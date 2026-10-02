# ddd — Linux desktop

The server's PWA in a native window (Tauri 2 / WebKitGTK). It is separate from the Flutter
`app/`, which has no Linux webview.

The page behaves like a browser tab: cookie login, service worker, offline boot. On top of
that the desktop app adds:

- **A notes folder** that mirrors your notes as Markdown files (below).
- **Native file dialogs**: exports ask where to save, imports open the GTK file chooser.

Released `.deb` and AppImage builds are attached to GitHub Releases.

## Requirements (Arch)

```sh
sudo pacman -S --needed webkit2gtk-4.1 libsoup3 gtk3 librsvg
```

## Server

The first match wins:

1. `--server https://ddd.example.com`
2. `DDD_SERVER_URL=https://ddd.example.com`
3. `~/.config/ddd/desktop.toml`:
   ```toml
   server_url = "https://ddd.example.com"
   ```

## Notes folder

On first launch the app offers to keep your notes as Markdown files in a folder. Every note is
written there (folders as directories, attachments as files) and kept in sync both ways while
the app runs. Change or turn it off in Settings → Local folder.

- The choice is stored as `folder = "…"` in `~/.config/ddd/desktop.toml`.
- The folder's `.ddd/` directory holds the mirror's state. Do not edit or delete it.

## Run and package

```sh
mise run desktop-run          # against the local server on :$PORT (or $DDD_SERVER_URL)
mise run desktop-install      # builds and installs ~/.local/bin/ddd, its icons and launcher entry

cargo install tauri-cli --version '^2'
mise run desktop-bundle       # .deb + AppImage under target/release/bundle/
```

## NVIDIA

On the NVIDIA driver the app sets these for itself so WebKitGTK stays on the GPU:

| Variable | Why |
|---|---|
| `WEBKIT_FORCE_DMABUF_RENDERER=1` | Lifts the NVIDIA block in Debian's and Ubuntu's WebKitGTK (and so the AppImage's) |
| `__NV_DISABLE_EXPLICIT_SYNC=1` (Wayland only) | Stops `Error 71 (Protocol error) dispatching to Wayland display` closing the window |

If you set any of these, or `WEBKIT_DISABLE_DMABUF_RENDERER`, yourself, the app leaves all of
them alone. Avoid `WEBKIT_DISABLE_DMABUF_RENDERER=1` unless nothing else works: on WebKitGTK
2.44 and later it renders every frame on the CPU.

## Notes for contributors

- **Icons.** `icons/` is rendered from `brand/` by `brand/render-icons.sh`. Tauri on Linux uses
  the *first* PNG in `bundle.icon` as the window icon, so `icon.png` (512 px) must stay first.
- **Debug webview data** (cookies, IndexedDB, service worker) lives in
  `~/.local/share/app.ddd.desktop/dev-webview/`, separate from the installed app's. Keep it
  that way: debug builds link the system WebKitGTK while the AppImage bundles its own, and
  WebKit upgrades IndexedDB files but never downgrades them. Sharing the directory makes the
  older WebKit fail at boot with "Unable to establish IDB database file".
