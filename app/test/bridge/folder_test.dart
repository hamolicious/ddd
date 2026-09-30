import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:life_manager_shell/bridge/bridge.dart';
import 'package:life_manager_shell/bridge/folder.dart';

/// The capability over a real temporary directory; the picker, the permission prompt and
/// the watcher are ports.
void main() {
  late Directory sandbox;
  late Directory notes;
  late Directory settings;
  late StreamController<String> watched;
  late StreamController<List<String>> changes;

  FolderCapability capability({bool granted = true, String? picked}) =>
      FolderCapability(
        pickDirectory: () async => picked,
        requestPermission: () async => granted,
        settingsDirectory: () async => settings,
        watch: (Directory _) => watched.stream,
        debounce: const Duration(milliseconds: 10),
        changes: changes.sink,
      );

  Future<Map<String, Object?>> call(
    ShellBridge bridge,
    String method, [
    Map<String, Object?> params = const <String, Object?>{},
  ]) => bridge.dispatch(<String, Object?>{
    'v': 1,
    'id': '1',
    'capability': 'folder',
    'method': method,
    'params': params,
  });

  setUp(() async {
    sandbox = await Directory.systemTemp.createTemp('lm-folder-');
    notes = await Directory('${sandbox.path}/notes').create();
    settings = await Directory('${sandbox.path}/settings').create();
    watched = StreamController<String>.broadcast();
    changes = StreamController<List<String>>.broadcast();
  });

  tearDown(() async {
    unawaited(watched.close());
    unawaited(changes.close());
    await sandbox.delete(recursive: true);
  });

  test(
    'nothing is chosen until the user chooses, and the choice is remembered',
    () async {
      final ShellBridge bridge = ShellBridge();
      capability(picked: notes.path).registerOn(bridge);
      expect((await call(bridge, 'current'))['result'], isNull);
      expect((await call(bridge, 'choose'))['result'], <String, Object?>{
        'label': notes.path,
      });

      final ShellBridge again = ShellBridge();
      capability().registerOn(again);
      expect((await call(again, 'current'))['result'], <String, Object?>{
        'label': notes.path,
      });
    },
  );

  test(
    'a refused permission is denied and a dismissed picker is cancelled',
    () async {
      final ShellBridge refused = ShellBridge();
      capability(granted: false, picked: notes.path).registerOn(refused);
      expect(
        ((await call(refused, 'choose'))['error']!
            as Map<String, Object?>)['code'],
        'denied',
      );
      final ShellBridge dismissed = ShellBridge();
      capability().registerOn(dismissed);
      expect(
        ((await call(dismissed, 'choose'))['error']!
            as Map<String, Object?>)['code'],
        'cancelled',
      );
    },
  );

  test('writes, lists, reads, moves and removes below the root', () async {
    final ShellBridge bridge = ShellBridge();
    capability(picked: notes.path).registerOn(bridge);
    await call(bridge, 'choose');

    final Map<String, Object?> written = await call(
      bridge,
      'write',
      <String, Object?>{
        'path': 'Work/Plans.md',
        'data': base64Encode(utf8.encode('# Plans\n')),
      },
    );
    expect(written['ok'], isTrue);
    expect(File('${notes.path}/Work/Plans.md').readAsStringSync(), '# Plans\n');

    final List<Object?> listed =
        (await call(bridge, 'list'))['result']! as List<Object?>;
    final List<String> paths = listed
        .map((Object? e) => (e! as Map<String, Object?>)['path']! as String)
        .toList();
    expect(paths, containsAll(<String>['Work', 'Work/Plans.md']));
    expect(
      paths.where((String p) => p.startsWith('.life-manager/tmp')),
      isEmpty,
    );

    final Map<String, Object?> read =
        (await call(bridge, 'read', <String, Object?>{
              'path': 'Work/Plans.md',
            }))['result']!
            as Map<String, Object?>;
    expect(utf8.decode(base64Decode(read['data']! as String)), '# Plans\n');

    await call(bridge, 'move', <String, Object?>{
      'from': 'Work/Plans.md',
      'to': 'Home/Plans.md',
    });
    expect(File('${notes.path}/Home/Plans.md').existsSync(), isTrue);
    await call(bridge, 'remove', <String, Object?>{'path': 'Home/Plans.md'});
    expect(File('${notes.path}/Home/Plans.md').existsSync(), isFalse);
    expect(
      (await call(bridge, 'remove', <String, Object?>{
        'path': 'Home/Plans.md',
      }))['ok'],
      isTrue,
    );
  });

  test('refuses paths that climb out, directly or through a link', () async {
    final ShellBridge bridge = ShellBridge();
    capability(picked: notes.path).registerOn(bridge);
    await call(bridge, 'choose');
    Link('${notes.path}/escape').createSync(sandbox.path);
    for (final String bad in <String>[
      '../x',
      '/etc/passwd',
      'a/../../x',
      'escape/settings',
      '',
    ]) {
      final Map<String, Object?> response = await call(
        bridge,
        'read',
        <String, Object?>{'path': bad},
      );
      expect(
        (response['error']! as Map<String, Object?>)['code'],
        'invalid',
        reason: bad,
      );
    }
  });

  test(
    'pushes debounced relative paths, and not its own state directory',
    () async {
      final ShellBridge bridge = ShellBridge();
      capability(picked: notes.path).registerOn(bridge);
      await call(bridge, 'choose');
      final Future<List<String>> first = changes.stream.first;
      watched
        ..add('${notes.path}/Home/Home.md')
        ..add('${notes.path}/.life-manager/index.json')
        ..add('${notes.path}/Home/Home.md');
      expect(await first, <String>['Home/Home.md']);
    },
  );

  test('the event script is the one the page listens for', () {
    expect(
      folderChangedScript(<String>['a.md']),
      'window.dispatchEvent(new CustomEvent("lm-folder-changed", { detail: { paths: ["a.md"] } }));',
    );
  });
}
