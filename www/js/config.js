/**
 * IRONBOX 1.0 — central configuration.
 *
 * Everything that a developer is likely to want to tune lives here. No other
 * module hard-codes an assistant name, a video filename, a language tag or a
 * tuning constant. Changing values in this file must never require touching
 * the dialogue engine, the animation manager or the storage layer.
 *
 * Values can additionally be overridden at runtime by `data/default-config.json`
 * (packaged) and by `ironbox-config.json` placed in the external IRONBOX
 * directory — see storageManager.js. Overrides are merged shallowly per
 * top-level section.
 */

export const ASSISTANT_CONFIG = {
  name: 'IRONBOX',
  version: '1.0',
  packageId: 'com.ironbox.virtualassistant',
  tagline: 'Holographic assistant core',
};

export const PERSONALITY = {
  name: 'IRONBOX',
  tone: 'friendly',
  enthusiasm: 0.7,
  humor: 0.3,
  politeness: 0.9,
  curiosity: 0.6,
};

export const LANGUAGE_CONFIG = {
  primary: 'en-US',
  supported: ['en-US', 'pt-BR', 'es-ES'],
  // Dialogue rows carry a `language` column and searches are scoped to the
  // active language. When crossLanguageFallback is enabled and the active
  // language returns nothing, these languages are tried in order — off by
  // default, so a pt-BR user is never answered in English.
  crossLanguageFallback: false,
  fallbackOrder: ['en-US'],
};

/**
 * The state machine. `animation` is an animation *category*, never a filename.
 * Categories are resolved to concrete videos by the AnimationManager.
 */
export const STATES = {
  IDLE: { animation: 'idle', loop: true, interruptible: true },
  LISTENING: { animation: 'listening', loop: true, interruptible: true },
  PROCESSING: { animation: 'thinking', loop: true, interruptible: true },
  THINKING: { animation: 'thinking', loop: true, interruptible: true },
  SPEAKING: { animation: 'speaking', loop: true, interruptible: true },
  HAPPY: { animation: 'happy', loop: false, interruptible: true },
  SAD: { animation: 'sad', loop: false, interruptible: true },
  ANGRY: { animation: 'angry', loop: false, interruptible: true },
  SURPRISED: { animation: 'surprised', loop: false, interruptible: true },
  CONFUSED: { animation: 'confused', loop: false, interruptible: true },
  ERROR: { animation: 'error', loop: false, interruptible: true },
  SLEEPING: { animation: 'sleeping', loop: true, interruptible: true },
};

/** Legal transitions. `'*'` means "from any state". */
export const STATE_TRANSITIONS = {
  '*': ['IDLE', 'ERROR', 'SLEEPING'],
  IDLE: ['LISTENING', 'PROCESSING', 'THINKING', 'SPEAKING'],
  LISTENING: ['PROCESSING', 'IDLE'],
  PROCESSING: ['THINKING', 'SPEAKING', 'IDLE'],
  THINKING: ['SPEAKING', 'IDLE'],
  SPEAKING: ['HAPPY', 'SAD', 'ANGRY', 'SURPRISED', 'CONFUSED', 'IDLE', 'LISTENING'],
  HAPPY: ['IDLE', 'LISTENING', 'SPEAKING'],
  SAD: ['IDLE', 'LISTENING', 'SPEAKING'],
  ANGRY: ['IDLE', 'LISTENING', 'SPEAKING'],
  SURPRISED: ['IDLE', 'LISTENING', 'SPEAKING'],
  CONFUSED: ['IDLE', 'LISTENING', 'SPEAKING'],
  ERROR: ['IDLE', 'LISTENING'],
  SLEEPING: ['IDLE', 'LISTENING'],
};

export const EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'confused',
];

/**
 * Ordered fallback chains, used when an animation category has no playable
 * video. Resolution walks the chain left to right and finally lands on the
 * built-in canvas renderer, so a missing file can never crash playback.
 */
export const ANIMATION_FALLBACKS = {
  idle: ['fallback'],
  listening: ['idle', 'fallback'],
  thinking: ['listening', 'idle', 'fallback'],
  speaking: ['idle', 'fallback'],
  happy: ['speaking', 'idle', 'fallback'],
  sad: ['speaking', 'idle', 'fallback'],
  angry: ['speaking', 'idle', 'fallback'],
  surprised: ['speaking', 'idle', 'fallback'],
  confused: ['thinking', 'speaking', 'idle', 'fallback'],
  error: ['confused', 'idle', 'fallback'],
  sleeping: ['idle', 'fallback'],
  neutral: ['idle', 'fallback'],
  fallback: [],
};

export const VIDEO_CONFIG = {
  /** Directory created inside app-specific external storage. */
  rootDirName: 'IRONBOX',
  videosDirName: 'videos',
  charactersDirName: 'characters',
  manifestFileName: 'animation-manifest.json',
  configFileName: 'ironbox-config.json',
  /** Packaged defaults, served from the WebView bundle. */
  packagedVideosPath: 'videos',
  packagedManifestPath: 'data/animation-manifest.json',
  allowedExtensions: ['.mp4', '.m4v', '.webm'],
  /** Files smaller than this are treated as truncated/corrupt. */
  minFileBytes: 1024,
  /** Metadata probe timeout (ms) during validation. */
  validationTimeoutMs: 6000,
  /** How many decoded videos to keep warm. Videos are never bulk-preloaded. */
  preloadCacheSize: 6,
  /** Categories preloaded when a state is entered — "what comes next". */
  preloadGraph: {
    IDLE: ['listening'],
    LISTENING: ['thinking'],
    PROCESSING: ['thinking', 'speaking'],
    THINKING: ['speaking'],
    SPEAKING: ['happy', 'idle'],
  },
  /** Filename convention: <category>[_<variant>][.<ext>] */
  filenamePattern: /^([a-z][a-z0-9]*(?:[-_][a-z][a-z0-9]*)*?)(?:[_-](\d{1,3}))?$/i,
  crossfadeMs: 220,
};

export const DATABASE_CONFIG = {
  name: 'ironbox',
  version: 1,
  /** Bundled starter database copied out of the APK on first run, if present. */
  assetDatabase: 'ironbox.db',
  /** Rows pulled out of SQLite per search. Never "SELECT *" without a LIMIT. */
  searchLimit: 25,
  /** Below this many AND-matches, the search widens to an OR pass. */
  ftsRecallThreshold: 5,
  /** Rows per transaction during bulk import. */
  importBatchSize: 2000,
  /** Minimum score (0..1) for an answer to be used instead of a fallback. */
  confidenceThreshold: 0.34,
  /** Score at or above which ranking stops early. */
  confidenceShortCircuit: 0.95,
};

export const MATCHING_CONFIG = {
  weights: {
    exact: 1.0,
    fts: 0.62,
    keyword: 0.42,
    intent: 0.55,
  },
  /** Contribution of each signal to the final confidence score. */
  signals: {
    tokenOverlap: 0.45,
    coverage: 0.2,
    rank: 0.15,
    priority: 0.1,
    intent: 0.1,
  },
  /**
   * Words stripped before matching (English defaults).
   *
   * Beyond ordinary stop words this covers the scaffolding of a spoken
   * question — "tell me about …", "can you explain …", "quick question …".
   * Leaving them in lets a row that merely shares the phrasing outscore the
   * row that shares the *subject*, which is how "tell me about holograms"
   * ends up answered with a fact about battery life. Interrogatives
   * (what/how/why/who/when/where) are deliberately kept: they carry intent.
   */
  stopWords: [
    'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been',
    'do', 'does', 'did', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
    'and', 'or', 'but', 'if', 'it', 'this', 'that', 'please', 'you',
    'me', 'my', 'your', 'about', 'can', 'could', 'would', 'should',
    'tell', 'explain', 'give', 'say', 'know', 'think', 'want', 'need',
    'let', 'anything', 'something', 'really', 'just', 'ok', 'so', 'hey',
    'hello', 'thanks', 'curious', 'quick', 'question', 'listen', 'more',
    'thing', 'one', 'us', 'i',
  ],
  /**
   * Interrogatives are kept as matchable tokens (they carry intent) but do not
   * count as *evidence*: sharing only "what" with a question is not a reason to
   * answer it.
   */
  interrogatives: ['what', 'how', 'why', 'who', 'when', 'where', 'which', 'whose', 'whom'],
  maxPriority: 100,
};

export const CONVERSATION_CONFIG = {
  /** Number of recent turns kept in memory. Older turns are discarded. */
  CONVERSATION_MEMORY: 10,
  /** Turns considered when boosting rows that match recent context. */
  contextWindow: 3,
  contextBoost: 0.06,
};

export const SPEECH_CONFIG = {
  language: 'en-US',
  maxResults: 5,
  partialResults: true,
  /** Push-to-talk. Continuous listening is deliberately not enabled. */
  mode: 'push-to-talk',
  /** Hard stop for a listening session (ms). */
  maxListenMs: 12000,
};

export const TTS_CONFIG = {
  language: 'en-US',
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  category: 'ambient',
};

export const UI_CONFIG = {
  /** Long-press duration on the talk button before listening starts (ms). */
  pressHoldMs: 90,
  transcriptLimit: 30,
  logLimit: 300,
  idleReturnDelayMs: 400,
};

/** Deep-ish merge used by the runtime override loader. */
export function applyConfigOverrides(overrides = {}) {
  const sections = {
    assistant: ASSISTANT_CONFIG,
    personality: PERSONALITY,
    language: LANGUAGE_CONFIG,
    video: VIDEO_CONFIG,
    database: DATABASE_CONFIG,
    matching: MATCHING_CONFIG,
    conversation: CONVERSATION_CONFIG,
    speech: SPEECH_CONFIG,
    tts: TTS_CONFIG,
    ui: UI_CONFIG,
  };

  for (const [key, target] of Object.entries(sections)) {
    const patch = overrides[key];
    if (patch && typeof patch === 'object') Object.assign(target, patch);
  }

  if (overrides.animationFallbacks) {
    Object.assign(ANIMATION_FALLBACKS, overrides.animationFallbacks);
  }
  if (overrides.states) Object.assign(STATES, overrides.states);
  return sections;
}

export default {
  ASSISTANT_CONFIG,
  PERSONALITY,
  LANGUAGE_CONFIG,
  STATES,
  STATE_TRANSITIONS,
  EMOTIONS,
  ANIMATION_FALLBACKS,
  VIDEO_CONFIG,
  DATABASE_CONFIG,
  MATCHING_CONFIG,
  CONVERSATION_CONFIG,
  SPEECH_CONFIG,
  TTS_CONFIG,
  UI_CONFIG,
};
