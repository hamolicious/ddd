/// The loopback bundle server (`BRIDGE.md` §6).
///
/// This is the shell's attack surface: it is an HTTP server on a device where every other
/// app can reach a loopback port, serving the origin that holds the workspace and the
/// bearer token. Four rules make that safe, and all four are tested against a real
/// `HttpServer` over a real socket rather than against a parsed URL — the hardening is in
/// what the socket answers, not in what a helper returns.
///
/// 1. only paths in the **active manifest** are served — not "whatever is on disk";
/// 2. only `Host: 127.0.0.1:<port>` is answered (DNS rebinding);
/// 3. `nosniff` on everything, an explicit `Content-Type`, and `index_csp` on `index.html`;
/// 4. nothing but `GET`/`HEAD`.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:life_manager_shell/bundle/manifest.dart';
import 'package:life_manager_shell/shell/webview_host.dart';

/// A port of its own, so this suite never races the shell's real [kLoopbackPort] or a
/// second test file.
const int _testPort = 41913;

void main() {
  late Directory bundle;
  late BundleManifest manifest;
  late BundleServer server;
  late HttpClient client;

  const Map<String, String> files = <String, String>{
    'index.html': '<!doctype html><title>Life Manager</title>',
    'assets/app-1a2b3c.js': 'console.log("v1")',
    'plugins/shell-ui/1.0.0/frontend/index.mjs':
        'export function activate() {}',
  };
  const String csp = "default-src 'self'; script-src 'self' 'nonce-abc'";

  setUp(() async {
    bundle = await Directory.systemTemp.createTemp('lm-bundle-server-test');
    for (final MapEntry<String, String> entry in files.entries) {
      final File file = File('${bundle.path}/${entry.key}');
      await file.parent.create(recursive: true);
      await file.writeAsString(entry.value, flush: true);
    }
    // On disk but not in the manifest: the bundle's own stored manifest, and a leftover
    // from a previous version. Neither may be reachable.
    await File('${bundle.path}/manifest.json').writeAsString('{"secret":true}');
    await File('${bundle.path}/leftover.txt').writeAsString('stale');

    manifest = BundleManifest.fromJson(<String, Object?>{
      'bundle_version':
          'b1f3c0de00000000000000000000000000000000000000000000000000000000',
      'min_bridge_version': 1,
      'index_csp': csp,
      'files': files.entries
          .map(
            (MapEntry<String, String> entry) => <String, Object?>{
              'path': entry.key,
              'sha256': sha256Hex(utf8.encode(entry.value)),
              'size': utf8.encode(entry.value).length,
            },
          )
          .toList(),
    });

    server = BundleServer(
      directory: bundle,
      manifest: manifest,
      port: _testPort,
    );
    await server.start();
    client = HttpClient();
  });

  tearDown(() async {
    client.close(force: true);
    await server.stop();
    if (bundle.existsSync()) await bundle.delete(recursive: true);
  });

  Future<HttpClientResponse> get(
    String path, {
    String? host,
    String method = 'GET',
    Map<String, String> headers = const <String, String>{},
  }) async {
    final HttpClientRequest request = await client.openUrl(
      method,
      Uri.parse('http://127.0.0.1:$_testPort$path'),
    );
    if (host != null) request.headers.set(HttpHeaders.hostHeader, host);
    headers.forEach(request.headers.set);
    return request.close();
  }

  group('the allowlist', () {
    test('serves a file the manifest names', () async {
      final HttpClientResponse response = await get('/assets/app-1a2b3c.js');

      expect(response.statusCode, HttpStatus.ok);
      expect(
        await response.transform(utf8.decoder).join(),
        'console.log("v1")',
      );
    });

    test('`/` is index.html', () async {
      final HttpClientResponse response = await get('/');

      expect(response.statusCode, HttpStatus.ok);
      expect(
        await response.transform(utf8.decoder).join(),
        files['index.html'],
      );
    });

    test('a file on disk but not in the manifest is a 404', () async {
      // The bundle's own manifest lives in this directory; a "serve whatever is here"
      // server would hand out `min_bridge_version` and every file hash on request.
      expect((await get('/manifest.json')).statusCode, HttpStatus.notFound);
      expect((await get('/leftover.txt')).statusCode, HttpStatus.notFound);
    });

    test('traversal cannot reach outside the bundle directory', () async {
      for (final String path in <String>[
        '/../manifest.json',
        '/assets/../../manifest.json',
        '/%2e%2e/manifest.json',
      ]) {
        expect((await get(path)).statusCode, HttpStatus.notFound, reason: path);
      }
    });

    test('a file that changed underneath the bundle is refused', () async {
      // The bundle was verified byte for byte before promotion, so a size that no longer
      // matches is a file nobody hashed.
      await File('${bundle.path}/assets/app-1a2b3c.js')
          .writeAsString('console.log("tampered with")', flush: true);

      expect(
        (await get('/assets/app-1a2b3c.js')).statusCode,
        HttpStatus.notFound,
      );
    });

    test('there is no SPA fallback — the allowlist is the hardening', () async {
      // The `router` plugin routes on `location.hash`, so no in-app URL ever reaches the
      // server as a path; answering unknown paths with `index.html` would only widen what
      // is reachable.
      expect((await get('/doc/01J')).statusCode, HttpStatus.notFound);
    });
  });

  group('hardening', () {
    test('a foreign Host is refused (DNS rebinding)', () async {
      // A page anywhere can point a name it controls at 127.0.0.1; the browser then sends
      // that name as `Host`. Exact match, port included, and nothing else is answered.
      final HttpClientResponse response = await get(
        '/index.html',
        host: 'evil.example',
      );

      expect(response.statusCode, HttpStatus.misdirectedRequest);
      expect(await response.transform(utf8.decoder).join(), isEmpty);
    });

    test('`localhost:<port>` is not the origin either', () async {
      // Origin-keyed storage is keyed on the *host string*: serving both spellings would
      // hand the app two workspaces.
      expect(
        (await get('/index.html', host: 'localhost:$_testPort')).statusCode,
        HttpStatus.misdirectedRequest,
      );
    });

    test('anything but GET or HEAD is refused', () async {
      for (final String method in <String>['POST', 'PUT', 'DELETE']) {
        expect(
          (await get('/index.html', method: method)).statusCode,
          HttpStatus.methodNotAllowed,
          reason: method,
        );
      }
    });

    test('nosniff and an explicit type on everything', () async {
      final HttpClientResponse js = await get('/assets/app-1a2b3c.js');
      final HttpClientResponse mjs = await get(
        '/plugins/shell-ui/1.0.0/frontend/index.mjs',
      );

      expect(js.headers.value('x-content-type-options'), 'nosniff');
      expect(js.headers.contentType?.mimeType, 'text/javascript');
      expect(mjs.headers.contentType?.mimeType, 'text/javascript');
      await js.drain<void>();
      await mjs.drain<void>();
    });

    test(
      'index.html carries the manifest\'s CSP, and nothing else does',
      () async {
        // The nonce in that policy matches the inline import map in those exact bytes
        // (`BRIDGE.md` §5), which is why the manifest carries the policy and the shell does
        // not compose one.
        final HttpClientResponse index = await get('/index.html');
        final HttpClientResponse asset = await get('/assets/app-1a2b3c.js');

        expect(index.headers.value('content-security-policy'), csp);
        expect(asset.headers.value('content-security-policy'), isNull);
        await index.drain<void>();
        await asset.drain<void>();
      },
    );
  });

  group('caching', () {
    test('the manifest hash is the ETag, and a match is a 304', () async {
      final String etag =
          '"${manifest.files.firstWhere((BundleFile f) => f.path == 'index.html').sha256}"';

      final HttpClientResponse first = await get('/index.html');
      expect(first.headers.value(HttpHeaders.etagHeader), etag);
      expect(first.headers.value(HttpHeaders.cacheControlHeader), 'no-cache');
      await first.drain<void>();

      // `no-cache`, not `no-store`: with an exact validator a revalidation is one 304 on a
      // loopback socket, and the webview keeps its compiled JavaScript across the boot
      // attempts of the revert state machine.
      final HttpClientResponse second = await get(
        '/index.html',
        headers: <String, String>{HttpHeaders.ifNoneMatchHeader: etag},
      );
      expect(second.statusCode, HttpStatus.notModified);
      await second.drain<void>();
    });

    test('HEAD answers with the length and no body', () async {
      final HttpClientResponse response = await get(
        '/index.html',
        method: 'HEAD',
      );

      expect(response.statusCode, HttpStatus.ok);
      expect(response.headers.contentLength, files['index.html']!.length);
      expect(await response.transform(utf8.decoder).join(), isEmpty);
    });
  });

  group('the origin', () {
    test('binds loopback only, and never the wildcard address', () async {
      // Every app on the device can reach a loopback port; nothing off the device may
      // reach this one.
      final List<NetworkInterface> interfaces = await NetworkInterface.list(
        includeLoopback: false,
      );
      for (final NetworkInterface interface in interfaces) {
        for (final InternetAddress address in interface.addresses) {
          if (address.type != InternetAddressType.IPv4) continue;
          await expectLater(
            Socket.connect(
              address,
              _testPort,
              timeout: const Duration(seconds: 1),
            ),
            throwsA(isA<SocketException>()),
            reason: '${address.address} must not reach the bundle server',
          );
        }
      }
    });

    test('indexUrl is the document the webview is pointed at', () {
      expect(
        server.indexUrl,
        Uri.parse('http://127.0.0.1:$_testPort/index.html'),
      );
      expect(server.allowedHosts, <String>{'127.0.0.1:$_testPort'});
      expect(server.isRunning, isTrue);
    });

    test('stop() releases the port, so the next launch can bind it', () async {
      await server.stop();

      expect(server.isRunning, isFalse);
      final ServerSocket socket = await ServerSocket.bind(
        InternetAddress.loopbackIPv4,
        _testPort,
      );
      await socket.close();
    });
  });

  group('requestedPath', () {
    test('canonicalizes to one spelling per file', () {
      expect(
        BundleServer.requestedPath(Uri.parse('/index.html')),
        'index.html',
      );
      expect(BundleServer.requestedPath(Uri.parse('/')), 'index.html');
      // Empty segments and `.` are dropped, so one file has one key in the allowlist.
      expect(
        BundleServer.requestedPath(Uri.parse('/assets//app.js')),
        'assets/app.js',
      );
      expect(
        BundleServer.requestedPath(Uri.parse('/./assets/app.js')),
        'assets/app.js',
      );
      // `?safe=1` is the second boot attempt (`BRIDGE.md` §7), not part of the path.
      expect(
        BundleServer.requestedPath(Uri.parse('/index.html?safe=1')),
        'index.html',
      );
    });

    test('a traversal cannot name a file outside the allowlist', () {
      // `Uri.parse` has already removed dot segments by the time this runs, percent-encoded
      // ones included, so a traversal collapses to a plain name — and a plain name is only
      // served when the manifest lists it (the 404s above are the end-to-end proof).
      expect(BundleServer.requestedPath(Uri.parse('/../secret')), 'secret');
      expect(
        BundleServer.requestedPath(Uri.parse('/a/%2e%2e/secret')),
        'secret',
      );
      expect(
        BundleServer.requestedPath(Uri.parse('/a/../../secret')),
        'secret',
      );
    });

    test('a percent-encoded separator cannot smuggle a segment through', () {
      // `/a%2Fb` decodes to the single segment `a/b`; passing that on would build a path
      // with a directory in it that no manifest entry could have declared.
      expect(BundleServer.requestedPath(Uri.parse('/a%2Fb')), '');
    });

    test('a segment that is literally `..` is refused', () {
      // Unreachable through `Uri.parse`, which normalizes first — but `requestedPath` is
      // what builds a filesystem path, so it refuses one itself rather than trusting the
      // parser to have done it.
      expect(
        BundleServer.requestedPath(Uri(pathSegments: <String>['..', 'secret'])),
        '',
      );
    });
  });

  group('contentTypeFor', () {
    test('knows the bundle\'s types and admits the rest', () {
      expect(
        BundleServer.contentTypeFor('index.html'),
        startsWith('text/html'),
      );
      expect(
        BundleServer.contentTypeFor('a/b.mjs'),
        startsWith('text/javascript'),
      );
      expect(BundleServer.contentTypeFor('core_bg.wasm'), 'application/wasm');
      expect(
        BundleServer.contentTypeFor('LICENSE'),
        'application/octet-stream',
      );
    });
  });

  group('isSameOrigin', () {
    test(
      'is scheme, host and port — the whole of "may be a document here"',
      () {
        final Uri origin = Uri.parse('http://127.0.0.1:41847/index.html');

        expect(
          isSameOrigin(Uri.parse('http://127.0.0.1:41847/a.js'), origin),
          isTrue,
        );
        expect(
          isSameOrigin(Uri.parse('http://127.0.0.1:41848/a.js'), origin),
          isFalse,
        );
        expect(
          isSameOrigin(Uri.parse('https://127.0.0.1:41847/a.js'), origin),
          isFalse,
        );
        // The one that matters: a link in a note must not replace the app.
        expect(
          isSameOrigin(Uri.parse('https://example.com/'), origin),
          isFalse,
        );
      },
    );
  });
}
