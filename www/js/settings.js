/**
 * IRONBOX 1.0 — persisted user/developer settings.
 *
 * Stored in localStorage, which inside the Android WebView is per-app private
 * storage. Settings never contain asset paths or character names — only
 * preferences the engine reads at startup.
 */

import { LANGUAGE_CONFIG, TTS_CONFIG, UI_CONFIG } from './config.js';
import { Emitter, logger } from './utils.js';

const STORAGE_KEY = 'ironbox.settings.v1';

export const DEFAULT_SETTINGS = {
  language: LANGUAGE_CONFIG.primary,
  ttsRate: TTS_CONFIG.rate,
  ttsPitch: TTS_CONFIG.pitch,
  ttsEnabled: true,
  /** Copy packaged videos into the external directory on first launch. */
  seedExternalVideos: true,
  /** Validate every referenced asset at startup (slower with 300+ videos). */
  validateOnStart: false,
  idleAnimation: 'idle',
  developerMode: false,
  transcriptLimit: UI_CONFIG.transcriptLimit,
};

export class Settings {
  constructor({ log = logger } = {}) {
    this.log = log;
    this.events = new Emitter();
    this.values = { ...DEFAULT_SETTINGS };
    this.load();
  }

  load() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (raw) Object.assign(this.values, JSON.parse(raw));
    } catch (error) {
      this.log.warn('settings', 'Could not read stored settings', error?.message);
    }
    return this.values;
  }

  save() {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.values));
      return true;
    } catch (error) {
      this.log.warn('settings', 'Could not persist settings', error?.message);
      return false;
    }
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (!(key in DEFAULT_SETTINGS)) {
      this.log.warn('settings', `Unknown setting "${key}" ignored`);
      return this.values[key];
    }
    this.values[key] = value;
    this.save();
    this.events.emit('change', { key, value });
    return value;
  }

  all() {
    return { ...this.values };
  }

  reset() {
    this.values = { ...DEFAULT_SETTINGS };
    this.save();
    this.events.emit('reset', this.values);
    return this.values;
  }

  onChange(handler) {
    return this.events.on('change', handler);
  }

  /** True exactly once, on the first launch after install. */
  isFirstRun() {
    try {
      return !globalThis.localStorage?.getItem(`${STORAGE_KEY}.launched`);
    } catch {
      return false;
    }
  }

  markLaunched() {
    try {
      globalThis.localStorage?.setItem(`${STORAGE_KEY}.launched`, String(Date.now()));
    } catch {
      /* ignore */
    }
  }
}

export default Settings;
