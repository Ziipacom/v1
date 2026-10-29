import test from "node:test";
import assert from "node:assert/strict";
import { creatorProfileParams } from "../src/lib/profile-collections.ts";
import {
  destinationFromSearch,
  destinationSearch,
} from "../src/lib/desktop-navigation.ts";
import { trustedProfileImagePath } from "../src/lib/private-profile-image.ts";

test("creator links use stable IDs and do not redirect samples to the viewer's own account", () => {
  assert.deepEqual(creatorProfileParams({ creator_id: 42, demo: false }), {
    creatorId: 42,
  });
  for (const creator_id of [undefined, 0, -1, NaN, Infinity, 1.5])
    assert.equal(creatorProfileParams({ creator_id, demo: false }), null);
  assert.equal(creatorProfileParams({ creator_id: 42, demo: true }), null);
});

test("visitor profile routes round-trip only the creator identifier", () => {
  const route = destinationSearch("Profile", {
    creatorId: 42,
    token: "private",
    email: "private@example.test",
  });
  assert.ok(route);
  assert.deepEqual(destinationFromSearch(route), {
    screen: "Profile",
    params: { creatorId: 42 },
  });
  assert.ok(!route.includes("private"));
  for (const creatorId of [-1, 0, 1.5, "42?secret=key", 2147483648])
    assert.equal(destinationSearch("Profile", { creatorId }), null);
});

test("visitor artwork keeps authorization confined to selected creator image routes", () => {
  const path =
    "/api/creator/profile-images/42/ae5580ee-5ee1-40cb-88fb-443f5ce004ca";
  assert.equal(trustedProfileImagePath(path, []), path);
  for (const bad of [
    path + "?token=secret",
    path.replace("/42/", "/0/"),
    path.replace("/42/", "/../"),
    "https://evil.test" + path,
  ])
    assert.equal(trustedProfileImagePath(bad, ["https://api.ziipa.com"]), null);
});
