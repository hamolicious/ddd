library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../bridge/auth.dart';
import '../config.dart';
import 'manifest.dart';
import 'store.dart';

const Duration kManifestTimeout = Duration(seconds: 20);

const Duration kFileTimeout = Duration(minutes: 3);

const int kMaxBundleBytes = 256 * 1024 * 1024;

final ValueNotifier<String?> stagedBundleVersion = ValueNotifier<String?>(null);

enum UpdateOutcome {
  upToDate,

  staged,

  unavailable,

  needsNewerShell,

  corrupt,

  quarantined,

  storageFailed,
}

class UpdateProgress {
  const UpdateProgress({
    required this.filesDone,
    required this.filesTotal,
    required this.bytesDone,
    required this.bytesTotal,
  });

  final int filesDone;
  final int filesTotal;
  final int bytesDone;
  final int bytesTotal;

  double get fraction => bytesTotal == 0 ? 0 : bytesDone / bytesTotal;

  @override
  String toString() =>
      'UpdateProgress($filesDone/$filesTotal files, $bytesDone/$bytesTotal bytes)';
}

class BundleUpdater {
  BundleUpdater({
    required this.config,
    required this.store,
    required this.auth,
    http.Client? client,
    this.log,
    this.bridgeVersion = kBridgeVersion,
  }) : _client = client ?? http.Client();

  final ShellConfig config;
  final BundleStore store;
  final AuthStore auth;
  final http.Client _client;

  final void Function(String)? log;

  final int bridgeVersion;

  BundleState? _reuseFrom;

  static const List<String> synthesizedPaths = <String>[
    'index.html',
    'importmap.json',
  ];

  Future<BundleManifest?> fetchManifest() async {
    final Uri url = config.api('/shell/manifest');
    try {
      final String? token = await auth.token();
      if (token == null) {
        log?.call('update: no bearer token; not checking for a bundle');
        return null;
      }
      final http.StreamedResponse streamed = await _client
          .send(
            bearerRequest('GET', url, token)
              ..headers['Accept'] = 'application/json',
          )
          .timeout(kManifestTimeout);
      final http.Response response = await http.Response.fromStream(streamed)
          .timeout(kManifestTimeout);
      if (response.statusCode != 200) {
        log?.call(
          'update: $url answered ${response.statusCode}'
          '${redirectNote(response.statusCode)}',
        );
        return null;
      }
      return BundleManifest.parse(response.body);
    } on ManifestException catch (error) {
      log?.call('update: ${error.message}');
      return null;
    } catch (error) {
      log?.call('update: $url unreachable: $error');
      return null;
    }
  }

  Future<UpdateOutcome> update({
    void Function(UpdateProgress)? onProgress,
  }) async {
    try {
      return await _update(onProgress: onProgress);
    } catch (error, stack) {
      log?.call('update: unexpected failure: $error\n$stack');
      return UpdateOutcome.storageFailed;
    }
  }

  Future<UpdateOutcome> _update({
    void Function(UpdateProgress)? onProgress,
  }) async {
    final BundleManifest? manifest = await fetchManifest();
    if (manifest == null) return UpdateOutcome.unavailable;

    final BundleState state = await store.readState();
    final String version = manifest.bundleVersion;

    if (state.active == version) {
      if (state.pending != null) {
        log?.call('update: dropping stale pending ${state.pending}');
        await store.writeState(
          BundleState(
            active: state.active,
            previous: state.previous,
            failedBoots: state.failedBoots,
            quarantined: state.quarantined,
          ),
        );
      }
      return UpdateOutcome.upToDate;
    }

    if (state.pending == version && store.isInstalled(version)) {
      return UpdateOutcome.staged;
    }

    if (state.isQuarantined(version)) {
      log?.call('update: $version is quarantined; not installing it again');
      return UpdateOutcome.quarantined;
    }

    if (!manifest.runsOnBridge(bridgeVersion)) {
      log?.call(
        'update: $version needs bridge v${manifest.minBridgeVersion}, '
        'this shell implements v$bridgeVersion',
      );
      return UpdateOutcome.needsNewerShell;
    }

    final String? rejection = _rejectManifest(manifest);
    if (rejection != null) {
      log?.call('update: refusing $version — $rejection');
      return UpdateOutcome.corrupt;
    }

    _reuseFrom = state;
    return _download(manifest, onProgress: onProgress);
  }

  Future<UpdateOutcome> _download(
    BundleManifest manifest, {
    void Function(UpdateProgress)? onProgress,
  }) async {
    final String version = manifest.bundleVersion;
    int filesDone = 0;
    int bytesDone = 0;
    void emit() => onProgress?.call(
      UpdateProgress(
        filesDone: filesDone,
        filesTotal: manifest.files.length,
        bytesDone: bytesDone,
        bytesTotal: manifest.totalBytes,
      ),
    );
    emit();

    try {
      await store.stagingDir(version).create(recursive: true);
      for (final BundleFile file in manifest.files) {
        final String? problem = await fetchFile(manifest, file);
        if (problem != null) {
          log?.call('update: $problem');
          await store.discardStaging(version);
          return UpdateOutcome.corrupt;
        }
        filesDone += 1;
        bytesDone += file.size;
        emit();
      }

      final VerificationResult result = await verifyStaged(manifest);
      if (!result.isValid) {
        for (final String problem in result.problems) {
          log?.call('update: $problem');
        }
        await store.discardStaging(version);
        return UpdateOutcome.corrupt;
      }

      await store.writeStagedManifest(manifest);
      await store.install(version);
    } catch (error) {
      log?.call('update: $version failed to install: $error');
      await store.discardStaging(version);
      return UpdateOutcome.corrupt;
    }

    try {
      final BundleState latest = await store.readState();
      await store.writeState(latest.staged(version));
    } catch (error) {
      log?.call(
        'update: $version is installed but the pointer could not be written: $error',
      );
      return UpdateOutcome.storageFailed;
    }
    log?.call('update: staged $version for the next launch');
    return UpdateOutcome.staged;
  }

  String? _rejectManifest(BundleManifest manifest) {
    if (manifest.totalBytes > kMaxBundleBytes) {
      return 'it claims ${manifest.totalBytes} bytes, over the $kMaxBundleBytes-byte cap';
    }
    final Set<String> seen = <String>{};
    for (final BundleFile file in manifest.files) {
      if (!seen.add(file.path)) {
        return 'it lists ${file.path} twice';
      }
      if (file.path == kBundleManifestFile) {
        return '${file.path} is reserved for the shell';
      }
    }
    return null;
  }

  Future<VerificationResult> verifyStaged(BundleManifest manifest) async {
    final Directory staging = store.stagingDir(manifest.bundleVersion);
    final List<String> problems = <String>[];
    for (final BundleFile file in manifest.files) {
      final File target = File('${staging.path}/${file.path}');
      if (!target.existsSync()) {
        problems.add('${file.path}: missing from the staged bundle');
        continue;
      }
      final String? problem = await verifyFileOnDisk(target, file);
      if (problem != null) problems.add(problem);
    }
    if (problems.isEmpty) await _deleteUnlisted(staging, manifest);
    return VerificationResult(
      checked: manifest.files.length,
      problems: problems,
    );
  }

  Future<String?> fetchFile(BundleManifest manifest, BundleFile file) async {
    final Directory staging = store.stagingDir(manifest.bundleVersion);
    final File target = File('${staging.path}/${file.path}');
    await target.parent.create(recursive: true);

    if (target.existsSync() && await verifyFileOnDisk(target, file) == null) {
      return null;
    }

    final BundleState reuse = _reuseFrom ??= await store.readState();
    for (final String version in <String>[
      ...<String?>[reuse.active, reuse.previous].whereType<String>(),
    ]) {
      final File source = store.fileIn(version, file.path);
      if (!source.existsSync()) continue;
      if (await verifyFileOnDisk(source, file) != null) continue;
      try {
        await source.copy(target.path);
        if (await verifyFileOnDisk(target, file) == null) return null;
      } catch (_) {}
    }

    return _fetchOverNetwork(file, target);
  }

  Future<String?> _fetchOverNetwork(BundleFile file, File target) async {
    final Uri url = fileUrl(file.path);
    final File part = File('${target.path}.part');
    IOSink? sink;
    try {
      final http.Request request;
      if (synthesizedPaths.contains(file.path)) {
        final String? token = await auth.token();
        if (token == null) return '${file.path}: no bearer token';
        request = bearerRequest('GET', url, token);
      } else {
        request = http.Request('GET', url)..followRedirects = false;
      }
      final http.StreamedResponse response = await _client
          .send(request)
          .timeout(kFileTimeout);
      if (response.statusCode != 200) {
        return '${file.path}: $url answered ${response.statusCode}'
            '${redirectNote(response.statusCode)}';
      }
      if (part.existsSync()) await part.delete();
      sink = part.openWrite();
      int received = 0;
      await for (final List<int> chunk in response.stream.timeout(
        kFileTimeout,
      )) {
        received += chunk.length;
        if (received > file.size) {
          return '${file.path}: longer than the manifest\'s ${file.size} bytes';
        }
        sink.add(chunk);
      }
      await sink.flush();
      await sink.close();
      sink = null;

      final String? problem = await verifyFileOnDisk(part, file);
      if (problem != null) return problem;
      if (target.existsSync()) await target.delete();
      await part.rename(target.path);
      return null;
    } catch (error) {
      return '${file.path}: $error';
    } finally {
      try {
        await sink?.close();
      } catch (_) {}
      try {
        if (part.existsSync()) await part.delete();
      } catch (_) {}
    }
  }

  static Future<String?> verifyFileOnDisk(File file, BundleFile entry) async {
    final int length = await file.length();
    if (length != entry.size) {
      return '${entry.path}: expected ${entry.size} bytes, got $length';
    }
    final _DigestSink accumulator = _DigestSink();
    final ByteConversionSink hasher = sha256.startChunkedConversion(
      accumulator,
    );
    await for (final List<int> chunk in file.openRead()) {
      hasher.add(chunk);
    }
    hasher.close();
    final String actual = accumulator.value.toString();
    if (actual != entry.sha256) {
      return '${entry.path}: sha256 ${actual.substring(0, 12)}… != '
          '${entry.sha256.substring(0, 12)}…';
    }
    return null;
  }

  Uri fileUrl(String path) => synthesizedPaths.contains(path)
      ? config.api('/shell/bundle/$path')
      : config.serverBaseUrl.resolve('/$path');

  void close() => _client.close();

  static Future<void> _deleteUnlisted(
    Directory staging,
    BundleManifest manifest,
  ) async {
    if (!staging.existsSync()) return;
    final Set<String> listed = <String>{
      kBundleManifestFile,
      ...manifest.files.map((BundleFile file) => file.path),
    };
    for (final FileSystemEntity entity in staging.listSync(
      recursive: true,
      followLinks: false,
    )) {
      if (entity is! File) continue;
      final String relative = entity.path.substring(staging.path.length + 1);
      if (listed.contains(relative)) continue;
      try {
        await entity.delete();
      } catch (_) {}
    }
  }
}

class _DigestSink implements Sink<Digest> {
  late Digest value;

  @override
  void add(Digest data) => value = data;

  @override
  void close() {}
}
