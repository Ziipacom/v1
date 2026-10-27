# Opt-in public gallery addresses

The owner settings API is shared by web and Android. `GET /api/creator/gallery`
returns `slug`, `enabled`, `revision`, `public_url`, `profile_public` and
`pending_render_count`. No address or public access exists by default.
`POST /api/creator/gallery` accepts exactly `{slug, enabled, revision}`.
New settings use revision 0; updates must supply the current revision.

Names normalize to lowercase and permit 3–40 ASCII letters, digits and single
hyphens. Reserved system names are rejected. A database primary key arbitrates
cross-account name claims, and a unique owner/current-name record plus an account
row lock serializes updates. Previous names remain reserved to the same owner
until account deletion, with at most ten names per account. Renaming immediately
makes the former public URL unavailable; no redirect or alias exposes the gallery.

`POST /api/creator/gallery/disable` accepts only `{revision}` and revokes the
existing public link without renaming, changing privacy or reserving a name.
This exact authenticated, guarded route remains usable during maintenance;
enabling and renaming remain blocked. Disabled settings retain their name.

Public URLs use the configured `PUBLIC_APP_URL` origin, never a request Host
header. Hosted origins must use HTTPS; HTTP is accepted only for local preview.
The API stores no provider credential and activates no paid plan or worker.

## Anonymous access and original media

`GET /api/public/galleries/{slug}` returns only the current creator display name,
current owned avatar/cover paths and a paginated whitelist of owned, published,
unmoderated original media. Page size is at most 24 with an opaque date/ID cursor.
When the owner selects a bundled cover instead of an upload, `cover_url` may
also be one of the six existing allowlisted public cover assets. Arbitrary
profile URLs are never used, and an unavailable upload does not fall back to an
old bundled selection. Bundled assets are already public and cannot be revoked
by disabling a gallery; the gallery's uploaded artwork routes remain revocable.
`unavailable_count` describes published creations requiring a finished export;
it excludes private drafts and hidden or foreign media. The owner's matching
`pending_render_count` does not mean a render job was queued.

An original is eligible only when it has no trim, timeline, captions, overlays,
soundtrack or visual effect requiring a finished export. Edited creations are
excluded from both listing and direct media access: **the gallery never falls
back to an uncut original and exposes outtakes**. This first version does not
select ready render jobs. A separately saved already-baked owned media file with
clear edit metadata can be published as an ordinary original. Rendering-worker
restoration, provenance checks and export publication remain separate work.

`GET /api/public/galleries/{slug}/items/{item-id}` returns the same safe item
projection. Its `media_url` is a relative gallery media route; image `cover`
uses that route, while video/audio covers are null. Source/editor IDs, raw
recognition cues, editor instructions, private notes, email, city, distribution
state and storage URLs are never included.

Every metadata, media and artwork request rechecks current gallery consent,
owner existence/activity, profile privacy, publication, source ownership and
moderation. Profiles must be deliberately **public**; members-only and private
profiles block anonymous access immediately. `discoverable=false` alone does
not revoke an explicitly enabled direct link. Changing the current artwork
invalidates its old gallery artwork URL. Suspension, deletion, unpublication,
disable and rename revoke subsequent requests. Already downloaded bytes cannot
be erased from another person's device.

All responses are no-store. Anonymous requests use the existing fail-closed
origin/rate guard. Local media uses bounded verified file paths; private R2
objects are served through a range-aware proxy with verified type, size, ETag
and exact range. Range responses are capped at 8 MiB and streamed in at most
64 KiB chunks. No signed object URL or redirect is given to anonymous visitors.
Account export includes settings and reserved names; account deletion removes
both, without changing the existing profile artwork save contract.

## Schema and verification

Additive Alembic head `20261027_0013` adds `public_gallery_slugs` and
`public_galleries`, following `20261020_0012`. Existing accounts remain opted out.
Apply migrations before deploying a release that uses these endpoints.
Fresh and repeated migration tests create no enabled gallery or owner name.
Tests use generated records, isolated SQLite or a local PostgreSQL rollback
schema, and mocked storage. They never enable a real account's gallery or send
media to a third-party service.
