# Ziipa native brand assets

- `ziipa-favicon.png`: the owner-requested standalone Z artwork reused byte-for-byte from the confirmed account avatar on 2026-10-25. Selected as the native launcher icon and Android adaptive foreground on 2026-10-27, matching the user's profile-Z request. Shared with the website favicon; the image contains no wordmark. The unmodified source is 1080×1080 opaque RGB PNG with no alpha channel or transparency chunk; Expo generates required native sizes. SHA-256: `f004365c505105d5f446488a00ccb3396a1fcd6df55e44055286fdd46fe6aa62`.

- `ziipa-logo.png`: unmodified original from the website project. Source: https://ziipa.com/wp-content/uploads/2022/04/cropped-image_2022_04_13T15_54_13_541Z-1.png . Original white-wordmark version, retained for dark-mode branding.
- `ziipa-logo-light.png`: owner-requested light-mode variant made on 2026-10-20 by converting only the original wordmark RGB to black. The split is at x=4050 inside the original transparent gap; every alpha value and every symbol pixel is preserved. Dimensions remain 9446 x 3104. No symbol inversion, redrawing, background or font substitution. Shared Studio selects it only when its resolved theme is light; dark mode retains the unmodified original.
- `ziipa-background.png`: original brand gradient from the website project. Source: https://ziipa.com/wp-content/uploads/2022/04/Background-1-1.8gb.png .
- Barlow font files in `../fonts/`: copied from the website's locally hosted Google Fonts assets; original source URLs are in `frontend/public/brand/barlow-source.css`.
- `app-icon.png`: retained, unused historical launcher draft generated with the built-in image tool on 2026-08-31 using the original logo as the edit target. Opaque RGB, square 1254×1254 source. It is not a pixel-identical extraction and is not selected by the current app configuration. It does not replace the original in-app logo or the confirmed profile artwork.

The historical 451×451 website favicon cropped away most of the mark and was rejected. It is distinct from the current 1080×1080 confirmed-avatar `ziipa-favicon.png` selected above.

Historical unused-draft prompt:

> Use case: precise-object-edit / compositing. Create the native iOS/Android launcher icon for the existing Ziipa brand. The provided image is the exact edit target brand logo, not an inspiration for redrawing. Isolate ONLY its existing purple-and-lime folded ribbon Z mark (including its existing white outer border), remove the wordmark 'ziipa' to its right, and center that exact mark on a completely flat opaque near-black violet background #110D1C. Preserve the exact Z silhouette, ribbon geometry, purple metallic shading and lime center from the source. No redesign, no additional embellishments, no new text, no shadows, no rounded outer corners (the OS applies them). 1024 by 1024 square PNG composition. Give the mark safe margins: it occupies approximately the central 60 percent of canvas height and width so it survives a circular Android icon mask. The entire canvas must be opaque with no transparency. This is production app-icon framing of the original brand, not new logo design.

That generated source differs from the requested exact dimensions/geometry. It is preserved only as an unused historical draft; the current launcher uses the confirmed avatar bytes without bitmap editing.
