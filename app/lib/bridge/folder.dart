library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:watcher/watcher.dart';

import 'bridge.dart';

const String kFolderChangedEvent = 'ddd-folder-changed';

const String kFolderStateDir = '.ddd';

const String kFolderTmpDir = '.ddd/tmp';

final StreamController<List<String>> folderChanges =
    StreamController<List<String>>.broadcast();

String folderChangedScript(List<String> paths) =>
    'window.dispatchEvent(new CustomEvent(${jsonEncode(kFolderChangedEvent)}, '
    '{ detail: { paths: ${jsonEncode(paths)} } }));';

typedef DirectoryPickPort = Future<String?> Function();

typedef StoragePermissionPort = Future<bool> Function();

typedef SettingsDirPort = Future<Directory> Function();

typedef WatchPort = Stream<String> Function(Directory root);

Future<String?> pickWithPlatformPicker() =>
    FilePicker.getDirectoryPath(dialogTitle: 'Choose a folder for your notes');

Future<bool> requestAllFilesAccess() async {
  if (await Permission.manageExternalStorage.isGranted) return true;
  if ((await Permission.manageExternalStorage.request()).isGranted) return true;
  return (await Permission.storage.request()).isGranted;
}

Stream<String> watchWithPlatformWatcher(Directory root) =>
    DirectoryWatcher(root.path).events.map((WatchEvent event) => event.path);

class FolderCapability {
  FolderCapability({
    DirectoryPickPort? pickDirectory,
    StoragePermissionPort? requestPermission,
    SettingsDirPort? settingsDirectory,
    WatchPort? watch,
    this.debounce = const Duration(milliseconds: 300),
    StreamSink<List<String>>? changes,
  }) : _pick = pickDirectory ?? pickWithPlatformPicker,
       _permission = requestPermission ?? requestAllFilesAccess,
       _settingsDir = settingsDirectory ?? getApplicationSupportDirectory,
       _watch = watch ?? watchWithPlatformWatcher,
       _changes = changes ?? folderChanges.sink;

  final DirectoryPickPort _pick;
  final StoragePermissionPort _permission;
  final SettingsDirPort _settingsDir;
  final WatchPort _watch;
  final StreamSink<List<String>> _changes;
  final Duration debounce;

  Directory? _root;
  bool _loaded = false;
  StreamSubscription<String>? _watching;
  Timer? _flush;
  final Set<String> _pending = <String>{};

  void registerOn(ShellBridge bridge) {
    bridge.register('folder', 'current', (Map<String, Object?> _) async {
      final Directory? root = await current();
      return root == null ? null : <String, Object?>{'label': root.path};
    });
    bridge.register('folder', 'choose', (Map<String, Object?> _) async {
      final Directory root = await choose();
      return <String, Object?>{'label': root.path};
    });
    bridge.register('folder', 'forget', (Map<String, Object?> _) async {
      await forget();
      return null;
    });
    bridge.register('folder', 'list', (Map<String, Object?> _) async => list());
    bridge.register('folder', 'read', (Map<String, Object?> params) async {
      final File file = await _file(params['path']);
      final List<int> bytes = await file.readAsBytes();
      return <String, Object?>{
        'data': base64Encode(bytes),
        'mtimeMs': (await file.lastModified()).millisecondsSinceEpoch,
      };
    });
    bridge.register('folder', 'write', (Map<String, Object?> params) async {
      final Object? data = params['data'];
      if (data is! String) throw BridgeException.invalid('data is required');
      final List<int> bytes;
      try {
        bytes = base64Decode(data);
      } on FormatException {
        throw BridgeException.invalid('data is not base64');
      }
      return <String, Object?>{'mtimeMs': await write(params['path'], bytes)};
    });
    bridge.register('folder', 'move', (Map<String, Object?> params) async {
      await move(params['from'], params['to']);
      return null;
    });
    bridge.register('folder', 'remove', (Map<String, Object?> params) async {
      await remove(params['path']);
      return null;
    });
  }

  Future<File> _settingsFile() async =>
      File('${(await _settingsDir()).path}/folder.json');

  Future<Directory?> current() async {
    if (!_loaded) {
      _loaded = true;
      try {
        final Object? stored = jsonDecode(
          await (await _settingsFile()).readAsString(),
        );
        final Object? path = stored is Map ? stored['path'] : null;
        if (path is String && await Directory(path).exists()) {
          _root = Directory(path);
          _startWatching();
        }
      } on Object {
        _root = null;
      }
    }
    return _root;
  }

  Future<Directory> choose() async {
    if (!await _permission()) {
      throw BridgeException.denied('all-files access was not granted');
    }
    final String? picked = await _pick();
    if (picked == null || picked.isEmpty) {
      throw BridgeException.cancelled('no folder was chosen');
    }
    final Directory root = Directory(picked);
    await _store(root.path);
    _loaded = true;
    _root = root;
    _startWatching();
    return root;
  }

  Future<void> forget() async {
    await _store(null);
    _loaded = true;
    _root = null;
    await _stopWatching();
  }

  Future<void> _store(String? path) async {
    final File file = await _settingsFile();
    await file.parent.create(recursive: true);
    final File tmp = File('${file.path}.tmp');
    await tmp.writeAsString(jsonEncode(<String, Object?>{'path': path}));
    await tmp.rename(file.path);
  }

  Future<Directory> _requireRoot() async {
    final Directory? root = await current();
    if (root == null) {
      throw BridgeException(BridgeErrorCode.unsupported, 'no folder is chosen');
    }
    return root;
  }

  static List<String> segments(Object? path) {
    if (path is! String ||
        path.isEmpty ||
        path.startsWith('/') ||
        path.contains('\\') ||
        path.contains('\u0000')) {
      throw BridgeException.invalid('not a relative path: $path');
    }
    final List<String> parts = path
        .split('/')
        .where((String s) => s.isNotEmpty)
        .toList(growable: false);
    if (parts.isEmpty) throw BridgeException.invalid('empty path');
    if (parts.any((String s) => s == '.' || s == '..')) {
      throw BridgeException.invalid('path climbs out of the folder');
    }
    return parts;
  }

  Future<String> _resolve(Object? path) async {
    final List<String> parts = segments(path);
    final Directory root = await _requireRoot();
    final String full = <String>[root.path, ...parts].join('/');
    final String canonicalRoot = await root.resolveSymbolicLinks();
    String probe = full;
    while (!await FileSystemEntity.isLink(probe) &&
        await FileSystemEntity.type(probe) == FileSystemEntityType.notFound) {
      final int slash = probe.lastIndexOf('/');
      if (slash <= root.path.length) {
        probe = root.path;
        break;
      }
      probe = probe.substring(0, slash);
    }
    final String real = await File(probe).resolveSymbolicLinks();
    if (real != canonicalRoot && !real.startsWith('$canonicalRoot/')) {
      throw BridgeException.invalid('path leaves the folder through a link');
    }
    return full;
  }

  Future<File> _file(Object? path) async {
    final File file = File(await _resolve(path));
    if (!await file.exists()) {
      throw BridgeException(BridgeErrorCode.failed, 'no such file: $path');
    }
    return file;
  }

  Future<List<Map<String, Object?>>> list() async {
    final Directory root = await _requireRoot();
    final List<Map<String, Object?>> out = <Map<String, Object?>>[];
    await for (final FileSystemEntity entity in root.list(
      recursive: true,
      followLinks: false,
    )) {
      final String rel = entity.path.substring(root.path.length + 1);
      if (rel == kFolderTmpDir || rel.startsWith('$kFolderTmpDir/')) continue;
      final FileStat stat = await entity.stat();
      if (entity is Directory) {
        out.add(<String, Object?>{
          'path': rel,
          'kind': 'dir',
          'size': 0,
          'mtimeMs': stat.modified.millisecondsSinceEpoch,
        });
      } else if (entity is File) {
        out.add(<String, Object?>{
          'path': rel,
          'kind': 'file',
          'size': stat.size,
          'mtimeMs': stat.modified.millisecondsSinceEpoch,
        });
      }
    }
    return out;
  }

  Future<int> write(Object? path, List<int> bytes) async {
    final File target = File(await _resolve(path));
    await target.parent.create(recursive: true);
    final Directory root = await _requireRoot();
    final Directory tmpDir = Directory('${root.path}/$kFolderTmpDir');
    await tmpDir.create(recursive: true);
    final File tmp = File(
      '${tmpDir.path}/$pid-${DateTime.now().microsecondsSinceEpoch}',
    );
    await tmp.writeAsBytes(bytes, flush: true);
    try {
      await tmp.rename(target.path);
    } on FileSystemException {
      await tmp.delete().catchError((Object _) => tmp);
      rethrow;
    }
    return (await target.lastModified()).millisecondsSinceEpoch;
  }

  Future<void> move(Object? from, Object? to) async {
    final String source = await _resolve(from);
    final String target = await _resolve(to);
    if (await FileSystemEntity.type(target) != FileSystemEntityType.notFound) {
      throw BridgeException(BridgeErrorCode.failed, '$to already exists');
    }
    await Directory(target).parent.create(recursive: true);
    await File(source).rename(target);
  }

  Future<void> remove(Object? path) async {
    final String full = await _resolve(path);
    switch (await FileSystemEntity.type(full, followLinks: false)) {
      case FileSystemEntityType.notFound:
        return;
      case FileSystemEntityType.directory:
        await Directory(full).delete();
      default:
        await File(full).delete();
    }
  }

  void _startWatching() {
    unawaited(_stopWatching());
    final Directory? root = _root;
    if (root == null) return;
    _watching = _watch(root).listen((String path) {
      if (!path.startsWith('${root.path}/')) return;
      final String rel = path.substring(root.path.length + 1);
      if (rel == kFolderStateDir || rel.startsWith('$kFolderStateDir/')) {
        return;
      }
      _pending.add(rel);
      _flush?.cancel();
      _flush = Timer(debounce, () {
        final List<String> paths = _pending.toList()..sort();
        _pending.clear();
        _changes.add(paths);
      });
    }, onError: (Object _) {});
  }

  Future<void> _stopWatching() async {
    _flush?.cancel();
    _pending.clear();
    final StreamSubscription<String>? watching = _watching;
    _watching = null;
    await watching?.cancel();
  }

  Future<void> close() => _stopWatching();
}
