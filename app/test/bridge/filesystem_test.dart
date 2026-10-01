/// `filesystem` — the mapping work, which is where the bugs are (`BRIDGE.md` §4.2).
///
/// The share sheet, the picker and the temp directory are platform channels and cannot run
/// on this gate at all (no device, no Android SDK — `CONTRACTS.md`). Everything that is not
/// a platform channel *is* testable, and it is the part that decides behaviour: which
/// `FileType` an `accept` list becomes, what MIME a name implies, what filename a
/// `Content-Disposition` yields, where the size cap bites, and which frozen error code a
/// non-200 from `GET /api/admin/export` turns into.
library;

import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ddd_shell/bridge/auth.dart';
import 'package:ddd_shell/bridge/bridge.dart';
import 'package:ddd_shell/bridge/filesystem.dart';
import 'package:ddd_shell/config.dart';

/// One share that happened: what the sheet was handed.
class _Shared {
  _Shared(this.file, this.mime, this.name);

  final File file;
  final String mime;
  final String name;

  String get contents => file.readAsStringSync();
}

void main() {
  late Directory temp;
  late AuthStore auth;
  late List<_Shared> shared;
  late bool shareAccepted;

  setUp(() async {
    temp = await Directory.systemTemp.createTemp('ddd-filesystem-test');
    FlutterSecureStorage.setMockInitialValues(<String, String>{
      kTokenKey: 'tok-123',
    });
    auth = AuthStore();
    shared = <_Shared>[];
    shareAccepted = true;
  });

  tearDown(() async {
    if (temp.existsSync()) await temp.delete(recursive: true);
  });

  FilesystemCapability capability({
    http.Client? client,
    PickPort? picker,
    int? maxImportBytes,
  }) => FilesystemCapability(
    config: ShellConfig(serverBaseUrl: Uri.parse('https://life.example.com')),
    auth: auth,
    maxImportBytes: maxImportBytes ?? kMaxImportBytes,
    client: client,
    share: (File file, String mime, String name) async {
      shared.add(_Shared(file, mime, name));
      return shareAccepted;
    },
    picker: picker ?? (PickRequest _) async => const <PickedSource>[],
    temporaryDirectory: () async => temp,
    now: () => DateTime.utc(2026, 10, 1, 8, 30, 15),
  );

  Map<String, Object?> envelope(
    String method, [
    Map<String, Object?>? params,
  ]) => <String, Object?>{
    'v': kBridgeVersion,
    'id': '1',
    'capability': 'filesystem',
    'method': method,
    'params': ?params,
  };

  group('registration', () {
    test('registers the four methods BRIDGE.md §4.2 names', () {
      final ShellBridge bridge = ShellBridge();
      capability().registerOn(bridge);

      expect(bridge.methods, <String>[
        'filesystem.export',
        'filesystem.exportWorkspace',
        'filesystem.importFile',
        'filesystem.pick',
      ]);
    });
  });

  group('export', () {
    test('writes the text and hands the file to the sheet', () async {
      await capability().export(
        const ExportRequest(
          name: 'Groceries.md',
          mime: 'text/markdown',
          text: '# Groceries\n',
        ),
      );

      expect(shared, hasLength(1));
      expect(shared.single.name, 'Groceries.md');
      expect(shared.single.mime, 'text/markdown');
      expect(shared.single.contents, '# Groceries\n');
    });

    test('decodes base64 `data`', () async {
      await capability().export(
        ExportRequest(
          name: 'note.md',
          mime: 'text/markdown',
          base64: base64Encode(utf8.encode('hello')),
        ),
      );

      expect(shared.single.contents, 'hello');
    });

    test('a dismissed sheet is `cancelled`, not a failure', () async {
      shareAccepted = false;
      final ShellBridge bridge = ShellBridge();
      capability().registerOn(bridge);

      final Map<String, Object?> response = await bridge.dispatch(
        envelope('export', <String, Object?>{
          'name': 'note.md',
          'mime': 'text/markdown',
          'text': 'x',
        }),
      );

      expect((response['error']! as Map<String, Object?>)['code'], 'cancelled');
    });

    test('a name from the page cannot escape the export directory', () async {
      await capability().export(
        const ExportRequest(
          name: '../../etc/passwd',
          mime: 'text/plain',
          text: 'x',
        ),
      );

      // `..` flattens to `_`, so the file lands beside the others.
      expect(shared.single.file.parent.path, endsWith(kExportDirName));
      expect(shared.single.name, isNot(contains('/')));
    });

    test('a missing body and a bad base64 are both `invalid`', () async {
      final ShellBridge bridge = ShellBridge();
      capability().registerOn(bridge);

      final Map<String, Object?> empty = await bridge.dispatch(
        envelope('export', <String, Object?>{
          'name': 'note.md',
          'mime': 'text/markdown',
        }),
      );
      final Map<String, Object?> garbage = await bridge.dispatch(
        envelope('export', <String, Object?>{
          'name': 'note.md',
          'mime': 'text/markdown',
          'data': 'not base64!!',
        }),
      );

      expect((empty['error']! as Map<String, Object?>)['code'], 'invalid');
      expect((garbage['error']! as Map<String, Object?>)['code'], 'invalid');
      expect(shared, isEmpty);
    });
  });

  group('pick', () {
    PickPort porting(List<PickedSource> sources) =>
        (PickRequest _) async => sources;

    test('a picked file crosses whole, as base64', () async {
      final List<PickedFile> files = await capability(
        picker: porting(<PickedSource>[
          PickedSource(
            name: 'photo.png',
            size: 5,
            read: () async => <int>[1, 2, 3, 4, 5],
          ),
        ]),
      ).pick(const PickRequest());

      expect(files.single.toJson(), <String, Object?>{
        'name': 'photo.png',
        // No MIME from the picker: the extension is the fallback.
        'mime': 'image/png',
        'size': 5,
        'data': base64Encode(<int>[1, 2, 3, 4, 5]),
      });
    });

    test('the picker\'s own MIME wins over the extension', () async {
      final List<PickedFile> files = await capability(
        picker: porting(<PickedSource>[
          PickedSource(
            name: 'download',
            mime: 'text/markdown',
            read: () async => utf8.encode('# hi'),
          ),
        ]),
      ).pick(const PickRequest());

      expect(files.single.mime, 'text/markdown');
    });

    test('a dismissed picker resolves empty, never `cancelled`', () async {
      final ShellBridge bridge = ShellBridge();
      capability(picker: porting(const <PickedSource>[])).registerOn(bridge);

      final Map<String, Object?> picked = await bridge.dispatch(
        envelope('pick', <String, Object?>{'multiple': true}),
      );
      final Map<String, Object?> imported = await bridge.dispatch(
        envelope('importFile'),
      );

      // A caller should not have to tell "no files" from "changed my mind".
      expect(picked['ok'], isTrue);
      expect(picked['result'], isEmpty);
      expect(imported['ok'], isTrue);
      expect(imported['result'], isNull);
    });

    test(
      'the cap bites on the reported size, before any bytes are read',
      () async {
        bool read = false;
        final FilesystemCapability fs = capability(
          maxImportBytes: 10,
          picker: porting(<PickedSource>[
            PickedSource(
              name: 'big.zip',
              size: 999,
              read: () async {
                read = true;
                return <int>[];
              },
            ),
          ]),
        );

        await expectLater(
          fs.pick(const PickRequest()),
          throwsA(isA<BridgeException>()),
        );
        expect(
          read,
          isFalse,
          reason: 'a 25 MB read is the thing the cap exists to avoid',
        );
      },
    );

    test(
      '… and again on the bytes, when the picker reported no size',
      () async {
        final FilesystemCapability fs = capability(
          maxImportBytes: 4,
          picker: porting(<PickedSource>[
            PickedSource(
              name: 'big.bin',
              read: () async => List<int>.filled(9, 0),
            ),
          ]),
        );

        await expectLater(
          fs.pick(const PickRequest()),
          throwsA(isA<BridgeException>()),
        );
      },
    );

    test(
      'importFile asks the picker for one file whatever the page said',
      () async {
        final List<PickRequest> asked = <PickRequest>[];
        final ShellBridge bridge = ShellBridge();
        capability(
          picker: (PickRequest request) async {
            asked.add(request);
            return <PickedSource>[
              PickedSource(name: 'a.md', read: () async => utf8.encode('a')),
            ];
          },
        ).registerOn(bridge);

        await bridge.dispatch(
          envelope('importFile', <String, Object?>{
            'accept': <String>['.md'],
            'multiple': true,
          }),
        );

        expect(asked.single.multiple, isFalse);
        expect(asked.single.accept, <String>['.md']);
      },
    );
  });

  group('exportWorkspace', () {
    MockClient answering(
      int status, {
      String body = '',
      Map<String, String> headers = const <String, String>{},
    }) => MockClient(
      (http.Request request) async =>
          http.Response(body, status, headers: headers, request: request),
    );

    test(
      'fetches /api/admin/export with the bearer token and shares it',
      () async {
        late http.BaseRequest seen;
        final MockClient client = MockClient((http.Request request) async {
          seen = request;
          return http.Response(
            'PKzip',
            200,
            request: request,
            headers: <String, String>{
              'content-disposition': 'attachment; filename="workspace.zip"',
            },
          );
        });

        await capability(client: client).exportWorkspace();

        expect(
          seen.url,
          Uri.parse('https://life.example.com/api/admin/export'),
        );
        expect(seen.headers['authorization'], 'Bearer tok-123');
        expect(shared.single.name, 'workspace.zip');
        expect(shared.single.mime, 'application/zip');
      },
    );

    test(
      'falls back to a timestamped name when the server names none',
      () async {
        await capability(client: answering(200, body: 'zip')).exportWorkspace();

        // `now` is pinned to 2026-10-01T08:30:15Z in `capability()`.
        expect(shared.single.name, 'ddd-export-20261001-083015.zip');
      },
    );

    test('a 403 is `denied`, because the export is admin-only', () async {
      await expectLater(
        capability(
          client: answering(403, body: '{"error":{"message":"admin only"}}'),
        ).exportWorkspace(),
        throwsA(
          isA<BridgeException>()
              .having(
                (BridgeException e) => e.code,
                'code',
                BridgeErrorCode.denied,
              )
              .having(
                (BridgeException e) => e.message,
                'message',
                contains('admin'),
              ),
        ),
      );
      expect(shared, isEmpty);
    });

    test('a 401 is `denied` too, and a 500 is `failed`', () async {
      await expectLater(
        capability(client: answering(401)).exportWorkspace(),
        throwsA(
          isA<BridgeException>().having(
            (BridgeException e) => e.code,
            'code',
            BridgeErrorCode.denied,
          ),
        ),
      );
      await expectLater(
        capability(client: answering(500)).exportWorkspace(),
        throwsA(
          isA<BridgeException>().having(
            (BridgeException e) => e.code,
            'code',
            BridgeErrorCode.failed,
          ),
        ),
      );
    });

    test('a device with no token is `denied` without a request', () async {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      bool called = false;
      final MockClient client = MockClient((http.Request request) async {
        called = true;
        return http.Response('', 200, request: request);
      });

      await expectLater(
        FilesystemCapability(
          config: ShellConfig(
            serverBaseUrl: Uri.parse('https://life.example.com'),
          ),
          auth: AuthStore(),
          client: client,
          share: (File _, String _, String _) async => true,
          picker: (PickRequest _) async => const <PickedSource>[],
          temporaryDirectory: () async => temp,
        ).exportWorkspace(),
        throwsA(
          isA<BridgeException>().having(
            (BridgeException e) => e.code,
            'code',
            BridgeErrorCode.denied,
          ),
        ),
      );
      expect(called, isFalse);
    });
  });

  group('pickerSelection', () {
    test('extensions become FileType.custom, sorted and dot-less', () {
      final ({FileType type, List<String>? extensions}) selection =
          pickerSelection(<String>['.md', 'txt', '.MD']);

      expect(selection.type, FileType.custom);
      expect(selection.extensions, <String>['md', 'txt']);
    });

    test('a concrete MIME with a known extension becomes that extension', () {
      expect(pickerSelection(<String>['text/markdown']).extensions, <String>[
        'md',
      ]);
    });

    test('one wildcard family becomes its FileType', () {
      expect(pickerSelection(<String>['image/*']).type, FileType.image);
      expect(pickerSelection(<String>['audio/*']).type, FileType.audio);
      expect(
        pickerSelection(<String>['image/*', 'video/*']).type,
        FileType.media,
      );
    });

    test(
      'anything unrepresentable is FileType.any, never a narrower guess',
      () {
        // A picker that hides the file the user came for is a dead end; one that shows too
        // much is a nuisance.
        expect(pickerSelection(const <String>[]).type, FileType.any);
        expect(
          pickerSelection(<String>['application/x-weird']).type,
          FileType.any,
        );
        expect(
          pickerSelection(<String>['image/*', 'audio/*', 'text/*']).type,
          FileType.any,
        );
      },
    );
  });

  group('safeFileName', () {
    test('flattens separators, dotfiles and traversal', () {
      expect(safeFileName('a/b/c.md'), 'a_b_c.md');
      expect(safeFileName(r'a\b.md'), 'a_b.md');
      // Every separator is gone, so the result names one file in one directory
      // however many `..` segments the page put in it.
      expect(safeFileName('../../etc/passwd'), '_.._etc_passwd');
      expect(safeFileName('.hidden'), 'hidden');
      expect(safeFileName('   '), 'download');
      expect(safeFileName('..'), 'download');
    });

    test('keeps the spaces a document title has', () {
      // A share sheet's whole job is to show a name the user recognises.
      expect(safeFileName('Shopping list.md'), 'Shopping list.md');
    });

    test('drops control characters, which reach other apps as header text', () {
      expect(safeFileName('a\nb.md'), 'ab.md');
      expect(safeFileName('a\u0000b.md'), 'ab.md');
      expect(safeFileName('a\u007fb.md'), 'ab.md');
    });

    test('truncates rather than handing a filesystem a name it refuses', () {
      expect(safeFileName('x' * 400).length, 120);
    });
  });

  group('mimeForFileName', () {
    test('knows what a workspace exchanges', () {
      expect(mimeForFileName('note.md'), 'text/markdown');
      expect(mimeForFileName('export.ZIP'), 'application/zip');
      expect(mimeForFileName('feed.ics'), 'text/calendar');
    });

    test('admits ignorance rather than guessing', () {
      expect(mimeForFileName('blob'), 'application/octet-stream');
      expect(mimeForFileName('archive.xyz'), 'application/octet-stream');
      expect(mimeForFileName('trailing.'), 'application/octet-stream');
    });
  });

  group('exportFileName', () {
    final DateTime now = DateTime.utc(2026, 10, 1, 8, 30, 15);

    test('prefers the server\'s Content-Disposition', () {
      expect(
        exportFileName('attachment; filename="workspace.zip"', now: now),
        'workspace.zip',
      );
      expect(
        exportFileName("attachment; filename*=utf-8''my%20notes.zip", now: now),
        'my notes.zip',
      );
    });

    test('does not believe a server that names a path', () {
      expect(
        exportFileName('attachment; filename="../../boot"', now: now),
        isNot(contains('/')),
      );
    });

    test('falls back to a UTC timestamp', () {
      expect(exportFileName(null, now: now), 'ddd-export-20261001-083015.zip');
      expect(
        exportFileName('attachment', now: now),
        'ddd-export-20261001-083015.zip',
      );
    });
  });
}
