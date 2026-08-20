/**
 * IRONBOX 1.0 — dialogue engine.
 *
 * Pipeline for one user utterance:
 *
 *   text → intent detection → local command?  → answer without a DB hit
 *                            ↓ no
 *        exact match → FTS5 match → keyword match → intent match
 *                            ↓
 *          rank ≤ searchLimit rows (matching.js)
 *                            ↓
 *        confidence ≥ threshold ? answer : fallback answer
 *
 * The engine returns an *emotion* and an *animation category*. It never sees a
 * filename, a video path or a character name — that separation is what lets
 * the assets be swapped without touching this file.
 */

import {
  CONVERSATION_CONFIG,
  DATABASE_CONFIG,
  LANGUAGE_CONFIG,
  MATCHING_CONFIG,
} from './config.js';
import { rankCandidates } from './matching.js';
import { BoundedList, logger, normalizeText, tokenize } from './utils.js';

const DEFAULT_FALLBACKS = [
  { text: 'I do not have an answer for that yet.', emotion: 'confused', animation: 'confused' },
  { text: 'Could you rephrase that for me?', emotion: 'confused', animation: 'thinking' },
  { text: 'That one is outside what I know right now.', emotion: 'sad', animation: 'sad' },
];

export class DialogueEngine {
  constructor({
    database,
    intentManager,
    config = DATABASE_CONFIG,
    matchingConfig = MATCHING_CONFIG,
    conversationConfig = CONVERSATION_CONFIG,
    log = logger,
  } = {}) {
    this.db = database;
    this.intents = intentManager;
    this.config = config;
    this.matchingConfig = matchingConfig;
    this.conversationConfig = conversationConfig;
    this.log = log;

    this.language = LANGUAGE_CONFIG.primary;
    this.history = new BoundedList(conversationConfig.CONVERSATION_MEMORY);
    this.fallbackCache = null;
    this.lastAnswer = null;
    this.stats = { queries: 0, answered: 0, fallbacks: 0, totalMs: 0 };
  }

  setLanguage(language) {
    if (!LANGUAGE_CONFIG.supported.includes(language)) {
      this.log.warn('dialogue', `Unsupported language ${language}; keeping ${this.language}`);
      return this.language;
    }
    this.language = language;
    this.fallbackCache = null;
    return this.language;
  }

  /**
   * @param {string} text user utterance
   * @returns {Promise<{answer, emotion, animation, confidence, source,
   *                    matchType, candidates, elapsedMs, intent}>}
   */
  async respond(text) {
    const started = Date.now();
    this.stats.queries += 1;

    const clean = String(text ?? '').trim();
    if (!clean) {
      return this.#finish(await this.#fallbackResponse('empty'), started, null);
    }

    const detected = this.intents?.detect(clean) ?? { intent: null, confidence: 0 };

    if (detected.intent && this.intents?.isLocalCommand(detected.intent)) {
      const local = this.intents.handleLocalCommand(detected.intent, {
        locale: this.language,
        lastAnswer: this.lastAnswer,
      });
      if (local) {
        return this.#finish(
          { ...local, confidence: detected.confidence, matchType: 'command', candidates: [] },
          started,
          detected.intent,
          clean,
        );
      }
    }

    const candidates = await this.#gather(clean, detected.intent);

    const contextTokens = this.#contextTokens();
    const ranked = rankCandidates(clean, candidates, {
      config: this.matchingConfig,
      intent: detected.intent,
      contextTokens,
      contextBoost: this.conversationConfig.contextBoost,
    });

    const best = ranked[0];
    if (!best || best.score < this.config.confidenceThreshold) {
      const fallback = await this.#fallbackResponse('low-confidence');
      fallback.confidence = best?.score ?? 0;
      fallback.candidates = ranked.slice(0, 5);
      return this.#finish(fallback, started, detected.intent, clean);
    }

    const response = {
      answer: best.answer,
      emotion: best.emotion ?? 'neutral',
      // animation defaults to the emotion; both are categories, never files
      animation: best.animation ?? best.emotion ?? 'speaking',
      confidence: best.score,
      matchType: best.matchType,
      source: 'database',
      rowId: best.id,
      category: best.category ?? null,
      candidates: ranked.slice(0, 5),
    };
    this.stats.answered += 1;
    return this.#finish(response, started, detected.intent, clean);
  }

  /** Search cascade. Every step is LIMITed inside SQLite. */
  async #gather(text, intent) {
    const limit = this.config.searchLimit;
    const collected = [];

    const exact = await this.db.searchExact(text, this.language, 3);
    collected.push(...exact);
    if (exact.length > 0) {
      // An exact hit is usually decisive; still cheap to enrich with FTS.
      const quick = rankCandidates(text, exact, { config: this.matchingConfig, intent });
      if ((quick[0]?.score ?? 0) >= this.config.confidenceShortCircuit) return exact;
    }

    const fts = await this.db.searchFts(text, this.language, limit);
    collected.push(...fts);

    if (fts.length < 3) {
      const tokens = await this.db.searchTokens(text, this.language, limit);
      collected.push(...tokens);
    }

    if (intent) {
      const byIntent = await this.db.searchIntent(intent, this.language, 5);
      collected.push(...byIntent);
    }

    // Cross-language fallback is opt-in: by default an unanswered question
    // gets a fallback line in the user's own language rather than an answer in
    // another one. Enable LANGUAGE_CONFIG.crossLanguageFallback when a sparse
    // secondary corpus should borrow from the primary one.
    if (collected.length === 0 && LANGUAGE_CONFIG.crossLanguageFallback) {
      for (const language of LANGUAGE_CONFIG.fallbackOrder) {
        if (language === this.language) continue;
        const rows = await this.db.searchFts(text, language, limit);
        if (rows.length > 0) {
          collected.push(...rows);
          break;
        }
      }
    }

    return collected;
  }

  #contextTokens() {
    const recent = this.history.last(this.conversationConfig.contextWindow);
    const stop = new Set(this.matchingConfig.stopWords);
    const tokens = [];
    for (const turn of recent) {
      tokens.push(...tokenize(`${turn.text ?? ''} ${turn.answer ?? ''}`, stop));
    }
    return tokens;
  }

  async #fallbackResponse(reason) {
    if (!this.fallbackCache) {
      const rows = await this.db.getFallbacks(this.language);
      this.fallbackCache = rows.length > 0 ? rows : DEFAULT_FALLBACKS;
    }
    const pick =
      this.fallbackCache[Math.floor(Math.random() * this.fallbackCache.length)];
    this.stats.fallbacks += 1;
    return {
      answer: pick.text,
      emotion: pick.emotion ?? 'confused',
      animation: pick.animation ?? 'confused',
      confidence: 0,
      matchType: 'fallback',
      source: `fallback:${reason}`,
      candidates: [],
    };
  }

  #finish(response, started, intent, text = '') {
    const elapsedMs = Date.now() - started;
    this.stats.totalMs += elapsedMs;

    const enriched = { ...response, elapsedMs, intent: intent ?? null };
    if (!enriched.silent) {
      this.history.push({
        at: Date.now(),
        text,
        answer: enriched.answer,
        emotion: enriched.emotion,
        intent: enriched.intent,
        confidence: enriched.confidence,
      });
      this.lastAnswer = {
        answer: enriched.answer,
        emotion: enriched.emotion,
        animation: enriched.animation,
      };
    }
    return enriched;
  }

  getHistory() {
    return this.history.toArray();
  }

  clearHistory() {
    this.history.clear();
    this.lastAnswer = null;
  }

  getStats() {
    const { queries, answered, fallbacks, totalMs } = this.stats;
    return {
      queries,
      answered,
      fallbacks,
      averageMs: queries > 0 ? Math.round(totalMs / queries) : 0,
      memoryTurns: this.history.length,
      memoryLimit: this.conversationConfig.CONVERSATION_MEMORY,
      language: this.language,
    };
  }
}

export { normalizeText };
export default DialogueEngine;
