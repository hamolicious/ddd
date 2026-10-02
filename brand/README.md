# brand

The ddd mark, shared by every shell (web, desktop, Flutter).

| File | What it is |
| --- | --- |
| `logo.svg` | The master artwork, as drawn. Edit this one; the others follow it. |
| `icon.svg` | The mark on a square, transparent canvas: favicons and `purpose: any` icons. |
| `icon-maskable.svg` | The mark on a white square, inside the maskable safe zone (radius 40%). |

The web build serves `icon.svg` and `icon-maskable.svg` at the site root
(`web/vite.app.config.ts`), so `brand/` must be in the image's build context.

Every shell's raster icons (Tauri `desktop/icons/`, and the Flutter Android, iOS,
macOS, web and Windows icons under `app/`) are rendered from these SVGs by
`render-icons.sh`. Re-run it after changing the mark and commit the output.

The brand colour, `#ff6a00`, is also the `theme_color` of both web manifests and the
PWA's `theme-color` meta tag.
