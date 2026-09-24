plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.example.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // Required by flutter_local_notifications: it uses java.time on API levels that do
        // not have it. Without desugaring the build fails at dex time with an unresolved
        // java.time reference, which reads like a plugin bug and is not one.
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        // TODO(integrator): pick the real application id before the first release build.
        // This is a one-way door — it is the app's identity on the device and in Play, and it
        // cannot be changed afterwards without shipping a different app. Left as the template
        // placeholder deliberately: Play rejects `com.example.*`, which is a loud, early
        // failure, whereas an invented id that nobody owns is a quiet wrong answer.
        // Changing it also means renaming `namespace` above and moving MainActivity.kt.
        applicationId = "com.example.app"
        // 24, not the Flutter default: flutter_inappwebview's evaluateJavascript/handler
        // plumbing and flutter_secure_storage's Keystore backend both want a modern
        // WebView and API surface, and 24 (Nougat, 2016) costs nothing real in 2026.
        minSdk = 24
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO(integrator): a real signing config. Debug keys are here so
            // `flutter run --release` works before there is a keystore.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

dependencies {
    // Pairs with `isCoreLibraryDesugaringEnabled` above (flutter_local_notifications).
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
