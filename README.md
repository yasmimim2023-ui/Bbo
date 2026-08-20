# Bbo

A mobile app built with plain HTML5, CSS3 and JavaScript, storing data in
SQLite, and packaged as an Android APK with Capacitor.

```
www/                  the app — plain HTML5 / CSS3 / ES modules, no bundler
  index.html
  css/styles.css
  js/app.js           UI logic
  js/db.js            storage layer (SQLite on device, localStorage in the browser)
android/              Capacitor's native Android project (Gradle)
scripts/
  setup-android-sdk.sh  installs the Android SDK pieces the build needs
capacitor.config.json app id, name and web directory
```

## Requirements

| Tool | Version used here |
| --- | --- |
| Node.js | 22.x (18+ works) |
| JDK | 21 (17+ works) |
| Android SDK | platform 36, build-tools 36.0.0, platform-tools |
| Gradle | 8.14.3, supplied by `android/gradlew` — no separate install needed |

## Setup

```bash
npm install                # web + Capacitor dependencies
npm run setup:android      # downloads the Android SDK, writes android/local.properties
```

`setup:android` installs into `$ANDROID_SDK_ROOT` (default `~/Android/sdk`) and
is safe to re-run. Add this to your shell profile afterwards:

```bash
export ANDROID_SDK_ROOT="$HOME/Android/sdk"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$PATH:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin"
```

## Developing

```bash
npm start      # serves www/ at http://localhost:5173
```

The browser has no native SQLite plugin, so `js/db.js` falls back to a
localStorage-backed store with the same interface — the badge in the header
shows which backend is live. Everything under `www/` is static: edit and
reload, there is no build step.

## Building the APK

```bash
npm run build:apk          # cap sync + gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk` (~13 MB, includes
the native SQLite libraries for arm64-v8a, armeabi-v7a, x86 and x86_64).

Install it on a connected device or emulator:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run sync` | copies `www/` into the Android project and refreshes plugins |
| `npm run clean:android` | `gradlew clean` |
| `npm run open:android` | opens the project in Android Studio |
| `npm run build:apk:release` | unsigned release build (see below) |

### Release signing

`build:apk:release` produces an unsigned APK until signing is configured.
Create a keystore, keep it out of the repository, and point Gradle at it via
`android/keystore.properties` (already git-ignored):

```bash
keytool -genkey -v -keystore bbo-release.jks -keyalg RSA \
  -keysize 2048 -validity 10000 -alias bbo
```

```properties
# android/keystore.properties
storeFile=/absolute/path/to/bbo-release.jks
storePassword=…
keyAlias=bbo
keyPassword=…
```

Then add a `signingConfigs` block reading that file in `android/app/build.gradle`.

## SQLite

Storage goes through [`@capacitor-community/sqlite`](https://github.com/capacitor-community/sqlite).
On Android `js/db.js` calls the plugin directly through the Capacitor bridge
(`window.Capacitor.Plugins.CapacitorSQLite`), which keeps the web layer free of
a bundler. The schema lives at the top of `js/db.js`.
