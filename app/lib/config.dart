/// Constants and settings all three areas share (bridge, bundle, shell).
///
/// It exists so that `bridge/`, `bundle/` and `shell/` never have to import each other
/// just to agree on a number. Everything here is either frozen by `BRIDGE.md` or an
/// integrator-visible default.
library;

/// The bridge ABI this build of the shell implements (`BRIDGE.md` §2).
///
/// Bumped only when a *breaking* change is made to an existing handler; adding a new
/// capability or method is not a bump, because the web side detects capabilities by
/// presence, not by version (`BRIDGE.md` §3).
const int kBridgeVersion = 1;

/// The `flutter_inappwebview` JavaScript handler name every bridge call goes through
/// (`BRIDGE.md` §2). One handler, one envelope — see `bridge/bridge.dart`.
const String kBridgeHandlerName = 'lm_shell_v1';

/// The loopback port the active bundle is served from (`BRIDGE.md` §6).
///
/// **Fixed on purpose, and it must stay fixed.** The webview's origin is
/// `http://127.0.0.1:<port>`, and every origin-keyed store the PWA depends on — IndexedDB
/// (the whole projection, SPEC §4.1), the local search index, `localStorage` — is keyed
/// by that origin, port included. An ephemeral port would hand the app an empty workspace
/// on every launch and re-bootstrap 5 000 documents over the network (SPEC §9 M2 gate).
/// It is also the origin that has to appear in the server's `APP_ORIGIN` allowlist
/// (SPEC §4.3), which cannot allowlist a port that changes.
const int kLoopbackPort = 41847;

/// The origin of the active bundle, as the webview sees it.
Uri get kLoopbackOrigin => Uri.parse('http://127.0.0.1:$kLoopbackPort');

/// How long a bundle gets to call `shell.bootOk()` before the boot counts as failed
/// (`BRIDGE.md` §7). Generous: a cold start on mid-range Android loads the Wasm core, the
/// projection store and every plugin (SPEC §8 budget is 2 s interactive, and this is the
/// timeout for "did not boot at all", not for "was slow").
const Duration kBootWatchdog = Duration(seconds: 25);

/// Failed boots of one bundle version before the shell reverts to the previous one
/// (SPEC §7: "auto-reverts after two failed boots").
const int kMaxFailedBoots = 2;

/// The shortest gap between two manifest polls.
///
/// The shell checks for a bundle update when a launch reaches `boot.ok` **and on every
/// foreground after that** — `routes/shell.rs`'s fingerprint cache and
/// [kManifestTimeout]'s own doc are both written around that assumption, and an Android
/// process routinely survives for days, so a once-per-launch check means a user who never
/// cold-starts the app never learns a new bundle exists (`docs/OPERATIONS.md`: "devices
/// pick up a new bundle on their next launch").
///
/// Throttled because `AppLifecycleState.resumed` fires far more often than a user would
/// call it "opening the app": every dismissed permission dialog, every notification
/// shade, every app switch back. One poll per quarter of an hour is well inside what the
/// server's cache is built for and invisible on a mobile connection.
const Duration kUpdateCheckInterval = Duration(minutes: 15);

/// Where the shell talks to, and how it is reached. Persisted by `bridge/auth.dart`
/// alongside the bearer token, because a self-hosted app cannot hard-code its server.
class ShellConfig {
  const ShellConfig({
    required this.serverBaseUrl,
    this.loopbackPort = kLoopbackPort,
  });

  /// Origin only, no path: `https://lm.example.com`. `/api/…` is appended by callers.
  final Uri serverBaseUrl;

  /// Overridable in tests; production is always [kLoopbackPort].
  final int loopbackPort;

  Uri api(String path) => serverBaseUrl.resolve('/api$path');

  Uri get loopbackOrigin => Uri.parse('http://127.0.0.1:$loopbackPort');
}
