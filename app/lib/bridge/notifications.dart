/// `notifications` — scheduled local notifications, the one capability with no browser
/// equivalent (SPEC §7: "these fire with the app closed").
///
/// Scope, exactly as SPEC §7 states it: v1 reminders are foreground (browser) plus
/// **scheduled local** (shell). No server push, no device registration, no Web Push —
/// those are v2 and a plugin author is told so by `capabilities.supportsScheduled`.
///
/// Three implementation facts the contract depends on.
///
/// **Ids are strings on the bridge and ints in Android.** `flutter_local_notifications`
/// keys everything on a 32-bit int; the web side has `tag`, a string. So the shell keeps a
/// registry file mapping string id → int id plus the scheduled instant, and
/// [nativeId] derives the int deterministically from the string. Deterministic matters:
/// re-scheduling the same reminder must *replace* rather than stack, exactly like a
/// browser `Notification` with the same `tag`.
///
/// **The registry is the answer to `list()`**, not the plugin. `pendingNotificationRequests()`
/// returns ints with no schedule attached, which cannot answer "what is pending, and when".
/// The registry is pruned whenever a notification fires or is cancelled.
///
/// **Inexact by default.** Exact alarms need `SCHEDULE_EXACT_ALARM` (a user-revocable
/// grant on API 31+) or `USE_EXACT_ALARM` (Play-restricted to alarm and calendar apps).
/// A reminder is not an alarm clock, so the shell schedules with
/// `AndroidScheduleMode.inexactAllowWhileIdle` and no special permission. Document it in
/// the UI wording rather than promising minute accuracy.
///
/// # The permission tri-state
///
/// The web side spells permission `granted` / `denied` / `default`, and Android has no
/// third state to read: `areNotificationsEnabled()` is false both for "never asked" and for
/// "refused". So the shell persists one bit — *has this device been asked* — next to the
/// registry, and derives the tri-state from it. Without that bit a fresh install would
/// report `denied` and a UI that only prompts from `default` would never prompt.
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

/// Permission states, spelled as the web side spells them (`BRIDGE.md` §4.3).
const String kPermissionGranted = 'granted';
const String kPermissionDenied = 'denied';
const String kPermissionDefault = 'default';

/// The registry file, under the app support directory (not the cache: a reminder scheduled
/// for next week must survive the OS reclaiming cache space).
const String kNotificationRegistryDir = 'notifications';
const String kNotificationRegistryFile = 'registry.json';

/// One scheduled notification, as stored in the registry and returned by `list()`.
class ScheduledNotification {
  const ScheduledNotification({
    required this.id,
    required this.title,
    required this.at,
    this.body,
    this.tag,
    this.route,
  });

  /// Decodes the `notifications.schedule` params (`BRIDGE.md` §4.3).
  ///
  /// `id` is optional; `tag` is used when it is absent, and a time-derived id when both
  /// are. `atIso` must parse and is normalized to UTC — the bridge carries instants, never
  /// wall-clock times, so a user crossing a timezone does not shift their reminders.
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

  /// Where a tap should land — an in-app route, never a URL (`BRIDGE.md` §4.3).
  final String? route;

  /// UTC, always.
  final DateTime at;

  /// The stable Android notification id for [id].
  int get androidId => nativeId(id);

  /// What `list()` returns: `{ id, at }` plus the fields the shell needs to restore.
  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'title': title,
    if (body != null) 'body': body,
    if (tag != null) 'tag': tag,
    if (route != null) 'route': route,
    'atIso': at.toIso8601String(),
    // The frozen web-side ABI reads `at` as epoch milliseconds; `atIso` is the bridge's
    // canonical spelling. Both are emitted so neither side has to convert.
    'at': at.millisecondsSinceEpoch,
  };
}

/// String id → Android's 32-bit notification id.
///
/// FNV-1a, masked to 31 bits so it is always a positive `int` on both 64-bit and JS
/// number semantics. Collisions are possible in principle and harmless in practice
/// (two reminders would replace each other); determinism is the property that matters.
int nativeId(String id) {
  int hash = 0x811c9dc5;
  for (final int unit in id.codeUnits) {
    hash = (hash ^ unit) & 0xffffffff;
    hash = (hash * 0x01000193) & 0xffffffff;
  }
  return hash & 0x7fffffff;
}

/// The route of the notification the user most recently tapped, or `null`.
///
/// `shell/webview_host.dart` watches this and steers the page's hash router at it
/// (`BRIDGE.md` §4.3: `route` is "an in-app route, never a URL"). A `ValueNotifier` rather
/// than a callback because a tap can arrive before the webview exists — that is the whole
/// point of a notification that fires with the app closed — and the value simply waits.
final ValueNotifier<String?> tappedNotificationRoute = ValueNotifier<String?>(
  null,
);

/// The slice of `flutter_local_notifications` (and `timezone`) the shell uses.
///
/// A port, because every member is a platform channel: `mise run shell-test` runs on the
/// host Dart VM with no device and no Android SDK (`CONTRACTS.md`), so the arg mapping —
/// which id, which instant, which channel, which schedule mode — is only testable if the
/// plugin can be replaced. [LocalNotificationPort] is the real one.
abstract interface class NotificationPort {
  /// Initialize the plugin, the timezone database and the [ddd.reminders] channel.
  Future<void> initialize();

  /// `POST_NOTIFICATIONS` on API 33+. `null` when the platform has no such prompt.
  Future<bool?> requestPermission();

  /// Whether notifications are currently permitted. `null` when unknown.
  Future<bool?> areEnabled();

  /// Fire now.
  Future<void> show(ScheduledNotification notification);

  /// Fire at [ScheduledNotification.at]. Replaces any notification with the same
  /// [ScheduledNotification.androidId].
  Future<void> schedule(ScheduledNotification notification);

  /// Cancel by Android id. Cancelling an unknown id is a no-op.
  ///
  /// [tag] is the tag the notification was *posted* with, when the registry still knows
  /// it. Android files a tagged notification under `(tag, id)`, so cancelling by id alone
  /// removes the pending alarm but leaves an already-visible one sitting in the shade.
  Future<void> cancel(int androidId, {String? tag});
}

/// Where the registry lives. Injectable so the gate can use a temp directory.
typedef SupportDirPort = Future<Directory> Function();

/// The `notifications` capability. Owned by the shell-bridge area.
///
/// Registers `permission`, `request`, `notify`, `schedule`, `cancel` and `list`.
/// `permission` is registered so the page's synchronous `permission()` has a value to
/// return: the shim caches the state injected at document start and refreshes it after
/// `request()` (`BRIDGE.md` §3).
class NotificationsCapability {
  NotificationsCapability({
    this.maxLeadTime = const Duration(days: 365),
    NotificationPort? port,
    SupportDirPort? supportDirectory,
    DateTime Function()? now,
  }) : _port = port ?? LocalNotificationPort(),
       _supportDir = supportDirectory ?? getApplicationSupportDirectory,
       _now = now ?? DateTime.now;

  /// A reminder further out than this is refused rather than silently dropped by the OS.
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

  /// Must be called before the webview loads: the shim bakes the current permission into
  /// the page, and the timezone database has to be loaded before anything is scheduled.
  ///
  /// Idempotent, and it **never throws**. A device where the plugin cannot initialize is a
  /// device with no reminders, which is a degraded app; it is not a reason to fail the
  /// launch of one whose whole job is to show documents.
  Future<void> initialize() => _ready ??= _initialize();

  Future<void> _initialize() async {
    try {
      await _port.initialize();
      await _restore();
      await _refreshPermission();
    } catch (error, stack) {
      // Logged, not rethrown: see the doc comment.
      debugPrint('notifications: initialize failed: $error\n$stack');
    }
  }

  /// The cached OS permission, for `bootstrapScript`.
  ///
  /// Synchronous and never throwing, because the injected script is generated before the
  /// page exists and the frozen web-side `permission()` is synchronous (`BRIDGE.md` §4.3).
  /// Before [initialize] it is `default` — the honest answer to "we have not looked yet".
  String get permission => _permission;

  /// Everything currently in the registry, for diagnostics and for tests.
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
      // Returns the id, which is what the web side awaits as its cancellation handle.
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

  /// `POST_NOTIFICATIONS` on API 33+. Returns one of the three [kPermissionGranted]
  /// spellings; a permanently denied request returns `denied`, not an error.
  Future<String> request() async {
    await initialize();
    final bool? granted = await _port.requestPermission();
    _asked = true;
    if (granted == null) {
      // No runtime prompt on this platform (API < 33): ask the OS what it thinks instead.
      await _refreshPermission();
    } else {
      _permission = granted ? kPermissionGranted : kPermissionDenied;
    }
    await _persist();
    return _permission;
  }

  /// Fire now. The shell path exists so a foreground reminder looks identical to a
  /// scheduled one (same channel, same tap route).
  Future<void> notify(ScheduledNotification notification) async {
    await initialize();
    _refuseIfDenied();
    await _port.show(notification);
  }

  /// Schedule for [ScheduledNotification.at] and record it in the registry. Returns the
  /// string id. Re-scheduling an existing id replaces it.
  ///
  /// An instant that is not in the future fires immediately and is **not** recorded: it is
  /// not pending, so `list()` must not claim it is.
  Future<String> schedule(ScheduledNotification notification) async {
    await initialize();
    _refuseIfDenied();
    if (!notification.at.isAfter(_now().toUtc())) {
      await _port.show(notification);
      return notification.id;
    }
    await _port.schedule(notification);
    // Both the same id and a different id that hashes to the same Android slot: one OS
    // notification must never be described by two registry rows (`nativeId`).
    _pending.removeWhere(
      (String _, ScheduledNotification existing) =>
          existing.androidId == notification.androidId,
    );
    _pending[notification.id] = notification;
    await _persist();
    return notification.id;
  }

  /// Cancel and forget. Cancelling an unknown id succeeds — the page may be catching up
  /// after a reinstall, and "already gone" is the outcome it asked for.
  Future<void> cancel(String id) async {
    await initialize();
    final ScheduledNotification? known = _pending[id];
    // The tag comes from the registry, not from the caller: `cancel` takes only an id
    // across the bridge, and Android needs `(tag, id)` to dismiss a notification that has
    // already been posted with one.
    await _port.cancel(nativeId(id), tag: known?.tag);
    if (_pending.remove(id) != null) await _persist();
  }

  /// Everything scheduled and not yet fired, from the registry.
  Future<List<ScheduledNotification>> list() async {
    await initialize();
    if (_prune()) await _persist();
    return _sorted();
  }

  /// A denied permission is the OS refusing, and the page is told so rather than being
  /// handed a reminder that will never appear.
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

  /// Drops rows whose instant has passed. Returns whether anything changed.
  ///
  /// The OS gives no "it fired" callback for a notification the user never touched, so
  /// elapsed-means-fired is the only honest rule — and it is the right one: a row whose
  /// instant is in the past is not pending either way.
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
          } on BridgeException {
            // One unreadable row costs that reminder its listing, not the whole registry.
          }
        }
      }
      _prune();
    } on FormatException {
      // A truncated registry is not worth a crash: the reminders themselves live in
      // Android's alarm store, and the next write rebuilds this file.
    } on FileSystemException {
      // Same.
    }
  }

  /// Replaced by `rename`, never edited in place — the same reasoning as
  /// `bundle/store.dart`'s pointer: a crash mid-write must leave the old file, not half a
  /// new one.
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

  /// The notification channel every reminder goes to. One channel, named in user-visible
  /// language, so Android's per-channel controls mean something.
  static const String channelId = 'ddd.reminders';
  static const String channelName = 'Reminders';
  static const String channelDescription =
      'Scheduled reminders from your documents';

  /// The bridge version this capability was introduced in; here so a future v2 method can
  /// say the same thing next to it.
  static const int introducedInBridgeVersion = kBridgeVersion;
}

/// [NotificationPort] backed by `flutter_local_notifications` + `timezone`.
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
    // The timezone database is what `TZDateTime` needs to exist at all; the shell only
    // ever uses `tz.UTC`, but the database still has to be loaded.
    tzdata.initializeTimeZones();
    await _plugin.initialize(
      settings: const InitializationSettings(
        // The launcher icon, because `android/` is the scaffold's and a dedicated
        // white-on-transparent notification drawable would be a file in it. Pre-API-21
        // is not a target (minSdk 24), so a coloured icon is legal, just not ideal.
        // INTEGRATION: a `@drawable/ic_notification` silhouette is the one improvement
        // worth making here, and it is an `android/app/src/main/res` change.
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
    // A notification that launched the app is a tap too, and it arrives before any
    // callback could have been registered.
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
        // UTC throughout: the bridge carries instants (`BRIDGE.md` §4.3), and converting
        // to a local wall-clock time is exactly how a reminder shifts when the user flies.
        scheduledDate: tz.TZDateTime.from(notification.at, tz.UTC),
        title: notification.title,
        body: notification.body,
        payload: notification.route,
        notificationDetails: _details(notification),
        // Inexact and no special permission — see the library docs.
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
          // The web `tag` is Android's tag as well, so the same reminder coalesces in the
          // shade the way it would in a browser.
          tag: notification.tag,
        ),
      );

  static void _onTap(NotificationResponse response) => _route(response.payload);

  static void _route(String? payload) {
    if (payload == null || payload.isEmpty) return;
    tappedNotificationRoute.value = payload;
  }
}
