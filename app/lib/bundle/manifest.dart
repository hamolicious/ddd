library;

import 'dart:convert';

import 'package:crypto/crypto.dart';

class BundleFile {
  const BundleFile({
    required this.path,
    required this.sha256,
    required this.size,
  });

  factory BundleFile.fromJson(Map<String, Object?> json) {
    final Object? path = json['path'];
    final Object? digest = json['sha256'];
    final Object? size = json['size'];
    if (path is! String || path.isEmpty) {
      throw ManifestException('a file entry has no path');
    }
    if (digest is! String || digest.length != 64) {
      throw ManifestException('$path has no 64-character sha256');
    }
    if (size is! int || size < 0) {
      throw ManifestException('$path has no size');
    }
    if (!isSafeBundlePath(path)) {
      throw ManifestException('$path escapes the bundle directory');
    }
    return BundleFile(path: path, sha256: digest.toLowerCase(), size: size);
  }

  final String path;

  final String sha256;
  final int size;

  Map<String, Object?> toJson() => <String, Object?>{
    'path': path,
    'sha256': sha256,
    'size': size,
  };
}

class BundleManifest {
  const BundleManifest({
    required this.bundleVersion,
    required this.minBridgeVersion,
    required this.indexCsp,
    required this.files,
  });

  factory BundleManifest.fromJson(Map<String, Object?> json) {
    final Object? version = json['bundle_version'];
    final Object? minBridge = json['min_bridge_version'];
    final Object? files = json['files'];
    if (version is! String || !isBundleVersion(version)) {
      throw ManifestException(
        'bundle_version is missing or is not a 64-character lowercase hex digest',
      );
    }
    if (minBridge is! int || minBridge < 1) {
      throw ManifestException('min_bridge_version is missing');
    }
    if (files is! List || files.isEmpty) {
      throw ManifestException('files is empty — there is nothing to serve');
    }
    final List<BundleFile> parsed = files
        .map(
          (Object? entry) => entry is Map
              ? BundleFile.fromJson(Map<String, Object?>.from(entry))
              : throw ManifestException('a file entry is not an object'),
        )
        .toList(growable: false);
    if (!parsed.any((BundleFile file) => file.path == indexPath)) {
      throw ManifestException('no $indexPath in the manifest');
    }
    return BundleManifest(
      bundleVersion: version,
      minBridgeVersion: minBridge,
      indexCsp: json['index_csp'] is String ? json['index_csp'] as String : '',
      files: parsed,
    );
  }

  factory BundleManifest.parse(String body) {
    final Object? decoded = jsonDecode(body);
    if (decoded is! Map) {
      throw ManifestException('the manifest is not an object');
    }
    return BundleManifest.fromJson(Map<String, Object?>.from(decoded));
  }

  static const String indexPath = 'index.html';

  final String bundleVersion;

  final int minBridgeVersion;

  final String indexCsp;

  final List<BundleFile> files;

  int get totalBytes =>
      files.fold(0, (int sum, BundleFile file) => sum + file.size);

  bool runsOnBridge(int bridgeVersion) => bridgeVersion >= minBridgeVersion;

  Map<String, Object?> toJson() => <String, Object?>{
    'bundle_version': bundleVersion,
    'min_bridge_version': minBridgeVersion,
    'index_csp': indexCsp,
    'files': files
        .map((BundleFile file) => file.toJson())
        .toList(growable: false),
  };
}

class ManifestException implements Exception {
  ManifestException(this.message);

  final String message;

  @override
  String toString() => 'ManifestException: $message';
}

String sha256Hex(List<int> bytes) => sha256.convert(bytes).toString();

bool isBundleVersion(String version) => _bundleVersion.hasMatch(version);

final RegExp _bundleVersion = RegExp(r'^[0-9a-f]{64}$');

bool isSafeBundlePath(String path) {
  if (path.isEmpty || path.startsWith('/') || path.contains('\\')) return false;
  if (path.contains('\u0000')) return false;
  for (final String segment in path.split('/')) {
    if (segment.isEmpty || segment == '.' || segment == '..') return false;
  }
  return true;
}

class VerificationResult {
  const VerificationResult({required this.checked, required this.problems});

  const VerificationResult.ok(this.checked) : problems = const <String>[];

  final int checked;

  final List<String> problems;

  bool get isValid => problems.isEmpty;
}

String? verifyBytes(BundleFile file, List<int> bytes) {
  if (bytes.length != file.size) {
    return '${file.path}: expected ${file.size} bytes, got ${bytes.length}';
  }
  final String actual = sha256Hex(bytes);
  if (actual != file.sha256) {
    return '${file.path}: sha256 ${actual.substring(0, 12)}… != ${file.sha256.substring(0, 12)}…';
  }
  return null;
}
