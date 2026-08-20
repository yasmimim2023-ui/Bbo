/**
 * IRONBOX 1.0 — shared helpers.
 *
 * Deliberately dependency-free and DOM-free so the same functions can be unit
 * tested under Node and reused by the tools in tools/.
 */

/** Collapse case, accents and punctuation so equal questions compare equal. */
export function normalizeText(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split normalized text into tokens, dropping stop words. */
export function tokenize(input, stopWords = []) {
  const stop = stopWords instanceof Set ? stopWords : new Set(stopWords);
  return normalizeText(input)
    .split(' ')
    .filter((token) => token.length > 0 && !stop.has(token));
}

/**
 * Escape a user phrase for an FTS5 MATCH expression. Every token is quoted,
 * which makes operators like `-`, `*`, `NEAR` and `"` inert.
 *
 * `join` picks the semantics: 'AND' is the precise pass (every token must
 * appear, few candidates), 'OR' the recall pass. `maxTokens` caps pathological
 * input so one very long utterance cannot build a huge expression.
 */
export function toFtsQuery(input, { prefix = false, join = 'OR', maxTokens = 12 } = {}) {
  const tokens = normalizeText(input).split(' ').filter(Boolean).slice(0, maxTokens);
  if (tokens.length === 0) return '';
  return tokens
    .map((token) => `"${token.replace(/"/g, '""')}"${prefix ? '*' : ''}`)
    .join(` ${join} `);
}

/** Jaccard-style overlap of two token lists, 0..1. */
export function tokenOverlap(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/** Fraction of the query's tokens present in the candidate, 0..1. */
export function coverage(queryTokens, candidateTokens) {
  if (queryTokens.length === 0) return 0;
  const candidate = new Set(candidateTokens);
  let hits = 0;
  for (const token of queryTokens) if (candidate.has(token)) hits += 1;
  return hits / queryTokens.length;
}

export function clamp(value, min = 0, max = 1) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Pick one item from `[{weight}]` proportionally to weight.
 * `random` is injectable so tests stay deterministic.
 */
export function weightedPick(items, random = Math.random) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const usable = items.filter((item) => (item?.weight ?? 1) > 0);
  const pool = usable.length > 0 ? usable : items;
  const total = pool.reduce((sum, item) => sum + (item.weight ?? 1), 0);
  if (total <= 0) return pool[0];

  let ticket = random() * total;
  for (const item of pool) {
    ticket -= item.weight ?? 1;
    if (ticket <= 0) return item;
  }
  return pool[pool.length - 1];
}

/** Ring buffer that never grows past `limit`. */
export class BoundedList {
  constructor(limit = 10) {
    this.limit = Math.max(1, limit);
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    while (this.items.length > this.limit) this.items.shift();
    return item;
  }

  toArray() {
    return [...this.items];
  }

  last(count = 1) {
    return this.items.slice(-count);
  }

  clear() {
    this.items.length = 0;
  }

  get length() {
    return this.items.length;
  }
}

/** Least-recently-used map with an eviction callback. */
export class LruCache {
  constructor(limit = 8, onEvict = null) {
    this.limit = Math.max(1, limit);
    this.onEvict = onEvict;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      const evicted = this.map.get(oldest);
      this.map.delete(oldest);
      this.onEvict?.(evicted, oldest);
    }
    return value;
  }

  clear() {
    if (this.onEvict) {
      for (const [key, value] of this.map) this.onEvict(value, key);
    }
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

/** Minimal event emitter — the app never pulls in a framework for this. */
export class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[emitter] listener for "${event}" failed`, error);
      }
    }
  }
}

/** Ring-buffered logger; the admin panel renders `logger.entries`. */
export class Logger {
  constructor(limit = 300) {
    this.entries = new BoundedList(limit);
    this.emitter = new Emitter();
  }

  write(level, scope, message, detail) {
    const entry = {
      at: Date.now(),
      level,
      scope,
      message,
      detail: detail === undefined ? null : detail,
    };
    this.entries.push(entry);
    this.emitter.emit('entry', entry);
    const line = `[${scope}] ${message}`;
    if (level === 'error') console.error(line, detail ?? '');
    else if (level === 'warn') console.warn(line, detail ?? '');
    else console.log(line, detail ?? '');
    return entry;
  }

  info(scope, message, detail) {
    return this.write('info', scope, message, detail);
  }

  warn(scope, message, detail) {
    return this.write('warn', scope, message, detail);
  }

  error(scope, message, detail) {
    return this.write('error', scope, message, detail);
  }

  onEntry(handler) {
    return this.emitter.on('entry', handler);
  }

  toArray() {
    return this.entries.toArray();
  }

  clear() {
    this.entries.clear();
  }
}

export const logger = new Logger();

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject a promise that takes too long, without leaving a dangling timer. */
export function withTimeout(promise, ms, message = 'timed out') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

/* ------------------------------------------------------------------ *
 * Capacitor bridge helpers
 *
 * The app deliberately ships without a bundler, so plugins are reached
 * through the runtime registry the native bridge injects into the WebView
 * (`window.Capacitor.Plugins.*`) instead of ES imports. Every helper below
 * degrades to `null`/`false` in a plain browser.
 * ------------------------------------------------------------------ */

export function getCapacitor() {
  return globalThis.Capacitor ?? null;
}

export function isNativePlatform() {
  return Boolean(getCapacitor()?.isNativePlatform?.());
}

export function getPlatform() {
  return getCapacitor()?.getPlatform?.() ?? 'web';
}

export function getPlugin(name) {
  const plugins = getCapacitor()?.Plugins;
  return plugins?.[name] ?? null;
}

/**
 * Turn a native file:// URI into something the WebView may load.
 * Capacitor proxies it through its local server (`/_capacitor_file_/…`),
 * which supports the range requests <video> needs for seeking.
 */
export function convertFileSrc(url) {
  const capacitor = getCapacitor();
  if (capacitor?.convertFileSrc) return capacitor.convertFileSrc(url);
  return url;
}

/** Read a Blob slice as raw base64 (no data: prefix). */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}
