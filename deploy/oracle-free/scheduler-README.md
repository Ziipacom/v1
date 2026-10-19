# Limited Micro calendar and Web Push profile

This is an optional partial fallback, not a replacement for the A1 media worker.
It handles only private calendar occurrence reminders and the existing durable,
consent-checked push outbox. Web Push is the default; native Expo HTTP sending and
receipt polling is optional, disabled unless separately configured and approved.
No recording import, clipping,
rendering, transcription, campaign delivery, network synchronization or AI runs.
It never executes the general workflow dispatcher or claims its readiness.

The intended host is an independently approved **Always Free E2.1.Micro, native
Linux AMD64**, with 1 GB advertised RAM. No VM, IP, administrator key or secret
transfer is provisioned by these files. Verify current tenancy free eligibility,
remaining boot-volume allowance and native capacity first; stop for paid options.
The frozen A1 renderer/workflow preflights and resource gates are unchanged.

## Resource and execution boundary

One serial process has 384 MiB RAM, no swap, 0.125 CPU, a 32 MiB temporary mount,
48 PIDs, no ports, no host mounts, an unprivileged user and a read-only filesystem.
The dedicated image omits FFmpeg and Node. Build with **backend/** as context so
its existing `.dockerignore` excludes all local environment files and uploads:

```sh
docker build --platform linux/amd64 -f deploy/oracle-free/Dockerfile.scheduler \
  -t ziipa-scheduler:oracle-amd64 backend
```

Host preflight requires native AMD64, at least 768 MiB actual total RAM, at least
512 MiB **available before start**, 3 GiB free disk, Docker Compose 2.30+ and the
reviewed unprivileged image. Do not add swap, weaken these checks, run another
Ziipa worker on the Micro host or assume an x86 desktop benchmark proves Oracle
capacity. Build under the same 384 MiB / 0.125 CPU limits or transfer an approved,
matching-image artifact; an unrestricted on-host build can exhaust the small VM.
Image preparation and native host acceptance are separate from service startup.
Startup also requires `/etc/ziipa/scheduler-image.sha256`: a root-owned regular
mode-0600 file in protected directories containing exactly the accepted immutable
`sha256:` image ID, optionally followed by one LF. Missing/symlinked/loose-mode
receipts and any fixed Compose alias pointing to a different image fail closed.
This non-secret receipt is installed only after native acceptance below, never
automatically created from the current tag by preflight.

## Narrow configuration and matching release

### Optional fixed compact profile

The original `standard384` profile above remains the default: 384 MiB container,
512 MiB available before start. A separate `compact256` profile uses a **256 MiB**
container and requires **384 MiB available** before start. Both reserve the same
128 MiB for the operating system beyond the full container allocation and require
at least 768 MiB actual total RAM. Neither profile permits arbitrary memory/CPU
overrides, swap, extra ports, another Ziipa worker or disabling OS monitoring.
Standard CPU remains 0.125 (12.5%). Compact uses the stricter fixed **0.12 CPU**
(12%): exactly 12000 quota / 100000 period. The 32 MiB temporary filesystem,
48 PIDs, non-root/read-only boundaries and supported functions are identical.
Compact acceptance additionally
requires a whole-container peak below 224 MiB, leaving 32 MiB inside its cap.

Select compact mode explicitly; do not edit the existing 384 MiB Compose file:

```sh
sudo python3 -B deploy/oracle-free/scheduler-acceptance.py --profile compact256 \
  --image ziipa-scheduler:REVIEWED_RELEASE_TAG --record-native-receipt
sudo python3 -B deploy/oracle-free/scheduler-preflight.py --profile compact256
```

The first command runs the actual synthetic suite under exact compact cgroup
limits, with no network, credentials or device messages. It checks the host floor
and refuses active Ziipa worker containers. Only a successful **native** run may
exclusively create `/etc/ziipa/scheduler-native-compact256.json`, root:root0600 in
protected directories. Schema2 binds the profile, all fixed resource limits,
immutable image ID, exact SHA256 of the deployed acceptance test source and a
SHA256 map of the selected host profile's Python/Compose/systemd source bytes.
This permits a separately verified unchanged runtime image to retain its original
runtime release while the reviewed deployment/test source advances; do not claim
those two revisions are identical without comparing the runtime manifest.
Existing receipts are never overwritten or treated as a request to replay a pass;
Desktop rehearsal cannot write one. The compact preflight requires that exact
receipt **and** the existing protected `scheduler-image.sha256` image-ID receipt.
A standard384 or legacy image-only receipt cannot authorize compact mode. A new
test source/image requires a new reviewed acceptance, not a hand-edited receipt.

After the separately approved settings transfer and bounded runtime acceptance,
use only `ziipa-scheduler-compact-worker.service`, backed by
`scheduler-compact-compose.json`. Do not start the standard unit too. Both units
hold the same exclusive `/run/ziipa-scheduler-worker.lock`; their preflights also
refuse the opposite unit or any media/agent worker. No `Conflicts=` directive
implicitly stops a preserved service. This profile is source-ready until its
specific image passes native host and opted-in device acceptance; a prior
384 MiB rehearsal is not proof of 256 MiB viability.

The 3210d78 compact native attempt was rejected because the host rounded its
requested 0.125 CPU to 13000/100000 (13%). That failed attempt provides no native
acceptance receipt. The fixed 0.12 CPU successor requires fresh exact-image,
profile-source and native test acceptance; never accept the rounded 13% value.
Use `python3 -B` for every host deployment/acceptance/preflight entry point.
Preflight and acceptance also disable bytecode internally before dynamic imports
so generated `__pycache__` files cannot change the protected release manifest.

After destination-specific owner authorization, install exactly one root-owned
regular mode-0600 file, `/etc/ziipa/scheduler-worker.env`, inside root-owned,
non-group/world-writable directories. Copy the template and fill it without shell
history or log output. It accepts only TLS PostgreSQL `DATABASE_URL`, TLS Redis
`REDIS_URL`, `PUSH_ENABLED` and the dedicated Web Push encryption/VAPID keys/contact.
The optional `PUSH_EXPO_ENABLED=false` and empty `PUSH_EXPO_ACCESS_TOKEN` settings
may be omitted from old Web-only files. Native opt-in requires explicit true,
enabled push and a bounded enhanced-security Expo sender token. Do not copy that
token while disabled. Verified owner EAS project, FCM/APNs configuration,
replacement binary, provider binding and destination-specific secret approval
are prerequisites; a logged-in Expo account alone is insufficient. For controlled
sender bootstrap, keep API enrollment disabled and verify zero active devices and
pending deliveries. Enable the approved worker and verify its matching readiness
first, then enable API enrollment last. Only afterward may the owner explicitly
consent, enroll the device and complete actual device acceptance. Sender readiness
alone never makes a release complete and never replaces per-device consent.
No R2/storage, Livepeer/webhook, social, email, wallet or agent/inference
credentials are accepted. Never reuse the render/workflow worker environment.

```sh
python3 -B deploy/oracle-free/scheduler-preflight.py
```

This intentionally fails until the protected accepted-image receipt exists.

The API must already have migrated to this release's exact Alembic head (currently
`20261019_0011`). The scheduler **only verifies** the schema and never upgrades it.
Use the same committed source on API and scheduler: Web Push readiness protocol 2
requires matching encryption, VAPID configuration, database scope and signed worker
expiry; the API does not accept old generic heartbeat strings as proof of delivery.

Keep API `OS_WORKFLOW_ENABLED`, `CREATION_CAMPAIGN_ENABLED`, `LIVE_RECORDINGS_ENABLED`,
transcription, agent and native Expo disabled until their own workers/providers pass
acceptance. Calendar may separately use `OS_CALENDAR_ENABLED=true`. Enable Web Push
only with its approved dedicated matching keys and an explicitly opted-in browser.
Calendar readiness now has its own scoped heartbeat, so a Micro worker never makes
the UI claim general workflow or recording readiness. No arbitrary push-text tools
are exposed; all push content remains fixed and non-sensitive.

## Acceptance before activation

1. Review one exact commit/image, schema head and protected configuration. Keep the
   new systemd unit stopped; do not stop/reconfigure the preserved old A1 host.
2. On native AMD64 run the isolated scheduler acceptance test under the exact
   Compose caps with `--network none`, synthetic SQLite and mocked Web Push. Bind
   only the reviewed test file; never mount a live environment or credential file:

   ```sh
   python3 -B deploy/oracle-free/scheduler-acceptance.py
   ```

   Require successful idempotent reminders/outbox, no general worker readiness,
   idle Redis-only polling, bounded cgroup memory and a deadline/stop test.
   The command resolves the tag before testing, runs that immutable ID, and only
   after success prints `accepted_image_id` and `native_acceptance:true`. A desktop
   rehearsal explicitly prints false and does not qualify. Install the **exact
   successful native output ID**, not a new lookup of a potentially retagged alias:

   ```sh
   sudo python3 - 'sha256:PASTE_THE_64_LOWERCASE_HEX_DIGITS_FROM_NATIVE_PASS' <<'PY'
   import os, pathlib, re, stat, sys
   identifier = sys.argv[1]
   assert os.geteuid() == 0 and re.fullmatch(r'sha256:[0-9a-f]{64}', identifier)
   path = pathlib.Path('/etc/ziipa/scheduler-image.sha256')
   for parent in path.parents:
       metadata = parent.lstat()
       assert stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == 0
       assert not stat.S_IMODE(metadata.st_mode) & 0o022
   descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
   with os.fdopen(descriptor, 'w', encoding='ascii') as stream:
       stream.write(identifier + '\n'); stream.flush(); os.fsync(stream.fileno())
   PY
   ```

   Exclusive creation preserves any existing receipt. For a later release, keep
   the service stopped, explicitly archive the previous receipt, accept the new
   immutable image and repeat; do not regenerate a receipt merely to satisfy a
   failed preflight. Do not retag the fixed alias while the unit starts or runs.
3. With approved runtime connections and **PUSH_ENABLED=false**, run one bounded
   `scheduler_worker.py --once` through an otherwise identical Compose command.
   Verify the matching schema, TLS connections and calendar-scoped readiness.
4. Only after acceptance, explicitly install/start `ziipa-scheduler-worker.service`.
   Its startup preflight checks real available host memory again. Do not enable
   both workflow and Micro scheduler units on the same host.
5. For push acceptance the owner must explicitly enable preferences, grant browser
   notification permission and register this device. Create one harmless private
   calendar reminder; require SQL receipt + provider acceptance + actual device
   display/open evidence. No test script sends a real notification automatically.
6. Monitor actual RSS/CPU, reboot recovery, failure-to-uncertain behavior and Redis
   usage before claiming this limited profile active. If constraints fail, keep it
   stopped and retain calendar planning without delivery; do not lift limits.

Hints, cached SQL deadlines and hourly reconciliation avoid minute-by-minute Neon
polling. At most three idle Redis operations per minute are normally needed
(~129,600 per30days), before API/device traffic. Free account limits still apply.
Missed reminder windows are recorded as missed; no broadcast or campaign starts.
Web Push receipts attest provider acceptance, not guaranteed lockscreen display.
Disabled Expo queues are excluded from both claims and next-wakeup calculation;
they cannot consume this profile's Web-only scans or starve browser recipients.
When separately enabled, native tickets/receipts use the same bounded serial
outbox with durable uncertain-result handling, not another process.

The final Docker Desktop Linux AMD64 rehearsal on 2026-10-19 passed 11 behavioral
tests, including real SQLite reminders, 50-per-scan bounds, synthetic Web Push and
optional Expo tickets/receipts, in 18.40 seconds. The cgroup peak was 120,631,296
bytes (~115.0 MiB), under exact 384 MiB / 0.125 CPU caps with networking disabled.
This is not Oracle native host, loaded-throughput or actual device acceptance.

## GitHub Actions is not a production media fallback

GitHub-hosted Actions is appropriate for generated-input CI and measured renderer
acceptance. Its official [additional terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions)
restrict it to software development/testing and prohibit use as part of a
serverless application. Do not dispatch private user recording backlogs there or
copy the current broad database/R2 worker credentials into Actions. Existing media
workers have no one-job broker with expiring exact-source/output grants; adding
that would not itself resolve the service-policy restriction. A1 recovery or free
native capacity remains necessary for hosted recording-to-clips processing.
