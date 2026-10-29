# Desktop portal

The production website exports the shared Expo application from `mobile/`.
Desktop chrome is enabled only when `EXPO_PUBLIC_PORTAL_MODE=true`, the runtime
is web, and its viewport is at least 1024 CSS pixels wide. Native applications,
standalone mobile previews and compact portal views retain the Figma mobile UI.
No second account, draft format or business API was introduced.

## Navigation and layouts

- Explore: published creation grid, categories, search, saved items and existing
  Watch playback. The desktop player is bounded to a portrait stage with context;
  playback, comments, reactions, sharing, reports and vertical paging are shared.
- Creator Studio: overview based on actual bootstrap data, a searchable library
  of owned creations and saved public inspiration, grid/list layouts, and entry
  points to the existing calendar, campaigns, recordings, publishing and networks.
- The desktop editor reuses the mobile controls in preview and inspector columns.
  Its persistent tool strip exposes media, trim/captions, text overlays, music,
  and save/publish. Editor navigation and per-creation Edit actions open the same
  composer; existing desktop drafts start on the editing tools.
  Unsaved desktop edits warn on route removal and browser close/reload. A save
  remains an explicit action; this UI does not introduce automatic saving.
- Media OS, wallet, profile, safety, account and legal routes remain available.
  Administration appears only after a validated current server permission response.
  All actual operations continue to be authorized by the API.

The collapsed sidebar and the Explore/Studio switch use the same navigator. Its
ancestors stay mounted across the compact breakpoint so resizing does not discard
an active editor or camera. Existing focus handlers still stop inactive media.

The existing sidebar toggle sits below the logo. Its arrow-and-lines icon points
in the expand/collapse direction. Explore's creation shortcut reads “Create”.

A floating desktop AI composer stays inside the main workspace, with reserved
bottom space so the last screen controls remain reachable. It reuses Media OS
chat and dictation, retains unsent text across routes, and shows replies without
leaving the current page. Opening the shared conversation in Media OS exposes
the existing proposal review and permission controls; the floating field does
not grant tools or execute proposals. Its state resets with the signed-in session.
Voice recognition starts only from the microphone button and edits text only.

## Browser URLs and privacy

Desktop destinations use `/studio/?view=...`; browser Back/Forward are handled by
React Navigation. `desktop-navigation.ts` projects a closed set of views, filters
and UUID identifiers. Session credentials, signed media URLs, complete draft
objects and private descriptions are never serialized into destination URLs.
Opening an owned draft by ID resolves it from the current account's bootstrap;
a missing or hidden source opens the library rather than another user's editor.

Browser routes and sidebar labels confer no additional provider, publishing,
wallet, streaming or administrator authority. Existing confirmations, credentials,
approvals, processing limits and release restrictions remain in effect.

## Verification

Run `npm run typecheck` and `npm test` in `mobile/`, `npm test` in `frontend/`,
then `npm run build` in `frontend/` to export Studio and build the website.
The private-media redirect test needs permission to bind a local loopback server.
Review `/portal` on a desktop and `/portal?layout=frame` with its Phone layout
toggle. The iframe changes width without being replaced, exercising the layout
breakpoint and retained editing state. Test publishing only with authorized
destinations; layout testing does not require posting to any external network.

## Desktop workspaces and gallery

Media OS uses compact per-tool headings instead of repeating global navigation
and a marketing hero. Assistant, workflows, insights, calendar, campaigns,
recordings, publishing, network connections and account settings arrange their
existing controls into desktop panels and list/detail views. Native/compact
business controls and permission checks are reused unchanged.

Explore includes a featured gallery and compact landscape creation cards. The
floating mobile Studio menu also has an explicit Gallery entry back to Main.
Gallery slides rotate with a short transition and play the active real media
muted; adjacent slides remain covers, with only one active gallery player.
Manual controls, screen focus, background state and accessibility motion
preferences govern rotation/playback. These are the requested additions to the
otherwise unchanged mobile layout. A gallery preview is not a broadcast or post.

Studio exports clear Metro's transformed-module cache, so switching local and
production public API origins cannot silently reuse a prior export's origin.

## Profile audience and visitor views

Creator avatar and handle links open the selected creator ID. Owner navigation
explicitly clears that ID. Both views provide compact reset, gallery, grid/list,
saved and tagged controls; saved collections and pending tags remain owner-only.
The carousel keeps every creation but displays no more than three moving bars.
Uploaded photos without a separate cover are their own neighboring-card stills.

Profile follower counts default to Ziipa. A small network selector uses an
anchored desktop dropdown and a compact-screen bottom sheet. Only connected or
linked networks appear; unavailable counts stay `—`, real zero stays zero, and
available counts include their update time. Provider totals are not inferred
from bounded imported-following lists. Public profile links do not verify network
account ownership or grant OAuth permissions.

The account submenu opens Dashboard. Its graphs use actual creation timestamps
and existing insights receipts. Its "Combined accounts" audience totals add known
network counts and identify missing values; these are not unique people.
Historical external reach, follower growth and verified revenue stay unavailable
until supported providers supply those metrics.

The profile lock opens an explicit followers-only privacy control. New followers
need owner approval; owners can review requests, remove followers and unfollow.
Private creations and selected artwork require an accepted relationship on the
server. Blocks revoke relationships in both directions, including legacy name
blocks; unblocking does not restore approval. Private drafts, saved collections,
signed-out Gallery access and public Discover eligibility remain separately
restricted. The additive `20261029_0015` migration is required before release.
