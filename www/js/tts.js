/**
 * IRONBOX 1.0 — text-to-speech abstraction.
 *
 *   Android : @capacitor-community/text-to-speech (Android TextToSpeech engine)
 *   Browser : window.speechSynthesis
 *
 * Android's TextToSpeech has no pause/resume. Rather than pretend otherwise,
 * IRONBOX splits the answer into sentences and speaks them as a queue:
 * `pauseSpeaking()` stops after the current sentence and `resumeSpeaking()`
 * continues from the next one. That gives real, observable pause semantics on
 * both platforms without inventing an API.
 */

import { TTS_CONFIG } from './config.js';
import { Emitter, getPlugin, isNativePlatform, logger } from './utils.js';

/**
 * Split into chunks the TTS engine speaks one at a time — one sentence per
 * chunk, and long sentences broken at word boundaries. Chunk granularity is
 * what makes pause/resume meaningful on Android.
 */
export function splitSentences(text, maxChars = 220) {
  const clean = String(text ?? '').trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?\u2026]+[.!?\u2026]*\s*/g) ?? [clean];
  const chunks = [];

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= maxChars) {
      chunks.push(sentence);
      continue;
    }
    let buffer = '';
    for (const word of sentence.split(/\s+/)) {
      if (buffer && `${buffer} ${word}`.length > maxChars) {
        chunks.push(buffer);
        buffer = word;
      } else {
        buffer = buffer ? `${buffer} ${word}` : word;
      }
    }
    if (buffer) chunks.push(buffer);
  }

  return chunks;
}

export class TextToSpeech {
  constructor({ config = TTS_CONFIG, log = logger } = {}) {
    this.config = { ...config };
    this.log = log;
    this.events = new Emitter();
    this.plugin = null;
    this.native = false;
    this.available = false;
    this.speaking = false;
    this.paused = false;
    this.queue = [];
    this.cursor = 0;
    this.supportedLanguages = [];
  }

  async initialize() {
    this.native = isNativePlatform();
    this.plugin = getPlugin('TextToSpeech');

    if (this.native && this.plugin) {
      this.available = true;
      try {
        const result = await this.plugin.getSupportedLanguages();
        this.supportedLanguages = result?.languages ?? [];
      } catch (error) {
        this.log.warn('tts', 'Could not list languages', error?.message);
      }
    } else {
      this.available = typeof globalThis.speechSynthesis !== 'undefined';
      if (this.available) {
        const load = () => {
          this.supportedLanguages = [
            ...new Set(speechSynthesis.getVoices().map((voice) => voice.lang)),
          ];
        };
        load();
        speechSynthesis.addEventListener?.('voiceschanged', load);
      }
    }

    this.log.info('tts', `TTS ${this.available ? 'available' : 'unavailable'} (${this.native ? 'android' : 'web'})`);
    return this.getStatus();
  }

  isSpeaking() {
    return this.speaking;
  }

  /**
   * Speak a full answer. Resolves when the whole queue finished, was stopped
   * or was paused.
   */
  async speak(text) {
    const chunks = splitSentences(text);
    if (chunks.length === 0 || !this.available) {
      this.events.emit('end', null);
      return false;
    }

    await this.stopSpeaking();
    this.queue = chunks;
    this.cursor = 0;
    this.paused = false;
    this.speaking = true;
    this.events.emit('start', { chunks: chunks.length });

    await this.#drain();
    return true;
  }

  async #drain() {
    while (this.cursor < this.queue.length && this.speaking && !this.paused) {
      const chunk = this.queue[this.cursor];
      try {
        await this.#speakChunk(chunk);
      } catch (error) {
        this.log.warn('tts', 'chunk failed', error?.message);
        this.events.emit('error', error?.message ?? 'tts-error');
        break;
      }
      this.cursor += 1;
    }

    if (this.cursor >= this.queue.length) {
      this.speaking = false;
      this.queue = [];
      this.cursor = 0;
      this.events.emit('end', null);
    }
  }

  #speakChunk(chunk) {
    if (this.native) {
      return this.plugin.speak({
        text: chunk,
        lang: this.config.language,
        rate: this.config.rate,
        pitch: this.config.pitch,
        volume: this.config.volume,
        category: this.config.category,
      });
    }

    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = this.config.language;
      utterance.rate = this.config.rate;
      utterance.pitch = this.config.pitch;
      utterance.volume = this.config.volume;
      utterance.onend = () => resolve();
      utterance.onerror = (event) =>
        event.error === 'interrupted' || event.error === 'canceled'
          ? resolve()
          : reject(new Error(event.error ?? 'synthesis-error'));
      speechSynthesis.speak(utterance);
    });
  }

  async stopSpeaking() {
    const wasSpeaking = this.speaking;
    this.speaking = false;
    this.paused = false;
    this.queue = [];
    this.cursor = 0;

    if (this.native && this.plugin) {
      try {
        await this.plugin.stop();
      } catch (error) {
        this.log.warn('tts', 'stop failed', error?.message);
      }
    } else if (this.available) {
      speechSynthesis.cancel();
    }

    if (wasSpeaking) this.events.emit('stopped', null);
    return wasSpeaking;
  }

  /** Stop after the current sentence; the remaining queue is kept. */
  async pauseSpeaking() {
    if (!this.speaking || this.paused) return false;
    this.paused = true;

    if (this.native && this.plugin) {
      try {
        await this.plugin.stop();
      } catch {
        /* ignore */
      }
    } else if (this.available) {
      speechSynthesis.pause();
    }
    this.events.emit('paused', { remaining: this.queue.length - this.cursor });
    return true;
  }

  async resumeSpeaking() {
    if (!this.paused) return false;
    this.paused = false;

    if (!this.native && this.available && speechSynthesis.paused) {
      speechSynthesis.resume();
      this.events.emit('resumed', null);
      return true;
    }

    this.speaking = true;
    this.events.emit('resumed', { from: this.cursor });
    await this.#drain();
    return true;
  }

  setLanguage(language) {
    this.config.language = language;
    return language;
  }

  setRate(rate) {
    this.config.rate = rate;
    return rate;
  }

  onStart(handler) {
    return this.events.on('start', handler);
  }

  onEnd(handler) {
    return this.events.on('end', handler);
  }

  onError(handler) {
    return this.events.on('error', handler);
  }

  getStatus() {
    return {
      available: this.available,
      platform: this.native ? 'android' : 'web',
      engine: this.native ? 'Android TextToSpeech' : 'Web SpeechSynthesis',
      language: this.config.language,
      rate: this.config.rate,
      speaking: this.speaking,
      paused: this.paused,
      queued: Math.max(0, this.queue.length - this.cursor),
      supportedLanguages: this.supportedLanguages.slice(0, 40),
      /** Android TTS has no native pause; IRONBOX pauses between sentences. */
      pauseStrategy: this.native ? 'sentence-queue' : 'native',
    };
  }
}

export default TextToSpeech;
