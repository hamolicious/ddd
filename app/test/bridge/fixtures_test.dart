library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:crypto/crypto.dart';

import 'package:ddd_shell/bridge/auth.dart';
import 'package:ddd_shell/bridge/bridge.dart';
import 'package:ddd_shell/bridge/filesystem.dart';
import 'package:ddd_shell/bridge/folder.dart';
import 'package:ddd_shell/bridge/notifications.dart';
import 'package:ddd_shell/bundle/manifest.dart';
import 'package:ddd_shell/shell/webview_host.dart';
import 'package:ddd_shell/bundle/updater.dart';
import 'package:ddd_shell/config.dart';

const String _dir = 'bridge_fixtures';

Map<String, Object?> _read(String name) =>
    jsonDecode(File('$_dir/$name').readAsStringSync()) as Map<String, Object?>;

List<Object?> _list(Map<String, Object?> json, String key) =>
    (json[key]! as List<Object?>);

List<String> _strings(Map<String, Object?> json, String key) =>
    _list(json, key).cast<String>();

Iterable<({String file, Map<String, Object?> body})> _allCases(
  Map<String, Object?> index,
) sync* {
  for (final String file in _strings(index, 'cases')) {
    for (final Object? entry in _list(_read(file), 'cases')) {
      yield (file: file, body: entry! as Map<String, Object?>);
    }
  }
}

ShellBridge _fullyRegisteredBridge() {
  final ShellBridge bridge = ShellBridge();
  final AuthStore auth = AuthStore();
  final ShellConfig config = ShellConfig(
    serverBaseUrl: Uri.parse('https://ddd.example.com'),
  );
  auth.registerOn(bridge);
  FilesystemCapability(config: config, auth: auth).registerOn(bridge);
  NotificationsCapability().registerOn(bridge);
  FolderCapability().registerOn(bridge);
  bridge.register('boot', 'ok', (Map<String, Object?> _) async => null);
  bridge.register('boot', 'failed', (Map<String, Object?> _) async => null);
  return bridge;
}

void main() {
  final Map<String, Object?> index = _read('index.json');

  group('index.json is what the shell is', () {
    test('the version and the handler name are the ones in config.dart', () {
      expect(index['bridgeVersion'], kBridgeVersion);
      expect(index['handler'], kBridgeHandlerName);
    });

    test('the six error codes are the enum, in the enum order', () {
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
        if (c['malformed'] != true) {
          final Map<String, Object?> req = request! as Map<String, Object?>;
          expect(
            req.keys.toSet().difference(requestKeys.toSet()),
            isEmpty,
            reason: 'unknown request key',
          );
          for (final String required in requestKeys.where(
            (String k) => k != 'params',
          )) {
            expect(req.keys, contains(required));
          }
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
        final String method = (aliases[fn] as String?) ?? fn;
        if (!fn.contains('.')) {
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
          anyOf(contains("'$member', '$method'"), contains('$fn =')),
          reason: '$fn has no JavaScript spelling',
        );
      }
    });

    test('boot has no nested spelling — only bootOk and bootFailed', () {
      final String js = script();
      expect(js, contains('bootOk: function'));
      expect(js, contains('bootFailed: function'));
      expect(js, isNot(contains('boot: boot')));
    });

    test('an unregistered method is not defined on the page', () {
      final String js = ShellBridge().bootstrapScript(
        serverBaseUrl: Uri.parse('https://ddd.example.com'),
        bearerToken: null,
        notificationPermission: kPermissionDefault,
      );
      expect(js, contains('var METHODS = [];'));
      expect(js, contains('if (has(method)) { target[name] = fn; }'));
      expect(js, contains("if (has('notifications.permission'))"));
    });
  });

  group('window_shell.json pins the folder-changed signal', () {
    final Map<String, Object?> folderChanged =
        _read('window_shell.json')['folderChanged']! as Map<String, Object?>;

    test('the event name and the script are the fixture\'s', () {
      expect(kFolderChangedEvent, folderChanged['event']);
      expect(
        folderChangedScript(
          (folderChanged['scriptPaths']! as List<Object?>).cast<String>(),
        ),
        folderChanged['script'],
      );
    });
  });

  group('window_shell.json pins the update-ready signal', () {
    final Map<String, Object?> updateReady =
        _read('window_shell.json')['updateReady']! as Map<String, Object?>;

    test('the shell dispatches exactly the event the page listens for', () {
      expect(kShellUpdateReadyEvent, updateReady['event']);
      expect(
        shellUpdateReadyScript(updateReady['scriptVersion']! as String),
        updateReady['script'],
      );
    });

    test('the bundle version is a literal, never a template', () {
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
        final Object? b64 = v['base64'];
        if (b64 is String) expect(base64Decode(b64), bytes);
      }
    });
  });
}

class _Verbatim implements Exception {
  _Verbatim(this.text);
  final String text;
  @override
  String toString() => text;
}
