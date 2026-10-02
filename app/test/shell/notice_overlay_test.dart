library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ddd_shell/main.dart';

void main() {
  testWidgets('the page survives a notice appearing and being dismissed', (
    WidgetTester tester,
  ) async {
    _StandInState.mounts = 0;
    String? notice;

    await tester.pumpWidget(
      MaterialApp(
        home: StatefulBuilder(
          builder: (BuildContext context, StateSetter setState) =>
              NoticeOverlay(
                notice: notice,
                onRestart: notice == null
                    ? null
                    : () => setState(() => notice = 'restarting'),
                onDismiss: () => setState(() => notice = null),
                child: const _StandIn(),
              ),
        ),
      ),
    );

    final _StandInState page = tester.state<_StandInState>(
      find.byType(_StandIn),
    );
    expect(_StandInState.mounts, 1);
    expect(find.text('Restart'), findsNothing);

    final StatefulElement host = tester.element<StatefulElement>(
      find.byType(StatefulBuilder),
    );
    (host.state as dynamic).setState(
      () => notice = 'An update is ready. Restart to apply it.',
    );
    await tester.pump();

    expect(
      find.text('An update is ready. Restart to apply it.'),
      findsOneWidget,
    );
    expect(find.text('Restart'), findsOneWidget);
    expect(
      tester.state<_StandInState>(find.byType(_StandIn)),
      same(page),
      reason: 'the banner remounted the page — in the shell that is a reload',
    );
    expect(_StandInState.mounts, 1);

    await tester.tap(find.text('Later'));
    await tester.pump();

    expect(find.text('Later'), findsNothing);
    expect(tester.state<_StandInState>(find.byType(_StandIn)), same(page));
    expect(
      _StandInState.mounts,
      1,
      reason: 'dismissing the banner remounted the page',
    );
  });

  testWidgets(
    'Restart is offered only when there is something to restart for',
    (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: NoticeOverlay(
            notice: 'ddd went back to an earlier version.',
            onDismiss: () {},
            child: const _StandIn(),
          ),
        ),
      );

      expect(find.text('Restart'), findsNothing);
      expect(find.text('Later'), findsOneWidget);
    },
  );
}

class _StandIn extends StatefulWidget {
  const _StandIn();

  @override
  State<_StandIn> createState() => _StandInState();
}

class _StandInState extends State<_StandIn> {
  static int mounts = 0;

  @override
  void initState() {
    super.initState();
    mounts += 1;
  }

  @override
  Widget build(BuildContext context) =>
      const ColoredBox(color: Color(0xFF000000));
}
