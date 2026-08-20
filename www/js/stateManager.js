/**
 * IRONBOX 1.0 — state machine.
 *
 * States and their legal transitions come from config.js, so adding a state is
 * a configuration change. Each state names an animation *category*; the
 * manager asks AnimationManager to play it and asks VideoManager to warm the
 * categories that usually come next.
 */

import { STATES, STATE_TRANSITIONS, VIDEO_CONFIG } from './config.js';
import { Emitter, logger } from './utils.js';

export class StateManager {
  constructor({
    animationManager = null,
    videoManager = null,
    states = STATES,
    transitions = STATE_TRANSITIONS,
    log = logger,
  } = {}) {
    this.animations = animationManager;
    this.videos = videoManager;
    this.states = states;
    this.transitions = transitions;
    this.log = log;
    this.events = new Emitter();

    this.current = 'IDLE';
    this.previous = null;
    this.enteredAt = Date.now();
    this.history = [];
  }

  list() {
    return Object.keys(this.states);
  }

  isValidTransition(from, to) {
    if (!this.states[to]) return false;
    if (from === to) return true;
    const anywhere = this.transitions['*'] ?? [];
    if (anywhere.includes(to)) return true;
    return (this.transitions[from] ?? []).includes(to);
  }

  /**
   * Enter a state, play its animation and preload the likely next ones.
   * Invalid transitions are refused and logged rather than thrown, so a
   * mis-sequenced UI event can never break the session.
   */
  async transition(to, options = {}) {
    const target = String(to ?? '').toUpperCase();
    const definition = this.states[target];

    if (!definition) {
      this.log.warn('state', `Unknown state "${target}" ignored`);
      return this.current;
    }
    if (!this.isValidTransition(this.current, target) && !options.force) {
      this.log.warn('state', `Illegal transition ${this.current} → ${target} ignored`);
      return this.current;
    }

    this.previous = this.current;
    this.current = target;
    this.enteredAt = Date.now();
    this.history.push({ state: target, at: this.enteredAt });
    if (this.history.length > 50) this.history.shift();

    this.events.emit('change', { from: this.previous, to: target });

    const category = options.animation ?? definition.animation;
    if (this.animations && category) {
      await this.animations.playAnimation(category, {
        loop: options.loop ?? definition.loop,
        returnToIdle: options.returnToIdle ?? !definition.loop,
        preferFile: options.preferFile ?? null,
      });
    }

    // Bounded, targeted preloading — never "load them all".
    if (this.videos && VIDEO_CONFIG.preloadGraph[target]) {
      this.videos.preloadForState(target).catch(() => {});
    }

    return this.current;
  }

  /** Convenience wrappers used by app.js. */
  idle(options) {
    return this.transition('IDLE', options);
  }

  listening(options) {
    return this.transition('LISTENING', options);
  }

  processing(options) {
    return this.transition('PROCESSING', options);
  }

  thinking(options) {
    return this.transition('THINKING', options);
  }

  speaking(options) {
    return this.transition('SPEAKING', options);
  }

  error(options) {
    return this.transition('ERROR', { force: true, ...options });
  }

  /** Map a dialogue emotion onto its state when one exists. */
  async emotion(emotion, options = {}) {
    const target = String(emotion ?? '').toUpperCase();
    if (this.states[target]) return this.transition(target, options);
    if (this.animations) await this.animations.playEmotion(emotion, options);
    return this.current;
  }

  onChange(handler) {
    return this.events.on('change', handler);
  }

  getStatus() {
    return {
      current: this.current,
      previous: this.previous,
      sinceMs: Date.now() - this.enteredAt,
      animation: this.states[this.current]?.animation ?? null,
      known: this.list(),
    };
  }
}

export default StateManager;
