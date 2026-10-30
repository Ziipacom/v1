import test from "node:test";
import assert from "node:assert/strict";
import { calendarAuthorizationUrl } from "../src/lib/calendar-connections.ts";

test("native calendar connection hands off to the Ziipa portal without bearer credentials", () => {
  assert.equal(
    calendarAuthorizationUrl(
      "https://ziipa.com/studio/?view=calendar",
      "https://api.ziipa.com",
    ),
    "https://ziipa.com/studio/?view=calendar",
  );
});
test("portal calendar authorization stays on its approved origin and fixed callback flow", () => {
  const url =
    "https://ziipa.com/api/os/calendar/connections/oauth/google/authorize?ticket=" +
    "a".repeat(40);
  assert.equal(calendarAuthorizationUrl(url, "https://ziipa.com"), url);
});
test("calendar consent rejects untrusted destinations, credentials and token-bearing URLs", () => {
  for (const url of [
    "https://evil.example/studio/?view=calendar",
    "https://ziipa.com.evil.example/studio/?view=calendar",
    "https://user:secret@ziipa.com/studio/?view=calendar",
    "http://ziipa.com/studio/?view=calendar",
    "https://ziipa.com/studio/?view=calendar&token=private",
    "https://ziipa.com/studio/?view=calendar#token",
    "https://ziipa.com/api/os/calendar/connections/oauth/google/callback?code=private",
    "https://ziipa.com/api/os/calendar/connections/oauth/evil/authorize?ticket=" +
      "a".repeat(40),
    "https://ziipa.com/api/os/calendar/connections/oauth/google/authorize?ticket=short",
  ])
    assert.throws(() => calendarAuthorizationUrl(url, "https://api.ziipa.com"));
});
