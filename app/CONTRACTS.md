# M5 build contracts — the Flutter shell

Four builder areas fill in this scaffold in parallel. The tree already builds: every class
exists, every signature is final, `flutter analyze` is clean, `flutter test` is green (44
tests), and the bodies that are not implemented throw `UnimplementedError` with the name of
the area that owns them.

**Scope: SPEC §9 M5 only** — Android webview, verified bundle updater with rollback, bearer
auth, the filesystem and scheduled-local-notification bridge. **No new kernel API, no new
plugin, no iOS/desktop work, no server features beyond the manifest endpoint.**

[`BRIDGE.md`](BRIDGE.md) is authoritative for everything that crosses a boundary: the
envelope, `window.shell`, the manifest, the loopback origin, the revert state machine. Where
a doc comment and `BRIDGE.md` disagree, `BRIDGE.md` wins and the comment is a bug — report it.
Where `BRIDGE.md` and `SPEC.md` disagree, SPEC wins.

**The three rules**

1. **Never edit a file owned by another area.** If you need a change there, say so in your
   report — do not make it.
2. **Never change a frozen signature** (`BRIDGE.md` §9, plus every type listed under
   [Frozen types](#frozen-types) below). Adding an *optional* field to a params object is the
   one exception, and it still gets announced.
3. **Never edit `pubspec.yaml`, `pubspec.lock` or the Gradle files, and never add a
   dependency.** Everything M5 needs is declared (see [Dependencies](#dependencies)). If
   something is genuinely missing, report it instead of adding it.

Supporting rules:

- `mise run shell-test` must stay green — that is the gate (`dart format --set-exit-if-changed`
  + `flutter analyze` + `flutter test`). `mise run check` and `mise run web-check` are the
  gates for the other two halves.
- **Plugins never contain Dart** (SPEC §7). Nothing in this tree grows a plugin-supplied
  native surface.
- **Every capability degrades in a plain browser** (SPEC §7). A change that makes a bundle
  require the shell is a change to `min_bridge_version`, announced.
- No timestamp arithmetic for scheduling: instants only, UTC, `atIso` on the wire.

---

## Layout and ownership

```text
app/
├── BRIDGE.md                       the contract                          [scaffold] FROZEN
├── CONTRACTS.md                    this file                             [scaffold]
├── pubspec.yaml / pubspec.lock     pinned; do not edit                   [scaffold] FROZEN
├── android/
│   ├── app/build.gradle.kts        minSdk 24, desugaring                 [scaffold]
│   └── app/src/main/
│       ├── AndroidManifest.xml     INTERNET, notifications, cleartext    [scaffold]
│       └── res/xml/network_security_config.xml                           [scaffold]
├── lib/
│   ├── main.dart                   the boot sequence                     [shell-updater]
│   ├── config.dart                 shared constants + ShellConfig        [scaffold] FROZEN
│   ├── bridge/
│   │   ├── bridge.dart             envelope, registry, injected shim     [shell-bridge] FROZEN
│   │   ├── auth.dart               keystore: token + server URL          [shell-bridge]
│   │   ├── filesystem.dart         export / pick / exportWorkspace       [shell-bridge]
│   │   ├── folder.dart             the notes folder (BRIDGE.md §4.5)     [shell-bridge]
│   │   └── notifications.dart      scheduled local notifications         [shell-bridge]
│   ├── bundle/
│   │   ├── manifest.dart           manifest types + sha256 verify        [scaffold] FROZEN
│   │   ├── store.dart              versioned dirs + atomic pointer       [shell-updater]
│   │   └── updater.dart            the OTA algorithm                     [shell-updater]
│   └── shell/
│       ├── webview_host.dart       loopback server + InAppWebView        [shell-bridge]
│       ├── boot_guard.dart         failed-boot counter + revert          [shell-updater]
│       └── login_screen.dart       native login → bearer token           [shell-bridge]
└── test/{bridge,bundle,shell}/     the policy tables                     [all areas]
```

Elsewhere in the repo:

```text
backend/crates/server/src/routes/shell.rs   the manifest endpoint         [server-bundle]
web/kernel/src/runtime/shell-bridge.ts      the window.shell declaration  [web-shim] FROZEN
web/kernel/src/runtime/capabilities.ts      the capability wrappers       [web-shim]
web/app/src/{main.tsx,boot/api.ts}          boot: token + serverBaseUrl   [web-shim]
web/app/src/boot/kernel-init.ts             apiBase / socket base         [web-shim]
```

`lib/config.dart` is a scaffold addition not in the M5 brief: three constants
(`kBridgeVersion`, `kLoopbackPort`, `kMaxFailedBoots`) and `ShellConfig` are needed by
`bridge/`, `bundle/` and `shell/` alike, and putting them in any one of those would make the
other two import across areas.

---

## Area: shell-bridge

**Owns:** `lib/bridge/**`, `lib/shell/webview_host.dart`, `lib/shell/login_screen.dart`.

**Must not touch:** `lib/bundle/**`, `lib/shell/boot_guard.dart`, `lib/config.dart`.

Hard requirements (`BRIDGE.md` §2–§4, §6):

- **One handler, one envelope.** `ShellBridge.dispatch` is the only entry point, and it
  **never throws**: every failure is an `ok: false` envelope with a frozen code.
- **Register only what works.** A method that cannot be performed on this device is not
  registered — the web side degrades on absence, and an error would make it try twice.
- **`bootstrapScript` is injected at `AT_DOCUMENT_START`**, before the bundle runs, and
  defines only registered methods. `bearerToken`, `serverBaseUrl` and the notification
  permission are baked in as values because boot reads them synchronously.
- **Only the loopback origin may be a document.** `shouldOverrideUrlLoading` cancels anything
  else and hands it to the browser; a note's link must never replace the app with a page on the
  token-bearing origin.
- **The webview's storage is the app's data directory**, not evictable web storage (SPEC §7).
- **`adjustResize` + hybrid composition**, because the M5 acceptance criterion is CodeMirror
  editing with the Android soft keyboard (SPEC §9 M5).
- **Login is native and comes first** (`BRIDGE.md` §4.1): the manifest endpoint is
  authenticated, so there is no bundle to show a form in on first run. Store the server URL
  only on success; pre-flight `/healthz` and say so plainly when the URL is not a ddd
  server.
- Notifications: inexact scheduling, one channel (`ddd.reminders`), a registry file as the
  answer to `list()`, deterministic string→int ids. Re-scheduling an id replaces it.

**Frozen:** `ShellBridge` (constructor, `register`, `dispatch`, `methods`, `capabilities`,
`bootstrapScript` and the JavaScript it emits), `BridgeRequest`, `BridgeResponse`,
`BridgeErrorCode`, `BridgeException`, the keystore keys in `auth.dart`, and every params/result
shape in `BRIDGE.md` §4.

---

## Area: shell-updater

**Owns:** `lib/bundle/store.dart`, `lib/bundle/updater.dart`, `lib/shell/boot_guard.dart`,
`lib/main.dart`.

**Must not touch:** `lib/bridge/**`, `lib/bundle/manifest.dart`.

Hard requirements (SPEC §7; `BRIDGE.md` §5, §7):

- **Verify before swapping.** Every file is hashed from the bytes written; one mismatch aborts
  the bundle and deletes the staging directory. A partial or unverified bundle is never
  promoted.
- **The failed-boot counter is written before the webview loads**, and only `boot.ok` clears
  it. This is the whole auto-revert guarantee — nothing may defer that write.
- **Attempt two is `?safe=1`**, and only its failure reverts (`BRIDGE.md` §7).
- **A reverted version is quarantined** and never auto-installed again — **but only when the
  bundle is what failed.** A revert forced by a missing bundle directory or by a shell too old
  for the bundle's `min_bridge_version` passes `reverted(quarantine: false)`: quarantine is
  permanent, it is checked *before* the bridge gate, and condemning a bundle that never ran
  pins the device to an older one forever.
- **`bundle_version` is validated before it is used as a path.** 64 lowercase hex characters
  (`isBundleVersion`); it becomes a directory name that a recursive delete and a rename are
  applied to, so an unchecked one lets the server reach outside the bundle root.
- **No native request follows a redirect while carrying the bearer token** (`bearerRequest`).
  `dart:io` copies `Authorization` onto a redirect target regardless of host.
- **Updates are staged, never hot-swapped.** Promotion happens at the next launch, with
  nothing running.
- **`state.json` moves by `rename`**, never by in-place edit, and `install()` renames the
  outgoing directory aside rather than deleting it: the version being replaced may be the
  revert target.
- **`update()` never throws.** Both callers depend on it — a silent background check and a
  first-run screen whose only exit would otherwise be force-stopping the app. A device that
  cannot store the update is `UpdateOutcome.storageFailed`, which is *this device's* problem
  and is worded as such.
- **Nothing in the boot path requires the network** except the first run. An unreachable
  manifest is `UpdateOutcome.unavailable` and changes nothing.
- **The boot watchdog measures foreground time**, and the page's own pre-kernel requests are
  bounded more tightly than it. "The bundle never ran" and "the bundle is waiting on the
  network, or nobody is looking" are the distinction the whole guarantee rests on.
- **Every failure lands on a native screen.** A blank webview is indistinguishable from a
  broken app, and the recovery path has to be reachable when the bundle is what is broken.
- The bundle directory also stores its own manifest, so `min_bridge_version` and `index_csp`
  are known offline. It is not servable (`BRIDGE.md` §6).

**Frozen:** `BundleState` and its transitions (`attemptingBoot`, `bootSucceeded`, `staged`,
`promoted`, `reverted`), `BootAction`, `BootPlan`, `BootGuard.decide`,
`BootGuard.promotePending`, `UpdateOutcome`.

---

## Area: server-bundle

**Owns:** `backend/crates/server/src/routes/shell.rs`, and the `min_bridge_version` half of
the web build (`shell-bundle.json` in `WEB_DIST_DIR`).

**Must not touch:** `routes/statics.rs` (ask — `index.html` rendering is shared),
`routes/mod.rs` beyond the `/api/shell` nest that is already there.

Hard requirements (`BRIDGE.md` §5):

- **`bundle_version` is derived** from the sorted `(path, sha256)` listing and nothing else —
  no timestamps, no server identity. Same bytes ⇒ same version, on any replica.
- **Authenticated**, like `GET /api/plugins`: the manifest names the installed plugin set.
- **Hash by streaming.** A bundle is tens of megabytes; this endpoint must not buffer it.
  Cache the result keyed on the newest mtime across the roots — a shell polls on every
  foreground.
- **`index.html` and `importmap.json` are rendered once per bundle version**, with a stable
  nonce, and their bytes must hash to what the manifest published. `index_csp` is the header
  the shell sends with `index.html`; its nonce must match the inline import map.
- **`sw.js` is excluded**, and so is anything outside `WEB_DIST_DIR` plus served plugins'
  `frontend/**`.
- `cargo fmt`, `cargo clippy -- -D warnings` and `cargo test` stay clean (`mise run check`).
  Do not add a dependency: `sha2` and `hex` are already declared.

**Frozen:** `ShellManifest`, `ShellFile`, the two route paths, and the field names in
`BRIDGE.md` §5.

---

## Area: web-shim

**Owns:** `web/kernel/src/runtime/shell-bridge.ts`, `web/kernel/src/runtime/capabilities.ts`,
and the shell-facing parts of `web/app/src/{main.tsx,boot/api.ts,boot/kernel-init.ts}`.

**Must not touch:** `web/kernel-api/src/capabilities.ts` (the plugin-facing types are frozen
from M3 — a new *optional* member is the only permitted change, and it is announced),
`web/kernel/src/sync/protocol.ts`.

Hard requirements (SPEC §7; `BRIDGE.md` §3, §6):

- **Capability detection is presence-based, per method.** `window.shell.capabilities` is
  informational; never gate on it.
- **Degrade on absence only, never after an error.** This rule is already implemented and
  tested (`capabilities.test.ts`) — keep it.
- **Resolve API and socket URLs against `window.shell.serverBaseUrl`** when it is present, and
  against the page origin when it is not. The three sites are
  `web/app/src/boot/api.ts` (hard-coded `/api`), `SessionHost` (`apiBase`, already an option)
  and `resolveSyncUrl`/`bootstrap.ts`/`doc-hydration.ts` (`location.href`). **This is the one
  M5 change without which the shell logs in and then cannot sync.**
- **Call `shell.bootOk()` once**, after the kernel is up and plugins have activated — not on
  `DOMContentLoaded`, which a broken bundle also reaches. That call is what stops the shell
  from reverting a working bundle.
- **Write `shell-bundle.json`** (`{ "minBridgeVersion": 1 }`) into the app dist, and bump it
  only when the web code *requires* a bridge method rather than preferring one.
- A plain browser tab must be unaffected by every one of these changes. `npm run typecheck`
  and `npm run test` stay green (`mise run web-check`).

**Frozen:** `ShellBridgeV1` and the member names in it, `BRIDGE_VERSION`, `readShellBridge`,
`bridgeVersionOf`, `detectBridge`'s contract (both version spellings accepted; a newer major
degrades).

**Announced after M5 (kernel 2.2.0):** `CapabilitiesApi.folder` and `CapabilityName` `"folder"`
(the notes folder, `BRIDGE.md` §4.5), and the `ShellBridgeV1` members `folder` and
`session`. A bridge with `session: "cookie"` (the Linux desktop shell) is a shell that does not
own the session: `shellOwnsSession()` in `web/app/src/boot/shell.ts`, not `inShell()`, gates
bearer login, the service worker, `navigator.storage.persist()` and the workspace-export link.

---

## Frozen types

Dart (`lib/config.dart`, `lib/bridge/bridge.dart`, `lib/bundle/manifest.dart`,
`lib/bundle/store.dart`, `lib/shell/boot_guard.dart`):

```dart
const int kBridgeVersion = 1;
const String kBridgeHandlerName = 'ddd_shell_v1';
const int kLoopbackPort = 41847;
const int kMaxFailedBoots = 2;
const Duration kBootWatchdog = Duration(seconds: 25);
class ShellConfig { Uri serverBaseUrl; int loopbackPort; Uri api(String path); }

enum BridgeErrorCode { unsupported, denied, cancelled, invalid, timeout, failed }
class BridgeRequest  { int version; String id, capability, method; Map<String,Object?> params; }
class BridgeResponse { Map<String,Object?> toJson(); }
class ShellBridge {
  void register(String capability, String method, BridgeHandler handler);
  Future<Map<String,Object?>> dispatch(Object? raw);          // never throws
  List<String> get methods; List<String> get capabilities;
  String bootstrapScript({required Uri serverBaseUrl, required String? bearerToken,
                          required String notificationPermission});
}

class BundleFile     { String path, sha256; int size; }
class BundleManifest { String bundleVersion, indexCsp; int minBridgeVersion;
                       List<BundleFile> files; bool runsOnBridge(int); }
String? verifyBytes(BundleFile file, List<int> bytes);          // null == matches
bool isSafeBundlePath(String path);

class BundleState { String? active, previous, pending; int failedBoots; List<String> quarantined;
                    BundleState attemptingBoot(), bootSucceeded(), staged(String),
                                promoted(String), reverted(); }
enum BootAction { firstRun, loadBundle, loadBundleSafeMode, revert, recovery, needsNewerShell }
class BootPlan { BootAction action; BundleState state; String? version, reason; }
BootPlan BootGuard.decide({required BundleState state, BundleManifest? activeManifest,
                           int bridgeVersion, int maxFailedBoots});
```

Rust (`routes/shell.rs`): `ShellManifest { bundle_version, min_bridge_version, index_csp,
files: Vec<ShellFile> }`, `ShellFile { path, sha256, size }`.

TypeScript (`web/kernel/src/runtime/shell-bridge.ts`): `ShellBridgeV1` and its member types.

---

## Dependencies

Pinned in `pubspec.yaml`, resolved against Flutter 3.47.5 / Dart 3.13.4:

| package | version | why |
|---|---|---|
| `flutter_inappwebview` | ^6.1.5 | the webview and the JS handler (SPEC §7) |
| `flutter_secure_storage` | ^11.2.0 | the bearer token and server URL (SPEC §5.2) |
| `flutter_local_notifications` | ^22.3.1 | scheduled local notifications (SPEC §7) |
| `timezone` | ^0.11.1 | **required by** `zonedSchedule`; not in the M5 brief but not optional |
| `path_provider` | ^2.1.6 | the bundle directory (app support, not documents) |
| `http` | ^1.6.0 | login, the manifest, file downloads |
| `crypto` | ^3.0.7 | SHA-256 verification |
| `archive` | ^4.3.0 | reserved: the export zip, and a future single-archive bundle download |
| `share_plus` | ^13.3.0 | handing a file to the user |
| `file_picker` | ^13.1.0 | taking a file from the user, and the notes folder |
| `permission_handler` | ^12.0.1 | all-files access for the notes folder (`folder.dart`) |
| `watcher` | ^1.1.2 | recursive change events for the notes folder on Linux/Android |

`archive` is declared and currently unused: the workspace export is a zip the shell may want to
inspect or unpack, and a future manifest revision may ship the bundle as one archive. If it is
still unused when M5 closes, drop it rather than leaving it.

---

## Environment and integrator notes

These are facts about this machine and this scaffold, not decisions to re-litigate silently.

1. ~~**No Android SDK is installed.**~~ **Done — the APK builds.** `cmdline-tools` +
   `platforms;android-36` + `build-tools;36.0.0` are installed at `~/Android/Sdk`, licences
   accepted, `android/local.properties` written; the NDK and CMake came down with the first
   build. `mise run shell-apk` is the gate, and `app/README.md` § "Building the APK" is the
   procedure. Two toolchain fixes were needed and both are documented where they live — the
   JDK pin (note 2) and `android.r8.proguardAndroidTxt.disallowed` in `android/gradle.properties`
   (AGP 9 dropped `getDefaultProguardFile('proguard-android.txt')`; `flutter_inappwebview_android`
   1.1.3, the newest stable, still calls it).
2. **The JDK is pinned to 21, not the system's.** The prediction in this note was right and the
   symptom is worth recording, because it names neither Java nor the JDK: with Java 26, AGP's
   `JdkImageTransform` feeds `jlink` a rebuilt `java.base` and jlink refuses it — *"cannot find
   the build signature in the java.base specified on module path"* — failing inside a
   *dependency's* `compileDebugJavaWithJavac`. `java = "temurin-21"` now sits in the root
   `mise.toml` with that reasoning; AGP 9.1.0 / Gradle 9.3.1 were left where the template put
   them.
3. **`applicationId` is still `com.example.app`** — deliberately. It is a one-way door (device
   and Play identity), Play rejects `com.example.*` loudly, and an invented reverse-domain
   nobody owns is a quiet wrong answer. Pick it before the first release build; it also means
   renaming `namespace` and moving `MainActivity.kt`.
4. **Release signing is the debug key.** Same reasoning: a real keystore is an integrator
   artefact.
5. **`10.0.2.2` is cleartext-permitted for emulator development.** Remove that entry if you
   want the platform, rather than the operator, to guarantee that the bearer token never
   crosses plain HTTP.
6. **`APP_ORIGIN` must list `http://127.0.0.1:41847`** on every server a shell talks to
   (`BRIDGE.md` §6). This is the most likely cause of "signed in, never syncs".
7. **The package is `ddd_shell`** (it was the template's `app`). Dart imports are
   `package:ddd_shell/…`.
8. **`app/mise.toml` is gone**; the Flutter tool definition moved to the root `mise.toml`, so
   `mise run shell-test` works from anywhere in the tree.

---

## Acceptance (SPEC §9 M5)

The milestone is done when all four hold on a real device:

1. **CodeMirror editing with the Android soft keyboard** — type, select, move the caret, and
   see the line you are editing.
2. **Offline boot** — aeroplane mode, cold start, the workspace opens from the local bundle and
   the local projection.
3. **OTA update** — deploy a changed bundle, relaunch, the new `bundle_version` is running.
4. **Revert** — ship a bundle that throws before `bootOk()`, relaunch twice, and land back on
   the previous bundle with the broken one quarantined.

**Status: all four are unverified — none has run on a device.** The integration machine has no
`/dev/kvm` (no module, no device node), so the emulator leg was skipped rather than faked. The
code is complete, the APK builds, and the manifest half is verified end to end against a live
server; what is missing is a phone. [`TESTPLAN.md`](TESTPLAN.md) is the script — these four
plus the two SPEC §7 capability items (a scheduled notification firing with the app closed, and
export/import), written to be run in one sitting.
