/// Manifest parsing and verification (`BRIDGE.md` §5).
///
/// The rule every test here defends: **fail closed**. A manifest the shell does not fully
/// understand, or a file whose bytes do not hash to what the server said, must stop the
/// update — not produce a bundle that is swapped in and then cannot boot.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:life_manager_shell/bundle/manifest.dart';

const String emptySha =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/// A `bundle_version` in the shape the server derives (`BRIDGE.md` §5) — and the shape the
/// parser now insists on, because the value ends up as a directory name.
const String testBundleId =
    'b1f3aa0000000000000000000000000000000000000000000000000000000000';

Map<String, Object?> manifestJson({
  int minBridge = 1,
  List<Map<String, Object?>>? files,
}) => <String, Object?>{
  'bundle_version': testBundleId,
  'min_bridge_version': minBridge,
  'index_csp': "default-src 'self'",
  'files':
      files ??
      <Map<String, Object?>>[
        <String, Object?>{'path': 'index.html', 'sha256': emptySha, 'size': 0},
        <String, Object?>{
          'path': 'assets/app-1a2b.js',
          'sha256': emptySha,
          'size': 0,
        },
      ],
};

void main() {
  group('BundleManifest', () {
    test('parses the server shape', () {
      final BundleManifest manifest = BundleManifest.parse(
        jsonEncode(manifestJson()),
      );

      expect(manifest.bundleVersion, testBundleId);
      expect(manifest.minBridgeVersion, 1);
      expect(manifest.indexCsp, "default-src 'self'");
      expect(manifest.files, hasLength(2));
      expect(manifest.toJson(), manifestJson());
    });

    test('refuses a manifest with no index.html — it could never boot', () {
      final Map<String, Object?> json = manifestJson(
        files: <Map<String, Object?>>[
          <String, Object?>{
            'path': 'assets/app.js',
            'sha256': emptySha,
            'size': 0,
          },
        ],
      );

      expect(
        () => BundleManifest.fromJson(json),
        throwsA(isA<ManifestException>()),
      );
    });

    test('refuses missing or malformed fields', () {
      for (final String key in <String>[
        'bundle_version',
        'min_bridge_version',
        'files',
      ]) {
        final Map<String, Object?> json = manifestJson()..remove(key);
        expect(
          () => BundleManifest.fromJson(json),
          throwsA(isA<ManifestException>()),
          reason: 'removing $key must fail the parse',
        );
      }
    });

    test('refuses a file entry whose path escapes the bundle directory', () {
      for (final String path in <String>[
        '../outside.js',
        '/etc/passwd',
        'a//b.js',
        'a/../b.js',
      ]) {
        expect(
          () => BundleFile.fromJson(<String, Object?>{
            'path': path,
            'sha256': emptySha,
            'size': 0,
          }),
          throwsA(isA<ManifestException>()),
          reason: '$path must be refused',
        );
      }
    });

    test('refuses a bundle_version that is not a 64-hex digest', () {
      // `bundle_version` becomes a directory name under the bundle root, and that
      // directory is handed to `Directory.delete(recursive: true)` and `Directory.rename`
      // by `BundleStore.install`. A hostile server that also serves bytes matching its own
      // hashes passes every other check in the shell, so this parse is the only thing
      // between `"../../shared_prefs"` and the deletion of the keystore holding the bearer
      // token — and between `".."` and the deletion of the whole files directory.
      //
      // The reserved names are the other half: the store keeps `state.json` and `.staging`
      // directly under the same root.
      for (final String version in <String>[
        '../../shared_prefs',
        '..',
        '.',
        'a/b',
        r'a\b',
        'state.json',
        '.staging',
        '',
        'b1f3aa',
        'B1F3AA0000000000000000000000000000000000000000000000000000000000',
        'g1f3aa0000000000000000000000000000000000000000000000000000000000',
        '${testBundleId}0',
      ]) {
        expect(
          () => BundleManifest.fromJson(
            manifestJson()..['bundle_version'] = version,
          ),
          throwsA(isA<ManifestException>()),
          reason: 'bundle_version "$version" must be refused',
        );
        expect(isBundleVersion(version), isFalse);
      }
      expect(isBundleVersion(testBundleId), isTrue);
    });

    test('runsOnBridge compares against the shell, not the server', () {
      final BundleManifest needsTwo = BundleManifest.fromJson(
        manifestJson(minBridge: 2),
      );

      expect(needsTwo.runsOnBridge(1), isFalse);
      expect(needsTwo.runsOnBridge(2), isTrue);
      expect(needsTwo.runsOnBridge(3), isTrue);
    });
  });

  group('verifyBytes', () {
    const BundleFile file = BundleFile(
      path: 'assets/app.js',
      sha256:
          'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      size: 3,
    );

    test('accepts the exact bytes', () {
      expect(verifyBytes(file, utf8.encode('abc')), isNull);
    });

    test('reports a truncated download by size, before hashing', () {
      expect(
        verifyBytes(file, utf8.encode('ab')),
        contains('expected 3 bytes'),
      );
    });

    test('reports a hash mismatch for the right number of wrong bytes', () {
      expect(verifyBytes(file, utf8.encode('abd')), contains('sha256'));
    });
  });

  test('sha256Hex is lowercase hex, matching the server', () {
    expect(sha256Hex(const <int>[]), emptySha);
  });
}
