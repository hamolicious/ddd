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

const int kMaxImportBytes = 25 * 1024 * 1024;

const String kExportDirName = 'ddd-export';

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

  final String? base64;

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

  final List<String> accept;
  final bool multiple;
}

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

class PickedSource {
  const PickedSource({
    required this.name,
    required this.read,
    this.size,
    this.mime,
  });

  final String name;

  final int? size;

  final String? mime;

  final Future<List<int>> Function() read;
}

typedef SharePort = Future<bool> Function(File file, String mime, String name);

typedef PickPort = Future<List<PickedSource>> Function(PickRequest request);

typedef TempDirPort = Future<Directory> Function();

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

  Future<void> export(ExportRequest request) async {
    final File file = await _stage(
      safeFileName(request.name),
      (IOSink sink) async => sink.add(request.bytes()),
    );
    await _handOver(file, request.mime, safeFileName(request.name));
  }

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

  Future<void> exportWorkspace() async {
    final String? token = await auth.token();
    if (token == null) {
      throw BridgeException.denied('this device is not signed in');
    }
    final Uri url = config.api('/admin/export');
    final http.StreamedResponse response;
    try {
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
      } on FileSystemException {}
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

String safeFileName(String name) {
  final String flattened = name
      .replaceAll(RegExp('[\u0000-\u001f\u007f]'), '')
      .replaceAll(RegExp(r'[\\/]'), '_')
      .replaceAll(RegExp(r'^\.+'), '')
      .trim();
  if (flattened.isEmpty || flattened == '.' || flattened == '..') {
    return 'download';
  }
  return flattened.length <= 120 ? flattened : flattened.substring(0, 120);
}

String mimeForFileName(String name) {
  final int dot = name.lastIndexOf('.');
  if (dot < 0 || dot == name.length - 1) return 'application/octet-stream';
  return _mimeForExtension[name.substring(dot + 1).toLowerCase()] ??
      'application/octet-stream';
}

String exportFileName(String? contentDisposition, {required DateTime now}) {
  final String? fromHeader = _dispositionFilename(contentDisposition);
  if (fromHeader != null && fromHeader.isNotEmpty) {
    return safeFileName(fromHeader);
  }
  final DateTime stamp = now.toUtc();
  String two(int value) => value.toString().padLeft(2, '0');
  return 'ddd-export-${stamp.year}${two(stamp.month)}${two(stamp.day)}'
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
    } on ArgumentError {}
  }
  final RegExpMatch? plain = RegExp(
    r'filename\s*=\s*"?([^";]+)"?',
    caseSensitive: false,
  ).firstMatch(header);
  return plain?.group(1)?.trim();
}

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

Future<bool> shareWithPlatformSheet(File file, String mime, String name) async {
  final ShareResult result = await SharePlus.instance.share(
    ShareParams(
      files: <XFile>[XFile(file.path, mimeType: mime, name: name)],
      fileNameOverrides: <String>[name],
    ),
  );
  return result.status != ShareResultStatus.dismissed;
}

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
          mime: _nonEmpty(file.xFile.mimeType),
          read: file.readAsBytes,
        ),
      )
      .toList(growable: false);
}

String? _nonEmpty(String? value) =>
    value == null || value.isEmpty ? null : value;
