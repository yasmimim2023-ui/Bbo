/**
 * Dialogue engine: the search cascade, confidence gating, local commands and
 * bounded conversation memory.
 *
 * The engine is exercised against a stub database so the assertions are about
 * the engine's decisions, not about SQLite (see database.test.js for that).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import DialogueEngine from '../www/js/dialogue.js';
import IntentManager from '../www/js/intentManager.js';
import { CONVERSATION_CONFIG, DATABASE_CONFIG } from '../www/js/config.js';
import { normalizeText } from '../www/js/utils.js';

const CORPUS = [
  {
    id: 1,
    question: 'who are you',
    answer: 'I am IRONBOX.',
    category: 'identity',
    emotion: 'happy',
    animation: 'happy',
    priority: 90,
    language: 'en-US',
    intent: 'identity',
    keywords: 'identity name who',
  },
  {
    id: 2,
    question: 'how do I replace the videos',
    answer: 'Copy MP4 files into the external videos directory.',
    category: 'capability',
    emotion: 'surprised',
    animation: 'surprised',
    priority: 80,
    language: 'en-US',
    intent: 'capability',
    keywords: 'videos replace external animation',
  },
];

/** Minimal stand-in for DialogueDatabase with the same method surface. */
class StubDatabase {
  constructor(rows = CORPUS) {
    this.rows = rows;
    this.calls = [];
    this.fallbacks = [
      { text: 'I do not know that yet.', emotion: 'confused', animation: 'confused' },
    ];
  }

  async searchExact(text, language, limit) {
    this.calls.push('exact');
    const norm = normalizeText(text);
    return this.rows
      .filter((row) => row.language === language && normalizeText(row.question) === norm)
      .slice(0, limit)
      .map((row) => ({ ...row, matchType: 'exact', rank: 0 }));
  }

  async searchFts(text, language, limit) {
    this.calls.push('fts');
    const tokens = new Set(normalizeText(text).split(' '));
    return this.rows
      .filter((row) => row.language === language)
      .filter((row) =>
        normalizeText(`${row.question} ${row.keywords}`)
          .split(' ')
          .some((token) => tokens.has(token)),
      )
      .slice(0, limit)
      .map((row) => ({ ...row, matchType: 'fts', rank: null }));
  }

  async searchTokens(text, language, limit) {
    this.calls.push('tokens');
    return this.searchFts(text, language, limit);
  }

  async searchIntent(intent, language, limit) {
    this.calls.push('intent');
    return this.rows
      .filter((row) => row.intent === intent && row.language === language)
      .slice(0, limit)
      .map((row) => ({ ...row, matchType: 'intent', rank: 0.5 }));
  }

  async getFallbacks() {
    this.calls.push('fallbacks');
    return this.fallbacks;
  }
}

function engineWith(rows) {
  const database = new StubDatabase(rows);
  const engine = new DialogueEngine({ database, intentManager: new IntentManager() });
  return { engine, database };
}

test('an exact question is answered with high confidence', async () => {
  const { engine } = engineWith();
  const response = await engine.respond('Who are you?');

  assert.equal(response.answer, 'I am IRONBOX.');
  assert.equal(response.matchType, 'exact');
  assert.equal(response.source, 'database');
  assert.ok(response.confidence > 0.9, `confidence was ${response.confidence}`);
});

test('an exact hit short-circuits the rest of the cascade', async () => {
  const { engine, database } = engineWith();
  await engine.respond('who are you');
  assert.deepEqual(database.calls, ['exact'], 'no FTS or intent query was needed');
});

test('the engine returns an emotion and an animation category, never a file', async () => {
  const { engine } = engineWith();
  const response = await engine.respond('how do I replace the videos');

  assert.equal(response.emotion, 'surprised');
  assert.equal(response.animation, 'surprised');
  for (const value of Object.values(response)) {
    if (typeof value === 'string') {
      assert.ok(!/\.(mp4|webm|m4v)$/i.test(value), `leaked a filename: ${value}`);
    }
  }
});

test('a paraphrase still reaches the right row through FTS', async () => {
  const { engine, database } = engineWith();
  const response = await engine.respond('replace videos');

  assert.match(response.answer, /external videos directory/);
  assert.ok(database.calls.includes('fts'));
});

test('an unknown question falls back instead of guessing', async () => {
  const { engine } = engineWith();
  const response = await engine.respond('what is the airspeed velocity of a swallow');

  assert.equal(response.matchType, 'fallback');
  assert.match(response.source, /^fallback:/);
  assert.ok(response.confidence < DATABASE_CONFIG.confidenceThreshold);
  assert.equal(response.emotion, 'confused');
});

test('an empty utterance is handled without touching the corpus', async () => {
  const { engine } = engineWith();
  const response = await engine.respond('   ');
  assert.equal(response.matchType, 'fallback');
});

test('local commands answer without a database query', async () => {
  const { engine, database } = engineWith();
  const response = await engine.respond('what time is it');

  assert.equal(response.source, 'command');
  assert.equal(response.matchType, 'command');
  assert.match(response.answer, /^It is /);
  assert.deepEqual(database.calls, [], 'no search was performed');
});

test('"repeat" replays the previous answer', async () => {
  const { engine } = engineWith();
  await engine.respond('who are you');
  const repeated = await engine.respond('say again');

  assert.equal(repeated.answer, 'I am IRONBOX.');
  assert.equal(repeated.source, 'command');
});

test('"stop" produces a silent response that is not recorded', async () => {
  const { engine } = engineWith();
  await engine.respond('who are you');
  const stop = await engine.respond('stop');

  assert.equal(stop.silent, true);
  assert.equal(stop.answer, '');
  assert.equal(engine.getHistory().length, 1, 'silent turns stay out of the transcript');
});

test('conversation memory is bounded by CONVERSATION_MEMORY', async () => {
  const { engine } = engineWith();
  for (let index = 0; index < CONVERSATION_CONFIG.CONVERSATION_MEMORY + 8; index += 1) {
    await engine.respond(`who are you ${index}`);
  }

  const history = engine.getHistory();
  assert.equal(history.length, CONVERSATION_CONFIG.CONVERSATION_MEMORY);
  assert.match(history.at(-1).text, /17$/, 'the newest turn is kept');
});

test('history can be cleared', async () => {
  const { engine } = engineWith();
  await engine.respond('who are you');
  engine.clearHistory();
  assert.equal(engine.getHistory().length, 0);
  assert.equal(engine.lastAnswer, null);
});

test('language selection is validated and scopes the search', async () => {
  const { engine } = engineWith();
  assert.equal(engine.setLanguage('pt-BR'), 'pt-BR');
  assert.equal(engine.setLanguage('kl-KL'), 'pt-BR', 'unsupported tags are refused');

  const response = await engine.respond('who are you');
  assert.equal(response.matchType, 'fallback', 'English rows are out of scope for pt-BR');
});

test('statistics track answers, fallbacks and latency', async () => {
  const { engine } = engineWith();
  await engine.respond('who are you');
  await engine.respond('nonsense that matches nothing at all');

  const stats = engine.getStats();
  assert.equal(stats.queries, 2);
  assert.equal(stats.answered, 1);
  assert.equal(stats.fallbacks, 1);
  assert.ok(stats.averageMs >= 0);
  assert.equal(stats.memoryLimit, CONVERSATION_CONFIG.CONVERSATION_MEMORY);
});

test('a database failure surfaces rather than being swallowed', async () => {
  const database = new StubDatabase();
  database.searchExact = async () => {
    throw new Error('disk I/O error');
  };
  const engine = new DialogueEngine({ database, intentManager: new IntentManager() });
  await assert.rejects(() => engine.respond('who are you'), /disk I\/O error/);
});
