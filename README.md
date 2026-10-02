# ddd

**Dynamic database for documents.** A self-hosted, offline-first notes app where every note is
Markdown with frontmatter, and every note can be queried like a database row.

- **Offline first.** The whole workspace lives in the browser and syncs when it can.
- **Real-time collaboration.** Every note is a CRDT, so several people and devices can edit it at once.
- **Saved searches as views.** Turn any search into a table, kanban board, calendar or timeline.
- **Linked notes.** `[[wikilinks]]`, embeds, backlinks, and a graph of the whole workspace.
- **Everything is a plugin.** The editor, the sidebar, the boards: all 38 parts of the app are
  plugins you can replace or remove, and you can write your own.
- **Your files stay yours.** Export everything as Markdown, mirror your notes into a folder on
  disk, or bring in an Obsidian vault with the example importer plugin.

## Getting started

You need Docker.

```bash
cp .env.example .env
# set SESSION_SECRET in .env, e.g. to the output of: openssl rand -base64 48
docker compose up --build -d
```

Open <http://localhost:8080>. The first account you create is the admin. Everyone after that
needs an invite (Settings → Invites).

### Running it on a server

Browsers only allow the offline app, secure cookies and the Android app on HTTPS. The `caddy`
profile puts Caddy in front of the server with automatic certificates:

```bash
DOMAIN=notes.example.com ACME_EMAIL=you@example.com \
  APP_ORIGIN=https://notes.example.com COOKIE_SECURE=true \
  TRUST_PROXY_HEADERS=true BIND_HOST=127.0.0.1 \
  docker compose --profile caddy up -d --build
```

Keep `BIND_HOST=127.0.0.1` when `TRUST_PROXY_HEADERS=true`: the proxy must be the only way in.

Every setting is listed in [`.env.example`](.env.example) and
[`backend/README.md`](backend/README.md#environment-variables).

### Backups

```bash
mise run backup     # writes backups/<timestamp>/dump.archive.gz
```

Notes, history and attachments all live in MongoDB, so back up the database. Settings →
Workspace can also export every note as Markdown, without history or attachments.

## Apps

ddd works in any modern browser and can be installed from there as an app. There are also:

| App | What it adds | Get it |
| --- | --- | --- |
| [Android](app/README.md) | Boots offline from a verified copy of the app, notifications with the app closed | APK on the [Releases](../../releases) page |
| [Linux desktop](desktop/README.md) | Mirrors your notes to a folder of Markdown files, native file dialogs | `.deb` and AppImage on the Releases page |
| [`ddd` CLI](cli/README.md) | Scaffolds plugins, queries your notes from a terminal | Binary on the Releases page |

## Writing plugins

A plugin is a frontend bundle, and optionally a sandboxed WebAssembly backend, described by a
`manifest.json`. Admins install it from a `.zip` in Settings → Plugins.

```bash
ddd plugin new my-plugin --dep toolbar@^1.1
```

- [`plugins/base/`](plugins/base/README.md): the built-in plugins, and the reference for
  writing your own
- [`plugins/examples/`](plugins/examples/README.md): small example plugins, including one with
  a backend
- [`backend/HOST-ABI.md`](backend/HOST-ABI.md): what a plugin backend can call

## Developing

The toolchain is managed by [mise](https://mise.jdx.dev): Rust, Node, Flutter and the JDK. Run
`mise tasks` to list everything.

```bash
cp .env.example .env    # set SESSION_SECRET
mise run web-build      # build the app and the base plugins
mise run dev            # MongoDB in Docker, the server on :8080
mise run dev-hot        # the same, with live reload
mise run test           # the server's tests
```

| Directory | What's in it |
| --- | --- |
| [`backend/`](backend/README.md) | The server (Rust): API, sync, plugin host. Also the shared core, which compiles to WebAssembly for the browser. |
| [`web/`](web/README.md) | The browser app: offline store, sync client, plugin loader |
| [`plugins/`](plugins/base/README.md) | The built-in plugins and examples |
| [`app/`](app/README.md) | The Android app (Flutter) |
| [`desktop/`](desktop/README.md) | The Linux desktop app (Tauri) |
| [`cli/`](cli/README.md) | The `ddd` command-line tool |
| [`schema/`](schema) | JSON schemas, including the plugin manifest |
| [`brand/`](brand/README.md) | The logo and icons |
| [`deploy/`](deploy) | The Caddy config for the `caddy` profile |
