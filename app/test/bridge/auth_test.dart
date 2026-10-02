library;

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ddd_shell/bridge/auth.dart';
import 'package:ddd_shell/bridge/bridge.dart';
import 'package:ddd_shell/config.dart';

Map<String, Object?> envelope(String method, [Map<String, Object?>? params]) =>
    <String, Object?>{
      'v': kBridgeVersion,
      'id': '1',
      'capability': 'auth',
      'method': method,
      'params': ?params,
    };

void main() {
  late Map<String, String> keystore;
  late AuthStore auth;

  setUp(() {
    keystore = <String, String>{};
    FlutterSecureStorage.setMockInitialValues(keystore);
    auth = AuthStore();
  });

  group('storage', () {
    test('a device that has never signed in holds neither secret', () async {
      expect(await auth.token(), isNull);
      expect(await auth.serverBaseUrl(), isNull);
    });

    test('the token round-trips under the frozen key', () async {
      await auth.setToken('tok-123');

      expect(await auth.token(), 'tok-123');
      expect(keystore[kTokenKey], 'tok-123');
      expect(kTokenKey, 'ddd.bearer-token');
    });

    test('an empty token is refused rather than stored', () async {
      await expectLater(
        auth.setToken(''),
        throwsA(
          isA<BridgeException>().having(
            (BridgeException e) => e.code,
            'code',
            BridgeErrorCode.invalid,
          ),
        ),
      );
      expect(keystore, isEmpty);
    });

    test('the server URL is stored as an origin, never as a path', () async {
      await auth.setServerBaseUrl(Uri.parse('https://ddd.example.com/app/'));

      expect(keystore[kServerKey], 'https://ddd.example.com');
      expect(await auth.serverBaseUrl(), Uri.parse('https://ddd.example.com'));
      expect(kServerKey, 'ddd.server-base-url');
    });

    test('signing out drops the token and keeps the server', () async {
      await auth.setToken('tok-123');
      await auth.setServerBaseUrl(Uri.parse('https://ddd.example.com'));

      await auth.clearToken();

      expect(await auth.token(), isNull);
      expect(await auth.serverBaseUrl(), Uri.parse('https://ddd.example.com'));
    });
  });

  group('the bridge methods', () {
    late ShellBridge bridge;

    setUp(() {
      bridge = ShellBridge();
      auth.registerOn(bridge);
    });

    test('registers exactly the three methods BRIDGE.md §4.1 names', () {
      expect(bridge.methods, <String>[
        'auth.clearToken',
        'auth.getToken',
        'auth.setToken',
      ]);
      expect(bridge.capabilities, <String>['auth']);
    });

    test('getToken / setToken / clearToken go through the envelope', () async {
      expect(
        await bridge.dispatch(envelope('getToken')),
        containsPair('result', isNull),
      );

      final Map<String, Object?> set = await bridge.dispatch(
        envelope('setToken', <String, Object?>{'token': 'tok-123'}),
      );
      expect(set['ok'], isTrue);
      expect(set['result'], isNull);

      expect(
        await bridge.dispatch(envelope('getToken')),
        containsPair('result', 'tok-123'),
      );

      expect((await bridge.dispatch(envelope('clearToken')))['ok'], isTrue);
      expect(
        await bridge.dispatch(envelope('getToken')),
        containsPair('result', isNull),
      );
    });

    test('a non-string token is `invalid`, and nothing is stored', () async {
      final Map<String, Object?> response = await bridge.dispatch(
        envelope('setToken', <String, Object?>{'token': 42}),
      );

      expect((response['error']! as Map<String, Object?>)['code'], 'invalid');
      expect(
        (response['error']! as Map<String, Object?>)['message'],
        'token is required',
      );
      expect(keystore, isEmpty);
    });
  });
}
