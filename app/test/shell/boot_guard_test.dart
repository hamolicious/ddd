library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ddd_shell/bundle/manifest.dart';
import 'package:ddd_shell/bundle/store.dart';
import 'package:ddd_shell/shell/boot_guard.dart';

import '../bundle/bundle_fixtures.dart';

const String someSha =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

BundleManifest manifestNeeding(int minBridge) =>
    BundleManifest.fromJson(<String, Object?>{
      'bundle_version': idB,
      'min_bridge_version': minBridge,
      'files': <Map<String, Object?>>[
        <String, Object?>{'path': 'index.html', 'sha256': someSha, 'size': 0},
      ],
    });

void main() {
  group('decide', () {
    test('no bundle at all is the first run', () {
      final BootPlan plan = BootGuard.decide(state: BundleState.empty);

      expect(plan.action, BootAction.firstRun);
    });

    test('a clean state loads the active bundle and counts the attempt', () {
      final BootPlan plan = BootGuard.decide(
        state: const BundleState(active: idB),
      );

      expect(plan.action, BootAction.loadBundle);
      expect(plan.version, idB);
      expect(plan.state.failedBoots, 1);
    });

    test('the second attempt is safe mode, not a revert', () {
      final BootPlan plan = BootGuard.decide(
        state: const BundleState(active: idB, previous: idA, failedBoots: 1),
      );

      expect(plan.action, BootAction.loadBundleSafeMode);
      expect(plan.state.failedBoots, 2);
    });

    test('two failures revert, quarantine and load the previous bundle', () {
      final BootPlan plan = BootGuard.decide(
        state: const BundleState(active: idB, previous: idA, failedBoots: 2),
      );

      expect(plan.action, BootAction.revert);
      expect(plan.version, idA);
      expect(plan.state.active, idA);
      expect(plan.state.quarantined, contains(idB));
      expect(plan.reason, contains('failed 2 boots'));
    });

    test(
      'two failures with nothing to revert to reach the recovery screen',
      () {
        final BootPlan plan = BootGuard.decide(
          state: const BundleState(active: idB, failedBoots: 2),
        );

        expect(plan.action, BootAction.recovery);
        expect(plan.loadsWebview, isFalse);
        expect(plan.state.quarantined, isEmpty);
      },
    );

    test('a bundle needing a newer bridge reverts when it can', () {
      final BootPlan plan = BootGuard.decide(
        state: const BundleState(active: idB, previous: idA),
        activeManifest: manifestNeeding(2),
        bridgeVersion: 1,
      );

      expect(plan.action, BootAction.revert);
      expect(plan.state.active, idA);
      expect(plan.reason, contains('bridge v2'));
    });

    test('… and shows "update the app" when it cannot', () {
      final BootPlan plan = BootGuard.decide(
        state: const BundleState(active: idB),
        activeManifest: manifestNeeding(2),
        bridgeVersion: 1,
      );

      expect(plan.action, BootAction.needsNewerShell);
      expect(
        plan.state.failedBoots,
        0,
        reason: 'the bundle never ran; this is not a failure',
      );
    });

    test('a compatible bundle is not questioned', () {
      final BootPlan plan = BootGuard.decide(
        state: const BundleState(active: idB),
        activeManifest: manifestNeeding(1),
        bridgeVersion: 1,
      );

      expect(plan.action, BootAction.loadBundle);
    });
  });

  group('promotePending', () {
    test('a staged bundle becomes active at the next launch', () {
      final BundleState promoted = BootGuard.promotePending(
        const BundleState(active: idA, pending: idB, failedBoots: 1),
      );

      expect(promoted.active, idB);
      expect(promoted.previous, idA);
      expect(promoted.pending, isNull);
      expect(promoted.failedBoots, 0);
    });

    test('a quarantined pending version is dropped, not promoted', () {
      final BundleState promoted = BootGuard.promotePending(
        const BundleState(
          active: idA,
          pending: idB,
          quarantined: <String>[idB],
        ),
      );

      expect(promoted.active, idA);
      expect(promoted.pending, isNull);
    });

    test('nothing staged changes nothing', () {
      const BundleState state = BundleState(active: idA, failedBoots: 1);

      expect(BootGuard.promotePending(state).toJson(), state.toJson());
    });
  });

  group('resolve', () {
    late Directory root;
    late BundleStore store;
    late BootGuard guard;

    setUp(() {
      root = Directory.systemTemp.createTempSync('ddd-boot');
      store = BundleStore(root);
      guard = BootGuard(store);
    });

    tearDown(() {
      if (root.existsSync()) root.deleteSync(recursive: true);
    });

    test('an empty device is a first run', () async {
      final BootPlan plan = await guard.resolve();

      expect(plan.action, BootAction.firstRun);
    });

    test(
      'a staged bundle is promoted and booted, and the attempt is persisted',
      () async {
        await placeBundle(store, FakeBundle(idA, bundleFiles()));
        await placeBundle(store, FakeBundle(idB, bundleFiles(appChunk: idB)));
        await store.writeState(const BundleState(active: idA, pending: idB));

        final BootPlan plan = await guard.resolve();

        expect(plan.action, BootAction.loadBundle);
        expect(plan.version, idB);
        final BundleState state = await store.readState();
        expect(state.active, idB);
        expect(state.previous, idA);
        expect(state.failedBoots, 1);
        expect(state.pending, isNull);
      },
    );

    test(
      'two launches without a boot.ok revert to the previous bundle',
      () async {
        await placeBundle(store, FakeBundle(idA, bundleFiles()));
        await placeBundle(
          store,
          FakeBundle(idB, bundleFiles(appChunk: 'boom')),
        );
        await store.writeState(const BundleState(active: idB, previous: idA));

        final BootPlan first = await guard.resolve();
        expect(first.action, BootAction.loadBundle);
        expect(first.version, idB);
        expect((await store.readState()).failedBoots, 1);

        final BootPlan second = await guard.resolve();
        expect(second.action, BootAction.loadBundleSafeMode);
        expect(second.version, idB);
        expect((await store.readState()).failedBoots, 2);

        final BootPlan third = await guard.resolve();
        expect(third.action, BootAction.loadBundle);
        expect(third.version, idA);
        expect(third.reason, contains('failed 2 boots'));
        final BundleState state = await store.readState();
        expect(state.active, idA);
        expect(state.quarantined, contains(idB));
        expect(state.previous, isNull);
        expect(state.failedBoots, 1);
      },
    );

    test(
      'boot.ok clears the counter, so the next launch starts fresh',
      () async {
        await placeBundle(store, FakeBundle(idA, bundleFiles()));
        await store.writeState(const BundleState(active: idA));

        await guard.resolve();
        expect((await store.readState()).failedBoots, 1);

        await guard.bootSucceeded();
        expect((await store.readState()).failedBoots, 0);

        expect((await guard.resolve()).action, BootAction.loadBundle);
      },
    );

    test(
      'boot.failed records the reason and does not touch the counter',
      () async {
        await placeBundle(store, FakeBundle(idA, bundleFiles()));
        await store.writeState(const BundleState(active: idA));
        await guard.resolve();

        await guard.bootFailed('the kernel threw before activating any plugin');

        expect((await store.readState()).failedBoots, 1);
        expect(guard.lastFailureReason, contains('the kernel threw'));
      },
    );

    test(
      'two failures with nothing to revert to reach the recovery screen',
      () async {
        await placeBundle(store, FakeBundle(idA, bundleFiles()));
        await store.writeState(const BundleState(active: idA, failedBoots: 2));

        final BootPlan plan = await guard.resolve();

        expect(plan.action, BootAction.recovery);
        expect(plan.loadsWebview, isFalse);
        expect((await store.readState()).quarantined, isEmpty);
      },
    );

    test('a bundle that needs a newer bridge reverts, and says why', () async {
      await placeBundle(store, FakeBundle(idA, bundleFiles()));
      await placeBundle(store, FakeBundle(idB, bundleFiles(), minBridge: 2));
      await store.writeState(const BundleState(active: idB, previous: idA));

      final BootPlan plan = await guard.resolve(bridgeVersion: 1);

      expect(plan.action, BootAction.loadBundle);
      expect(plan.version, idA);
      expect(plan.reason, contains('bridge v2'));
      expect((await store.readState()).quarantined, isEmpty);
    });

    test(
      '… and shows "update the app" when there is nothing to revert to',
      () async {
        await placeBundle(store, FakeBundle(idB, bundleFiles(), minBridge: 2));
        await store.writeState(const BundleState(active: idB));

        final BootPlan plan = await guard.resolve(bridgeVersion: 1);

        expect(plan.action, BootAction.needsNewerShell);
        expect(plan.reason, contains('bridge v2'));
        expect(
          (await store.readState()).failedBoots,
          0,
          reason: 'the bundle never ran; this is not a failed boot',
        );
      },
    );

    test('a pointer at a bundle that is not on disk reverts instead of booting a 404', () async {
      await placeBundle(store, FakeBundle(idA, bundleFiles()));
      await store.writeState(
        const BundleState(active: 'v9-gone', previous: idA),
      );

      final BootPlan plan = await guard.resolve();

      expect(plan.action, BootAction.loadBundle);
      expect(plan.version, idA);
      expect(plan.reason, contains('missing from disk'));
      expect((await store.readState()).quarantined, isEmpty);
    });

    test(
      'an installed bundle with no manifest is treated the same way',
      () async {
        await placeBundle(store, FakeBundle(idA, bundleFiles()));
        await placeBundle(store, FakeBundle(idB, bundleFiles(appChunk: idB)));
        await store.manifestFile(idB).delete();
        await store.writeState(const BundleState(active: idB, previous: idA));

        final BootPlan plan = await guard.resolve();

        expect(plan.action, BootAction.loadBundle);
        expect(plan.version, idA);
        expect(plan.reason, contains('no readable manifest'));
      },
    );

    test('a missing bundle with nowhere to go lands on recovery, never on a first run', () async {
      await store.writeState(const BundleState(active: 'v9-gone'));

      final BootPlan plan = await guard.resolve();

      expect(plan.action, BootAction.recovery);
      expect(plan.reason, contains('missing from disk'));
    });

    test(
      'a quarantined pending version is dropped rather than promoted',
      () async {
        await placeBundle(store, FakeBundle(idA, bundleFiles()));
        await store.writeState(
          const BundleState(
            active: idA,
            pending: idB,
            quarantined: <String>[idB],
          ),
        );

        final BootPlan plan = await guard.resolve();

        expect(plan.version, idA);
        expect((await store.readState()).pending, isNull);
      },
    );
  });
}
