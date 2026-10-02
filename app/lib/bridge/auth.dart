library;

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'bridge.dart';

const String kTokenKey = 'ddd.bearer-token';
const String kServerKey = 'ddd.server-base-url';

http.Request bearerRequest(String method, Uri url, String token) =>
    http.Request(method, url)
      ..followRedirects = false
      ..headers['Authorization'] = 'Bearer $token';

String redirectNote(int status) => status >= 300 && status < 400
    ? ' — a redirect, which the shell does not follow while carrying the bearer token '
          '(bridge/auth.dart)'
    : '';

class AuthStore {
  AuthStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  Future<String?> token() async => _storage.read(key: kTokenKey);

  Future<void> setToken(String token) async {
    if (token.isEmpty) {
      throw BridgeException.invalid('refusing to store an empty token');
    }
    await _storage.write(key: kTokenKey, value: token);
  }

  Future<void> clearToken() async => _storage.delete(key: kTokenKey);

  Future<Uri?> serverBaseUrl() async {
    final String? raw = await _storage.read(key: kServerKey);
    if (raw == null || raw.isEmpty) return null;
    return Uri.tryParse(raw);
  }

  Future<void> setServerBaseUrl(Uri url) async =>
      _storage.write(key: kServerKey, value: url.origin);

  void registerOn(ShellBridge bridge) {
    bridge.register('auth', 'getToken', (Map<String, Object?> _) => token());
    bridge.register('auth', 'setToken', (Map<String, Object?> params) async {
      final Object? value = params['token'];
      if (value is! String) {
        throw BridgeException.invalid('token is required');
      }
      await setToken(value);
      return null;
    });
    bridge.register('auth', 'clearToken', (Map<String, Object?> _) async {
      await clearToken();
      return null;
    });
  }
}
