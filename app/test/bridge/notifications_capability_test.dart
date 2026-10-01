/// `NotificationsCapability` against a fake plugin (`BRIDGE.md` §4.3).
///
/// Everything `flutter_local_notifications` does is a platform channel, so the gate can
/// never reach it (`CONTRACTS.md`: no device, no Android SDK). [NotificationPort] exists so
/// the part that *decides* — which id, which instant, which tag, what `list()` says, what
/// the permission tri-state resolves to — is testable without one, and that is the part
/// every reminder on every device depends on.
///
/// The registry is a real file in a temp directory rather than a fake, because "a reminder
/// scheduled last week is still listed after a restart" is the behaviour, and an in-memory
/// double would assert the opposite of what ships.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ddd_shell/bridge/bridge.dart';
import 'package:ddd_shell/bridge/notifications.dart';
import 'package:ddd_shell/config.dart';

/// What the plugin was asked to do, in order.
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
  /// What `requestNotificationsPermission()` answers. `null` is API < 33 — no prompt.
  bool? permissionPrompt = true;

  /// What `areNotificationsEnabled()` answers.
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
      // Android cannot tell "never asked" from "refused"; without the persisted bit a
      // fresh install would report `denied` and a UI that only prompts from `default`
      // would never prompt at all.
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

      // A second launch reads the "has been asked" bit back out of the registry.
      final NotificationsCapability relaunched = build();
      await relaunched.initialize();
      expect(relaunched.permission, kPermissionDenied);
    });

    test('a platform with no runtime prompt asks the OS instead', () async {
      // API < 33: `requestNotificationsPermission()` answers `null`.
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

      // Same Android id both times, so the OS replaced it; one registry row, the newer.
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

        // Android files a tagged notification under `(tag, id)`: cancelling by id alone
        // would drop the alarm and leave a posted one sitting in the shade.
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

      // The OS gives no "it fired" callback, so elapsed-means-fired is the only honest
      // rule — and a row in the past is not pending either way.
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

        // A device with no reminders is a degraded app; a launch that fails is not an app.
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

/// `bridge..let(capability.registerOn)` reads better than a two-line temporary in a test
/// that does it a dozen times.
extension on ShellBridge {
  void let(void Function(ShellBridge bridge) register) => register(this);
}
