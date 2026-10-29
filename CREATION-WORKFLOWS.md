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

## Creator automation audit — 29 October 2026

This is a source audit and proposed implementation sequence, not acceptance of
live calendar connectors, a restored renderer, or unattended production. The
existing calendar API explicitly reports `automatic_broadcast: false` and
`automatic_campaign_delivery: false`. The limited `scheduler_worker.py` profile
rejects media, agent, recording, provider-sync and campaign execution flags.
Keep this least-capable reminder worker separate from any production executor.

### Product patterns reviewed

[Muse's developer-provided App Store description](https://apps.apple.com/us/app/muse-from-meta/id6760173601)
describes connected calendars, scheduling-conflict handling, reminders,
goal-to-plan execution, continued work after the app closes, attention
notifications, approvals and an activity log. These are product claims, not a
published implementation or independent reliability test.

[Instinct's official site](https://instinct.com/) describes a text/call assistant
that acts through phones and computers. Its [privacy policy](https://instinct.com/privacy-policy)
specifically confirms optional Google Calendar/Workspace access, calendar-event
context, actions, revocation and deletion controls. Its public documentation does
not establish a complete recurring-calendar, provider or notification feature
matrix. Do not treat third-party example prompts as verified functionality.

For Ziipa, adopt the connected-context, persistent-plan and exception-notification
patterns, with explicit creator rights and destination controls. An imported
calendar description is untrusted event data, never an agent instruction or
permission to publish, invite guests, expose a private draft or spend money.

### Existing foundations and missing behavior

| Capability | Existing implementation | Remaining work |
| --- | --- | --- |
| Calendar | Owner-scoped events, daily/weekly repeats, timezone/DST handling, reminders, pause/cancel and bounded ICS export | Two-way account connections, provider event identity/versions, cancellations and exceptions, conflict checks and authenticated creation links |
| Notifications | Consented calendar/recording/campaign categories, private generic messages, device records, durable queues and provider receipts | Production/device acceptance, production-stage and approval-needed alerts, quiet hours, digests, snooze and cross-device acknowledgement |
| Assistant | Text/voice entry, private tools, explicit permissions, proposal review, bounded autonomous private tasks and activity history | Typed calendar tools and a reviewed recurring series/episode production template |
| Creation | Saved Studio edits, captions/audio tools, render jobs and recording/clip foundations | A fresh episode draft per occurrence, topic/source selection, script-to-audio/video assembly and accepted production rendering capacity |
| Distribution | Revision-bound campaign approvals, per-destination receipts and provider-specific adapters/gates | A series coordinator linking calendar, episode, preparation, approvals, scheduled deliveries and per-network recovery |
| Live | Livepeer ingest, explicit start controls, Twitch destination handling and readiness checks | Scheduled event provisioning, independently eligible live destinations, encoder/source health, multichannel acceptance and post-live processing |
| Podcast delivery | Media creations and generic campaign delivery | Podcast-series metadata and a valid hosted RSS feed with stable episode GUIDs, enclosures, artwork and distribution validation |

Code existence is not proof that a provider is authorized or that a worker is
healthy in production. Oracle rendering recovery remains unresolved. Upload/import
permissions do not establish publishing or live-broadcast permissions.

### Recommended central workflow

Create one durable **series** with an owner-reviewed template: timezone, recurring
release time, finite horizon, episode format/duration, approved source library,
voice/music rights, preparation lead time, selected account destinations, privacy,
approval mode and resource limits. Materialize a distinct **episode** for each
occurrence; do not re-render the same saved target and call it a new episode.

For “create my podcast every Friday at 8 AM,” confirm the timezone, first Friday,
whether 8 AM means recording, live start or finished release, and the intended
duration/source. Schedule preparation before release based on measured job times.
Resolve calendar conflicts without silently moving a public release. The sequence
is: prepare brief/script, create private draft, generate/assemble permitted media,
render, validate captions/audio and rights, obtain the required review, deliver
to the selected authorized destinations, verify receipts, then notify the owner.

Use one series/episode record and idempotent stage IDs across clients. Show
draft, preparing, awaiting review, scheduled, live, processing, delivered,
partially delivered, blocked, uncertain and cancelled states accurately. A timeout
after a provider mutation requires reconciliation before retrying. Cancellation
stops later stages; a reschedule or changed artifact invalidates affected reviews.
Missed public releases after an outage require a defined skip/review policy.

Default to reviewing each newly generated episode before publication. A future
unattended mode needs its own explicit, revocable series policy with approved
accounts, formats, rights, budgets, expiry and stop conditions. A connected
calendar or general chat permission must not silently grant that authority.

An imported pitch meeting should create an optional **suggestion**, not a public
production. After acceptance, create a linked private presentation draft and
preparation task, then write an authenticated Ziipa creation link to the chosen
calendar event. Keep existing attendees/meeting details intact and do not send
invitations implicitly. Externally shared links still enforce Ziipa access; never
write bearer tokens, signed media URLs or secret stream keys into an event.

### Calendar and execution architecture

- Google: narrowly scoped OAuth, selected calendars, incremental event sync with
  stored sync tokens, change-channel renewal and bounded reconciliation. Google
  [change notifications](https://developers.google.com/workspace/calendar/api/guides/push)
  wake sync; [incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync)
  retrieves the actual changes and handles invalid tokens.
- Outlook/Microsoft 365: Microsoft Graph calendar authorization and
  [event delta queries](https://learn.microsoft.com/en-us/graph/delta-query-events),
  with subscription renewal and conflict-safe writes. Teams meetings in these
  calendars can be imported; creating a Teams meeting or media broadcast is a
  separate capability and authorization.
- Apple Calendar: distinguish device EventKit from server synchronization. Apple's
  [EventKit access model](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)
  requires full access for reading existing events; write-only access is
  insufficient. Device access alone does not establish an always-running cloud
  calendar service. Evaluate iCloud CalDAV separately, or sync an underlying
  Google/Microsoft account already visible in Apple Calendar. ICS remains export,
  not a two-way connection.
- Store provider IDs, recurrence/exception identity, versions, origin markers,
  sync cursors and per-event mappings. Apply optimistic concurrency, loop
  prevention and deletion tombstones. A calendar edit changes its linked plan
  only under a reviewed policy; shared attendees do not acquire Ziipa access.
- Keep calendar data private and excluded from ads, Discover, public galleries,
  IPFS and model training. Only send necessary event context for an expressly
  requested creation. Expose disconnect, retained-data deletion and sync health.
- Run schedules on durable server workers, independent of whether a phone is
  open. A live camera/microphone session still requires an available source and
  explicit device access. Recorded media can be scheduled separately from live
  capture. Do not imply that a closed iPhone app will start recording itself.
- Expose destination-specific eligibility. For example, YouTube's
  [broadcast creation API](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert)
  requires a scheduled start and live permissions; it can reject a channel that
  is not live-enabled. A generic “all networks” switch cannot replace these
  checks. Unsupported networks must show a handoff or unavailable status.

### Build and acceptance order

1. Add Google and Microsoft calendar connections with two-way event edits,
   disconnect/revoke handling, recurrence and duplicate/conflict tests. Add the
   Apple path with its own device/server constraints visibly stated.
2. Add series/episode records and calendar-linked private drafts; connect the
   global Assistant to typed tools and owner-reviewed production templates.
3. Restore/accept the renderer and generation services within measured free
   capacity; add per-stage resource admission, storage limits and diagnostics.
4. Prove one prerecorded episode end to end before live simulcasting. Confirm
   render checksums, real provider delivery URLs and each network's acceptance.
5. Add scheduled live provisioning, source preflight, recording-to-clips and
   podcast RSS, with independent provider permissions and rights review.
6. Add actionable notifications and a central run view. Test permission loss,
   daylight-saving transitions, concurrent mobile/web edits, retries, outages,
   cancelled events, insufficient quota and partially successful destinations.

Reuse the existing database, queues and workers where their resource/privilege
profiles permit. Bound reconciliation and AI/render work, cache idempotent
results, and stop at free-tier limits. This plan activates no paid provider,
calendar access grant, notification consent, publisher capability or cloud change.

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

## Creator profile implementation checkpoint · 2026-10-29

Shared client/backend work now includes visitor profiles reached from creator
avatars and handles, list/grid/gallery/saved/tagged controls, owner-approved tags,
opt-in public imported-post collections, a real-metrics Dashboard, and Ziipa
follow/follow-request relationships. The lock control persists followers-only
privacy and server access checks cover published posts, selected artwork and
source media. New requests require owner approval; removal and blocking revoke
access. Saved media, drafts and pending tag requests remain private.

Profile audience selection defaults to Ziipa, with separate connected-network
counts and known update timestamps. Bluesky receipts preserve actual reported
follower/following counts; other unavailable metrics stay `—`. Bounded import
lists never substitute for audience totals. Dashboard's "Combined accounts"
label explicitly permits duplicate people across networks. No external sync,
permission grant, paid service or network publishing is implicitly activated.

These changes require the additive profile-tags/follows migration
`20261029_0015`. Local acceptance does not complete provider review, external
calendar connections, production rendering recovery, device voice acceptance,
store publication or native signed-release distribution.
