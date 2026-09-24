/// The native login screen: server URL, email, password → a bearer token in the keystore
/// (SPEC §5.2: "Shell: bearer tokens … issued at login").
///
/// **Why login is native and not a page.** On first run there is no bundle to show a form
/// in — the shell has to authenticate *before* it can download one, because
/// `GET /api/shell/manifest` is authenticated (it names every installed plugin, the same
/// information `GET /api/plugins` protects). So the order is: native login → manifest →
/// bundle → webview. Re-authentication after a 4401 can happen either way; the page's own
/// login form works once a bundle exists, and hands the new token back through
/// `shell.setBearerToken()` (`BRIDGE.md` §4.1).
///
/// The server URL is asked for here because a self-hosted app cannot hard-code one, and it
/// is stored next to the token (`bridge/auth.dart`).
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../bridge/auth.dart';
import '../config.dart';

/// `POST /api/auth/login` with `token: true` — the bearer-token flow the server has
/// supported since M1 (SPEC §5.2; the field is also accepted as `bearer`).
class LoginRequest {
  const LoginRequest({
    required this.serverBaseUrl,
    required this.email,
    required this.password,
  });

  final Uri serverBaseUrl;
  final String email;
  final String password;

  Uri get url => serverBaseUrl.resolve('/api/auth/login');

  String get body => jsonEncode(<String, Object?>{
    'email': email,
    'password': password,
    'token': true,
  });
}

/// Why a login attempt failed, in the terms the screen shows.
enum LoginFailure {
  /// Wrong email or password, or rate-limited (SPEC §5.2 backoff).
  rejected,

  /// The URL is not a Life Manager server, or is unreachable.
  unreachable,

  /// The server answered without a token — it is older than M1's bearer support, or
  /// `token: true` was dropped by a proxy.
  noToken,
}

class LoginException implements Exception {
  LoginException(this.failure, this.message);

  final LoginFailure failure;
  final String message;

  @override
  String toString() => 'LoginException(${failure.name}): $message';
}

/// How long login and the pre-flight get. A human is watching a spinner; a server that
/// cannot answer in this long is a server worth reporting as unreachable.
const Duration kLoginTimeout = Duration(seconds: 20);

/// What the pre-flight learned about a URL, before any password is sent.
///
/// Two independent facts, because they fail independently and the wording has to differ:
/// a URL that is not a Life Manager server is the user's typo, and a server that does not
/// allowlist the shell's origin is the operator's `APP_ORIGIN` (SPEC §4.3) — the single most
/// likely cause of "signed in, never syncs" (`BRIDGE.md` §6).
class Preflight {
  const Preflight({
    required this.reachable,
    required this.originAllowed,
    this.detail,
  });

  /// `/healthz` answered.
  final bool reachable;

  /// The response carried `Access-Control-Allow-Origin` for the shell's loopback origin,
  /// so the page's cross-origin API calls and its WebSocket upgrade will be accepted.
  ///
  /// `false` is a *warning*, never a block: the check is one request against one endpoint,
  /// and an operator who is mid-deploy should still be able to sign in.
  final bool originAllowed;

  /// Something to show the user when one of the two is false.
  final String? detail;

  bool get isHealthy => reachable && originAllowed;
}

/// The one network call the shell makes before it has a bundle.
class LoginService {
  LoginService({required this.auth, http.Client? client, Uri? shellOrigin})
    : _client = client ?? http.Client(),
      shellOrigin = shellOrigin ?? kLoopbackOrigin;

  final AuthStore auth;
  final http.Client _client;

  /// The origin the webview will run on, and therefore the origin the server has to
  /// allowlist ([Preflight.originAllowed]).
  final Uri shellOrigin;

  /// Logs in, stores the token and the server URL, and returns the token.
  ///
  /// Implementation notes for shell-bridge:
  ///
  /// * a 200 with `{ "token": "…" }` is the success path; a 200 *without* a token is
  ///   [LoginFailure.noToken] (do not fall through to a cookie — there is no cookie jar
  ///   worth having here);
  /// * 401/403/429 are [LoginFailure.rejected], with the server's `error.message`;
  /// * a `SocketException`, a TLS failure or non-JSON is [LoginFailure.unreachable];
  /// * store the server URL **only on success**, so a typo does not become the remembered
  ///   server.
  Future<String> login(LoginRequest request) async {
    final String token = await _post(request);
    // Both, and only here: the token is useless without knowing which server issued it.
    await auth.setToken(token);
    await auth.setServerBaseUrl(request.serverBaseUrl);
    return token;
  }

  Future<String> _post(LoginRequest request) async {
    final http.Response response;
    try {
      response = await _client
          .post(
            request.url,
            headers: <String, String>{
              HttpHeaders.contentTypeHeader: 'application/json',
              HttpHeaders.acceptHeader: 'application/json',
              // Sent so the server's CORS layer answers the way it will answer the
              // webview: the response's `Access-Control-Allow-Origin` is how the shell
              // knows whether `APP_ORIGIN` lists it ([Preflight]).
              'origin': shellOrigin.origin,
            },
            body: request.body,
          )
          .timeout(kLoginTimeout);
    } catch (error) {
      // A `SocketException`, a TLS handshake failure, a DNS miss, a timeout: from the
      // user's side these are one fact — that URL did not answer.
      throw LoginException(
        LoginFailure.unreachable,
        'Could not reach ${request.serverBaseUrl.origin}: ${_short(error)}',
      );
    }

    if (response.statusCode != HttpStatus.ok) {
      throw LoginException(
        response.statusCode >= 500
            ? LoginFailure.unreachable
            : LoginFailure.rejected,
        _rejection(response),
      );
    }

    final Object? decoded;
    try {
      decoded = jsonDecode(response.body);
    } on FormatException {
      // A 200 that is not JSON is something in front of the server — a captive portal, a
      // proxy error page, the wrong host entirely.
      throw LoginException(
        LoginFailure.unreachable,
        '${request.serverBaseUrl.origin} answered, but not like a Life Manager server.',
      );
    }
    final Object? token = decoded is Map ? decoded['token'] : null;
    if (token is! String || token.isEmpty) {
      // Deliberately not falling back to the cookie the server also set: there is no
      // cookie jar worth having here (the webview is a different origin — `BRIDGE.md` §6).
      throw LoginException(
        LoginFailure.noToken,
        'That server signed in but issued no bearer token. It is older than the shell '
        'needs, or something between it and this device dropped the token request.',
      );
    }
    return token;
  }

  /// The user-facing sentence for a non-200, from the server's own `error.message`
  /// (`backend/crates/server/src/error.rs`).
  String _rejection(http.Response response) {
    final String? message = _errorMessage(response.body);
    return switch (response.statusCode) {
      HttpStatus.unauthorized => message ?? 'Wrong email or password.',
      HttpStatus.tooManyRequests =>
        message ??
            'Too many attempts. Wait a minute before trying again '
                '(the server backs off per account and per address).',
      HttpStatus.notFound =>
        'There is no Life Manager API at ${response.request?.url.origin}.',
      _ =>
        message ??
            'The server refused the sign-in (HTTP ${response.statusCode}).',
    };
  }

  /// A friendly pre-flight: `GET /healthz` on the entered URL, so "that is not a Life
  /// Manager server" is said before the password is sent.
  ///
  /// It is also where the `APP_ORIGIN` problem gets caught early: the shell's own origin
  /// (`http://127.0.0.1:41847`) has to be in the server's allowlist (SPEC §4.3), and a
  /// server that answers `/healthz` but rejects the shell's CORS pre-flight produces an app
  /// that logs in and then never syncs. Report it here, once, in words an operator can act
  /// on.
  Future<bool> reachable(Uri serverBaseUrl) async =>
      (await preflight(serverBaseUrl)).reachable;

  /// [reachable], plus the `APP_ORIGIN` answer. Never throws: everything it learns is
  /// reported, including "nothing".
  Future<Preflight> preflight(Uri serverBaseUrl) async {
    final Uri url = serverBaseUrl.resolve('/healthz');
    final http.Response response;
    try {
      response = await _client
          .get(url, headers: <String, String>{'origin': shellOrigin.origin})
          .timeout(kLoginTimeout);
    } catch (error) {
      return Preflight(
        reachable: false,
        originAllowed: false,
        detail:
            'Could not reach ${serverBaseUrl.origin}: ${_short(error)}\n'
            'Check the URL, and that this device can see that host.',
      );
    }

    // `/healthz` is a 200 with the body `ok` and nothing else (`routes/health.rs`).
    final bool healthy =
        response.statusCode == HttpStatus.ok &&
        response.body.trim().toLowerCase() == 'ok';
    if (!healthy) {
      return Preflight(
        reachable: false,
        originAllowed: false,
        detail:
            '${serverBaseUrl.origin} answered HTTP ${response.statusCode} at /healthz, '
            'which is not what a Life Manager server answers. Check the URL — a reverse '
            'proxy in front of a different app looks exactly like this.',
      );
    }

    // The server echoes the origin only when it is in `APP_ORIGIN`; `tower-http`'s CORS
    // layer cannot wildcard alongside credentials, so an echo means an allowlist hit
    // (`backend/crates/server/src/routes/mod.rs`).
    final String? allowed = response.headers['access-control-allow-origin'];
    final bool originAllowed =
        allowed != null &&
        allowed.trim().toLowerCase() == shellOrigin.origin.toLowerCase();
    return Preflight(
      reachable: true,
      originAllowed: originAllowed,
      detail: originAllowed
          ? null
          : 'Signed in, but this server does not list ${shellOrigin.origin} in '
                'APP_ORIGIN. The app will not sync until it does — add it to APP_ORIGIN '
                'and restart the server (SPEC §4.3).',
    );
  }

  void close() => _client.close();
}

/// Pulls `error.message` out of the server's error body
/// (`backend/crates/server/src/error.rs`), or `null` when the body is not one.
String? _errorMessage(String body) {
  if (body.isEmpty) return null;
  try {
    final Object? decoded = jsonDecode(body);
    if (decoded is Map && decoded['error'] is Map) {
      final Object? message = (decoded['error'] as Map)['message'];
      if (message is String && message.isNotEmpty) return message;
    }
  } on FormatException {
    return null;
  }
  return null;
}

/// The readable half of a transport exception. `SocketException.toString()` is three lines
/// of address detail; the login screen has one.
String _short(Object error) => switch (error) {
  SocketException(message: final String message, osError: final OSError? os) =>
    os == null ? message : '$message (${os.message})',
  HandshakeException() => 'the TLS handshake failed',
  http.ClientException(message: final String message) => message,
  _ => error.toString().split('\n').first,
};

/// What the user typed, as an origin — or `null` when it is not one.
///
/// A phone keyboard produces `life.example.com`, ` https://life.example.com/ ` and
/// `https://life.example.com/app` about equally often; all three mean the same server, and
/// only the first needs a scheme invented for it. Everything is reduced to an **origin**
/// because that is what `ShellConfig.api()` resolves against and what the server's
/// `APP_ORIGIN` compares — a remembered path would silently produce `/app/api/…`.
///
/// `https` is the assumed scheme, never `http`: the bearer token travels on every request
/// (SPEC §5.2), and guessing cleartext for someone is not the shell's decision to make. A
/// self-hosted plain-HTTP server can be typed in full.
Uri? normalizeServerUrl(String raw) {
  final String text = raw.trim();
  if (text.isEmpty) return null;
  final Uri? parsed = Uri.tryParse(
    text.contains('://') ? text : 'https://$text',
  );
  if (parsed == null || parsed.host.isEmpty) return null;
  if (!parsed.isScheme('https') && !parsed.isScheme('http')) return null;
  if (!_isPlausibleHost(parsed.host)) return null;
  return Uri.parse(parsed.origin);
}

/// Whether [host] could be a hostname or an IP literal.
///
/// `Uri.tryParse` does not refuse a host it cannot make sense of — it percent-escapes it,
/// so `not a url` parses happily as `https://not%20a%20url`. That would send the user's
/// password at a name that cannot resolve and report it as "could not reach", which reads
/// like the server is down rather than like a typo. Checked here instead, before anything
/// leaves the device.
bool _isPlausibleHost(String host) {
  // `Uri.host` strips the brackets from an IPv6 literal; anything with a colon left in it
  // is one, and `Uri` has already validated it.
  if (host.contains(':')) return true;
  return RegExp(r'^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$').hasMatch(host);
}

/// The form. Owned by the shell-bridge area; deliberately plain — this screen is seen once
/// per device and must work before anything else does.
class LoginScreen extends StatefulWidget {
  const LoginScreen({
    required this.service,
    required this.onSignedIn,
    this.initialServer,
    super.key,
  });

  final LoginService service;

  /// Called with the issued token once it is in the keystore.
  final void Function(Uri serverBaseUrl, String token) onSignedIn;

  /// Pre-filled after a sign-out (the URL outlives the token).
  final Uri? initialServer;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final TextEditingController _server = TextEditingController();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _password = TextEditingController();
  bool _busy = false;
  String? _error;

  /// A pre-flight warning the user has seen but not yet accepted. Set when the server is a
  /// Life Manager server that does not allowlist the shell's origin: signing in will work
  /// and syncing will not, which is worth one extra tap rather than a silent surprise.
  String? _warning;

  @override
  void initState() {
    super.initState();
    _server.text = widget.initialServer?.toString() ?? '';
    _server.addListener(_onServerChanged);
  }

  /// A warning is about *the URL that was pre-flighted*. Editing the field invalidates it,
  /// and without this the "Sign in anyway" state would carry over to a different server and
  /// skip its pre-flight entirely.
  void _onServerChanged() {
    if (_warning == null && _error == null) return;
    setState(() {
      _warning = null;
      _error = null;
    });
  }

  @override
  void dispose() {
    _server.removeListener(_onServerChanged);
    _server.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final Uri? url = normalizeServerUrl(_server.text);
    if (url == null) {
      setState(() => _error = 'Enter the full server URL, including https://');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // Pre-flight first, so "that is not a Life Manager server" is said before the
      // password is sent, and the `APP_ORIGIN` problem is named while an operator is
      // still looking at it. A warning the user has already seen is not re-raised.
      if (_warning == null) {
        final Preflight check = await widget.service.preflight(url);
        if (!check.reachable) {
          setState(() => _error = check.detail);
          return;
        }
        if (!check.originAllowed) {
          setState(() => _warning = check.detail);
          return;
        }
      }
      final String token = await widget.service.login(
        LoginRequest(
          serverBaseUrl: url,
          email: _email.text.trim(),
          password: _password.text,
        ),
      );
      widget.onSignedIn(url, token);
    } on LoginException catch (error) {
      setState(() => _error = error.message);
    } catch (error) {
      setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(
                'Life Manager',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 24),
              TextField(
                controller: _server,
                keyboardType: TextInputType.url,
                autocorrect: false,
                decoration: const InputDecoration(
                  labelText: 'Server',
                  hintText: 'https://life.example.com',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                decoration: const InputDecoration(labelText: 'Email'),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _password,
                obscureText: true,
                onSubmitted: (_) => _busy ? null : _submit(),
                decoration: const InputDecoration(labelText: 'Password'),
              ),
              if (_error != null) ...<Widget>[
                const SizedBox(height: 16),
                Text(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              if (_warning != null) ...<Widget>[
                const SizedBox(height: 16),
                Text(
                  _warning!,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.tertiary,
                  ),
                ),
              ],
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: Text(switch ((_busy, _warning != null)) {
                  (true, _) => 'Signing in…',
                  // The second tap: the operator has read the APP_ORIGIN warning and
                  // wants to sign in anyway (it is fixable server-side afterwards).
                  (false, true) => 'Sign in anyway',
                  (false, false) => 'Sign in',
                }),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
