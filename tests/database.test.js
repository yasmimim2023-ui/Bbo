/**
 * Database layer: the schema and the exact SQL the app runs, executed against
 * a real SQLite build (node:sqlite). This is what proves the statements in
 * www/js/database.js are valid and bounded — not a mock of them.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { SQL } from '../www/js/database.js';
import { DATABASE_CONFIG } from '../www/js/config.js';
import { normalizeText, toFtsQuery } from '../www/js/utils.js';
import { normalizeText as toolNormalize } from '../tools/import-database.js';

let db;
let fts5 = false;

const insert = (row) =>
  db
    .prepare(
      `INSERT INTO dialogues (question, question_norm, answer, category, emotion,
        animation, priority, language, intent, keywords) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.question,
      normalizeText(row.question),
      row.answer,
      row.category ?? null,
      row.emotion ?? 'neutral',
      row.animation ?? 'speaking',
      row.priority ?? 0,
      row.language ?? 'en-US',
      row.intent ?? null,
      row.keywords ?? '',
    );

before(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync('database/schema.sql', 'utf8').replace(/PRAGMA journal_mode[^;]*;/i, ''));
  try {
    db.exec(readFileSync('database/schema-fts5.sql', 'utf8'));
    fts5 = true;
  } catch {
    fts5 = false;
  }

  insert({
    question: 'Who are you',
    answer: 'I am IRONBOX.',
    category: 'identity',
    emotion: 'happy',
    animation: 'happy',
    priority: 90,
    intent: 'identity',
    keywords: 'identity name who',
  });
  insert({
    question: 'How do I replace the videos',
    answer: 'Copy MP4 files into the external videos directory and reload.',
    category: 'capability',
    emotion: 'happy',
    animation: 'happy',
    priority: 80,
    intent: 'capability',
    keywords: 'videos replace animation external',
  });
  insert({
    question: 'Quem é você',
    answer: 'Sou o IRONBOX.',
    emotion: 'happy',
    animation: 'happy',
    language: 'pt-BR',
    intent: 'identity',
    keywords: 'identidade nome',
  });

  // Bulk rows so the LIMIT guarantees are meaningful.
  for (let index = 0; index < 1000; index += 1) {
    insert({
      question: `benchmark question number ${index}`,
      answer: `benchmark answer ${index}`,
      keywords: 'benchmark question',
      priority: index % 50,
    });
  }

  db.prepare('INSERT INTO fallbacks (text, emotion, animation, language) VALUES (?,?,?,?)').run(
    'I do not know that yet.',
    'confused',
    'confused',
    'en-US',
  );
});

after(() => db?.close());

test('schema creates the tables and indexes the app relies on', () => {
  const objects = db
    .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','index')")
    .all()
    .map((row) => row.name);

  for (const name of ['dialogues', 'fallbacks', 'meta']) assert.ok(objects.includes(name), name);
  for (const name of [
    'idx_dialogues_norm_lang',
    'idx_dialogues_language',
    'idx_dialogues_intent',
    'idx_dialogues_category',
    'idx_dialogues_priority',
  ]) {
    assert.ok(objects.includes(name), `missing index ${name}`);
  }
});

test('FTS5 is available in this SQLite build', () => {
  assert.ok(fts5, 'the test environment should provide FTS5');
  const indexed = db.prepare('SELECT COUNT(*) AS n FROM dialogues_fts').get().n;
  const rows = db.prepare('SELECT COUNT(*) AS n FROM dialogues').get().n;
  assert.equal(indexed, rows, 'the AFTER INSERT trigger keeps the index in sync');
});

test('exact lookup uses the normalized column', () => {
  const rows = db.prepare(SQL.exact).all(normalizeText('  who ARE you?? '), 'en-US', 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].answer, 'I am IRONBOX.');
  assert.equal(rows[0].rank, 0);
});

test('exact lookup is language-scoped', () => {
  const english = db.prepare(SQL.exact).all(normalizeText('Quem é você'), 'en-US', 3);
  const portuguese = db.prepare(SQL.exact).all(normalizeText('Quem é você'), 'pt-BR', 3);
  assert.equal(english.length, 0);
  assert.equal(portuguese.length, 1);
  assert.equal(portuguese[0].answer, 'Sou o IRONBOX.');
});

test('AND retrieval is precise, OR retrieval is broad', () => {
  const and = db
    .prepare(SQL.fts)
    .all(toFtsQuery('how do I replace the videos', { join: 'AND' }), 'en-US', 25);
  assert.equal(and.length, 1);
  assert.match(and[0].answer, /external videos directory/);

  const or = db
    .prepare(SQL.fts)
    .all(toFtsQuery('how do I replace the videos', { join: 'OR' }), 'en-US', 25);
  assert.ok(or.length > and.length, 'OR widens the candidate set');
});

test('FTS matching ignores accents', () => {
  const rows = db.prepare(SQL.fts).all(toFtsQuery('quem e voce', { join: 'AND' }), 'pt-BR', 25);
  assert.equal(rows.length, 1, 'remove_diacritics 2 makes "você" reachable as "voce"');
});

test('user text cannot inject FTS5 operators', () => {
  const hostile = 'videos" OR dialogues_fts MATCH "benchmark';
  assert.doesNotThrow(() => {
    db.prepare(SQL.fts).all(toFtsQuery(hostile, { join: 'AND' }), 'en-US', 25);
  });
});

test('every search is bounded — the corpus is never pulled into JavaScript', () => {
  const limit = DATABASE_CONFIG.searchLimit;
  const or = db.prepare(SQL.fts).all(toFtsQuery('benchmark question', { join: 'OR' }), 'en-US', limit);
  const like = db.prepare(SQL.prefix).all('en-US', '%benchmark%', limit);
  const keyword = db.prepare(SQL.keyword).all('en-US', '%benchmark%', limit);
  const intent = db.prepare(SQL.intent).all('identity', 'en-US', 5);

  assert.equal(or.length, limit);
  assert.equal(like.length, limit);
  assert.equal(keyword.length, limit);
  assert.ok(intent.length <= 5);
  assert.equal(db.prepare(SQL.count).get().total, 1003, 'the table itself is far larger');
});

test('priority orders the non-FTS paths', () => {
  const rows = db.prepare(SQL.prefix).all('en-US', '%benchmark%', 5);
  const priorities = rows.map((row) => row.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
});

test('intent lookup is indexed and language-scoped', () => {
  const rows = db.prepare(SQL.intent).all('identity', 'en-US', 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].intent, 'identity');
});

test('fallbacks are stored per language', () => {
  const rows = db.prepare(SQL.fallbacks).all('en-US');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].emotion, 'confused');
  assert.equal(db.prepare(SQL.fallbacks).all('es-ES').length, 0);
});

test('update and delete triggers keep FTS5 consistent', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM dialogues_fts').get().n;
  const id = db.prepare("SELECT id FROM dialogues WHERE question = 'Who are you'").get().id;

  db.prepare('UPDATE dialogues SET question = ?, question_norm = ? WHERE id = ?').run(
    'Who is IRONBOX',
    normalizeText('Who is IRONBOX'),
    id,
  );
  assert.equal(
    db.prepare(SQL.fts).all(toFtsQuery('ironbox', { join: 'AND' }), 'en-US', 5).length,
    1,
    'the updated text is searchable',
  );

  db.prepare('DELETE FROM dialogues WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dialogues_fts').get().n, before - 1);
  assert.equal(
    db.prepare(SQL.fts).all(toFtsQuery('ironbox', { join: 'AND' }), 'en-US', 5).length,
    0,
    'deleted rows leave the index',
  );
});

test('the importer normalizes identically to the app', () => {
  for (const sample of ['  WHO are   you? ', 'Olá, Mundo!', 'Quem é você', 'Adiós!']) {
    assert.equal(toolNormalize(sample), normalizeText(sample), `mismatch for "${sample}"`);
  }
});

test('the packaged database, if built, matches the schema', () => {
  let packaged;
  try {
    packaged = new DatabaseSync('www/assets/databases/ironbox.db', { readOnly: true });
  } catch {
    return; // not built in this checkout; import-database.js creates it
  }
  const total = packaged.prepare('SELECT COUNT(*) AS n FROM dialogues').get().n;
  assert.ok(total > 0);
  const mismatch = packaged
    .prepare('SELECT question, question_norm FROM dialogues LIMIT 50')
    .all()
    .filter((row) => normalizeText(row.question) !== row.question_norm);
  assert.equal(mismatch.length, 0);
  packaged.close();
});
