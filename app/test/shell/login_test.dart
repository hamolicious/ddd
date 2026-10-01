/// The native login screen (`BRIDGE.md` §4.1, SPEC §5.2).
///
/// Login is the one thing the shell does before it has a bundle, so every failure here is
/// a failure with nothing to show it in. Three behaviours carry that weight and are worth
/// pinning:
///
/// * **`token: true`, and a 200 without a token is a failure** — not a fall-through to the
///   cookie the server also set. The webview is a different origin (`BRIDGE.md` §6), so
///   there is no cookie jar worth having.
/// * **The server URL is stored only on success**, so a typo never becomes the remembered
///   server.
/// * **The `APP_ORIGIN` pre-flight**, which is the single most likely cause of "signed in,
///   never syncs" (`BRIDGE.md` §6) and the one thing an operator can act on if they are
///   told about it while they are still looking at it.
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

  LoginRequest request([String server = 'https://life.example.com']) =>
      LoginRequest(
        serverBaseUrl: Uri.parse(server),
        email: 'a@b.co',
        password: 'hunter2',
      );

  group('normalizeServerUrl', () {
    test('a bare host gets https, never http', () {
      // The bearer token travels on every request (SPEC §5.2); guessing cleartext for
      // someone is not the shell's decision to make.
      expect(
        normalizeServerUrl('life.example.com'),
        Uri.parse('https://life.example.com'),
      );
    });

    test('reduces everything to an origin', () {
      // `ShellConfig.api()` resolves against this and `APP_ORIGIN` compares it; a
      // remembered path would quietly produce `/app/api/…`.
      for (final String typed in <String>[
        '  https://life.example.com/  ',
        'https://life.example.com/app',
        'https://life.example.com/app?x=1#y',
      ]) {
        expect(
          normalizeServerUrl(typed),
          Uri.parse('https://life.example.com'),
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
      expect(normalizeServerUrl('ftp://life.example.com'), isNull);
      expect(normalizeServerUrl('https://'), isNull);
      // `Uri.tryParse` would percent-escape this into `https://not%20a%20url` and report
      // the result as "could not reach", which reads like a server outage, not a typo.
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
        Uri.parse('https://life.example.com/api/auth/login'),
      );
      expect(jsonDecode(request().body), <String, Object?>{
        'email': 'a@b.co',
        'password': 'hunter2',
        // The server accepts `token` as an alias of `bearer` (`routes/auth.rs`).
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
      expect(keystore[kServerKey], 'https://life.example.com');
      // The CORS layer answers this the way it will answer the webview.
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
        // A typo must never become the remembered server.
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
        ).preflight(Uri.parse('https://life.example.com'));

        expect(check.isHealthy, isTrue);
        expect(check.detail, isNull);
      },
    );

    test('a missing APP_ORIGIN is a warning with a fix in it', () async {
      // Signing in will work and syncing will not; an operator who is told this while they
      // are still looking at the server can fix it in one restart.
      final Preflight check = await service(healthz())
          .preflight(Uri.parse('https://life.example.com'));

      expect(check.reachable, isTrue);
      expect(check.originAllowed, isFalse);
      expect(check.detail, contains('APP_ORIGIN'));
      expect(check.detail, contains(kLoopbackOrigin.origin));
    });

    test('a different origin echoed back is not this shell\'s', () async {
      final Preflight check = await service(
        healthz(
          headers: <String, String>{
            'access-control-allow-origin': 'https://life.example.com',
          },
        ),
      ).preflight(Uri.parse('https://life.example.com'));

      expect(check.originAllowed, isFalse);
    });

    test('something that is not a ddd server says so', () async {
      final Preflight check = await service(
        healthz(status: 404, body: 'Not Found'),
      ).preflight(Uri.parse('https://life.example.com'));

      expect(check.reachable, isFalse);
      // A reverse proxy in front of a different app looks exactly like this.
      expect(check.detail, contains('/healthz'));
    });

    test('a 200 whose body is not `ok` is not a ddd server either', () async {
      final Preflight check = await service(
        healthz(body: '<html>welcome</html>'),
      ).preflight(Uri.parse('https://life.example.com'));

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
        ).preflight(Uri.parse('https://life.example.com'));

        expect(check.reachable, isFalse);
        expect(check.originAllowed, isFalse);
        expect(check.detail, contains('No route to host'));
      },
    );

    test('reachable() is preflight()\'s first half', () async {
      expect(
        await service(healthz())
            .reachable(Uri.parse('https://life.example.com')),
        isTrue,
      );
      expect(
        await service(healthz(status: 500))
            .reachable(Uri.parse('https://life.example.com')),
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
      String server = 'life.example.com',
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

      expect(server, Uri.parse('https://life.example.com'));
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
            // Healthy, but no `Access-Control-Allow-Origin` for the shell.
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

      // Without this, "Sign in anyway" would carry over to a different server and skip its
      // pre-flight entirely.
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
