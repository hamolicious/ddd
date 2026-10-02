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

class BundleServer {
  BundleServer({
    required this.directory,
    required this.manifest,
    this.port = kLoopbackPort,
  }) : _servable = <String, BundleFile>{
         for (final BundleFile file in manifest.files) file.path: file,
       };

  final Directory directory;

  final BundleManifest manifest;

  final int port;

  final Map<String, BundleFile> _servable;

  HttpServer? _server;

  Uri get origin => Uri.parse('http://127.0.0.1:$port');

  Uri get indexUrl => origin.resolve('/${BundleManifest.indexPath}');

  bool get isRunning => _server != null;

  Set<String> get allowedHosts => <String>{'127.0.0.1:$port'};

  Future<void> start() async {
    if (_server != null) return;
    SocketException? last;
    for (int attempt = 0; attempt < 5; attempt++) {
      try {
        final HttpServer server = await HttpServer.bind(
          InternetAddress.loopbackIPv4,
          port,
        );
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
        debugPrint('bundle server: $path is in the manifest but not on disk');
        await _empty(response, HttpStatus.notFound);
        return;
      }
      if (length != file.size) {
        debugPrint(
          'bundle server: $path is $length bytes, manifest says ${file.size}',
        );
        await _empty(response, HttpStatus.notFound);
        return;
      }

      _applyHeaders(response, file);
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
    } catch (error) {
      debugPrint('bundle server: $error');
      try {
        await _empty(response, HttpStatus.internalServerError);
      } on Object {}
    }
  }

  void _applyHeaders(HttpResponse response, BundleFile file) {
    final HttpHeaders headers = response.headers;
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set(HttpHeaders.contentTypeHeader, contentTypeFor(file.path));
    headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
    headers.set(HttpHeaders.etagHeader, '"${file.sha256}"');
    if (file.path == BundleManifest.indexPath && manifest.indexCsp.isNotEmpty) {
      headers.set('Content-Security-Policy', manifest.indexCsp);
    }
  }

  Future<void> _empty(HttpResponse response, int status) async {
    response.statusCode = status;
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.contentLength = 0;
    await response.close();
  }

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

  final Uri url;

  final ShellBridge bridge;

  final VoidCallback onBootOk;

  final void Function(String reason) onBootFailed;

  final AuthStore? auth;

  final NotificationsCapability? notifications;

  final Uri? serverBaseUrl;

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

  Future<void> _onPopInvoked(bool didPop, Object? _) async {
    if (didPop) return;
    final InAppWebViewController? controller = _controller;
    if (controller == null) return;
    if (await controller.canGoBack()) {
      await controller.goBack();
      return;
    }
    await SystemNavigator.pop();
  }

  Widget _webview(_BootstrapValues values) => PopScope(
    canPop: false,
    onPopInvokedWithResult: _onPopInvoked,
    child: Scaffold(
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
              allowedOriginRules: <String>{_originRule(widget.url)},
            ),
          ]),
          initialSettings: InAppWebViewSettings(
            useShouldOverrideUrlLoading: true,
            regexToCancelSubFramesLoading:
                '^(?!${_originPattern(widget.url)}).*',
            useHybridComposition: true,
            databaseEnabled: true,
            domStorageEnabled: true,
            mixedContentMode: MixedContentMode.MIXED_CONTENT_NEVER_ALLOW,
            allowFileAccess: false,
            allowFileAccessFromFileURLs: false,
            allowUniversalAccessFromFileURLs: false,
            allowContentAccess: false,
            supportMultipleWindows: false,
            javaScriptCanOpenWindowsAutomatically: false,
            geolocationEnabled: false,
            mediaPlaybackRequiresUserGesture: true,
            transparentBackground: true,
          ),
          onWebViewCreated: (InAppWebViewController controller) {
            _controller = controller;
            controller.addJavaScriptHandler(
              handlerName: kBridgeHandlerName,
              callback: _dispatch,
            );
            _startWatchdog();
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
                await _openExternally(url);
                return NavigationActionPolicy.CANCEL;
              },
          onReceivedError:
              (
                InAppWebViewController controller,
                WebResourceRequest request,
                WebResourceError error,
              ) {
                if (request.isForMainFrame ?? false) {
                  _fail('the bundle failed to load: ${error.description}');
                }
              },
          onRenderProcessGone: (InAppWebViewController controller, _) =>
              _fail('the webview process was killed'),
          onConsoleMessage:
              (InAppWebViewController controller, ConsoleMessage message) {
                debugPrint(
                  'bundle: ${message.messageLevel} ${message.message}',
                );
              },
        ),
      ),
    ),
  );

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

bool isSameOrigin(Uri candidate, Uri origin) =>
    candidate.scheme == origin.scheme &&
    candidate.host == origin.host &&
    candidate.port == origin.port;

String _originRule(Uri origin) =>
    '${origin.scheme}://${origin.host}:${origin.port}';

String _originPattern(Uri origin) =>
    RegExp.escape('${origin.scheme}://${origin.host}:${origin.port}/');

String jsonStringLiteral(String value) => jsonEncode(value);

String shellUpdateReadyScript(String version) {
  final String name = jsonStringLiteral(kShellUpdateReadyEvent);
  final String detail = '{ bundleVersion: ${jsonStringLiteral(version)} }';
  return 'window.dispatchEvent(new CustomEvent($name, { detail: $detail }));';
}

const String kShellUpdateReadyEvent = 'ddd-shell-update-ready';

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
