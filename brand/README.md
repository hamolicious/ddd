# brand

The ddd mark, shared by every shell (web, desktop, Flutter).

| File | What it is |
| --- | --- |
| `logo.svg` | The master artwork, as drawn. Edit this one; the others follow it. |
| `icon.svg` | The mark on a square, transparent canvas: favicons and `purpose: any` icons. |
| `icon-maskable.svg` | The mark on a white square, inside the maskable safe zone (radius 40%). |

The web build serves `icon.svg` and `icon-maskable.svg` at the site root
(`web/vite.app.config.ts`), so `brand/` must be in the image's build context.
