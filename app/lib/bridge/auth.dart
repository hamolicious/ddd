/// `auth` — the bearer token and the server URL, in the platform keystore
/// (SPEC §5.2: "Shell: bearer tokens … stored in native secure storage").
///
/// Why native storage and not the webview's: the token has to survive an app restart and
/// a bundle swap, and web storage in a webview is evictable (SPEC §7 — "webview storage
/// backed by a native data directory, not evictable web storage"). It is also the one
/// secret the shell holds, so it belongs behind Android's Keystore rather than in a file
/// next to the bundle.
///
/// **The token reaches the page.** `bridge.dart` bakes it into `window.shell.bearerToken`
/// at document start, because the PWA needs it before its first request. That is not a
/// weakening: frontend plugins are full-trust and share the session by design
/// (SPEC §6.1), and the alternative — a local proxy that holds the token and injects it —
/// would turn the loopback server into an authenticated open proxy any app on the device
/// could drive (`BRIDGE.md` §6).
library;

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'bridge.dart';

/// Keystore keys. Changing one logs every device out; treat them as frozen.
const String kTokenKey = 'lm.bearer-token';
const String kServerKey = 'lm.server-base-url';

/// Attach the bearer token to [request] and **refuse to follow redirects while holding
/// it**. Every authenticated request the shell makes natively goes through here.
///
/// `dart:io` copies the original request's headers onto a redirect target with no
/// same-origin check, and `package:http`'s `IOClient` leaves `followRedirects` at `true`.
/// So a single `301`/`302` from the configured server — an operator moving the
/// deployment, an identity proxy bouncing an unrecognised request to an SSO host — hands
/// a 30-day-idle / 180-day-absolute workspace credential (SPEC §5.2) to whatever host the
/// `Location` names, silently and with full read/write over every document.
///
/// The server never legitimately redirects `/api` (SPEC §5.1 — TLS terminates at the
/// ingress and the app talks to one origin), so a redirect is either a misconfiguration
/// or an attack, and both are better reported than followed. The caller sees a non-200
/// status and says so; [redirectNote] makes the log line name the cause.
http.Request bearerRequest(String method, Uri url, String token) =>
    http.Request(method, url)
      ..followRedirects = false
      ..headers['Authorization'] = 'Bearer $token';

/// The half-sentence that turns "answered 302" into a diagnosis.
String redirectNote(int status) => status >= 300 && status < 400
    ? ' — a redirect, which the shell does not follow while carrying the bearer token '
          '(bridge/auth.dart)'
    : '';

/// Reads and writes the two persisted secrets, and exposes them as `auth.*` bridge
/// methods (`BRIDGE.md` §4.1).
class AuthStore {
  AuthStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  /// The bearer token, or `null` when the user has never signed in on this device.
  Future<String?> token() async => _storage.read(key: kTokenKey);

  /// Stores a token the server just issued (login, or a re-auth after a 4401).
  Future<void> setToken(String token) async {
    if (token.isEmpty) {
      throw BridgeException.invalid('refusing to store an empty token');
    }
    await _storage.write(key: kTokenKey, value: token);
  }

  /// Sign-out. **Only the token** — the server URL survives, so the login screen comes
  /// back pre-filled. Local documents are the webview's business (SPEC §5.3: the page
  /// clears its own IndexedDB after warning about unsynced edits).
  Future<void> clearToken() async => _storage.delete(key: kTokenKey);

  /// The server the user typed on the login screen. A self-hosted app cannot hard-code
  /// one, and the whole boot flow depends on it.
  Future<Uri?> serverBaseUrl() async {
    final String? raw = await _storage.read(key: kServerKey);
    if (raw == null || raw.isEmpty) return null;
    return Uri.tryParse(raw);
  }

  Future<void> setServerBaseUrl(Uri url) async =>
      _storage.write(key: kServerKey, value: url.origin);

  /// Wires `auth.getToken`, `auth.setToken` and `auth.clearToken`.
  ///
  /// `getToken` is registered even though the token is also baked into the page: a
  /// long-lived webview that was re-authenticated natively needs a way to pick up the new
  /// one without a reload.
  void registerOn(ShellBridge bridge) {
    bridge.register('auth', 'getToken', (Map<String, Object?> _) => token());
    bridge.register('auth', 'setToken', (Map<String, Object?> params) async {
      final Object? value = params['token'];
      if (value is! String) {
        // The wording `bridge_fixtures/auth.json` pins: an absent key and a key of the
        // wrong type are the same web-side bug, and naming the field is the useful half.
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
