
## Backend half

`backend/` is the Rust half, built to `dist/backend.wasm` by `npm run build`. It needs the
`wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`). Hooks, cron
schedules, routes and exports are declared under `backend` in `manifest.json`.

The plugin SDK comes from git (`backend/Cargo.toml`), pinned to the commit of the `lm`
that created this project. Change `rev` there to move to a newer SDK.
