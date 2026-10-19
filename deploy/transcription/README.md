# Optional CPU transcription image

This image extends an already-built Ziipa API image; it does not create any
cloud service, change Render configuration, enable transcription by default,
or download a speech model. It compiles the official whisper.cpp v1.9.5/b5454
commit `d1be6fde11ac6e0407606b4e42fe72d34add8037` with CPU-only flags and native
host-specific tuning disabled. The upstream x64 defaults still require AVX2;
test the intended CPU architecture before using it on another machine.
The build needs Internet access to official Debian/GitHub sources; requests do
not. No model hub client or Python speech dependency is installed.

From the repository root, explicitly build the current API base first, then:

```sh
docker build -t ziipa-api:local backend
docker build --build-arg ZIIPA_API_IMAGE=ziipa-api:local \
  -f deploy/transcription/Dockerfile -t ziipa-api:speech .
```

Use the [local installation guide](../local-speech/README.md) to obtain and
verify `ggml-tiny.en.bin` separately. When an operator elects to enable this
image, mount that file read-only at `/models/ggml-tiny.en.bin`. Startup checks
its exact SHA-256 and refuses a missing, substituted or differently named
model. It never downloads a replacement. The default disabled image starts
without any model. A runtime/code upgrade requires rebuilding the base image
before the optional image; this Dockerfile deliberately does not copy app code
over an old base.

For a bounded, **offline runtime smoke check**, not an API/worker deployment:

```sh
docker run --rm --network none --cpus 2 --memory 1g --pids-limit 64 \
  --read-only --security-opt no-new-privileges --cap-drop ALL \
  --tmpfs /speech-work:rw,noexec,nosuid,size=128m,uid=10001,gid=10001,mode=700 \
  --mount type=bind,src=/absolute/path/ggml-tiny.en.bin,dst=/models/ggml-tiny.en.bin,readonly \
  -e TRANSCRIPTION_ENABLED=true ziipa-api:speech /usr/local/bin/whisper-cli --version
```

Only an explicit API/worker deployment should receive the existing narrowly
scoped database/storage environment. `--network none` is appropriate for the
offline smoke command, but an actual worker needs its configured database and
private storage; apply an allowlist appropriate to that deployment. Use the
same shared private work mount for all speech processes on a host. Do not run
this on an already constrained free API instance without resource acceptance;
the presence of an optional image does not provision or authorize capacity.

The 128 MiB scratch bound covers one 100 MiB source plus decoded audio and logs;
test peak memory/time on each target CPU architecture. The Windows CPU speech
test does not establish Linux/ARM production capacity. No transcription cloud
deployment or scheduler activation is part of these files.

Local acceptance on 2026-10-19: the image built against the existing
`ziipa-api:agent-review` base and recognized the generated English sample under
the network-none, read-only, 2 CPU/1 GiB/128 MiB scratch limits above. Missing
models failed closed, including the `TRANSCRIPTION_ENABLED=t` boolean spelling;
disabled startup required no model. This checks the pinned Linux amd64 engine
and entrypoint, not current campaign application code in that older base image.
Rebuild the API base from current sources before any actual deployment.
