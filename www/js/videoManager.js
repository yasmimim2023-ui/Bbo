/**
 * IRONBOX 1.0 — VideoManager.
 *
 * Owns the *asset* side of animation: which concrete file backs a category,
 * where that file comes from, whether it is playable, and how many decoded
 * videos are kept warm.
 *
 * Source priority (spec §6):
 *
 *   1. External user videos   IRONBOX/videos/<file>
 *   2. Packaged defaults      www/videos/<file>
 *   3. Built-in canvas fallback (handled by AnimationManager)
 *
 * Nothing here knows which character the pixels depict.
 */

import { VIDEO_CONFIG } from './config.js';
import {
  buildManifestFromFiles,
  manifestFiles,
  mergeManifests,
  normalizeManifest,
  resolveCategory,
  selectVideo,
  summarizeManifest,
} from './animationRegistry.js';
import { Emitter, LruCache, logger, withTimeout } from './utils.js';

/** @typedef {'external'|'packaged'|'memory'|'missing'} VideoSource */

export class VideoManager {
  constructor({ storage, config = VIDEO_CONFIG, log = logger } = {}) {
    this.storage = storage;
    this.config = config;
    this.log = log;
    this.events = new Emitter();

    /** Canonical merged manifest: category → { videos: [...] }. */
    this.manifest = {};
    /** file → 'external' | 'packaged' | 'memory'. */
    this.sources = new Map();
    /** file → { status, reason, duration, width, height, bytes } */
    this.validation = new Map();
    /** Decoded <video> elements kept warm, evicted LRU. */
    this.cache = new LruCache(config.preloadCacheSize, (element) => {
      this.#releaseElement(element);
    });

    this.packagedManifest = {};
    this.externalManifest = null;
    this.discoveredManifest = {};
    this.externalFiles = [];
    this.lastLoadedAt = 0;
  }

  /* ---------------------------------------------------------------- *
   * Loading
   * ---------------------------------------------------------------- */

  async initialize() {
    await this.load();
    return this.getDiagnostics();
  }

  /**
   * (Re)build the registry from all three sources. Safe to call at runtime —
   * this is what "Reload Videos" triggers.
   */
  async load() {
    this.packagedManifest = normalizeManifest(await this.#fetchPackagedManifest());

    this.externalFiles = await this.storage.listVideos();
    this.discoveredManifest = buildManifestFromFiles(
      this.externalFiles.map((file) => file.name),
    );

    const rawExternalManifest = await this.storage.loadManifest();
    this.externalManifest = rawExternalManifest
      ? normalizeManifest(rawExternalManifest)
      : null;

    // Later sources win per category: packaged < discovered < explicit manifest.
    this.manifest = mergeManifests(
      this.packagedManifest,
      this.discoveredManifest,
      this.externalManifest ?? {},
    );

    this.#indexSources();
    this.lastLoadedAt = Date.now();
    this.events.emit('manifest', this.manifest);

    this.log.info(
      'video',
      `Registry built: ${Object.keys(this.manifest).length} categories, ` +
        `${manifestFiles(this.manifest).length} videos ` +
        `(${this.externalFiles.length} external files found)`,
    );
    return this.manifest;
  }

  async reload() {
    this.cache.clear();
    this.validation.clear();
    await this.storage.reload();
    return this.load();
  }

  async #fetchPackagedManifest() {
    try {
      const response = await fetch(this.config.packagedManifestPath, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      this.log.warn(
        'video',
        'No packaged manifest; relying on discovery',
        error?.message,
      );
      return {};
    }
  }

  /** Decide, per referenced filename, whether the external copy exists. */
  #indexSources() {
    const external = new Set(this.externalFiles.map((file) => file.name));
    const packaged = new Set(manifestFiles(this.packagedManifest));
    this.sources.clear();

    for (const file of manifestFiles(this.manifest)) {
      if (external.has(file)) this.sources.set(file, this.storage.ready ? 'external' : 'memory');
      else if (packaged.has(file)) this.sources.set(file, 'packaged');
      else this.sources.set(file, 'missing');
    }
  }

  /* ---------------------------------------------------------------- *
   * Resolution
   * ---------------------------------------------------------------- */

  getSource(file) {
    return this.sources.get(file) ?? 'missing';
  }

  /** Playable URL honouring the source priority, or null when unavailable. */
  getVideoUrl(file) {
    const source = this.getSource(file);
    if (source === 'external' || source === 'memory') {
      const url = this.storage.getVideoPath(file);
      if (url) return url;
    }
    if (source === 'packaged' || source === 'external' || source === 'memory') {
      return `${this.config.packagedVideosPath}/${file}`;
    }
    return null;
  }

  #isPlayable = (video) => {
    if (this.getSource(video.file) === 'missing') return false;
    const record = this.validation.get(video.file);
    return !record || record.status !== 'invalid';
  };

  /**
   * Resolve a category to a concrete asset.
   * @returns {{category, requested, file, url, source, loop, fallbackUsed, chain}|null}
   */
  resolve(category, options = {}) {
    const resolved = resolveCategory(category, this.manifest, {
      isPlayable: this.#isPlayable,
      ...options,
    });
    if (!resolved) return null;

    const video = selectVideo(resolved, options);
    if (!video) return null;

    const url = this.getVideoUrl(video.file);
    if (!url) return null;

    return {
      requested: resolved.requested,
      category: resolved.category,
      file: video.file,
      url,
      source: this.getSource(video.file),
      loop: video.loop,
      weight: video.weight,
      fallbackUsed: resolved.fallbackUsed,
      chain: resolved.chain,
    };
  }

  /* ---------------------------------------------------------------- *
   * Validation
   * ---------------------------------------------------------------- */

  /**
   * Probe one asset: readable, allowed extension, decodable metadata,
   * plausible duration/resolution. Never throws.
   */
  async validateFile(file) {
    const url = this.getVideoUrl(file);
    const record = {
      file,
      source: this.getSource(file),
      status: 'unknown',
      reason: null,
      duration: null,
      width: null,
      height: null,
      bytes: null,
      checkedAt: Date.now(),
    };

    if (!url) {
      record.status = 'invalid';
      record.reason = 'File not found in external or packaged storage';
      this.validation.set(file, record);
      return record;
    }

    const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
    if (!this.config.allowedExtensions.includes(extension)) {
      record.status = 'invalid';
      record.reason = `Unsupported extension ${extension}`;
      this.validation.set(file, record);
      return record;
    }

    if (record.source === 'external') {
      const stat = await this.storage.statVideo(file);
      record.bytes = stat?.size ?? null;
      if (stat && stat.size < this.config.minFileBytes) {
        record.status = 'invalid';
        record.reason = `File too small (${stat.size} bytes) — truncated or empty`;
        this.validation.set(file, record);
        return record;
      }
    }

    try {
      const meta = await this.#probeMetadata(url);
      Object.assign(record, meta);
      if (!Number.isFinite(meta.duration) || meta.duration <= 0) {
        record.status = 'invalid';
        record.reason = 'No decodable duration — unsupported codec or container';
      } else if (!meta.width || !meta.height) {
        record.status = 'invalid';
        record.reason = 'No video track (audio-only file?)';
      } else {
        record.status = 'valid';
      }
    } catch (error) {
      record.status = 'invalid';
      record.reason = error?.message ?? 'Metadata could not be read';
    }

    if (record.status === 'invalid') {
      this.log.warn('video', `${file} INVALID — ${record.reason}`);
    }
    this.validation.set(file, record);
    return record;
  }

  /** Validate everything the registry references. Returns a summary. */
  async validateAll({ onProgress = null } = {}) {
    const files = manifestFiles(this.manifest);
    const results = [];
    let index = 0;

    for (const file of files) {
      results.push(await this.validateFile(file));
      index += 1;
      onProgress?.(index, files.length);
    }

    const summary = {
      total: files.length,
      valid: results.filter((entry) => entry.status === 'valid').length,
      invalid: results.filter((entry) => entry.status === 'invalid').length,
      missing: results.filter(
        (entry) => entry.status === 'invalid' && entry.source === 'missing',
      ).length,
      results,
    };
    this.events.emit('validated', summary);
    this.log.info(
      'video',
      `Validation: ${summary.valid} valid, ${summary.invalid} invalid of ${summary.total}`,
    );
    return summary;
  }

  #probeMetadata(url) {
    return withTimeout(
      new Promise((resolve, reject) => {
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.muted = true;
        probe.playsInline = true;

        const cleanup = () => {
          probe.removeAttribute('src');
          probe.load();
        };

        probe.onloadedmetadata = () => {
          const meta = {
            duration: probe.duration,
            width: probe.videoWidth,
            height: probe.videoHeight,
          };
          cleanup();
          resolve(meta);
        };
        probe.onerror = () => {
          const code = probe.error?.code;
          cleanup();
          reject(new Error(this.#mediaErrorText(code)));
        };

        probe.src = url;
        probe.load();
      }),
      this.config.validationTimeoutMs,
      'Metadata probe timed out',
    );
  }

  #mediaErrorText(code) {
    switch (code) {
      case 1:
        return 'Loading aborted';
      case 2:
        return 'Network error while reading the file';
      case 3:
        return 'Decode error — unsupported codec';
      case 4:
        return 'Unsupported codec or container for this device';
      default:
        return 'Unknown media error';
    }
  }

  /* ---------------------------------------------------------------- *
   * Preloading — bounded, never "load everything"
   * ---------------------------------------------------------------- */

  /**
   * Warm one category. Only metadata is fetched unless `full` is set, and the
   * cache is an LRU of `preloadCacheSize` entries, so 300+ assets never sit in
   * memory at once.
   */
  async preloadAnimation(category, { full = false } = {}) {
    const resolved = this.resolve(category);
    if (!resolved) return null;
    if (this.cache.has(resolved.file)) return this.cache.get(resolved.file);

    const element = document.createElement('video');
    element.preload = full ? 'auto' : 'metadata';
    element.muted = true;
    element.playsInline = true;
    element.src = resolved.url;
    element.load();
    this.cache.set(resolved.file, element);
    return element;
  }

  /** Warm the categories likely to follow `state` (config.preloadGraph). */
  async preloadForState(state) {
    const categories = this.config.preloadGraph?.[state] ?? [];
    for (const category of categories) {
      try {
        await this.preloadAnimation(category);
      } catch (error) {
        this.log.warn('video', `Preload failed for ${category}`, error?.message);
      }
    }
    return categories;
  }

  releaseAll() {
    this.cache.clear();
  }

  #releaseElement(element) {
    if (!element) return;
    try {
      element.pause?.();
      element.removeAttribute?.('src');
      element.load?.();
    } catch {
      /* releasing a detached element must never surface an error */
    }
  }

  /* ---------------------------------------------------------------- *
   * Diagnostics
   * ---------------------------------------------------------------- */

  getDiagnostics() {
    const files = manifestFiles(this.manifest);
    const bySource = { external: 0, packaged: 0, memory: 0, missing: 0 };
    for (const file of files) bySource[this.getSource(file)] += 1;

    const validation = [...this.validation.values()];
    return {
      directory: this.storage.getExternalVideoDirectory(),
      externalOverride: this.storage.ready,
      externalFilesFound: this.externalFiles.length,
      externalManifest: Boolean(this.externalManifest),
      manifest: summarizeManifest(this.manifest),
      videosFound: files.length,
      bySource,
      valid: validation.filter((entry) => entry.status === 'valid').length,
      invalid: validation.filter((entry) => entry.status === 'invalid').length,
      missing: bySource.missing,
      cached: this.cache.size,
      lastLoadedAt: this.lastLoadedAt,
      invalidDetails: validation
        .filter((entry) => entry.status === 'invalid')
        .map(({ file, reason, source }) => ({ file, reason, source })),
    };
  }
}

export default VideoManager;
