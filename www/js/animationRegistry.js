/**
 * IRONBOX 1.0 — animation registry (pure logic).
 *
 * Turns a set of *filenames* into a category → videos registry, merges
 * manifests, and resolves a requested category to a playable asset using the
 * configured fallback chain. There is no DOM, no filesystem and no Capacitor
 * here, which is what makes the animation behaviour unit-testable and what
 * keeps character assets out of the application logic.
 *
 * Canonical manifest shape:
 *
 *   {
 *     "happy": {
 *       "videos": [
 *         { "file": "happy_01.mp4", "weight": 50, "loop": false },
 *         { "file": "happy_02.mp4", "weight": 30, "loop": false }
 *       ]
 *     }
 *   }
 */

import { ANIMATION_FALLBACKS, VIDEO_CONFIG } from './config.js';
import { weightedPick } from './utils.js';

/** Categories that loop by default when a manifest entry omits `loop`. */
export const LOOPING_CATEGORIES = new Set([
  'idle',
  'listening',
  'thinking',
  'speaking',
  'sleeping',
  'fallback',
]);

/**
 * Split "happy_02.mp4" into { category: 'happy', variant: 2 }.
 * Returns null for names that do not follow the convention.
 */
export function parseVideoFilename(filename, pattern = VIDEO_CONFIG.filenamePattern) {
  const name = String(filename ?? '').trim();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;

  const extension = name.slice(dot).toLowerCase();
  if (!VIDEO_CONFIG.allowedExtensions.includes(extension)) return null;

  const stem = name.slice(0, dot);
  const match = pattern.exec(stem);
  if (!match) return null;

  const [, rawCategory, rawVariant] = match;
  return {
    file: name,
    category: rawCategory.toLowerCase().replace(/-/g, '_'),
    variant: rawVariant ? Number.parseInt(rawVariant, 10) : null,
    extension,
  };
}

/**
 * Build a manifest by scanning filenames. This is the automatic discovery
 * path: dropping `happy_04.mp4` into the videos directory adds a variation
 * with no code and no manifest edit.
 */
export function buildManifestFromFiles(filenames = [], options = {}) {
  const { defaultWeight = 100, pattern = VIDEO_CONFIG.filenamePattern } = options;
  const manifest = {};

  for (const filename of filenames) {
    const parsed = parseVideoFilename(filename, pattern);
    if (!parsed) continue;

    if (!manifest[parsed.category]) manifest[parsed.category] = { videos: [] };
    manifest[parsed.category].videos.push({
      file: parsed.file,
      weight: defaultWeight,
      loop: LOOPING_CATEGORIES.has(parsed.category),
      variant: parsed.variant,
      discovered: true,
    });
  }

  for (const entry of Object.values(manifest)) {
    entry.videos.sort((a, b) => {
      const left = a.variant ?? 0;
      const right = b.variant ?? 0;
      return left - right || a.file.localeCompare(b.file);
    });
  }

  return manifest;
}

/**
 * Accept the loose shapes a human may write in animation-manifest.json and
 * return the canonical one.
 *
 *   "happy": ["a.mp4"]                       → { videos: [{file:'a.mp4', …}] }
 *   "happy": { "videos": ["a.mp4"] }         → idem
 *   "happy": { "videos": [{file, weight}] }  → completed with defaults
 */
export function normalizeManifest(raw = {}) {
  const manifest = {};

  for (const [rawCategory, value] of Object.entries(raw ?? {})) {
    const category = String(rawCategory).toLowerCase();
    const list = Array.isArray(value) ? value : value?.videos ?? [];
    const videos = [];

    for (const item of list) {
      const source = typeof item === 'string' ? { file: item } : item ?? {};
      if (!source.file) continue;
      videos.push({
        file: String(source.file),
        weight: Number.isFinite(source.weight) ? Number(source.weight) : 100,
        loop:
          typeof source.loop === 'boolean'
            ? source.loop
            : LOOPING_CATEGORIES.has(category),
        variant: Number.isFinite(source.variant) ? Number(source.variant) : null,
        discovered: false,
      });
    }

    if (videos.length > 0) manifest[category] = { videos };
  }

  return manifest;
}

/**
 * Merge manifests. Later sources win **per category**, which is what makes an
 * external manifest able to repoint "happy" at "characterB_happy.mp4" without
 * losing the packaged categories it does not mention.
 */
export function mergeManifests(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [category, entry] of Object.entries(source ?? {})) {
      if (!entry?.videos?.length) continue;
      merged[category] = { videos: entry.videos.map((video) => ({ ...video })) };
    }
  }
  return merged;
}

/**
 * Resolve a category to a playable entry, walking the fallback chain.
 *
 * @param {string} category           requested animation category
 * @param {object} manifest           canonical manifest
 * @param {object} options
 * @param {(video, category) => boolean} [options.isPlayable]
 *        filter applied per video — used to exclude assets that failed
 *        validation at runtime
 * @param {object} [options.fallbacks] category → ordered fallback categories
 * @returns {{requested, category, videos, fallbackUsed, chain}|null}
 */
export function resolveCategory(category, manifest, options = {}) {
  const {
    isPlayable = () => true,
    fallbacks = ANIMATION_FALLBACKS,
    maxDepth = 8,
  } = options;

  const requested = String(category ?? '').toLowerCase();
  const chain = [requested, ...(fallbacks[requested] ?? [])];
  const seen = new Set();

  for (const candidate of chain) {
    if (!candidate || seen.has(candidate) || seen.size >= maxDepth) continue;
    seen.add(candidate);

    const videos = (manifest?.[candidate]?.videos ?? []).filter((video) =>
      isPlayable(video, candidate),
    );
    if (videos.length > 0) {
      return {
        requested,
        category: candidate,
        videos,
        fallbackUsed: candidate !== requested,
        chain: [...seen],
      };
    }
  }

  return null;
}

/**
 * Choose one video from a resolved entry. `preferFile` pins a specific asset
 * (used by the admin panel's "test animation"), `avoidFile` reduces the odds
 * of replaying the same variation twice in a row.
 */
export function selectVideo(resolved, options = {}) {
  if (!resolved?.videos?.length) return null;
  const { random = Math.random, preferFile = null, avoidFile = null } = options;

  if (preferFile) {
    const pinned = resolved.videos.find((video) => video.file === preferFile);
    if (pinned) return pinned;
  }

  const pool =
    resolved.videos.length > 1 && avoidFile
      ? resolved.videos.filter((video) => video.file !== avoidFile)
      : resolved.videos;

  return weightedPick(pool.length > 0 ? pool : resolved.videos, random);
}

/** Every filename referenced by a manifest, de-duplicated. */
export function manifestFiles(manifest = {}) {
  const files = new Set();
  for (const entry of Object.values(manifest)) {
    for (const video of entry?.videos ?? []) files.add(video.file);
  }
  return [...files];
}

/** Small summary used by the diagnostics screen. */
export function summarizeManifest(manifest = {}) {
  const categories = Object.keys(manifest).sort();
  return {
    categories: categories.length,
    videos: manifestFiles(manifest).length,
    byCategory: Object.fromEntries(
      categories.map((category) => [category, manifest[category].videos.length]),
    ),
  };
}
