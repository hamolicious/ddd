# Life Manager — Linux desktop

The server's PWA in a native window (Tauri 2 / WebKitGTK). Flutter has no Linux webview,
so this is not the `app/` shell: it injects **no** `window.shell` and the page behaves as a
browser tab — cookie login, service worker, offline boot. Files work through native dialogs:
exports ask where to save, imports open the GTK file chooser.

## Setup (Arch)

```sh
sudo pacman -S --needed webkit2gtk-4.1 libsoup3 gtk3 librsvg
```

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
