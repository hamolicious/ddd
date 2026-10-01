/// On-disk bundle storage: versioned directories and one atomic pointer
/// (SPEC §7: "keeps the previous bundle, auto-reverts after two failed boots").
///
/// ```text
/// <app support>/bundles/
/// ├── state.json                 the pointer + the failed-boot counter  (atomic)
/// ├── .staging/<version>/        a download in progress; never served
/// ├── b1f3…/                     a verified bundle (active or previous)
/// └── 9ac7…/
/// ```
///
/// Three properties hold this together.
///
/// **Directories are named by content hash**, so "install version X" is idempotent and two
/// bundles never share a path. It also means a re-download of the same version lands in the
/// same place, which makes a resumed update free.
///
/// **`state.json` is the only mutable thing**, and it is replaced by `rename()` — never
/// edited in place. A crash mid-write therefore leaves either the old pointer or the new
/// one, never a truncated file that would make the shell forget which bundle boots. (Dart
/// cannot fsync a directory, so a power cut immediately after the rename can in principle
/// lose it; the outcome is booting the previous bundle, which is the safe direction.)
///
/// **The failed-boot counter lives here, natively**, not in web storage — the whole point
/// is to survive a bundle that cannot run its own JavaScript (SPEC §7).
library;

import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'manifest.dart';

/// The bundle's own copy of the manifest it was installed from, inside its directory.
///
/// The shell needs `min_bridge_version` and `index_csp` (`BRIDGE.md` §5) **offline**, on
/// every launch, before any network call — the min-bridge gate and the loopback server's
/// `Content-Security-Policy` header both read them. So the manifest is written into the
/// staging directory before the swap and travels with it.
///
/// The name is dotted and namespaced rather than the plain `manifest.json` of
/// `BRIDGE.md` §6, because `manifest.json` is a name a web bundle can legitimately use:
/// Vite writes one, and a PWA that renames `manifest.webmanifest` would collide with it.
/// A collision would mean the shell overwriting a bundle file or losing its own metadata.
/// [BundleUpdater] additionally refuses a manifest that lists this path, so the two can
/// never be the same file.
const String kBundleManifestFile = '.ddd-manifest.json';

/// The directory a download is assembled in, under the store root.
const String kStagingDirName = '.staging';

/// How many quarantined versions [BundleState] remembers. Oldest first out: a version
/// that far back is a build nothing publishes any more, and the list is rewritten to disk
/// on every launch.
const int kMaxQuarantined = 10;

/// The persisted pointer. Pure data with pure transitions, so the whole revert policy is
/// testable without a filesystem (`test/bundle/store_test.dart`).
class BundleState {
  const BundleState({
    this.active,
    this.previous,
    this.pending,
    this.failedBoots = 0,
    this.quarantined = const <String>[],
  });

  factory BundleState.fromJson(Map<String, Object?> json) => BundleState(
    active: json['active'] is String ? json['active'] as String : null,
    previous: json['previous'] is String ? json['previous'] as String : null,
    pending: json['pending'] is String ? json['pending'] as String : null,
    failedBoots: json['failedBoots'] is int ? json['failedBoots'] as int : 0,
    quarantined: json['quarantined'] is List
        ? (json['quarantined'] as List).whereType<String>().toList(
            growable: false,
          )
        : const <String>[],
  );

  /// A device that has never updated: no bundle at all.
  static const BundleState empty = BundleState();

  /// The bundle the webview boots.
  final String? active;

  /// The last bundle known to have booted. The revert target; kept until a newer bundle
  /// has booted successfully once.
  final String? previous;

  /// Downloaded and verified, waiting for the next launch to be promoted. Updates are
  /// never swapped under a running webview — the page holds open IndexedDB handles and a
  /// socket, and hot-swapping its own code underneath it is how you get a half-old,
  /// half-new client.
  final String? pending;

  /// Consecutive failed boots of [active] (`BRIDGE.md` §7).
  final int failedBoots;

  /// Versions that failed and must never be auto-installed again. Without this the
  /// updater re-downloads the bundle it just reverted away from, every launch, forever.
  final List<String> quarantined;

  bool get hasBundle => active != null;

  bool get canRevert => previous != null && previous != active;

  bool isQuarantined(String version) => quarantined.contains(version);

  /// About to load [active] in the webview. Written **before** the load, so a crash that
  /// takes the process with it still counts.
  BundleState attemptingBoot() => copyWith(failedBoots: failedBoots + 1);

  /// The page called `shell.bootOk()`. The active bundle is trusted from here on, and its
  /// predecessor stops being interesting.
  BundleState bootSucceeded() => copyWith(failedBoots: 0);

  /// A verified download is ready for the next launch.
  BundleState staged(String version) => copyWith(pending: version);

  /// Promote [version] to active, keeping the outgoing one as the revert target.
  ///
  /// The counter resets: the new bundle deserves its own two attempts.
  BundleState promoted(String version) => BundleState(
    active: version,
    previous: active,
    failedBoots: 0,
    quarantined: quarantined,
  );

  /// [active] failed twice. Swap back, and quarantine it **when the bundle is what
  /// failed**.
  ///
  /// `previous` becomes `null` rather than the failed version: reverting to something that
  /// just failed twice is not a recovery path.
  ///
  /// [quarantine] is `false` for the reverts that are not the bundle's fault — a shell too
  /// old for the bundle's `min_bridge_version`, a bundle directory that went missing under
  /// the pointer (`shell/boot_guard.dart`). Quarantine is permanent and is only ever
  /// cleared by the user finding "Download the app again" behind the recovery screen, so
  /// marking a bundle that never got to run would pin the device to an older one forever:
  /// re-install the APK, and [BundleUpdater.update] still refuses the version the server
  /// publishes, with no screen ever saying why.
  BundleState reverted({bool quarantine = true}) => BundleState(
    active: previous,
    pending: pending,
    failedBoots: 0,
    quarantined: quarantine && active != null && !quarantined.contains(active)
        ? _capped(<String>[...quarantined, active!])
        : quarantined,
  );

  /// The newest [kMaxQuarantined] entries. The list is append-only otherwise, and every
  /// entry is a 64-character hash of a build that may not exist anywhere any more; an
  /// unbounded one is written into `state.json` on every launch forever.
  static List<String> _capped(List<String> versions) =>
      versions.length <= kMaxQuarantined
      ? List<String>.unmodifiable(versions)
      : List<String>.unmodifiable(
          versions.sublist(versions.length - kMaxQuarantined),
        );

  BundleState copyWith({
    String? active,
    String? previous,
    String? pending,
    int? failedBoots,
    List<String>? quarantined,
  }) => BundleState(
    active: active ?? this.active,
    previous: previous ?? this.previous,
    pending: pending ?? this.pending,
    failedBoots: failedBoots ?? this.failedBoots,
    quarantined: quarantined ?? this.quarantined,
  );

  Map<String, Object?> toJson() => <String, Object?>{
    if (active != null) 'active': active,
    if (previous != null) 'previous': previous,
    if (pending != null) 'pending': pending,
    'failedBoots': failedBoots,
    'quarantined': quarantined,
  };

  @override
  String toString() =>
      'BundleState(active: $active, previous: $previous, pending: $pending, '
      'failedBoots: $failedBoots, quarantined: $quarantined)';
}

/// The bundle directory and its pointer file. Owned by the shell-updater area.
class BundleStore {
  BundleStore(this.root);

  /// `<app support>/bundles`. **Application support, not documents**: the bundle is app
  /// data, must not appear in any user-visible file list, and must not be backed up and
  /// restored onto a device whose shell is older (SPEC §7's min-bridge screen exists for
  /// that case, but not having to reach it is better).
  static Future<BundleStore> open() async {
    final Directory support = await getApplicationSupportDirectory();
    final Directory root = Directory('${support.path}/bundles');
    await root.create(recursive: true);
    return BundleStore(root);
  }

  final Directory root;

  File get stateFile => File('${root.path}/state.json');

  /// Where a download is assembled. Outside the served set, so a partial bundle can never
  /// be booted, and safe to delete wholesale at any time.
  Directory stagingDir(String version) =>
      Directory('${root.path}/$kStagingDirName/$version');

  /// The directory a verified bundle lives in; also what the loopback server serves from.
  Directory dirFor(String version) => Directory('${root.path}/$version');

  /// One file inside an installed bundle. Used by the updater to reuse bytes it already
  /// has (an update changes a handful of files out of hundreds) and by the loopback
  /// server to answer a request.
  File fileIn(String version, String path) =>
      File('${dirFor(version).path}/$path');

  /// The bundle's own copy of its manifest ([kBundleManifestFile]).
  File manifestFile(String version) =>
      File('${dirFor(version).path}/$kBundleManifestFile');

  /// `true` when [version] has a directory on disk. The pointer and the disk can disagree
  /// — app data cleared, a crash mid-prune — and a pointer at a directory that is not
  /// there must be discovered before the webview is handed a 404 for `index.html`.
  bool isInstalled(String version) => dirFor(version).existsSync();

  /// The manifest stored alongside an installed bundle, or `null` when it cannot be read.
  ///
  /// Never throws: a missing or corrupt copy is a fact the boot flow handles (it treats
  /// the bundle as unbootable and reverts), not an exception to propagate out of launch.
  Future<BundleManifest?> readManifest(String version) async {
    try {
      final File file = manifestFile(version);
      if (!file.existsSync()) return null;
      return BundleManifest.parse(await file.readAsString());
    } catch (_) {
      return null;
    }
  }

  /// Write the manifest into the *staging* directory, so it is renamed into place with the
  /// bytes it describes. Nothing ever writes into an installed bundle directory.
  Future<void> writeStagedManifest(BundleManifest manifest) async {
    final Directory staging = stagingDir(manifest.bundleVersion);
    await staging.create(recursive: true);
    await File('${staging.path}/$kBundleManifestFile')
        .writeAsString(jsonEncode(manifest.toJson()), flush: true);
  }

  /// Never throws: an unreadable or corrupt pointer means "no bundle", which sends the
  /// shell down the first-run path rather than into a crash loop.
  Future<BundleState> readState() async {
    try {
      if (!stateFile.existsSync()) return BundleState.empty;
      final Object? decoded = jsonDecode(await stateFile.readAsString());
      if (decoded is! Map) return BundleState.empty;
      return BundleState.fromJson(Map<String, Object?>.from(decoded));
    } catch (_) {
      return BundleState.empty;
    }
  }

  /// Write-then-rename: the pointer is never observed half-written.
  Future<void> writeState(BundleState state) async {
    final File temp = File('${stateFile.path}.tmp');
    await temp.writeAsString(jsonEncode(state.toJson()), flush: true);
    await temp.rename(stateFile.path);
  }

  /// Move a verified staging directory into place under its content hash.
  ///
  /// `rename` within one filesystem, so the directory appears complete or not at all;
  /// verification has already happened (`manifest.dart`, and the updater's second pass
  /// over the bytes on disk) — this must never be the step that decides whether the bytes
  /// are good.
  ///
  /// An existing directory for the same version is replaced rather than kept. The
  /// directory name is a content hash, so the two *should* be identical; "should" is not a
  /// guarantee a crashed `prune` respects, and the copy that was just verified file by
  /// file is the one worth keeping.
  ///
  /// **The old directory is renamed aside, not deleted, before the new one lands.** A
  /// delete-then-rename leaves a window in which the version exists nowhere, and the
  /// version being replaced is not always a spare copy: roll a bad deploy back and the
  /// server republishes the exact bundle this device holds as `previous`, so the
  /// destination *is* the revert target. A process death in that window (a low-memory
  /// kill, the user swiping the app away — this runs unawaited in the background) would
  /// leave `state.json` naming a `previous` that is gone, and the failure only surfaces
  /// much later, as a revert that lands on the recovery screen. Two renames cost nothing
  /// and there is no such window: the directory is the old bundle or the new one.
  Future<void> install(String version) async {
    final Directory staging = stagingDir(version);
    if (!staging.existsSync()) {
      throw StateError('nothing staged at ${staging.path}');
    }
    await Directory(root.path).create(recursive: true);
    final Directory target = dirFor(version);
    final Directory replaced = Directory(
      '${root.path}/$kStagingDirName/.replaced-$version',
    );
    bool movedAside = false;
    if (target.existsSync()) {
      if (replaced.existsSync()) await replaced.delete(recursive: true);
      await replaced.parent.create(recursive: true);
      await target.rename(replaced.path);
      movedAside = true;
    }
    try {
      try {
        await staging.rename(target.path);
      } on FileSystemException {
        // Staging lives under the same root, so this should not happen; if the platform
        // refuses the rename anyway, copying is slower but not wrong.
        await _copyDirectory(staging, target);
        await staging.delete(recursive: true);
      }
    } catch (_) {
      // The new bundle did not land. Put the old one back rather than leaving the version
      // absent — it is the copy the pointer may still be naming.
      if (movedAside && !target.existsSync()) {
        await replaced.rename(target.path);
        movedAside = false;
      }
      rethrow;
    }
    if (movedAside) {
      try {
        await replaced.delete(recursive: true);
      } catch (_) {
        // Superseded bytes under `.staging`, which `prune` removes wholesale: disk, not
        // correctness.
      }
    }
  }

  /// Throw away a download, verified or not. Called on every failure path in the updater:
  /// a bundle that failed verification must not leave bytes behind that a later run could
  /// mistake for a resumable download.
  Future<void> discardStaging(String version) async {
    final Directory staging = stagingDir(version);
    try {
      if (staging.existsSync()) await staging.delete(recursive: true);
    } catch (_) {
      // Disk full, a permission change, a file held open: the next attempt re-verifies
      // every byte anyway, so a leftover directory is waste, not a hazard.
    }
  }

  /// Delete every bundle directory that is not active, previous or pending, and every
  /// staging directory. Called after a successful boot, never before: disk is cheap and a
  /// bundle you might still need to revert to is not.
  ///
  /// **Call it before starting a background update, not during one** — it deletes
  /// `.staging` wholesale, which would take a download in flight with it. The boot flow
  /// sequences the two (`main.dart`: `bootOk` → prune → check for an update).
  ///
  /// Never throws: failing to reclaim disk is not a reason to fail a launch that has
  /// already succeeded.
  Future<void> prune(BundleState state) async {
    final Set<String> keep = <String>{
      ...<String?>[
        state.active,
        state.previous,
        state.pending,
      ].whereType<String>(),
    };
    if (!root.existsSync()) return;
    for (final FileSystemEntity entity in root.listSync(followLinks: false)) {
      if (entity is! Directory) continue;
      // A direct child of the root, so the tail of the path is the version (or
      // `.staging`) — no path-separator guessing needed.
      final String name = entity.path.substring(root.path.length + 1);
      if (name != kStagingDirName && keep.contains(name)) continue;
      try {
        await entity.delete(recursive: true);
      } catch (_) {
        // See above: best effort.
      }
    }
  }

  static Future<void> _copyDirectory(Directory from, Directory to) async {
    await to.create(recursive: true);
    for (final FileSystemEntity entity in from.listSync(
      recursive: true,
      followLinks: false,
    )) {
      final String relative = entity.path.substring(from.path.length + 1);
      if (entity is Directory) {
        await Directory('${to.path}/$relative').create(recursive: true);
      } else if (entity is File) {
        final File target = File('${to.path}/$relative');
        await target.parent.create(recursive: true);
        await entity.copy(target.path);
      }
    }
  }
}
