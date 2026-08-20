/**
 * Confidence scoring: exact beats fuzzy, priority and intent act as tie
 * breakers, and nonsense stays below the answer threshold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rankCandidates, rankScore, scoreCandidate, explainScore } from '../www/js/matching.js';
import { DATABASE_CONFIG } from '../www/js/config.js';

const row = (overrides = {}) => ({
  id: 1,
  question: 'who are you',
  answer: 'I am IRONBOX.',
  keywords: 'identity name who',
  category: 'identity',
  emotion: 'happy',
  animation: 'happy',
  priority: 50,
  language: 'en-US',
  intent: 'identity',
  matchType: 'fts',
  rank: -2,
  ...overrides,
});

test('bm25 ranks map into 0..1 with better rows scoring higher', () => {
  assert.equal(rankScore(0, 'exact'), 1);
  assert.ok(rankScore(-8, 'fts') > rankScore(-1, 'fts'));
  assert.ok(rankScore(-100, 'fts') <= 1);
  assert.ok(rankScore(undefined, 'keyword') > 0, 'missing rank still scores');
});

test('an exact match scores near the top of the range', () => {
  const { score } = scoreCandidate('who are you', row({ matchType: 'exact', rank: 0 }));
  assert.ok(score > 0.9, `expected a high score, got ${score}`);
});

test('an unrelated row scores below the answer threshold', () => {
  const { score } = scoreCandidate(
    'how do I replace the videos',
    row({ question: 'what is the weather', keywords: 'weather rain', intent: null, priority: 0 }),
  );
  assert.ok(
    score < DATABASE_CONFIG.confidenceThreshold,
    `expected below ${DATABASE_CONFIG.confidenceThreshold}, got ${score}`,
  );
});

test('exact outranks fts, which outranks keyword, for the same text', () => {
  const query = 'who are you';
  const exact = scoreCandidate(query, row({ matchType: 'exact', rank: 0 })).score;
  const fts = scoreCandidate(query, row({ matchType: 'fts', rank: -3 })).score;
  const keyword = scoreCandidate(query, row({ matchType: 'keyword', rank: 1 })).score;
  assert.ok(exact > fts, `exact ${exact} should beat fts ${fts}`);
  assert.ok(fts > keyword, `fts ${fts} should beat keyword ${keyword}`);
});

test('priority breaks ties between otherwise equal rows', () => {
  const low = scoreCandidate('who are you', row({ priority: 0 })).score;
  const high = scoreCandidate('who are you', row({ priority: 100 })).score;
  assert.ok(high > low);
});

test('a matching intent raises confidence', () => {
  const without = scoreCandidate('who are you', row(), {}).score;
  const with_ = scoreCandidate('who are you', row(), { intent: 'identity' }).score;
  assert.ok(with_ > without);
});

test('recent conversation nudges related rows upward', () => {
  const plain = scoreCandidate('and the videos', row({ question: 'how do I replace videos' })).score;
  const inContext = scoreCandidate('and the videos', row({ question: 'how do I replace videos' }), {
    contextTokens: ['replace', 'videos'],
  }).score;
  assert.ok(inContext > plain);
});

test('ranking sorts, de-duplicates by id and keeps the best variant', () => {
  const ranked = rankCandidates('who are you', [
    row({ id: 1, matchType: 'keyword', rank: 1 }),
    row({ id: 1, matchType: 'exact', rank: 0 }),
    row({ id: 2, question: 'what is the weather', keywords: 'weather', intent: null, priority: 0 }),
  ]);

  assert.equal(ranked.length, 2, 'the duplicate id collapses');
  assert.equal(ranked[0].id, 1);
  assert.equal(ranked[0].matchType, 'exact', 'the better variant survives');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('scores stay inside 0..1', () => {
  const extreme = scoreCandidate('who are you', row({ priority: 100000, rank: -1000, matchType: 'exact' }), {
    intent: 'identity',
    contextTokens: ['who', 'are', 'you'],
  });
  assert.ok(extreme.score <= 1 && extreme.score >= 0, `score out of range: ${extreme.score}`);
});

test('empty input produces no confidence', () => {
  const { score } = scoreCandidate('', row());
  assert.ok(score < DATABASE_CONFIG.confidenceThreshold);
  assert.deepEqual(rankCandidates('anything', []), []);
});

test('the explanation lists the signals used', () => {
  const [best] = rankCandidates('who are you', [row({ matchType: 'exact', rank: 0 })], {
    intent: 'identity',
  });
  const text = explainScore(best);
  for (const part of ['score=', 'type=exact', 'overlap=', 'coverage=', 'priority=']) {
    assert.ok(text.includes(part), `expected "${part}" in "${text}"`);
  }
});
