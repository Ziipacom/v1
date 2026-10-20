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
  Unsaved desktop edits warn on route removal and browser close/reload. A save
  remains an explicit action; this UI does not introduce automatic saving.
- Media OS, wallet, profile, safety, account and legal routes remain available.
  Administration appears only after a validated current server permission response.
  All actual operations continue to be authorized by the API.

The collapsed sidebar and the Explore/Studio switch use the same navigator. Its
ancestors stay mounted across the compact breakpoint so resizing does not discard
an active editor or camera. Existing focus handlers still stop inactive media.

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
