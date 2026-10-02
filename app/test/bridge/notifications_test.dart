library;

import 'package:flutter_test/flutter_test.dart';
import 'package:ddd_shell/bridge/bridge.dart';
import 'package:ddd_shell/bridge/notifications.dart';

void main() {
  group('ScheduledNotification.fromParams', () {
    test('decodes the envelope the shim sends', () {
      final ScheduledNotification notification =
          ScheduledNotification.fromParams(<String, Object?>{
            'id': 'reminder-1',
            'title': 'Water the plants',
            'body': 'The ones on the balcony',
            'tag': 'doc:01J',
            'route': '/doc/01J',
            'atIso': '2026-10-01T08:30:00.000Z',
          });

      expect(notification.id, 'reminder-1');
      expect(notification.title, 'Water the plants');
      expect(notification.route, '/doc/01J');
      expect(notification.at, DateTime.utc(2026, 10, 1, 8, 30));
    });

    test('normalizes the instant to UTC, so a timezone change does not shift reminders', () {
      final ScheduledNotification notification =
          ScheduledNotification.fromParams(<String, Object?>{
            'title': 'x',
            'atIso': '2026-10-01T10:30:00+02:00',
          });

      expect(notification.at.isUtc, isTrue);
      expect(notification.at, DateTime.utc(2026, 10, 1, 8, 30));
    });

    test(
      'falls back to the tag as the id, the way a browser Notification does',
      () {
        final ScheduledNotification notification =
            ScheduledNotification.fromParams(<String, Object?>{
              'title': 'x',
              'tag': 'doc:01J',
              'atIso': '2026-10-01T08:30:00Z',
            });

        expect(notification.id, 'doc:01J');
      },
    );

    test('rejects a missing title or an unparseable instant as `invalid`', () {
      expect(
        () => ScheduledNotification.fromParams(<String, Object?>{
          'atIso': '2026-10-01T08:30:00Z',
        }),
        throwsA(
          isA<BridgeException>().having(
            (BridgeException e) => e.code,
            'code',
            BridgeErrorCode.invalid,
          ),
        ),
      );
      expect(
        () => ScheduledNotification.fromParams(<String, Object?>{
          'title': 'x',
          'atIso': 'soon',
        }),
        throwsA(isA<BridgeException>()),
      );
      expect(
        () => ScheduledNotification.fromParams(<String, Object?>{'title': 'x'}),
        throwsA(isA<BridgeException>()),
      );
    });

    test('list() entries carry both spellings of the instant', () {
      final Map<String, Object?> json = ScheduledNotification.fromParams(
        <String, Object?>{
          'id': 'r1',
          'title': 'x',
          'atIso': '2026-10-01T08:30:00.000Z',
        },
      ).toJson();

      expect(json['atIso'], '2026-10-01T08:30:00.000Z');
      expect(
        json['at'],
        DateTime.utc(2026, 10, 1, 8, 30).millisecondsSinceEpoch,
      );
    });
  });

  group('nativeId', () {
    test('is deterministic, so re-scheduling replaces instead of stacking', () {
      expect(nativeId('doc:01J'), nativeId('doc:01J'));
      expect(nativeId('doc:01J'), isNot(nativeId('doc:01K')));
    });

    test('always fits a positive 32-bit Android notification id', () {
      for (final String id in <String>['', 'a', 'doc:01JABCDEF', 'x' * 500]) {
        expect(nativeId(id), inInclusiveRange(0, 0x7fffffff));
      }
    });
  });
}
