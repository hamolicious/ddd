/// `filesystem` — handing files to the user and taking files from them
/// (SPEC §7: "v1 = `filesystem` (export/import)").
///
/// Four methods, two of them generic and two of them named operations:
///
/// | method | what it is |
/// |---|---|
/// | `filesystem.export` | the generic "save these bytes" the kernel's `capabilities.filesystem.export()` calls |
/// | `filesystem.pick` | the generic file picker behind `capabilities.filesystem.pick()` |
/// | `filesystem.exportWorkspace` | the admin export zip (SPEC §5.1), fetched natively and shared |
/// | `filesystem.importFile` | `pick`, single file, for a UI that wants exactly one |
///
/// The generic pair is what the frozen web-side capability API is written against
/// (`web/kernel-api/src/capabilities.ts`); the named pair is what M5's UI actually calls.
/// Both are registered, because "export the workspace" is *not* expressible as
/// `export(bytes)` from inside the page: the zip is a streamed multi-megabyte response
/// from `GET /api/admin/export`, and routing it through JavaScript would mean holding the
/// whole archive in the webview's heap. The shell streams it straight to a file instead.
///
/// **`exportWorkspace` is admin-only, server-side.** The export endpoint is under
/// `/api/admin`, so a non-admin gets a 403 no matter what the bridge reports. The UI must
/// gate the affordance on the user's admin flag, not on capability presence.
///
/// # Ports, and why they exist
///
/// The share sheet, the picker and the temp directory are all platform channels: on the
/// gate (`mise run shell-test`, no device and no Android SDK) they cannot be called at all.
/// Each is therefore reached through an injectable function — [SharePort], [PickPort],
/// [TempDirPort] — whose default implementation is the real plugin. The mapping work, which
/// is where the bugs live (which `FileType` an `accept` list becomes, what MIME a name
/// implies, what filename a `Content-Disposition` yields, where the size cap bites), is
/// pure and tested.
library;

import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../config.dart';
import 'auth.dart';
import 'bridge.dart';

/// The largest file the shell will hand to the page.
///
/// It is a *heap* bound, not a policy: a picked file crosses the bridge as base64 inside a
/// JSON envelope (`BRIDGE.md` §2), so the webview holds roughly 1.4× this in one string
/// before the page has even decoded it. 25 MB matches `MAX_ATTACHMENT_BYTES`
/// (SPEC §3.5), so anything the server would accept as an attachment can be imported, and
/// anything larger fails with a message rather than an out-of-memory webview.
const int kMaxImportBytes = 25 * 1024 * 1024;

/// Where exports are staged before they are handed to the share sheet. One directory under
/// the cache dir, so the OS may reclaim it and the next export can prune it wholesale.
const String kExportDirName = 'lm-export';

/// A file the page wants saved. Exactly one of [text] and [base64] is set
/// (`BRIDGE.md` §4.2).
class ExportRequest {
  const ExportRequest({
    required this.name,
    required this.mime,
    this.text,
    this.base64,
  });

  factory ExportRequest.fromParams(Map<String, Object?> params) {
    final Object? name = params['name'];
    final Object? mime = params['mime'];
    final Object? text = params['text'];
    final Object? data = params['data'];
    if (name is! String || name.isEmpty) {
      throw BridgeException.invalid('name is required');
    }
    if (text is! String? || data is! String?) {
      throw BridgeException.invalid(
        'text and data must be strings when present',
      );
    }
    if (text == null && data == null) {
      throw BridgeException.invalid('one of text or data is required');
    }
    return ExportRequest(
      name: name,
      mime: mime is String && mime.isNotEmpty
          ? mime
          : 'application/octet-stream',
      text: text,
      base64: data,
    );
  }

  final String name;
  final String mime;
  final String? text;

  /// Base64, because only JSON crosses the bridge (`BRIDGE.md` §2).
  final String? base64;

  /// The bytes to write, decoded.
  ///
  /// A `data` that is not base64 is the page's bug, so it is [BridgeErrorCode.invalid] —
  /// not `failed`. `base64Decode` throws [FormatException], which would otherwise reach
  /// `dispatch` as an anonymous error and tell the caller nothing about which field was
  /// wrong.
  List<int> bytes() {
    final String? encoded = base64;
    if (encoded == null) return utf8.encode(text ?? '');
    try {
      return base64Decode(encoded);
    } on FormatException catch (error) {
      throw BridgeException.invalid('data is not base64: ${error.message}');
    }
  }
}

/// What the page asked the picker for.
class PickRequest {
  const PickRequest({this.accept = const <String>[], this.multiple = false});

  factory PickRequest.fromParams(Map<String, Object?> params) {
    final Object? accept = params['accept'];
    final Object? multiple = params['multiple'];
    return PickRequest(
      accept: accept is List
          ? accept.whereType<String>().toList(growable: false)
          : const <String>[],
      multiple: multiple == true,
    );
  }

  /// MIME types and/or extensions, as the web `accept` attribute allows.
  final List<String> accept;
  final bool multiple;
}

/// One picked file, as the page receives it: `{ name, mime, size, data }` with `data`
/// base64. The whole file comes across, because a native picker's file has no `File`
/// object in the page's realm to read from later (`BRIDGE.md` §4.2).
class PickedFile {
  const PickedFile({
    required this.name,
    required this.mime,
    required this.size,
    required this.base64,
  });

  final String name;
  final String mime;
  final int size;
  final String base64;

  Map<String, Object?> toJson() => <String, Object?>{
    'name': name,
    'mime': mime,
    'size': size,
    'data': base64,
  };
}

/// One file the picker produced, before it is read and encoded.
///
/// A neutral shape rather than `file_picker`'s `PlatformFile`, for one reason that matters
/// on the gate: `PlatformFile` is a `base` class tied to the plugin's platform channels, so
/// a test cannot make one. Keeping the read lazy also means the size cap is enforced
/// *before* the bytes exist, when the picker told us the size.
class PickedSource {
  const PickedSource({
    required this.name,
    required this.read,
    this.size,
    this.mime,
  });

  final String name;

  /// What the picker reported, or `null` when it reported nothing. When it is `null` the
  /// cap is enforced after reading instead — correct either way, cheaper when it is known.
  final int? size;

  /// The picker's own MIME, when it has one. Android's pickers usually do not, so
  /// [mimeForFileName] is the fallback.
  final String? mime;

  final Future<List<int>> Function() read;
}

/// Hands a file on disk to the platform's share/save sheet. `false` means the user
/// dismissed it.
typedef SharePort = Future<bool> Function(File file, String mime, String name);

/// Opens the platform's file picker. An empty list means the user dismissed it
/// (`BRIDGE.md` §4.2: dismissal is not an error).
typedef PickPort = Future<List<PickedSource>> Function(PickRequest request);

/// The directory exports are staged in. The cache dir, not documents: these files exist
/// for the seconds between writing them and the share target reading them.
typedef TempDirPort = Future<Directory> Function();

/// The `filesystem` capability. Owned by the shell-bridge area.
class FilesystemCapability {
  FilesystemCapability({
    required this.config,
    required this.auth,
    this.maxImportBytes = kMaxImportBytes,
    http.Client? client,
    SharePort? share,
    PickPort? picker,
    TempDirPort? temporaryDirectory,
    DateTime Function()? now,
  }) : _client = client ?? http.Client(),
       _share = share ?? shareWithPlatformSheet,
       _pick = picker ?? pickWithPlatformPicker,
       _tempDir = temporaryDirectory ?? getTemporaryDirectory,
       _now = now ?? DateTime.now;

  final ShellConfig config;
  final AuthStore auth;

  /// See [kMaxImportBytes].
  final int maxImportBytes;

  final http.Client _client;
  final SharePort _share;
  final PickPort _pick;
  final TempDirPort _tempDir;
  final DateTime Function() _now;

  void registerOn(ShellBridge bridge) {
    bridge.register('filesystem', 'export', (
      Map<String, Object?> params,
    ) async {
      await export(ExportRequest.fromParams(params));
      return null;
    });
    bridge.register('filesystem', 'pick', (Map<String, Object?> params) async {
      final List<PickedFile> files = await pick(PickRequest.fromParams(params));
      return files
          .map((PickedFile file) => file.toJson())
          .toList(growable: false);
    });
    bridge.register('filesystem', 'exportWorkspace', (
      Map<String, Object?> _,
    ) async {
      await exportWorkspace();
      return null;
    });
    bridge.register('filesystem', 'importFile', (
      Map<String, Object?> params,
    ) async {
      final PickRequest request = PickRequest.fromParams(params);
      final List<PickedFile> files = await pick(
        PickRequest(accept: request.accept, multiple: false),
      );
      return files.isEmpty ? null : files.first.toJson();
    });
  }

  /// Write the bytes to a cache file and hand it to the Android share/save sheet.
  ///
  /// A cancelled sheet is [BridgeErrorCode.cancelled], not a failure. Cache files are
  /// pruned on the next export — the share target may still be reading when this returns,
  /// so deleting immediately is a race.
  Future<void> export(ExportRequest request) async {
    final File file = await _stage(
      safeFileName(request.name),
      (IOSink sink) async => sink.add(request.bytes()),
    );
    await _handOver(file, request.mime, safeFileName(request.name));
  }

  /// The platform picker, mapped through [pickerSelection] and capped by [maxImportBytes].
  ///
  /// Dismissal resolves **empty**, never an error — that is what the web-side fallback
  /// does, and a plugin should not have to tell "no files" from "cancelled".
  Future<List<PickedFile>> pick(PickRequest request) async {
    final List<PickedSource> sources = await _pick(request);
    final List<PickedFile> files = <PickedFile>[];
    for (final PickedSource source in sources) {
      final String name = safeFileName(source.name);
      final int? reported = source.size;
      if (reported != null && reported > maxImportBytes) {
        throw _tooLarge(name, reported);
      }
      final List<int> bytes = await source.read();
      if (bytes.length > maxImportBytes) {
        throw _tooLarge(name, bytes.length);
      }
      files.add(
        PickedFile(
          name: name,
          mime: source.mime ?? mimeForFileName(name),
          size: bytes.length,
          base64: base64Encode(bytes),
        ),
      );
    }
    return files;
  }

  /// `GET /api/admin/export` streamed to a temp file, then shared (SPEC §5.1: "the
  /// no-Mongo disaster-recovery path").
  ///
  /// Streamed, not buffered: the response is a zip of every document. A 403 means the user
  /// is not an admin and surfaces as [BridgeErrorCode.denied] so the page can say why.
  Future<void> exportWorkspace() async {
    final String? token = await auth.token();
    if (token == null) {
      throw BridgeException.denied('this device is not signed in');
    }
    final Uri url = config.api('/admin/export');
    final http.StreamedResponse response;
    try {
      // `bearerRequest`, not a hand-rolled header: it also refuses to follow redirects,
      // which `dart:io` would otherwise follow *with the `Authorization` header attached*
      // to whatever host the `Location` names (bridge/auth.dart).
      response = await _client.send(
        bearerRequest('GET', url, token)..headers['accept'] = 'application/zip',
      );
    } on http.ClientException catch (error) {
      throw BridgeException(
        BridgeErrorCode.failed,
        'could not reach ${url.origin}: ${error.message}',
      );
    } on SocketException catch (error) {
      throw BridgeException(
        BridgeErrorCode.failed,
        'could not reach ${url.origin}: ${error.message}',
      );
    }

    if (response.statusCode != HttpStatus.ok) {
      // Drained so the socket is returned to the pool rather than left half-read.
      final String body = await response.stream.bytesToString().catchError(
        (Object _) => '',
      );
      throw _httpFailure(response.statusCode, body);
    }

    final String name = exportFileName(
      response.headers['content-disposition'],
      now: _now(),
    );
    final File file = await _stage(
      name,
      (IOSink sink) => sink.addStream(response.stream),
    );
    await _handOver(file, 'application/zip', name);
  }

  /// Prune the export directory, then write one file into it.
  ///
  /// Pruning happens *before* the write, not after the share: the share target may still be
  /// reading the previous file when the sheet closes, and deleting it then is a race that
  /// shows up as an empty file in another app.
  Future<File> _stage(
    String name,
    Future<void> Function(IOSink sink) write,
  ) async {
    final Directory root = Directory(
      '${(await _tempDir()).path}/$kExportDirName',
    );
    if (root.existsSync()) {
      try {
        await root.delete(recursive: true);
      } on FileSystemException {
        // A file another app still holds open is not a reason to fail this export.
      }
    }
    await root.create(recursive: true);
    final File file = File('${root.path}/$name');
    final IOSink sink = file.openWrite();
    try {
      await write(sink);
    } finally {
      await sink.close();
    }
    return file;
  }

  Future<void> _handOver(File file, String mime, String name) async {
    final bool shared = await _share(file, mime, name);
    if (!shared) {
      throw BridgeException.cancelled('the share sheet was dismissed');
    }
  }

  BridgeException _tooLarge(String name, int size) => BridgeException(
    BridgeErrorCode.failed,
    '$name is ${(size / (1024 * 1024)).toStringAsFixed(1)} MB; the shell hands the '
    'app at most ${maxImportBytes ~/ (1024 * 1024)} MB',
  );

  void close() => _client.close();
}

/// Maps a non-200 from the export endpoint onto the frozen error vocabulary.
///
/// 401 and 403 are both [BridgeErrorCode.denied]: the export is admin-only (SPEC §5.1), so
/// "not signed in" and "not an admin" are the same sentence to the user, and the page must
/// gate the affordance on the admin flag rather than on this answer.
BridgeException _httpFailure(int status, String body) {
  final String message = _errorMessage(body) ?? 'HTTP $status';
  return switch (status) {
    HttpStatus.unauthorized => BridgeException.denied(
      'the server rejected this device\'s token ($message)',
    ),
    HttpStatus.forbidden => BridgeException.denied(
      'exporting the workspace is admin-only ($message)',
    ),
    _ => BridgeException(
      BridgeErrorCode.failed,
      'the export failed: $message${redirectNote(status)}',
    ),
  };
}

/// Pulls `error.message` out of the server's error body
/// (`backend/crates/server/src/error.rs`), or `null` when the body is not one.
String? _errorMessage(String body) {
  if (body.isEmpty) return null;
  try {
    final Object? decoded = jsonDecode(body);
    if (decoded is Map && decoded['error'] is Map) {
      final Object? message = (decoded['error'] as Map)['message'];
      if (message is String && message.isNotEmpty) return message;
    }
  } on FormatException {
    return null;
  }
  return null;
}

/// What the `accept` list means to `file_picker`.
///
/// The web spells `accept` as MIME types, MIME wildcards and extensions, in any mixture;
/// `file_picker` takes one [FileType] plus, for [FileType.custom], a list of dot-less
/// extensions. The mapping is deliberately conservative: anything it cannot express becomes
/// [FileType.any], because a picker that shows too much is a nuisance and a picker that
/// hides the file the user came for is a dead end.
({FileType type, List<String>? extensions}) pickerSelection(
  List<String> accept,
) {
  final Set<String> extensions = <String>{};
  final Set<String> families = <String>{};
  for (final String raw in accept) {
    final String entry = raw.trim().toLowerCase();
    if (entry.isEmpty) continue;
    if (entry.contains('/')) {
      final List<String> parts = entry.split('/');
      if (parts.length != 2) continue;
      if (parts[1] == '*') {
        families.add(parts[0]);
      } else {
        // A concrete MIME is only usable if a known extension maps to it; `file_picker`
        // has no MIME mode on Android.
        final String? extension = _extensionForMime[entry];
        if (extension != null) {
          extensions.add(extension);
        } else {
          families.add(parts[0]);
        }
      }
      continue;
    }
    final String cleaned = entry.startsWith('.') ? entry.substring(1) : entry;
    if (cleaned.isNotEmpty && !cleaned.contains('.')) extensions.add(cleaned);
  }

  if (extensions.isNotEmpty) {
    return (
      type: FileType.custom,
      extensions: extensions.toList(growable: false)..sort(),
    );
  }
  if (families.length == 1) {
    return switch (families.single) {
      'image' => (type: FileType.image, extensions: null),
      'video' => (type: FileType.video, extensions: null),
      'audio' => (type: FileType.audio, extensions: null),
      _ => (type: FileType.any, extensions: null),
    };
  }
  if (families.length == 2 &&
      families.containsAll(const <String>['image', 'video'])) {
    return (type: FileType.media, extensions: null);
  }
  return (type: FileType.any, extensions: null);
}

/// A filename that cannot escape the directory it is written into, and cannot be a dotfile.
///
/// The name comes from the page, which is full-trust (SPEC §6.1) and therefore not to be
/// trusted with a path. Separators, NUL and traversal all collapse to `_`; an empty result
/// becomes `download`.
String safeFileName(String name) {
  final String flattened = name
      // Control characters go for a reason beyond tidiness: a newline in a name
      // reaches `Content-Disposition` in whatever app receives the share, and a NUL
      // truncates a path in every C API underneath `dart:io`.
      .replaceAll(RegExp('[\u0000-\u001f\u007f]'), '')
      .replaceAll(RegExp(r'[\\/]'), '_')
      .replaceAll(RegExp(r'^\.+'), '')
      .trim();
  if (flattened.isEmpty || flattened == '.' || flattened == '..') {
    return 'download';
  }
  // Long enough for any sane title, short of every filesystem's per-name limit.
  return flattened.length <= 120 ? flattened : flattened.substring(0, 120);
}

/// The MIME a filename implies, for a picker that reported none.
///
/// `application/octet-stream` is the honest answer for anything unlisted: `nosniff` is on
/// everywhere the page might render it, so a guess would be worse than an admission.
String mimeForFileName(String name) {
  final int dot = name.lastIndexOf('.');
  if (dot < 0 || dot == name.length - 1) return 'application/octet-stream';
  return _mimeForExtension[name.substring(dot + 1).toLowerCase()] ??
      'application/octet-stream';
}

/// The filename for a workspace export: the server's `Content-Disposition` when it gave
/// one, otherwise a timestamped name.
///
/// The header's value is still run through [safeFileName] — it arrives over the network,
/// and a server that says `filename="../../boot"` must not be believed.
String exportFileName(String? contentDisposition, {required DateTime now}) {
  final String? fromHeader = _dispositionFilename(contentDisposition);
  if (fromHeader != null && fromHeader.isNotEmpty) {
    return safeFileName(fromHeader);
  }
  final DateTime stamp = now.toUtc();
  String two(int value) => value.toString().padLeft(2, '0');
  return 'life-manager-export-${stamp.year}${two(stamp.month)}${two(stamp.day)}'
      '-${two(stamp.hour)}${two(stamp.minute)}${two(stamp.second)}.zip';
}

String? _dispositionFilename(String? header) {
  if (header == null) return null;
  final RegExpMatch? extended = RegExp(
    r"filename\*\s*=\s*utf-8''([^;]+)",
    caseSensitive: false,
  ).firstMatch(header);
  if (extended != null) {
    try {
      return Uri.decodeComponent(extended.group(1)!.trim());
    } on ArgumentError {
      // A broken percent-escape is not worth failing an export over.
    }
  }
  final RegExpMatch? plain = RegExp(
    r'filename\s*=\s*"?([^";]+)"?',
    caseSensitive: false,
  ).firstMatch(header);
  return plain?.group(1)?.trim();
}

/// Extension → MIME, for [mimeForFileName]. Everything a Life Manager workspace actually
/// exchanges: markdown, the export zip, attachments.
const Map<String, String> _mimeForExtension = <String, String>{
  'md': 'text/markdown',
  'markdown': 'text/markdown',
  'txt': 'text/plain',
  'json': 'application/json',
  'yaml': 'application/yaml',
  'yml': 'application/yaml',
  'csv': 'text/csv',
  'html': 'text/html',
  'ics': 'text/calendar',
  'zip': 'application/zip',
  'pdf': 'application/pdf',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'heic': 'image/heic',
  'mp3': 'audio/mpeg',
  'm4a': 'audio/mp4',
  'ogg': 'audio/ogg',
  'wav': 'audio/wav',
  'mp4': 'video/mp4',
  'webm': 'video/webm',
};

/// MIME → extension, for [pickerSelection]. Derived by hand from [_mimeForExtension]
/// rather than inverted at runtime, because the inverse is ambiguous (`image/jpeg` has two)
/// and the picker wants the spelling users see.
const Map<String, String> _extensionForMime = <String, String>{
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/plain': 'txt',
  'application/json': 'json',
  'application/yaml': 'yaml',
  'text/yaml': 'yaml',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/calendar': 'ics',
  'application/zip': 'zip',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

// ---------------------------------------------------------------------------
// The default ports: the real plugins.
// ---------------------------------------------------------------------------

/// [SharePort] backed by `share_plus`.
///
/// `ShareResultStatus.unavailable` counts as shared: Android only reports which action the
/// user picked on recent versions, and treating "cannot tell" as a dismissal would report
/// `cancelled` for a successful save.
Future<bool> shareWithPlatformSheet(File file, String mime, String name) async {
  final ShareResult result = await SharePlus.instance.share(
    ShareParams(
      files: <XFile>[XFile(file.path, mimeType: mime, name: name)],
      fileNameOverrides: <String>[name],
    ),
  );
  return result.status != ShareResultStatus.dismissed;
}

/// [PickPort] backed by `file_picker`.
Future<List<PickedSource>> pickWithPlatformPicker(PickRequest request) async {
  final ({FileType type, List<String>? extensions}) selection = pickerSelection(
    request.accept,
  );
  final List<PlatformFile> picked = request.multiple
      ? await FilePicker.pickFiles(
          type: selection.type,
          allowedExtensions: selection.extensions,
        )
      : <PlatformFile>[
          ?await FilePicker.pickFile(
            type: selection.type,
            allowedExtensions: selection.extensions,
          ),
        ];
  return picked
      .map(
        (PlatformFile file) => PickedSource(
          name: file.name,
          size: file.lengthSync(),
          // Android's SAF picker reports the MIME the *provider* declares, which is a
          // better answer than the extension for a file that came out of another app's
          // storage (`content://…/1234` has no extension at all). `mimeForFileName` stays
          // as the fallback for the platforms and providers that report nothing.
          mime: _nonEmpty(file.xFile.mimeType),
          read: file.readAsBytes,
        ),
      )
      .toList(growable: false);
}

String? _nonEmpty(String? value) =>
    value == null || value.isEmpty ? null : value;
