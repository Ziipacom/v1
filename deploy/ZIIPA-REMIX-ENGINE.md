# Ziipa Remix Engine

Remix starts from media a creator has authorized for reuse. From a post, a Ziipa member chooses an allowed mode and a source range, then adds a response. Ziipa renders the combined media as a private draft. The creator can review, edit and publish the draft through Studio. Published remixes automatically credit the parent and the root original where those posts remain available to the viewer.

## What differentiates Ziipa

| Platform | Documented tools | Ziipa’s design response |
| --- | --- | --- |
| TikTok | Duet and Stitch, controlled through reuse settings and individual posts. [TikTok Stitch settings](https://support.tiktok.com/en/using-tiktok/creating-videos/stitch-settings) | Per-post choices for each reuse mode and immutable, multi-generation attribution. |
| YouTube Shorts | Audio reuse, Cut, Collab, and Green Screen. [YouTube Help](https://support.google.com/youtube/answer/10623810?hl=en) | Keep the licensed source range and receipt as editable project data. Allow creators to fork an approved template with replaceable source slots. |
| Instagram Reels | Green screen, horizontal and vertical split, picture-in-picture, and a response after the source. [Meta announcement](https://about.fb.com/news/2022/07/new-ways-to-create-instagram-reels-remix/) | Use reusable layouts, synchronized tracks, and a portable provenance manifest when the source license permits external distribution. |

The comparison covers the linked product documentation. The opportunity for Ziipa is to connect editing, permission history, attribution, and delivery receipts in one workspace.

## Implemented in this change

- **Stitch** joins 1–5 seconds of the published source with the member’s response.
- **Split-screen** plays the selected source and the response together, within the selected clip’s time window.
- **Use this sound** combines a permitted source audio segment with the response video. No more than the selected region is played.
- Creators can allow modes for all Ziipa members, followers, or nobody. Other creators’ media is unavailable for Remix until its owner enables a mode. A permitted post still has to be visible to the remixer.
- Projects have bounded clips, resource limits, explicit rights confirmation, an idempotent request key, and separate render and apply steps. The app can reopen the processed draft without republishing it automatically.
- This reuse permission covers signed-in Ziipa viewing. Anonymous gallery delivery, external adapters, download handoffs, marketplace attachments, and public wallet/IPFS pinning require a separate license path. The app does not grant that license.

## Persisted model

The executable schema is in `backend/migrations/versions/20261125_0020_remix.py`. The migration extends the previous Store schema. The primary graph is a directed acyclic graph in which a new derivative references an existing authorized item.

| Table | Identity | Durable facts |
| --- | --- | --- |
| `remix_policies` | One row per creation | Creator ID, policy revision, allowed audience and individual modes. A save checks the expected revision. |
| `remix_projects` | Derivative item UUID, with unique owner and request ID | Parent UUID, root UUID, source policy revision, media descriptors, absolute trim in milliseconds, mode, job ID and request digest. Apply records the output media ID and digest. Input and output digests are recorded against the same project. |
| `render_jobs` | Existing job UUID plus output-media lookup | Schema-four snapshot, state, claim lease, attempts, output dimensions, duration, and the result digest. The protected-media distinction survives deleting the derivative post while its render receipt and media remain. |

Each new edge runs from a derivative to an existing parent. For example, if B stitches A and C reuses B’s sound, B points to A as both parent and root. C points to B as parent and A as root. The parent index supports browsing branches, while the root index groups a whole remix tree. Delivery checks every ancestor using the current viewer’s access.

The service resolves the authorized source from the post on the server. It translates the member’s offsets relative to the published trim into absolute positions. A post with unbaked edit tracks must be rendered to an approved source first. Workers validate the data before reading storage and again before retaining output. Apply and publish check that the license is current and that the data matches the rendered artifact.

Parent and root UUIDs stay stable if a source is hidden or deleted. A live attribution response omits inaccessible names, titles, and links. The API projects a bounded set of visible children and links to the visible parent and root. If a recorded source grant changes or expires, queued or unapplied work becomes stale and affected derivatives are withheld from other viewers. Account export includes the creator’s own policies and projects. Account deletion removes owned records and media.

## Rendering and separation

The Remix worker uses the existing durable render queue and private media storage. It validates input ownership, reads only the referenced files, probes duration and streams, normalizes the selected intervals, and applies mode-specific FFmpeg composition. A successful result includes source, response and output SHA-256 values. A worker advertises Remix capability only when it supports schema four. Schema-three workers continue to handle ordinary projects. Drain old workers before accepting new Remix jobs. [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html)

`backend/remix_stems.py` implements the offline processor for one authorized range. It normalizes at most 30 seconds to a stereo PCM sample clock, verifies a pinned local model checkpoint, and validates four aligned WAV outputs with hashes. Demucs labels the tracks vocals, drums, bass, and other. “Other” is the remaining accompaniment, which can include several instruments. The processor requires a separately provisioned runtime and reviewed model. Tests exercise actual FFmpeg extraction and a synthetic model subprocess contract. [Demucs source separation](https://github.com/facebookresearch/demucs)

The stem processor is not connected to the creator UI or a production queue. Stem jobs need their own resource pool so separation cannot stall standard exports. Keep GPU or memory requirements, package and checkpoint checksums, model licenses, runtime results, and per-account quotas in the worker’s release configuration. Canary one accepted job before advertising the mode. Store stems as private material until the creator applies an authorized mix.

## Schema extensions for the full suite

These tables describe the next implementation boundary. The current migration includes the tables listed under the persisted model.

| Proposed table | Keys and invariants |
| --- | --- |
| `remix_recipe_revisions` | `(project_id, revision)` primary key. Immutable render recipe, timeline time base, model and renderer version, canonical SHA-256. One selected revision per project. |
| `remix_recipe_inputs` | `(project_id, revision, slot)` primary key. Order 0–5, permitted asset version, source range in milliseconds, target time, layout role, policy snapshot and digest. Inputs already exist before a derivative is published. Reject cycles and cap ancestry work. |
| `remix_stem_jobs` | Job UUID, owner and idempotency key, exact authorized input range, source and checkpoint digests, state, lease, attempt count and error category. Unique active job per authorized input version, range and model. |
| `remix_stem_assets` | `(job_id, role)` primary key. Role in vocals, drums, bass, or other. Audio media ID, frame count, sample rate and digest. All four rows publish to the private project atomically. |
| `remix_external_grants` | Grant UUID with source owner, licensed mode and range, destination and territory scope, commercial allowance, expiry, and version. One current grant per defined scope. Keep historical decisions for disputes and audit. |
| `remix_manifest_releases` | `(item_id, manifest_version)`. Sanitized public ingredients, output digest, canonical manifest hash, signature and key ID. Create only after review of each ingredient’s external permission. |
| `remix_revenue_terms` and `remix_revenue_allocations` | Versioned rights-holder allocations in basis points totaling 10,000. Each immutable allocation has one revenue event ID, currency, provider reference, recipient, amount and rights version. Unverified or disputed funds stay pending. |
| `remix_events_outbox` | Unique event UUID and `(aggregate_id, version, event_type)` constraint. Store availability time, lease, attempts and delivery time. Write events such as permission changed, render ready, and derivative published in the same transaction as the corresponding state change. Consumers deduplicate by event UUID and revalidate current permission before acting. |

For multicamera and audio layering, use a common output clock, explicit start and end times, and a render recipe that declares tracks and gains. Publish whole validated recipe revisions. For multiple stitches, each source interval is an independent rights-scoped input. For templates, export only approved editable structure and placeholders, never private file IDs, assets or unused outtakes. For green screen and depth effects, generate frame-aligned masks from a reviewed model and store them as private, versioned artifacts. Beat alignment, pitch and tempo changes should be replayable from the saved recipe and tested for sync across device types.

### Portable attribution and revenue

Attach a public, reversible Ziipa permalink to each allowed external delivery. A future signed manifest binds the exact output bytes to explicitly permitted ingredients, the renderer version, and the canonical recipe digest. Publish the signed manifest and provenance receipt only where the license allows them. A hash proves byte identity to a verifier. A C2PA integration can sign and attach an industry-compatible manifest, while a sidecar permalink survives provider transcoding or stripped metadata. Neither mechanism grants a license. [C2PA Technical Specification](https://spec.c2pa.org/specifications/specifications/2.2/specs/C2PA_Specification.html)

Revenue events must come from reconciled provider receipts. At confirmation, freeze the approved share version, flatten eligible multi-hop shares to recipients once, and round integer minor units deterministically so allocations sum to the net receipt. Use append-only adjustments for refunds and disputes. Exact clip usage and selected stems are evidence for the agreement, not a substitute for agreed percentages or commercial rights. Cash settlement remains a separate integration with the payout provider.

## Release acceptance

Verify source authorization with an owner, an allowed follower, and a blocked or unrelated viewer. Render generated test media for each supported mode and inspect duration, audio alignment, input and output hashes, and app playback. Revoke a source while a render is queued and after a derivative is published. Verify the resulting UI and all media delivery routes. Deploy the API migration and compatible worker together for Remix, then check readiness and run physical-device acceptance on the actual build. The current live renderer is offline. The new Remix capability must stay unavailable until the worker passes its readiness check.
