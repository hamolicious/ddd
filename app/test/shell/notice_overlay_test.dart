/// The one property [NoticeOverlay] exists to guarantee: **showing or hiding the notice
/// must not remount the page underneath it.**
///
/// In the running shell that page is a `WebViewHost` wrapping an `InAppWebView`, and a
/// remount is a full reload of the bundle from `index.html` — the socket, the hydrated
/// documents, the activated plugin graph, the caret and the scroll position all go. The
/// notice that appears most often is "an update is ready", minutes into a session, while
/// someone is typing into a document; the original code returned the page bare when there
/// was no notice and a `Scaffold` when there was, so the banner reloaded the editor under
/// the user, and tapping "Later" reloaded it again.
///
/// A webview cannot be mounted in a host test, so the assertion is made against the thing
/// that actually matters and that a fake can carry: the child's `State` instance, and the
/// `initState` count behind it.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ddd_shell/main.dart';

void main() {
  testWidgets('the page survives a notice appearing and being dismissed', (
    WidgetTester tester,
  ) async {
    // **No key.** A `GlobalKey` would preserve the child's `State` across exactly the
    // restructure this test is about, and `WebViewHost` does not have one — so a keyed
    // stand-in would pass against the bug it exists to catch.
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

    // The update banner arrives while the page is running.
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

    // "Later" takes it away again; the page must survive that too.
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

      // A revert notice has nothing to restart into: the bundle it describes is already the
      // one running.
      expect(find.text('Restart'), findsNothing);
      expect(find.text('Later'), findsOneWidget);
    },
  );
}

/// Stands in for `WebViewHost`: a `StatefulWidget` whose `State` identity is the whole
/// assertion.
class _StandIn extends StatefulWidget {
  const _StandIn();

  @override
  State<_StandIn> createState() => _StandInState();
}

class _StandInState extends State<_StandIn> {
  /// Static, not per-instance: a remount produces a *new* `State`, whose own counter would
  /// read 1 and hide exactly the failure this is looking for.
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
