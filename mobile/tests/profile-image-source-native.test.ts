import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const babel = require("@babel/core");
const apiOrigin = "https://api.profile-fixture.test";
const canonicalApiOrigin = "https://canonical.profile-fixture.test";
const avatar =
  "/api/creator/profile-images/209fbea3-2a64-45cc-a656-aeec2f900971";
const cover =
  "/api/creator/profile-images/468fbea3-2a64-45cc-a656-aeec2f900972";
const token = "synthetic-profile-session";

/** Execute the real app modules with public, synthetic build configuration. */
function nativeProfileImages(os: "android" | "ios") {
  const modules = new Map<string, Record<string, any>>();
  const assetNumbers = new Map<string, number>();
  let memo: { deps: readonly unknown[]; value: unknown } | undefined;
  const allowed = new Set([
    "assets",
    "config",
    "domain",
    "local-media",
    "preview-origin",
    "private-profile-image",
    "profile-image-source",
  ]);
  function load(name: string): Record<string, any> {
    const key = name.replace(/\.ts$/, "");
    assert.ok(allowed.has(key), `Unexpected app module ${name}`);
    const cached = modules.get(key);
    if (cached) return cached;
    const exported: Record<string, any> = {};
    modules.set(key, exported);
    const source = readFileSync(
      new URL(`../src/lib/${key}.ts`, import.meta.url),
      "utf8",
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
    new Function(
      "exports",
      "require",
      "process",
      "globalThis",
      "__DEV__",
      compiled,
    )(
      exported,
      (dependency: string) => {
        if (dependency === "react")
          return {
            useMemo: (factory: () => unknown, deps: readonly unknown[]) => {
              if (
                !memo ||
                memo.deps.length !== deps.length ||
                deps.some(
                  (value, index) => !Object.is(value, memo!.deps[index]),
                )
              )
                memo = { deps, value: factory() };
              return memo.value;
            },
          };
        if (dependency === "react-native") return { Platform: { OS: os } };
        if (dependency.startsWith("../../assets/")) {
          if (!assetNumbers.has(dependency))
            assetNumbers.set(dependency, 100 + assetNumbers.size);
          return assetNumbers.get(dependency);
        }
        if (dependency.startsWith("./")) return load(dependency.slice(2));
        throw new Error(`Unexpected app dependency ${dependency}`);
      },
      {
        env: {
          EXPO_PUBLIC_API_URL: apiOrigin,
          EXPO_PUBLIC_CANONICAL_API_ORIGIN: canonicalApiOrigin,
        },
      },
      {},
      false,
    );
    return exported;
  }
  return {
    hook: load("profile-image-source").useProfileImageSource,
    assets: load("assets"),
  };
}

/** Load installed RN code, leaving its source/header normalization intact. */
function androidImageAdapter() {
  function compile(file: string, jsx = false) {
    const source = readFileSync(
      new URL(
        `../node_modules/react-native/Libraries/Image/${file}`,
        import.meta.url,
      ),
      "utf8",
    );
    const result = babel.transformSync(source, {
      filename: file,
      babelrc: false,
      configFile: false,
      plugins: [
        require.resolve("babel-plugin-syntax-hermes-parser"),
        require.resolve("@babel/plugin-transform-flow-strip-types"),
        ...(jsx
          ? [
              [
                require.resolve("@babel/plugin-transform-react-jsx"),
                { runtime: "classic" },
              ],
            ]
          : []),
        require.resolve("@babel/plugin-transform-modules-commonjs"),
      ],
    });
    assert.ok(result?.code, `Could not compile installed ${file}`);
    return result.code as string;
  }
  // Metro already resolved remote source objects; asset-number resolution is
  // deliberately outside this adapter harness and checked at the app boundary.
  const resolveAssetSource = (source: unknown) => {
    assert.ok(
      source == null || typeof source === "object",
      "Only resolved sources enter this harness",
    );
    return source;
  };
  const utils: Record<string, any> = {};
  new Function("exports", "require", compile("ImageSourceUtils.js"))(
    utils,
    (dependency: string) => {
      assert.equal(dependency, "./resolveAssetSource");
      return { __esModule: true, default: resolveAssetSource };
    },
  );
  const exported: Record<string, any> = {};
  new Function("exports", "require", compile("Image.android.js", true))(
    exported,
    (dependency: string) => {
      if (dependency === "./ImageSourceUtils") return utils;
      if (dependency === "./resolveAssetSource")
        return { __esModule: true, default: resolveAssetSource };
      if (dependency === "react")
        return {
          use: () => null,
          createElement: (type: unknown, props: Record<string, any>) => ({
            type,
            props,
          }),
        };
      if (dependency === "../StyleSheet/StyleSheet")
        return { create: (styles: unknown) => styles };
      if (dependency === "../StyleSheet/flattenStyle")
        return (style: unknown) => style;
      if (dependency === "./ImageAnalyticsTagContext") return {};
      if (dependency === "./ImageInjection")
        return {
          unstable_getImageComponentDecorator: () => null,
          useWrapRefWithImageAttachedCallbacks: (ref: unknown) => ref,
        };
      if (dependency === "./ImageUtils")
        return { convertObjectFitToResizeMode: () => undefined };
      if (dependency === "./ImageViewNativeComponent")
        return "AndroidImageView";
      if (dependency === "./NativeImageLoaderAndroid")
        return new Proxy(
          {},
          {
            get: (_, name) => {
              if (name === "__esModule") return false;
              throw new Error(
                `Native image loader ${String(name)} must not run in this test`,
              );
            },
          },
        );
      throw new Error(`Unexpected React Native dependency ${dependency}`);
    },
  );
  return {
    sources: utils.getImageSourcesFromImageProps,
    render: (source: unknown) => exported.default({ source, style: {} }),
  };
}

const android = androidImageAdapter();

test("native avatar and cover reach the installed Android adapter with bearer headers", () => {
  const app = nativeProfileImages("android");
  for (const path of [avatar, canonicalApiOrigin + cover]) {
    const source = app.hook(path, token);
    assert.ok(source);
    const output = android.render(source);
    assert.equal(output.type, "AndroidImageView");
    assert.deepEqual(output.props.headers, {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(output.props.source.length, 1);
    assert.equal(
      output.props.source[0].uri,
      apiOrigin + (path === avatar ? avatar : cover),
    );
    const changed = android.render(
      app.hook(path, "synthetic-replacement-session"),
    );
    assert.equal(
      changed.props.headers.Authorization,
      "Bearer synthetic-replacement-session",
    );
  }
});

test("iOS retains its authenticated object source through actual RN source resolution", () => {
  const app = nativeProfileImages("ios");
  for (const path of [avatar, canonicalApiOrigin + cover]) {
    const source = app.hook(path, token);
    assert.ok(source && !Array.isArray(source));
    assert.deepEqual(source.headers, { Authorization: `Bearer ${token}` });
    assert.equal(source.uri, apiOrigin + (path === avatar ? avatar : cover));
    assert.equal(android.sources({ source }), source);
  }
});

test("bundled profile artwork remains an opaque asset number on both native platforms", () => {
  for (const os of ["android", "ios"] as const) {
    const app = nativeProfileImages(os);
    for (const path of [
      "/media/studio.jpg",
      "/media/sintel.png",
      "/brand/ziipa-background.png",
    ]) {
      assert.equal(typeof app.assets.localImages[path], "number");
      assert.equal(app.hook(path), app.assets.localImages[path]);
      assert.equal(app.hook(path, token), app.assets.localImages[path]);
    }
  }
});

test("native profile images reject missing auth and paths outside the exact trusted owner route", () => {
  for (const os of ["android", "ios"] as const) {
    const app = nativeProfileImages(os);
    assert.equal(app.hook(avatar), null);
    assert.equal(app.hook(avatar, ""), null);
    assert.equal(app.hook(null, token), null);
    for (const path of [
      "https://untrusted.profile-fixture.test" + avatar,
      apiOrigin + avatar + "?signed=synthetic",
      avatar + "#fragment",
      avatar.replace("profile-images", "media"),
      "file:///synthetic-avatar.png",
      "blob:synthetic-avatar",
    ])
      assert.equal(app.hook(path, token), null, `${os} must reject ${path}`);
  }
});
