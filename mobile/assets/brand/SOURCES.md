# Ziipa native brand assets

- `ziipa-logo.png`: unmodified original from the website project. Source: https://ziipa.com/wp-content/uploads/2022/04/cropped-image_2022_04_13T15_54_13_541Z-1.png . Used in all in-app branding and splash.
- `ziipa-background.png`: original brand gradient from the website project. Source: https://ziipa.com/wp-content/uploads/2022/04/Background-1-1.8gb.png .
- Barlow font files in `../fonts/`: copied from the website's locally hosted Google Fonts assets; original source URLs are in `frontend/public/brand/barlow-source.css`.
- `app-icon.png`: separate launcher treatment generated with the built-in image tool on 2026-08-31 using the original logo as the edit target. Opaque RGB, square 1254×1254 source; Expo generates required native sizes. It is not a pixel-identical extraction and needs final brand approval before store release. It does not replace the original in-app logo.

The website's existing 451×451 favicon was inspected and found to crop away most of the mark, so it is not used as the launcher icon.

Final built-in prompt:

> Use case: precise-object-edit / compositing. Create the native iOS/Android launcher icon for the existing Ziipa brand. The provided image is the exact edit target brand logo, not an inspiration for redrawing. Isolate ONLY its existing purple-and-lime folded ribbon Z mark (including its existing white outer border), remove the wordmark 'ziipa' to its right, and center that exact mark on a completely flat opaque near-black violet background #110D1C. Preserve the exact Z silhouette, ribbon geometry, purple metallic shading and lime center from the source. No redesign, no additional embellishments, no new text, no shadows, no rounded outer corners (the OS applies them). 1024 by 1024 square PNG composition. Give the mark safe margins: it occupies approximately the central 60 percent of canvas height and width so it survives a circular Android icon mask. The entire canvas must be opaque with no transparency. This is production app-icon framing of the original brand, not new logo design.

The generated source differs from requested exact dimensions/geometry; the square framing was kept as a reviewable launcher draft. Full-resolution output was copied into this project; the original logo remains unchanged.
