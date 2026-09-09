import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  cameraError,
  recordingBytes,
  recordingFormat,
  recordingTime,
  validateRecordingSize,
} from "../src/components/recorder-utils.ts";
import {
  rememberLocalMedia,
  forgetLocalMedia,
  localPlaybackSource,
} from "../src/lib/local-media.ts";

test("remote data cannot open device paths or acquire authorization through local previews", () => {
  const picked = "blob:http://localhost:8082/selected-by-picker";
  assert.equal(
    localPlaybackSource("file:///private/unselected.mp4", true),
    null,
  );
  assert.equal(localPlaybackSource(picked, true), null);
  assert.throws(() => rememberLocalMedia("https://remote.example/file.mp4"));
  rememberLocalMedia(picked);
  assert.deepEqual(localPlaybackSource(picked, true), { uri: picked });
  assert.equal(localPlaybackSource(picked, false), null);
  assert.equal(
    localPlaybackSource("blob:http://localhost:8082/not-selected", true),
    null,
  );
  forgetLocalMedia(picked);
  assert.equal(localPlaybackSource(picked, true), null);
});

test("recorded files reject empty, invalid and oversized payloads before upload", () => {
  for (const size of [0, -1, NaN, Infinity, recordingBytes + 1])
    assert.throws(() => validateRecordingSize(size));
  assert.doesNotThrow(() => validateRecordingSize(1));
  assert.doesNotThrow(() => validateRecordingSize(recordingBytes));
});

test("browser codec parameters become upload-compatible MIME types and filenames", () => {
  assert.deepEqual(recordingFormat("video/webm;codecs=vp8,opus"), {
    mimeType: "video/webm",
    extension: "webm",
  });
  assert.deepEqual(recordingFormat("video/mp4;codecs=avc1.42E01E,mp4a.40.2"), {
    mimeType: "video/mp4",
    extension: "mp4",
  });
  assert.deepEqual(recordingFormat("video/quicktime"), {
    mimeType: "video/quicktime",
    extension: "mov",
  });
  for (const mime of ["", "audio/webm", "text/html", "video/unknown"])
    assert.throws(() => recordingFormat(mime));
});

test("recording timer is stable at minute boundaries and invalid input", () => {
  assert.equal(recordingTime(59.8), "00:59");
  assert.equal(recordingTime(60), "01:00");
  assert.equal(recordingTime(120), "02:00");
  assert.equal(recordingTime(-1), "00:00");
  assert.equal(recordingTime(NaN), "00:00");
});

test("camera denials offer recovery without treating denial as a missing device", () => {
  const denied = new Error("denied");
  denied.name = "NotAllowedError";
  assert.match(cameraError(denied), /site permissions/);
  const missing = new Error("missing");
  missing.name = "NotFoundError";
  assert.match(cameraError(missing), /No camera or microphone/);
  const busy = new Error("busy");
  busy.name = "NotReadableError";
  assert.match(cameraError(busy), /Close other apps/);
});
