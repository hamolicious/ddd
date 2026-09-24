# `app/TESTPLAN.md` — the on-device acceptance script for M5

SPEC §9 M5's acceptance is *"CodeMirror editing with the Android soft keyboard; offline boot;
OTA update + revert"*, and §7 adds two capabilities that only exist on a device: scheduled
local notifications **that fire with the app closed**, and the platform file dialogs.

None of that can be checked by `mise run shell-test` or `mise run shell-apk`. Both gates are
green and both are blind to it: the first runs on the host Dart VM with no Android at all, and
the second proves the APK links, not that it works. **This file is the rest of the gate**, and
until someone runs it on hardware, M5's acceptance criteria are unverified — not passed, not
failed.

It is written to be run by a person with a phone and a laptop in one sitting (about 45
minutes). Nothing here needs Play Store signing, an emulator or root.

## Why this is a manual script and not a test

The integration machine has no `/dev/kvm` — no kernel module, no device node — so a headless
emulator would fall back to full software emulation, which does not boot an API 36 system
image in any useful time. A physical device over `adb` is the cheaper path anyway: the
soft-keyboard criterion is specifically about a real IME, and "fires with the app closed" is
specifically about real Doze.

Automating this later is worth it and is not hard — `integration_test` + `flutter drive`
covers everything except the notification and the share sheet, which need UiAutomator. That is
a follow-up, not a blocker.

---

## 0. Setup (once)

**On the laptop**, with the phone plugged in and USB debugging on:

```bash
mise run web-build                 # what the shell will download
mise run dev                       # the server, on :8080
mise run shell-apk                 # app/build/app/outputs/flutter-apk/app-debug.apk
adb devices                        # confirm exactly one device, authorised
adb install -r app/build/app/outputs/flutter-apk/app-debug.apk
adb reverse tcp:8080 tcp:8080      # the phone's localhost:8080 is now the laptop's
adb logcat -c && adb logcat -s flutter:V    # leave running in a second terminal
```

`adb reverse` is what makes `http://127.0.0.1:8080` a working server URL *on the phone*, and
it is also why cleartext to `127.0.0.1` is permitted
(`android/app/src/main/res/xml/network_security_config.xml` — that entry is the shell's own
loopback bundle server and ships in release). It does **not** survive an unplug — re-run it
after reconnecting, or the app looks broken in a way that is entirely the cable's fault.

The **emulator's** route to the host, `10.0.2.2`, is exempted only in
`android/app/src/{debug,profile}/res/xml/network_security_config.xml`. A release APK cannot
reach it, which is deliberate: the bearer token and the login password would otherwise be
sent in the clear to an RFC1918 address that resolves on plenty of real networks, and an
on-path attacker there could forge the bundle manifest. If a **release** build cannot talk to
a development server, that is this working as intended — use a debug build or put the server
behind HTTPS.

**`APP_ORIGIN` must contain `http://127.0.0.1:41847`.** `.env.example` ships it. Without it the
app signs in (login is not origin-checked) and then never syncs, because the WebSocket upgrade
is refused before it authenticates. Confirm before starting:

```bash
grep APP_ORIGIN .env
```

Useful throughout — the shell's own storage, which several steps inspect:

```bash
adb shell run-as com.example.app ls -l files/bundles/
adb shell run-as com.example.app cat files/bundles/state.json
```

`run-as` works because this is a debug build. The directory layout is documented in
`lib/bundle/store.dart`: one directory per bundle named by its content hash, plus the atomic
`state.json` pointer that carries the failed-boot counter.

---

## 1. First run: URL, login, download, boot

**Steps**

1. Launch Life Manager from the launcher.
2. The login screen appears. Enter `http://127.0.0.1:8080`, the admin email and password.
3. Tap **Sign in**.

**Expect**

- No `APP_ORIGIN` warning. If one appears, the allowlist is wrong — fix it and start over
  rather than tapping through; "Sign in anyway" exists for the case where you know better, and
  here you do not.
- A **"Downloading the workspace app"** screen with a real per-file, per-byte progress bar,
  not a bare spinner. About 75 files / 1.8 MB against a current build.
- The webview replaces it and the workspace renders: sidebar, document list, the welcome
  documents.
- `logcat` shows no `boot:` line about a failure.

**Then verify the boot guard actually cleared** — this is the single most load-bearing state
in the milestone:

```bash
adb shell run-as com.example.app cat files/bundles/state.json
```

`failedBoots` must be `0` and `active` must name the bundle directory that exists. A non-zero
counter here means `shell.bootOk()` never arrived, and the *next* launch will go to safe mode
even though this one looked fine.

**Fails if** the progress screen never advances (server unreachable — check `adb reverse`), or
the webview shows a white rectangle for 25 seconds and is replaced by "Life Manager could not
start" (that is the watchdog in `lib/config.dart`, and it means the bundle loaded but never
called `bootOk`).

---

## 2. CodeMirror editing with the soft keyboard — SPEC §9 M5 acceptance

This is the criterion most likely to fail, and the reason `android:windowSoftInputMode` is
`adjustResize` rather than `adjustPan` in `AndroidManifest.xml`.

**Steps**

1. Open any document, switch to **edit** mode.
2. Tap in the middle of the text. The keyboard opens.
3. Type a sentence. Watch the caret the whole time.
4. Press Enter several times until the caret would be where the keyboard now is.
5. Tap-and-drag to select a word; use the selection handles to extend it.
6. Cut, then paste it back at a different position.
7. Rotate to landscape and type again.
8. With the keyboard open, scroll the document with a finger, then tap a new position.

**Expect**

- **The caret is visible at every moment of typing.** This is the acceptance criterion, stated
  plainly. If it slides under the keyboard and stays there, M5 fails here.
- Characters appear in order, with no dropped or doubled keystrokes — a real IME composes text,
  and CodeMirror's handling of composition events in a webview is exactly what is being tested.
- Selection handles are draggable and land where you put them.
- Autocorrect / predictive text, if the IME offers it, inserts as one word rather than
  re-typing the line.
- The document still says what you typed after switching to read mode and back.

**Test with at least two keyboards** — Gboard and one other (Samsung Keyboard, or SwiftKey).
IME behaviour in webviews differs between them, and shipping against one is how this criterion
passes in the lab and fails in the field.

**Fails if** the caret hides under the keyboard, composition drops characters, or the selection
handles cannot be grabbed.

---

## 3. Offline boot — SPEC §9 M5 acceptance

**Steps**

1. Confirm the app works online (step 1 complete).
2. **Force-stop it**: Settings → Apps → Life Manager → Force stop. Not just backgrounded —
   the criterion is about a cold start.
3. Put the phone in **aeroplane mode**, and on the laptop `adb reverse --remove-all` so
   there is no path to the server even over USB.
4. Launch the app.

**Expect**

- The app reaches the workspace with no login screen and no download screen. The token is in
  the keystore and the bundle is on disk; neither needs the network.
- Documents open and are **readable and searchable** — that is the projection in IndexedDB
  (SPEC §4.1), which survives because the origin is the fixed loopback port and never changes.
- A sync indicator shows offline. Editing a document you have opened before still works.
- `logcat` shows the background update check failing **silently** — no banner, no dialog. Being
  offline is the normal case, not an error to report.

**Fails if** a login screen appears (the token did not persist), the workspace is empty (the
origin changed, so IndexedDB is a different store), or any error dialog interrupts.

Restore: aeroplane mode off, `adb reverse tcp:8080 tcp:8080`.

---

## 4. OTA update — SPEC §9 M5 acceptance

**Steps**

1. Note the current bundle: `adb shell run-as com.example.app cat files/bundles/state.json`.
2. On the laptop, change something visible in the app — e.g. append a line to a plugin's
   frontend, or edit a string in `web/app/src/` — then `mise run web-build`.
3. Confirm the server is publishing a new bundle:
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/shell/manifest \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)["bundle_version"])'
   ```
   It must differ from step 1's `active`.
4. In the app, pull down / navigate so the running page stays up. The check runs shortly after
   boot **and on every foreground**, throttled to 15 minutes (`kUpdateCheckInterval`), so
   switching away and back is enough — a force-stop is not required. If the app has been open
   less than 15 minutes since its last check, background it, wait, and foreground it again.
5. **Do this with the cursor in a document, mid-word.** The banner appearing must not reload
   the page: the caret, the scroll position and any uncommitted CodeMirror state have to
   survive it, and so must tapping **Later**. A reload here is a data-loss bug, not a cosmetic
   one, and it is invisible in any host test.

**Expect**

- A **banner strip above the page**: *"An update is ready. Restart to apply it."* with
  **Restart** and **Later**. A banner, never a dialog — what is underneath is a working app.
- In the page itself, the kernel notice *"An app update is ready. Close and reopen Life
  Manager to finish it."* — the `lm-shell-update-ready` event reaching the web side. Its
  absence with the native banner present means the two halves have drifted; the strings are
  pinned in `bridge_fixtures/window_shell.json`.
- The page underneath is **untouched**. An update is never applied to a running webview: it is
  verified, staged and promoted at the next launch.
- `state.json` now has a `pending` version alongside the unchanged `active`.
- The staged bytes are on disk before the restart:
  `adb shell run-as com.example.app ls files/bundles/`.
5. Tap **Restart**. The new bundle boots, `active` is now the new version, `pending` is gone,
   `failedBoots` is `0`, and your change is visible.
6. Tap through to a document to confirm the workspace survived the swap — same origin, same
   IndexedDB, no re-bootstrap.

**Also check the delta path** (this is what makes an update cheap): before step 5, in `logcat`,
the updater should have fetched only the files whose hashes changed, not all 75. A one-line
plugin change should move a handful of files and a few tens of KB.

**Fails if** the banner never appears (the check failed silently — read `logcat`), the running
page changes underneath you, or the restart lands on the old bundle.

---

## 5. Revert after two failed boots — SPEC §9 M5 acceptance

The point of this one: the shell must recover from a bundle that **cannot run its own
JavaScript**, so nothing in the recovery path may depend on the page.

**Steps**

1. Be on a working install with a *previous* bundle still on disk — i.e. run step 4 first, so
   `files/bundles/` holds two directories.
2. Break the active bundle from outside the app, on the laptop:
   ```bash
   # corrupt the entry point of the ACTIVE bundle
   adb shell run-as com.example.app sh -c 'echo "throw new Error(1)" > files/bundles/<active>/index.html'
   ```
   (Any change that stops the page reaching `shell.bootOk()` will do. Note this also breaks the
   hash, which is deliberate: it proves the shell tolerates local damage rather than only
   server-side damage.)
3. Launch. Wait out the 25-second watchdog.
4. Launch again. Wait again.
5. Launch a third time.

**Expect**

- **Attempt 1:** blank/broken page for 25 s, then the native screen *"Life Manager could not
  start"* — never a white webview left on screen. `failedBoots` is now `1`.
- **Attempt 2:** the same, but the bundle is loaded in **safe mode** (`?safe=1`, base plugins
  only) and a banner says so in plain words — *"…running with plugins switched off"* — not
  "safe mode" and not a spec reference. `failedBoots` is now `2`.
- **Attempt 3:** the shell **reverts to the previous bundle**, boots it, and shows a banner:
  *"Life Manager went back to an earlier version: …"* with the reason in it.
  `state.json`'s `active` is the older version.
- **The notify half is the part to watch.** A silent revert is a user discovering their app is
  mysteriously older; the criterion in the M5 brief is "revert to previous **+ notify**", and
  the banner is that notification.
- The reverted app works: documents open, sync resumes.

**Then check the quarantine**: the broken version must not be re-downloaded and re-installed
automatically on the next update check. It is the version the server publishes, and trying it
again would loop.

**Fails if** any attempt leaves a white webview with no native screen, if the third launch does
not revert, or if it reverts with no banner.

---

## 6. Scheduled notification with the app closed — SPEC §7

The capability that most justifies the shell existing: a browser tab cannot do this.

**Steps**

1. First, the permission tri-state. On a fresh install (API 33+), the app has not asked yet.
   In the app, do whatever schedules a reminder; Android's runtime prompt appears.
2. **Deny it once.** Confirm the app degrades rather than breaking — the reminder is refused
   with a readable message, nothing crashes.
3. Grant it (Settings → Apps → Life Manager → Notifications), return to the app.
4. Schedule a reminder **3 minutes out**.
5. Confirm it is listed as pending in whatever UI lists reminders.
6. **Force-stop the app.** Settings → Apps → Life Manager → Force stop.
7. Lock the phone and put it down. Wait out the 3 minutes.

**Expect**

- The notification **arrives with the app force-stopped** and the screen locked. This is the
  criterion; a notification that only arrives while the app is running is a foreground
  notification and proves nothing.
- It carries the title and body that were scheduled.
- **Tapping it opens the app at the right document**, not at the default view — the tap route
  is carried through `tappedNotificationRoute` into the webview.

**Then verify it survives a reboot:**

8. Schedule another reminder ~10 minutes out.
9. `adb reboot`. Do not open the app.
10. Wait.

The notification must still fire. That is what `RECEIVE_BOOT_COMPLETED` is for, and without it
every reminder silently disappears when the phone restarts — the worst kind of failure, because
nothing reports it.

**Why both halves of this section are device-only.** The permission is not the mechanism:
delivery needs two receivers declared in the *app's* `AndroidManifest.xml`
(`ScheduledNotificationReceiver` and `ScheduledNotificationBootReceiver` — the plugin ships
the classes but declares only permissions), and nothing on the host notices if they are
missing. `zonedSchedule` succeeds, `list()` reports the reminder as pending, every bridge
test passes — and the alarm fires into a component the merged manifest does not contain, so
the reminder simply never appears. Every test in `test/bridge/` replaces the plugin with a
fake, which is the right call for the envelope and useless for this. If a scheduled
notification does not arrive, check the merged manifest first:

```sh
adb shell dumpsys package com.example.app | grep -i dexterous
```

**Note on timing:** reminders are scheduled with `AndroidScheduleMode.inexactAllowWhileIdle`
(see the comment in `AndroidManifest.xml` — exact alarms need a user-revocable grant and
`USE_EXACT_ALARM` is Play-restricted to alarm and calendar apps). So **a few minutes late is a
pass, not a failure.** Under Doze the window can stretch further. Test late-vs-never, not
late-vs-punctual.

**Fails if** nothing arrives with the app closed, if the tap does not route, or if a reminder
dies across a reboot.

---

## 7. Export and import — SPEC §7 `filesystem`

**Steps**

1. **Export a document.** Use the app's export action on an open document. The Android share
   sheet appears; send it to Files, or to a mail draft.
2. Confirm the file lands with a sensible filename and the document's actual text.
3. **Dismiss a share sheet** (back out of it). The app must carry on as if nothing happened —
   dismissal is `cancelled`, which is deliberately not an error to report loudly.
4. **Import a file.** Use the import action; the SAF picker appears. Choose a `.md` file.
5. Confirm the content arrives in the app.
6. **Pick a file with no extension** — e.g. something from Downloads via a `content://` URI.
   The MIME must come from the picker, not be guessed from a name that does not exist.
7. **Dismiss the picker.** Again: no error, nothing logged loudly.
8. **Export the workspace** (admin only). The zip of every document arrives — this is the
   no-Mongo disaster-recovery path of SPEC §5.1, reached from the phone.
9. As a **non-admin** user, confirm the workspace export is refused with a readable "you do not
   have permission" rather than a generic failure.

**Fails if** a dismissal surfaces as an error, a filename carries a newline or a control
character into the share sheet, or the workspace export silently produces an empty zip.

---

## 8. Re-login onto a different server

Worth five minutes because it is the case that silently sends one server's data to another.

**Steps**

1. Sign out from the native recovery screen (or the app's sign-out).
2. Sign in to a **different** server URL.
3. Use **export workspace**.

**Expect** the export to come from the **new** server. The bridge handlers capture the config
they were built with, so a stale capture here would fetch `GET /api/admin/export` from the old
host using the new host's bearer token.

---

## Reporting

Record, for each numbered section: **pass / fail / not run**, the device model, the Android
version, and the keyboard used for §2. A failure is only useful with the `logcat` excerpt
around it (`adb logcat -s flutter:V`) and, for anything about boots or updates, the
`state.json` before and after.

If §2, §3, §4 or §5 fails, **M5's acceptance is not met** — those four are the criteria SPEC
§9 names. §6 and §7 are SPEC §7 capability scope: a failure there is a bug to fix, not a
milestone that did not land.
