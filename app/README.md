# `app/` — the ddd Android app

An optional Flutter shell for Android. It runs the server's PWA in a webview and adds what a
browser tab cannot:

- a **downloaded, verified** copy of the PWA, so the app boots offline
- over-the-air bundle updates that keep the previous bundle and revert automatically if a new
  one fails to boot
- a bearer token and server URL kept in the platform keystore
- a capability bridge, `window.shell`, with platform file dialogs and **scheduled local
  notifications that fire with the app closed**

Everything also works in a plain browser; every capability the app adds has a browser fallback.

Plugins never contain Dart. A plugin reaches the device through `kernel.capabilities`, which
goes through this bridge.

Released APKs are attached to GitHub Releases.

## Layout

```text
lib/
├── config.dart          shared constants: bridge version, loopback port, watchdog, revert threshold
├── main.dart            the boot sequence and its screens
├── bridge/              the capability bridge (`window.shell`)
│   ├── bridge.dart      envelope, dispatch, error codes, injected bootstrap JS
│   ├── auth.dart        keystore: bearer token + server URL
│   ├── filesystem.dart  export / pick / import / workspace export
│   └── notifications.dart   permission, schedule, cancel, on-disk registry
├── bundle/              the OTA updater
│   ├── manifest.dart    the server's manifest, parsed and validated
│   ├── store.dart       versioned bundle directories + the atomic pointer
│   └── updater.dart     download, verify, stage (never applied to a running webview)
└── shell/
    ├── boot_guard.dart  decides: boot, safe mode, revert, recover, or "update the app"
    ├── login_screen.dart    native sign-in, with the APP_ORIGIN pre-flight
    └── webview_host.dart    the loopback bundle server and the webview

bridge_fixtures/         ABI fixtures shared with the web kernel: read by
                         test/bridge/fixtures_test.dart here and by
                         web/kernel/src/runtime/bridge-fixtures.test.ts
```

## Develop

```bash
mise run shell-test     # dart format check + flutter analyze + flutter test
```

This runs on the host Dart VM (no Android SDK, emulator or device) and every change to `app/`
must pass it.

```bash
mise run dev            # the server the app talks to
mise run shell-apk      # debug APK (needs the Android SDK, below)
flutter run             # run on a connected device
```

Installing on a phone:

```bash
mise run adb-pair <ip:pairing-port> <6-digit-code>   # Wi-Fi debugging, optional
mise run shell-install                               # adb reverse tcp:$PORT + install -r
```

After `shell-install`, the server URL on the phone is `http://127.0.0.1:$PORT`. With more than
one device attached, set `ANDROID_SERIAL`.

### `APP_ORIGIN` must include `http://127.0.0.1:41847`

`.env.example` already includes it. Without it the app signs in but never syncs: login is not
origin-checked, but the WebSocket upgrade is refused before it authenticates. The login screen
checks `/healthz` with that `Origin` and warns before sending a password, but it cannot fix the
server's config.

## Build the APK

`mise run shell-apk` needs an Android SDK, which `mise` does not install. Install it once:

```bash
mkdir -p ~/Android/Sdk/cmdline-tools && cd ~/Android/Sdk/cmdline-tools
curl -fsSLO https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
unzip -q commandlinetools-linux-*.zip && mv cmdline-tools latest && rm commandlinetools-linux-*.zip

export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

Platform and build-tools 36 match Flutter's `compileSdkVersion` and `targetSdkVersion`. The NDK
and CMake are downloaded by the first build.

Then write `android/local.properties` (gitignored, machine-local):

```bash
cat > android/local.properties <<EOF
sdk.dir=$HOME/Android/Sdk
flutter.sdk=$(mise where flutter)
EOF
```

`shell-apk` defaults `ANDROID_HOME` to `~/Android/Sdk` and fails with a pointer here if there is
no SDK. Extra arguments go to `flutter build apk`, e.g. a release build:

```bash
mise run shell-apk -- --release --split-per-abi
```

### Memory caps: do not raise them

`android/gradle.properties` caps the build's memory:

```properties
org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m -XX:+HeapDumpOnOutOfMemoryError
kotlin.daemon.jvmargs=-Xmx1024m
org.gradle.workers.max=2
org.gradle.parallel=false
```

Gradle, the Kotlin daemon and the Dart AOT steps each size their heap off total RAM. Uncapped,
the build can exhaust even a large machine. The caps cost about a minute on a cold build.

- **Run the APK build on its own**, not alongside `cargo build`, `mise run web-build` or
  another Gradle build.
- **Run `./android/gradlew --stop` when done.** The Gradle daemon keeps its heap reserved after
  the build.

### Version pins

- **JDK 21** (root `mise.toml`). Newer JDKs' `jlink` rejects the `java.base` module AGP builds,
  and the build fails inside a dependency's Java compile with no mention of the JDK.
- **`android.r8.proguardAndroidTxt.disallowed=false`** (`android/gradle.properties`). Needed
  because `flutter_inappwebview_android` still calls a ProGuard file AGP 9 removed. The comment
  in that file says when it can go.

## How a launch works

```text
keystore → native login (first run only)
         → promote a staged bundle → BootGuard.decide
         → loopback server on 127.0.0.1:41847 → webview → shell.bootOk()
         → check for an update in the background, stage it for the next launch
```

The bundle is served over loopback HTTP so the page has a real, stable, secure-context origin
(IndexedDB, Web Workers and `crypto.subtle` work unchanged). The API is therefore cross-origin:
auth uses a bearer token, and the server's `APP_ORIGIN` must include the loopback origin,
`http://127.0.0.1:41847`.

## Known limitations

- **Application id is `com.example.app`.** Fine for sideloading, wrong for distribution. To
  change it, edit `namespace` and `applicationId` in `android/app/build.gradle.kts` and move
  `MainActivity.kt` to match.
- **Release builds are signed with the debug key.** There is no release signing config yet.
- **The debug APK is large** (~166 MB): it ships every ABI unstripped. Use a release build with
  `--split-per-abi` for devices.
