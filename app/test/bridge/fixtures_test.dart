/// The Dart half of the shared contract fixtures in `app/bridge_fixtures/`.
///
/// The fixtures exist to stop the two independently-written implementations of one ABI from
/// drifting: the Dart shell that answers the envelope, and the TypeScript kernel that sends
/// it. A fixture only does that job when **both** sides read it. The web side does
/// (`web/kernel/src/runtime/bridge-fixtures.test.ts`); until this file, the Dart side did
/// not, which made the whole set a description of the contract rather than a check on it —
/// exactly the state a contract test is supposed to prevent.
///
/// What this suite deliberately does *not* do is re-test the capabilities. `auth_test.dart`,
/// `filesystem_test.dart` and `notifications_capability_test.dart` already drive real
/// handlers against real ports; repeating that here through the fixtures would double the
/// cost of every behaviour change while catching nothing new. This suite asserts the things
/// only a *shared* file can assert:
///
/// * the constants both sides hard-code (version, handler name, the six error codes) agree
///   with the file, so a rename cannot land on one side alone;
/// * the registered method set is exactly `index.methods` — a method added to the shell and
///   not to the index is invisible to the web suite, and one removed breaks a caller;
/// * every envelope in every case file has the frozen key set, and the shell's own
///   decisions (unknown method, a newer major, the three malformed shapes) produce the
///   frozen responses byte for byte;
/// * `bootstrapScript` defines every JS spelling `window_shell.json` promises and nothing
///   it does not;
/// * the manifest parser accepts the valid fixture, rejects all six invalid ones, and hashes
///   the shared vectors to the same digests the server and the web side do.
///
/// `index.json` names every other file, so nothing here hard-codes the list: adding a case
/// file to the index is enough to bring it into both suites.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:crypto/crypto.dart';

import 'package:life_manager_shell/bridge/auth.dart';
import 'package:life_manager_shell/bridge/bridge.dart';
import 'package:life_manager_shell/bridge/filesystem.dart';
import 'package:life_manager_shell/bridge/notifications.dart';
import 'package:life_manager_shell/bundle/manifest.dart';
import 'package:life_manager_shell/shell/webview_host.dart';
import 'package:life_manager_shell/bundle/updater.dart';
import 'package:life_manager_shell/config.dart';

/// `flutter test` runs with the package root as the working directory, which is what makes
/// this a plain relative path rather than a package resource.
const String _dir = 'bridge_fixtures';

Map<String, Object?> _read(String name) =>
    jsonDecode(File('$_dir/$name').readAsStringSync()) as Map<String, Object?>;

List<Object?> _list(Map<String, Object?> json, String key) =>
    (json[key]! as List<Object?>);

List<String> _strings(Map<String, Object?> json, String key) =>
    _list(json, key).cast<String>();

/// Every `cases` entry of every case file `index.json` names, tagged with its file so a
/// failure says which fixture is wrong.
Iterable<({String file, Map<String, Object?> body})> _allCases(
  Map<String, Object?> index,
) sync* {
  for (final String file in _strings(index, 'cases')) {
    for (final Object? entry in _list(_read(file), 'cases')) {
      yield (file: file, body: entry! as Map<String, Object?>);
    }
  }
}

/// A bridge carrying every capability the shell registers, with the platform-touching
/// constructors left at their defaults: nothing here *calls* a handler, so no port is
/// touched. What is under test is the shape of the registry.
ShellBridge _fullyRegisteredBridge() {
  final ShellBridge bridge = ShellBridge();
  final AuthStore auth = AuthStore();
  final ShellConfig config = ShellConfig(
    serverBaseUrl: Uri.parse('https://life.example.com'),
  );
  auth.registerOn(bridge);
  FilesystemCapability(config: config, auth: auth).registerOn(bridge);
  NotificationsCapability().registerOn(bridge);
  // `boot.*` lives in `main.dart` rather than in a capability class — it is the shell's own
  // pair, not a feature — so it is spelled out here the way `main.dart` spells it.
  bridge.register('boot', 'ok', (Map<String, Object?> _) async => null);
  bridge.register('boot', 'failed', (Map<String, Object?> _) async => null);
  return bridge;
}

void main() {
  final Map<String, Object?> index = _read('index.json');

  group('index.json is what the shell is', () {
    test('the version and the handler name are the ones in config.dart', () {
      // A handler-name change is silent and total: the injected script calls one name and
      // the native side listens on another, so every bridge call hangs.
      expect(index['bridgeVersion'], kBridgeVersion);
      expect(index['handler'], kBridgeHandlerName);
    });

    test('the six error codes are the enum, in the enum order', () {
      // Codes are what the web side branches on (`cancelled` is not an error to report,
      // `denied` is). A seventh code that only one side knows degrades to `failed`.
      expect(
        _strings(index, 'errorCodes'),
        BridgeErrorCode.values
            .map((BridgeErrorCode c) => c.wire)
            .toList(growable: false),
      );
    });

    test('the registered methods are exactly index.methods', () {
      expect(_fullyRegisteredBridge().methods, _strings(index, 'methods'));
    });

    test('the capabilities are exactly index.capabilities', () {
      expect(
        _fullyRegisteredBridge().capabilities,
        _strings(index, 'capabilities'),
      );
    });

    test('every case file names a capability that exists', () {
      for (final String file in _strings(index, 'cases')) {
        final Map<String, Object?> body = _read(file);
        final Object? capability = body['capability'];
        // `envelope.json` is about the envelope rather than one capability.
        if (capability == null) continue;
        expect(
          _strings(index, 'capabilities'),
          contains(capability),
          reason: '$file declares an unknown capability',
        );
      }
    });

    test('every jsAlias points at a registered method', () {
      final List<String> methods = _strings(index, 'methods');
      final Map<String, Object?> aliases =
          index['jsAliases']! as Map<String, Object?>;
      for (final MapEntry<String, Object?> alias in aliases.entries) {
        expect(
          methods,
          contains(alias.value),
          reason: '${alias.key} aliases a method that does not exist',
        );
      }
    });
  });

  group('every fixture envelope has the frozen key set', () {
    final Map<String, Object?> keys =
        index['envelopeKeys']! as Map<String, Object?>;
    final List<String> requestKeys = (keys['request']! as List<Object?>)
        .cast<String>();
    final List<String> responseKeys = (keys['response']! as List<Object?>)
        .cast<String>();
    final List<String> errorKeys = (keys['error']! as List<Object?>)
        .cast<String>();
    final List<String> codes = _strings(index, 'errorCodes');
    final List<String> methods = _strings(index, 'methods');

    for (final ({String file, Map<String, Object?> body}) entry in _allCases(
      index,
    )) {
      final Map<String, Object?> c = entry.body;
      test('${entry.file}: ${c['name']}', () {
        final Object? request = c['request'];
        // Only the deliberately-malformed cases may have a request that is not an object or
        // is missing keys; everything else is a well-formed call.
        if (c['malformed'] != true) {
          final Map<String, Object?> req = request! as Map<String, Object?>;
          expect(
            req.keys.toSet().difference(requestKeys.toSet()),
            isEmpty,
            reason: 'unknown request key',
          );
          // `params` is the one optional member — absent means empty (envelope.json).
          for (final String required in requestKeys.where(
            (String k) => k != 'params',
          )) {
            expect(req.keys, contains(required));
          }
          // …except where the point of the case is a method that does not exist. That is
          // what `unsupported` means, and `envelope.json` has one on purpose: a full-trust
          // plugin can call the handler directly with anything (SPEC §6.1).
          final Map<String, Object?> res =
              c['response']! as Map<String, Object?>;
          final Object? code = res['ok'] == true
              ? null
              : (res['error']! as Map<String, Object?>)['code'];
          if (code != 'unsupported') {
            expect(
              methods,
              contains('${req['capability']}.${req['method']}'),
              reason: 'a case calls a method the index does not list',
            );
          }
        }

        final Map<String, Object?> res = c['response']! as Map<String, Object?>;
        expect(res.keys.toSet().difference(responseKeys.toSet()), isEmpty);
        expect(res['v'], kBridgeVersion);
        expect(res.containsKey('id'), isTrue);
        // `ok` and the payload are mutually exclusive: a response carries a result or an
        // error, never both, or the web side's "did it work" test is ambiguous.
        if (res['ok'] == true) {
          expect(res.containsKey('error'), isFalse);
        } else {
          expect(res['ok'], isFalse);
          expect(res.containsKey('result'), isFalse);
          final Map<String, Object?> error =
              res['error']! as Map<String, Object?>;
          expect(error.keys.toSet(), errorKeys.toSet());
          expect(codes, contains(error['code']));
          expect(error['message'], isA<String>());
        }
      });
    }
  });

  group('the shell answers envelope.json exactly', () {
    /// The cases whose answer the bridge decides entirely by itself — no handler, no
    /// capability, no platform. Those are the ones a fixture can pin verbatim.
    Future<Map<String, Object?>> answer(Object? request) =>
        _fullyRegisteredBridge().dispatch(request);

    Map<String, Object?> caseNamed(String name) =>
        (_list(_read('envelope.json'), 'cases').cast<Map<String, Object?>>())
            .firstWhere((Map<String, Object?> c) => c['name'] == name);

    for (final String name in <String>[
      'an unknown method',
      'a page speaking a newer bridge major',
      'the envelope is not an object',
      'the envelope is missing its keys',
      'params is not an object',
      'params absent is params empty',
    ]) {
      test(name, () async {
        final Map<String, Object?> c = caseNamed(name);
        expect(await answer(c['request']), c['response']);
      });
    }

    test('a handler bug becomes `failed` carrying its toString', () async {
      // The fixture's message is a `FileSystemException`'s `toString()`. What is frozen is
      // that an unexpected throw is reported rather than swallowed — a dead promise in the
      // page is the failure this prevents — and that the code is `failed`.
      final Map<String, Object?> c = caseNamed('a handler bug');
      final String message =
          ((c['response']! as Map<String, Object?>)['error']!
                  as Map<String, Object?>)['message']!
              as String;
      final ShellBridge bridge = ShellBridge();
      bridge.register(
        'notifications',
        'list',
        (Map<String, Object?> _) async => throw _Verbatim(message),
      );
      expect(await bridge.dispatch(c['request']), c['response']);
    });

    test(
      'a handler that never answers times out at the frozen wording',
      () async {
        final Map<String, Object?> c = caseNamed(
          'a handler that ran out of time',
        );
        // The fixture names 120 s because that is the default; the wait itself is not worth
        // a two-minute test, so the two halves are pinned separately — the default, and the
        // sentence built from it.
        expect(ShellBridge().callTimeout, const Duration(seconds: 120));
        final ShellBridge bridge = ShellBridge(
          callTimeout: const Duration(milliseconds: 1),
        );
        bridge.register(
          'filesystem',
          'pick',
          (Map<String, Object?> _) => Completer<Object?>().future,
        );
        final Map<String, Object?> response = await bridge.dispatch(
          c['request'],
        );
        final Map<String, Object?> expected =
            c['response']! as Map<String, Object?>;
        expect(response['id'], expected['id']);
        expect(response['ok'], false);
        expect((response['error']! as Map<String, Object?>)['code'], 'timeout');
        expect(
          ((expected['error']! as Map<String, Object?>)['message']! as String)
              .replaceAll('120s', '0s'),
          (response['error']! as Map<String, Object?>)['message'],
        );
      },
    );
  });

  group('window_shell.json is what bootstrapScript injects', () {
    final Map<String, Object?> injected =
        _read('window_shell.json')['injected']! as Map<String, Object?>;

    String script() => _fullyRegisteredBridge().bootstrapScript(
      serverBaseUrl: Uri.parse(injected['serverBaseUrl']! as String),
      bearerToken: injected['bearerToken'] as String?,
      notificationPermission: kPermissionDefault,
    );

    test('the scalar members are baked in as the fixture describes', () {
      final String js = script();
      expect(injected['version'], kBridgeVersion);
      expect(injected['bridgeVersion'], kBridgeVersion);
      // Both spellings are injected: `version` is what the first shells published and
      // `bridgeVersion` is what BRIDGE.md §3 froze. Dropping either breaks a bundle that
      // reads only the other.
      expect(js, contains('version: V'));
      expect(js, contains('bridgeVersion: V'));
      expect(js, contains("platform: 'android'"));
      expect(js, contains(jsonEncode(injected['serverBaseUrl'])));
    });

    test('capabilities and methods match the fixture arrays', () {
      expect(
        _fullyRegisteredBridge().capabilities,
        (injected['capabilities']! as List<Object?>).cast<String>(),
      );
      expect(
        _fullyRegisteredBridge().methods,
        (injected['methods']! as List<Object?>).cast<String>(),
      );
    });

    test('every promised JS spelling is defined', () {
      final String js = script();
      final Map<String, Object?> aliases =
          index['jsAliases']! as Map<String, Object?>;
      for (final String fn
          in (injected['functions']! as List<Object?>).cast<String>()) {
        // A member's JS name and the method behind it are not always the same word:
        // `notifications.scheduled` calls `notifications.list`. `index.json` is the map.
        final String method = (aliases[fn] as String?) ?? fn;
        if (!fn.contains('.')) {
          // The flat members are literals on `shell` itself (BRIDGE.md §3).
          expect(
            js,
            contains('$fn: function'),
            reason: '$fn is not a member of window.shell',
          );
          continue;
        }
        final String member = fn.split('.').last;
        expect(
          js,
          anyOf(
            // `define(target, '<member>', '<method>', …)` — guarded by `has(method)` so it
            // exists in the page only when the shell registered it.
            contains("'$member', '$method'"),
            // …or assigned directly, which is how the two synchronous/aliased members go.
            contains('$fn ='),
          ),
          reason: '$fn has no JavaScript spelling',
        );
      }
    });

    test('boot has no nested spelling — only bootOk and bootFailed', () {
      final String js = script();
      expect(js, contains('bootOk: function'));
      expect(js, contains('bootFailed: function'));
      // `boot: boot` would make `window.shell.boot.ok()` work on a shell and nowhere else,
      // which is how a bundle acquires a shell-only dependency by accident (BRIDGE.md §3).
      expect(js, isNot(contains('boot: boot')));
    });

    test('an unregistered method is not defined on the page', () {
      // The shim defines only what exists, so a page feature-detects by member rather than
      // by version (BRIDGE.md §3). The filtering is done *in the page* — the script text is
      // the same either way, and `METHODS` is the list it filters against — so what this
      // pins is that the list is the bridge's and that every definition is guarded by it.
      final String js = ShellBridge().bootstrapScript(
        serverBaseUrl: Uri.parse('https://life.example.com'),
        bearerToken: null,
        notificationPermission: kPermissionDefault,
      );
      expect(js, contains('var METHODS = [];'));
      expect(js, contains('if (has(method)) { target[name] = fn; }'));
      // The one member that is not routed through `define` is guarded by hand; an
      // unguarded assignment would put a method on the page that answers nothing.
      expect(js, contains("if (has('notifications.permission'))"));
    });
  });

  group('window_shell.json pins the update-ready signal', () {
    final Map<String, Object?> updateReady =
        _read('window_shell.json')['updateReady']! as Map<String, Object?>;

    test('the shell dispatches exactly the event the page listens for', () {
      // The web half installed both listeners in M5 and nothing in `app/` ever fired
      // them, so the whole `lm-shell-update-ready` contract was dead on a device while
      // passing its own unit tests. Pinning the string on both sides is what makes that
      // kind of drift a failing test rather than a code review.
      expect(kShellUpdateReadyEvent, updateReady['event']);
      expect(
        shellUpdateReadyScript(updateReady['scriptVersion']! as String),
        updateReady['script'],
      );
    });

    test('the bundle version is a literal, never a template', () {
      // It arrives from the server. Interpolating it into a script is injection.
      expect(
        shellUpdateReadyScript('"); alert(1); //'),
        contains(r'\"); alert(1); //'),
      );
    });
  });

  group('manifest.json parses the same on both sides', () {
    final Map<String, Object?> fixture = _read('manifest.json');

    test('the valid manifest parses with its fields intact', () {
      final Map<String, Object?> valid =
          fixture['valid']! as Map<String, Object?>;
      final BundleManifest manifest = BundleManifest.fromJson(valid);
      expect(manifest.bundleVersion, valid['bundle_version']);
      expect(manifest.minBridgeVersion, valid['min_bridge_version']);
      expect(manifest.indexCsp, valid['index_csp']);
      expect(manifest.files.length, (valid['files']! as List<Object?>).length);
    });

    for (final Object? entry in _list(fixture, 'invalid')) {
      final Map<String, Object?> c = entry! as Map<String, Object?>;
      test('rejected: ${c['name']}', () {
        expect(
          () => BundleManifest.fromJson(c['manifest']! as Map<String, Object?>),
          throwsA(isA<ManifestException>()),
        );
      });
    }

    test('every unsafe path is refused', () {
      for (final String path
          in (fixture['unsafePaths']! as List<Object?>).cast<String>()) {
        expect(
          isSafeBundlePath(path),
          isFalse,
          reason: '"$path" was accepted as a bundle path',
        );
      }
    });

    test('the synthesized pair is the updater\'s', () {
      // The server renders these two per response and the shell must fetch them from
      // `/api/shell/bundle/…` with the bearer token rather than from their public URLs.
      // A disagreement here is a bundle that verifies on neither side.
      expect(
        BundleUpdater.synthesizedPaths,
        (fixture['synthesized']! as List<Object?>).cast<String>(),
      );
    });

    test('the excluded files are absent from the valid manifest', () {
      final List<String> paths =
          ((fixture['valid']! as Map<String, Object?>)['files']!
                  as List<Object?>)
              .cast<Map<String, Object?>>()
              .map((Map<String, Object?> f) => f['path']! as String)
              .toList();
      for (final String excluded
          in (fixture['excluded']! as List<Object?>).cast<String>()) {
        expect(paths, isNot(contains(excluded)));
      }
    });

    test('the shared hash vectors agree', () {
      for (final Object? entry in _list(fixture, 'verify')) {
        final Map<String, Object?> v = entry! as Map<String, Object?>;
        final List<int> bytes = utf8.encode(v['utf8']! as String);
        expect(bytes.length, v['size'], reason: v['name'] as String);
        expect(
          sha256.convert(bytes).toString(),
          v['sha256'],
          reason: v['name'] as String,
        );
        // Where the fixture also carries the base64 spelling, the two must decode to the
        // same bytes — that is the boundary `filesystem.export` crosses.
        final Object? b64 = v['base64'];
        if (b64 is String) expect(base64Decode(b64), bytes);
      }
    });
  });
}

/// An exception whose `toString()` is exactly the text given, so a fixture can pin the
/// message a handler bug surfaces without depending on `dart:io`'s wording.
class _Verbatim implements Exception {
  _Verbatim(this.text);
  final String text;
  @override
  String toString() => text;
}
