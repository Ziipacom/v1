# Ziipa creation and distribution workflows

Creation Campaigns connect a saved Studio video, private preparation, reviewed
captions and copy, an approved MP4, an explicit schedule and separate destination
receipts. The mobile app and portal use the same React Native screen and FastAPI
records. This first implementation does not make every provider active or
complete the later Media OS roadmap.

## Create and review a campaign

1. Upload or record a video in Creator Studio and save it to your account.
   Open Campaigns from the saved video or Media OS. Demo media cannot be used.
2. Name the campaign, edit the publication copy and confirm distribution rights.
   Transcription and AI copy are opt-in. Automatic processing also requires an
   unexpired Library rights declaration with Allow AI enabled.
3. Prepare the video. The existing renderer applies the saved trim, captions,
   overlays and owned soundtrack. Optional whisper.cpp speech recognition runs
   locally; optional Qwen copy suggestions use Ziipa's private inference adapter.
   Suggestions do not silently edit or publish anything. Unavailable processing
   retains a visible manual correction path.
4. Review transcript words and timestamps. Explicitly apply reviewed caption cues
   to Studio if wanted; this queues a new render and invalidates the old review.
   Applying suggested copy also requires saving and reviewing the new revision.
5. Choose actual connected destination accounts, provider-supported visibility and
   a date/time with an explicit timezone. Review playback of the rendered MP4.
   Approve Ziipa publication and every selected external destination separately.
6. Follow the durable campaign and individual destination receipts. Approval is
   not publication. Pausing/cancelling prevents further handoffs, but cannot recall
   an already sent provider request. Never repeat an uncertain post blindly.

At the approved time, Ziipa creates a separate owned post referencing the exact
reviewed rendered MP4. Baked captions and effects are not applied a second time.
The campaign retains its original source and render lineage; its editable source
draft stays private, and an existing source post stays unchanged. Provider
handoffs use this rendered publication. Once it exists, the campaign's content
cannot be edited or prepared again, including after pausing a partial delivery.

## Platform video versions

Choose original, portrait (720×1280), square (720×720) or landscape (1280×720)
versions of one saved Studio edit. Each selected version is a real queued FFmpeg
export with its own source/edit fingerprint and output SHA256. The preset uses
contain padding: it preserves the full source frame instead of guessing which
person or subject to crop. Scene selection, automatic subject tracking, long-form
production and a multitrack timeline are not implemented.

Select the Ziipa feed version and a version for each external destination. Review
all selected exports before approval. Changing formats, destinations or the
schedule invalidates approval. The Ziipa version becomes the public local post;
other versions stay private owned derivatives for their approved distribution
destinations. They do not create duplicate public Ziipa posts. Original Studio
exports keep their existing fingerprints for compatibility.

Rendering limits remain 90 seconds, 25 MiB per output and a 1280-pixel long edge.
Presets do not guarantee acceptance by every platform: current provider account,
privacy, size and upload restrictions still apply. Uploaded originals stay private
until their own explicit publication; retaining them does not require IPFS or a
token.

## Calendar and streaming preparation

The shared Calendar stores private plans in PostgreSQL and uses the existing
workflow process for durable reminders. Named IANA timezones retain local wall
times across daylight-saving changes. Ambiguous fall-back times require an
explicit earlier/later choice, and nonexistent spring-forward occurrences are
skipped. Repeats are bounded and can be paused or cancelled. A missed event is
reported distinctly; it does not replay a public action after a long outage.

Campaign entries reflect their separately approved publication schedule. Calendar
plans do not approve content or silently reschedule an approved campaign. Private
calendar exports contain no OAuth tokens, encoder keys or ingest URLs.
ICS downloads are limited to 1,000 occurrences and fail explicitly above that
limit. Use `/api/os/calendar/export.ics` with `event_id`, `starts_after` and/or
`starts_before` to narrow a larger export. Date filters require timezone offsets;
the end is exclusive. Cancelled series are omitted, including retained reminder
history, so an acknowledged old occurrence is not exported as a confirmed plan.

Streaming plans provide a preflight checklist and a reminder to open Live. The
schedule does not grant camera/microphone permissions, create a billable provider
stream, enable public ingest or attach a Twitch destination. Those actions retain
the existing explicit Live controls. A provider-confirmed fresh live state is
required to report an active broadcast; an event reaching its time is not proof
that any stream started. Missing provider setup remains visible.

## Durable state and approvals

Postgres owns campaign revisions, source fingerprints, exact rendered output
digests, approval manifests, due times and delivery receipts. Redis supplies wake
hints and scoped worker capability heartbeats; losing it does not erase approvals.
The existing serial workflow process advances bounded campaign stages. Lease
expiry/restart recovery does not authorize a new publication.

Approval binds the campaign revision, source/editor/rights state, rendered media
SHA256, copy, account targets, visibility and schedule. Mutations invalidate the
review. Provider handoffs also recheck campaign authorization at their existing
checkpoints, so a pending cancellation or permission/source change stops later
provider steps. Publication requests retain stable request IDs and reuse existing
provider receipts instead of assuming a lost response means a failed upload.

Campaign creation and preparation never grant unattended publishing to the general
Assistant or Agent. Those tools retain their existing restrictions. Payment,
wallet signing, travel purchase, invitations and arbitrary code are not campaign
actions. Account export includes campaigns; account deletion removes their private
records through the existing authenticated deletion flow.

## Provider boundaries

YouTube, Bluesky, managed Facebook Pages and professional Instagram use the existing
publishing adapters and their current credentials, selected accounts, scopes and
operator gates. A saved campaign does not establish developer approval or OAuth.
TikTok requires its current creator/source review and disclosures in Publishing;
the campaign exposes a handoff instead of bypassing that experience. Twitch uses
Live/channel controls, not this finished-video publishing path. Missing credentials,
processing, rejected, blocked, handoff and uncertain outcomes remain distinct from
delivered.

## Local and hosted operation

Apply `python render_migrate.py` before starting this release. Enable
`CREATION_CAMPAIGN_ENABLED=true` and `OS_WORKFLOW_ENABLED=true` on the API and the
existing `python workflow_worker.py` process. Run the renderer separately with
matching database, storage and quota configuration. Model setup is described in
[local speech](deploy/local-speech/README.md) and the optional
[CPU image](deploy/transcription/README.md). Requests never download models.

Enable `OS_CALENDAR_ENABLED=true` on the API and workflow process to advance
calendar reminders. Leave it false on unaccepted hosted instances. No new cron
service or paid scheduler is needed. In-app reminders work independently of
optional device push. Push requires its own configured worker, category/device
consent and browser/native provider acceptance; this calendar flag does not grant
those permissions. Email delivery and external calendar account sync remain open.

Rebuild the portal's shared Studio with `npm run build:studio` from `frontend`,
then restart its dev server to refresh hashed assets. Metro serves the same
mobile source. Native installed apps need a new build to include these screens.

No cloud setting or credential transfer is required to review this locally. The
existing Oracle workflow package intentionally has no social provider secrets and
keeps campaigns disabled by default. Do not copy an API environment into it or
increase its resource allowances as an implicit deployment step. Hosted publishing
needs a separately reviewed execution environment and real provider acceptance;
speech needs measured CPU/RAM/scratch capacity and a pinned local model. Keep all
new hosted flags off until those checks pass. Free capacity is not guaranteed.

## Remaining implementation order

1. Accept real authorized provider receipts and native device playback for the
   creation-to-distribution workflow and its platform versions. Add richer media
   understanding and subject-aware reframing after measured rendering acceptance.
2. Accept signed provider webhooks, optional notification delivery and private
   recording-to-clips workflows against the real Ziipa Livepeer project and real
   test devices. Their shared UI/backend are now implemented; see
   [the operation runbook](backend/LIVE-RECORDINGS-PUSH.md).
3. Add real playback and permitted external analytics, attribution and verified
   economics. Unavailable metrics must stay unavailable, never synthetic zeros.
4. Add portable public Ziipa records and federation, followed by scoped personal
   email/calendar connectors. Commercial spending requires a supported provider,
   explicit budget policies, payment receipts and separate purchase authorization.

Stage two still needs external acceptance; stages three/four remain a roadmap.
Private memories,
email, drafts and payment information must never automatically become public
AT Protocol or IPFS data.
