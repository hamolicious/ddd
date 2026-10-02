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

enum _Phase { starting, login, firstRun, running, blocked }

class BootFlow extends StatefulWidget {
  const BootFlow({super.key});

  @override
  State<BootFlow> createState() => _BootFlowState();
}

class _BootFlowState extends State<BootFlow> with WidgetsBindingObserver {
  final AuthStore _auth = AuthStore();
  ShellBridge _bridge = ShellBridge(log: _log);

  final NotificationsCapability _notifications = NotificationsCapability();

  final FolderCapability _folder = FolderCapability();

  late final LoginService _login = LoginService(auth: _auth);

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

  bool _bootOk = false;

  bool _watchdogSuspended = false;

  DateTime? _lastUpdateCheck;
  bool _checkingForUpdate = false;

  String? _noticedStaged;

  Uri? _bridgeServer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_start());
  }

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

  Future<void> _start() async {
    _watchdog?.cancel();
    _watchdog = null;
    _watchdogSuspended = false;
    _noticedStaged = null;
    _lastUpdateCheck = null;
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

  Future<void> _serve(BootPlan plan) async {
    final BundleStore store = _store!;
    final String version = plan.version!;
    final BundleManifest? manifest = await store.readManifest(version);
    if (manifest == null) {
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
      _log('boot: the loopback server did not start: $error');
      _block(
        'ddd could not start',
        'The app could not serve its own files on port $kLoopbackPort. If ddd '
            'was just closed, wait a moment and try again.\n\n$error',
      );
      return;
    }
    _server = server;

    _armWatchdog();

    final Uri index = server.indexUrl;
    _to(
      _Phase.running,
      pageUrl: plan.action == BootAction.loadBundleSafeMode
          ? index.replace(queryParameters: <String, String>{'safe': '1'})
          : index,
    );

    final String? reason = plan.reason;
    if (plan.action == BootAction.loadBundleSafeMode) {
      _notify(
        'ddd did not finish starting last time, so it is running with plugins '
        'switched off. If it works now, a plugin is the problem.',
      );
    } else if (reason != null) {
      _notify('ddd went back to an earlier version: $reason.');
    }
  }

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

  Future<void> _onBootOk() async {
    if (_bootOk) return;
    _bootOk = true;
    _watchdog?.cancel();
    _watchdog = null;
    _watchdogSuspended = false;
    await _guard?.bootSucceeded();

    final BundleStore? store = _store;
    if (store != null) {
      await store.prune(await store.readState());
    }
    unawaited(_checkForUpdate());
  }

  Future<void> _onBootFailed(String reason) async {
    if (_bootOk) {
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

  Future<void> _checkForUpdate() async {
    final BundleUpdater? updater = _updater;
    final BundleStore? store = _store;
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
        _log(
          'boot: the published bundle failed verification; keeping this one',
        );
      case UpdateOutcome.storageFailed:
        _log('boot: the update could not be stored; keeping this bundle');
      case UpdateOutcome.quarantined:
        _log('boot: the published bundle is quarantined on this device');
      case UpdateOutcome.upToDate:
      case UpdateOutcome.unavailable:
        break;
    }
  }

  Future<void> _signOut() async {
    await _auth.clearToken();
    await _start();
  }

  void _register(ShellConfig config) {
    if (_bridgeServer == config.serverBaseUrl) return;
    if (_bridgeServer != null) _bridge = ShellBridge(log: _log);
    _bridgeServer = config.serverBaseUrl;
    _auth.registerOn(_bridge);
    _filesystem?.close();
    _filesystem = FilesystemCapability(config: config, auth: _auth)
      ..registerOn(_bridge);
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
        notifications: _notifications,
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

class NoticeOverlay extends StatelessWidget {
  const NoticeOverlay({
    required this.child,
    required this.onDismiss,
    this.notice,
    this.onRestart,
    super.key,
  });

  final String? notice;

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

void _log(String message) => debugPrint('ddd shell: $message');
