# Ziipa agent and private inference deployment

This release packages a durable, permission-scoped private-workspace agent and
free local-model inference. It does **not** give an LLM a shell, administrator
credentials, another user's data or unattended publishing/payment authority.
Project/goal creation and selected private exports can run without repeated
approval only after the owner enables their specific agent tools. Wallet signing,
account deletion, permission changes, public posting and provider connections
keep their existing user-controlled reviews. Disable an account's autonomy or
pause/cancel a task to stop future steps; already completed changes remain in
activity history.

## Services and data

The existing website/Studio calls the authenticated FastAPI API. PostgreSQL
holds users, policies, durable tasks and receipts; Redis carries short-lived
wake notifications and worker health. `backend/agent_worker.py` consumes one
bounded task at a time and rechecks grants/ownership before effects. The
workflow worker remains separate for schedules/synchronization; the renderer
remains separate for FFmpeg work. Losing an inference connection must leave a
task blocked/failed with its completed-step history, not silently invent success.

`backend/inference_gateway.py` is a separate minimal service with no database,
social, email, R2 or wallet credentials. It accepts one generation at a time:

- Public `GET /livez`: process state only, not model readiness.
- Authenticated `GET /v1/health`: `{available: bool, model: string}` after checking
  the configured downloaded model's inventory. A listed model still needs a real
  response test; the acceptance script below provides that separate check.
- Authenticated `POST /v1/chat`: `{messages: [{role, content}], format: objectSchema}`
  returns `{result: object, model: string}`. Ziipa validates that object against
  its typed plan and permissions before executing anything.

Use `Authorization: Bearer <random key>`. There is no model selector, pull/delete
endpoint, arbitrary upstream URL, file access, tool execution, streaming endpoint
or prompt access log. The gateway checks authentication before reading a body,
caps requests/responses at 32 KiB, message context at 16,000 UTF-8 bytes and
generation at 650 tokens (450 in the small profile). It uses a fixed downloaded
model, no thinking output, a 45-second deadline, one concurrent inference and
12 requests/minute (6 for the small profile). There is no automatic paid API
fallback. Its single-process limits require `--workers 1`; do not scale this
container without adding coordinated quotas.

## Free hosting choices and resource checks

Keep the current free API host if desired. Run the model on an **existing,
verified Always Free eligible Oracle ARM64 VM**, rather than trying to load it
inside a tiny API instance. Confirm account-wide eligibility/capacity and the
existing boot disk before any resize or install. This package does not create a
VM, resize it, upgrade an account, add a disk, purchase a GPU or promise that
free resources are available. Oracle can reclaim idle free instances; do not
generate artificial load to defeat reclamation. See the existing
`deploy/oracle-free/README.md` and
[Oracle's current free resource rules](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

The normal package requires at least **2 OCPU / 8 GiB**, including the current
1 GiB renderer, 512 MiB workflows, 256 MiB agent worker, 2 GiB Ollama, 192 MiB
gateway and optional 128 MiB tunnel. Offline preflight requires at least 7 GiB
actual usable host memory, two CPUs and 6 GiB free on the **existing disk**.
CPU shares are bounded, not guaranteed performance; native acceptance matters.

An explicit **small-host demo/closed-beta profile** uses `qwen3:0.6b`, 4,096 context
tokens, 450 output tokens and six requests/minute. Ollama is limited to 1 GiB and
the gateway to 128 MiB. Including the renderer/workflows/agent/tunnel above,
declared container maxima total **3,072 MiB**. Preflight still requires at least
3,840 MiB actual host memory, leaving at least 768 MiB for Ubuntu/Docker, one
CPU and the same disk headroom. It will reject a nominal 4 GB host whose actual
usable memory is too small. This is an explicit exception for the reviewed small
model, not weakened acceptance for the larger profile. Do not infer public-launch
capacity from a synthetic pass. If multi-step planning, model memory or response
time fails, keep the adapter disabled and use the larger eligible free profile
only when available. Stop the renderer while first benchmarking the small model,
then repeat with the normal workers active before admitting testers.

## Build and download the reviewed model

Put the reviewed release at `/opt/ziipa` and retain root ownership. Build on the
native ARM host, not through emulation. Docker Compose 2.30+ is required for raw
environment files. Images are versioned and pulled/built only by an operator;
boot does not update them. The model image uses the official
[Ollama 0.40.3 release](https://github.com/ollama/ollama/releases/tag/v0.40.3).

```bash
cd /opt/ziipa
sudo docker build --platform linux/arm64 -f deploy/oracle-free/Dockerfile.inference -t ziipa-inference:oracle-arm64 .
sudo docker build --platform linux/arm64 -f deploy/oracle-free/Dockerfile.ollama -t ziipa-ollama:oracle-arm64 .
sudo sh deploy/oracle-free/bootstrap-inference-model.sh normal
```

Use `small` instead of `normal` only for the explicit small-host profile. The
bootstrap command downloads the chosen public model into the named
`ziipa-inference-models` volume through a temporary container. It passes no
credentials, publishes no port, binds its temporary server to container
loopback and only permits the two reviewed model names. Network/download/storage
allowances still apply. Runtime mounts this volume **read-only**, disables
Ollama cloud features and places Ollama on an internal Docker network with no
published port or outbound Internet route. The unprivileged server gets a tiny
temporary home for ephemeral startup files; it has no real user's SSH/wallet keys.
Ollama's model persistence and concurrency settings follow its
[official Docker guide](https://docs.ollama.com/docker) and
[runtime configuration](https://docs.ollama.com/faq).

## Separate secret and loopback startup

Create `/etc/ziipa` as root:root mode0700 if it does not already exist. Create
`/etc/ziipa/inference-gateway.env` as root:root mode0600, outside Git, using the
two-key example `deploy/oracle-free/inference-gateway.env.example`. Generate a
new random URL-safe key, for example with Python `secrets.token_urlsafe(48)`,
inside a secure editor or a script that writes directly to the protected file.
Do **not** print it to command output/chat, include it on a command line or reuse
the publishing/database password. Use `ZIIPA_INFERENCE_MODEL=qwen3:0.6b` in the
small profile, otherwise `qwen3:1.7b`. Do not copy the entire API environment.

Use literal, unquoted `KEY=value`. The preflight rejects extra credentials,
placeholders, duplicate keys, insecure permissions and wrong model/resource
profiles without emitting supplied values. Do not `source` the file or run
`docker inspect` on live container environments. Use `docker compose config
--quiet`; rendered configuration may contain the secret.

```bash
sudo python3 deploy/oracle-free/inference_preflight.py
sudo docker compose -f deploy/oracle-free/inference-compose.json config --quiet
sudo install -m 0644 deploy/oracle-free/ziipa-inference.service /etc/systemd/system/ziipa-inference.service
sudo systemctl daemon-reload
sudo systemctl enable --now ziipa-inference
sudo python3 deploy/oracle-free/inference_acceptance.py
sudo systemctl restart ziipa-inference
sudo python3 deploy/oracle-free/inference_acceptance.py
```

For the small profile use `inference_preflight.py --small-host`, merge
`inference-compose.json` followed by `inference-small-compose.json`, and install
`ziipa-inference-small.service` instead. The mutually conflicting units prevent
two profile supervisors from managing the same Compose project. All containers
use a read-only root, dropped capabilities, no privilege escalation, bounded
RAM/no swap/CPU/processes/logs and bounded restart attempts. The gateway is
published **only to host loopback 127.0.0.1:8089**. Never open OCI/firewall 11434
or 8089 publicly, and never forward a public hostname to raw Ollama.

The synthetic acceptance script sends only invented project/goal names and
fixture receipts, using the production action-versus-terminal object grammar.
It requires sequential `project.create`, then `goal.create` linked to the exact
project receipt UUID with three requested **unchecked** steps, followed by `done`
and blocked unsupported-effects plans. It rejects repeated projects, unlinked
or wrong-project goals, changed step titles and invented completion. It executes **no tools,
posts, emails, broadcasts or wallet operations**, emits no prompts/key and exits
nonzero on invalid output. Repeat after restart, record timings and review
container memory/OOM status. Then validate a real owned task with the API and
agent worker, verify permission revocation and stop/restart behavior, and only
then enable user autonomy. Model readiness alone does not prove worker readiness.

## API adapter and optional outbound HTTPS tunnel

On a same-host API/agent worker, set these server-only API/worker settings:

```dotenv
OS_ASSISTANT_LOCAL_AI_ENABLED=true
OS_ASSISTANT_INFERENCE_URL=http://127.0.0.1:8089
OS_ASSISTANT_INFERENCE_HOST=
OS_ASSISTANT_INFERENCE_KEY=<same separate gateway key>
OS_ASSISTANT_MODEL=qwen3:1.7b
OS_AGENT_ENABLED=true
```

For the small profile the model value must match `qwen3:0.6b`. Use the parent
`deploy/oracle-free/agent-compose.json`/agent systemd package for its private
worker. It uses `/etc/ziipa/render-worker.env` for the existing eight storage
settings, plus a **separate root:root mode0600** `/etc/ziipa/agent-inference.env`
containing only `OS_ASSISTANT_INFERENCE_KEY` and `OS_ASSISTANT_MODEL` matching
the gateway. Do not add the gateway key to the strict eight-key renderer file.
Both agent units run `agent_preflight.py` after the existing storage preflight.
It verifies the two private files' root-only permissions, strict setting lists,
the selected profile's model and constant-time key equality before startup,
without transmitting or printing values.
The agent container uses host networking solely for the authenticated loopback
gateway; it has no listener/published port. Start the selected model profile
first, then exactly one matching agent supervisor (`ziipa-agent-worker.service`
or `ziipa-agent-worker-small.service`). Those worker units depend only on Docker
and use runtime model readiness, so they do not start a conflicting model/tunnel
profile. Their mutual conflicts prevent duplicate agent supervisors. API/agent
settings never belong in web/mobile bundles. Running
the service enables infrastructure, **not** every member's per-account autonomy.

When the API stays on Render, use the optional outbound Cloudflare Tunnel to
the gateway. In the owner account create a remotely managed Ziipa-only tunnel
with an otherwise unused hostname, for example an administrator-chosen random
subdomain under `ziipa.com`; point that tunnel's HTTP service at
`http://inference-gateway:8089`. It is reachable only through the authenticated
gateway. Keep `/livez` process-only and disable edge caching for the hostname.
Do not route `ollama:11434`, create a public Quick Tunnel, change the website
routes, or expose SSH through this tunnel. All unmatched tunnel hostnames must
return404. The VM needs only outbound Cloudflare connectivity; no new inbound
firewall rule, public HTTP listener or paid load balancer is needed.

Store only that tunnel's token in `/etc/ziipa/inference-tunnel.token`, root:root
mode0600. It grants that connector access and must never enter Git/chat/logs.
The optional `cloudflare/cloudflared:2026.10.0` container reads it through
`--token-file`, not command-line token interpolation, following Cloudflare's
[token guidance](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)
and [run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/).
The small connector runs as root only to read the root-only file, with all
capabilities dropped, no privilege escalation, no ports and no other host mount.
No Cloudflare account certificate/API administration token is copied to it.

```bash
sudo docker pull --platform linux/arm64 cloudflare/cloudflared:2026.10.0
sudo python3 deploy/oracle-free/inference_preflight.py --tunnel
sudo docker compose -f deploy/oracle-free/inference-compose.json -f deploy/oracle-free/inference-tunnel-compose.json config --quiet
sudo install -m 0644 deploy/oracle-free/ziipa-inference-tunnel.service /etc/systemd/system/ziipa-inference-tunnel.service
sudo systemctl daemon-reload
sudo systemctl enable --now ziipa-inference-tunnel
```

For small+tunnel use `--small-host --tunnel`, add `inference-small-compose.json`
between those two files, and install `ziipa-inference-small-tunnel.service`.
Do not enable a second supervisor. After native loopback acceptance, save the
matching key in the **server** API configuration and set:

```dotenv
OS_ASSISTANT_INFERENCE_URL=https://<chosen-hostname>
OS_ASSISTANT_INFERENCE_HOST=<exact-chosen-hostname>
```

The API adapter permits HTTPS to that exact explicit hostname, or local HTTP
loopback; it rejects credentials, paths/query fragments, arbitrary hosts and
redirects. TLS verification stays enabled and environment HTTP proxies are not
used. Cloudflare terminates this optional HTTPS transport; private workspace
text passes through that infrastructure, so disclose that provider in privacy
documentation. A secret hostname is not authentication. Verify a request without
Bearer returns401 and actual model readiness with the right key returns the
chosen model before enabling hosted inference. Cloud/provider owner access and
this private secret transfer are necessary activation steps; source files do
not make the endpoint live.

## Worker activation, rollback and monitoring

Deploy the reviewed API migration once before starting agent/workflow workers.
Keep API and workers on the same reviewed release and matched database/Redis
scope. The agent uses `OS_AGENT_POLL_SECONDS=60` and
`OS_AGENT_RECONCILE_SECONDS=3600` to respect free quotas; account-owned queue
and receipts remain durable in PostgreSQL. Run one supervised agent worker,
not multiple copies of the same package. Scheduled workflow and renderer
workers are separate; their health/queue readiness must also be verified.

Monitor queue age, model failures/latency, task/step histories, worker heartbeats,
OOM/restarts, host free memory/disk and each free provider's quota. Inference
timeouts and small-instance contention are expected closed-beta limitations,
not successful task completion. Free infrastructure has no availability SLA and
does not make unrestricted public traffic affordable. No paid fallback, public
mainnet activation or autonomous provider spending is configured here.

For key rotation, first pause new agent work, disable hosted inference in the
API and stop the selected inference systemd unit. Atomically replace the
two-key protected gateway file without changing its permissions; securely
replace matching API key and the agent's separate `/etc/ziipa/agent-inference.env`
key, then restart/redeploy those
services and rerun both authenticated/unauthenticated checks. A restart is
required because the gateway reads its key only at startup. The old key must
return401. Rotate the tunnel token separately in its owner account if exposed.
Never rotate the API database password as part of inference-only setup.

Keep prior images/source for rollback and the model volume for persistence.
Disable agent/inference activation before rolling code back; do not blindly
downgrade durable task schema or erase completed receipts. `docker compose down`
without `--volumes` retains the model; do not prune shared Docker volumes. After
host recovery, check stale leases/recovered steps before restarting testers.
This document describes a deployable package; only recorded provider activation,
native tests and production user flows establish deployment completion.
