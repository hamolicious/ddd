library;

import 'package:flutter_test/flutter_test.dart';
import 'package:ddd_shell/bridge/bridge.dart';
import 'package:ddd_shell/config.dart';

Map<String, Object?> envelope(
  String capability,
  String method, [
  Map<String, Object?>? params,
]) => <String, Object?>{
  'v': kBridgeVersion,
  'id': '1',
  'capability': capability,
  'method': method,
  'params': ?params,
};

void main() {
  group('dispatch', () {
    test('calls the registered handler and wraps the result', () async {
      final ShellBridge bridge = ShellBridge();
      bridge.register(
        'demo',
        'echo',
        (Map<String, Object?> params) async => params['value'],
      );

      final Map<String, Object?> response = await bridge.dispatch(
        envelope('demo', 'echo', <String, Object?>{'value': 42}),
      );

      expect(response, <String, Object?>{
        'v': 1,
        'id': '1',
        'ok': true,
        'result': 42,
      });
    });

    test('an unknown method is `unsupported`, not a crash', () async {
      final ShellBridge bridge = ShellBridge();

      final Map<String, Object?> response = await bridge.dispatch(
        envelope('demo', 'missing'),
      );

      expect(response['ok'], isFalse);
      expect(
        (response['error']! as Map<String, Object?>)['code'],
        'unsupported',
      );
    });

    test('a newer bridge version is refused rather than guessed at', () async {
      final ShellBridge bridge = ShellBridge();
      bridge.register('demo', 'echo', (Map<String, Object?> _) async => null);

      final Map<String, Object?> response = await bridge.dispatch(
        <String, Object?>{
          'v': kBridgeVersion + 1,
          'id': 'x',
          'capability': 'demo',
          'method': 'echo',
        },
      );

      expect(
        (response['error']! as Map<String, Object?>)['code'],
        'unsupported',
      );
    });

    test('a malformed envelope answers instead of throwing', () async {
      final ShellBridge bridge = ShellBridge();

      expect((await bridge.dispatch('nonsense'))['ok'], isFalse);
      expect((await bridge.dispatch(null))['ok'], isFalse);
      expect((await bridge.dispatch(<String, Object?>{'v': 1}))['ok'], isFalse);
    });

    test(
      'a BridgeException keeps its code; anything else becomes `failed`',
      () async {
        final ShellBridge bridge = ShellBridge();
        bridge.register('demo', 'denied', (Map<String, Object?> _) async {
          throw BridgeException.denied('no permission');
        });
        bridge.register(
          'demo',
          'bug',
          (Map<String, Object?> _) async => throw StateError('oops'),
        );

        final Map<String, Object?> denied = await bridge.dispatch(
          envelope('demo', 'denied'),
        );
        final Map<String, Object?> bug = await bridge.dispatch(
          envelope('demo', 'bug'),
        );

        expect((denied['error']! as Map<String, Object?>)['code'], 'denied');
        expect(
          (denied['error']! as Map<String, Object?>)['message'],
          'no permission',
        );
        expect((bug['error']! as Map<String, Object?>)['code'], 'failed');
      },
    );

    test('a handler that never completes times out', () async {
      final ShellBridge bridge = ShellBridge(
        callTimeout: const Duration(milliseconds: 10),
      );
      bridge.register(
        'demo',
        'hang',
        (Map<String, Object?> _) =>
            Future<Object?>.delayed(const Duration(seconds: 5)),
      );

      final Map<String, Object?> response = await bridge.dispatch(
        envelope('demo', 'hang'),
      );

      expect((response['error']! as Map<String, Object?>)['code'], 'timeout');
    });

    test('registering the same method twice is a programming error', () {
      final ShellBridge bridge = ShellBridge();
      bridge.register('demo', 'echo', (Map<String, Object?> _) async => null);

      expect(
        () => bridge.register(
          'demo',
          'echo',
          (Map<String, Object?> _) async => null,
        ),
        throwsStateError,
      );
    });
  });

  group('capability reporting', () {
    test('capabilities and methods are derived from what is registered', () {
      final ShellBridge bridge = ShellBridge();
      bridge.register(
        'filesystem',
        'export',
        (Map<String, Object?> _) async => null,
      );
      bridge.register(
        'filesystem',
        'pick',
        (Map<String, Object?> _) async => null,
      );
      bridge.register(
        'auth',
        'getToken',
        (Map<String, Object?> _) async => null,
      );

      expect(bridge.capabilities, <String>['auth', 'filesystem']);
      expect(bridge.methods, <String>[
        'auth.getToken',
        'filesystem.export',
        'filesystem.pick',
      ]);
    });
  });

  group('bootstrapScript', () {
    String script(ShellBridge bridge) => bridge.bootstrapScript(
      serverBaseUrl: Uri.parse('https://ddd.example.com'),
      bearerToken: 'tok-123',
      notificationPermission: 'granted',
    );

    test('bakes in the values the page reads before it can call anything', () {
      final ShellBridge bridge = ShellBridge();

      final String source = script(bridge);

      expect(source, contains('version: V'));
      expect(source, contains('bridgeVersion: V'));
      expect(source, contains('"tok-123"'));
      expect(source, contains('"https://ddd.example.com"'));
      expect(source, contains('"granted"'));
      expect(source, contains(kBridgeHandlerName));
    });

    test('defines only the methods that exist', () {
      final ShellBridge bare = ShellBridge();
      final ShellBridge full = ShellBridge()
        ..register(
          'filesystem',
          'export',
          (Map<String, Object?> _) async => null,
        );

      expect(script(bare), contains('METHODS = []'));
      expect(script(full), contains('"filesystem.export"'));
    });
  });
}
