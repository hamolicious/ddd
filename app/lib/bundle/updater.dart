/// The OTA bundle updater (SPEC §7, SPEC §9 M5 acceptance: "OTA update + revert").
///
/// The whole algorithm, in order, because every step exists to prevent a specific way of
/// bricking the app:
///
/// 1. `GET /api/shell/manifest` with the bearer token. Any failure — offline, 401, garbage
///    JSON — is [UpdateOutcome.unavailable] and **changes nothing**. An update is an
///    enhancement; the installed bundle keeps running.
/// 2. `manifest.bundle_version == state.active` → [UpdateOutcome.upToDate]. This is the
///    common path and costs one request.
/// 3. `state.isQuarantined(version)` → [UpdateOutcome.quarantined]. A bundle that failed
///    twice is not re-downloaded just because it is still the newest thing on the server.
/// 4. `!manifest.runsOnBridge(kBridgeVersion)` → [UpdateOutcome.needsNewerShell]. The
///    *bundle* is fine; this shell is too old (SPEC §7: "mismatch shows 'update the app'").
///    Nothing is downloaded, and the active bundle keeps running if it can.
/// 5. Download every file into `.staging/<version>/`, hashing as it writes. One mismatch
///    aborts the whole bundle ([UpdateOutcome.corrupt]) and deletes the staging directory.
/// 6. `install()` renames staging into place; `staged()` records it as pending.
/// 7. **The swap happens at the next launch**, not now — `boot_guard.dart` promotes the
///    pending bundle. A running webview holds IndexedDB handles, a socket and a plugin
///    graph; replacing its code underneath it is how a client ends up half-old.
///
/// Files are fetched from the URLs they already have (`BRIDGE.md` §5): the dist files and
/// plugin assets from the public static routes, `index.html` and `importmap.json` from
/// `/api/shell/bundle/…` because those two are rendered per response in the browser and
/// cannot be hashed otherwise.
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

/// How long the manifest request gets. Short: it runs on every foreground, and a server
/// that is slow to answer it must not hold up a shell that can already boot offline.
const Duration kManifestTimeout = Duration(seconds: 20);

/// How long one file download gets. Generous — a phone on a bad connection pulling a
/// multi-megabyte chunk is not a failure — but bounded, so a half-open socket cannot
/// leave the first-run screen spinning forever.
const Duration kFileTimeout = Duration(minutes: 3);

/// The largest bundle the shell will download, summed from the manifest before anything is
/// fetched (`BRIDGE.md` §5: "reject partial/oversize").
///
/// It is a sanity bound, not a budget: the PWA plus every plugin is single-digit megabytes
/// (SPEC §8's perf budget would be unreachable otherwise), so a manifest claiming a
/// quarter of a gigabyte is a bug or an attack, and filling the user's storage to find
/// that out is the wrong way to learn it.
const int kMaxBundleBytes = 256 * 1024 * 1024;

/// The version the shell has verified and staged for the next launch, or `null`.
///
/// The page is *told* about a staged bundle rather than asked — `web/app/src/boot/shell.ts`
/// listens for the `ddd-shell-update-ready` event and turns it into the kernel notice
/// "close and reopen ddd to finish it". `WebViewHost` watches this notifier and
/// dispatches that event; a `ValueNotifier` rather than a direct call because the updater
/// runs in the background and has no webview to talk to (the same shape as
/// `tappedNotificationRoute` in `bridge/notifications.dart`).
///
/// Purely informational: promotion happens at the next launch either way (`BRIDGE.md` §7).
final ValueNotifier<String?> stagedBundleVersion = ValueNotifier<String?>(null);

/// What one update pass did. Every value is a terminal state the UI can report; none of
/// them leaves the shell in a worse position than it started.
enum UpdateOutcome {
  /// Already running the manifest's bundle.
  upToDate,

  /// Downloaded, verified, staged. Applied at the next launch.
  staged,

  /// Could not reach or parse the manifest. Silent — this happens on every launch offline.
  unavailable,

  /// The newest bundle needs a bridge this shell does not implement (`BRIDGE.md` §8).
  needsNewerShell,

  /// A file failed verification. Loud: it means the bytes on the wire were not the bytes
  /// the server hashed.
  corrupt,

  /// The newest bundle is the one that already failed twice here.
  quarantined,

  /// The device could not store the update: the disk filled up mid-download, the pointer
  /// could not be rewritten, the keystore refused to answer. Nothing was promoted and the
  /// installed bundle is untouched — but unlike [unavailable] this is *this device's*
  /// problem, and saying "the server could not be reached" would send the user looking in
  /// the wrong place.
  storageFailed,
}

/// Progress for the first-run download screen. A first install is the whole PWA plus every
/// plugin, which is not instant on a phone.
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

/// Owned by the shell-updater area.
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

  /// Diagnostics for `adb logcat`. Every rejection says which file and why — "the update
  /// failed" is useless when the cause is one proxy rewriting one asset.
  final void Function(String)? log;

  /// The bridge this build implements. Overridable so the min-bridge gate is testable
  /// without rebuilding the shell (`BRIDGE.md` §8).
  final int bridgeVersion;

  /// The state the current pass reuses bytes from, read once per [update].
  BundleState? _reuseFrom;

  /// The paths the shell fetches from `/api/shell/bundle/…` with the bearer token rather
  /// than from a public static route (`BRIDGE.md` §5). They are rendered per response in
  /// the browser and therefore cannot be hashed from the static route's bytes.
  static const List<String> synthesizedPaths = <String>[
    'index.html',
    'importmap.json',
  ];

  /// Step 1. Returns `null` when the manifest could not be fetched or parsed — the caller
  /// treats that as [UpdateOutcome.unavailable], never as a reason to stop booting.
  Future<BundleManifest?> fetchManifest() async {
    final Uri url = config.api('/shell/manifest');
    try {
      // Inside the `try`: a keystore that throws (a corrupt keystore, a device whose
      // credentials were invalidated by a lock-screen change) is "no usable manifest"
      // like any other failure here, not an exception out of a background update check
      // or out of the first-run screen.
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
      // A malformed manifest is indistinguishable, from here, from a captive portal
      // serving a login page: both are "no usable manifest", and neither is a reason to
      // touch the bundle that is already running.
      log?.call('update: ${error.message}');
      return null;
    } catch (error) {
      log?.call('update: $url unreachable: $error');
      return null;
    }
  }

  /// Steps 2–6. **Never throws; every failure is an [UpdateOutcome].**
  ///
  /// That sentence is load-bearing rather than descriptive: the two callers are a
  /// background check whose failure must be silent (`main.dart._checkForUpdate`) and the
  /// first-run screen, which has no bundle to fall back to and would otherwise be left on
  /// a progress bar forever. So the guarantee is enforced here, once, instead of being
  /// re-derived every time a step grows an `await` — a full disk and a keystore that
  /// refuses to answer both raise from places that look like pure bookkeeping.
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

    // Step 2. The common case, and it costs exactly the one request above.
    if (state.active == version) {
      // A pending update that the server has since rolled back would otherwise be
      // promoted at the next launch, moving the device *off* the version the server now
      // publishes. Dropping the pointer is enough; `prune` reclaims the bytes.
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

    // Already downloaded and verified in an earlier pass; it applies at the next launch.
    if (state.pending == version && store.isInstalled(version)) {
      return UpdateOutcome.staged;
    }

    // Step 3. A bundle that failed twice here is not re-downloaded just because it is
    // still the newest thing on the server.
    if (state.isQuarantined(version)) {
      log?.call('update: $version is quarantined; not installing it again');
      return UpdateOutcome.quarantined;
    }

    // Step 4. The bundle is fine; this shell is too old (SPEC §7: "update the app").
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

    // Step 5. Download into staging, verifying as we go. Staging is deliberately *not*
    // cleared first: its directory is named by content hash, so whatever is in there
    // belongs to this exact version, and every file in it is re-verified before it is
    // trusted. That is what makes an interrupted first install resume instead of starting
    // over on a phone that lost its connection at 90%.
    _reuseFrom = state;
    return _download(manifest, onProgress: onProgress);
  }

  /// Steps 5–6 proper, split out so [update]'s preconditions read as a list.
  ///
  /// Resuming is at file granularity: a file already in staging that verifies is kept, and
  /// anything else is fetched again from the first byte. Half a file is never trusted —
  /// there is no way to tell a truncated body from a body that was rewritten in the middle,
  /// and a range request that the server answers from a *different* build would produce a
  /// file that is corrupt in a way the per-file hash is the only thing standing between and
  /// the user.
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

      // Step 6, and the one guarantee the whole file is built around: **every** sha256 is
      // checked against the bytes on disk before anything is promoted. `fetchFile` already
      // hashed each file as it landed; this pass also catches what a per-file check cannot
      // — a file that was never written at all, and one that changed underneath us between
      // its own check and the swap.
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

    // Step 7 happens at the next launch. Re-read the pointer rather than reusing the copy
    // from the top of `update`: a `boot.ok` may have cleared the failed-boot counter while
    // this download was running, and writing a stale copy back would undo it.
    //
    // Guarded separately from the download above because it fails for a different reason
    // and leaves a different world behind: the bytes are installed and verified, and only
    // the pointer naming them is missing. The next launch re-reads the manifest, finds the
    // bundle already on disk and stages it again for free — so this is worth reporting as
    // "this device could not save it", not as a corrupt download.
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

  /// Everything about a manifest that makes it unusable *before* a byte is fetched.
  String? _rejectManifest(BundleManifest manifest) {
    if (manifest.totalBytes > kMaxBundleBytes) {
      return 'it claims ${manifest.totalBytes} bytes, over the $kMaxBundleBytes-byte cap';
    }
    final Set<String> seen = <String>{};
    for (final BundleFile file in manifest.files) {
      if (!seen.add(file.path)) {
        // Two entries for one path cannot both be verified, and whichever landed last
        // would decide what the webview runs.
        return 'it lists ${file.path} twice';
      }
      if (file.path == kBundleManifestFile) {
        // The shell's own metadata lives at this path inside a bundle directory
        // (`store.dart`); a bundle file there would overwrite it or be overwritten by it.
        return '${file.path} is reserved for the shell';
      }
    }
    return null;
  }

  /// Re-hash every staged file against the manifest, and delete anything staged that the
  /// manifest does not list (a `.part` left by an interrupted download, a file dropped
  /// from the bundle since the last version).
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

  /// Download one file into the staging directory and verify it against its manifest
  /// entry. Streamed to disk — a bundle is tens of megabytes and must not be held in
  /// memory — and hashed from the bytes that were *written*, not the bytes received.
  ///
  /// Two cheaper sources are tried first, and between them they are what makes an update a
  /// *delta*:
  ///
  /// 1. **staging** — a file an interrupted run already completed and verified;
  /// 2. **the installed bundles** — a path whose `sha256` is unchanged from the active or
  ///    previous bundle is copied locally instead of fetched. A typical PWA redeploy
  ///    changes `index.html`, the import map and a handful of hashed chunks; every plugin
  ///    and every unchanged asset comes off the device's own disk.
  ///
  /// Both are verified before they are trusted: a local file is not a verified file, and
  /// "it was verified once" is not the same claim as "these bytes hash correctly now".
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
      } catch (_) {
        // Fall through to the network: a failed copy is not a failed update.
      }
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
        // Only the synthesized two are authenticated (`BRIDGE.md` §5); the static routes
        // are public because `import()` cannot send an `Authorization` header.
        final String? token = await auth.token();
        if (token == null) return '${file.path}: no bearer token';
        request = bearerRequest('GET', url, token);
      } else {
        // Unauthenticated, but still not followed: a redirect here would let the server
        // point one manifest-listed path at an arbitrary host, and the per-file hash is
        // the only thing between that and the webview. Fetching what was published is
        // the contract; the hash check would reject it anyway, one round trip later.
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
          // Oversize, caught at the chunk that crosses the line rather than after
          // filling the device: the manifest is the authority on how long a file is.
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
      } catch (_) {
        // The response is already a failure; a failing close adds nothing.
      }
      // A `.part` that survives is a partial download, and the next run must not mistake
      // it for anything else. Only the rename above makes bytes count.
      try {
        if (part.existsSync()) await part.delete();
      } catch (_) {
        // Best effort; `verifyStaged` deletes unlisted files too.
      }
    }
  }

  /// Hash a file on disk against its manifest entry. Returns `null` when it matches.
  ///
  /// Streamed, not buffered: this runs over every file in the bundle twice (once as it
  /// lands, once before the swap) and a wasm module is not something to hold in a phone's
  /// heap twice over.
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

  /// Where a bundle path is fetched from (`BRIDGE.md` §5).
  ///
  /// The two synthesized files have their own route because the browser's versions of them
  /// are deliberately not byte-stable; everything else is fetched from the public URL it is
  /// served at, which is also its path inside the bundle.
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
      } catch (_) {
        // An unservable stray file costs disk, not correctness: the loopback server
        // answers only manifest paths (`BRIDGE.md` §6).
      }
    }
  }
}

/// The one-value sink `sha256.startChunkedConversion` needs. Three lines here rather than a
/// dependency on `package:convert` for its `AccumulatorSink`.
class _DigestSink implements Sink<Digest> {
  late Digest value;

  @override
  void add(Digest data) => value = data;

  @override
  void close() {}
}
