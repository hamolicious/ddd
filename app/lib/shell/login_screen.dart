library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../bridge/auth.dart';
import '../config.dart';

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

enum LoginFailure { rejected, unreachable, noToken }

class LoginException implements Exception {
  LoginException(this.failure, this.message);

  final LoginFailure failure;
  final String message;

  @override
  String toString() => 'LoginException(${failure.name}): $message';
}

const Duration kLoginTimeout = Duration(seconds: 20);

class Preflight {
  const Preflight({
    required this.reachable,
    required this.originAllowed,
    this.detail,
  });

  final bool reachable;

  final bool originAllowed;

  final String? detail;

  bool get isHealthy => reachable && originAllowed;
}

class LoginService {
  LoginService({required this.auth, http.Client? client, Uri? shellOrigin})
    : _client = client ?? http.Client(),
      shellOrigin = shellOrigin ?? kLoopbackOrigin;

  final AuthStore auth;
  final http.Client _client;

  final Uri shellOrigin;

  Future<String> login(LoginRequest request) async {
    final String token = await _post(request);
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
              'origin': shellOrigin.origin,
            },
            body: request.body,
          )
          .timeout(kLoginTimeout);
    } catch (error) {
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
      throw LoginException(
        LoginFailure.unreachable,
        '${request.serverBaseUrl.origin} answered, but not like a ddd server.',
      );
    }
    final Object? token = decoded is Map ? decoded['token'] : null;
    if (token is! String || token.isEmpty) {
      throw LoginException(
        LoginFailure.noToken,
        'That server signed in but issued no bearer token. It is older than the shell '
        'needs, or something between it and this device dropped the token request.',
      );
    }
    return token;
  }

  String _rejection(http.Response response) {
    final String? message = _errorMessage(response.body);
    return switch (response.statusCode) {
      HttpStatus.unauthorized => message ?? 'Wrong email or password.',
      HttpStatus.tooManyRequests =>
        message ??
            'Too many attempts. Wait a minute before trying again '
                '(the server backs off per account and per address).',
      HttpStatus.notFound =>
        'There is no ddd API at ${response.request?.url.origin}.',
      _ =>
        message ??
            'The server refused the sign-in (HTTP ${response.statusCode}).',
    };
  }

  Future<bool> reachable(Uri serverBaseUrl) async =>
      (await preflight(serverBaseUrl)).reachable;

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

    final bool healthy =
        response.statusCode == HttpStatus.ok &&
        response.body.trim().toLowerCase() == 'ok';
    if (!healthy) {
      return Preflight(
        reachable: false,
        originAllowed: false,
        detail:
            '${serverBaseUrl.origin} answered HTTP ${response.statusCode} at /healthz, '
            'which is not what a ddd server answers. Check the URL — a reverse '
            'proxy in front of a different app looks exactly like this.',
      );
    }

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

String _short(Object error) => switch (error) {
  SocketException(message: final String message, osError: final OSError? os) =>
    os == null ? message : '$message (${os.message})',
  HandshakeException() => 'the TLS handshake failed',
  http.ClientException(message: final String message) => message,
  _ => error.toString().split('\n').first,
};

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

bool _isPlausibleHost(String host) {
  if (host.contains(':')) return true;
  return RegExp(r'^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$').hasMatch(host);
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({
    required this.service,
    required this.onSignedIn,
    this.initialServer,
    super.key,
  });

  final LoginService service;

  final void Function(Uri serverBaseUrl, String token) onSignedIn;

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

  String? _warning;

  @override
  void initState() {
    super.initState();
    _server.text = widget.initialServer?.toString() ?? '';
    _server.addListener(_onServerChanged);
  }

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
              Text('ddd', style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 24),
              TextField(
                controller: _server,
                keyboardType: TextInputType.url,
                autocorrect: false,
                decoration: const InputDecoration(
                  labelText: 'Server',
                  hintText: 'https://ddd.example.com',
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
