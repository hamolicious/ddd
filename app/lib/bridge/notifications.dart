library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:path_provider/path_provider.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

import '../config.dart';
import 'bridge.dart';

const String kPermissionGranted = 'granted';
const String kPermissionDenied = 'denied';
const String kPermissionDefault = 'default';

const String kNotificationRegistryDir = 'notifications';
const String kNotificationRegistryFile = 'registry.json';

class ScheduledNotification {
  const ScheduledNotification({
    required this.id,
    required this.title,
    required this.at,
    this.body,
    this.tag,
    this.route,
  });

  factory ScheduledNotification.fromParams(Map<String, Object?> params) {
    final Object? title = params['title'];
    final Object? atIso = params['atIso'];
    if (title is! String || title.isEmpty) {
      throw BridgeException.invalid('title is required');
    }
    if (atIso is! String) {
      throw BridgeException.invalid('atIso is required');
    }
    final DateTime? at = DateTime.tryParse(atIso);
    if (at == null) {
      throw BridgeException.invalid('atIso is not an ISO-8601 instant: $atIso');
    }
    final Object? id = params['id'];
    final Object? tag = params['tag'];
    final String resolved = switch (<Object?>[id, tag]) {
      [final String value, _] when value.isNotEmpty => value,
      [_, final String value] when value.isNotEmpty => value,
      _ => 'ddd-${at.toUtc().millisecondsSinceEpoch}',
    };
    return ScheduledNotification(
      id: resolved,
      title: title,
      body: params['body'] is String ? params['body'] as String : null,
      tag: tag is String ? tag : null,
      route: params['route'] is String ? params['route'] as String : null,
      at: at.toUtc(),
    );
  }

  factory ScheduledNotification.fromJson(Map<String, Object?> json) =>
      ScheduledNotification.fromParams(json);

  final String id;
  final String title;
  final String? body;
  final String? tag;

  final String? route;

  final DateTime at;

  int get androidId => nativeId(id);

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'title': title,
    if (body != null) 'body': body,
    if (tag != null) 'tag': tag,
    if (route != null) 'route': route,
    'atIso': at.toIso8601String(),
    'at': at.millisecondsSinceEpoch,
  };
}

int nativeId(String id) {
  int hash = 0x811c9dc5;
  for (final int unit in id.codeUnits) {
    hash = (hash ^ unit) & 0xffffffff;
    hash = (hash * 0x01000193) & 0xffffffff;
  }
  return hash & 0x7fffffff;
}

final ValueNotifier<String?> tappedNotificationRoute = ValueNotifier<String?>(
  null,
);

abstract interface class NotificationPort {
  Future<void> initialize();

  Future<bool?> requestPermission();

  Future<bool?> areEnabled();

  Future<void> show(ScheduledNotification notification);

  Future<void> schedule(ScheduledNotification notification);

  Future<void> cancel(int androidId, {String? tag});
}

typedef SupportDirPort = Future<Directory> Function();

class NotificationsCapability {
  NotificationsCapability({
    this.maxLeadTime = const Duration(days: 365),
    NotificationPort? port,
    SupportDirPort? supportDirectory,
    DateTime Function()? now,
  }) : _port = port ?? LocalNotificationPort(),
       _supportDir = supportDirectory ?? getApplicationSupportDirectory,
       _now = now ?? DateTime.now;

  final Duration maxLeadTime;

  final NotificationPort _port;
  final SupportDirPort _supportDir;
  final DateTime Function() _now;

  final Map<String, ScheduledNotification> _pending =
      <String, ScheduledNotification>{};

  String _permission = kPermissionDefault;
  bool _asked = false;
  Future<void>? _ready;
  File? _registry;

  Future<void> initialize() => _ready ??= _initialize();

  Future<void> _initialize() async {
    try {
      await _port.initialize();
      await _restore();
      await _refreshPermission();
    } catch (error, stack) {
      debugPrint('notifications: initialize failed: $error\n$stack');
    }
  }

  String get permission => _permission;

  @visibleForTesting
  List<ScheduledNotification> get pending => _sorted();

  void registerOn(ShellBridge bridge) {
    bridge.register(
      'notifications',
      'permission',
      (Map<String, Object?> _) async => permission,
    );
    bridge.register(
      'notifications',
      'request',
      (Map<String, Object?> _) => request(),
    );
    bridge.register('notifications', 'notify', (
      Map<String, Object?> params,
    ) async {
      await notify(
        ScheduledNotification.fromParams(<String, Object?>{
          ...params,
          'atIso': _now().toUtc().toIso8601String(),
        }),
      );
      return null;
    });
    bridge.register('notifications', 'schedule', (
      Map<String, Object?> params,
    ) async {
      final ScheduledNotification notification =
          ScheduledNotification.fromParams(params);
      final DateTime limit = _now().toUtc().add(maxLeadTime);
      if (notification.at.isAfter(limit)) {
        throw BridgeException.invalid(
          'atIso is further out than ${maxLeadTime.inDays} days',
        );
      }
      return schedule(notification);
    });
    bridge.register('notifications', 'cancel', (
      Map<String, Object?> params,
    ) async {
      final Object? id = params['id'];
      if (id is! String || id.isEmpty) {
        throw BridgeException.invalid('id is required');
      }
      await cancel(id);
      return null;
    });
    bridge.register('notifications', 'list', (Map<String, Object?> _) async {
      final List<ScheduledNotification> pending = await list();
      return pending
          .map((ScheduledNotification n) => n.toJson())
          .toList(growable: false);
    });
  }

  Future<String> request() async {
    await initialize();
    final bool? granted = await _port.requestPermission();
    _asked = true;
    if (granted == null) {
      await _refreshPermission();
    } else {
      _permission = granted ? kPermissionGranted : kPermissionDenied;
    }
    await _persist();
    return _permission;
  }

  Future<void> notify(ScheduledNotification notification) async {
    await initialize();
    _refuseIfDenied();
    await _port.show(notification);
  }

  Future<String> schedule(ScheduledNotification notification) async {
    await initialize();
    _refuseIfDenied();
    if (!notification.at.isAfter(_now().toUtc())) {
      await _port.show(notification);
      return notification.id;
    }
    await _port.schedule(notification);
    _pending.removeWhere(
      (String _, ScheduledNotification existing) =>
          existing.androidId == notification.androidId,
    );
    _pending[notification.id] = notification;
    await _persist();
    return notification.id;
  }

  Future<void> cancel(String id) async {
    await initialize();
    final ScheduledNotification? known = _pending[id];
    await _port.cancel(nativeId(id), tag: known?.tag);
    if (_pending.remove(id) != null) await _persist();
  }

  Future<List<ScheduledNotification>> list() async {
    await initialize();
    if (_prune()) await _persist();
    return _sorted();
  }

  void _refuseIfDenied() {
    if (_permission == kPermissionDenied) {
      throw BridgeException.denied(
        'notifications are turned off for ddd in Android settings',
      );
    }
  }

  Future<void> _refreshPermission() async {
    final bool enabled = await _port.areEnabled() ?? true;
    _permission = enabled
        ? kPermissionGranted
        : (_asked ? kPermissionDenied : kPermissionDefault);
  }

  bool _prune() {
    final DateTime now = _now().toUtc();
    final int before = _pending.length;
    _pending.removeWhere(
      (String _, ScheduledNotification n) => !n.at.isAfter(now),
    );
    return _pending.length != before;
  }

  List<ScheduledNotification> _sorted() =>
      _pending.values.toList(growable: false)..sort(
        (ScheduledNotification a, ScheduledNotification b) =>
            a.at.compareTo(b.at),
      );

  Future<File> _registryFile() async {
    final File? cached = _registry;
    if (cached != null) return cached;
    final Directory dir = Directory(
      '${(await _supportDir()).path}/$kNotificationRegistryDir',
    );
    await dir.create(recursive: true);
    return _registry = File('${dir.path}/$kNotificationRegistryFile');
  }

  Future<void> _restore() async {
    final File file = await _registryFile();
    if (!file.existsSync()) return;
    try {
      final Object? decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map) return;
      _asked = decoded['asked'] == true;
      final Object? rows = decoded['pending'];
      if (rows is List) {
        for (final Object? row in rows) {
          if (row is! Map) continue;
          try {
            final ScheduledNotification n = ScheduledNotification.fromJson(
              Map<String, Object?>.from(row),
            );
            _pending[n.id] = n;
          } on BridgeException {}
        }
      }
      _prune();
    } on FormatException {
    } on FileSystemException {}
  }

  Future<void> _persist() async {
    try {
      final File file = await _registryFile();
      final File temp = File('${file.path}.tmp');
      await temp.writeAsString(
        jsonEncode(<String, Object?>{
          'v': 1,
          'asked': _asked,
          'pending': _sorted()
              .map((ScheduledNotification n) => n.toJson())
              .toList(growable: false),
        }),
        flush: true,
      );
      await temp.rename(file.path);
    } on FileSystemException catch (error) {
      debugPrint('notifications: could not write the registry: $error');
    }
  }

  static const String channelId = 'ddd.reminders';
  static const String channelName = 'Reminders';
  static const String channelDescription =
      'Scheduled reminders from your documents';

  static const int introducedInBridgeVersion = kBridgeVersion;
}

class LocalNotificationPort implements NotificationPort {
  LocalNotificationPort({FlutterLocalNotificationsPlugin? plugin})
    : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  final FlutterLocalNotificationsPlugin _plugin;

  AndroidFlutterLocalNotificationsPlugin? get _android => _plugin
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >();

  @override
  Future<void> initialize() async {
    tzdata.initializeTimeZones();
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
      onDidReceiveNotificationResponse: _onTap,
    );
    await _android?.createNotificationChannel(
      const AndroidNotificationChannel(
        NotificationsCapability.channelId,
        NotificationsCapability.channelName,
        description: NotificationsCapability.channelDescription,
        importance: Importance.defaultImportance,
      ),
    );
    final NotificationAppLaunchDetails? launch = await _plugin
        .getNotificationAppLaunchDetails();
    if (launch?.didNotificationLaunchApp ?? false) {
      _route(launch?.notificationResponse?.payload);
    }
  }

  @override
  Future<bool?> requestPermission() async =>
      _android?.requestNotificationsPermission();

  @override
  Future<bool?> areEnabled() async => _android?.areNotificationsEnabled();

  @override
  Future<void> show(ScheduledNotification notification) => _plugin.show(
    id: notification.androidId,
    title: notification.title,
    body: notification.body,
    payload: notification.route,
    notificationDetails: _details(notification),
  );

  @override
  Future<void> schedule(ScheduledNotification notification) =>
      _plugin.zonedSchedule(
        id: notification.androidId,
        scheduledDate: tz.TZDateTime.from(notification.at, tz.UTC),
        title: notification.title,
        body: notification.body,
        payload: notification.route,
        notificationDetails: _details(notification),
        androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
      );

  @override
  Future<void> cancel(int androidId, {String? tag}) =>
      _plugin.cancel(id: androidId, tag: tag);

  NotificationDetails _details(ScheduledNotification notification) =>
      NotificationDetails(
        android: AndroidNotificationDetails(
          NotificationsCapability.channelId,
          NotificationsCapability.channelName,
          channelDescription: NotificationsCapability.channelDescription,
          tag: notification.tag,
        ),
      );

  static void _onTap(NotificationResponse response) => _route(response.payload);

  static void _route(String? payload) {
    if (payload == null || payload.isEmpty) return;
    tappedNotificationRoute.value = payload;
  }
}
