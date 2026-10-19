# Ziipa Personal Media OS

Built on 12 October 2026 in the existing FastAPI service and shared React Native
Studio. The portal exports the same screens as mobile. This release adds no paid
provider or metered AI subscription. New code must still be deployed before these
features appear on public Ziipa domains or in distributed app binaries.

## The four stages

1. **Library and memory.** Private projects group owned uploads, drafts and posts.
   Assets have searchable titles, tags and notes, project links and explicit rights
   declarations. Original uploads can become a draft without reuploading. Preferences,
   style and context memories can be inspected, corrected or forgotten. Goals track
   checked steps; the system never assumes completion. Concurrent edits use revisions.
2. **Assistant.** Conversation uses an allowlisted set of Ziipa tools. Changes require
   a tool permission, a visible proposal and an explicit approval. Proposals expire,
   recheck ownership and permissions, and cannot execute shell commands, arbitrary
   requests, payments or automatic posts. Permissions can be revoked and conversation
   history cleared. Activity records show what was proposed, rejected and completed.
3. **Workflows.** Scheduled and recurring reminders, owned-creation rendering and
   supported public Bluesky synchronization run in a separate serial worker. Media-save
   and render-ready triggers have durable cursors. Run receipts survive process/Redis
   restarts, prevent duplicate occurrences, enforce reviewed targets and expose pause,
   cancellation and bounded retries. A rendered run completes only after the actual
   export is ready. A reminder produces a Ziipa receipt, not an email or push notification.
4. **Insights and economics.** Insights report recorded Ziipa likes, saves, comments,
   render jobs and delivery records. Rights declarations include license notes, source,
   expiry and explicit AI use permission. The ledger separates received/expected income
   and expenses, preserving each currency's minor units. It is user-reported accounting,
   not verified payment settlement, tax reporting or external platform analytics.

Wallet signatures, testnet minting, IPFS provenance and existing publishing/exports
remain in their existing Studio tools. An Assistant proposal cannot bypass their
rights, channel selection, signing or consent checks.

The subsequent [Creation Campaigns release](CREATION-WORKFLOWS.md) connects private
preparation, reviewed transcripts/captions, exact rendered artifacts, explicit
schedule/destination approval and delivery receipts in the shared Studio. It uses
separate campaign authority; the Assistant/Agent and the reminder/render/sync
workflow tool allowlists remain unchanged.

## Assistant modes and privacy

Guided commands work without an inference service:

```text
Create a project called Summer launch
Remember: Keep my captions short
Set a goal: Prepare three launch clips
Find concert
Show insights
Remind me to review clips at 2026-12-10T17:00:00Z
Open networks
Render <owned-creation-UUID>
```

Enable the corresponding tool in Assistant permissions before requesting a change.
Reviewed reminders start paused; enable their schedule in Workflows. Music exports
still require soundtrack rights confirmation in Exports.

Optional open-ended planning uses a downloaded Ollama model on the API host. The
local review setup has the official portable runtime and `qwen3:1.7b`, bound to
`127.0.0.1:11434` with cloud inference disabled. The API sends bounded text context:
current opted-in memories, project/goal names and asset titles/tags with effective
AI rights. It never sends media files, storage URLs, OAuth tokens, passwords or
wallet keys. Model proposals undergo the same validation as guided commands.

The Assistant does not automatically extract video transcripts, perform vision
analysis, control the operating system or autonomously publish to arbitrary networks.
Deleting a saved memory removes it from future prompts and redacts its linked
save conversation. Clear conversation to remove other messages and old proposals.
Personal data is included in account export and removed during account deletion.

## Run locally

Creation Campaigns also support real portrait/square/landscape exports and exact
per-destination review. The shared Calendar adds private timezone-aware plans,
bounded recurrence, in-app reminders and read-only streaming preflight. It uses
the same workflow process with `OS_CALENDAR_ENABLED=true`; no separate scheduler
is required. Calendar plans never approve or reschedule a campaign, start a device
camera, or enable public ingest. See [CREATION-WORKFLOWS.md](CREATION-WORKFLOWS.md).

Use the existing Ziipa PostgreSQL and Redis services. Apply the additive migration
before starting API/workers:

```text
python render_migrate.py
```

Set `OS_WORKFLOW_ENABLED=true` on the API and workflow worker, then run
`python workflow_worker.py` as a separate supervised process. The renderer remains
separate. Workflow deadlines/leases and wake hints avoid continuous idle database
queries; an hourly reconciliation recovers missed hints. Redis allowances still
apply. The existing Oracle Always Free deployment has a separate bounded workflow
container package under `deploy/oracle-free`, using the same private environment
file, ARM image and no public ports.

For local AI, run `ollama serve` with `OLLAMA_HOST=127.0.0.1:11434`,
`OLLAMA_NO_CLOUD=1`, then `ollama pull qwen3:1.7b`. Set
`OS_ASSISTANT_LOCAL_AI_ENABLED=true`. The config endpoint displays `local_ai` only
when the selected model is actually available; otherwise the app uses guided mode.
Do not set this flag on a hosted API that has no local model.

The local review helper `.local/start-review.ps1` starts the API, renderer, workflows,
mobile preview, website and available local model. It is ignored local tooling and
must never be copied as a production environment or expose development passwords.

Browser preview requests are bounded to three simultaneous workspace calls. On a
development preview opened at localhost, the local API uses the same loopback host;
phone and LAN previews retain their configured network address. The portal uses
its same-origin API proxy. After exporting Studio, restart the website dev server
so its public-file inventory includes the new hashed bundles, then reload the page.

## Deployment and acceptance

Deploy API and frontend from the same reviewed release, with the migration first,
and rebuild the shared Studio export. The worker must use that release too. Existing
accounts and media remain compatible; the migration creates new owner-scoped tables
and does not remove existing data. Rollback preserves new workspace data.

Before public acceptance, verify provider OAuth permissions, external synchronization
limits and actual publishing receipts with authorized accounts. Closed provider feeds,
external analytics, automated settlement, push/email notifications and app-store
signing are separate integrations. Neither a successful local test nor a saved cloud
environment variable proves a public deployment or store release.
