/// The bundle manifest: types, parsing, and SHA-256 verification
/// (SPEC §7: "the shell verifies before swapping").
///
/// The wire shape is `GET /api/shell/manifest`, defined in
/// `backend/crates/server/src/routes/shell.rs` and frozen in `BRIDGE.md` §5. This file is
/// the only place in the shell that knows those field names.
///
/// Verification is not a nicety here. The shell downloads executable code over the
/// network and then *runs it as the app*; a truncated response, a proxy that rewrote a
/// file, or a half-finished download must all fail closed, before anything is promoted.
/// So: hash every file after writing it, compare against the manifest, and refuse the
/// whole bundle if any single file disagrees (SPEC §7).
library;

import 'dart:convert';

import 'package:crypto/crypto.dart';

/// One file in the bundle. [path] is both the local path under the bundle directory and
/// the URL path the loopback server answers with it.
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

  /// Lowercase hex.
  final String sha256;
  final int size;

  Map<String, Object?> toJson() => <String, Object?>{
    'path': path,
    'sha256': sha256,
    'size': size,
  };
}

/// The manifest, parsed. Field names mirror the JSON exactly (`snake_case` on the wire,
/// camelCase in Dart) — that mapping is the frozen part.
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
    // `index.html` is what the webview is pointed at; a bundle without it is a bundle
    // that cannot boot, and finding that out here is much cheaper than finding it out
    // after the swap.
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

  /// The document the webview loads, and the only synthesized path that must exist.
  static const String indexPath = 'index.html';

  /// Content hash of the whole set; also the on-disk directory name. Always a
  /// 64-character lowercase hex digest — see [isBundleVersion] for why that is enforced
  /// rather than assumed.
  final String bundleVersion;

  /// The shell refuses a bundle asking for a bridge it does not implement (`BRIDGE.md` §8).
  final int minBridgeVersion;

  /// The `Content-Security-Policy` header the loopback server must send with
  /// `index.html`; its nonce matches the inline import map in those bytes.
  final String indexCsp;

  final List<BundleFile> files;

  int get totalBytes =>
      files.fold(0, (int sum, BundleFile file) => sum + file.size);

  /// `true` when a shell implementing [bridgeVersion] may run this bundle.
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

/// A manifest the shell will not act on. Always fails closed: the active bundle stays.
class ManifestException implements Exception {
  ManifestException(this.message);

  final String message;

  @override
  String toString() => 'ManifestException: $message';
}

/// Lowercase hex SHA-256, the one spelling used everywhere in the shell.
String sha256Hex(List<int> bytes) => sha256.convert(bytes).toString();

/// `true` when [version] has the shape the server derives (`BRIDGE.md` §5): a lowercase
/// hex `sha256`, 64 characters, nothing else.
///
/// **This is a path check, not a cosmetic one.** `bundle_version` is used verbatim as a
/// directory name under the bundle root — `BundleStore.dirFor`, `stagingDir` — and those
/// directories are handed to `Directory.delete(recursive: true)` and `Directory.rename`
/// by `install()`. An unvalidated value therefore reaches the filesystem with the
/// server's privileges over this app's private storage: `"../../shared_prefs"` deletes
/// the keystore holding the bearer token, `".."` deletes the whole files directory, and
/// `"state.json"` or `".staging"` collide with the store's own names. The file list is
/// checked with [isSafeBundlePath] for exactly this reason; the id needs the same
/// treatment and a stricter rule is available, because the server's derivation is frozen.
///
/// Every manifest, from the network *and* from a bundle's own `.ddd-manifest.json`, is
/// parsed through [BundleManifest.fromJson], so this is the only gate needed.
bool isBundleVersion(String version) => _bundleVersion.hasMatch(version);

final RegExp _bundleVersion = RegExp(r'^[0-9a-f]{64}$');

/// `true` when [path] is a relative, traversal-free, backslash-free forward-slash path.
///
/// Checked on the *manifest*, before anything is written, so a malicious or broken server
/// cannot make the updater write outside the bundle directory. The rules match the
/// server's `safe_relative_path`: no absolute paths, no `..`, no empty segments, no
/// Windows separators, no NUL.
bool isSafeBundlePath(String path) {
  if (path.isEmpty || path.startsWith('/') || path.contains('\\')) return false;
  if (path.contains('\u0000')) return false;
  for (final String segment in path.split('/')) {
    if (segment.isEmpty || segment == '.' || segment == '..') return false;
  }
  return true;
}

/// The result of verifying a downloaded bundle directory against its manifest.
class VerificationResult {
  const VerificationResult({required this.checked, required this.problems});

  const VerificationResult.ok(this.checked) : problems = const <String>[];

  final int checked;

  /// Human-readable, one per offending file: missing, wrong size, wrong hash.
  final List<String> problems;

  bool get isValid => problems.isEmpty;
}

/// Verify one file's bytes against its manifest entry. Returns `null` when it matches, a
/// problem description when it does not.
///
/// Size is checked first because it is free and catches the common failure (a truncated
/// download) with a message that says so.
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
