/// The shell's entry point: the boot sequence of SPEC §9 M5, in order, with every step
/// visible.
///
/// ```text
/// keystore (token + server URL)
///   ├─ no token ──────────────→ native login  (SPEC §5.2)
///   └─ token
///        ↓
///      promote a staged bundle          (bundle/store.dart)
///        ↓
///      BootGuard.resolve                (shell/boot_guard.dart)
///        ├─ firstRun         → download the first bundle, with progress
///        ├─ loadBundle       → loopback server + webview            ← the normal path
///        ├─ loadBundleSafeMode → the same, with ?safe=1   (attempt 2)
///        ├─ revert           → swap to the previous bundle, then re-decide
///        ├─ recovery         → native screen: retry, re-download, sign out
///        └─ needsNewerShell  → native screen: "update the app"      (SPEC §7)
///        ↓
///      webview up → shell.bootOk() clears the failed-boot counter
///        ↓
///      prune, then check for an update in the background; stage it for the next launch
/// ```
///
/// Four properties of this sequence are load-bearing.
///
/// 1. **The failed-boot counter is incremented before the webview loads**, and only the
///    page's own `bootOk()` clears it. That is the entire auto-revert guarantee (SPEC §7),
///    and it only works if nothing here defers the write. [BootGuard.resolve] persists the
///    incremented pointer before it returns, and this file starts nothing until it has.
/// 2. **An update is never applied to a running webview.** It is verified, staged, and
///    promoted at the next launch (`bundle/updater.dart`). The running page is offered a
///    restart; it is never swapped underneath.
/// 3. **Nothing in this sequence requires the network except the first run.** A shell with a
///    bundle and a token boots offline, which is half of M5's acceptance: the update check
///    happens *after* the webview is up, and its failure is silent.
/// 4. **Every failure lands on a native screen, never a blank webview.** A white rectangle
///    is indistinguishable from a broken app, and the recovery path has to be reachable when
///    the bundle is the thing that is broken.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'bridge/auth.dart';
import 'bridge/bridge.dart';
import 'bridge/filesystem.dart';
import 'bridge/folder.dart';
import 'bridge/notifications.dart';
import 'bundle/manifest.dart';
import 'bundle/store.dart';
import 'bundle/updater.dart';
import 'config.dart';
import 'shell/boot_guard.dart';
import 'shell/login_screen.dart';
import 'shell/webview_host.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ShellApp());
}

/// The root widget. Owns nothing but the theme and the boot future.
class ShellApp extends StatelessWidget {
  const ShellApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'ddd',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF3B6EA5)),
    ),
    darkTheme: ThemeData(
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(0xFF3B6EA5),
        brightness: Brightness.dark,
      ),
    ),
    home: const BootFlow(),
  );
}

/// Which screen the shell is on. Not the same thing as [BootAction]: `revert` never reaches
/// a screen (it resolves to the bundle it reverted *to*), and `login` is not a boot decision
/// at all — it is what happens when there is no token to decide anything with.
enum _Phase { starting, login, firstRun, running, blocked }

/// The sequence in the library docs, as a widget.
class BootFlow extends StatefulWidget {
  const BootFlow({super.key});

  @override
  State<BootFlow> createState() => _BootFlowState();
}

class _BootFlowState extends State<BootFlow> with WidgetsBindingObserver {
  final AuthStore _auth = AuthStore();
  ShellBridge _bridge = ShellBridge(log: _log);

  /// Held rather than registered and dropped, for two reasons that both show up as the web
  /// app quietly losing a capability it was promised (`BRIDGE.md` §4.3).
  ///
  /// The bootstrap script bakes `notifications.permission()`'s answer into the page as a
  /// constant — it is synchronous on the web side — so [WebViewHost] has to be handed the
  /// *same* instance whose [NotificationsCapability.initialize] asked the OS. A discarded
  /// instance leaves every launch reporting `default`, and a page that sees `default`
  /// forever is a page that re-prompts forever.
  ///
  /// It also survives a re-login onto a different server: reminders are local to the device,
  /// so the OS permission and the registry of scheduled notifications are not the old
  /// server's to lose. Only the handlers get rebuilt, onto the new bridge.
  final NotificationsCapability _notifications = NotificationsCapability();

  /// The notes folder. One instance for the life of the app, like [_notifications]: the
  /// folder and its watcher belong to the device, not to a server or a login.
  final FolderCapability _folder = FolderCapability();

  /// One HTTP client for the whole login phase. [build] runs on every keystroke in the
  /// server-URL field, and a [LoginService] constructed there would open — and never close —
  /// a client per rebuild.
  late final LoginService _login = LoginService(auth: _auth);

  /// The filesystem handlers currently on [_bridge], kept so the client they hold is closed
  /// when they are replaced or the flow is disposed.
  FilesystemCapability? _filesystem;

  BundleStore? _store;
  BootGuard? _guard;
  BundleUpdater? _updater;
  BundleServer? _server;
  ShellConfig? _config;
  Timer? _watchdog;

  _Phase _phase = _Phase.starting;
  Uri? _pageUrl;
  String? _blockedTitle;
  String? _blockedDetail;
  bool _offerRedownload = false;
  String? _notice;
  bool _noticeOffersRestart = false;

  /// `boot.ok` arrived for the webview that is currently mounted. Guards the watchdog, the
  /// prune and the background update check against running twice, and stops a late error
  /// inside a bundle that *did* boot from being counted as a failed boot.
  bool _bootOk = false;

  /// The watchdog was cancelled because the app left the foreground before the bundle
  /// reported, and must be re-armed — from the start — when it comes back.
  ///
  /// Android throttles a background WebView's JavaScript and timers while a Dart `Timer`
  /// keeps counting, so a user who launches the app and immediately switches away would
  /// otherwise come back to a bundle the shell had already declared broken. Twice, and a
  /// working bundle is quarantined and the device pinned to an older one.
  bool _watchdogSuspended = false;

  /// When the manifest was last polled, for [kUpdateCheckInterval].
  DateTime? _lastUpdateCheck;
  bool _checkingForUpdate = false;

  /// The staged version the running page has already been told about, so a foreground
  /// poll that re-reports the same staged bundle does not bring the banner back after the
  /// user dismissed it.
  String? _noticedStaged;

  /// The server the handlers currently on [_bridge] were built for, or `null` before the
  /// first registration.
  ///
  /// [ShellBridge.register] rejects a duplicate key and [_start] runs again on every login,
  /// restart and retry, so registration has to happen at most once per bridge. But the
  /// handlers *capture* the [ShellConfig] they were handed — `filesystem.exportWorkspace`
  /// fetches `GET /api/admin/export` from it (`BRIDGE.md` §4.2) — so signing out and back
  /// in against a **different** server must not leave them pointed at the old one with the
  /// new one's bearer token. A changed URL gets a fresh bridge instead of a stale capture.
  Uri? _bridgeServer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_start());
  }

  /// Two things happen at a foreground/background edge, and both of them are about the
  /// difference between "the bundle is broken" and "nobody was looking".
  ///
  /// * **Backgrounding suspends the boot watchdog** and resuming re-arms it with a full
  ///   duration. See [_watchdogSuspended].
  /// * **Foregrounding polls the manifest** (throttled by [kUpdateCheckInterval]), which
  ///   is the cadence SPEC §7's OTA half is designed around. A once-per-process check is
  ///   not "on the next launch" on Android, where the process outlives the session.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    super.didChangeAppLifecycleState(state);
    switch (state) {
      case AppLifecycleState.resumed:
        if (_watchdogSuspended) {
          _watchdogSuspended = false;
          _armWatchdog();
        }
        unawaited(_checkForUpdate());
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        final Timer? watchdog = _watchdog;
        if (watchdog != null) {
          watchdog.cancel();
          _watchdog = null;
          _watchdogSuspended = true;
        }
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _watchdog?.cancel();
    unawaited(_server?.stop());
    _updater?.close();
    _filesystem?.close();
    unawaited(_folder.close());
    _login.close();
    super.dispose();
  }

  // ───────────────────────────────── the sequence ─────────────────────────────────

  /// One launch. Also one *re*-launch: "restart to apply an update", "try again" after a
  /// failed boot, and the hand-off from the login screen all come back through here, because
  /// promoting a staged bundle and re-deciding is exactly what a launch does.
  Future<void> _start() async {
    _watchdog?.cancel();
    _watchdog = null;
    _watchdogSuspended = false;
    _noticedStaged = null;
    _lastUpdateCheck = null;
    // A launch promotes whatever was staged, so the signal from the last session is about
    // a bundle that is either running now or gone.
    stagedBundleVersion.value = null;
    await _server?.stop();
    _server = null;
    if (!mounted) return;
    setState(() {
      _phase = _Phase.starting;
      _bootOk = false;
      _notice = null;
      _pageUrl = null;
    });

    try {
      final BundleStore store = _store ??= await BundleStore.open();
      final Uri? server = await _auth.serverBaseUrl();
      final String? token = await _auth.token();

      // Not an error, and not a decision the boot guard can make: the manifest endpoint is
      // authenticated (`BRIDGE.md` §4.1), so with no token there is nothing to download a
      // bundle with and nothing to show it in.
      if (server == null || token == null) {
        _to(_Phase.login);
        return;
      }

      final ShellConfig config = ShellConfig(serverBaseUrl: server);
      _config = config;
      _guard ??= BootGuard(store, log: _log);
      _updater?.close();
      _updater = BundleUpdater(
        config: config,
        store: store,
        auth: _auth,
        log: _log,
      );
      _register(config);

      final BootPlan plan = await _guard!.resolve();
      switch (plan.action) {
        case BootAction.firstRun:
          _to(_Phase.firstRun);
        case BootAction.loadBundle:
        case BootAction.loadBundleSafeMode:
          await _serve(plan);
        case BootAction.needsNewerShell:
          _block(
            'Update the app',
            'The workspace this device syncs with needs a newer version of the ddd '
                'app than the one installed. Install the update and start it '
                'again.\n\n${plan.reason ?? ''}',
          );
        case BootAction.recovery:
          _block(
            'ddd could not start',
            '${plan.reason ?? 'The last two starts did not finish.'}\n\n'
                'Downloading the workspace app again is the usual fix. Your documents are '
                'not affected — they live on the server and in this app\'s own storage.',
            offerRedownload: true,
          );
        case BootAction.revert:
          // [BootGuard.resolve] follows a revert through to the bundle it lands on, so this
          // is unreachable. If it is ever reached, say so rather than showing nothing.
          _block(
            'ddd could not start',
            'The shell reverted to an earlier version of the workspace app but could not '
                'start it. ${plan.reason ?? ''}',
            offerRedownload: true,
          );
      }
    } catch (error, stack) {
      _log('boot: $error\n$stack');
      _block('ddd could not start', '$error', offerRedownload: true);
    }
  }

  /// Start the loopback server on the planned bundle and mount the webview.
  ///
  /// The counter for this attempt is already persisted ([BootGuard.resolve]); from here on a
  /// crash, an ANR or a bundle that never calls `bootOk()` all land on the same next launch.
  Future<void> _serve(BootPlan plan) async {
    final BundleStore store = _store!;
    final String version = plan.version!;
    final BundleManifest? manifest = await store.readManifest(version);
    if (manifest == null) {
      // `resolve()` checks this too and escalates it into the revert path; reaching it here
      // means the file went away in between.
      _block(
        'ddd could not start',
        'The installed workspace app ($version) has no manifest, so its files cannot be '
            'served safely.',
        offerRedownload: true,
      );
      return;
    }

    final BundleServer server = BundleServer(
      directory: store.dirFor(version),
      manifest: manifest,
    );
    try {
      await server.start();
    } catch (error) {
      // A port in use is the likely cause, and it is not something to paper over with a
      // different port: the origin is origin-keyed storage (`BRIDGE.md` §6).
      _log('boot: the loopback server did not start: $error');
      _block(
        'ddd could not start',
        'The app could not serve its own files on port $kLoopbackPort. If ddd '
            'was just closed, wait a moment and try again.\n\n$error',
      );
      return;
    }
    _server = server;

    // Silence is a decision the shell has to make inside one launch, or the user has to
    // kill the app twice to get to the revert (`BRIDGE.md` §7).
    _armWatchdog();

    final Uri index = server.indexUrl;
    _to(
      _Phase.running,
      pageUrl: plan.action == BootAction.loadBundleSafeMode
          // SPEC §6.1: base plugins only. A bundle that boots this way has a broken
          // plugin, not a broken bundle.
          ? index.replace(queryParameters: <String, String>{'safe': '1'})
          : index,
    );

    // The revert is silent from inside the webview by construction: the page that would
    // have reported the failure is the one that did not start, and the bundle now running
    // is an *older* one that has no idea it was reinstated. So the shell says it.
    //
    // A plain first attempt carries no reason ([BootGuard.resolve] sets one only when a
    // launch had to recover from something), so this strip appears exactly when something
    // happened that the user would otherwise discover as "my app is older now".
    final String? reason = plan.reason;
    if (plan.action == BootAction.loadBundleSafeMode) {
      // SPEC §6.1 safe mode, in words rather than in jargon: what the user needs to know
      // is why their plugins are gone and that it is temporary, not which flag did it.
      _notify(
        'ddd did not finish starting last time, so it is running with plugins '
        'switched off. If it works now, a plugin is the problem.',
      );
    } else if (reason != null) {
      _notify('ddd went back to an earlier version: $reason.');
    }
  }

  /// Start (or restart) the countdown that turns silence into a failed boot.
  ///
  /// It measures *foreground* time only ([didChangeAppLifecycleState]): a webview whose
  /// timers Android has throttled is not a webview that failed, and the auto-revert
  /// guarantee is worth nothing if it fires on a bundle that was merely not being looked
  /// at. Re-armed from the start rather than resumed, because a page that was frozen
  /// part-way through boot needs the whole budget, not the remainder.
  void _armWatchdog() {
    if (_bootOk) return;
    _watchdog?.cancel();
    _watchdog = Timer(kBootWatchdog, () {
      unawaited(
        _onBootFailed(
          'the workspace app did not finish starting within '
          '${kBootWatchdog.inSeconds} seconds in the foreground',
        ),
      );
    });
  }

  /// `boot.ok` — from the bridge handler, and from [WebViewHost] if it reports it too.
  /// Idempotent, because both paths are legitimate and neither knows about the other.
  Future<void> _onBootOk() async {
    if (_bootOk) return;
    _bootOk = true;
    _watchdog?.cancel();
    _watchdog = null;
    _watchdogSuspended = false;
    await _guard?.bootSucceeded();

    final BundleStore? store = _store;
    if (store != null) {
      // Only now: a bundle you might still have to revert to is worth more than the disk it
      // occupies. Pruning also clears `.staging`, which is why it runs *before* the update
      // check rather than beside it (`store.dart`).
      await store.prune(await store.readState());
    }
    unawaited(_checkForUpdate());
  }

  /// The watchdog expired, or the page reported `boot.failed`.
  Future<void> _onBootFailed(String reason) async {
    if (_bootOk) {
      // The bundle booted and then something inside it broke. That is the page's problem to
      // report; reverting a bundle that reached `bootOk()` would be a worse app, not a
      // better one (`boot_guard.dart`).
      _log('boot: reported after a successful boot, ignoring — $reason');
      return;
    }
    _watchdog?.cancel();
    _watchdog = null;
    _watchdogSuspended = false;
    await _guard?.bootFailed(reason);
    await _server?.stop();
    _server = null;
    _block(
      'ddd could not start',
      '$reason\n\nStarting again will try the workspace app in safe mode, and then the '
          'version before it.',
      offerRedownload: true,
    );
  }

  /// The background check (SPEC §7's OTA half). Runs after the webview is up, so it never
  /// delays a boot, and its failure is silent — being offline is the normal case, not an
  /// error to report.
  ///
  /// Called once per successful boot *and* on every foreground after that
  /// ([didChangeAppLifecycleState]); [kUpdateCheckInterval] is what keeps "every
  /// foreground" from meaning "every notification shade".
  Future<void> _checkForUpdate() async {
    final BundleUpdater? updater = _updater;
    final BundleStore? store = _store;
    // Before `boot.ok` the bundle has not proved it runs, and `prune` has not cleared
    // `.staging` yet — starting a download here would race the thing that deletes it.
    if (updater == null || store == null || !_bootOk) return;
    if (_checkingForUpdate) return;
    final DateTime now = DateTime.now();
    final DateTime? last = _lastUpdateCheck;
    if (last != null && now.difference(last) < kUpdateCheckInterval) return;
    _lastUpdateCheck = now;
    _checkingForUpdate = true;
    final UpdateOutcome outcome;
    try {
      outcome = await updater.update();
    } finally {
      _checkingForUpdate = false;
    }
    if (!mounted) return;
    switch (outcome) {
      case UpdateOutcome.staged:
        final String? pending = (await store.readState()).pending;
        if (!mounted) return;
        // The page's own notice (`web/app/src/boot/shell.ts`): the kernel says "close and
        // reopen ddd to finish it" in the app's own language, and a plugin that
        // feature-detects the event can offer its own affordance. The native banner below
        // stays, because a bundle that is mid-boot or broken has no notice centre.
        stagedBundleVersion.value = pending;
        if (_noticedStaged == pending) return;
        _noticedStaged = pending;
        _notify(
          'An update is ready. Restart to apply it.',
          offersRestart: true,
        );
        _log('boot: $pending staged; offering a restart');
      case UpdateOutcome.needsNewerShell:
        _notify(
          'The workspace has a newer app version than this one. Update ddd '
          'to get it.',
        );
      case UpdateOutcome.corrupt:
        // Loud in the log, quiet on screen: the running bundle is untouched, and there is
        // nothing the user can do about a server whose bytes do not match its hashes.
        _log(
          'boot: the published bundle failed verification; keeping this one',
        );
      case UpdateOutcome.storageFailed:
        // Same reasoning, different cause: the running bundle is untouched and the next
        // check retries for free (the verified bytes are already on disk).
        _log('boot: the update could not be stored; keeping this bundle');
      case UpdateOutcome.quarantined:
        // Not silent any more. A quarantine is permanent until the user clears it from
        // the recovery screen, so a device that keeps refusing the version the server
        // publishes would otherwise sit on an old bundle forever with nothing said.
        _log('boot: the published bundle is quarantined on this device');
      case UpdateOutcome.upToDate:
      case UpdateOutcome.unavailable:
        break;
    }
  }

  /// Sign-out from a native screen: the token goes, the server URL stays (the login screen
  /// comes back pre-filled), and the bundle stays — it is public code, not user data, and
  /// the next user of this device still needs something to log in *with*.
  Future<void> _signOut() async {
    await _auth.clearToken();
    await _start();
  }

  // ───────────────────────────────── the bridge ─────────────────────────────────

  /// Registered before any webview exists, so [ShellBridge.methods] is complete when the
  /// bootstrap script is generated (`BRIDGE.md` §3: the page defines only what exists).
  ///
  /// `boot.ok` and `boot.failed` are registered here rather than in `bridge/`: they are the
  /// shell's own handlers, not a capability, and they are what the auto-revert guarantee
  /// rests on.
  void _register(ShellConfig config) {
    if (_bridgeServer == config.serverBaseUrl) return;
    // A second server means a second set of handlers, and `register` refuses to overwrite
    // a key. The old bridge is unreachable by then: `_start` has already torn the webview
    // down through `_Phase.starting`, and [WebViewHost] reads `widget.bridge` on every
    // dispatch rather than holding its own copy.
    if (_bridgeServer != null) _bridge = ShellBridge(log: _log);
    _bridgeServer = config.serverBaseUrl;
    _auth.registerOn(_bridge);
    _filesystem?.close();
    _filesystem = FilesystemCapability(config: config, auth: _auth)
      ..registerOn(_bridge);
    // Re-registered onto the new bridge, but the same instance: see the field.
    _notifications.registerOn(_bridge);
    _folder.registerOn(_bridge);
    _bridge.register('boot', 'ok', (Map<String, Object?> _) async {
      await _onBootOk();
      return null;
    });
    _bridge.register('boot', 'failed', (Map<String, Object?> params) async {
      final Object? reason = params['reason'];
      await _onBootFailed(
        reason is String && reason.isNotEmpty
            ? reason
            : 'the workspace app reported a failure without a reason',
      );
      return null;
    });
  }

  // ───────────────────────────────── the screens ─────────────────────────────────

  void _to(_Phase phase, {Uri? pageUrl}) {
    if (!mounted) return;
    setState(() {
      _phase = phase;
      _pageUrl = pageUrl;
      _blockedTitle = null;
      _blockedDetail = null;
      _offerRedownload = false;
    });
  }

  /// Put one line above the running page. Never a dialog: what is underneath it is a
  /// working app, and neither an update nor a revert is worth interrupting someone
  /// mid-sentence for. Cleared by [_start], so a notice never outlives its launch.
  void _notify(String message, {bool offersRestart = false}) {
    if (!mounted) return;
    setState(() {
      _notice = message;
      _noticeOffersRestart = offersRestart;
    });
  }

  void _block(String title, String detail, {bool offerRedownload = false}) {
    if (!mounted) return;
    setState(() {
      _phase = _Phase.blocked;
      _blockedTitle = title;
      _blockedDetail = detail;
      _offerRedownload = offerRedownload;
      _pageUrl = null;
    });
  }

  /// Forget the installed bundle and download it again. The last resort on the recovery
  /// screen: the pointer is cleared, so the next launch is a first run.
  ///
  /// Quarantines are cleared with it — they exist to stop an *automatic* loop, and the user
  /// asking for this bundle again is not a loop.
  Future<void> _redownload() async {
    final BundleStore? store = _store;
    if (store == null) return;
    await _server?.stop();
    _server = null;
    await store.writeState(BundleState.empty);
    await store.prune(BundleState.empty);
    await _start();
  }

  @override
  Widget build(BuildContext context) => switch (_phase) {
    _Phase.starting => const _ShellMessage(title: 'Starting…', busy: true),
    _Phase.login => LoginScreen(
      service: _login,
      initialServer: _config?.serverBaseUrl,
      onSignedIn: (Uri server, String _) => unawaited(_start()),
    ),
    _Phase.firstRun => _FirstRunScreen(
      updater: _updater!,
      onInstalled: () => unawaited(_start()),
      onSignOut: () => unawaited(_signOut()),
    ),
    _Phase.running => NoticeOverlay(
      notice: _notice,
      onRestart: _noticeOffersRestart ? () => unawaited(_start()) : null,
      onDismiss: () => setState(() => _notice = null),
      child: WebViewHost(
        url: _pageUrl!,
        bridge: _bridge,
        // The instance the bootstrap script reads `permission()` from, and the one whose
        // `initialize()` the host awaits before generating it.
        notifications: _notifications,
        // Both are already in hand from `_start`; passing them saves a keystore round trip
        // per launch and removes a second source of truth for the server URL.
        auth: _auth,
        serverBaseUrl: _config?.serverBaseUrl,
        onBootOk: () => unawaited(_onBootOk()),
        onBootFailed: (String reason) => unawaited(_onBootFailed(reason)),
      ),
    ),
    _Phase.blocked => _ShellMessage(
      title: _blockedTitle ?? 'ddd could not start',
      detail: _blockedDetail,
      actions: <Widget>[
        FilledButton(
          onPressed: () => unawaited(_start()),
          child: const Text('Try again'),
        ),
        if (_offerRedownload)
          OutlinedButton(
            onPressed: () => unawaited(_redownload()),
            child: const Text('Download the app again'),
          ),
        TextButton(
          onPressed: () => unawaited(_signOut()),
          child: const Text('Sign out'),
        ),
      ],
    ),
  };
}

/// The "update ready, restart to apply" strip (SPEC §7), and the page underneath it.
///
/// A banner rather than a dialog: the page below it is a working app, and interrupting
/// someone mid-sentence to tell them about an update they cannot see is worse than waiting
/// for their next launch.
///
/// **The shape of this subtree never changes** — always a `Scaffold`, always the same two
/// slots, the page always the second — and that is not tidiness, it is the difference
/// between a banner and a reload. Flutter matches children by position and runtime type, so
/// returning the page bare when there is no notice and a `Scaffold` when there is would
/// deactivate the [WebViewHost] element the instant a notice appeared: the `InAppWebView`
/// is destroyed, a fresh one inflated, and the bundle reloads from `index.html`. The notice
/// most likely to appear is "an update is ready", minutes into a session, while someone is
/// typing — so the cost would be their caret, their scroll position and any uncommitted
/// CodeMirror state, and then again when they tap "Later".
///
/// It is a widget of its own rather than a method so that property is testable without a
/// webview: `test/shell/notice_overlay_test.dart` asserts the child's `State` survives.
class NoticeOverlay extends StatelessWidget {
  const NoticeOverlay({
    required this.child,
    required this.onDismiss,
    this.notice,
    this.onRestart,
    super.key,
  });

  /// The line above the page, or `null` for none.
  final String? notice;

  /// Offered as "Restart" when the notice is about a staged bundle.
  final VoidCallback? onRestart;

  final VoidCallback onDismiss;

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final String? notice = this.notice;
    final VoidCallback? onRestart = this.onRestart;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: <Widget>[
            if (notice == null)
              const SizedBox.shrink()
            else
              MaterialBanner(
                content: Text(notice),
                actions: <Widget>[
                  if (onRestart != null)
                    TextButton(
                      onPressed: onRestart,
                      child: const Text('Restart'),
                    ),
                  TextButton(onPressed: onDismiss, child: const Text('Later')),
                ],
              ),
            Expanded(child: child),
          ],
        ),
      ),
    );
  }
}

/// The blocking first download (SPEC §7: a device with no bundle has nothing to show until
/// it has one). Progress is per file and per byte, because a first install is the whole PWA
/// plus every plugin and a bare spinner for that long reads as a hang.
class _FirstRunScreen extends StatefulWidget {
  const _FirstRunScreen({
    required this.updater,
    required this.onInstalled,
    required this.onSignOut,
  });

  final BundleUpdater updater;
  final VoidCallback onInstalled;
  final VoidCallback onSignOut;

  @override
  State<_FirstRunScreen> createState() => _FirstRunScreenState();
}

class _FirstRunScreenState extends State<_FirstRunScreen> {
  UpdateProgress? _progress;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_download());
  }

  Future<void> _download() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    // [BundleUpdater.update] promises never to throw, and this screen is the one place
    // where believing that without a net is unrecoverable: there is no bundle behind it,
    // every button is gated on `_error != null`, and an exception escaping here leaves
    // `_busy` true forever — a progress bar with no "Try again" and no "Sign out", whose
    // only exit is force-stopping the app into the identical state.
    final UpdateOutcome outcome;
    try {
      outcome = await widget.updater.update(
        onProgress: (UpdateProgress progress) {
          if (mounted) setState(() => _progress = progress);
        },
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error =
            'The workspace app could not be installed on this device: $error';
      });
      return;
    }
    if (!mounted) return;
    setState(() => _busy = false);
    switch (outcome) {
      case UpdateOutcome.staged:
      case UpdateOutcome.upToDate:
        // A first run stages; the launch that follows promotes it. `upToDate` here means
        // the pointer already named this version, which a re-entered first run can produce.
        widget.onInstalled();
      case UpdateOutcome.unavailable:
        setState(
          () => _error =
              'The server could not be reached, so there is nothing to start yet. The '
              'first download is the one step that needs a connection.',
        );
      case UpdateOutcome.needsNewerShell:
        setState(
          () => _error =
              'This workspace needs a newer version of the ddd app. Install the '
              'update and start it again.',
        );
      case UpdateOutcome.corrupt:
        setState(
          () => _error =
              'The downloaded files did not match the checksums the server published, so '
              'none of them were installed.',
        );
      case UpdateOutcome.quarantined:
        setState(
          () => _error =
              'The version the server publishes is the one that failed to start on this '
              'device. Trying again will not change that; the server needs a new build.',
        );
      case UpdateOutcome.storageFailed:
        setState(
          () => _error =
              'The workspace app could not be saved on this device. The usual cause is '
              'full storage — free some space and try again.',
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final UpdateProgress? progress = _progress;
    return _ShellMessage(
      title: _error == null ? 'Downloading the workspace app' : 'Not installed',
      detail:
          _error ??
          (progress == null
              ? 'Asking the server what to download…'
              : '${progress.filesDone} of ${progress.filesTotal} files · '
                    '${_mb(progress.bytesDone)} of ${_mb(progress.bytesTotal)} MB'),
      progress: _error == null ? progress?.fraction : null,
      busy: _busy && progress == null,
      actions: _error == null
          ? const <Widget>[]
          : <Widget>[
              FilledButton(
                onPressed: _busy ? null : () => unawaited(_download()),
                child: const Text('Try again'),
              ),
              TextButton(
                onPressed: widget.onSignOut,
                child: const Text('Sign out'),
              ),
            ],
    );
  }

  static String _mb(int bytes) => (bytes / (1024 * 1024)).toStringAsFixed(1);
}

/// Every native screen the shell shows: starting, downloading, recovering, "update the app",
/// and the hard failure. One widget, because they differ only in words and in which buttons
/// are on them.
class _ShellMessage extends StatelessWidget {
  const _ShellMessage({
    required this.title,
    this.detail,
    this.progress,
    this.busy = false,
    this.actions = const <Widget>[],
  });

  final String title;
  final String? detail;

  /// 0…1 for the first-run download; `null` for an indeterminate or absent bar.
  final double? progress;
  final bool busy;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                title,
                style: Theme.of(context).textTheme.titleLarge,
                textAlign: TextAlign.center,
              ),
              if (detail != null) ...<Widget>[
                const SizedBox(height: 12),
                Text(detail!, textAlign: TextAlign.center),
              ],
              if (progress != null) ...<Widget>[
                const SizedBox(height: 24),
                LinearProgressIndicator(value: progress),
              ] else if (busy) ...<Widget>[
                const SizedBox(height: 24),
                const CircularProgressIndicator(),
              ],
              if (actions.isNotEmpty) ...<Widget>[
                const SizedBox(height: 24),
                Wrap(
                  alignment: WrapAlignment.center,
                  spacing: 12,
                  runSpacing: 8,
                  children: actions,
                ),
              ],
            ],
          ),
        ),
      ),
    ),
  );
}

/// `adb logcat` is the only window into a launch that never reaches the webview, so the
/// whole boot flow logs through one function.
void _log(String message) => debugPrint('ddd shell: $message');
