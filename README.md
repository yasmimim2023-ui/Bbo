# IRONBOX 1.0

An offline-first Android virtual assistant with a holographic video character,
built from HTML5, CSS3 and JavaScript, backed by SQLite + FTS5, and packaged
with Capacitor.

**The point of the project: the animation engine is independent from the
animation assets.** You can replace IRONBOX's MP4 videos *after* the APK has
been compiled — no JavaScript edit, no rebuild — as long as the replacement
keeps a registered filename or is declared in an external manifest.

- Package id: `com.ironbox.virtualassistant`
- Primary language: English (`pt-BR` and `es-ES` supported by the architecture,
  with starter rows for both)
- Voice interaction: push-to-talk
- Character system: replaceable MP4 assets, external directory wins over
  packaged defaults

---

## Table of contents

- [Quick start](#quick-start)
- [Replacing the videos after the APK is built](#replacing-the-videos-after-the-apk-is-built)
- [Where the videos live on Android](#where-the-videos-live-on-android)
- [How an animation is resolved](#how-an-animation-is-resolved)
- [Video naming and the manifest](#video-naming-and-the-manifest)
- [Video format requirements](#video-format-requirements)
- [The dialogue database](#the-dialogue-database)
- [Shipping a large database](#shipping-a-large-database)
- [Speech recognition and TTS — what is actually guaranteed](#speech-recognition-and-tts--what-is-actually-guaranteed)
- [Developer panel](#developer-panel)
- [Project layout](#project-layout)
- [Commands](#commands)
- [Building the APK](#building-the-apk)
- [Testing](#testing)
- [What was verified, and how](#what-was-verified-and-how)
- [Acceptance criteria](#acceptance-criteria)
- [Assets, copyright and licence](#assets-copyright-and-licence)

---

## Quick start

```bash
npm install
npm run setup:android        # installs the Android SDK pieces (one time)
npm run prepare:assets       # generates the packaged manifest, seed and schema copies
npm run db:build             # builds www/assets/databases/ironbox.db from database/seed.csv
npm run build:apk            # → android/app/build/outputs/apk/debug/app-debug.apk
```

Install on a device:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Develop the UI in a browser (no Android needed):

```bash
npm start                    # http://localhost:5173
```

In browser mode there is no native SQLite plugin and no external storage, so the
app falls back to an in-memory dialogue index and the packaged videos. The badge
in the header and the developer panel always state which backends are live —
they never claim more than is running.

## Replacing the videos after the APK is built

This is the workflow the whole design exists to support.

1. Install `IRONBOX 1.0.apk` on the device.
2. Launch the app once. It creates
   `Android/data/com.ironbox.virtualassistant/files/IRONBOX/videos/` and copies
   the packaged defaults into it, so there are real files to replace.
3. Put your own MP4 in that folder using **any** of the three methods below.
4. Restart IRONBOX, or open the developer panel (⚙) and press **Reload Videos**.
5. The new video plays. `dialogue.js`, `database.js`, `stateManager.js`,
   `speech.js` and `tts.js` are untouched, and the APK is not rebuilt.

**Method A — copy the file (USB / MTP).** Connect the phone to a computer,
browse to `Android/data/com.ironbox.virtualassistant/files/IRONBOX/videos/`,
and overwrite e.g. `happy_01.mp4`.

**Method B — the in-app picker (works everywhere).** Developer panel →
**Import Videos…** → choose one or more MP4 files. They are copied into the
external videos directory in bounded chunks, then the registry reloads. Use
this on Android 11+, where file managers cannot browse `Android/data`.

**Method C — an external manifest.** Developer panel → **Write Manifest** dumps
the current registry to
`…/files/IRONBOX/animation-manifest.json`. Edit it to point a category at any
filename you like:

```json
{ "happy": { "videos": [ { "file": "characterB_smile.mp4", "weight": 100, "loop": false } ] } }
```

Categories the file does not mention keep their packaged assets. This is how you
replace a character whose files are named differently.

> **You do not need to rebuild the APK to replace an animation video**, provided
> the replacement uses a registered animation filename/category and sits in the
> app's external `videos/` directory — or is declared in the external
> `animation-manifest.json`.

## Where the videos live on Android

```
/storage/emulated/0/Android/data/com.ironbox.virtualassistant/files/
└── IRONBOX/
    ├── videos/                    your replaceable animations
    ├── characters/<pack>/videos/  optional character packs
    ├── animation-manifest.json    optional category → file overrides
    └── ironbox-config.json        optional runtime config overrides
```

This is **app-specific external storage**. IRONBOX uses it deliberately:

- no runtime storage permission is required, on any supported Android version;
- it survives app updates;
- it is removed when the app is uninstalled (so keep your originals elsewhere).

**The honest limitation:** since Android 11, the system Files app and
third-party file managers are blocked from browsing `Android/data`. A computer
connected over USB/MTP can normally still reach it, but this varies by
manufacturer and Android version. That restriction is exactly why **Import
Videos** exists — it uses the system file picker, which is never blocked.

There is no `/videos/` folder at the root of the device, and IRONBOX does not
pretend otherwise: modern Android would not let an app write there without
permissions it does not need.

## How an animation is resolved

```
playEmotion('happy')
        │
        ▼
AnimationManager  ── asks for the category, never a file
        │
        ▼
VideoManager      ── merged registry: packaged ∪ discovered ∪ external manifest
        │
        ├─ 1. external file exists → IRONBOX/videos/happy_01.mp4
        ├─ 2. packaged default     → www/videos/happy_01.mp4  (inside the APK)
        └─ 3. nothing playable     → next category in the fallback chain
                                      (happy → speaking → idle → fallback)
                                      and finally the built-in canvas animation
```

Consequences worth knowing:

- An invalid or missing file never crashes the app; it is excluded from
  resolution and the chain takes over.
- A category with several variations picks one by weight, avoiding an immediate
  repeat of the same file.
- The fallback chain is configurable in `www/js/config.js`
  (`ANIMATION_FALLBACKS`).

## Video naming and the manifest

Files follow `<category>[_NN].<ext>`:

```
idle.mp4  listening.mp4  thinking.mp4  speaking.mp4
happy_01.mp4  happy_02.mp4  happy_03.mp4
sad_01.mp4  angry_01.mp4  surprised_01.mp4  confused_01.mp4
error.mp4  sleeping.mp4  fallback.mp4
```

Dropping `happy_04.mp4` into the external directory adds a fourth variation
automatically — the app discovers it at load time. No JavaScript, no manifest
edit. Categories are discovered the same way, so a brand-new category costs
nothing either (it just needs something to play it).

The packaged manifest at `www/data/animation-manifest.json` is generated from
`www/videos/` by `npm run prepare:assets`. The external manifest, when present,
takes precedence per category.

There is no limit on the number of videos. The registry is a map, not a chain of
`if`s; the test suite exercises a 400-file registry, and memory stays bounded by
an LRU cache of decoded elements (default 6) rather than by the file count.

## Video format requirements

| Property | Recommended |
| --- | --- |
| Container | MP4 |
| Video codec | H.264 / AVC, Baseline or Main profile |
| Pixel format | `yuv420p` |
| Audio | none (IRONBOX speaks through TTS); AAC if you need it |
| Resolution | 480×854 … 1080×1920, portrait |
| Frame rate | 24–30 fps |

WebM (VP8/VP9) also works on modern Android WebViews and is accepted by the
validator. Convert with:

```bash
ffmpeg -i input.mov -c:v libx264 -profile:v baseline -pix_fmt yuv420p \
       -crf 26 -an -movflags +faststart happy_01.mp4
```

Check a folder before shipping it:

```bash
npm run videos:validate      # naming, codec, manifest agreement, category coverage
```

The 13 placeholder clips in `www/videos/` were generated by
`tools/make-placeholder-videos.sh` (needs ffmpeg). They are original abstract
holographic visuals with the category name burned in, so it is obvious which
asset is on screen. Replace them with your own.

## The dialogue database

Schema (`database/schema.sql`):

```sql
CREATE TABLE dialogues (
    id INTEGER PRIMARY KEY,
    question TEXT NOT NULL,
    question_norm TEXT NOT NULL,   -- case/accent folded, indexed
    answer TEXT NOT NULL,
    category TEXT, emotion TEXT, animation TEXT,
    priority INTEGER DEFAULT 0,
    language TEXT DEFAULT 'en-US',
    intent TEXT, keywords TEXT
);
```

plus an external-content FTS5 index over `question, keywords, answer` kept in
sync by triggers, and a `fallbacks` table for when nothing matches.

A turn runs: **exact → FTS5 (AND, then OR) → keyword → intent**, all bounded by
`LIMIT`, then at most `searchLimit` (25) rows are scored in JavaScript
(`matching.js`) using token overlap, coverage, priority, intent and recent
context. Below `confidenceThreshold` the assistant says it does not know rather
than guessing. A row returns an **emotion** and an **animation category** — the
engine never sees a filename.

Measured on a generated 1,000,000-row corpus (432 MB, FTS5 enabled):

| Step | ms/query |
| --- | --- |
| Exact lookup | 0.03 |
| FTS5 AND retrieval (`LIMIT 25`, unranked) | 0.28 |
| FTS5 OR retrieval | 0.09 |
| Indexed `LIKE` fallback | 0.10 |
| **Full pipeline incl. JavaScript ranking** | **0.14** (top-1 correct 25/25) |
| For comparison: `ORDER BY bm25(...)` in SQL | 75 – 1030 |

That last row is why IRONBOX lets SQLite *retrieve* and ranks in JavaScript:
ordering by `bm25` forces SQLite to score every match before applying the
`LIMIT`. Reproduce it yourself:

```bash
npm run db:generate -- --count 1000000 --output build/corpus.jsonl
node tools/import-database.js --input build/corpus.jsonl --output build/ironbox-1m.db
node tools/validate-database.js --db build/ironbox-1m.db --bench
```

**FTS5 is probed, not assumed.** The app tries to create the index at startup;
if the device's SQLite build lacks FTS5, it logs that and falls back to indexed
`LIKE` matching. The developer panel shows which path is live.

## Shipping a large database

Two ways to get a big corpus onto the device:

**Packaged.** Put the built file at `www/assets/databases/ironbox.db`;
`@capacitor-community/sqlite` copies it out of the APK on first run (a file
named `ironbox.db` is installed as `ironboxSQLite.db`, which the connection
named `ironbox` opens). Simple, but a million rows adds ~430 MB to the APK.

**Imported.** Ship the small seed and import a `.jsonl`/`.csv`/`.json` corpus
in-app: developer panel → **Import Dialogues…**. Rows are inserted in batched
transactions of `importBatchSize`. This keeps the APK small and is the
recommended path at scale.

## Speech recognition and TTS — what is actually guaranteed

**Recognition** uses Android's `SpeechRecognizer` through
`@capacitor-community/speech-recognition`. That service is provided by the
device, usually by Google. **Whether it works offline depends on the device and
on whether an offline language pack is installed — IRONBOX cannot promise
offline recognition and does not.** The developer panel reports
`offlineCapable: "unknown — depends on device language packs"`. In a desktop
browser, the Web Speech API is used where present, which is an online service.

Interaction is push-to-talk: the microphone opens while the button is held and
closes on release or after `maxListenMs`. It is never left listening.

**TTS** uses Android's `TextToSpeech`. That engine has no pause/resume, so
IRONBOX speaks answers as a queue of sentences: pause stops after the current
sentence, resume continues with the next. That is a real mechanism, not a
wrapper pretending to pause.

The dialogue database itself is fully offline.

## Developer panel

Open with the ⚙ button.

- **Videos** — Reload Videos, Validate Videos, Import Videos…, Write Manifest,
  test any animation, and a table of every registered file with its source
  (`external` / `packaged` / `imported` / `missing`) and validation status.
- **Database** — engine, mode, FTS5 availability, row counts per language,
  query statistics, a live dialogue search showing the confidence breakdown of
  each candidate, plus import and export.
- **Tests** — microphone permission, TTS, a state-machine cycle, language,
  speech rate and first-run seeding.
- **Logs** — the in-app ring buffer.

The diagnostics block answers the question that matters after a swap:

```
VIDEO
  Video Directory:        …/files/IRONBOX/videos
  External Override:      ENABLED
  Videos Registered:      327
    external storage:     327
    packaged (APK):       0
  Current Animation:      happy
  Current Video:          happy_03.mp4
  Source:                 External Storage
```

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full tree, the
rationale behind each decision, and the answers to the nineteen design
questions (storage, manifest, FTS5, scale, validation, testing, …).

```
www/js/   app · config · utils · database · dialogue · matching · intentManager
          stateManager · animationManager · animationRegistry · videoManager
          storageManager · speech · tts · settings · diagnostics · adminPanel
tools/    prepare-assets · import-database · generate-database
          validate-database · validate-videos · make-placeholder-videos.sh
database/ schema.sql · schema-fts5.sql · seed.csv · fallbacks.csv
tests/    animation · state · matching · dialogue · database
```

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | serves `www/` at http://localhost:5173 |
| `npm run setup:android` | installs the Android SDK packages and writes `local.properties` |
| `npm run prepare:assets` | regenerates the packaged manifest, seed JSON and schema copies |
| `npm run db:build` | builds `www/assets/databases/ironbox.db` from `database/seed.csv` |
| `npm run db:generate` | writes a synthetic JSONL corpus (`-- --count 1000000`) |
| `npm run db:validate` | schema/index/FTS checks plus the query benchmark |
| `npm run videos:validate` | naming, codec, manifest and coverage checks |
| `npm run videos:placeholders` | regenerates the placeholder clips (needs ffmpeg) |
| `npm run sync` | prepare assets + `cap sync android` |
| `npm run build:apk` | debug APK |
| `npm run build:apk:release` | release APK (unsigned until you configure signing) |
| `npm run open:android` | opens the project in Android Studio |
| `npm test` | the unit suite |
| `npm run verify` | tests + database validation + video validation |

## Building the APK

Requirements: Node.js 22+, JDK 17+ (21 used here), Android SDK platform 36 with
build-tools 36.0.0. `npm run setup:android` installs the SDK pieces and writes
`android/local.properties`; add to your shell profile:

```bash
export ANDROID_SDK_ROOT="$HOME/Android/sdk"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$PATH:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin"
```

Then:

```bash
npm run build:apk                       # debug
npm run build:apk:release               # release, unsigned
npx cap open android                    # or drive it from Android Studio
```

### Release signing

Keep the keystore out of the repository (`.gitignore` already excludes `*.jks`,
`*.keystore` and `android/keystore.properties`):

```bash
keytool -genkey -v -keystore ironbox-release.jks -keyalg RSA \
        -keysize 2048 -validity 10000 -alias ironbox
```

```properties
# android/keystore.properties
storeFile=/absolute/path/to/ironbox-release.jks
storePassword=…
keyAlias=ironbox
keyPassword=…
```

Then add a `signingConfigs` block reading that file in `android/app/build.gradle`
and point `buildTypes.release` at it.

## Testing

```bash
npm test          # 61 tests, node:test, no test framework dependency
npm run verify    # tests + db validation + video validation
```

The suite covers the parts where a regression would be invisible in the UI:
manifest discovery and merging, fallback chains, weighted selection, a
400-video registry, state transitions, confidence ordering, the search cascade,
bounded conversation memory, and the app's real SQL executed against a real
SQLite build (schema, triggers, `LIMIT` guarantees, FTS operator injection,
normalization parity between the app and the importer).

## What was verified, and how

Being precise about this, because "it builds" and "it works" are different
claims.

**Actually run and observed:**

- `npm run build:apk` completed and produced
  `android/app/build/outputs/apk/debug/app-debug.apk` — 15.4 MB, package
  `com.ironbox.virtualassistant`, label `IRONBOX 1.0`, minSdk 24, targetSdk 36,
  containing the 13 packaged videos, the seed database and every JS module
  (verified with `aapt2 dump badging` and by listing the archive).
- 61 unit tests pass, including the app's SQL against real SQLite with FTS5.
- The 1,000,000-row benchmark in this README was measured, not estimated.
- The full app was driven in a real browser (Playwright/Chromium): boot,
  a conversational turn answered from the database at 0.99–1.00 confidence, the
  fallback answer for an unknown question, **actual video playback** (element
  playing, looping, cross-fading between the two layers), variation alternation
  across repeats, the `angry → speaking` fallback chain, validation reporting
  6/6 assets valid with real durations and resolutions, the preload cache
  staying at its 6-entry bound, the developer panel rendering diagnostics, and a
  **runtime hot-swap**: importing a replacement asset and pressing reload
  switched the playing video from the packaged file to the imported one with no
  code change.

**Not verified, and why:**

- **No physical Android device or emulator was available in the build
  environment.** So on-device behaviour — the external `IRONBOX/videos/`
  directory being created, `SpeechRecognizer`, `TextToSpeech`, and SQLite via
  the Capacitor plugin — is implemented against the documented plugin APIs and
  compiles into the APK, but has not been executed on Android by this build.
  Install the APK and open the developer panel: every one of those subsystems
  reports its real status there.
- The browser run used WebM copies of the placeholders because the Chromium
  build available here has no H.264 decoder (`canPlayType('video/mp4;
  codecs="avc1.42E01E"')` returns empty). The packaged MP4s are H.264 Baseline /
  `yuv420p` — verified with `ffprobe` — which is the profile Android WebView
  decodes natively. Interestingly, that limitation exercised the failure path
  for real: every MP4 was correctly reported as `Unsupported codec` and the
  procedural canvas fallback took over instead of the app breaking.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| APK builds and installs | ✅ built (15.4 MB); installation not exercised without a device |
| Virtual character displayed, idle video works | ✅ verified in-browser; packaged idle asset resolves and loops |
| Push-to-talk wired to recognition → dialogue engine | ✅ implemented; device recognition not exercised here |
| SQLite + FTS5 | ✅ schema, triggers and queries tested against real SQLite |
| 1,000,000-record architecture, no bulk loading into JS | ✅ measured at 0.14 ms/query; every query `LIMIT`ed |
| Confidence scoring and fallback answers | ✅ unit-tested and observed in-browser |
| TTS | ✅ implemented with a real sentence-queue pause; device engine not exercised |
| IDLE / LISTENING / THINKING / SPEAKING / emotions | ✅ state machine tested; transitions observed driving animations |
| 300+ videos, no hard-coded limit | ✅ 400-file registry test; map-based registry |
| Animation assets separated from core logic | ✅ engine handles categories only; test asserts no filename leaks |
| External `videos/` directory, packaged fallback, external override | ✅ implemented; override observed via runtime import |
| Replace an MP4 after installation, without rebuilding | ✅ hot-swap observed in-browser; same code path on device |
| Reload videos without restarting | ✅ `reloadAnimations()` observed |
| Missing/invalid videos do not crash | ✅ observed — 13 undecodable files degraded to the canvas fallback |
| Video diagnostics | ✅ developer panel |
| Bulk import, database validation, developer diagnostics | ✅ tools + admin panel |
| README documents post-build replacement and Android storage limits | ✅ above |
| No third-party copyrighted assets included | ✅ placeholders are generated procedurally |
| Nothing falsely presented as implemented | ✅ see "What was verified" |

## Assets, copyright and licence

The project ships **no third-party character assets**. The placeholder clips are
generated procedurally by `tools/make-placeholder-videos.sh` and depict no
character.

IRONBOX will happily play videos of any character you supply — but obtaining the
rights to those files is your responsibility. Do not distribute an APK
containing copyrighted character animations you are not licensed to use. The
architecture keeps assets out of the source tree precisely so that the code and
the artwork can be licensed separately.

Code: MIT (see `package.json`).
