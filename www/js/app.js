/**
 * IRONBOX 1.0 — application wiring.
 *
 *   UI ─┬─ StateManager ─── AnimationManager ─── VideoManager ─── VideoStorageAdapter
 *       ├─ SpeechRecognizer                                            │
 *       ├─ TextToSpeech                              external videos ──┘ (priority 1)
 *       └─ DialogueEngine ─── DialogueDatabase (SQLite + FTS5)
 *
 * The dialogue side produces emotions and animation *categories*; the
 * animation side resolves those to files. Neither knows about the other's
 * internals, which is what makes the character replaceable after build.
 */

import {
  ASSISTANT_CONFIG,
  LANGUAGE_CONFIG,
  UI_CONFIG,
  applyConfigOverrides,
} from './config.js';
import AdminPanel from './adminPanel.js';
import AnimationManager from './animationManager.js';
import DialogueEngine from './dialogue.js';
import Diagnostics from './diagnostics.js';
import DialogueDatabase from './database.js';
import IntentManager from './intentManager.js';
import Settings from './settings.js';
import SpeechRecognizer from './speech.js';
import StateManager from './stateManager.js';
import TextToSpeech from './tts.js';
import VideoManager from './videoManager.js';
import VideoStorageAdapter from './storageManager.js';
import { escapeHtml, logger } from './utils.js';

class IronboxApp {
  constructor() {
    this.name = ASSISTANT_CONFIG.name;
    this.log = logger;
    this.settings = new Settings({ log: logger });

    this.storage = new VideoStorageAdapter({ log: logger });
    this.videos = new VideoManager({ storage: this.storage, log: logger });
    this.animations = new AnimationManager({ videoManager: this.videos, log: logger });
    this.database = new DialogueDatabase({ log: logger });
    this.intents = new IntentManager();
    this.dialogue = new DialogueEngine({
      database: this.database,
      intentManager: this.intents,
      log: logger,
    });
    this.states = new StateManager({
      animationManager: this.animations,
      videoManager: this.videos,
      log: logger,
    });
    this.speech = new SpeechRecognizer({ log: logger });
    this.tts = new TextToSpeech({ log: logger });
    this.diagnostics = new Diagnostics({ app: this, log: logger });
    this.admin = new AdminPanel({
      app: this,
      diagnostics: this.diagnostics,
      settings: this.settings,
      log: logger,
    });

    this.elements = {};
    this.busy = false;
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  async start() {
    this.#cacheElements();
    this.#renderIdentity();

    try {
      await this.#loadConfigOverrides();

      this.#boot('Preparing storage…');
      await this.storage.initialize();

      this.#boot('Loading animations…');
      await this.videos.initialize();
      this.animations.attach(this.elements.stage);
      this.animations.setIdleAnimation(this.settings.get('idleAnimation'));

      await this.#seedExternalVideosIfNeeded();

      this.#boot('Opening database…');
      await this.database.initialize();
      this.dialogue.setLanguage(this.settings.get('language'));

      this.#boot('Starting voice services…');
      await Promise.all([this.speech.initialize(), this.tts.initialize()]);
      this.tts.setLanguage(this.settings.get('language'));
      this.tts.setRate(this.settings.get('ttsRate'));
      this.speech.setLanguage(this.settings.get('language'));

      this.#bindUi();
      this.admin.initialize();

      if (this.settings.get('validateOnStart')) {
        this.#boot('Validating videos…');
        await this.videos.validateAll();
      }

      await this.states.transition('IDLE', { force: true });
      this.settings.markLaunched();
      this.#bootDone();
      this.#say(`${this.name} online.`, { speak: false });
      this.log.info('app', `${this.name} ${ASSISTANT_CONFIG.version} ready`);
    } catch (error) {
      this.log.error('app', 'Startup failed', error?.message ?? String(error));
      this.#bootDone();
      this.#say(`${this.name} started with errors: ${error?.message ?? error}`, {
        speak: false,
      });
      await this.states.error();
    }
  }

  /** Packaged defaults first, then an optional external override file. */
  async #loadConfigOverrides() {
    try {
      const response = await fetch('data/default-config.json', { cache: 'no-store' });
      if (response.ok) applyConfigOverrides(await response.json());
    } catch {
      /* packaged config is optional */
    }
    const external = await this.storage.loadConfigOverrides?.();
    if (external) {
      applyConfigOverrides(external);
      this.log.info('app', 'Applied external ironbox-config.json overrides');
    }
  }

  /**
   * First launch: copy the packaged videos into IRONBOX/videos/ so the user has
   * real files to replace. Existing files are never overwritten.
   */
  async #seedExternalVideosIfNeeded() {
    if (!this.storage.ready) return;
    if (!this.settings.get('seedExternalVideos')) return;
    if (this.storage.ready && this.videos.externalFiles.length > 0) return;

    const packaged = Object.values(this.videos.packagedManifest)
      .flatMap((entry) => entry.videos.map((video) => video.file));
    if (packaged.length === 0) return;

    this.#boot('Copying default videos…');
    await this.storage.seedFromPackaged([...new Set(packaged)]);
    await this.videos.load();
  }

  /* ---------------------------------------------------------------- *
   * Conversation
   * ---------------------------------------------------------------- */

  /** One full turn: text in → answer, animation and speech out. */
  async handleUtterance(text) {
    const clean = String(text ?? '').trim();
    if (!clean || this.busy) return null;
    this.busy = true;

    try {
      this.#appendTranscript('user', clean);
      await this.states.processing();

      const response = await this.dialogue.respond(clean);

      if (response.silent) {
        await this.tts.stopSpeaking();
        await this.states.idle();
        return response;
      }

      this.#appendTranscript('assistant', response.answer, {
        confidence: response.confidence,
        matchType: response.matchType,
        emotion: response.emotion,
      });

      await this.states.speaking();
      this.#say(response.answer, { speak: false });

      const speaking =
        this.settings.get('ttsEnabled') && this.tts.available
          ? this.tts.speak(response.answer)
          : Promise.resolve();

      // The emotional animation plays over the answer rather than after it.
      await this.states.emotion(response.emotion, { returnToIdle: true });
      await speaking;

      setTimeout(() => {
        if (!this.busy) this.states.idle();
      }, UI_CONFIG.idleReturnDelayMs);

      return response;
    } catch (error) {
      this.log.error('app', 'Turn failed', error?.message ?? String(error));
      await this.states.error();
      this.#say('Something went wrong while answering that.', { speak: false });
      return null;
    } finally {
      this.busy = false;
      setTimeout(() => {
        if (!this.busy && this.states.current !== 'IDLE') this.states.idle();
      }, UI_CONFIG.idleReturnDelayMs);
    }
  }

  setLanguage(language) {
    if (!LANGUAGE_CONFIG.supported.includes(language)) return this.dialogue.language;
    this.dialogue.setLanguage(language);
    this.speech.setLanguage(language);
    this.tts.setLanguage(language);
    this.log.info('app', `Language set to ${language}`);
    return language;
  }

  /* ---------------------------------------------------------------- *
   * UI
   * ---------------------------------------------------------------- */

  #cacheElements() {
    this.elements = {
      stage: document.getElementById('stage'),
      caption: document.getElementById('caption'),
      transcript: document.getElementById('transcript'),
      composer: document.getElementById('composer'),
      input: document.getElementById('composer-input'),
      talk: document.getElementById('talk'),
      badgeState: document.getElementById('badge-state'),
      badgeSource: document.getElementById('badge-source'),
      boot: document.getElementById('boot'),
      bootText: document.getElementById('boot-text'),
    };
  }

  #renderIdentity() {
    document.getElementById('assistant-name').textContent = ASSISTANT_CONFIG.name;
    document.getElementById('assistant-version').textContent = ASSISTANT_CONFIG.version;
    document.title = `${ASSISTANT_CONFIG.name} ${ASSISTANT_CONFIG.version}`;
  }

  #bindUi() {
    const { composer, input, talk } = this.elements;

    composer.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      this.handleUtterance(text);
    });

    // Push-to-talk: hold to listen, release to send.
    const startListening = async (event) => {
      event.preventDefault();
      if (this.speech.isListening()) return;
      talk.classList.add('is-listening');
      await this.states.listening();
      await this.speech.startListening();
    };
    const stopListening = async () => {
      talk.classList.remove('is-listening');
      if (this.speech.isListening()) await this.speech.stopListening();
    };

    talk.addEventListener('pointerdown', startListening);
    talk.addEventListener('pointerup', stopListening);
    talk.addEventListener('pointercancel', stopListening);
    talk.addEventListener('pointerleave', stopListening);

    this.speech.onSpeechPartial((text) => {
      this.#say(text, { speak: false, partial: true });
    });
    this.speech.onSpeechResult((text) => {
      talk.classList.remove('is-listening');
      this.handleUtterance(text);
    });
    this.speech.onSpeechError((reason) => {
      talk.classList.remove('is-listening');
      this.log.warn('speech', `Recognition error: ${reason}`);
      this.#say(this.#speechErrorText(reason), { speak: false });
      this.states.idle();
    });
    this.speech.events.on('end', () => {
      talk.classList.remove('is-listening');
      this.states.idle();
    });

    if (!this.speech.getStatus().available) {
      talk.disabled = true;
      talk.title = 'Speech recognition unavailable on this device';
    }

    this.states.onChange(({ to }) => {
      this.elements.badgeState.textContent = to;
      this.elements.stage.dataset.state = to;
    });

    this.animations.events.on('played', (current) => {
      const label = {
        external: 'EXTERNAL',
        packaged: 'PACKAGED',
        memory: 'IMPORTED',
        canvas: 'FALLBACK',
      }[current?.source] ?? '—';
      this.elements.badgeSource.textContent = label;
      this.elements.badgeSource.title = current?.file
        ? `${current.category}: ${current.file} (${current.source})`
        : 'Procedural fallback — no video asset resolved';
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.tts.stopSpeaking();
        this.speech.stopListening();
      }
    });
  }

  #speechErrorText(reason) {
    switch (reason) {
      case 'permission-denied':
        return 'Microphone permission is required for voice input.';
      case 'unavailable':
        return 'Speech recognition is not available on this device.';
      case 'no-speech':
        return 'I did not catch that.';
      default:
        return `Voice input failed (${reason}).`;
    }
  }

  #appendTranscript(role, text, meta = null) {
    const item = document.createElement('li');
    item.className = role === 'user' ? 'from-user' : 'from-assistant';
    item.innerHTML = escapeHtml(text);

    if (meta) {
      const detail = document.createElement('span');
      detail.className = 'meta';
      detail.textContent = `${meta.emotion} · ${meta.matchType} · ${(meta.confidence ?? 0).toFixed(2)}`;
      item.append(detail);
    }

    const list = this.elements.transcript;
    list.append(item);
    while (list.children.length > this.settings.get('transcriptLimit')) {
      list.firstElementChild.remove();
    }
    list.scrollTop = list.scrollHeight;
  }

  #say(text, { speak = true, partial = false } = {}) {
    this.elements.caption.textContent = text;
    this.elements.caption.dataset.partial = String(partial);
    if (speak && this.settings.get('ttsEnabled')) this.tts.speak(text);
  }

  #boot(message) {
    if (this.elements.bootText) this.elements.bootText.textContent = message;
  }

  #bootDone() {
    this.elements.boot?.classList.add('is-done');
    setTimeout(() => this.elements.boot?.remove(), 600);
  }
}

const app = new IronboxApp();
/** Exposed for the developer console and for automated device checks. */
globalThis.IRONBOX = app;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => app.start());
} else {
  app.start();
}

export default app;
