# `ddd` — developer tooling for ddd (dynamic database for documents)

```bash
cargo install --path cli        # puts `ddd` on your PATH
ddd plugin new reading-list --dep header@^2.0 --tailwind --backend
ddd plugin types --server https://notes.example.com   # in a plugin project
```

`ddd` knows nothing about where a plugin's server is. The server is whatever `--server` or
`DDD_SERVER` names, and it is only contacted when one is given: `ddd plugin new` then fills
in `types/` and resolves bare `--dep <id>` ranges from what that server has installed.
Without one it scaffolds offline, and `ddd plugin types` fetches the types later.

`ddd` embeds files from this repository at compile time (the reference Vite config, the
kernel version from `schema/manifest.schema.json`, tool versions from `web/package.json`),
so reinstall it after those change.

## Adding a command

Commands are grouped by what they act on. A new subcommand of an existing group is a
module under `src/commands/<group>/` plus a variant in that group's enum; a new group is a
module under `src/commands/` plus a variant in `commands::Command`. Shared pieces:

- `scaffold.rs`: writes a set of templated files into a new directory.
- `server.rs`: reads the unauthenticated routes of a running server.
- `repo.rs`: facts about this repository, embedded at compile time.

## The plugin SDK

`ddd plugin new --backend` makes the backend crate depend on `ddd-plugin-sdk` from
git, pinned to the commit `ddd` was built from. The repository URL is a placeholder until
the repository is public; set `DDD_SDK_GIT=<url>` when building `ddd` to change it (and
`DDD_SDK_REV=<commit>` when building without a `.git`). Authors can override it per project
with `--sdk-git <url>`, or use a local checkout with `--sdk <path>`.
