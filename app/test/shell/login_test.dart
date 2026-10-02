library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ddd_shell/bridge/auth.dart';
import 'package:ddd_shell/config.dart';
import 'package:ddd_shell/shell/login_screen.dart';

void main() {
  late Map<String, String> keystore;
  late AuthStore auth;

  setUp(() {
    keystore = <String, String>{};
    FlutterSecureStorage.setMockInitialValues(keystore);
    auth = AuthStore();
  });

  LoginService service(MockClient client) =>
      LoginService(auth: auth, client: client);

  LoginRequest request([String server = 'https://ddd.example.com']) =>
      LoginRequest(
        serverBaseUrl: Uri.parse(server),
        email: 'a@b.co',
        password: 'hunter2',
      );

  group('normalizeServerUrl', () {
    test('a bare host gets https, never http', () {
      expect(
        normalizeServerUrl('ddd.example.com'),
        Uri.parse('https://ddd.example.com'),
      );
    });

    test('reduces everything to an origin', () {
      for (final String typed in <String>[
        '  https://ddd.example.com/  ',
        'https://ddd.example.com/app',
        'https://ddd.example.com/app?x=1#y',
      ]) {
        expect(
          normalizeServerUrl(typed),
          Uri.parse('https://ddd.example.com'),
          reason: typed,
        );
      }
    });

    test('a self-hosted plain-HTTP server can be typed in full', () {
      expect(
        normalizeServerUrl('http://192.168.1.10:8080'),
        Uri.parse('http://192.168.1.10:8080'),
      );
    });

    test('nonsense is null, not a guess', () {
      expect(normalizeServerUrl(''), isNull);
      expect(normalizeServerUrl('   '), isNull);
      expect(normalizeServerUrl('ftp://ddd.example.com'), isNull);
      expect(normalizeServerUrl('https://'), isNull);
      expect(normalizeServerUrl('not a url'), isNull);
      expect(normalizeServerUrl('https://a b.com'), isNull);
    });

    test('an IP literal and a port are both servers someone self-hosts', () {
      expect(
        normalizeServerUrl('192.168.1.10:8080'),
        Uri.parse('https://192.168.1.10:8080'),
      );
      expect(
        normalizeServerUrl('http://[::1]:8080'),
        Uri.parse('http://[::1]:8080'),
      );
    });
  });

  group('LoginRequest', () {
    test('asks for a bearer token with the spelling SPEC §5.2 names', () {
      expect(
        request().url,
        Uri.parse('https://ddd.example.com/api/auth/login'),
      );
      expect(jsonDecode(request().body), <String, Object?>{
        'email': 'a@b.co',
        'password': 'hunter2',
        'token': true,
      });
    });
  });

  group('login', () {
    test('stores the token and the server on success', () async {
      late http.Request seen;
      final String token = await service(
        MockClient((http.Request r) async {
          seen = r;
          return http.Response(
            '{"token":"tok-123"}',
            200,
            request: r,
            headers: <String, String>{'content-type': 'application/json'},
          );
        }),
      ).login(request());

      expect(token, 'tok-123');
      expect(keystore[kTokenKey], 'tok-123');
      expect(keystore[kServerKey], 'https://ddd.example.com');
      expect(seen.headers['origin'], kLoopbackOrigin.origin);
    });

    test(
      'a 200 without a token is `noToken`, never a silent cookie login',
      () async {
        await expectLater(
          service(
            MockClient(
              (http.Request r) async =>
                  http.Response('{"user":{}}', 200, request: r),
            ),
          ).login(request()),
          throwsA(
            isA<LoginException>().having(
              (LoginException e) => e.failure,
              'failure',
              LoginFailure.noToken,
            ),
          ),
        );
        expect(keystore, isEmpty);
      },
    );

    test('a 401 is `rejected`, and carries the server\'s own words', () async {
      await expectLater(
        service(
          MockClient(
            (http.Request r) async => http.Response(
              '{"error":{"message":"wrong email or password"}}',
              401,
              request: r,
            ),
          ),
        ).login(request()),
        throwsA(
          isA<LoginException>()
              .having(
                (LoginException e) => e.failure,
                'failure',
                LoginFailure.rejected,
              )
              .having(
                (LoginException e) => e.message,
                'message',
                contains('wrong email or password'),
              ),
        ),
      );
    });

    test('a 429 says what to do about it (SPEC §5.2 backoff)', () async {
      await expectLater(
        service(
          MockClient(
            (http.Request r) async => http.Response('', 429, request: r),
          ),
        ).login(request()),
        throwsA(
          isA<LoginException>().having(
            (LoginException e) => e.message,
            'message',
            contains('Wait'),
          ),
        ),
      );
    });

    test(
      'a 5xx is `unreachable`, not the user\'s password being wrong',
      () async {
        await expectLater(
          service(
            MockClient(
              (http.Request r) async => http.Response('', 503, request: r),
            ),
          ).login(request()),
          throwsA(
            isA<LoginException>().having(
              (LoginException e) => e.failure,
              'failure',
              LoginFailure.unreachable,
            ),
          ),
        );
      },
    );

    test(
      'a 200 that is not JSON is something in front of the server',
      () async {
        await expectLater(
          service(
            MockClient(
              (http.Request r) async =>
                  http.Response('<html>captive portal</html>', 200, request: r),
            ),
          ).login(request()),
          throwsA(
            isA<LoginException>()
                .having(
                  (LoginException e) => e.failure,
                  'failure',
                  LoginFailure.unreachable,
                )
                .having(
                  (LoginException e) => e.message,
                  'message',
                  contains('not like a ddd server'),
                ),
          ),
        );
      },
    );

    test(
      'a dead socket is one fact to the user: that URL did not answer',
      () async {
        await expectLater(
          service(
            MockClient(
              (http.Request _) async =>
                  throw const SocketException('Connection refused'),
            ),
          ).login(request()),
          throwsA(
            isA<LoginException>()
                .having(
                  (LoginException e) => e.failure,
                  'failure',
                  LoginFailure.unreachable,
                )
                .having(
                  (LoginException e) => e.message,
                  'message',
                  contains('Connection refused'),
                ),
          ),
        );
        expect(keystore, isEmpty);
      },
    );
  });

  group('preflight', () {
    MockClient healthz({
      int status = 200,
      String body = 'ok',
      Map<String, String> headers = const <String, String>{},
    }) => MockClient(
      (http.Request r) async =>
          http.Response(body, status, request: r, headers: headers),
    );

    test(
      'a healthy server that allowlists the shell origin is clean',
      () async {
        final Preflight check = await service(
          healthz(
            headers: <String, String>{
              'access-control-allow-origin': kLoopbackOrigin.origin,
            },
          ),
        ).preflight(Uri.parse('https://ddd.example.com'));

        expect(check.isHealthy, isTrue);
        expect(check.detail, isNull);
      },
    );

    test('a missing APP_ORIGIN is a warning with a fix in it', () async {
      final Preflight check = await service(healthz())
          .preflight(Uri.parse('https://ddd.example.com'));

      expect(check.reachable, isTrue);
      expect(check.originAllowed, isFalse);
      expect(check.detail, contains('APP_ORIGIN'));
      expect(check.detail, contains(kLoopbackOrigin.origin));
    });

    test('a different origin echoed back is not this shell\'s', () async {
      final Preflight check = await service(
        healthz(
          headers: <String, String>{
            'access-control-allow-origin': 'https://ddd.example.com',
          },
        ),
      ).preflight(Uri.parse('https://ddd.example.com'));

      expect(check.originAllowed, isFalse);
    });

    test('something that is not a ddd server says so', () async {
      final Preflight check = await service(
        healthz(status: 404, body: 'Not Found'),
      ).preflight(Uri.parse('https://ddd.example.com'));

      expect(check.reachable, isFalse);
      expect(check.detail, contains('/healthz'));
    });

    test('a 200 whose body is not `ok` is not a ddd server either', () async {
      final Preflight check = await service(
        healthz(body: '<html>welcome</html>'),
      ).preflight(Uri.parse('https://ddd.example.com'));

      expect(check.reachable, isFalse);
    });

    test(
      'never throws — everything it learns is reported, including nothing',
      () async {
        final Preflight check = await service(
          MockClient(
            (http.Request _) async =>
                throw const SocketException('No route to host'),
          ),
        ).preflight(Uri.parse('https://ddd.example.com'));

        expect(check.reachable, isFalse);
        expect(check.originAllowed, isFalse);
        expect(check.detail, contains('No route to host'));
      },
    );

    test('reachable() is preflight()\'s first half', () async {
      expect(
        await service(healthz())
            .reachable(Uri.parse('https://ddd.example.com')),
        isTrue,
      );
      expect(
        await service(healthz(status: 500))
            .reachable(Uri.parse('https://ddd.example.com')),
        isFalse,
      );
    });
  });

  group('the screen', () {
    Future<void> pump(
      WidgetTester tester,
      MockClient client, {
      void Function(Uri, String)? onSignedIn,
    }) => tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(
          service: service(client),
          onSignedIn: onSignedIn ?? (Uri _, String _) {},
        ),
      ),
    );

    Future<void> fillIn(
      WidgetTester tester, {
      String server = 'ddd.example.com',
    }) async {
      await tester.enterText(find.byType(TextField).at(0), server);
      await tester.enterText(find.byType(TextField).at(1), 'a@b.co');
      await tester.enterText(find.byType(TextField).at(2), 'hunter2');
    }

    testWidgets('signs in and hands the token back', (
      WidgetTester tester,
    ) async {
      Uri? server;
      String? token;
      await pump(
        tester,
        MockClient((http.Request r) async {
          if (r.url.path == '/healthz') {
            return http.Response(
              'ok',
              200,
              request: r,
              headers: <String, String>{
                'access-control-allow-origin': kLoopbackOrigin.origin,
              },
            );
          }
          return http.Response('{"token":"tok-123"}', 200, request: r);
        }),
        onSignedIn: (Uri s, String t) {
          server = s;
          token = t;
        },
      );

      await fillIn(tester);
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();

      expect(server, Uri.parse('https://ddd.example.com'));
      expect(token, 'tok-123');
    });

    testWidgets('an unparseable URL is caught before any request', (
      WidgetTester tester,
    ) async {
      bool called = false;
      await pump(
        tester,
        MockClient((http.Request _) async {
          called = true;
          return http.Response('', 200);
        }),
      );

      await tester.enterText(find.byType(TextField).at(0), 'not a url');
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();

      expect(called, isFalse);
      expect(find.textContaining('https://'), findsWidgets);
    });

    testWidgets('the APP_ORIGIN warning takes a second, deliberate tap', (
      WidgetTester tester,
    ) async {
      int logins = 0;
      await pump(
        tester,
        MockClient((http.Request r) async {
          if (r.url.path == '/healthz') {
            return http.Response('ok', 200, request: r);
          }
          logins++;
          return http.Response('{"token":"tok-123"}', 200, request: r);
        }),
      );

      await fillIn(tester);
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();

      expect(find.textContaining('APP_ORIGIN'), findsOneWidget);
      expect(
        logins,
        0,
        reason: 'the password is not sent until the warning is read',
      );

      await tester.tap(find.text('Sign in anyway'));
      await tester.pumpAndSettle();
      expect(logins, 1);
    });

    testWidgets('editing the server URL invalidates the warning it was about', (
      WidgetTester tester,
    ) async {
      await pump(
        tester,
        MockClient(
          (http.Request r) async => r.url.path == '/healthz'
              ? http.Response('ok', 200, request: r)
              : http.Response('{"token":"tok-123"}', 200, request: r),
        ),
      );

      await fillIn(tester);
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();
      expect(find.text('Sign in anyway'), findsOneWidget);

      await tester.enterText(find.byType(TextField).at(0), 'other.example.com');
      await tester.pumpAndSettle();

      expect(find.text('Sign in'), findsOneWidget);
      expect(find.textContaining('APP_ORIGIN'), findsNothing);
    });

    testWidgets('a rejected sign-in shows the server\'s reason', (
      WidgetTester tester,
    ) async {
      await pump(
        tester,
        MockClient(
          (http.Request r) async => r.url.path == '/healthz'
              ? http.Response(
                  'ok',
                  200,
                  request: r,
                  headers: <String, String>{
                    'access-control-allow-origin': kLoopbackOrigin.origin,
                  },
                )
              : http.Response(
                  '{"error":{"message":"wrong email or password"}}',
                  401,
                  request: r,
                ),
        ),
      );

      await fillIn(tester);
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();

      expect(find.text('wrong email or password'), findsOneWidget);
      expect(keystore, isEmpty);
    });
  });
}
