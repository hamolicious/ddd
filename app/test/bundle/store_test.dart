library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ddd_shell/bundle/manifest.dart';
import 'package:ddd_shell/bundle/store.dart';

import 'bundle_fixtures.dart';

void main() {
  group('BundleState', () {
    test('round-trips through JSON', () {
      const BundleState state = BundleState(
        active: idB,
        previous: idA,
        pending: idC,
        failedBoots: 1,
        quarantined: <String>['v0'],
      );

      final BundleState parsed = BundleState.fromJson(state.toJson());

      expect(parsed.active, idB);
      expect(parsed.previous, idA);
      expect(parsed.pending, idC);
      expect(parsed.failedBoots, 1);
      expect(parsed.quarantined, <String>['v0']);
    });

    test('an unreadable pointer reads as empty, not as a crash', () {
      final BundleState parsed = BundleState.fromJson(<String, Object?>{
        'active': 7,
      });

      expect(parsed.hasBundle, isFalse);
      expect(parsed.failedBoots, 0);
    });

    test('promoting keeps the outgoing bundle as the revert target', () {
      const BundleState state = BundleState(active: idA, failedBoots: 1);

      final BundleState promoted = state.promoted(idB);

      expect(promoted.active, idB);
      expect(promoted.previous, idA);
      expect(promoted.failedBoots, 0);
    });

    test('reverting swaps back and quarantines the failure', () {
      const BundleState state = BundleState(
        active: idB,
        previous: idA,
        failedBoots: 2,
      );

      final BundleState reverted = state.reverted();

      expect(reverted.active, idA);
      expect(reverted.failedBoots, 0);
      expect(reverted.quarantined, contains(idB));
      expect(reverted.previous, isNull);
      expect(reverted.canRevert, isFalse);
    });

    test('quarantine is idempotent — a version is listed once however often it fails', () {
      const BundleState state = BundleState(
        active: idB,
        previous: idA,
        quarantined: <String>[idB],
      );

      expect(state.reverted().quarantined, <String>[idB]);
    });

    test(
      'reverting without quarantine leaves the version installable again',
      () {
        const BundleState state = BundleState(
          active: idB,
          previous: idA,
          failedBoots: 2,
        );

        final BundleState reverted = state.reverted(quarantine: false);

        expect(reverted.active, idA);
        expect(reverted.failedBoots, 0);
        expect(reverted.quarantined, isEmpty);
        expect(reverted.isQuarantined(idB), isFalse);
      },
    );

    test('the quarantine list is capped, oldest first out', () {
      BundleState state = const BundleState();
      for (int index = 0; index < kMaxQuarantined + 3; index += 1) {
        state = BundleState(
          active: '$index'.padLeft(64, '0'),
          previous: idA,
          quarantined: state.quarantined,
        ).reverted();
      }

      expect(state.quarantined, hasLength(kMaxQuarantined));
      expect(state.quarantined.first, '3'.padLeft(64, '0'));
      expect(state.quarantined.last, '12'.padLeft(64, '0'));
    });

    test('attemptingBoot counts, bootSucceeded clears', () {
      const BundleState state = BundleState(active: idA);

      expect(state.attemptingBoot().failedBoots, 1);
      expect(state.attemptingBoot().attemptingBoot().failedBoots, 2);
      expect(
        state.attemptingBoot().attemptingBoot().bootSucceeded().failedBoots,
        0,
      );
    });

    test('canRevert is false when there is nothing else to go back to', () {
      expect(const BundleState(active: idA).canRevert, isFalse);
      expect(const BundleState(active: idA, previous: idA).canRevert, isFalse);
      expect(const BundleState(active: idB, previous: idA).canRevert, isTrue);
    });
  });

  group('BundleStore', () {
    late Directory root;
    late BundleStore store;

    setUp(() {
      root = Directory.systemTemp.createTempSync('ddd-store');
      store = BundleStore(root);
    });

    tearDown(() {
      if (root.existsSync()) root.deleteSync(recursive: true);
    });

    test('the pointer round-trips, and a corrupt one reads as empty', () async {
      await store.writeState(
        const BundleState(active: idB, previous: idA, failedBoots: 1),
      );

      expect((await store.readState()).active, idB);
      expect((await store.readState()).failedBoots, 1);

      await store.stateFile.writeAsString('{"active": "v2", "fail');

      expect((await store.readState()).hasBundle, isFalse);
    });

    test(
      'install renames a staged bundle into place under its version',
      () async {
        final FakeBundle v1 = FakeBundle(idA, bundleFiles());
        final Directory staging = store.stagingDir(idA);
        for (final MapEntry<String, String> entry in v1.files.entries) {
          final File file = File('${staging.path}/${entry.key}');
          await file.parent.create(recursive: true);
          await file.writeAsString(entry.value, flush: true);
        }
        await store.writeStagedManifest(v1.manifest);

        await store.install(idA);

        expect(store.isInstalled(idA), isTrue);
        expect(staging.existsSync(), isFalse);
        expect(
          store.fileIn(idA, 'index.html').readAsStringSync(),
          v1.files['index.html'],
        );

        final BundleManifest? stored = await store.readManifest(idA);
        expect(stored?.bundleVersion, idA);
        expect(stored?.minBridgeVersion, 1);
      },
    );

    test(
      'install replaces an existing directory for the same version',
      () async {
        await placeBundle(
          store,
          FakeBundle(idA, bundleFiles(appChunk: 'stale')),
        );
        final FakeBundle fresh = FakeBundle(
          idA,
          bundleFiles(appChunk: 'fresh'),
        );
        final Directory staging = store.stagingDir(idA);
        for (final MapEntry<String, String> entry in fresh.files.entries) {
          final File file = File('${staging.path}/${entry.key}');
          await file.parent.create(recursive: true);
          await file.writeAsString(entry.value, flush: true);
        }
        await store.writeStagedManifest(fresh.manifest);

        await store.install(idA);

        expect(
          store.fileIn(idA, 'assets/app-1a2b3c.js').readAsStringSync(),
          'fresh',
        );
        expect(
          Directory('${store.root.path}/$kStagingDirName/.replaced-$idA')
              .existsSync(),
          isFalse,
        );
      },
    );

    test(
      'install refuses a version with nothing staged, and touches nothing',
      () async {
        await placeBundle(
          store,
          FakeBundle(idA, bundleFiles(appChunk: 'kept')),
        );

        await expectLater(store.install(idA), throwsStateError);

        expect(store.isInstalled(idA), isTrue);
        expect(
          store.fileIn(idA, 'assets/app-1a2b3c.js').readAsStringSync(),
          'kept',
        );
      },
    );

    test('install refuses to invent a bundle out of nothing', () async {
      expect(store.install('v9'), throwsStateError);
    });

    test('a missing bundle directory is visible, not assumed away', () async {
      expect(store.isInstalled(idA), isFalse);
      expect(await store.readManifest(idA), isNull);

      await placeBundle(store, FakeBundle(idA, bundleFiles()));
      expect(store.isInstalled(idA), isTrue);

      await store.manifestFile(idA).delete();
      expect(store.isInstalled(idA), isTrue);
      expect(await store.readManifest(idA), isNull);
    });

    test(
      'prune keeps active, previous and pending, and nothing else',
      () async {
        for (final String version in <String>[idA, idB, idC, idD]) {
          await placeBundle(store, FakeBundle(version, bundleFiles()));
        }
        await store.stagingDir('v5').create(recursive: true);
        const BundleState state = BundleState(
          active: idC,
          previous: idB,
          pending: idD,
        );
        await store.writeState(state);

        await store.prune(state);

        expect(store.isInstalled(idA), isFalse);
        expect(store.isInstalled(idB), isTrue);
        expect(store.isInstalled(idC), isTrue);
        expect(store.isInstalled(idD), isTrue);
        expect(store.stagingDir('v5').existsSync(), isFalse);
        expect((await store.readState()).active, idC);
      },
    );

    test('prune on an empty store is a no-op, not a failure', () async {
      await store.prune(BundleState.empty);
      expect(root.existsSync(), isTrue);
    });

    test(
      'discardStaging removes a download and tolerates its absence',
      () async {
        final Directory staging = store.stagingDir(idA);
        await File('${staging.path}/index.html').create(recursive: true);

        await store.discardStaging(idA);
        expect(staging.existsSync(), isFalse);

        await store.discardStaging(idA);
        expect(staging.existsSync(), isFalse);
      },
    );
  });
}
