import test from "node:test";
import assert from "node:assert/strict";
import {
  soundCloudAuthorizationUrl,
  soundCloudPermalink,
  soundCloudPortalUrl,
  soundCloudTrackId,
  soundCloudWidgetUrl,
  soundCloudWidgetNavigationOrigins,
} from "../src/lib/soundcloud-links.ts";

const permalink = "https://soundcloud.com/ziipa-creator/original-track";
const widget = () =>
  `https://w.soundcloud.com/player/?${new URLSearchParams({ url: permalink, auto_play: "false", show_comments: "false", show_reposts: "false", visual: "false" })}`;

test("native widget routes every navigation to validation instead of WebView's automatic OS opener", () => {
  assert.deepEqual(soundCloudWidgetNavigationOrigins, ["*"]);
  for (const destination of [
    "https://soundcloud.com/creator/track",
    "https://evil.test",
    "tel:123",
    "intent://open",
    "file:///private/config",
  ])
    assert.equal(soundCloudWidgetUrl(destination), null);
  assert.equal(soundCloudWidgetUrl(widget()), widget());
});

test("official widget accepts one public permalink with autoplay explicitly disabled", () => {
  assert.equal(soundCloudWidgetUrl(widget()), widget());
  const autoplay = new URL(widget());
  autoplay.searchParams.set("auto_play", "true");
  assert.equal(soundCloudWidgetUrl(autoplay.href), null);
  const omitted = new URL(widget());
  omitted.searchParams.delete("auto_play");
  assert.equal(soundCloudWidgetUrl(omitted.href), null);
  const duplicate = new URL(widget());
  duplicate.searchParams.append("url", permalink);
  assert.equal(soundCloudWidgetUrl(duplicate.href), null);
  const raw = new URL(widget());
  raw.searchParams.set(
    "url",
    "https://api.soundcloud.com/tracks/123/stream?token=secret",
  );
  assert.equal(soundCloudWidgetUrl(raw.href), null);
  assert.equal(
    soundCloudWidgetUrl(
      widget().replace("w.soundcloud.com", "w.soundcloud.com.evil.test"),
    ),
    null,
  );
  const added = new URL(widget());
  added.searchParams.set("token", "not-permitted");
  assert.equal(soundCloudWidgetUrl(added.href), null);
});

test("private secret tokens, other origins, credentials and script URLs never become public links", () => {
  assert.equal(soundCloudPermalink(permalink), permalink);
  for (const value of [
    `${permalink}?secret_token=private`,
    `${permalink}#secret`,
    "https://soundcloud.com.evil.test/creator/track",
    "https://user:password@soundcloud.com/creator/track",
    "http://soundcloud.com/creator/track",
    "javascript:alert(1)",
    "https://soundcloud.com/creator/track/extra",
  ])
    assert.equal(soundCloudPermalink(value), null, value);
  assert.equal(
    soundCloudTrackId("soundcloud:tracks:1234"),
    "soundcloud%3Atracks%3A1234",
  );
  assert.equal(soundCloudTrackId("1234"), null);
  assert.equal(soundCloudTrackId("soundcloud:tracks:1234/../stream"), null);
});

test("OAuth handoff is a single-use ticket on an approved Ziipa origin only", () => {
  const origins = ["https://ziipa.com"];
  const url = `https://ziipa.com/api/music/soundcloud/oauth/authorize?ticket=${"a".repeat(54)}`;
  assert.equal(soundCloudAuthorizationUrl(url, origins), url);
  for (const invalid of [
    url.replace("ziipa.com/", "evil.test/"),
    `${url}&next=https://evil.test`,
    `${url}&ticket=another`,
    url.replace("/authorize", "/callback"),
    `${url}#fragment`,
    "https://ziipa.com/api/music/soundcloud/oauth/authorize?ticket=short",
  ])
    assert.equal(soundCloudAuthorizationUrl(invalid, origins), null);
  assert.equal(
    soundCloudPortalUrl("https://ziipa.com/portal", origins),
    "https://ziipa.com/portal",
  );
  assert.equal(
    soundCloudPortalUrl(
      "https://ziipa.com/portal?next=https://evil.test",
      origins,
    ),
    null,
  );
  assert.equal(soundCloudPortalUrl("https://evil.test/portal", origins), null);
});
