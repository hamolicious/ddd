# brand

The ddd mark, shared by every client (web, desktop, Flutter).

| File | What it is |
| --- | --- |
| `logo.svg` | The master artwork. Edit this one; the others follow it. |
| `icon.svg` | The mark on a square, transparent canvas: favicons and `purpose: any` icons. |
| `icon-maskable.svg` | The mark on a white square, inside the maskable safe zone (radius 40%). |
| `render-icons.sh` | Renders every raster icon from these SVGs. |

Brand colour: `#ff6a00`. It is also the `theme_color` of both web manifests and the PWA's
`theme-color` meta tag.

## Changing the mark

1. Edit `logo.svg` (and `icon.svg` / `icon-maskable.svg` to match).
2. Run `./render-icons.sh` (needs `rsvg-convert` and ImageMagick's `magick`). It regenerates `desktop/icons/` and the Flutter Android, iOS,
   macOS, web and Windows icons under `app/`.
3. Commit the rendered output.

The web build serves `icon.svg` and `icon-maskable.svg` at the site root
(`web/vite.app.config.ts`), so `brand/` must be in the Docker image's build context.
