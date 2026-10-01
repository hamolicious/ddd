# `app/` — the ddd Android shell

The optional per-device shell of SPEC §7: a webview serving a **downloaded, verified** copy of
the PWA, a bearer token in the platform keystore, an OTA bundle updater that keeps the previous
bundle and auto-reverts, and a versioned capability bridge (`window.shell`) that gives the web
app two things a browser tab cannot have — the platform file dialogs and **scheduled local
notifications that fire with the app closed**.

The app is not required. Everything works in a plain browser; the shell adds fidelity, and
every capability it adds has a browser fallback by rule (SPEC §7).

**Plugins never contain Dart.** A plugin reaches the device through `kernel.capabilities`,
which goes through this bridge. There is no plugin-supplied native code.

## Read these first

| file | what it is |
|---|---|
| [`BRIDGE.md`](BRIDGE.md) | **the contract** — envelope, `window.shell`, the server manifest, the loopback origin, the revert state machine. Authoritative. |
| [`CONTRACTS.md`](CONTRACTS.md) | who owns which file in M5, what is frozen, the environment and integrator notes |
| [`TESTPLAN.md`](TESTPLAN.md) | the on-device acceptance script — **the half of M5's gate no CI can run** |
| [`../SPEC.md`](../SPEC.md) §7, §5.2, §9 M5 | why any of this exists |

## Layout

```text
lib/
├── config.dart          the numbers all three areas share: bridge version, loopback port,
│                        watchdog, revert threshold. Nothing here imports anything else.
├── main.dart            the boot sequence, as a widget. Owns the phases and the screens.
├── bridge/              the capability bridge (`window.shell`)
│   ├── bridge.dart      the envelope: dispatch, the error codes, the injected bootstrap JS
│   ├── auth.dart        the keystore — bearer token + server URL
│   ├── filesystem.dart  export / pick / import / workspace export
│   └── notifications.dart   permission, schedule, cancel, the on-disk registry
├── bundle/              the OTA updater
│   ├── manifest.dart    the server's manifest, parsed and validated
│   ├── store.dart       versioned directories + the atomic pointer (the revert state)
│   └── updater.dart     download, verify, stage — never applied to a running webview
└── shell/
    ├── boot_guard.dart  the decision: boot, safe mode, revert, recover, "update the app"
    ├── login_screen.dart    native sign-in, with the APP_ORIGIN pre-flight
    └── webview_host.dart    the loopback bundle server and the webview itself

bridge_fixtures/         the shared ABI fixtures, read by *both* sides — `test/bridge/
                         fixtures_test.dart` here and `web/kernel/src/runtime/
                         bridge-fixtures.test.ts` there
```

## Working on it

```bash
mise run shell-test     # the gate: dart format --set-exit-if-changed + analyze + test
```

That needs no Android SDK, no emulator and no device — it runs on the host Dart VM, and it is
what every change to `app/` has to pass.

```bash
mise run dev            # the server the shell talks to
mise run shell-apk      # the debug APK (needs the SDK — next section)
flutter run             # onto a connected device
```

**`APP_ORIGIN` must include `http://127.0.0.1:41847`.** `.env.example` ships it. Without it the
shell signs in and then never syncs: login is not origin-checked, but the WebSocket upgrade is
refused before it authenticates (SPEC §4.3). The login screen pre-flights `/healthz` with that
`Origin` and warns before sending a password, but it cannot fix the server.

## Building the APK

`mise run shell-apk` is the build gate. It needs an Android SDK, which is **not** part of the
`mise` toolchain — Google's SDK manager is interactive-licensed and machine-local, so it is
installed once by hand:

```bash
mkdir -p ~/Android/Sdk/cmdline-tools && cd ~/Android/Sdk/cmdline-tools
curl -fsSLO https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
unzip -q commandlinetools-linux-*.zip && mv cmdline-tools latest && rm commandlinetools-linux-*.zip

export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

`android-36` and `build-tools;36.0.0` because Flutter 3.47's `compileSdkVersion` and
`targetSdkVersion` are both 36. The NDK (28.2.13676358) and CMake are pulled in automatically
by the first build; there is no need to name them.

Then, once, write the paths Gradle reads (`android/local.properties` is gitignored — it is
machine-local by design):

```bash
cat > android/local.properties <<EOF
sdk.dir=$HOME/Android/Sdk
flutter.sdk=$(mise where flutter)
EOF
```

`mise run shell-apk` defaults `ANDROID_HOME` to `~/Android/Sdk` and fails with a pointer to
this section if there is no SDK there.

**The memory caps in `android/gradle.properties` are load-bearing — do not raise them.**

```properties
org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m -XX:+HeapDumpOnOutOfMemoryError
kotlin.daemon.jvmargs=-Xmx1024m
org.gradle.workers.max=2
org.gradle.parallel=false
```

An uncapped build of this project has OOM-killed a 46 GB developer machine. Gradle, the Kotlin
daemon and the Dart/AOT steps each take a JVM or a native heap, and left to their defaults they
size themselves off total RAM independently — so the ceiling is a sum nobody chose. The caps
cost roughly a minute on a cold build and nothing on a warm one.

Two habits go with them:

- **Run the APK build on its own.** Not next to `cargo build`, `mise run web-build`, or another
  Gradle invocation. The caps bound *this* build; they cannot bound what is running beside it.
- **`./android/gradlew --stop` when you are done.** The daemon survives the build and keeps its
  heap reserved; on a machine that is also compiling Rust, that reservation is the difference.

**Two version pins exist because of this build, and both are load-bearing:**

- **JDK 21**, pinned in the root `mise.toml`. AGP rebuilds a `java.base` module from the
  platform jar and hands it to `jlink`; JDK 26's jlink refuses it (*"cannot find the build
  signature in the java.base specified on module path"*) and the build dies inside a
  *dependency's* Java compilation with no mention of the JDK. 21 is the newest LTS that AGP 9
  and Gradle 9.3 both support.
- **`android.r8.proguardAndroidTxt.disallowed=false`** in `android/gradle.properties`. AGP 9
  removed `getDefaultProguardFile('proguard-android.txt')`; `flutter_inappwebview_android`
  1.1.3 — the newest stable — still calls it. The flag is AGP's own transitional opt-out, it
  is there for the dependency rather than for us, and the file says when to remove it.

## How a launch goes

```text
keystore → native login (first run only)
         → promote a staged bundle → BootGuard.decide
         → loopback server on 127.0.0.1:41847 → webview → shell.bootOk()
         → check for an update in the background, stage it for the next launch
```

The bundle is served over loopback HTTP rather than a custom scheme so that the page has a
real, stable, secure-context origin — IndexedDB, Web Workers and `crypto.subtle` all work
unchanged. The consequence, spelled out in `BRIDGE.md` §6: the API is cross-origin, so auth is
a bearer token (SPEC §5.2) and the server's `APP_ORIGIN` has to include the loopback origin.

## State

**M5 is code-complete and the APK builds.** Every area is implemented — no `UnimplementedError`
remains — and the three gates are green: `mise run shell-test` (263 tests, `flutter analyze`
clean), `mise run shell-apk`, and the server's `/api/shell/manifest` verified end to end
against a real build (75 files, every SHA-256 re-checked after download).

**What is not verified is everything that needs hardware.** The integration machine has no
`/dev/kvm`, so no emulator ran, and nothing here has been on a phone. That means the four
things SPEC §9 M5 actually names as acceptance — soft-keyboard CodeMirror editing, offline
boot, OTA update, revert — are **unverified, not passed**. [`TESTPLAN.md`](TESTPLAN.md) is the
script that closes that gap; it is a 45-minute manual run against a device and a laptop.

Known gaps, both deliberate and both cheap to close when someone decides:

- The application id is still the template's `com.example.app`. Fine for a sideloaded
  self-hosted app, wrong for anything distributed; changing it means `namespace` in
  `android/app/build.gradle.kts` and moving `MainActivity.kt` to match.
- The debug APK is ~166 MB because a debug build ships every ABI unstripped. A release build
  (`mise run shell-apk -- --release --split-per-abi`) is the shape a device should get, and it
  needs a signing key that does not exist yet.
