# Life Manager — Linux desktop

The server's PWA in a native window (Tauri 2 / WebKitGTK). Flutter has no Linux webview,
so this is not the `app/` shell. The page behaves as a browser tab — cookie login, service
worker, offline boot — and its `window.shell` (`session: "cookie"`) adds one thing: the
**notes folder**. Files work through native dialogs: exports ask where to save, imports open
the GTK file chooser.

## Notes folder

On first launch the app offers to keep your notes as Markdown files in a folder. Choose one
and every note is written there — folders as directories, attachments as their files — and
kept in step both ways while the app runs. Change or stop it in Settings → Local folder.

The choice is stored as `folder = "…"` in `~/.config/life-manager/desktop.toml`. The folder's
`.life-manager/` directory is the mirror's own state; leave it alone.

## Setup (Arch)

```sh
sudo pacman -S --needed webkit2gtk-4.1 libsoup3 gtk3 librsvg
```

## NVIDIA

On the NVIDIA driver under Wayland the shell sets `__NV_DISABLE_EXPLICIT_SYNC=1` for
itself, which keeps WebKitGTK on the GPU and stops the driver's explicit sync from killing
the window ("Error 71 (Protocol error) dispatching to Wayland display"). Set that variable,
or `WEBKIT_DISABLE_DMABUF_RENDERER`, yourself and the shell leaves both alone. Do not reach
for `WEBKIT_DISABLE_DMABUF_RENDERER=1` unless nothing else works: it makes WebKitGTK 2.44 and
later render every frame on the CPU.

The AppImage bundles the WebKitGTK of the image it is built on. Bookworm's 2.50 never
reaches the GPU on NVIDIA, so it is built on Trixie (2.52), and needs a glibc at least as new
as Trixie's (2.41) to run.

## Server

First match wins:

1. `--server https://life.example.com`
2. `LM_SERVER_URL=https://life.example.com`
3. `~/.config/life-manager/desktop.toml`:
   ```toml
   server_url = "https://life.example.com"
   ```

## Run / package

```sh
mise run desktop-run          # against the local server on :$PORT
cargo install tauri-cli --version '^2'
mise run desktop-bundle       # .deb + AppImage under target/release/bundle/
```

A debug build keeps its webview data (cookies, IndexedDB, service worker) in
`~/.local/share/app.life-manager.desktop/dev-webview/`, apart from the installed app's. The
debug build links the system WebKitGTK and the AppImage bundles its own; WebKit upgrades
IndexedDB files to its own format but never downgrades them, so a shared directory left the
AppImage failing at boot with "Unable to establish IDB database file".
