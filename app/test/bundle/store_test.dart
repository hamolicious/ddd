/// The pointer's pure transitions (`BRIDGE.md` §7).
///
/// [BundleState] is data with transitions precisely so the revert policy can be tested
/// without a filesystem, a webview or a server. The invariant these tests pin down:
/// **the shell never ends up pointing at a bundle that has already failed twice.**
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
      // The new bundle gets its own two attempts.
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
      // Reverting *to* something that just failed twice is not a recovery path.
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
        // The reverts that are not the bundle's fault: a shell too old for its
        // `min_bridge_version`, a bundle directory that went missing under the pointer. A
        // quarantine is permanent and only the user's own "Download the app again" clears
        // it, so condemning a bundle that never got to run pins the device to an older one
        // forever — `BundleUpdater.update` checks `quarantined` before the bridge gate, so
        // even installing a newer APK does not undo it.
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
      // `bundle_version` is a content hash, so this list only ever grows, and it is
      // rewritten into `state.json` on every launch. Ten is more history than any
      // decision reads.
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

  /// The IO half: the pointer file, the swap, and reclaiming disk. A real temp directory,
  /// because every one of these is about what survives a crash and a filesystem is the only
  /// honest fake for that.
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

      // Half a write — the shape a crash would leave if the file were edited in place
      // instead of renamed over.
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

        // The copy that was just verified wins over the one that was merely already there.
        expect(
          store.fileIn(idA, 'assets/app-1a2b3c.js').readAsStringSync(),
          'fresh',
        );
        // …and nothing is left behind: the old directory is renamed aside rather than
        // deleted, so there is no instant at which the version exists nowhere. That
        // matters because the destination is not always a spare copy — roll a deploy back
        // and the server republishes the bundle this device holds as `previous`, i.e. its
        // revert target. A process death inside a delete-then-rename window would leave
        // `state.json` naming a directory that is gone, and the failure only surfaces much
        // later as a revert that lands on the recovery screen.
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
        // The guard runs before the old directory is moved aside, so a caller that asks for
        // a version it never downloaded cannot cost the device the copy it has.
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

      // An installed bundle whose manifest was lost is *not* a bundle that can be served:
      // the loopback server needs the path allowlist and the CSP out of it.
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
        // `.staging` goes wholesale, which is why prune runs before a background update and
        // never beside one (`store.dart`).
        expect(store.stagingDir('v5').existsSync(), isFalse);
        // The pointer is not collateral damage.
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
