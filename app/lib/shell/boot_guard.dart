/// The failed-boot counter and the auto-revert decision
/// (SPEC §7: "auto-reverts after two failed boots"; `BRIDGE.md` §7 has the state machine).
///
/// The problem this solves: the shell's own code is fine, but the *bundle* it downloaded
/// may not be — a bad plugin, a broken chunk, a kernel that throws before it can render
/// anything. Nothing inside the webview can be trusted to report that, because the thing
/// that would report it is the thing that failed. So the count is kept natively, it is
/// incremented **before** the load, and only a positive signal from the page clears it.
///
/// ```text
///                      ┌──────────────── bootOk() ──────────────┐
///                      │                                        │
/// failedBoots = 0 → load active ──(watchdog / crash)──→ failedBoots = 1
///                                                             │
///                       ┌── bootOk() ──────────────────────────┘
///                       │
/// failedBoots = 1 → load active with ?safe=1 ──(watchdog / crash)──→ failedBoots = 2
///                                                             │
/// failedBoots ≥ 2 → previous bundle exists? ──yes──→ revert, quarantine, load previous
///                                          └──no───→ the recovery screen
/// ```
///
/// **Why attempt two is safe mode.** SPEC §6.1 gives the PWA `?safe=1` (base plugins only)
/// and `?safe=bare` (a minimal plugin manager). A bundle that boots in safe mode and not
/// otherwise has a broken *plugin*, not a broken bundle — reverting the bundle would not
/// fix it, and the user is better off in a working app with a notice than one version back.
/// So the second attempt is the diagnostic, and only its failure triggers the revert.
///
/// [decide] is pure. The whole policy is a table in `test/shell/boot_guard_test.dart`.
library;

import '../bundle/manifest.dart';
import '../bundle/store.dart';
import '../config.dart';

/// What the shell should do at launch.
enum BootAction {
  /// No bundle on the device: native login, then the first download.
  firstRun,

  /// Load [BootPlan.version] normally.
  loadBundle,

  /// Load [BootPlan.version] with `?safe=1` — the second attempt (SPEC §6.1).
  loadBundleSafeMode,

  /// Swap back to the previous bundle and load it. The failed version is quarantined.
  revert,

  /// Two failures and nothing to revert to: a native screen offering re-download and
  /// sign-out. Never a blank webview.
  recovery,

  /// The bundle needs a newer bridge than this shell implements (SPEC §7: "update the app").
  needsNewerShell,
}

/// The decision, plus the state that must be persisted before acting on it.
class BootPlan {
  const BootPlan({
    required this.action,
    required this.state,
    this.version,
    this.reason,
  });

  final BootAction action;

  /// Persist this **before** loading anything: the increment has to survive a crash that
  /// takes the process with it.
  final BundleState state;

  final String? version;

  /// Shown on the recovery and "update the app" screens; logged otherwise.
  final String? reason;

  bool get loadsWebview =>
      action == BootAction.loadBundle ||
      action == BootAction.loadBundleSafeMode;
}

/// Pure policy, plus the thin IO around it: promote, decide, persist, record the outcome.
class BootGuard {
  BootGuard(this._store, {this.log});

  final BundleStore _store;

  /// Diagnostics for `adb logcat`. Every decision this class makes is invisible from
  /// inside the webview by construction, so it has to be visible from outside.
  final void Function(String)? log;

  /// Why the last boot attempt was declared failed. Shown on the native failure screen;
  /// not persisted — the *count* is what has to survive a crash, and the reason from a
  /// process that is gone is not something the next launch can trust anyway.
  String? get lastFailureReason => _lastFailureReason;
  String? _lastFailureReason;

  /// Promote a staged bundle. Called once at launch, **before** [decide]: an update
  /// downloaded during the last session becomes active now, while nothing is running.
  ///
  /// A pending version that is quarantined is dropped rather than promoted — that
  /// combination means it was staged, promoted, failed twice and reverted, and re-promoting
  /// it is an infinite loop.
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

  /// The state machine in the library docs. Pure.
  ///
  /// [activeManifest] is the manifest stored alongside the active bundle (the updater
  /// writes it into the bundle directory so the shell knows `min_bridge_version` and
  /// `index_csp` offline). `null` means it could not be read, which is treated as
  /// compatible — refusing to boot over a missing metadata file would be a worse failure
  /// than trying.
  /// [quarantineOnRevert] distinguishes "this bundle crashed here" from "this bundle
  /// never got to run". Quarantine is permanent and only the user's own "Download the app
  /// again" clears it, so it is applied *only* to a bundle that was loaded and failed. A
  /// bundle whose directory vanished under the pointer, or one this shell is too old for,
  /// is reverted away from without being condemned — see [BundleState.reverted].
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
      // Reverting is tried first: an older bundle that runs is better than a screen that
      // tells the user to go and find an APK. The revert itself re-enters `decide`.
      //
      // **Not quarantined.** Nothing is wrong with this bundle — the shell is too old for
      // it, which is a fact about the APK and changes the moment the APK is updated.
      // Condemning it here would survive that update (the updater checks `quarantined`
      // before the bridge gate) and pin the device to the older bundle permanently.
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

  /// The whole launch decision, with its IO: promote what was staged, notice a pointer that
  /// disagrees with the disk, [decide], follow a revert through to the bundle it lands on,
  /// and persist the result **before** the caller loads anything.
  ///
  /// One `state.json` write, at the end, holding every transition the launch made. Writing
  /// the intermediate states would buy nothing — a crash between two of them would leave a
  /// state that says less than the one before it — and the file moves by `rename`, so the
  /// single write is the atomic one (`store.dart`).
  Future<BootPlan> resolve({
    int bridgeVersion = kBridgeVersion,
    int maxFailedBoots = kMaxFailedBoots,
  }) async {
    BundleState state = BootGuard.promotePending(await _store.readState());
    String? firstReason;
    BootPlan plan = await _decide(state, bridgeVersion, maxFailedBoots);

    // A revert names the bundle it went back to; that bundle gets its own turn through the
    // table (it may itself be missing, or need a newer bridge). `previous` becomes null on
    // revert, so this terminates after one hop; the bound is a belt, not a mechanism.
    for (int hop = 0; plan.action == BootAction.revert && hop < 4; hop += 1) {
      log?.call('boot: reverting — ${plan.reason}');
      firstReason ??= plan.reason;
      plan = await _decide(plan.state, bridgeVersion, maxFailedBoots);
    }
    if (plan.action == BootAction.revert) {
      // Unreachable via the transitions above; if it ever is reached, a native screen is
      // the only honest answer.
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

  /// [decide], with the two things only the disk can answer folded in.
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
      // The pointer and the disk disagree: app data cleared, a crash mid-install, a
      // half-deleted directory. This is not a first run — the pointer may still hold a
      // good `previous` — so it is escalated into the revert path rather than quietly
      // re-downloading over a state that could have recovered on its own.
      //
      // The escalation borrows the failed-boot path's *transition* but not its verdict:
      // the bundle never ran, so it is reverted away from and left un-quarantined. A
      // device that had its app data cleared, or an install that crashed half-way, would
      // otherwise permanently refuse the version the server publishes.
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

  /// `shell.bootOk()` arrived: clear the counter. Registered on the bridge as `boot.ok`.
  Future<void> bootSucceeded() async {
    _lastFailureReason = null;
    final BundleState state = await _store.readState();
    if (state.failedBoots == 0) return;
    log?.call('boot: ${state.active} reported a successful boot');
    await _store.writeState(state.bootSucceeded());
  }

  /// The watchdog expired or the page reported a failure. The counter is already
  /// incremented (that happened before the load), so this only has to stop waiting — the
  /// next launch reads it and decides.
  ///
  /// It deliberately **does not** touch the counter. Incrementing here would double-count
  /// a watchdog expiry that the page then confirms with `boot.failed`, and re-arming it
  /// after a successful `boot.ok` would let one late error inside a bundle that *did* boot
  /// push the device into safe mode and then a revert. The count means "launches that never
  /// reached `boot.ok`", and that is written before the load, once, by [resolve].
  Future<void> bootFailed(String reason) async {
    _lastFailureReason = reason;
    final BundleState state = await _store.readState();
    log?.call(
      'boot: ${state.active} failed — $reason '
      '(failedBoots: ${state.failedBoots})',
    );
  }
}
