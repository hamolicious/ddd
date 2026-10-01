/// Serving the active bundle into the webview, and hosting it.
///
/// # The mechanism, and why
///
/// Two ways exist to get a downloaded bundle in front of `flutter_inappwebview`:
///
/// 1. **`shouldInterceptRequest`** (Android only) — answer requests for a custom scheme,
///    or for `https://appassets.androidplatform.net/`, from Dart.
/// 2. **A loopback HTTP server** — a `dart:io` `HttpServer` bound to `127.0.0.1` on a
///    fixed port, pointed at the active bundle directory.
///
/// **This shell uses the loopback server**, at `http://127.0.0.1:41847` ([kLoopbackPort]).
/// The reasons, in the order they mattered:
///
/// * **It is a real, stable web origin.** The PWA is a *PWA*: IndexedDB for the whole
///   projection (SPEC §4.1), a Web Worker for the search index (SPEC §4.2), `crypto.subtle`,
///   `navigator.storage.persist()`. `http://127.0.0.1` is a secure context by
///   specification, so all of it works with no special cases — and `localhost` is the only
///   non-TLS origin browsers treat that way. A custom scheme is not a secure context, and
///   several of those APIs simply are not there.
/// * **Origin-keyed storage survives.** The port is fixed ([kLoopbackPort]) precisely
///   because every one of those stores is keyed by origin. An ephemeral port would re-key
///   the workspace on every launch and re-bootstrap 5 000 documents (SPEC §9 M2 gate).
/// * **Interception is one code path fewer.** `shouldInterceptRequest` does not fire for
///   service workers or for some subresource loads without extra `ServiceWorkerController`
///   plumbing, and it is Android-only — the rest of this shell is portable.
///
/// # Origin implications for auth (SPEC §5.2)
///
/// The page's origin is the loopback server; the API lives on the *server's* origin. Two
/// consequences, both deliberate:
///
/// * **Cookies are out, bearer tokens are in** — exactly what SPEC §5.2 says, and now for a
///   second reason: every API call is cross-origin, so no cookie would be attached anyway.
///   The token is injected into the page by `bridge/bridge.dart`.
/// * **`APP_ORIGIN` must include `http://127.0.0.1:41847`.** The server's CORS allowlist and
///   the WebSocket upgrade's mandatory Origin check (SPEC §4.3) both see the loopback
///   origin. An operator who forgets this gets a shell that logs in natively and then cannot
///   sync — so the login screen checks it (`login_screen.dart`) and says so.
/// * **The web side must resolve API and socket URLs against `window.shell.serverBaseUrl`**,
///   not against `location.origin`. That is the web-shim area's M5 work; it is listed in
///   `CONTRACTS.md` with the three places that resolve URLs today.
///
/// # What the local server does and does not do
///
/// It serves **static bytes from one directory**, and nothing else. It is deliberately not a
/// proxy: a local proxy holding the bearer token would be an authenticated open door to the
/// workspace for every other app on the device (anything can connect to a loopback port).
/// Serving public bundle bytes — the same bytes any browser can fetch from the server
/// unauthenticated — exposes nothing.
///
/// Hardening that is still required:
///
/// * bind to `127.0.0.1`, never `0.0.0.0`;
/// * reject any request whose `Host` header is not `127.0.0.1:<port>` (DNS rebinding);
/// * serve only paths listed in the active manifest — not "whatever is on disk" — so a
///   leftover file in a bundle directory can never be fetched, dotfiles included (the
///   bundle's own `manifest.json` lives there);
/// * `X-Content-Type-Options: nosniff` on everything, and the manifest's `index_csp` on
///   `index.html` (its nonce matches the inline import map in those bytes — `BRIDGE.md` §5).
///
/// **No SPA fallback, deliberately.** The server's own `statics::fallback` answers unknown
/// paths with `index.html` because a browser can be deep-linked; the loopback server must
/// not, because the allowlist is the hardening. It costs nothing: the `router` plugin routes
/// on `location.hash` (`plugins/base/router`), so every in-app URL is `/index.html#/…` and
/// the path the server sees never changes.
library;

import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import '../bridge/auth.dart';
import '../bridge/bridge.dart';
import '../bridge/folder.dart';
import '../bridge/notifications.dart';
import '../bundle/manifest.dart';
import '../bundle/updater.dart';
import '../config.dart';

/// The loopback static server.
///
/// Constructed by the boot flow with the active bundle's directory and manifest; `start()`
/// must complete before the webview is pointed at [indexUrl].
class BundleServer {
  BundleServer({
    required this.directory,
    required this.manifest,
    this.port = kLoopbackPort,
  }) : _servable = <String, BundleFile>{
         for (final BundleFile file in manifest.files) file.path: file,
       };

  /// The active bundle's directory (`bundle/store.dart`).
  final Directory directory;

  /// The active bundle's manifest: the allowlist of servable paths, and `index_csp`.
  final BundleManifest manifest;

  final int port;

  /// The allowlist, by path. Built once: it is consulted on every request, and a bundle is
  /// hundreds of files.
  final Map<String, BundleFile> _servable;

  HttpServer? _server;

  Uri get origin => Uri.parse('http://127.0.0.1:$port');

  /// The URL the webview is pointed at. `?safe=1` is appended by the caller for the second
  /// boot attempt (`boot_guard.dart`).
  Uri get indexUrl => origin.resolve('/${BundleManifest.indexPath}');

  bool get isRunning => _server != null;

  /// The `Host` values this server answers to. Exact, with the port: a request for any other
  /// host is a DNS-rebinding attempt (a page on the internet resolving a name it controls to
  /// 127.0.0.1) and gets nothing.
  Set<String> get allowedHosts => <String>{'127.0.0.1:$port'};

  /// Binds to `127.0.0.1:[port]`.
  ///
  /// A port already in use is a real failure, not something to paper over with a different
  /// port: the origin is load-bearing (see the library docs). The most likely cause is a
  /// previous instance of this app that has not exited yet, so retry briefly, then fail
  /// loudly to the recovery screen.
  Future<void> start() async {
    if (_server != null) return;
    SocketException? last;
    for (int attempt = 0; attempt < 5; attempt++) {
      try {
        // `InternetAddress.loopbackIPv4`, never `anyIPv4`: every other app on the device
        // can reach a loopback port, and nothing off the device may reach this one.
        final HttpServer server = await HttpServer.bind(
          InternetAddress.loopbackIPv4,
          port,
        );
        // The bundle is already gzip-compressed where it matters and this is a loopback
        // socket; compressing again costs CPU on the boot path and buys nothing.
        server.autoCompress = false;
        _server = server;
        server.listen(
          _serve,
          onError: (Object error) =>
              debugPrint('bundle server: connection failed: $error'),
          cancelOnError: false,
        );
        return;
      } on SocketException catch (error) {
        last = error;
        await Future<void>.delayed(Duration(milliseconds: 150 * (attempt + 1)));
      }
    }
    throw StateError(
      'the bundle server could not bind 127.0.0.1:$port — the port is fixed because '
      'every store the app has is keyed to that origin, so it cannot be moved. '
      'Another copy of ddd is probably still shutting down. ($last)',
    );
  }

  Future<void> stop() async {
    await _server?.close(force: true);
    _server = null;
  }

  Future<void> _serve(HttpRequest request) async {
    final HttpResponse response = request.response;
    try {
      if (request.method != 'GET' && request.method != 'HEAD') {
        await _empty(response, HttpStatus.methodNotAllowed);
        return;
      }
      // DNS rebinding: a page anywhere on the internet can point a name it controls at
      // 127.0.0.1 and have the browser send `Host: evil.example`. Exact match, port
      // included, and nothing else is answered.
      final String? host = request.headers.value(HttpHeaders.hostHeader);
      if (host == null || !allowedHosts.contains(host.toLowerCase())) {
        await _empty(response, HttpStatus.misdirectedRequest);
        return;
      }

      final String path = requestedPath(request.uri);
      final BundleFile? file = _servable[path];
      if (file == null) {
        await _empty(response, HttpStatus.notFound);
        return;
      }

      final File onDisk = File('${directory.path}/$path');
      final int length;
      try {
        length = onDisk.lengthSync();
      } on FileSystemException {
        // The pointer and the disk disagreeing is a broken bundle, not a missing page: the
        // boot watchdog turns it into a failed boot and the revert path handles it.
        debugPrint('bundle server: $path is in the manifest but not on disk');
        await _empty(response, HttpStatus.notFound);
        return;
      }
      if (length != file.size) {
        // The bundle was verified byte for byte before it was promoted, so this is a file
        // that changed underneath an installed bundle. Serving it would be serving
        // something nobody hashed.
        debugPrint(
          'bundle server: $path is $length bytes, manifest says ${file.size}',
        );
        await _empty(response, HttpStatus.notFound);
        return;
      }

      _applyHeaders(response, file);
      // The manifest's hash *is* the strong validator, so revalidation is exact and free.
      final String etag = '"${file.sha256}"';
      if (request.headers.value(HttpHeaders.ifNoneMatchHeader) == etag) {
        response.statusCode = HttpStatus.notModified;
        await response.close();
        return;
      }
      response.headers.contentLength = length;
      if (request.method == 'HEAD') {
        await response.close();
        return;
      }
      await response.addStream(onDisk.openRead());
      await response.close();
    } on HttpException {
      // The webview closed the connection mid-response (a reload, a navigation). Normal.
    } catch (error) {
      debugPrint('bundle server: $error');
      try {
        await _empty(response, HttpStatus.internalServerError);
      } on Object {
        // Headers were already sent; nothing left to say.
      }
    }
  }

  void _applyHeaders(HttpResponse response, BundleFile file) {
    final HttpHeaders headers = response.headers;
    // `nosniff` on everything, and an explicit type from the extension: a wrong type here
    // is a file the browser refuses rather than one it guesses at.
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set(HttpHeaders.contentTypeHeader, contentTypeFor(file.path));
    // `no-cache`, not `no-store`: with the manifest hash as the ETag, a revalidation is one
    // 304 on a loopback socket, and the webview keeps its compiled JavaScript across
    // reloads. `no-store` would throw that away on every boot attempt.
    headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
    headers.set(HttpHeaders.etagHeader, '"${file.sha256}"');
    if (file.path == BundleManifest.indexPath && manifest.indexCsp.isNotEmpty) {
      // The nonce in this policy matches the inline import map in those exact bytes
      // (`BRIDGE.md` §5), which is why the manifest carries the policy and the shell does
      // not compose one.
      headers.set('Content-Security-Policy', manifest.indexCsp);
    }
  }

  Future<void> _empty(HttpResponse response, int status) async {
    response.statusCode = status;
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.contentLength = 0;
    await response.close();
  }

  /// The manifest path a request URI asks for.
  ///
  /// `/` means `index.html`; empty segments and `.` are dropped (`//index.html`,
  /// `/./index.html`) so one file has one spelling; anything with a `..` segment returns the
  /// empty string, which matches nothing in the allowlist. Percent-escapes are decoded
  /// because the allowlist holds decoded paths.
  static String requestedPath(Uri uri) {
    final List<String> segments = <String>[];
    for (final String raw in uri.pathSegments) {
      final String segment = Uri.decodeComponent(raw);
      if (segment.isEmpty || segment == '.') continue;
      if (segment == '..' || segment.contains('/')) return '';
      segments.add(segment);
    }
    return segments.isEmpty ? BundleManifest.indexPath : segments.join('/');
  }

  /// Content types the bundle contains. Explicit, not sniffed: `nosniff` is sent on every
  /// response, so a wrong type here is a file the browser refuses rather than a guess.
  static const Map<String, String> contentTypes = <String, String>{
    'html': 'text/html; charset=utf-8',
    'js': 'text/javascript; charset=utf-8',
    'mjs': 'text/javascript; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'json': 'application/json; charset=utf-8',
    'wasm': 'application/wasm',
    'map': 'application/json; charset=utf-8',
    'svg': 'image/svg+xml',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'webp': 'image/webp',
    'woff2': 'font/woff2',
    'ico': 'image/vnd.microsoft.icon',
    'txt': 'text/plain; charset=utf-8',
  };

  static String contentTypeFor(String path) {
    final int dot = path.lastIndexOf('.');
    if (dot < 0) return 'application/octet-stream';
    return contentTypes[path.substring(dot + 1).toLowerCase()] ??
        'application/octet-stream';
  }
}

/// The webview itself: the bundle, the bridge and the boot watchdog.
///
/// Two behaviours that are part of the contract, not decoration:
///
/// * **Only the loopback origin may be a document.** A link to `https://example.com` inside
///   a note opens in the browser, not in this webview: a page on the token-bearing origin
///   must never replace the app.
/// * **The boot watchdog** ([kBootWatchdog]) starts with the load and is cancelled by
///   `shell.bootOk()`. On expiry the shell reports a failed boot — the counter was already
///   incremented before the load, so an expiry does not need to write anything to be
///   counted.
///
/// # How `bootOk()` is observed
///
/// `boot.ok` and `boot.failed` are registered on the [ShellBridge] by the boot flow
/// (`main.dart`, shell-updater's file), because clearing the failed-boot counter is its
/// business. This widget needs to hear the same call to cancel its watchdog, and it cannot
/// register the method twice — [ShellBridge.register] refuses a duplicate on purpose. So it
/// watches the envelope on its way past: this widget owns the `flutter_inappwebview`
/// handler wiring, which is the single point every bridge call flows through, and it reacts
/// to a `boot` envelope *before* forwarding it to [ShellBridge.dispatch]. One handler, one
/// envelope, no second registry.
class WebViewHost extends StatefulWidget {
  const WebViewHost({
    required this.url,
    required this.bridge,
    required this.onBootOk,
    required this.onBootFailed,
    this.auth,
    this.notifications,
    this.serverBaseUrl,
    this.watchdog = kBootWatchdog,
    super.key,
  });

  /// [BundleServer.indexUrl], plus `?safe=1` on the second attempt.
  final Uri url;

  final ShellBridge bridge;

  /// `boot.ok` arrived from the page.
  final VoidCallback onBootOk;

  /// The watchdog expired, or the page reported a failure.
  final void Function(String reason) onBootFailed;

  /// Where the bearer token and the server URL are read from. Defaults to a fresh
  /// [AuthStore] — the keystore is the source of truth for both, so the widget can find
  /// them itself rather than requiring the boot flow to thread them through.
  ///
  /// INTEGRATION (shell-updater): passing the boot flow's own [AuthStore] saves one keystore
  /// round trip per launch. Not required.
  final AuthStore? auth;

  /// Supplies `notifications.permission()`'s baked-in value, and the tapped-notification
  /// route.
  ///
  /// INTEGRATION (shell-updater): `main.dart` should hold one [NotificationsCapability],
  /// `await`&#8203;its `initialize()` before building this widget, and pass it here — both so the
  /// injected `permission()` is the real OS state rather than `default`, and so a
  /// notification tap can steer the page. Without it the page sees `default` and asks.
  final NotificationsCapability? notifications;

  /// Overrides the keystore's server URL (`ShellConfig.serverBaseUrl`), which is what the
  /// page resolves `/api` and the sync socket against (`BRIDGE.md` §6).
  final Uri? serverBaseUrl;

  /// Overridable for tests; production is always [kBootWatchdog].
  final Duration watchdog;

  @override
  State<WebViewHost> createState() => _WebViewHostState();
}

class _WebViewHostState extends State<WebViewHost> {
  late final AuthStore _auth = widget.auth ?? AuthStore();
  late final Future<_BootstrapValues> _values = _readValues();

  InAppWebViewController? _controller;
  Timer? _watchdog;
  bool _settled = false;
  StreamSubscription<List<String>>? _folderChanges;

  @override
  void initState() {
    super.initState();
    tappedNotificationRoute.addListener(_onTappedRoute);
    stagedBundleVersion.addListener(_onStagedBundle);
    // Files changed in the notes folder (`bridge/folder.dart`): the page rescans.
    _folderChanges = folderChanges.stream.listen(
      (List<String> paths) =>
          _controller?.evaluateJavascript(source: folderChangedScript(paths)),
    );
  }

  @override
  void dispose() {
    tappedNotificationRoute.removeListener(_onTappedRoute);
    stagedBundleVersion.removeListener(_onStagedBundle);
    _folderChanges?.cancel();
    _watchdog?.cancel();
    super.dispose();
  }

  /// The three values the injected script bakes in (`BRIDGE.md` §3): they are read before
  /// the webview is built, because the page reads them synchronously during boot.
  Future<_BootstrapValues> _readValues() async {
    await widget.notifications?.initialize();
    final Uri? server = widget.serverBaseUrl ?? await _auth.serverBaseUrl();
    if (server == null) {
      throw StateError(
        'no server URL in the keystore — the login screen stores it on success '
        '(bridge/auth.dart)',
      );
    }
    return _BootstrapValues(
      serverBaseUrl: server,
      bearerToken: await _auth.token(),
      notificationPermission:
          widget.notifications?.permission ?? kPermissionDefault,
    );
  }

  void _startWatchdog() {
    _watchdog?.cancel();
    _watchdog = Timer(widget.watchdog, () {
      _fail(
        'the bundle did not call shell.bootOk() within '
        '${widget.watchdog.inSeconds}s',
      );
    });
  }

  void _succeed() {
    if (_settled) return;
    _settled = true;
    _watchdog?.cancel();
    widget.onBootOk();
  }

  void _fail(String reason) {
    if (_settled) return;
    _settled = true;
    _watchdog?.cancel();
    widget.onBootFailed(reason);
  }

  /// Every bridge call passes through here. `boot.*` is acted on locally *and* forwarded,
  /// so the widget's watchdog and the boot flow's counter both see it (see the class docs).
  Future<Object?> _dispatch(List<dynamic> args) async {
    final Object? raw = args.isEmpty ? null : args.first;
    if (raw is Map) {
      if (raw['capability'] == 'boot') {
        if (raw['method'] == 'ok') {
          _succeed();
        } else if (raw['method'] == 'failed') {
          final Object? params = raw['params'];
          final Object? reason = params is Map ? params['reason'] : null;
          _fail(
            'the bundle reported a failed boot: ${reason ?? 'no reason given'}',
          );
        }
      }
    }
    return widget.bridge.dispatch(raw);
  }

  /// A notification tap steers the page's hash router rather than reloading it: a reload
  /// would drop the socket, the hydrated documents and the plugin graph to move one view.
  /// `route` is an in-app route by contract (`BRIDGE.md` §4.3) — never a URL — and the
  /// `router` plugin listens for `hashchange`.
  void _onTappedRoute() {
    final String? route = tappedNotificationRoute.value;
    final InAppWebViewController? controller = _controller;
    if (route == null || route.isEmpty || controller == null) return;
    tappedNotificationRoute.value = null;
    final String path = route.startsWith('#') ? route.substring(1) : route;
    final String hash = path.startsWith('/') ? path : '/$path';
    controller.evaluateJavascript(
      source: 'location.hash = ${jsonStringLiteral(hash)};',
    );
  }

  /// Tell the running page that a new bundle is verified and staged
  /// (`web/app/src/boot/shell.ts`, `BRIDGE.md` §5/§7).
  ///
  /// Not a bridge method: the page does not ask, it is told, and a `CustomEvent` needs no
  /// handler registration on this side. The web half has listened for both spellings since
  /// M5 — the event and `window.dddShellUpdateReady` — and this is the line that makes them
  /// reachable on a device rather than only in `shell.test.ts`. The event spelling is the
  /// one dispatched because it is the one a plugin can also subscribe to.
  ///
  /// Purely informational, and deliberately additive to the native banner: promotion
  /// happens at the next launch either way, and a page that is mid-boot or broken has no
  /// notice centre to put this in.
  void _onStagedBundle() {
    final String? version = stagedBundleVersion.value;
    final InAppWebViewController? controller = _controller;
    if (version == null || version.isEmpty || controller == null) return;
    controller.evaluateJavascript(source: shellUpdateReadyScript(version));
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<_BootstrapValues>(
    future: _values,
    builder: (BuildContext context, AsyncSnapshot<_BootstrapValues> snapshot) {
      if (snapshot.hasError) {
        // A native screen, never a blank webview: a white rectangle is indistinguishable
        // from a broken app (`CONTRACTS.md`).
        return _Message(
          title: 'ddd cannot open the workspace',
          detail: '${snapshot.error}',
        );
      }
      final _BootstrapValues? values = snapshot.data;
      if (values == null) {
        return const _Message(title: 'Starting…', spinner: true);
      }
      return _webview(values);
    },
  );

  /// Android's back gesture, routed into the page.
  ///
  /// Without this, back kills the app from the middle of a document — the `router` plugin
  /// navigates on `location.hash` (`plugins/base/router`), so every in-app move is a
  /// history entry the webview owns and Flutter knows nothing about. Back only leaves the
  /// app when the page has nowhere left to go, which is what a user expects from a
  /// single-activity app.
  Future<void> _onPopInvoked(bool didPop, Object? _) async {
    if (didPop) return;
    final InAppWebViewController? controller = _controller;
    if (controller == null) return;
    if (await controller.canGoBack()) {
      await controller.goBack();
      return;
    }
    // Nothing to go back to. `SystemNavigator.pop()` and not `Navigator.maybePop()`: this
    // widget is the root route, so a `maybePop` would come straight back through this
    // callback (`canPop` is false) and leave back doing nothing at all.
    await SystemNavigator.pop();
  }

  Widget _webview(_BootstrapValues values) => PopScope(
    // `false` so the pop always reaches [_onPopInvoked]; it decides between the page's own
    // history and leaving the app.
    canPop: false,
    onPopInvokedWithResult: _onPopInvoked,
    child: Scaffold(
      // With `windowSoftInputMode=adjustResize` in the manifest, this is what actually
      // shrinks the webview when the keyboard opens — the M5 acceptance criterion is
      // CodeMirror editing with the Android soft keyboard (SPEC §9 M5).
      resizeToAvoidBottomInset: true,
      body: SafeArea(
        child: InAppWebView(
          initialUrlRequest: URLRequest(url: WebUri(widget.url.toString())),
          initialUserScripts: UnmodifiableListView<UserScript>(<UserScript>[
            UserScript(
              source: widget.bridge.bootstrapScript(
                serverBaseUrl: values.serverBaseUrl,
                bearerToken: values.bearerToken,
                notificationPermission: values.notificationPermission,
              ),
              injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
              // `window.shell` exists on the bundle's origin and nowhere else. Where the
              // WebView supports document-start scripts this is enforced by the platform;
              // navigation is locked to the same origin regardless.
              allowedOriginRules: <String>{_originRule(widget.url)},
            ),
          ]),
          initialSettings: InAppWebViewSettings(
            // The bundle is the app; nothing else may be loaded as a document.
            useShouldOverrideUrlLoading: true,
            // Cancels cross-origin *subframe* loads too: `shouldOverrideUrlLoading` only
            // sees the main frame on Android, and an iframe shares the bridge's realm.
            regexToCancelSubFramesLoading:
                '^(?!${_originPattern(widget.url)}).*',
            // SPEC §9 M5 acceptance: CodeMirror with the Android soft keyboard.
            useHybridComposition: true,
            // Local storage lives in the app's data directory, not evictable web storage
            // (SPEC §7) — which is where Android's WebView keeps IndexedDB and DOM storage
            // for an `http://` origin. What matters is that this is *not* a `file://`
            // origin, where both are unavailable or opaque.
            databaseEnabled: true,
            domStorageEnabled: true,
            // No cleartext to anywhere but the loopback origin (`network_security_config.xml`).
            mixedContentMode: MixedContentMode.MIXED_CONTENT_NEVER_ALLOW,
            // No file access at all: the bundle is served over HTTP, so nothing in the page
            // has a reason to read the filesystem — and `allowFileAccess` is the setting that
            // has historically turned a stored-XSS into a readable keystore directory.
            allowFileAccess: false,
            allowFileAccessFromFileURLs: false,
            allowUniversalAccessFromFileURLs: false,
            allowContentAccess: false,
            // One window, one realm: a popup would be a second document with the same
            // JavaScript handler and no navigation lock.
            supportMultipleWindows: false,
            javaScriptCanOpenWindowsAutomatically: false,
            // Not a browser: no geolocation prompt, and media needs a gesture.
            geolocationEnabled: false,
            mediaPlaybackRequiresUserGesture: true,
            // The app draws its own selection and context menus.
            transparentBackground: true,
          ),
          onWebViewCreated: (InAppWebViewController controller) {
            _controller = controller;
            controller.addJavaScriptHandler(
              handlerName: kBridgeHandlerName,
              callback: _dispatch,
            );
            _startWatchdog();
            // A tap that arrived before the webview existed (the app was closed — which is
            // the entire point of a scheduled notification) is delivered now.
            _onTappedRoute();
          },
          shouldOverrideUrlLoading:
              (
                InAppWebViewController controller,
                NavigationAction action,
              ) async {
                final WebUri? url = action.request.url;
                if (url == null) return NavigationActionPolicy.CANCEL;
                if (isSameOrigin(url, widget.url)) {
                  return NavigationActionPolicy.ALLOW;
                }
                // Everything else is a link in a document. It opens outside the app: a page
                // loaded here would share the origin that holds the workspace and the token.
                await _openExternally(url);
                return NavigationActionPolicy.CANCEL;
              },
          onReceivedError:
              (
                InAppWebViewController controller,
                WebResourceRequest request,
                WebResourceError error,
              ) {
                // Only the document itself: a missing icon is not a failed boot.
                if (request.isForMainFrame ?? false) {
                  _fail('the bundle failed to load: ${error.description}');
                }
              },
          onRenderProcessGone: (InAppWebViewController controller, _) =>
              _fail('the webview process was killed'),
          onConsoleMessage:
              (InAppWebViewController controller, ConsoleMessage message) {
                // The page's console is the only diagnostic a broken bundle produces, and
                // `adb logcat` is where whoever is debugging it is looking.
                debugPrint(
                  'bundle: ${message.messageLevel} ${message.message}',
                );
              },
        ),
      ),
    ),
  );

  /// Opens a document's link in the user's browser (an Android Custom Tab, which is the
  /// user's default browser rendering it out of this app's process).
  ///
  /// Only `http(s)`: an arbitrary scheme from a note is an intent to some other app, and
  /// firing those on a document's behalf is a bigger decision than M5 makes.
  Future<void> _openExternally(WebUri url) async {
    if (url.scheme != 'http' && url.scheme != 'https') {
      debugPrint('bundle: refused to open a ${url.scheme}: link');
      return;
    }
    try {
      await ChromeSafariBrowser().open(url: url);
    } catch (error) {
      debugPrint('bundle: could not open $url externally: $error');
    }
  }
}

/// Same scheme, host and port — the whole of "may be a document here".
bool isSameOrigin(Uri candidate, Uri origin) =>
    candidate.scheme == origin.scheme &&
    candidate.host == origin.host &&
    candidate.port == origin.port;

/// `scheme://host:port/*`, the form `UserScript.allowedOriginRules` wants.
String _originRule(Uri origin) =>
    '${origin.scheme}://${origin.host}:${origin.port}';

/// The same origin as a regular-expression prefix, for
/// `InAppWebViewSettings.regexToCancelSubFramesLoading`.
String _originPattern(Uri origin) =>
    RegExp.escape('${origin.scheme}://${origin.host}:${origin.port}/');

/// A JavaScript string literal for [value].
///
/// `jsonEncode` of a string is a JavaScript string expression: the escaping rules are a
/// subset, and every code point JSON escapes, JavaScript reads the same way. It is here as
/// a named function because the alternative — interpolating a route into a `location.hash =
/// '...'` template — is script injection from a notification payload.
String jsonStringLiteral(String value) => jsonEncode(value);

/// The script that tells a running page a new bundle is verified and staged.
///
/// The event name, the function spelling and the `detail` key are a *contract* with
/// `web/app/src/boot/shell.ts`, pinned in `bridge_fixtures/window_shell.json` so both
/// sides are tested against the same strings rather than against each other's memory. The
/// web half shipped its listeners in M5 and nothing here fired them, which is a mistake a
/// shared fixture makes loud.
///
/// [version] is interpolated as a JSON literal for the same reason a notification route
/// is: it arrives from the server, and a template would be script injection.
String shellUpdateReadyScript(String version) {
  final String name = jsonStringLiteral(kShellUpdateReadyEvent);
  final String detail = '{ bundleVersion: ${jsonStringLiteral(version)} }';
  return 'window.dispatchEvent(new CustomEvent($name, { detail: $detail }));';
}

/// The `CustomEvent` name the page listens for (`BRIDGE.md` §5, §7).
const String kShellUpdateReadyEvent = 'ddd-shell-update-ready';

/// The values baked into the page at document start (`BRIDGE.md` §3).
class _BootstrapValues {
  const _BootstrapValues({
    required this.serverBaseUrl,
    required this.bearerToken,
    required this.notificationPermission,
  });

  final Uri serverBaseUrl;
  final String? bearerToken;
  final String notificationPermission;
}

/// A native screen for the two states that are not a webview.
class _Message extends StatelessWidget {
  const _Message({required this.title, this.detail, this.spinner = false});

  final String title;
  final String? detail;
  final bool spinner;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (spinner) ...<Widget>[
                const CircularProgressIndicator(),
                const SizedBox(height: 24),
              ],
              Text(title, style: Theme.of(context).textTheme.titleLarge),
              if (detail != null) ...<Widget>[
                const SizedBox(height: 12),
                Text(detail!, textAlign: TextAlign.center),
              ],
            ],
          ),
        ),
      ),
    ),
  );
}
