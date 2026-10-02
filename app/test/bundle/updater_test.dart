library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ddd_shell/bundle/manifest.dart';
import 'package:ddd_shell/bundle/store.dart';
import 'package:ddd_shell/bundle/updater.dart';
import 'package:ddd_shell/config.dart';
import 'package:ddd_shell/shell/boot_guard.dart';

import 'bundle_fixtures.dart';

void main() {
  late Directory root;
  late BundleStore store;
  late FakeHttp http;
  late FakeAuth auth;
  late List<String> log;
  late BundleUpdater updater;

  BundleUpdater updaterWith({int bridgeVersion = kBridgeVersion}) =>
      BundleUpdater(
        config: ShellConfig(serverBaseUrl: testServer),
        store: store,
        auth: auth,
        client: http,
        bridgeVersion: bridgeVersion,
        log: log.add,
      );

  setUp(() {
    root = Directory.systemTemp.createTempSync('ddd-bundles');
    store = BundleStore(root);
    http = FakeHttp();
    auth = FakeAuth();
    log = <String>[];
    updater = updaterWith();
  });

  tearDown(() {
    if (root.existsSync()) root.deleteSync(recursive: true);
  });

  String logText() => log.join('\n');

  group('a fresh install', () {
    test(
      'downloads every file, verifies it and stages it for the next launch',
      () async {
        final FakeBundle v1 = FakeBundle(idA, bundleFiles());
        http.publish(v1);

        final List<UpdateProgress> progress = <UpdateProgress>[];
        final UpdateOutcome outcome = await updater.update(
          onProgress: progress.add,
        );

        expect(outcome, UpdateOutcome.staged, reason: logText());

        final BundleState state = await store.readState();
        expect(state.pending, idA);
        expect(state.active, isNull);

        for (final MapEntry<String, String> entry in v1.files.entries) {
          expect(
            store.fileIn(idA, entry.key).readAsStringSync(),
            entry.value,
            reason: entry.key,
          );
        }
        expect(store.stagingDir(idA).existsSync(), isFalse);

        final BundleManifest? stored = await store.readManifest(idA);
        expect(stored, isNotNull);
        expect(stored!.bundleVersion, idA);
        expect(stored.indexCsp, "default-src 'self'");
        expect(stored.files.length, v1.files.length);

        expect(progress.first.filesDone, 0);
        expect(progress.last.filesDone, v1.files.length);
        expect(progress.last.fraction, 1.0);
      },
    );

    test('authenticates the manifest and the two synthesized files, and nothing else', () async {
      http.publish(FakeBundle(idA, bundleFiles()));

      await updater.update();

      expect(http.bearers, <String>[
        '/api/shell/manifest Bearer test-token',
        '/api/shell/bundle/index.html Bearer test-token',
        '/api/shell/bundle/importmap.json Bearer test-token',
      ]);
    });

    test('a promoted staged bundle is what the next launch boots', () async {
      http.publish(FakeBundle(idA, bundleFiles()));
      await updater.update();

      final BundleState promoted = BootGuard.promotePending(
        await store.readState(),
      );

      expect(promoted.active, idA);
      expect(promoted.pending, isNull);
    });
  });

  group('a delta update', () {
    test('downloads only the files whose hash changed', () async {
      final FakeBundle v1 = FakeBundle(idA, bundleFiles());
      await placeBundle(store, v1);
      await store.writeState(const BundleState(active: idA));

      final Map<String, String> next = bundleFiles(
        appChunk: 'console.log("v2")',
      );
      next['index.html'] = '<!doctype html><title>ddd 2</title>';
      http.publish(FakeBundle(idB, next));
      http.clearLog();

      final UpdateOutcome outcome = await updater.update();

      expect(outcome, UpdateOutcome.staged, reason: logText());
      expect(http.downloads, <String>[
        '/api/shell/bundle/index.html',
        '/assets/app-1a2b3c.js',
      ]);
      expect(
        store
            .fileIn(idB, 'plugins/shell-ui/1.0.0/frontend/index.mjs')
            .existsSync(),
        isTrue,
      );
      expect(
        store.fileIn(idB, 'importmap.json').readAsStringSync(),
        next['importmap.json'],
      );
    });

    test(
      'reuses the previous bundle too, so a re-update after a revert is cheap',
      () async {
        final FakeBundle v1 = FakeBundle(idA, bundleFiles());
        final FakeBundle v2 = FakeBundle(
          idB,
          bundleFiles(appChunk: 'console.log("v2")'),
        );
        await placeBundle(store, v1);
        await placeBundle(store, v2);
        await store.writeState(const BundleState(active: idA, previous: idB));

        http.publish(
          FakeBundle(idC, bundleFiles(appChunk: 'console.log("v2")')),
        );
        http.clearLog();

        expect(await updater.update(), UpdateOutcome.staged, reason: logText());
        expect(http.downloads, isEmpty);
      },
    );

    test(
      'a file whose bytes changed under the same path is never reused',
      () async {
        final FakeBundle v1 = FakeBundle(idA, bundleFiles());
        await placeBundle(store, v1);
        await store.writeState(const BundleState(active: idA));

        final Map<String, String> next = bundleFiles();
        next['runtime/react.js'] = 'export default { version: 19 }';
        http.publish(FakeBundle(idB, next));
        http.clearLog();

        expect(await updater.update(), UpdateOutcome.staged, reason: logText());
        expect(http.downloads, contains('/runtime/react.js'));
        expect(
          store.fileIn(idB, 'runtime/react.js').readAsStringSync(),
          'export default { version: 19 }',
        );
      },
    );

    test('nothing to do is one request and no writes', () async {
      await placeBundle(store, FakeBundle(idA, bundleFiles()));
      await store.writeState(const BundleState(active: idA));
      http.publish(FakeBundle(idA, bundleFiles()));
      http.clearLog();

      expect(await updater.update(), UpdateOutcome.upToDate);
      expect(http.downloads, isEmpty);
    });
  });

  group('verification', () {
    test(
      'a file whose sha256 does not match rejects the whole bundle',
      () async {
        final FakeBundle v1 = FakeBundle(idA, bundleFiles());
        http.publish(v1);
        http.replies['/assets/app-1a2b3c.js'] = FakeReply.text(
          'console.log("XX")',
        );

        final UpdateOutcome outcome = await updater.update();

        expect(outcome, UpdateOutcome.corrupt);
        expect(logText(), contains('sha256'));
        expect(store.isInstalled(idA), isFalse);
        expect(store.stagingDir(idA).existsSync(), isFalse);
        expect((await store.readState()).pending, isNull);
      },
    );

    test(
      'a truncated file is rejected by size, with a message that says so',
      () async {
        http.publish(FakeBundle(idA, bundleFiles()));
        http.replies['/runtime/react.js'] = FakeReply.text('export');

        expect(await updater.update(), UpdateOutcome.corrupt);
        expect(logText(), contains('expected'));
        expect(logText(), contains('bytes, got'));
        expect(store.isInstalled(idA), isFalse);
      },
    );

    test(
      'an oversize response is cut off rather than written to the end',
      () async {
        http.publish(FakeBundle(idA, bundleFiles()));
        http.replies['/runtime/react.js'] = FakeReply.text('x' * 5000);

        expect(await updater.update(), UpdateOutcome.corrupt);
        expect(logText(), contains('longer than the manifest'));
        expect(store.stagingDir(idA).existsSync(), isFalse);
      },
    );

    test('a manifest claiming more than the cap is refused before anything is fetched', () async {
      final FakeBundle v1 = FakeBundle(idA, bundleFiles());
      final Map<String, Object?> json = v1.manifestJson();
      final List<Object?> files = json['files']! as List<Object?>;
      (files.first as Map<String, Object?>)['size'] = kMaxBundleBytes + 1;
      http.replies['/api/shell/manifest'] = FakeReply.json(json);
      http.clearLog();

      expect(await updater.update(), UpdateOutcome.corrupt);
      expect(http.downloads, isEmpty);
      expect(logText(), contains('over the'));
    });

    test('a 404 for one file rejects the bundle', () async {
      http.publish(FakeBundle(idA, bundleFiles()));
      http.replies.remove('/runtime/react.js');

      expect(await updater.update(), UpdateOutcome.corrupt);
      expect(logText(), contains('404'));
    });

    test('a manifest that lists the same path twice is refused', () async {
      final FakeBundle v1 = FakeBundle(idA, bundleFiles());
      final Map<String, Object?> json = v1.manifestJson();
      final List<Object?> files = json['files']! as List<Object?>;
      files.add(files.first);
      http.replies['/api/shell/manifest'] = FakeReply.json(json);

      expect(await updater.update(), UpdateOutcome.corrupt);
      expect(logText(), contains('twice'));
    });

    test(
      'a manifest that claims the shell\'s own metadata path is refused',
      () async {
        final FakeBundle v1 = FakeBundle(idA, <String, String>{
          ...bundleFiles(),
          kBundleManifestFile: '{"bundle_version":"evil"}',
        });
        http.publish(v1);

        expect(await updater.update(), UpdateOutcome.corrupt);
        expect(logText(), contains('reserved'));
      },
    );

    test('an unreachable or unparseable manifest changes nothing', () async {
      await placeBundle(store, FakeBundle(idA, bundleFiles()));
      await store.writeState(const BundleState(active: idA));

      expect(await updater.update(), UpdateOutcome.unavailable);
      http.replies['/api/shell/manifest'] = FakeReply.text(
        '<html>Sign in</html>',
      );
      expect(await updater.update(), UpdateOutcome.unavailable);
      http.replies['/api/shell/manifest'] = FakeReply.text('{}', status: 401);
      expect(await updater.update(), UpdateOutcome.unavailable);

      expect((await store.readState()).active, idA);
      expect((await store.readState()).pending, isNull);
    });

    test('no token means no check at all', () async {
      auth.value = null;
      http.publish(FakeBundle(idA, bundleFiles()));

      expect(await updater.update(), UpdateOutcome.unavailable);
      expect(http.requested, isEmpty);
    });
  });

  group('an interrupted download', () {
    test(
      'resumes: files an earlier run finished are not fetched again',
      () async {
        final FakeBundle v1 = FakeBundle(idA, bundleFiles());
        http.publish(v1);
        http.failAfter = 3;

        expect(await updater.update(), UpdateOutcome.corrupt);
        expect(store.stagingDir(idA).existsSync(), isFalse);

        final Directory staging = store.stagingDir(idA);
        for (final String path in <String>[
          'index.html',
          'plugins/shell-ui/1.0.0/frontend/index.mjs',
        ]) {
          final File file = File('${staging.path}/$path');
          await file.parent.create(recursive: true);
          await file.writeAsString(v1.files[path]!, flush: true);
        }
        http.failAfter = null;
        http.clearLog();

        expect(await updater.update(), UpdateOutcome.staged, reason: logText());
        expect(http.downloads, isNot(contains('/api/shell/bundle/index.html')));
        expect(
          http.downloads,
          isNot(contains('/plugins/shell-ui/1.0.0/frontend/index.mjs')),
        );
        expect(http.downloads, contains('/runtime/react.js'));
      },
    );

    test('restarts a half-written file instead of trusting it', () async {
      final FakeBundle v1 = FakeBundle(idA, bundleFiles());
      http.publish(v1);

      final Directory staging = store.stagingDir(idA);
      await staging.create(recursive: true);
      await File('${staging.path}/index.html')
          .writeAsString('<!doctype html><ti');
      await Directory('${staging.path}/runtime').create(recursive: true);
      await File('${staging.path}/runtime/react.js.part').writeAsString('expo');
      http.clearLog();

      expect(await updater.update(), UpdateOutcome.staged, reason: logText());
      expect(http.downloads, contains('/api/shell/bundle/index.html'));
      expect(
        store.fileIn(idA, 'index.html').readAsStringSync(),
        v1.files['index.html'],
      );
      expect(
        File('${store.dirFor(idA).path}/runtime/react.js.part').existsSync(),
        isFalse,
      );
    });

    test('a staged file that was tampered with after its own check is caught before the swap', () async {
      final FakeBundle v1 = FakeBundle(idA, bundleFiles());
      final Directory staging = store.stagingDir(idA);
      await staging.create(recursive: true);
      for (final MapEntry<String, String> entry in v1.files.entries) {
        final File file = File('${staging.path}/${entry.key}');
        await file.parent.create(recursive: true);
        await file.writeAsString(entry.value, flush: true);
      }
      await File('${staging.path}/runtime/react.js')
          .writeAsString('export default 0');

      final VerificationResult result = await updater.verifyStaged(v1.manifest);

      expect(result.isValid, isFalse);
      expect(result.checked, v1.files.length);
      expect(result.problems.single, contains('runtime/react.js'));
    });
  });

  group('the bearer token', () {
    test('is never carried through a redirect', () async {
      http.publish(FakeBundle(idA, bundleFiles()));

      expect(await updater.update(), UpdateOutcome.staged, reason: logText());

      expect(http.followRedirects['/api/shell/manifest'], isFalse);
      expect(http.followRedirects['/api/shell/bundle/index.html'], isFalse);
      expect(http.followRedirects['/assets/app-1a2b3c.js'], isFalse);
      expect(
        http.followRedirects.values.every((bool follows) => !follows),
        isTrue,
      );
    });

    test('a redirected manifest is unavailable, and says so', () async {
      http.publish(FakeBundle(idA, bundleFiles()));
      http.replies['/api/shell/manifest'] = FakeReply.text('', status: 302);

      expect(await updater.update(), UpdateOutcome.unavailable);
      expect(logText(), contains('302'));
      expect(logText(), contains('redirect'));
    });
  });

  group('a device that cannot store the update', () {
    test(
      'reports storageFailed rather than throwing out of update()',
      () async {
        final BundleStore failing = _UnwritableStore(root);
        final BundleUpdater broken = BundleUpdater(
          config: ShellConfig(serverBaseUrl: testServer),
          store: failing,
          auth: auth,
          client: http,
          log: log.add,
        );
        http.publish(FakeBundle(idA, bundleFiles()));

        expect(
          await broken.update(),
          UpdateOutcome.storageFailed,
          reason: logText(),
        );
        expect(failing.isInstalled(idA), isTrue);
      },
    );
  });

  group('the min-bridge gate', () {
    test('a bundle needing a newer bridge is not downloaded at all', () async {
      await placeBundle(store, FakeBundle(idA, bundleFiles()));
      await store.writeState(const BundleState(active: idA));
      http.publish(FakeBundle(idB, bundleFiles(), minBridge: 2));
      http.clearLog();

      expect(await updater.update(), UpdateOutcome.needsNewerShell);
      expect(http.downloads, isEmpty);
      expect((await store.readState()).active, idA);
      expect(logText(), contains('needs bridge v2'));
    });

    test('the same bundle installs on a shell that implements the bridge it asks for', () async {
      http.publish(FakeBundle(idB, bundleFiles(), minBridge: 2));

      expect(
        await updaterWith(bridgeVersion: 2).update(),
        UpdateOutcome.staged,
        reason: logText(),
      );
    });
  });

  group('quarantine', () {
    test(
      'the version that failed twice here is not downloaded again',
      () async {
        await placeBundle(store, FakeBundle(idA, bundleFiles()));
        await store.writeState(
          const BundleState(active: idA, quarantined: <String>[idB]),
        );
        http.publish(FakeBundle(idB, bundleFiles(appChunk: 'boom')));
        http.clearLog();

        expect(await updater.update(), UpdateOutcome.quarantined);
        expect(http.downloads, isEmpty);
      },
    );

    test('a pending version the server has rolled back is dropped', () async {
      await placeBundle(store, FakeBundle(idA, bundleFiles()));
      await store.writeState(const BundleState(active: idA, pending: idB));
      http.publish(FakeBundle(idA, bundleFiles()));

      expect(await updater.update(), UpdateOutcome.upToDate);
      expect((await store.readState()).pending, isNull);
      expect((await store.readState()).active, idA);
    });

    test(
      'an already-staged version is reported staged without re-downloading it',
      () async {
        final FakeBundle v2 = FakeBundle(idB, bundleFiles());
        await placeBundle(store, FakeBundle(idA, bundleFiles(appChunk: 'old')));
        await placeBundle(store, v2);
        await store.writeState(const BundleState(active: idA, pending: idB));
        http.publish(v2);
        http.clearLog();

        expect(await updater.update(), UpdateOutcome.staged);
        expect(http.downloads, isEmpty);
      },
    );
  });

  group('fileUrl', () {
    test('sends the synthesized documents to the shell route and the rest to their own', () {
      expect(
        updater.fileUrl('index.html').toString(),
        'https://ddd.test/api/shell/bundle/index.html',
      );
      expect(
        updater.fileUrl('importmap.json').toString(),
        'https://ddd.test/api/shell/bundle/importmap.json',
      );
      expect(
        updater.fileUrl('assets/app-1a2b3c.js').toString(),
        'https://ddd.test/assets/app-1a2b3c.js',
      );
      expect(
        updater.fileUrl('plugins/shell-ui/1.0.0/frontend/index.mjs').toString(),
        'https://ddd.test/plugins/shell-ui/1.0.0/frontend/index.mjs',
      );
    });

    test('a server on a path prefix still resolves to its own origin', () {
      final BundleUpdater onPath = BundleUpdater(
        config: ShellConfig(serverBaseUrl: Uri.parse('https://ddd.test/ddd')),
        store: store,
        auth: auth,
        client: http,
      );

      expect(
        onPath.fileUrl('assets/app.js').toString(),
        'https://ddd.test/assets/app.js',
      );
      onPath.close();
    });
  });
}

class _UnwritableStore extends BundleStore {
  _UnwritableStore(super.root);

  @override
  Future<void> writeState(BundleState state) async =>
      throw const FileSystemException('no space left on device');
}
