/// Fakes for the bundle tests: a bundle, a server that publishes it, and a store on a
/// temp directory.
///
/// The updater is the one part of the shell that cannot be tested with pure functions —
/// its whole job is bytes moving between a network and a disk, and every interesting
/// failure (a truncated body, a rewritten file, an interrupted install) lives in that
/// movement. So these fakes are deliberately literal: a real temp directory, a real
/// `sha256`, and an `http.BaseClient` that streams the bytes it was given.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:life_manager_shell/bridge/auth.dart';
import 'package:life_manager_shell/bundle/manifest.dart';
import 'package:life_manager_shell/bundle/store.dart';
import 'package:life_manager_shell/bundle/updater.dart';

/// The server the tests talk to. Only the origin matters; the paths come from
/// `BRIDGE.md` §5.
final Uri testServer = Uri.parse('https://lm.test');

/// Bundle ids, in the shape the wire actually carries: a 64-character lowercase hex
/// `sha256` (`BRIDGE.md` §5, enforced by [isBundleVersion]).
///
/// Named rather than spelled out at each use because the id is a *path* — the store makes
/// a directory of it — so the tests must exercise the same values the parser lets through.
/// Readable stand-ins like `'v1'` would pass through a store that never sees a real one.
const String idA =
    'aaaaaaaa11111111000000000000000000000000000000000000000000000001';
const String idB =
    'bbbbbbbb22222222000000000000000000000000000000000000000000000002';
const String idC =
    'cccccccc33333333000000000000000000000000000000000000000000000003';
const String idD =
    'dddddddd44444444000000000000000000000000000000000000000000000004';

/// A bundle as the server would publish it: a version, a file set, a min bridge version.
class FakeBundle {
  FakeBundle(this.version, this.files, {this.minBridge = 1});

  final String version;

  /// Path inside the bundle → its text content. Text, not bytes, so a test that changes
  /// one file reads as changing one file.
  final Map<String, String> files;

  final int minBridge;

  Map<String, Object?> manifestJson({Map<String, Object?>? override}) =>
      <String, Object?>{
        'bundle_version': version,
        'min_bridge_version': minBridge,
        'index_csp': "default-src 'self'",
        'files': files.entries
            .map(
              (MapEntry<String, String> entry) => <String, Object?>{
                'path': entry.key,
                'sha256': sha256Hex(utf8.encode(entry.value)),
                'size': utf8.encode(entry.value).length,
              },
            )
            .toList(),
        ...?override,
      };

  BundleManifest get manifest => BundleManifest.fromJson(manifestJson());

  /// The URL path the shell fetches [path] from: the two synthesized files have their own
  /// authenticated route, everything else keeps the public path it is served at.
  static String urlPathFor(String path) =>
      BundleUpdater.synthesizedPaths.contains(path)
      ? '/api/shell/bundle/$path'
      : '/$path';
}

/// One canned response.
class FakeReply {
  FakeReply(this.bytes, {this.status = 200, this.error});

  FakeReply.text(String body, {this.status = 200})
    : bytes = utf8.encode(body),
      error = null;

  FakeReply.json(Object? body)
    : bytes = utf8.encode(jsonEncode(body)),
      status = 200,
      error = null;

  FakeReply.failure(this.error) : bytes = const <int>[], status = 0;

  final List<int> bytes;
  final int status;

  /// Thrown instead of answering — a dropped connection.
  final Object? error;
}

/// An `http.Client` that answers from a map keyed on URL path, and records what was asked
/// for. The recording is the assertion for "a delta update downloads only what changed".
class FakeHttp extends http.BaseClient {
  final Map<String, FakeReply> replies = <String, FakeReply>{};
  final List<String> requested = <String>[];
  final List<String> bearers = <String>[];

  /// `path → followRedirects`, for the one assertion a fake client can make about a
  /// header-forwarding bug it cannot itself reproduce: `dart:io` copies `Authorization`
  /// onto a redirect target regardless of host, so the shell must refuse to follow one.
  final Map<String, bool> followRedirects = <String, bool>{};

  /// Every request after this many is answered by [interruptWith] — a connection that dies
  /// part-way through an install.
  int? failAfter;
  Object interruptWith = const SocketException('connection reset by peer');

  void publish(FakeBundle bundle) {
    replies['/api/shell/manifest'] = FakeReply.json(bundle.manifestJson());
    bundle.files.forEach((String path, String content) {
      replies[FakeBundle.urlPathFor(path)] = FakeReply.text(content);
    });
  }

  /// Requests for bundle files only — the manifest poll is not a download.
  List<String> get downloads => requested
      .where((String path) => path != '/api/shell/manifest')
      .toList(growable: false);

  void clearLog() {
    requested.clear();
    bearers.clear();
  }

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requested.add(request.url.path);
    followRedirects[request.url.path] = request.followRedirects;
    final String? bearer = request.headers['Authorization'];
    if (bearer != null) bearers.add('${request.url.path} $bearer');

    final int? limit = failAfter;
    if (limit != null && requested.length > limit) throw interruptWith;

    final FakeReply? reply = replies[request.url.path];
    if (reply == null) {
      return http.StreamedResponse(const Stream<List<int>>.empty(), 404);
    }
    if (reply.error != null) throw reply.error!;
    return http.StreamedResponse(
      Stream<List<int>>.fromIterable(<List<int>>[reply.bytes]),
      reply.status,
      contentLength: reply.bytes.length,
    );
  }
}

/// An [AuthStore] that never touches the platform keystore.
class FakeAuth extends AuthStore {
  FakeAuth({this.value = 'test-token'});

  String? value;

  @override
  Future<String?> token() async => value;
}

/// Write a bundle straight into the store as an installed version, the way a completed
/// update would leave it. Used by the tests that start from "this device already has a
/// bundle".
Future<void> placeBundle(BundleStore store, FakeBundle bundle) async {
  final Directory dir = store.dirFor(bundle.version);
  await dir.create(recursive: true);
  for (final MapEntry<String, String> entry in bundle.files.entries) {
    final File file = File('${dir.path}/${entry.key}');
    await file.parent.create(recursive: true);
    await file.writeAsString(entry.value, flush: true);
  }
  await File('${dir.path}/$kBundleManifestFile')
      .writeAsString(jsonEncode(bundle.manifestJson()), flush: true);
}

/// The file set of a plausible bundle: the two synthesized documents, a chunk, a plugin.
Map<String, String> bundleFiles({
  String appChunk = 'console.log("v1")',
}) => <String, String>{
  'index.html': '<!doctype html><title>Life Manager</title>',
  'importmap.json': '{"imports":{"react":"/runtime/react.js"}}',
  'assets/app-1a2b3c.js': appChunk,
  'runtime/react.js': 'export default {}',
  'plugins/shell-ui/1.0.0/frontend/index.mjs': 'export function activate() {}',
};
