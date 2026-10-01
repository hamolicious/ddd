# ddd — Linux desktop

The server's PWA in a native window (Tauri 2 / WebKitGTK). Flutter has no Linux webview,
so this is not the `app/` shell. The page behaves as a browser tab — cookie login, service
worker, offline boot — and its `window.shell` (`session: "cookie"`) adds one thing: the
**notes folder**. Files work through native dialogs: exports ask where to save, imports open
the GTK file chooser.

## Notes folder

On first launch the app offers to keep your notes as Markdown files in a folder. Choose one
and every note is written there — folders as directories, attachments as their files — and
kept in step both ways while the app runs. Change or stop it in Settings → Local folder.

The choice is stored as `folder = "…"` in `~/.config/ddd/desktop.toml`. The folder's
`.ddd/` directory is the mirror's own state; leave it alone.

## Moving from life-manager

<!-- RENAME-HOP: one release only; the cleanup release removes this section. -->

The app used to be called life-manager. On its first start this version moves the old
build's files to the new names, by renaming (never copying):

| old | new |
|---|---|
| `~/.config/life-manager/` | `~/.config/ddd/` |
| `~/.local/share/app.life-manager.desktop/` (cookies, offline data) | `~/.local/share/app.ddd.desktop/` |
| `~/.cache/app.life-manager.desktop/`, `~/.config/app.life-manager.desktop/` | `…/app.ddd.desktop/` |
| `<notes folder>/.life-manager/` | `<notes folder>/.ddd/` |

`XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` are respected. A new directory that
already exists wins and the old one is left alone. If a move fails (say the two places are on
different filesystems) the app logs a warning and starts with fresh data, which the server
fills again; move or delete the old directory by hand while the app is closed.

When the server moves to its new address, the page asks the app to follow
(`window.shell.server.move`): the new address is written as `server_url` in
`~/.config/ddd/desktop.toml` and the app restarts on it.

## Setup (Arch)

```sh
sudo pacman -S --needed webkit2gtk-4.1 libsoup3 gtk3 librsvg
```

## NVIDIA

On the NVIDIA driver the shell sets two variables for itself so WebKitGTK stays on the GPU:
`WEBKIT_FORCE_DMABUF_RENDERER=1`, which lifts the block Debian's and Ubuntu's WebKitGTK
(and so the AppImage's) put on NVIDIA, and under Wayland `__NV_DISABLE_EXPLICIT_SYNC=1`,
which stops the driver's explicit sync from killing the window ("Error 71 (Protocol error)
dispatching to Wayland display"). Set any of those, or `WEBKIT_DISABLE_DMABUF_RENDERER`,
yourself and the shell leaves all of them alone. Do not reach for
`WEBKIT_DISABLE_DMABUF_RENDERER=1` unless nothing else works: it makes WebKitGTK 2.44 and
later render every frame on the CPU.

## Server

First match wins:

1. `--server https://ddd.example.com`
2. `DDD_SERVER_URL=https://ddd.example.com`
3. `~/.config/ddd/desktop.toml`:
   ```toml
   server_url = "https://ddd.example.com"
   ```

## Run / package

```sh
mise run desktop-run          # against the local server on :$PORT
cargo install tauri-cli --version '^2'
mise run desktop-bundle       # .deb + AppImage under target/release/bundle/
```

A debug build keeps its webview data (cookies, IndexedDB, service worker) in
`~/.local/share/app.ddd.desktop/dev-webview/`, apart from the installed app's. The
debug build links the system WebKitGTK and the AppImage bundles its own; WebKit upgrades
IndexedDB files to its own format but never downgrades them, so a shared directory left the
AppImage failing at boot with "Unable to establish IDB database file".
