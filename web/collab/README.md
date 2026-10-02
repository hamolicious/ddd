# Collaboration suite

People editing the same notes together, online and offline, against a real server.

```bash
docker compose up -d mongo            # the suite needs a Mongo
cargo build --bin ddd                 # in backend/
mise run collab                       # or: cd web && npm run test:collab
```

Each file starts its own server (`app/e2e/server.mjs`) on its own port and a
throwaway database (`ddd_collab_<port>`), so it never touches your
workspace. `DDD_COLLAB_SERVER=http://…` points it at a server you started; the
restart and purge tests then skip.

| File | What it covers |
|---|---|
| `realtime.test.ts` | Everyone online: typing at the same spot, edits crossing on a slow link, both deleting the same words, deleting a paragraph someone is typing in, frontmatter races, four-device bursts, late joiners, REST writes reaching open editors |
| `offline.test.ts` | Offline and online mixed: one or both offline, coming back in either order, hundreds of offline keystrokes, frames lost in flight, a connection that blips every 100 ms, flapping, closing the tab offline, two tabs of one device, a long absence |
| `lifecycle.test.ts` | Notes made offline, a lost create reply, two devices minting the same id, Trash while editing, deleted for good while holding unsent edits, the server restarting mid-edit |
| `chaos.test.ts` | Seeded random runs of all of the above on four devices of two people |

Every test ends with `converged()`: each device, the server's CRDT and the server's
saved text are identical. Tests that write known text also check that each piece
appears exactly once, so nothing is lost or doubled.

## Chaos seeds

```bash
DDD_COLLAB_SEEDS=50 npm run test:collab -- chaos     # more seeds (default 6)
DDD_COLLAB_SEED=17  npm run test:collab -- chaos     # replay one
DDD_COLLAB_STEPS=400 …                                # longer runs (default 160)
```

A failing seed prints its journal. The script replays exactly; only the network
timing differs between runs.

## The browser half

`app/e2e/collab.spec.ts` runs the same kinds of scenario in the real app with two
accounts in two browsers: live typing, both typing on one line, a reload while
offline, a staggered return, a socket that keeps dropping, and a note made offline
that the other person then edits. It is part of `npm run e2e:app`, or run just it
with `npx playwright test --config playwright.app.config.ts collab`.
