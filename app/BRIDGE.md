# `window.shell` — the capability bridge, v1

**Status:** frozen for M5 (SPEC §7, §9 M5). Both halves are compiled separately and never
see each other, so this document is the contract; where it and a doc comment disagree, this
file wins and the comment is a bug.

**The two halves:**

| half | where | owner |
|---|---|---|
| the Dart side — handlers, injection, the local server, the updater | `app/lib/**` | shell-bridge, shell-updater |
| the JavaScript side — `kernel.capabilities`, boot, URL resolution | `web/kernel/src/runtime/{capabilities,shell-bridge}.ts`, `web/app/src/**` | web-shim |
| the manifest endpoint | `backend/crates/server/src/routes/shell.rs` | server-bundle |

**Three rules the whole design follows.** They are not style; each one prevents a specific
failure that has to be designed out rather than tested out.

1. **Only JSON crosses the boundary.** A `flutter_inappwebview` handler serializes its
   arguments and its result. Bytes are **base64**; instants are **ISO-8601 strings** (`atIso`)
   or epoch milliseconds; `Uint8Array`, `Date`, `Map` and callbacks cannot appear.
2. **Everything may be a promise.** Every handler is asynchronous on the Dart side. The only
   synchronous members are *values* baked into the page before the bundle runs
   (`bridgeVersion`, `bearerToken`, `serverBaseUrl`, `notifications.permission()`), because
   the boot sequence reads them before it can await anything.
3. **A capability the shell cannot perform is absent, not failing.** The web side degrades to
   its browser implementation on *absence only* — never on a thrown error, because retrying
   in the browser after a native attempt risks doing the thing twice (two save dialogs, two
   notifications). This is why the shim defines only the methods that are registered.

**Plugins never contain Dart** (SPEC §7). A plugin gets native behaviour by calling
`kernel.capabilities`, which calls this bridge. There is no plugin-supplied native code, no
per-plugin bridge surface, and no way for a plugin to add one.

---

## 1. Scope

v1 is SPEC §7: `filesystem` (export/import) and `notifications` (scheduled local —
the ones that fire with the app closed), plus the two things the shell needs for itself,
`auth` and `boot`. `folder` (§4.5, the notes folder) was added later as new methods, which
§8 allows without a version bump; the Linux desktop shell carries it too.

**Not in v1, and plugin authors are told so:** server push, device registration, Web Push,
background sync, camera, contacts, geolocation, biometrics. Those are v2 conversations
(SPEC §10).

---

## 2. The envelope

One `flutter_inappwebview` JavaScript handler, named **`lm_shell_v1`**
(`kBridgeHandlerName`). One handler rather than one per method, so versioning, the error
shape, logging and timeouts are written once.

**Request** (page → shell):

```jsonc
{
  "v": 1,                       // bridge major the page speaks
  "id": "7",                    // monotonic per page load; diagnostics only
  "capability": "filesystem",
  "method": "export",
  "params": { }                 // always an object; `{}` when there are none
}
```

**Response** (shell → page) — the handler's return value:

```jsonc
{ "v": 1, "id": "7", "ok": true,  "result": … }
{ "v": 1, "id": "7", "ok": false, "error": { "code": "denied", "message": "…" } }
```

`id` is **not** used for correlation: `callHandler` already returns a promise tied to the
call. It exists so a log line on one side can be matched to a log line on the other.

**Error codes** — frozen, and the web side treats every one of them as a real failure:

| code | meaning |
|---|---|
| `unsupported` | unknown capability/method, or `v` newer than the shell. Unreachable in a matched pair: the shim only calls what was registered. |
| `denied` | the OS refused — notification permission, storage permission, a 403 from the server. |
| `cancelled` | the user dismissed a picker or share sheet. Not an error to shout about. |
| `invalid` | malformed params: a missing field, an unparseable `atIso`. A bug on the web side. |
| `timeout` | the handler exceeded `ShellBridge.callTimeout` (120 s; a picker waits on a human). The native side may still finish; the page has stopped waiting. |
| `failed` | anything else, with a message. |

**A handler never throws across the bridge.** `ShellBridge.dispatch` converts a
`BridgeException` to its code, a `TimeoutException` to `timeout`, and anything else to
`failed`. A malformed envelope gets a response too — a bad message must not leave a promise
pending forever in the page.

---

## 3. `window.shell`, and the capability-detection rule

The shell injects a small script at **`AT_DOCUMENT_START`** (`ShellBridge.bootstrapScript`),
before the bundle runs. It defines `window.shell` with:

```ts
{
  version: 1,              // canonical; what the kernel's detectBridge() reads
  bridgeVersion: 1,        // the same number, the name this document uses
  capabilities: ["auth", "boot", "filesystem", "notifications"],
  methods: ["auth.getToken", …],   // "capability.method", sorted; diagnostics
  platform: "android",
  serverBaseUrl: "https://life.example.com",
  bearerToken: "…" | null,
  setBearerToken(token | null): Promise<void>,
  bootOk(): Promise<void>,
  bootFailed(reason): Promise<void>,
  auth: { getToken?, setToken?, clearToken? },
  filesystem: { export?, pick?, exportWorkspace?, importFile? },
  folder: { current?, choose?, forget?, list?, read?, write?, move?, remove? },
  notifications: { permission?, request?, notify?, schedule?, cancel?, scheduled?, list? },
  session?: "cookie",      // only a cookie shell sets it; see below
}
```

**Who holds the session.** The Flutter shell serves the page from a loopback origin, so the
session is a bearer token it keeps; the page reads `bearerToken`, skips the service worker
(the bundle updater is the offline cache) and resolves `/api` against `serverBaseUrl`. The
**Linux desktop shell** (`desktop/`) loads the page from the server's own origin instead, and
says so with `session: "cookie"`: the page then behaves exactly like a browser tab — cookie
login, service worker, the workspace-export link — and only uses the native capabilities the
bridge carries (today, `folder`). `web/app/src/boot/shell.ts` `shellOwnsSession()` is the one
test; `inShell()` still answers "is there a native shell at all".

Both `version` and `bridgeVersion` are present and equal: `version` is what the committed
kernel reads (`web/kernel/src/runtime/capabilities.ts`, frozen in M3), `bridgeVersion` is the
name M5 uses. Emitting both costs nothing and avoids editing a frozen surface; the kernel
accepts either.

**The detection rule, in full:**

1. `window.shell` exists and is an object → there may be a bridge. Anything else (missing, a
   string, `null`) → **no bridge**; the browser implementations are used.
2. It claims an integer `version` (or `bridgeVersion`) → otherwise **no bridge**. Full-trust
   plugins can put anything on `window`; a bridge has to say what it is.
3. That version is **not greater** than `SUPPORTED_BRIDGE_VERSION` in the bundle → otherwise
   **no bridge**: a shell newer in major speaks an ABI this bundle does not know, and
   guessing is worse than degrading. (The reverse mismatch — bundle newer than shell — is
   handled at install time, §8.)
4. Per capability: `window.shell.<capability>` is an object → wrap it. Otherwise use the
   browser implementation.
5. **Per method:** the member is a function → call it. Otherwise call the browser
   implementation *for that method only*. A shell that implements `export` but not `pick`
   leaves `pick` working.

`capabilities` is informational — for logging and for an admin screen that wants to show what
this device can do. **It is never the gate**; presence of the method is. Two sources of truth
would eventually disagree, and the one that matters is the one that gets called.

`Object.freeze` on the injected object is a courtesy, not a boundary: frontend plugins run
unsandboxed (SPEC §6.1) and can call `lm_shell_v1` directly. The bridge's job is ergonomics
and graceful degradation, not containment.

---

## 4. The capabilities

### 4.1 `auth` — the bearer token

| method | params | result |
|---|---|---|
| `auth.getToken` | — | `string \| null` |
| `auth.setToken` | `{ token: string }` | `null` |
| `auth.clearToken` | — | `null` |

Stored in the platform keystore (`flutter_secure_storage`), alongside the server URL
(SPEC §5.2: "stored in native secure storage"). Web storage would not do: it is evictable,
and it dies with a bundle swap.

The token is **also baked into the page** as `window.shell.bearerToken`, because
`web/app/src/main.tsx` reads it synchronously during boot, before the kernel exists. The
namespaced `auth.*` methods are for what happens afterwards: a webview that was
re-authenticated natively picks up the new token without a reload, and a page that logged in
itself hands the issued token back (`setBearerToken`, kept as the flat spelling the committed
boot code already uses).

**This is not a weakening of anything.** The page must authenticate to the server, so the
token has to reach JavaScript; plugins are full-trust and already share the session
(SPEC §6.1). The alternative — a local proxy that holds the token and injects it — is worse,
and §6 says why.

`auth` is deliberately **not** exposed through `kernel.capabilities`: a plugin has no business
reading the token from an API that looks like a feature. It is app-boot plumbing.

### 4.2 `filesystem`

| method | params | result |
|---|---|---|
| `filesystem.export` | `{ name, mime, text? \| data? }` (`data` base64) | `null` |
| `filesystem.pick` | `{ accept?: string[], multiple: boolean }` | `[{ name, mime, size, data }]` |
| `filesystem.exportWorkspace` | — | `null` |
| `filesystem.importFile` | `{ accept?: string[] }` | `{ name, mime, size, data } \| null` |

`export`/`pick` are the generic pair the frozen `kernel.capabilities.filesystem` API is
written against. `exportWorkspace`/`importFile` are the named operations M5's UI calls.

**A picked file arrives whole**, base64, because a native picker's file has no `File` object
in the page's realm to read from later. A dismissed picker resolves **empty** (`pick`) or
`null` (`importFile`) — not `cancelled` — so a caller does not have to tell "no files" from
"changed my mind".

**`exportWorkspace` is not `export(bytes)`.** It is `GET /api/admin/export` — a streamed zip
of every document (SPEC §5.1, the no-Mongo recovery path) — fetched natively with the bearer
token and handed to the share sheet. Through JavaScript it would mean holding the whole
archive in the webview's heap. It is **admin-only server-side**: a non-admin gets a 403
(`denied`) however the UI is drawn, so the affordance must be gated on the user's admin flag.

### 4.3 `notifications`

| method | params | result |
|---|---|---|
| `notifications.permission` | — | `"granted" \| "denied" \| "default"` |
| `notifications.request` | — | the same |
| `notifications.notify` | `{ title, body?, tag?, route? }` | `null` |
| `notifications.schedule` | `{ id?, title, body?, tag?, route?, atIso }` | `string` (the id) |
| `notifications.cancel` | `{ id: string }` | `null` |
| `notifications.list` | — | `[{ id, atIso, at, title, … }]` |

Five things here are contract, not implementation:

* **`permission()` is synchronous** on the JavaScript side, because the frozen web API is.
  The shim returns a value baked in at document start and refreshed after `request()`.
* **`atIso` is the canonical instant** — ISO-8601, normalized to UTC. The kernel's
  `schedule(notification, at)` takes epoch ms and the shim converts. `list()` entries carry
  **both** (`atIso` and `at`) so neither side has to. Instants, never wall-clock times: a
  user crossing a timezone must not have their reminders shift.
* **Ids are strings across the bridge and ints inside Android.** The shell derives the
  Android id deterministically from the string (`nativeId`, FNV-1a masked to 31 bits), so
  re-scheduling the same id **replaces** rather than stacks — the same semantics as a browser
  `Notification` with the same `tag`. `id` defaults to `tag` when absent.
* **A registry file is the source of truth for `list()`.** Android's
  `pendingNotificationRequests()` returns ints with no schedule attached, which cannot answer
  "what is pending, and when".
* **Reminders are inexact** (`AndroidScheduleMode.inexactAllowWhileIdle`). Exact alarms need
  `SCHEDULE_EXACT_ALARM` (user-revocable on API 31+) or `USE_EXACT_ALARM` (Play-restricted to
  alarm and calendar apps). Say "around" in the UI rather than asking for a permission the
  app does not deserve.

`scheduled` and `list` are the same handler under two names — `scheduled()` is what the frozen
kernel calls, `list` is what this document names it.

### 4.4 `boot` — the shell's own handlers

| method | params | result |
|---|---|---|
| `boot.ok` | — | `null` |
| `boot.failed` | `{ reason: string }` | `null` |

`bootOk()` is what makes auto-revert work (§7). The web-shim area calls it **once, after the
kernel is up and the first plugin has activated** — not on `DOMContentLoaded`, which a broken
bundle also reaches. `bootFailed(reason)` is optional politeness; the shell's watchdog covers
silence.

### 4.5 `folder` — the notes folder

One directory the user chose on this device. The `local-folder` plugin keeps every note in it
as a Markdown file, both ways, while the app runs.

| method | params | result |
|---|---|---|
| `folder.current` | — | `{ label } \| null` |
| `folder.choose` | — | `{ label }`; `cancelled`, `denied` |
| `folder.forget` | — | `null` (the files stay) |
| `folder.list` | — | `[{ path, kind: "file" \| "dir", size, mtimeMs }]`, recursive |
| `folder.read` | `{ path }` | `{ data, mtimeMs }` (`data` base64) |
| `folder.write` | `{ path, data }` | `{ mtimeMs }` |
| `folder.move` | `{ from, to }` | `null` |
| `folder.remove` | `{ path }` | `null` (a file or an empty directory; missing is fine) |

* **Paths are relative** to the folder and `/`-separated. The shell refuses an absolute path,
  a `..` segment, or one a symlink would carry outside the folder, with `invalid`, before
  touching the disk. Every method but `current`/`choose` answers `unsupported` while no folder
  is chosen.
* **The choice belongs to the device**, not the account: the shell remembers it
  (`<appSupport>/folder.json` on Android, `folder` in `~/.config/life-manager/desktop.toml` on
  Linux). It is never written to synced settings.
* **Writes are atomic**: bytes go to `.life-manager/tmp/` and are renamed into place, so a
  sync client or an editor never reads half a file. `list` skips that directory.
* **Changes are pushed, not polled**: the shell watches the folder and evaluates
  `window.dispatchEvent(new CustomEvent("lm-folder-changed", { detail: { paths } }))`,
  debounced, with the relative paths that changed (`.life-manager/` excluded). `paths` is a
  hint; the page rescans either way. Pinned in `bridge_fixtures/window_shell.json`
  (`folderChanged`).
* **Android uses a real path** and therefore *all-files access* (`MANAGE_EXTERNAL_STORAGE`,
  API 30+; the storage permission below that), which `choose` requests before the picker. A
  Storage Access Framework URI cannot be watched, and a folder other apps can share is the
  point. Play restricts the permission; this shell is sideloaded.
* **The browser has a fallback** in the kernel, not here: the File System Access API in
  Chromium, with no change events.

---

## 5. The server contract: `GET /api/shell/manifest`

Defined in `backend/crates/server/src/routes/shell.rs`. **Authenticated** (bearer token) — it
names every installed plugin and version, which is the information `GET /api/plugins` is
authenticated to protect. The *files* stay public, because `import()` cannot send an
`Authorization` header.

```jsonc
{
  "bundle_version": "b1f3…",          // content hash of everything in `files`
  "min_bridge_version": 1,            // the bundle refuses to run on an older shell
  "index_csp": "default-src 'self'; script-src 'self' 'nonce-…' 'wasm-unsafe-eval'; …",
  "files": [
    { "path": "index.html",                         "sha256": "…", "size": 4711 },
    { "path": "assets/app-1a2b3c.js",               "sha256": "…", "size": 284_113 },
    { "path": "plugins/shell-ui/1.0.0/frontend/index.mjs", "sha256": "…", "size": 9_002 }
  ]
}
```

**`bundle_version` is derived, never stored:** `sha256` over the sorted, newline-delimited
`(path, sha256)` listing. It moves when — and only when — the bytes the shell would download
move. A PWA redeploy, a plugin install and a plugin *removal* all change it; a server restart
does not. Nothing has to remember to bump a number.

**And its shape is enforced, not assumed** (`isBundleVersion`, `bundle/manifest.dart`): 64
lowercase hex characters, nothing else. The id is used verbatim as a directory name under
the bundle root, and that directory is handed to a recursive delete and a rename when an
update installs — so an unchecked value reaches the filesystem with the *server's* word for
it, over the app's own private storage. `../../shared_prefs` deletes the keystore holding
the bearer token; `..` deletes the whole files directory; `state.json` and `.staging`
collide with the store's own names. A server that also serves file bytes matching its own
hashes passes every other check in the updater, so this parse is the only gate. `files[].path`
has had the same treatment since M5 (`isSafeBundlePath`); this closes the other half.

**Plugin files are part of the bundle.** An offline boot with the kernel but without
`shell-ui` renders nothing, so the manifest spans `WEB_DIST_DIR` *and* every served plugin's
`frontend/**`, at the paths the public routes already use.

**Two files are synthesized** and fetched from `GET /api/shell/bundle/{path}`:

| path | why it cannot come from the static route |
|---|---|
| `index.html` | the browser's copy is rendered per response with a fresh CSP nonce and `no-store` (`statics.rs`); bytes that differ every time cannot be hashed into a manifest |
| `importmap.json` | generated from the installed plugin set; served `no-cache` |

`/api/shell/bundle/index.html` renders the document **once per bundle version**, with the
import map inlined and a *stable* nonce, and `index_csp` carries the matching policy for the
shell's local server to send as a header. A baked nonce is safe here and not in the browser:
these bytes are served by the device's own loopback server to its own webview, with no cache
and no intermediary to replay them to.

**Excluded from the bundle:** `sw.js`. The loopback origin already *is* the offline cache, and
a service worker installed there would fight the bundle updater for control of what the
webview sees — two caches, two update stories, one of them invisible to the revert path.

**How the shell fetches** (`bundle/updater.dart`):

1. every `path` not in the synthesized set → `GET {serverBaseUrl}/{path}` (the existing public
   static routes: `/assets/*`, `/runtime/*`, `/plugins/{id}/{version}/frontend/*`);
2. the synthesized two → `GET {serverBaseUrl}/api/shell/bundle/{path}` with the bearer token;
3. each response is streamed to `.staging/<bundle_version>/<path>` and hashed **from the bytes
   written**; size first (it catches the common truncation with a message that says so);
4. one mismatch aborts the whole bundle and deletes the staging directory. Never a partial
   install, never a "mostly verified" swap.

**No request the shell makes natively follows a redirect** (`bearerRequest`,
`bridge/auth.dart`). `dart:io` copies the original request's headers onto a redirect target
with no same-origin check and `package:http` follows by default, so one `301` from the
configured server — an operator moving the deployment, an identity proxy bouncing an
unrecognised request to an SSO host — would hand a 30-day-idle / 180-day-absolute workspace
credential (SPEC §5.2) to whatever host the `Location` names, silently. The server never
legitimately redirects `/api`, so a redirect is a misconfiguration or an attack and both are
better reported than followed: the caller sees a non-200 and the log line names the cause.

**When to poll:** on the launch that reaches `boot.ok`, and on every foreground after that,
throttled to `kUpdateCheckInterval` (15 min). An Android process routinely outlives a
session, so a once-per-process check is not "on the next launch" in any sense a user would
recognise — and `routes/shell.rs`'s fingerprint cache exists precisely because a shell polls
this endpoint often.

**When it is staged**, the shell dispatches `lm-shell-update-ready` into the page (§7), on
top of its own native banner.

---

## 6. Serving the bundle: the loopback origin

The active bundle is served by a `dart:io` `HttpServer` bound to **`127.0.0.1:41847`**
(`kLoopbackPort`), and the webview is pointed at `http://127.0.0.1:41847/index.html`.

**Why not `shouldInterceptRequest` / a custom scheme:**

* `http://127.0.0.1` is a **secure context** by specification. The PWA is a PWA: IndexedDB for
  the whole projection (SPEC §4.1), a Web Worker for the search index (SPEC §4.2),
  `crypto.subtle`, `navigator.storage.persist()`. A custom scheme is not a secure context and
  several of those simply are not there.
* Interception is Android-only and does not fire for every subresource or for service workers
  without extra `ServiceWorkerController` plumbing. The loopback server is one code path.

**The port is fixed, and that is load-bearing.** Every store the app depends on is keyed by
origin — port included. An ephemeral port would hand the user an empty workspace on every
launch and re-bootstrap 5 000 documents (SPEC §9 M2 gate). It is also the origin that must
appear in the server's `APP_ORIGIN` allowlist, which cannot allowlist a moving port.

### Origin implications for auth

1. **Cookies are out; bearer tokens are in.** SPEC §5.2 says so, and the origin split means a
   cookie would not be attached anyway: every API call from the page is cross-origin.
2. **`APP_ORIGIN` must include `http://127.0.0.1:41847`.** Both the CORS allowlist and the
   mandatory WebSocket Origin check (SPEC §4.3) see the loopback origin. Forgetting this
   produces a shell that logs in and then never syncs, which is why the login screen
   pre-flights and says so in words an operator can act on.
3. **The web side must resolve API and socket URLs against `window.shell.serverBaseUrl`.** In
   a browser the API is same-origin; in the shell it is not. Three places resolve URLs against
   the page origin today and are the web-shim area's M5 work:
   `web/app/src/boot/api.ts` (hard-coded `/api`), `SessionHost` (`apiBase` option — already
   supported, just needs passing), and `resolveSyncUrl` / `bootstrap.ts` / `doc-hydration.ts`
   (`location.href`).

### What the local server is not

It serves **static bytes from one directory** and nothing else. It is deliberately **not a
proxy**: a local proxy holding the bearer token would be an authenticated open door to the
workspace for every other app on the device (anything can connect to a loopback port). Serving
public bundle bytes — the same bytes any browser can fetch unauthenticated — exposes nothing.

Required hardening:

* bind `127.0.0.1`, never `0.0.0.0`;
* reject any request whose `Host` is not `127.0.0.1:<port>` (DNS rebinding);
* serve **only paths listed in the active manifest**, not "whatever is on disk" — so the
  bundle's own stored `manifest.json` and any leftover file are unreachable;
* `X-Content-Type-Options: nosniff` on everything; explicit `Content-Type` from the path's
  extension; `index_csp` on `index.html`.

---

## 7. The failed-boot / auto-revert state machine

SPEC §7: "keeps the previous bundle, auto-reverts after two failed boots." The counter is
**native** (`<app support>/bundles/state.json`), because the thing that would report a failed
boot is the thing that failed.

```text
launch
  ↓
promote a staged bundle          (pending → active; skipped if quarantined)
  ↓
failedBoots = 0  → write failedBoots = 1 → load bundle
                     ├─ bootOk()          → failedBoots = 0          ✓
                     └─ watchdog / crash  → (counter already 1)
  ↓
failedBoots = 1  → write failedBoots = 2 → load bundle with ?safe=1
                     ├─ bootOk()          → failedBoots = 0          ✓ (a plugin is broken)
                     └─ watchdog / crash  → (counter already 2)
  ↓
failedBoots ≥ 2  → previous bundle? ──yes──→ revert: active ↔ previous,
                 │                            quarantine the failure, previous = null
                 └──no───→ the native recovery screen
```

Five properties, each one deliberate:

* **The increment is written before the load.** A crash that takes the process with it still
  counts. Nothing may defer that write.
* **Only `bootOk()` clears it.** Rendering is not booting; a bundle that paints a shell and
  then throws has not booted.
* **Attempt two is safe mode** (`?safe=1`, SPEC §6.1: base plugins only). A bundle that boots
  in safe mode has a broken *plugin*, not a broken bundle — reverting would not fix it, and the
  user is better off in a working app with a notice than one version back. So the second
  attempt is the diagnostic, and only its failure reverts.
* **A reverted version is quarantined** and never auto-installed again. Without that the
  updater re-downloads the bundle it just escaped, every launch, forever. **Only when the
  bundle is what failed**: a revert forced by a missing bundle directory, or by a shell too
  old for the bundle's `min_bridge_version`, reverts *without* condemning the version
  (`reverted(quarantine: false)`). Quarantine is permanent — only the user's own "Download
  the app again" clears it — and `BundleUpdater.update` checks it *before* the bridge gate,
  so a bundle condemned for the APK's age would still be refused after the APK is updated,
  pinning the device to an older bundle forever with nothing on screen saying why. The list
  is capped at `kMaxQuarantined` (10), oldest first out.
* **`previous` becomes `null` on revert.** Reverting *to* something that just failed twice is
  not a recovery path.
* **The watchdog** (`kBootWatchdog`, 25 s) turns silence into a decision inside one launch
  instead of making the user kill the app twice. It measures **foreground time**: it is
  suspended when the app leaves the foreground and re-armed from the start when it returns,
  because Android throttles a background WebView's JS and timers while a Dart `Timer` keeps
  running. A launch the user immediately switches away from is not a failed boot. The page's
  own pre-kernel requests are bounded too (`web/app/src/boot/api.ts`), and shorter than this,
  so a stalled server becomes an *offline boot* rather than a failed one.
* **Reaching the login form is a successful boot.** The web side calls `bootOk()` before
  rendering `AuthGate` (`web/app/src/main.tsx`): the bundle ran, and an expired session is
  not a reason to revert it.
* **A staged bundle is announced to the page.** The shell evaluates
  `window.dispatchEvent(new CustomEvent("lm-shell-update-ready", { detail: { bundleVersion } }))`
  (`shellUpdateReadyScript`), which `web/app/src/boot/shell.ts` turns into the kernel notice
  "close and reopen Life Manager to finish it"; `window.lmShellUpdateReady({ bundleVersion })`
  is an accepted alternative spelling. The strings live in
  `bridge_fixtures/window_shell.json` and both sides are tested against them. Purely
  informational — promotion happens at the next launch either way, which is why there is no
  "Reload" action.

`BootGuard.decide` is pure and the whole table lives in `test/shell/boot_guard_test.dart`.

**Updates are never applied to a running webview.** A verified download is `pending` and
promoted at the next launch: the page holds IndexedDB handles, a socket and an activated
plugin graph, and replacing its code underneath it produces a half-old client.

---

## 8. Version mismatch, both directions

| situation | what happens |
|---|---|
| bundle's `min_bridge_version` > shell's `kBridgeVersion`, at update time | the update is **refused** (`UpdateOutcome.needsNewerShell`); nothing is downloaded; the installed bundle keeps running |
| the same, for the **active** bundle (the app was downgraded, or its data restored onto an older shell) | revert if there is a previous bundle; otherwise the native **"Update the app"** screen, naming both versions |
| shell's `version` > the bundle's `SUPPORTED_BRIDGE_VERSION` (an old bundle on a new shell) | the bundle ignores the bridge entirely and uses browser fallbacks (§3 rule 3). It still works; it just does not get native behaviour |

**When to bump `kBridgeVersion`:** only for a **breaking** change to an existing handler — a
renamed field, a changed result shape, a removed method. Adding a capability or a method is
*not* a bump, because detection is per method (§3): an older shell simply does not define the
new one and the page falls back.

**When to bump `min_bridge_version`:** when the *web* code starts *requiring* a bridge method
that older shells do not have — i.e. when the fallback is no longer acceptable. It is written
by the web build into `shell-bundle.json`; the server reads it there.

---

## 9. Frozen surface

Changing any of these breaks a shell or a bundle already in the field. They move only with
the version rules in §8, and every change is announced in `app/CONTRACTS.md`.

* the handler name `lm_shell_v1`, the envelope keys (`v`, `id`, `capability`, `method`,
  `params`, `ok`, `result`, `error.code`, `error.message`) and the six error codes;
* every method name and parameter name in §4, and the `window.shell` member names in §3;
* the manifest JSON field names in §5 (`bundle_version`, `min_bridge_version`, `index_csp`,
  `files[].path`, `files[].sha256`, `files[].size`) and the two routes
  `GET /api/shell/manifest`, `GET /api/shell/bundle/{path}`;
* the loopback port `41847` — it is origin-keyed storage and an `APP_ORIGIN` entry;
* the keystore keys `lm.bearer-token` and `lm.server-base-url` (changing one signs every
  device out);
* the notification channel id `lm.reminders`.
