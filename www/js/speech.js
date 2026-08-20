/**
 * IRONBOX 1.0 — speech recognition abstraction.
 *
 * WHAT THIS ACTUALLY IS — read before assuming offline behaviour:
 *
 *   Android : @capacitor-community/speech-recognition, which wraps the
 *             platform's SpeechRecognizer service. That service is provided by
 *             the device (usually Google's). Whether it works offline depends
 *             entirely on the device and on whether the user installed an
 *             offline language pack. IRONBOX cannot make that guarantee and
 *             does not claim to: getStatus() reports `offlineCapable: 'unknown'`.
 *   Browser : the Web Speech API where present (Chromium). That implementation
 *             streams audio to a remote service — it is online recognition.
 *
 * Interaction is push-to-talk by design: recognition starts on a button press
 * and stops on release or on `maxListenMs`. No always-on microphone.
 */

import { SPEECH_CONFIG } from './config.js';
import { Emitter, getPlugin, isNativePlatform, logger } from './utils.js';

export class SpeechRecognizer {
  constructor({ config = SPEECH_CONFIG, log = logger } = {}) {
    this.config = { ...config };
    this.log = log;
    this.events = new Emitter();
    this.plugin = null;
    this.webRecognition = null;
    this.native = false;
    this.available = false;
    this.listening = false;
    this.permission = 'unknown';
    this.lastPartial = '';
    this.stopTimer = null;
    this.listenerHandles = [];
  }

  async initialize() {
    this.native = isNativePlatform();
    this.plugin = getPlugin('SpeechRecognition');

    if (this.native && this.plugin) {
      try {
        const result = await this.plugin.available();
        this.available = Boolean(result?.available);
      } catch (error) {
        this.available = false;
        this.log.warn('speech', 'availability check failed', error?.message);
      }
      if (this.available) await this.#attachNativeListeners();
    } else {
      const Recognition =
        globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
      this.available = Boolean(Recognition);
      if (Recognition) this.#setupWebRecognition(Recognition);
    }

    this.log.info(
      'speech',
      `Recognition ${this.available ? 'available' : 'unavailable'} (${this.native ? 'android' : 'web'})`,
    );
    return this.getStatus();
  }

  async #attachNativeListeners() {
    try {
      this.listenerHandles.push(
        await this.plugin.addListener('partialResults', (data) => {
          const text = data?.matches?.[0] ?? '';
          if (!text) return;
          this.lastPartial = text;
          this.events.emit('partial', text);
        }),
      );
      this.listenerHandles.push(
        await this.plugin.addListener('listeningState', (data) => {
          const state = data?.status ?? data?.state;
          if (state === 'stopped' && this.listening) this.#finishNative();
        }),
      );
    } catch (error) {
      this.log.warn('speech', 'Could not attach listeners', error?.message);
    }
  }

  #setupWebRecognition(Recognition) {
    const recognition = new Recognition();
    recognition.lang = this.config.language;
    recognition.interimResults = this.config.partialResults;
    recognition.maxAlternatives = this.config.maxResults;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      let finalText = '';
      let partial = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalText += result[0].transcript;
        else partial += result[0].transcript;
      }
      if (partial) {
        this.lastPartial = partial;
        this.events.emit('partial', partial);
      }
      if (finalText) {
        this.listening = false;
        this.events.emit('result', finalText.trim());
      }
    };
    recognition.onerror = (event) => {
      this.listening = false;
      this.events.emit('error', event.error ?? 'recognition-error');
    };
    recognition.onend = () => {
      if (this.listening) {
        this.listening = false;
        if (this.lastPartial) this.events.emit('result', this.lastPartial.trim());
        else this.events.emit('end', null);
      }
    };

    this.webRecognition = recognition;
  }

  /** Ask for the microphone permission. Returns true when granted. */
  async requestPermission() {
    if (!this.native || !this.plugin) {
      this.permission = 'web';
      return true;
    }
    try {
      const current = await this.plugin.checkPermissions();
      if (current?.speechRecognition === 'granted') {
        this.permission = 'granted';
        return true;
      }
      const asked = await this.plugin.requestPermissions();
      this.permission = asked?.speechRecognition ?? 'denied';
      return this.permission === 'granted';
    } catch (error) {
      this.log.warn('speech', 'permission request failed', error?.message);
      this.permission = 'denied';
      return false;
    }
  }

  isListening() {
    return this.listening;
  }

  async startListening() {
    if (this.listening) return false;
    if (!this.available) {
      this.events.emit('error', 'unavailable');
      return false;
    }
    if (!(await this.requestPermission())) {
      this.events.emit('error', 'permission-denied');
      return false;
    }

    this.lastPartial = '';
    this.listening = true;
    this.events.emit('start', null);

    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.listening) this.stopListening();
    }, this.config.maxListenMs);

    if (this.native) {
      try {
        const result = await this.plugin.start({
          language: this.config.language,
          maxResults: this.config.maxResults,
          partialResults: this.config.partialResults,
          popup: false,
        });
        // Some Android versions resolve start() with the final matches.
        const text = result?.matches?.[0];
        if (text && this.listening) {
          this.listening = false;
          clearTimeout(this.stopTimer);
          this.events.emit('result', text.trim());
        }
      } catch (error) {
        this.listening = false;
        clearTimeout(this.stopTimer);
        this.events.emit('error', error?.message ?? 'start-failed');
        return false;
      }
    } else {
      try {
        this.webRecognition.lang = this.config.language;
        this.webRecognition.start();
      } catch (error) {
        this.listening = false;
        this.events.emit('error', error?.message ?? 'start-failed');
        return false;
      }
    }
    return true;
  }

  async stopListening() {
    clearTimeout(this.stopTimer);
    if (!this.listening) return false;

    if (this.native && this.plugin) {
      try {
        await this.plugin.stop();
      } catch (error) {
        this.log.warn('speech', 'stop failed', error?.message);
      }
      this.#finishNative();
    } else if (this.webRecognition) {
      try {
        this.webRecognition.stop();
      } catch {
        /* already stopped */
      }
    }
    return true;
  }

  #finishNative() {
    if (!this.listening) return;
    this.listening = false;
    const text = this.lastPartial.trim();
    if (text) this.events.emit('result', text);
    else this.events.emit('end', null);
  }

  setLanguage(language) {
    this.config.language = language;
    if (this.webRecognition) this.webRecognition.lang = language;
    return language;
  }

  onSpeechResult(handler) {
    return this.events.on('result', handler);
  }

  onSpeechPartial(handler) {
    return this.events.on('partial', handler);
  }

  onSpeechError(handler) {
    return this.events.on('error', handler);
  }

  onSpeechStart(handler) {
    return this.events.on('start', handler);
  }

  getStatus() {
    return {
      available: this.available,
      platform: this.native ? 'android' : 'web',
      engine: this.native
        ? 'Android SpeechRecognizer (device-provided)'
        : 'Web Speech API (online service)',
      /** Deliberately not claimed: depends on device language packs. */
      offlineCapable: this.native ? 'unknown — depends on device language packs' : 'no',
      permission: this.permission,
      language: this.config.language,
      listening: this.listening,
      mode: this.config.mode,
    };
  }

  async destroy() {
    await this.stopListening();
    for (const handle of this.listenerHandles) {
      try {
        await handle?.remove?.();
      } catch {
        /* ignore */
      }
    }
    this.listenerHandles = [];
  }
}

export default SpeechRecognizer;
