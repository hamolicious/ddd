# `lm` — Life Manager developer tooling

```bash
cargo install --path cli        # puts `lm` on your PATH
lm plugin new reading-list --dep header@^2.0 --tailwind --backend
lm plugin types --server https://notes.example.com   # in a plugin project
```

`lm` knows nothing about where a plugin's server is. The server is whatever `--server` or
`LM_SERVER` names, and it is only contacted when one is given: `lm plugin new` then fills
in `types/` and resolves bare `--dep <id>` ranges from what that server has installed.
Without one it scaffolds offline, and `lm plugin types` fetches the types later.

`lm` embeds files from this repository at compile time (the reference Vite config, the
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

`lm plugin new --backend` makes the backend crate depend on `life-manager-plugin-sdk` from
git, pinned to the commit `lm` was built from. The repository URL is a placeholder until
the repository is public; set `LM_SDK_GIT=<url>` when building `lm` to change it (and
`LM_SDK_REV=<commit>` when building without a `.git`). Authors can override it per project
with `--sdk-git <url>`, or use a local checkout with `--sdk <path>`.
