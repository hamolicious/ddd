library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:ddd_shell/bridge/auth.dart';
import 'package:ddd_shell/bundle/manifest.dart';
import 'package:ddd_shell/bundle/store.dart';
import 'package:ddd_shell/bundle/updater.dart';

final Uri testServer = Uri.parse('https://ddd.test');

const String idA =
    'aaaaaaaa11111111000000000000000000000000000000000000000000000001';
const String idB =
    'bbbbbbbb22222222000000000000000000000000000000000000000000000002';
const String idC =
    'cccccccc33333333000000000000000000000000000000000000000000000003';
const String idD =
    'dddddddd44444444000000000000000000000000000000000000000000000004';

class FakeBundle {
  FakeBundle(this.version, this.files, {this.minBridge = 1});

  final String version;

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

  static String urlPathFor(String path) =>
      BundleUpdater.synthesizedPaths.contains(path)
      ? '/api/shell/bundle/$path'
      : '/$path';
}

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

  final Object? error;
}

class FakeHttp extends http.BaseClient {
  final Map<String, FakeReply> replies = <String, FakeReply>{};
  final List<String> requested = <String>[];
  final List<String> bearers = <String>[];

  final Map<String, bool> followRedirects = <String, bool>{};

  int? failAfter;
  Object interruptWith = const SocketException('connection reset by peer');

  void publish(FakeBundle bundle) {
    replies['/api/shell/manifest'] = FakeReply.json(bundle.manifestJson());
    bundle.files.forEach((String path, String content) {
      replies[FakeBundle.urlPathFor(path)] = FakeReply.text(content);
    });
  }

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

class FakeAuth extends AuthStore {
  FakeAuth({this.value = 'test-token'});

  String? value;

  @override
  Future<String?> token() async => value;
}

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

Map<String, String> bundleFiles({
  String appChunk = 'console.log("v1")',
}) => <String, String>{
  'index.html': '<!doctype html><title>ddd</title>',
  'importmap.json': '{"imports":{"react":"/runtime/react.js"}}',
  'assets/app-1a2b3c.js': appChunk,
  'runtime/react.js': 'export default {}',
  'plugins/shell-ui/1.0.0/frontend/index.mjs': 'export function activate() {}',
};
