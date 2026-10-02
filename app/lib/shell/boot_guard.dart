library;

import '../bundle/manifest.dart';
import '../bundle/store.dart';
import '../config.dart';

enum BootAction {
  firstRun,

  loadBundle,

  loadBundleSafeMode,

  revert,

  recovery,

  needsNewerShell,
}

class BootPlan {
  const BootPlan({
    required this.action,
    required this.state,
    this.version,
    this.reason,
  });

  final BootAction action;

  final BundleState state;

  final String? version;

  final String? reason;

  bool get loadsWebview =>
      action == BootAction.loadBundle ||
      action == BootAction.loadBundleSafeMode;
}

class BootGuard {
  BootGuard(this._store, {this.log});

  final BundleStore _store;

  final void Function(String)? log;

  String? get lastFailureReason => _lastFailureReason;
  String? _lastFailureReason;

  static BundleState promotePending(BundleState state) {
    final String? pending = state.pending;
    if (pending == null) return state;
    if (state.isQuarantined(pending)) {
      return BundleState(
        active: state.active,
        previous: state.previous,
        failedBoots: state.failedBoots,
        quarantined: state.quarantined,
      );
    }
    return state.promoted(pending);
  }

  static BootPlan decide({
    required BundleState state,
    BundleManifest? activeManifest,
    int bridgeVersion = kBridgeVersion,
    int maxFailedBoots = kMaxFailedBoots,
    bool quarantineOnRevert = true,
  }) {
    final String? active = state.active;
    if (active == null) {
      return BootPlan(action: BootAction.firstRun, state: state);
    }

    if (activeManifest != null && !activeManifest.runsOnBridge(bridgeVersion)) {
      final String reason =
          'this bundle needs bridge v${activeManifest.minBridgeVersion}; '
          'this shell implements v$bridgeVersion';
      return state.canRevert
          ? BootPlan(
              action: BootAction.revert,
              state: state.reverted(quarantine: false),
              version: state.previous,
              reason: reason,
            )
          : BootPlan(
              action: BootAction.needsNewerShell,
              state: state,
              reason: reason,
            );
    }

    if (state.failedBoots >= maxFailedBoots) {
      if (!state.canRevert) {
        return BootPlan(
          action: BootAction.recovery,
          state: state,
          version: active,
          reason:
              '$active failed ${state.failedBoots} boots and there is nothing to revert to',
        );
      }
      final BundleState reverted = state.reverted(
        quarantine: quarantineOnRevert,
      );
      return BootPlan(
        action: BootAction.revert,
        state: reverted,
        version: reverted.active,
        reason: '$active failed ${state.failedBoots} boots',
      );
    }

    return BootPlan(
      action: state.failedBoots == 0
          ? BootAction.loadBundle
          : BootAction.loadBundleSafeMode,
      state: state.attemptingBoot(),
      version: active,
    );
  }

  Future<BootPlan> resolve({
    int bridgeVersion = kBridgeVersion,
    int maxFailedBoots = kMaxFailedBoots,
  }) async {
    BundleState state = BootGuard.promotePending(await _store.readState());
    String? firstReason;
    BootPlan plan = await _decide(state, bridgeVersion, maxFailedBoots);

    for (int hop = 0; plan.action == BootAction.revert && hop < 4; hop += 1) {
      log?.call('boot: reverting — ${plan.reason}');
      firstReason ??= plan.reason;
      plan = await _decide(plan.state, bridgeVersion, maxFailedBoots);
    }
    if (plan.action == BootAction.revert) {
      plan = BootPlan(
        action: BootAction.recovery,
        state: plan.state,
        version: plan.state.active,
        reason: firstReason ?? plan.reason,
      );
    } else if (firstReason != null) {
      plan = BootPlan(
        action: plan.action,
        state: plan.state,
        version: plan.version,
        reason: firstReason,
      );
    }

    await _store.writeState(plan.state);
    log?.call(
      'boot: ${plan.action.name} ${plan.version ?? ''} — ${plan.state}',
    );
    return plan;
  }

  Future<BootPlan> _decide(
    BundleState state,
    int bridgeVersion,
    int maxFailedBoots,
  ) async {
    final String? active = state.active;
    if (active == null) {
      return BootGuard.decide(
        state: state,
        bridgeVersion: bridgeVersion,
        maxFailedBoots: maxFailedBoots,
      );
    }

    final BundleManifest? manifest = await _store.readManifest(active);
    final bool installed = _store.isInstalled(active);
    if (!installed || manifest == null) {
      final String reason = installed
          ? '$active has no readable manifest on disk'
          : '$active is missing from disk';
      log?.call('boot: $reason');
      final BundleState escalated = state.copyWith(failedBoots: maxFailedBoots);
      final BootPlan plan = BootGuard.decide(
        state: escalated,
        bridgeVersion: bridgeVersion,
        maxFailedBoots: maxFailedBoots,
        quarantineOnRevert: false,
      );
      return BootPlan(
        action: plan.action,
        state: plan.state,
        version: plan.version,
        reason: reason,
      );
    }

    return BootGuard.decide(
      state: state,
      activeManifest: manifest,
      bridgeVersion: bridgeVersion,
      maxFailedBoots: maxFailedBoots,
    );
  }

  Future<void> bootSucceeded() async {
    _lastFailureReason = null;
    final BundleState state = await _store.readState();
    if (state.failedBoots == 0) return;
    log?.call('boot: ${state.active} reported a successful boot');
    await _store.writeState(state.bootSucceeded());
  }

  Future<void> bootFailed(String reason) async {
    _lastFailureReason = reason;
    final BundleState state = await _store.readState();
    log?.call(
      'boot: ${state.active} failed — $reason '
      '(failedBoots: ${state.failedBoots})',
    );
  }
}
