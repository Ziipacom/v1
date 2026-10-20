import test from "node:test";
import assert from "node:assert/strict";
import { CommonActions, StackRouter } from "@react-navigation/routers";
import {
  composerRouteId,
  savedComposerParams,
} from "../src/lib/composer-navigation.ts";
import type { Item, RootStack } from "../src/lib/types.ts";

const first: Item = {
  id: "6a452c1e-9802-46fc-93bd-cb0ef504ce0b",
  title: "Saved video with captions",
  description: "",
  category: "video",
  creator: "Creator",
  creator_id: 1,
  tags: [],
  city: "",
  cover: "",
  media_url: null,
  demo: false,
  label: "Draft",
  visibility: "draft",
  captions: [{ start: 0, end: 4, text: "Existing caption" }],
};
const second: Item = {
  ...first,
  id: "c6b42c46-b7bb-46d0-a0a1-7a78be3e1d55",
  title: "Another saved creation",
};
const options = {
  routeNames: ["Main", "Composer"],
  routeParamList: {},
  routeGetIdList: {
    Composer: ({ params }: { params?: object }) =>
      composerRouteId({ params: params as RootStack["Composer"] }),
  },
};
const router = StackRouter({ initialRouteName: "Main" });
type State = ReturnType<typeof router.getInitialState>;
function navigate(state: State, params?: RootStack["Composer"]) {
  const next = router.getStateForAction(
    state,
    CommonActions.navigate("Composer", params),
    options,
  );
  assert.ok(next && next.stale === false);
  return next;
}
const current = (state: State) => state.routes[state.index];

test("actual StackRouter reproduces stale Composer reuse without identity and separates it with the registered getId", () => {
  const initial = router.getInitialState(options);
  const saved = navigate(initial, { item: first });
  const oldKey = current(saved).key;
  const legacy = router.getStateForAction(
    saved,
    CommonActions.navigate("Composer"),
    { ...options, routeGetIdList: {} },
  );
  assert.ok(legacy && legacy.stale === false);
  assert.equal(
    current(legacy).key,
    oldKey,
    "the installed router reuses the mounted editor when getId is absent",
  );
  assert.equal(
    current(legacy).params,
    undefined,
    "params alone cannot reset useState-initialized editor fields",
  );

  const created = navigate(saved);
  assert.notEqual(current(created).key, oldKey);
  assert.equal(current(created).params, undefined);
  assert.deepEqual(
    created.routes.find((route) => route.key === oldKey),
    current(saved),
    "saved editor state remains mounted under its existing key",
  );
  assert.deepEqual(
    saved.routes.filter(
      (route) => !created.routes.some((next) => next.key === route.key),
    ),
    [],
    "opening Create removes no editor route or its unsaved guard",
  );
});

test("repeated Create reuses the current new form and returning to an owned draft preserves both route keys", () => {
  const saved = navigate(router.getInitialState(options), { item: first });
  const savedKey = current(saved).key;
  const created = navigate(saved);
  const newKey = current(created).key;
  const repeated = navigate(created);
  assert.equal(current(repeated).key, newKey);
  assert.equal(repeated.routes.length, created.routes.length);
  const returned = navigate(repeated, { item: first });
  assert.equal(current(returned).key, savedKey);
  assert.ok(
    returned.routes.some((route) => route.key === newKey),
    "the unsaved new form is not replaced when reopening the saved draft",
  );
  assert.equal(
    (current(returned).params as RootStack["Composer"])?.item?.captions?.[0]
      ?.text,
    "Existing caption",
  );
});

test("different drafts and same-ID upload/remix sources receive distinct real editor routes", () => {
  let state = navigate(router.getInitialState(options), { item: first });
  const keys = [current(state).key];
  for (const params of [
    { item: second },
    { upload: { id: first.id, content_type: "video/mp4" } },
    { remix: first },
  ] satisfies NonNullable<RootStack["Composer"]>[]) {
    state = navigate(state, params);
    keys.push(current(state).key);
  }
  assert.equal(new Set(keys).size, 4);
  assert.equal(
    state.routes.filter((route) => route.name === "Composer").length,
    4,
  );
  const prior = state;
  state = navigate(state, { item: second });
  assert.equal(current(state).key, keys[1]);
  assert.equal(state.routes.length, prior.routes.length);
});

test("saving new, upload and remix routes canonicalizes the same key before the next Create or reopen", () => {
  for (const seed of [
    undefined,
    { upload: { id: second.id, content_type: "video/mp4" } },
    { remix: second },
  ] satisfies RootStack["Composer"][]) {
    const editing = navigate(router.getInitialState(options), seed);
    const key = current(editing).key;
    const canonical = router.getStateForAction(
      editing,
      {
        ...CommonActions.replaceParams(savedComposerParams(first)),
        source: key,
      },
      options,
    );
    assert.ok(canonical && canonical.stale === false);
    assert.equal(
      current(canonical).key,
      key,
      "the mounted form and unsaved-change guard retain their route key",
    );
    assert.equal(canonical.index, editing.index);
    assert.equal(canonical.routes.length, editing.routes.length);
    assert.deepEqual(
      current(canonical).params,
      { item: first },
      "obsolete upload/remix/category seeds do not survive save",
    );
    assert.equal(
      composerRouteId({
        params: current(canonical).params as RootStack["Composer"],
      }),
      `draft:${first.id}`,
    );

    const created = navigate(canonical);
    assert.notEqual(
      current(created).key,
      key,
      "Create after save opens a fresh form",
    );
    assert.equal(current(created).params, undefined);
    assert.deepEqual(
      created.routes.find((route) => route.key === key),
      current(canonical),
    );
    const reopened = navigate(created, { item: first });
    assert.equal(
      current(reopened).key,
      key,
      "opening the saved item reuses its original mounted editor",
    );
    assert.equal(
      reopened.routes.filter(
        (route) =>
          (route.params as RootStack["Composer"])?.item?.id === first.id,
      ).length,
      1,
    );
  }
});
