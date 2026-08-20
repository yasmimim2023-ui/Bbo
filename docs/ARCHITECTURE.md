# IRONBOX 1.0 — architecture and technical decisions

This document answers, in order, the nineteen design questions the project
brief asks for. Everything described here is implemented in this repository;
where something is a limitation of Android or of a dependency, it says so
rather than papering over it.

---

## 1. Final architecture

```
                                 IRONBOX CORE
                                       │
     ┌──────────────┬───────────────┬──┴────────────┬────────────────┐
     │              │               │               │                │
  UI layer     State machine   Dialogue engine   Speech in        Speech out
 index.html   stateManager.js   dialogue.js      speech.js         tts.js
  app.js                        matching.js
                                intentManager.js
     │              │               │
     │              │        DialogueDatabase (database.js)
     │              │               │
     │              │        SQLite + FTS5  ← packaged .db / in-app import
     │              │
     └──────► AnimationManager (animationManager.js)
                     │   plays categories, never files
                     ▼
              VideoManager (videoManager.js)
                     │   resolves category → file, validates, caches
                     ▼
           AnimationRegistry (animationRegistry.js)   ← pure, unit-tested
                     │   discovery, manifest merge, fallback chain
                     ▼
          VideoStorageAdapter (storageManager.js)
                     │   the only module that knows Android paths
        ┌────────────┴─────────────┐
        ▼                          ▼
  External videos            Packaged videos
  IRONBOX/videos/            www/videos/ inside the APK
   PRIORITY 1                 FALLBACK 2      → procedural canvas: FALLBACK 3
```

The load-bearing separation is the horizontal line between the dialogue side
and the animation side. The dialogue engine emits an **emotion** and an
**animation category**; it never learns a filename. The animation side accepts
categories and resolves them to assets. Replacing the character is therefore an
asset operation, never a programming one.

## 2. Technical decisions and rationale

| Decision | Why |
| --- | --- |
| No framework, no bundler | The brief asks for HTML5/CSS3/JavaScript. Native ES modules load directly in the Android WebView, so what ships is what you can read and edit — and post-build edits to `www/` stay possible. |
| Plugins reached through `window.Capacitor.Plugins` | Without a bundler you cannot `import` a plugin package. Capacitor's native bridge registers every installed plugin on that object at runtime, so this is the supported no-build path. Each wrapper degrades to a browser fallback when the plugin is absent. |
| `Directory.External` (app-specific external storage) | Readable and writable with **no runtime permission** on every supported Android version, survives updates, visible over USB/MTP. Shared storage would need broad media permissions for no benefit. |
| `Capacitor.convertFileSrc()` for video URLs | A WebView on `https://localhost` cannot load `file://`. Capacitor proxies files through its local server with range-request support, which `<video>` needs for seeking and looping. |
| FTS5 probed at runtime, never assumed | The SQLite build inside `@capacitor-community/sqlite` is SQLCipher-based; FTS5 is expected but not guaranteed on every device/version. IRONBOX creates the index in a `try`, records the result, and falls back to indexed `LIKE` matching. Diagnostics show which path is live. |
| Ranking in JavaScript, retrieval in SQLite | Measured, not assumed — see §6. `ORDER BY bm25(...)` costs ~1 s per query at one million rows because it ranks every match. Bounded retrieval plus JS scoring costs ~0.14 ms. |
| Two `<video>` layers, cross-faded | Swapping `src` on one element flashes. Two layers give a clean transition and let the outgoing asset be released deliberately. |
| Procedural canvas as the last fallback | A missing or corrupt asset must never produce a black rectangle or a crash. The canvas renderer needs no assets at all. |
| `node:sqlite` for the tools | The build tooling needs SQLite with FTS5. Node 22 ships it, so there is no native module to compile and no extra dependency. |
| Tests on `node:test` | Same reason: zero dependencies, and the pure modules (registry, matching, state machine, SQL) are testable without a browser. |

## 3. Complete folder structure

```
IRONBOX/
├── www/                         the application (what ships inside the APK)
│   ├── index.html
│   ├── css/    main.css · robot.css · animations.css
│   ├── js/
│   │   ├── app.js               wiring and the conversational turn
│   │   ├── config.js            every tunable value, one file
│   │   ├── utils.js             text normalization, LRU, emitter, bridge helpers
│   │   ├── database.js          SQLite + FTS5 (browser: in-memory index)
│   │   ├── dialogue.js          search cascade, confidence gating, context
│   │   ├── matching.js          candidate scoring (pure)
│   │   ├── intentManager.js     intent patterns and local commands
│   │   ├── stateManager.js      state machine
│   │   ├── animationManager.js  playAnimation / playEmotion / reloadAnimations
│   │   ├── animationRegistry.js discovery, manifest merge, fallback (pure)
│   │   ├── videoManager.js      source priority, validation, preload cache
│   │   ├── storageManager.js    VideoStorageAdapter — the only Android paths
│   │   ├── speech.js            recognition abstraction
│   │   ├── tts.js               speech synthesis abstraction
│   │   ├── settings.js          persisted preferences
│   │   ├── diagnostics.js       the report behind the admin panel
│   │   └── adminPanel.js        developer UI
│   ├── data/                    generated: manifest, seed, schema copies
│   ├── videos/                  packaged default animations (13 placeholders)
│   └── assets/databases/        optional packaged .db copied out on first run
├── tools/
│   ├── prepare-assets.js        schema + seed + packaged manifest generation
│   ├── import-database.js       CSV/JSON/JSONL → SQLite (+FTS5), batched
│   ├── generate-database.js     synthetic corpus for load testing
│   ├── validate-database.js     schema/index/FTS checks + query benchmark
│   ├── validate-videos.js       naming, codec, manifest and coverage checks
│   ├── make-placeholder-videos.sh   original placeholder assets (ffmpeg)
│   └── csv.js                   RFC-4180 reader shared by the tools
├── database/  schema.sql · schema-fts5.sql · seed.csv · fallbacks.csv
├── tests/     animation · state · matching · dialogue · database
├── android/                     Capacitor's Gradle project
├── docs/ARCHITECTURE.md
├── capacitor.config.ts
├── package.json
└── README.md
```

## 4. Dependencies

Runtime (four Capacitor plugins, nothing else):

| Package | Role |
| --- | --- |
| `@capacitor/core`, `@capacitor/android` | bridge and Android platform |
| `@capacitor/filesystem` | the external videos directory |
| `@capacitor-community/sqlite` | SQLite (+FTS5) on device |
| `@capacitor-community/speech-recognition` | Android `SpeechRecognizer` |
| `@capacitor-community/text-to-speech` | Android `TextToSpeech` |

Build-time: `@capacitor/cli`, `typescript` (for `capacitor.config.ts`).
Tools and tests use only Node built-ins. No UI framework, no test framework, no
bundler.

## 5. SQLite + FTS5 strategy

Base table `dialogues` carries `question`, a normalized `question_norm`,
`answer`, `category`, `emotion`, `animation`, `priority`, `language`, `intent`
and `keywords`, with indexes on `(question_norm, language)`, `language`,
`(intent, language)`, `(category, language)` and `priority`.

The full-text index is an **external-content** FTS5 table over
`question, keywords, answer` with `content='dialogues'`, kept in sync by three
triggers. External content means the index stores no second copy of the text,
which roughly halves the cost of a large corpus. The tokenizer is
`unicode61 remove_diacritics 2`, so "você" is reachable as "voce".

`schema.sql` and `schema-fts5.sql` are separate files because FTS5 is optional:
the app applies the base schema unconditionally and the FTS schema inside a
`try`. `DialogueDatabase.fts5` records the outcome and the admin panel prints
it. When FTS5 is missing, `searchTokens()` serves the same role using the
indexed columns.

## 6. One-million-record strategy

Verified on a generated 1,000,000-row corpus (432 MB database file, FTS5
enabled) with `tools/validate-database.js --bench`:

| Query strategy | ms/query at 1M rows |
| --- | --- |
| Exact lookup on `question_norm` | **0.03** |
| FTS5 `AND` retrieval, `LIMIT 25`, unranked | **0.28** |
| FTS5 `OR` retrieval, `LIMIT 25`, unranked | **0.09** |
| FTS5 with `ORDER BY bm25(...)` | **75** |
| FTS5 `OR` + `ORDER BY bm25(...)` | **~1030** |
| Indexed `LIKE` fallback | **0.10** |
| Full pipeline (exact → AND → OR → JS ranking) | **0.14**, top-1 correct 25/25 |

The conclusion drove the design: **SQLite retrieves, JavaScript ranks.** Asking
SQLite to order by `bm25` forces it to score every match before applying
`LIMIT`; even selecting `bm25()` as a column costs ~70 ms because it needs
global term statistics. Retrieval with a `LIMIT` and no `ORDER BY` terminates
early, and `matching.js` then scores at most `searchLimit` rows.

Other rules that hold at that scale: no query without a `LIMIT`; imports run in
batched transactions (`importBatchSize`, default 2,000 in-app / 5,000 in the
tool); JSONL is streamed line by line; exports are paged. The corpus is never
converted into a JavaScript array.

## 7. 300+ video strategy

Videos are data, never branches. The registry is a map built from filenames
and/or manifests, so the code path for 13 videos and for 1,300 is identical;
`tests/animation.test.js` exercises a 400-file registry. Nothing enumerates
categories in `if/else` chains, and no constant caps the count.

Memory is bounded instead: only metadata is fetched by default, decoded
elements live in an LRU of `VIDEO_CONFIG.preloadCacheSize` (6) entries, evicted
entries have their `src` cleared, and preloading follows a small
state→next-categories graph rather than loading everything.

## 8. External video directory architecture

```
/storage/emulated/0/Android/data/com.ironbox.virtualassistant/files/
└── IRONBOX/
    ├── videos/                    ← user-replaceable assets (priority 1)
    ├── characters/<pack>/videos/  ← optional character packs
    ├── animation-manifest.json    ← optional category → files override
    └── ironbox-config.json        ← optional runtime config override
```

`VideoStorageAdapter` creates this tree on first launch, lists it, reads and
writes the manifest, imports files and converts paths to WebView-loadable URLs.
No other module touches a filesystem path, so moving to a different storage
location later is a one-file change.

## 9. Post-build video replacement architecture

```
resolve('happy')
   → registry:  packaged manifest ∪ discovered files ∪ external manifest
   → per file:  external copy exists? → external URL (convertFileSrc)
                else packaged copy?   → www/videos/<file>
                else                  → next category in the fallback chain
   → nothing playable at all         → procedural canvas
```

Because resolution happens per *file* at runtime, dropping a replacement into
`IRONBOX/videos/` shadows the packaged asset of the same name with no code
change and no rebuild. "Reload Videos" re-runs the whole pipeline in place.

## 10. Video manifest architecture

Canonical shape:

```json
{ "happy": { "videos": [ { "file": "happy_01.mp4", "weight": 50, "loop": false } ] } }
```

Three sources merge **per category**, later winning: packaged manifest
(generated from `www/videos/` by `prepare-assets.js`) → filenames discovered in
the external directory → an explicit external `animation-manifest.json`.
`normalizeManifest()` accepts the loose shapes a human writes by hand
(`"happy": ["a.mp4"]`, `{"videos": ["a.mp4"]}`), so an external manifest can
repoint a category at any filename — `characterB_happy.mp4` — while categories
it does not mention keep their packaged assets.

## 11. Video validation strategy

Per asset: existence and source, allowed extension, file size (external files
below `minFileBytes` are treated as truncated), then a real metadata probe in a
detached `<video>` element with a timeout. Duration, width and height must be
present, otherwise the asset is marked invalid with a human-readable reason
(`Decode error — unsupported codec`, `No video track (audio-only file?)`, …).

Invalid assets are excluded from resolution, so the fallback chain takes over
automatically. Runtime playback errors mark the asset invalid too, meaning a
file that passes the probe but fails on the device still degrades gracefully.
`tools/validate-videos.js` performs the same checks offline with `ffprobe`.

## 12. Speech recognition strategy

`@capacitor-community/speech-recognition` wraps Android's `SpeechRecognizer`,
which is provided by the device (usually Google's). **Whether it works offline
depends on the device and its installed language packs — IRONBOX does not claim
offline recognition** and `getStatus().offlineCapable` literally reports
`"unknown — depends on device language packs"`. In a browser the Web Speech API
is used where available, which is an online service.

Interaction is push-to-talk: recognition starts on button press, stops on
release, and is hard-capped by `maxListenMs`. Partial results stream to the
caption. The microphone is never left open.

## 13. TTS strategy

`@capacitor-community/text-to-speech` on Android, `speechSynthesis` in the
browser. Android's `TextToSpeech` has **no pause/resume**, so rather than fake
one, IRONBOX splits an answer into sentence-sized chunks and speaks them as a
queue: `pauseSpeaking()` stops after the current sentence and
`resumeSpeaking()` continues from the next. `getStatus().pauseStrategy` reports
which mechanism is in use.

## 14. Conversation context strategy

A ring buffer of `CONVERSATION_MEMORY` (default 10) turns; older turns are
discarded, never accumulated. The last `contextWindow` (3) turns contribute
tokens that give a small `contextBoost` to candidates echoing the recent
conversation. Nothing else persists between turns except the last answer, which
backs the "repeat" command.

## 15. State and animation strategy

Twelve states (`IDLE`, `LISTENING`, `PROCESSING`, `THINKING`, `SPEAKING`,
`HAPPY`, `SAD`, `ANGRY`, `SURPRISED`, `CONFUSED`, `ERROR`, `SLEEPING`) declared
in `config.js` with an explicit transition table. Illegal transitions are
refused and logged, never thrown. Each state names an animation *category*;
entering a state plays it and preloads the categories that usually follow.

A dialogue row's `emotion` maps to a state when one exists, otherwise straight
to an animation. Adding a state or an emotion is a config edit.

## 16. Android storage strategy

App-specific external storage, chosen deliberately over the alternatives:

| Option | Verdict |
| --- | --- |
| `Directory.External` — `Android/data/<pkg>/files` | **chosen.** No permission needed, visible over USB/MTP, removed on uninstall. |
| Shared storage (`/sdcard/IRONBOX`) | Needs broad media permissions on Android 11+, and scoped storage makes arbitrary directories unreliable. Rejected. |
| Internal storage (`Directory.Data`) | Invisible to the user, so post-build replacement by hand becomes impossible. Rejected as the primary location. |

Honest limitation: **on Android 11+ the system Files app and third-party file
managers cannot browse `Android/data`.** A computer over USB/MTP generally can,
and behaviour varies by OEM. That is exactly why the in-app **Import Videos**
picker exists — it uses the system file chooser and copies the selection into
the directory in bounded chunks, so it works regardless of the device's file
manager policy.

## 17. Capacitor strategy

Capacitor 8, configured in `capacitor.config.ts` (`appId
com.ironbox.virtualassistant`, `webDir www`). Web assets are copied into the
Gradle project by `cap sync`; the four plugins contribute their own manifest
entries through the Android manifest merger. The app declares `INTERNET` (for
Capacitor's local server) and `RECORD_AUDIO`, and deliberately declares **no**
storage permission.

## 18. Build strategy

`npm run prepare:assets` → `cap sync android` → `gradlew assembleDebug`.
`npm run build:apk` chains all three. Release builds use `assembleRelease` and
are unsigned until a keystore is configured; the README documents the signing
steps and `.gitignore` keeps keystores out of the repository.

## 19. Testing strategy

61 tests on `node:test`, covering the parts where a regression would be
invisible in the UI:

| File | Covers |
| --- | --- |
| `tests/animation.test.js` | filename parsing, discovery, manifest merge/override, fallback chains, invalid-asset skipping, weighted selection, a 400-video registry |
| `tests/state.test.js` | legal and illegal transitions, category dispatch, targeted preloading, emotion mapping |
| `tests/matching.test.js` | confidence ordering (exact > FTS > keyword), priority and intent tie-breakers, context boost, 0..1 bounds |
| `tests/dialogue.test.js` | the search cascade and short-circuit, fallback gating, local commands, bounded memory, language scoping, error propagation |
| `tests/database.test.js` | the app's real SQL against a real SQLite build: schema, indexes, trigger sync, AND/OR retrieval, `LIMIT` guarantees, FTS operator injection, normalization parity with the importer |

Beyond unit tests, the pipeline was driven in a real browser with Playwright to
confirm boot, a full conversational turn, actual video playback and
cross-fading, variation selection, the fallback chain, asset validation, the
bounded preload cache and a runtime hot-swap. See the README's
"What was verified" section for what that did and did not prove.
