# The image CI's `android-apk` job runs in: everything `flutter build apk` would otherwise
# download on every run, installed once.
#
# Why it exists: on a cold job pod, Gradle fetched and unpacked the NDK (and two extra
# platforms) mid-build, onto the node's spinning root disk, and the job ran into the hour
# limit before compiling anything. Baked in here, it is a one-time pull the node then keeps.
#
# The base already carries what app/README.md § "Building the APK" installs by hand:
# platform 36, build-tools 36.0.0 and JDK 21 (the pin in mise.toml).
#
# Bump ANDROID_BUILDER_TAG in .gitlab-ci.yml whenever this file changes.
FROM ghcr.io/cirruslabs/android-sdk:36

# 3.47.5 is what app/pubspec.lock was solved against (the pin in mise.toml).
ARG FLUTTER_VERSION=3.47.5
ARG FLUTTER_SHA256=2132e990f236f8d22e7c6314b29a191a95b10d7cbcfec9b4e2e303d996652cbb

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl git unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLo /tmp/flutter.tar.xz "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz" \
    && echo "${FLUTTER_SHA256}  /tmp/flutter.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/flutter.tar.xz -C /opt \
    && rm /tmp/flutter.tar.xz \
    # The tarball is a git checkout owned by someone else; flutter shells out to git on it.
    && git config --global --add safe.directory '*'

ENV PATH="/opt/flutter/bin:${PATH}"

RUN flutter config --no-analytics \
    && flutter precache --android

# What the Android Gradle plugin otherwise installs during `assembleRelease`: the NDK Flutter
# 3.47 pins (r28c, see app/README.md) and the platforms the app's plugins compile against.
RUN yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "ndk;28.2.13676358" "platforms;android-34" "platforms;android-35"
