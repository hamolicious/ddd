library;

import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'manifest.dart';

const String kBundleManifestFile = '.ddd-manifest.json';

const String kStagingDirName = '.staging';

const int kMaxQuarantined = 10;

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

  static const BundleState empty = BundleState();

  final String? active;

  final String? previous;

  final String? pending;

  final int failedBoots;

  final List<String> quarantined;

  bool get hasBundle => active != null;

  bool get canRevert => previous != null && previous != active;

  bool isQuarantined(String version) => quarantined.contains(version);

  BundleState attemptingBoot() => copyWith(failedBoots: failedBoots + 1);

  BundleState bootSucceeded() => copyWith(failedBoots: 0);

  BundleState staged(String version) => copyWith(pending: version);

  BundleState promoted(String version) => BundleState(
    active: version,
    previous: active,
    failedBoots: 0,
    quarantined: quarantined,
  );

  BundleState reverted({bool quarantine = true}) => BundleState(
    active: previous,
    pending: pending,
    failedBoots: 0,
    quarantined: quarantine && active != null && !quarantined.contains(active)
        ? _capped(<String>[...quarantined, active!])
        : quarantined,
  );

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

class BundleStore {
  BundleStore(this.root);

  static Future<BundleStore> open() async {
    final Directory support = await getApplicationSupportDirectory();
    final Directory root = Directory('${support.path}/bundles');
    await root.create(recursive: true);
    return BundleStore(root);
  }

  final Directory root;

  File get stateFile => File('${root.path}/state.json');

  Directory stagingDir(String version) =>
      Directory('${root.path}/$kStagingDirName/$version');

  Directory dirFor(String version) => Directory('${root.path}/$version');

  File fileIn(String version, String path) =>
      File('${dirFor(version).path}/$path');

  File manifestFile(String version) =>
      File('${dirFor(version).path}/$kBundleManifestFile');

  bool isInstalled(String version) => dirFor(version).existsSync();

  Future<BundleManifest?> readManifest(String version) async {
    try {
      final File file = manifestFile(version);
      if (!file.existsSync()) return null;
      return BundleManifest.parse(await file.readAsString());
    } catch (_) {
      return null;
    }
  }

  Future<void> writeStagedManifest(BundleManifest manifest) async {
    final Directory staging = stagingDir(manifest.bundleVersion);
    await staging.create(recursive: true);
    await File('${staging.path}/$kBundleManifestFile')
        .writeAsString(jsonEncode(manifest.toJson()), flush: true);
  }

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

  Future<void> writeState(BundleState state) async {
    final File temp = File('${stateFile.path}.tmp');
    await temp.writeAsString(jsonEncode(state.toJson()), flush: true);
    await temp.rename(stateFile.path);
  }

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
        await _copyDirectory(staging, target);
        await staging.delete(recursive: true);
      }
    } catch (_) {
      if (movedAside && !target.existsSync()) {
        await replaced.rename(target.path);
        movedAside = false;
      }
      rethrow;
    }
    if (movedAside) {
      try {
        await replaced.delete(recursive: true);
      } catch (_) {}
    }
  }

  Future<void> discardStaging(String version) async {
    final Directory staging = stagingDir(version);
    try {
      if (staging.existsSync()) await staging.delete(recursive: true);
    } catch (_) {}
  }

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
      final String name = entity.path.substring(root.path.length + 1);
      if (name != kStagingDirName && keep.contains(name)) continue;
      try {
        await entity.delete(recursive: true);
      } catch (_) {}
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
