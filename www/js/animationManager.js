/**
 * IRONBOX 1.0 — AnimationManager.
 *
 * Public API (spec §14):
 *
 *   playAnimation('idle')        playEmotion('happy')     stopAnimation()
 *   playAnimation('listening')   playRandomAnimation()    setIdleAnimation('idle')
 *   playAnimation('thinking')    preloadAnimation('happy')
 *   playAnimation('speaking')    reloadAnimations()
 *
 * The manager knows about *categories* only. It never contains a character
 * name, never a filename, and never a filesystem path: VideoManager resolves
 * the asset and VideoStorageAdapter resolves the location. Replacing the
 * character is therefore an asset operation, not a code change.
 *
 * Playback uses two stacked <video> elements so switching animations
 * cross-fades instead of flashing. When no video at all can be resolved, a
 * procedural canvas renderer takes over so the stage is never blank.
 */

import { ANIMATION_FALLBACKS, EMOTIONS, VIDEO_CONFIG } from './config.js';
import { Emitter, logger } from './utils.js';

export class AnimationManager {
  constructor({ videoManager, config = VIDEO_CONFIG, log = logger } = {}) {
    this.videos = videoManager;
    this.config = config;
    this.log = log;
    this.events = new Emitter();

    this.stage = null;
    this.layers = [];
    this.activeLayer = 0;
    this.canvas = null;
    this.canvasContext = null;
    this.canvasFrame = null;
    this.canvasStartedAt = 0;

    this.idleCategory = 'idle';
    this.current = null;
    this.lastFileByCategory = new Map();
    this.returnTimer = null;
    this.destroyed = false;
  }

  /**
   * @param {HTMLElement} stage container that already holds
   *        two <video data-layer> elements and one <canvas data-fallback>
   */
  attach(stage) {
    this.stage = stage;
    this.layers = [...stage.querySelectorAll('video[data-layer]')];
    this.canvas = stage.querySelector('canvas[data-fallback]');
    this.canvasContext = this.canvas?.getContext('2d') ?? null;

    for (const layer of this.layers) {
      layer.muted = true;
      layer.playsInline = true;
      layer.setAttribute('playsinline', '');
      layer.preload = 'auto';
      layer.addEventListener('ended', () => this.#handleEnded(layer));
      layer.addEventListener('error', () => this.#handleError(layer));
    }

    if (this.layers.length < 2) {
      this.log.warn('animation', 'Expected two video layers for cross-fading');
    }
    return this;
  }

  setIdleAnimation(category) {
    this.idleCategory = String(category ?? 'idle').toLowerCase();
    return this.idleCategory;
  }

  getCurrent() {
    return this.current ? { ...this.current } : null;
  }

  /* ---------------------------------------------------------------- *
   * Playback
   * ---------------------------------------------------------------- */

  /**
   * @param {string} category  animation category, e.g. 'idle' | 'speaking'
   * @param {object} [options]
   * @param {boolean} [options.loop]        override the manifest's loop flag
   * @param {string}  [options.preferFile]  pin one asset (admin "test animation")
   * @param {boolean} [options.returnToIdle] go back to idle when it ends
   */
  async playAnimation(category, options = {}) {
    if (this.destroyed || !this.stage) return null;

    const name = String(category ?? '').toLowerCase();
    const resolved = this.videos.resolve(name, {
      preferFile: options.preferFile ?? null,
      avoidFile: this.lastFileByCategory.get(name) ?? null,
    });

    if (!resolved) {
      this.log.warn('animation', `No playable asset for "${name}" — canvas fallback`);
      this.#startCanvasFallback(name);
      this.current = {
        requested: name,
        category: 'fallback',
        file: null,
        source: 'canvas',
        loop: true,
        fallbackUsed: true,
      };
      this.events.emit('played', this.current);
      return this.current;
    }

    const loop = options.loop ?? resolved.loop;
    const layer = this.layers[(this.activeLayer + 1) % this.layers.length];
    const previous = this.layers[this.activeLayer];

    layer.loop = loop;
    layer.dataset.category = resolved.category;
    layer.dataset.returnToIdle = String(options.returnToIdle ?? !loop);

    if (layer.dataset.file !== resolved.file) {
      layer.src = resolved.url;
      layer.dataset.file = resolved.file;
      layer.load();
    } else {
      layer.currentTime = 0;
    }

    try {
      await layer.play();
    } catch (error) {
      // Autoplay rejections and decode failures both land here.
      this.log.warn('animation', `Playback rejected for ${resolved.file}`, error?.message);
      this.#markUnplayable(resolved, error);
      return this.#playFallbackChain(name, options);
    }

    this.#stopCanvasFallback();
    this.#crossfade(layer, previous);
    this.activeLayer = this.layers.indexOf(layer);
    this.lastFileByCategory.set(name, resolved.file);

    this.current = {
      requested: name,
      category: resolved.category,
      file: resolved.file,
      source: resolved.source,
      loop,
      fallbackUsed: resolved.fallbackUsed,
      chain: resolved.chain,
    };

    if (resolved.fallbackUsed) {
      this.events.emit('fallback', this.current);
      this.log.info(
        'animation',
        `"${name}" fell back to "${resolved.category}" (${resolved.file})`,
      );
    }
    this.events.emit('played', this.current);
    return this.current;
  }

  /** Emotions map 1:1 onto animation categories; unknown ones degrade safely. */
  async playEmotion(emotion, options = {}) {
    const name = String(emotion ?? 'neutral').toLowerCase();
    const category = EMOTIONS.includes(name) ? name : 'neutral';
    return this.playAnimation(category, { returnToIdle: true, ...options });
  }

  /** Play a random category that currently has at least one playable asset. */
  async playRandomAnimation(options = {}) {
    const categories = Object.keys(this.videos.manifest).filter(
      (category) => category !== 'fallback',
    );
    if (categories.length === 0) return this.playAnimation(this.idleCategory);
    const pick = categories[Math.floor(Math.random() * categories.length)];
    return this.playAnimation(pick, { returnToIdle: true, ...options });
  }

  async preloadAnimation(category, options = {}) {
    return this.videos.preloadAnimation(category, options);
  }

  async playIdle() {
    return this.playAnimation(this.idleCategory, { loop: true });
  }

  stopAnimation() {
    clearTimeout(this.returnTimer);
    for (const layer of this.layers) {
      try {
        layer.pause();
      } catch {
        /* ignore */
      }
      layer.classList.remove('is-visible');
    }
    this.#stopCanvasFallback();
    this.current = null;
    this.events.emit('stopped', null);
  }

  /**
   * Rebuild the registry and restart the current animation from whatever the
   * external directory now contains. This is the "Reload Videos" operation:
   * no application restart, no rebuild.
   */
  async reloadAnimations() {
    const previous = this.current?.requested ?? this.idleCategory;
    this.stopAnimation();
    for (const layer of this.layers) {
      layer.removeAttribute('src');
      delete layer.dataset.file;
      layer.load();
    }
    this.lastFileByCategory.clear();

    const manifest = await this.videos.reload();
    await this.playAnimation(previous, { loop: true });
    this.events.emit('reloaded', this.videos.getDiagnostics());
    this.log.info('animation', 'Animations reloaded from storage');
    return manifest;
  }

  destroy() {
    this.destroyed = true;
    this.stopAnimation();
    this.videos.releaseAll();
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  #crossfade(next, previous) {
    next.classList.add('is-visible');
    if (previous && previous !== next) {
      previous.classList.remove('is-visible');
      setTimeout(() => {
        if (previous !== this.layers[this.activeLayer]) {
          try {
            previous.pause();
          } catch {
            /* ignore */
          }
        }
      }, this.config.crossfadeMs);
    }
  }

  #handleEnded(layer) {
    if (layer.loop) return;
    this.events.emit('ended', { file: layer.dataset.file ?? null });
    if (layer.dataset.returnToIdle === 'true') {
      clearTimeout(this.returnTimer);
      this.returnTimer = setTimeout(() => this.playIdle(), 60);
    }
  }

  #handleError(layer) {
    const file = layer.dataset.file;
    if (!file) return;
    this.log.warn('animation', `Layer error on ${file}; marking invalid`);
    this.videos.validation.set(file, {
      file,
      source: this.videos.getSource(file),
      status: 'invalid',
      reason: 'Playback error on device',
      checkedAt: Date.now(),
    });
    const category = layer.dataset.category ?? this.idleCategory;
    this.#playFallbackChain(category, {});
  }

  #markUnplayable(resolved, error) {
    this.videos.validation.set(resolved.file, {
      file: resolved.file,
      source: resolved.source,
      status: 'invalid',
      reason: error?.message ?? 'Playback rejected',
      checkedAt: Date.now(),
    });
  }

  /** Retry down the configured chain once the current pick proved unplayable. */
  async #playFallbackChain(category, options) {
    const chain = ANIMATION_FALLBACKS[category] ?? ['idle'];
    for (const candidate of chain) {
      const resolved = this.videos.resolve(candidate);
      if (resolved) return this.playAnimation(candidate, { ...options, loop: true });
    }
    this.#startCanvasFallback(category);
    return null;
  }

  /* -------- procedural fallback (tier 3) --------------------------- *
   * An original, asset-free holographic pulse. It exists so a missing or
   * broken MP4 degrades into "something alive on screen" instead of a black
   * rectangle or a crash.
   * ----------------------------------------------------------------- */

  #startCanvasFallback(category) {
    if (!this.canvas || !this.canvasContext) return;
    for (const layer of this.layers) layer.classList.remove('is-visible');
    this.canvas.classList.add('is-visible');
    if (this.canvasFrame) return;

    this.canvasStartedAt = performance.now();
    const draw = (now) => {
      this.canvasFrame = requestAnimationFrame(draw);
      this.#drawFallbackFrame((now - this.canvasStartedAt) / 1000, category);
    };
    this.canvasFrame = requestAnimationFrame(draw);
  }

  #stopCanvasFallback() {
    if (this.canvasFrame) cancelAnimationFrame(this.canvasFrame);
    this.canvasFrame = null;
    this.canvas?.classList.remove('is-visible');
  }

  #drawFallbackFrame(time, category) {
    const canvas = this.canvas;
    const context = this.canvasContext;
    const width = (canvas.width = canvas.clientWidth || 480);
    const height = (canvas.height = canvas.clientHeight || 720);

    context.clearRect(0, 0, width, height);
    const centerX = width / 2;
    const centerY = height / 2;
    const base = Math.min(width, height) * 0.28;
    const hue = { happy: 165, sad: 215, angry: 350, surprised: 45 }[category] ?? 190;

    for (let ring = 0; ring < 4; ring += 1) {
      const phase = time * 1.1 + ring * 0.7;
      const radius = base + Math.sin(phase) * base * 0.12 + ring * base * 0.16;
      context.beginPath();
      context.strokeStyle = `hsla(${hue + ring * 6}, 92%, ${62 - ring * 6}%, ${0.5 - ring * 0.09})`;
      context.lineWidth = 2.5 - ring * 0.4;
      context.ellipse(centerX, centerY, radius, radius * 0.42, 0, 0, Math.PI * 2);
      context.stroke();
    }

    context.beginPath();
    const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, base);
    glow.addColorStop(0, `hsla(${hue}, 96%, 72%, 0.55)`);
    glow.addColorStop(1, 'hsla(200, 96%, 60%, 0)');
    context.fillStyle = glow;
    context.arc(centerX, centerY, base, 0, Math.PI * 2);
    context.fill();

    context.beginPath();
    context.strokeStyle = `hsla(${hue}, 96%, 78%, 0.85)`;
    context.lineWidth = 2;
    for (let x = 0; x <= width; x += 4) {
      const t = x / width;
      const amplitude = base * 0.22 * (0.35 + 0.65 * Math.sin(time * 2 + t * 6));
      const y = centerY + Math.sin(t * 12 + time * 5) * amplitude;
      if (x === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }
}

export default AnimationManager;
