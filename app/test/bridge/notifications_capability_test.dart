library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ddd_shell/bridge/bridge.dart';
import 'package:ddd_shell/bridge/notifications.dart';
import 'package:ddd_shell/config.dart';

class _Call {
  _Call(this.kind, {this.notification, this.androidId, this.tag});

  final String kind;
  final ScheduledNotification? notification;
  final int? androidId;
  final String? tag;

  @override
  String toString() =>
      '$kind(${notification?.id ?? androidId}${tag == null ? '' : ', tag: $tag'})';
}

class _FakePort implements NotificationPort {
  bool? permissionPrompt = true;

  bool? enabled = true;

  final List<_Call> calls = <_Call>[];
  int initializeCount = 0;

  List<_Call> ofKind(String kind) =>
      calls.where((_Call call) => call.kind == kind).toList(growable: false);

  @override
  Future<void> initialize() async => initializeCount++;

  @override
  Future<bool?> requestPermission() async {
    calls.add(_Call('request'));
    if (permissionPrompt != null) enabled = permissionPrompt;
    return permissionPrompt;
  }

  @override
  Future<bool?> areEnabled() async => enabled;

  @override
  Future<void> show(ScheduledNotification notification) async =>
      calls.add(_Call('show', notification: notification));

  @override
  Future<void> schedule(ScheduledNotification notification) async =>
      calls.add(_Call('schedule', notification: notification));

  @override
  Future<void> cancel(int androidId, {String? tag}) async =>
      calls.add(_Call('cancel', androidId: androidId, tag: tag));
}

void main() {
  late Directory support;
  late _FakePort port;
  DateTime now = DateTime.utc(2026, 10, 1, 8, 0);

  setUp(() async {
    support = await Directory.systemTemp.createTemp('ddd-notifications-test');
    port = _FakePort();
    now = DateTime.utc(2026, 10, 1, 8, 0);
  });

  tearDown(() async {
    if (support.existsSync()) await support.delete(recursive: true);
  });

  NotificationsCapability build() => NotificationsCapability(
    port: port,
    supportDirectory: () async => support,
    now: () => now,
  );

  Map<String, Object?> envelope(
    String method, [
    Map<String, Object?>? params,
  ]) => <String, Object?>{
    'v': kBridgeVersion,
    'id': '1',
    'capability': 'notifications',
    'method': method,
    'params': ?params,
  };

  Future<ShellBridge> wired([NotificationsCapability? capability]) async {
    final NotificationsCapability notifications = capability ?? build();
    await notifications.initialize();
    return ShellBridge()..let(notifications.registerOn);
  }

  group('registration', () {
    test('registers the six methods BRIDGE.md §4.3 names', () async {
      final ShellBridge bridge = await wired();

      expect(bridge.methods, <String>[
        'notifications.cancel',
        'notifications.list',
        'notifications.notify',
        'notifications.permission',
        'notifications.request',
        'notifications.schedule',
      ]);
    });
  });

  group('permission', () {
    test('an un-asked device is `default`, not `denied`', () async {
      port.enabled = false;
      final NotificationsCapability notifications = build();

      await notifications.initialize();

      expect(notifications.permission, kPermissionDefault);
    });

    test('a granted prompt becomes `granted`', () async {
      port
        ..enabled = false
        ..permissionPrompt = true;
      final NotificationsCapability notifications = build();

      expect(await notifications.request(), kPermissionGranted);
      expect(notifications.permission, kPermissionGranted);
    });

    test('a refused prompt becomes `denied`, and survives a restart', () async {
      port
        ..enabled = false
        ..permissionPrompt = false;

      expect(await build().request(), kPermissionDenied);

      final NotificationsCapability relaunched = build();
      await relaunched.initialize();
      expect(relaunched.permission, kPermissionDenied);
    });

    test('a platform with no runtime prompt asks the OS instead', () async {
      port
        ..permissionPrompt = null
        ..enabled = true;

      expect(await build().request(), kPermissionGranted);
    });

    test(
      'scheduling into a denied permission is `denied`, not silence',
      () async {
        port
          ..enabled = false
          ..permissionPrompt = false;
        final NotificationsCapability notifications = build();
        await notifications.request();
        final ShellBridge bridge = ShellBridge()..let(notifications.registerOn);

        final Map<String, Object?> response = await bridge.dispatch(
          envelope('schedule', <String, Object?>{
            'title': 'x',
            'atIso': '2026-10-02T08:00:00Z',
          }),
        );

        expect((response['error']! as Map<String, Object?>)['code'], 'denied');
        expect(port.ofKind('schedule'), isEmpty);
      },
    );
  });

  group('schedule', () {
    test('hands the plugin the instant and returns the id', () async {
      final ShellBridge bridge = await wired();

      final Map<String, Object?> response = await bridge.dispatch(
        envelope('schedule', <String, Object?>{
          'id': 'reminder-1',
          'title': 'Water the plants',
          'route': '/doc/01J',
          'atIso': '2026-10-02T08:00:00.000Z',
        }),
      );

      expect(response['result'], 'reminder-1');
      final ScheduledNotification sent = port
          .ofKind('schedule')
          .single
          .notification!;
      expect(sent.id, 'reminder-1');
      expect(sent.at, DateTime.utc(2026, 10, 2, 8));
      expect(sent.androidId, nativeId('reminder-1'));
    });

    test('re-scheduling one id replaces it instead of stacking', () async {
      final NotificationsCapability notifications = build();
      await notifications.initialize();

      await notifications.schedule(
        ScheduledNotification.fromParams(<String, Object?>{
          'id': 'r1',
          'title': 'first',
          'atIso': '2026-10-02T08:00:00Z',
        }),
      );
      await notifications.schedule(
        ScheduledNotification.fromParams(<String, Object?>{
          'id': 'r1',
          'title': 'second',
          'atIso': '2026-10-03T08:00:00Z',
        }),
      );

      expect(port.ofKind('schedule'), hasLength(2));
      expect(notifications.pending, hasLength(1));
      expect(notifications.pending.single.title, 'second');
    });

    test(
      'an instant in the past fires now and is not listed as pending',
      () async {
        final NotificationsCapability notifications = build();
        await notifications.initialize();

        await notifications.schedule(
          ScheduledNotification.fromParams(<String, Object?>{
            'id': 'late',
            'title': 'overdue',
            'atIso': '2026-09-30T08:00:00Z',
          }),
        );

        expect(port.ofKind('show'), hasLength(1));
        expect(port.ofKind('schedule'), isEmpty);
        expect(notifications.pending, isEmpty);
      },
    );

    test(
      'an absurd lead time is `invalid` rather than dropped by the OS',
      () async {
        final ShellBridge bridge = await wired();

        final Map<String, Object?> response = await bridge.dispatch(
          envelope('schedule', <String, Object?>{
            'title': 'x',
            'atIso': '2050-01-01T00:00:00Z',
          }),
        );

        expect((response['error']! as Map<String, Object?>)['code'], 'invalid');
      },
    );
  });

  group('notify', () {
    test('fires immediately and is never recorded as pending', () async {
      final NotificationsCapability notifications = build();
      final ShellBridge bridge = ShellBridge()..let(notifications.registerOn);

      final Map<String, Object?> response = await bridge.dispatch(
        envelope('notify', <String, Object?>{
          'title': 'Saved',
          'tag': 'doc:01J',
        }),
      );

      expect(response['ok'], isTrue);
      expect(port.ofKind('show').single.notification!.title, 'Saved');
      expect(notifications.pending, isEmpty);
    });
  });

  group('cancel', () {
    test(
      'cancels by the derived Android id, with the registry\'s tag',
      () async {
        final NotificationsCapability notifications = build();
        await notifications.initialize();
        await notifications.schedule(
          ScheduledNotification.fromParams(<String, Object?>{
            'id': 'r1',
            'title': 'x',
            'tag': 'doc:01J',
            'atIso': '2026-10-02T08:00:00Z',
          }),
        );

        await notifications.cancel('r1');

        expect(port.ofKind('cancel').single.androidId, nativeId('r1'));
        expect(port.ofKind('cancel').single.tag, 'doc:01J');
        expect(notifications.pending, isEmpty);
      },
    );

    test(
      'an unknown id succeeds — "already gone" is the outcome asked for',
      () async {
        final ShellBridge bridge = await wired();

        final Map<String, Object?> response = await bridge.dispatch(
          envelope('cancel', <String, Object?>{'id': 'never-scheduled'}),
        );

        expect(response['ok'], isTrue);
        expect(port.ofKind('cancel').single.tag, isNull);
      },
    );

    test('a missing id is `invalid`', () async {
      final ShellBridge bridge = await wired();

      final Map<String, Object?> response = await bridge.dispatch(
        envelope('cancel', <String, Object?>{}),
      );

      expect((response['error']! as Map<String, Object?>)['code'], 'invalid');
    });
  });

  group('list', () {
    test(
      'answers from the registry, sorted, in both instant spellings',
      () async {
        final NotificationsCapability notifications = build();
        await notifications.initialize();
        for (final (String id, String at) in <(String, String)>[
          ('later', '2026-10-05T08:00:00Z'),
          ('sooner', '2026-10-02T08:00:00Z'),
        ]) {
          await notifications.schedule(
            ScheduledNotification.fromParams(<String, Object?>{
              'id': id,
              'title': id,
              'atIso': at,
            }),
          );
        }
        final ShellBridge bridge = ShellBridge()..let(notifications.registerOn);

        final List<Object?> rows =
            (await bridge.dispatch(envelope('list')))['result']!
                as List<Object?>;

        expect(
          rows.map((Object? row) => (row! as Map<String, Object?>)['id']),
          <String>['sooner', 'later'],
        );
        final Map<String, Object?> first = rows.first! as Map<String, Object?>;
        expect(first['atIso'], '2026-10-02T08:00:00.000Z');
        expect(
          first['at'],
          DateTime.utc(2026, 10, 2, 8).millisecondsSinceEpoch,
        );
      },
    );

    test('a row whose instant has passed stops being pending', () async {
      final NotificationsCapability notifications = build();
      await notifications.initialize();
      await notifications.schedule(
        ScheduledNotification.fromParams(<String, Object?>{
          'id': 'r1',
          'title': 'x',
          'atIso': '2026-10-02T08:00:00Z',
        }),
      );

      now = DateTime.utc(2026, 10, 3);

      expect(await notifications.list(), isEmpty);
    });

    test('survives a restart, because the registry is a file', () async {
      final NotificationsCapability first = build();
      await first.initialize();
      await first.schedule(
        ScheduledNotification.fromParams(<String, Object?>{
          'id': 'r1',
          'title': 'Water the plants',
          'route': '/doc/01J',
          'atIso': '2026-10-02T08:00:00Z',
        }),
      );

      final NotificationsCapability relaunched = NotificationsCapability(
        port: _FakePort(),
        supportDirectory: () async => support,
        now: () => now,
      );

      final List<ScheduledNotification> pending = await relaunched.list();
      expect(pending.single.id, 'r1');
      expect(pending.single.route, '/doc/01J');
      expect(pending.single.at, DateTime.utc(2026, 10, 2, 8));
    });

    test(
      'a corrupt registry costs the reminders their listing, not the launch',
      () async {
        final Directory dir = Directory(
          '${support.path}/$kNotificationRegistryDir',
        );
        await dir.create(recursive: true);
        await File('${dir.path}/$kNotificationRegistryFile')
            .writeAsString('{"v":1,"pending":[{"title":');

        final NotificationsCapability notifications = build();
        await notifications.initialize();

        expect(await notifications.list(), isEmpty);
      },
    );

    test('one unreadable row does not discard the others', () async {
      final Directory dir = Directory(
        '${support.path}/$kNotificationRegistryDir',
      );
      await dir.create(recursive: true);
      await File('${dir.path}/$kNotificationRegistryFile').writeAsString(
        jsonEncode(<String, Object?>{
          'v': 1,
          'asked': true,
          'pending': <Object?>[
            <String, Object?>{'id': 'broken', 'atIso': 'whenever'},
            <String, Object?>{
              'id': 'good',
              'title': 'x',
              'atIso': '2026-10-02T08:00:00.000Z',
            },
          ],
        }),
      );

      final NotificationsCapability notifications = build();

      expect((await notifications.list()).single.id, 'good');
    });
  });

  group('initialize', () {
    test('is idempotent and never throws', () async {
      final NotificationsCapability notifications = build();

      await notifications.initialize();
      await notifications.initialize();

      expect(port.initializeCount, 1);
    });

    test(
      'a plugin that cannot start leaves a degraded app, not a dead one',
      () async {
        final NotificationsCapability notifications = NotificationsCapability(
          port: _ThrowingPort(),
          supportDirectory: () async => support,
          now: () => now,
        );

        await notifications.initialize();
        expect(notifications.permission, kPermissionDefault);
      },
    );
  });
}

class _ThrowingPort implements NotificationPort {
  @override
  Future<void> initialize() async =>
      throw StateError('no notification channel');

  @override
  Future<bool?> areEnabled() async => throw StateError('unreachable');

  @override
  Future<void> cancel(int androidId, {String? tag}) async =>
      throw StateError('unreachable');

  @override
  Future<bool?> requestPermission() async => throw StateError('unreachable');

  @override
  Future<void> schedule(ScheduledNotification notification) async =>
      throw StateError('unreachable');

  @override
  Future<void> show(ScheduledNotification notification) async =>
      throw StateError('unreachable');
}

extension on ShellBridge {
  void let(void Function(ShellBridge bridge) register) => register(this);
}
