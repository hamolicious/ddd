# `ddd` — command-line tool for ddd (dynamic database for documents)

Scaffolds plugins, fetches plugin types, and queries a server's documents.

Release binaries are attached to GitHub Releases. To build from source:

```bash
cargo install --path cli        # puts `ddd` on your PATH
```

## Commands

```bash
ddd plugin new reading-list --dep header@^2.0 --tailwind --backend
ddd plugin types --server https://notes.example.com   # run inside a plugin project
ddd login --server https://notes.example.com          # prints a bearer token
ddd query --filter title:text_contains:a --sort fm.date
```

Run `ddd <command> --help` for every option.

| Variable | Used by | Meaning |
|---|---|---|
| `DDD_SERVER` | `plugin new`, `plugin types`, `login`, `query` | The server URL; same as `--server` |
| `DDD_TOKEN` | `query` | The bearer token from `ddd login`; same as `--token` |

`ddd` has no default server and only contacts one when given `--server` or `DDD_SERVER`:

- `ddd plugin new` with a server fills in `types/` and resolves bare `--dep <id>` ranges from
  the plugins that server has installed.
- Without one it scaffolds offline; run `ddd plugin types` later to fetch the types.
- `ddd query --plan` prints the query plan without a server.

## The plugin SDK

`ddd plugin new --backend` makes the backend crate depend on `ddd-plugin-sdk` from git, pinned
to the commit `ddd` was built from. Release builds point at this GitHub repository.

| Option | Where | Effect |
|---|---|---|
| `--sdk-git <url>` | `ddd plugin new` | Use another git URL for this project |
| `--sdk <path>` | `ddd plugin new` | Use a local checkout |
| `DDD_SDK_GIT=<url>` | when building `ddd` | Set the default SDK repository. **Set it when building from source**; otherwise generated crates point at a placeholder URL. |
| `DDD_SDK_REV=<commit>` | when building `ddd` | Set the pinned commit; needed when building without a `.git` directory |

## Building from source

`ddd` embeds files from this repository at compile time: the reference Vite config, the kernel
version from `schema/manifest.schema.json`, and tool versions from `web/package.json`.
Reinstall it after those change.

### Adding a command

Commands are grouped by what they act on.

- New subcommand in an existing group: a module under `src/commands/<group>/` plus a variant
  in that group's enum.
- New group: a module under `src/commands/` plus a variant in `commands::Command`.

Shared modules:

- `scaffold.rs`: writes a set of templated files into a new directory.
- `server.rs`: reads the unauthenticated routes of a running server.
- `repo.rs`: facts about this repository, embedded at compile time.
