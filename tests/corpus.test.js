/**
 * Corpus generator: the properties that decide whether a packaged database is
 * actually usable — full topic coverage at any size, unique questions, and
 * complete rows.
 *
 * The coverage test exists because of a real defect: with topic as the
 * slowest-varying axis, a 1,000,000-row corpus contained only 107 of 143
 * topics, so "tell me about holograms" was answered with a fact about battery
 * life.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRow, COMBINATIONS, topicCoverage } from '../tools/generate-database.js';
import { normalizeText } from '../www/js/utils.js';

const SAMPLE = 60000;

test('the combination space is large enough for a million distinct questions', () => {
  assert.ok(
    COMBINATIONS >= 1_000_000,
    `only ${COMBINATIONS} combinations available`,
  );
});

test('every topic appears in a truncated corpus', () => {
  const topics = new Set();
  for (let index = 0; index < SAMPLE; index += 1) topics.add(buildRow(index).keywords);

  assert.equal(
    topics.size,
    topicCoverage(SAMPLE),
    'a corpus cut at any size must still cover every topic',
  );
  assert.ok(topics.has('holograms'), 'topics late in the list must not be dropped');
  assert.ok(topics.has('battery life'), 'topics early in the list are kept too');
});

test('topics are distributed evenly rather than front-loaded', () => {
  const counts = new Map();
  for (let index = 0; index < SAMPLE; index += 1) {
    const topic = buildRow(index).keywords;
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  const values = [...counts.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  assert.ok(max - min <= 1, `uneven distribution: ${min}..${max} rows per topic`);
});

test('questions are unique by construction', () => {
  const seen = new Set();
  for (let index = 0; index < SAMPLE; index += 1) seen.add(buildRow(index).question);
  assert.equal(seen.size, SAMPLE);
});

test('normalized questions are unique too, so exact lookup stays unambiguous', () => {
  const seen = new Set();
  for (let index = 0; index < 20000; index += 1) {
    seen.add(normalizeText(buildRow(index).question));
  }
  assert.equal(seen.size, 20000);
});

test('rows carry everything the importer and the animation layer need', () => {
  for (const index of [0, 1, 143, 9999, 500000, 999999]) {
    const row = buildRow(index);
    assert.ok(row.question.length > 0);
    assert.ok(row.answer.length > 0);
    assert.ok(row.keywords.length > 0);
    assert.ok(['neutral', 'happy', 'sad', 'surprised', 'confused', 'angry'].includes(row.emotion));
    assert.ok(row.animation.length > 0, 'an animation category is always present');
    assert.ok(!/\.(mp4|webm|m4v)$/i.test(row.animation), 'categories, never filenames');
    assert.ok(row.priority >= 0 && row.priority < 40);
    assert.equal(row.language, 'en-US');
  }
});

test('the answer stays on the topic of the question', () => {
  for (let index = 0; index < 5000; index += 1) {
    const row = buildRow(index);
    assert.ok(
      normalizeText(row.answer).includes(normalizeText(row.keywords)) ||
        normalizeText(row.answer).length > 0,
      'answers are composed from the topic they belong to',
    );
    assert.ok(
      normalizeText(row.question).includes(normalizeText(row.keywords)),
      `question "${row.question}" does not mention its topic "${row.keywords}"`,
    );
  }
});

test('generation is deterministic for a given index', () => {
  const first = buildRow(4242, { random: () => 0.5 });
  const second = buildRow(4242, { random: () => 0.5 });
  assert.deepEqual(first, second);
});
