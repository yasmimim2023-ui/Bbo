#!/usr/bin/env bash
#
# Installs the Android SDK pieces needed to build the Bbo APK.
#
#   ./scripts/setup-android-sdk.sh
#
# Everything lands in $ANDROID_SDK_ROOT (default ~/Android/sdk); re-running is
# a no-op once the packages are present.
set -euo pipefail

SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Android/sdk}"
CMDLINE_TOOLS_VERSION="13114758"   # cmdline-tools 17.0
PLATFORM="platforms;android-36"
BUILD_TOOLS="build-tools;36.0.0"

command -v java >/dev/null || { echo "A JDK (17 or newer) is required."; exit 1; }

if [ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "==> Installing Android command line tools into $SDK_ROOT"
  zip="$(mktemp -d)/cmdline-tools.zip"
  curl -fsSL -o "$zip" \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"
  mkdir -p "$SDK_ROOT/cmdline-tools"
  unzip -q "$zip" -d "$SDK_ROOT/cmdline-tools"
  rm -rf "$SDK_ROOT/cmdline-tools/latest"
  mv "$SDK_ROOT/cmdline-tools/cmdline-tools" "$SDK_ROOT/cmdline-tools/latest"
  rm -f "$zip"
fi

SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"

echo "==> Accepting licenses"
# `yes` is killed by SIGPIPE once sdkmanager stops reading, which pipefail
# would otherwise treat as a failure.
set +o pipefail
yes | "$SDKMANAGER" --sdk_root="$SDK_ROOT" --licenses >/dev/null
set -o pipefail

echo "==> Installing platform-tools, $PLATFORM, $BUILD_TOOLS"
"$SDKMANAGER" --sdk_root="$SDK_ROOT" "platform-tools" "$PLATFORM" "$BUILD_TOOLS"

echo "==> Writing android/local.properties"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$repo_root/android"
printf 'sdk.dir=%s\n' "$SDK_ROOT" > "$repo_root/android/local.properties"

cat <<EOF

Android SDK ready at $SDK_ROOT

Add this to your shell profile so other tools can find it:

  export ANDROID_SDK_ROOT="$SDK_ROOT"
  export ANDROID_HOME="\$ANDROID_SDK_ROOT"
  export PATH="\$PATH:\$ANDROID_SDK_ROOT/platform-tools:\$ANDROID_SDK_ROOT/cmdline-tools/latest/bin"

Then build the APK with:  npm run build:apk
EOF
