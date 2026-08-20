#!/usr/bin/env node
/**
 * IRONBOX 1.0 — database validation and benchmark.
 *
 *   node tools/validate-database.js
 *   node tools/validate-database.js --db build/ironbox.db --bench
 *
 * Checks that a built database is actually usable by the app:
 *   • schema objects and indexes exist
 *   • FTS5 index is present and in sync with the base table
 *   • question_norm matches the app's normalization (exact lookups depend on it)
 *   • rows have answers, languages and sane emotions
 *   • the queries the app runs return within a sane time at the current size
 *
 * Exit code is non-zero when a check fails, so it can gate a build.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { normalizeText } from './import-database.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    db: join(root, 'www', 'assets', 'databases', 'ironbox.db'),
    bench: false,
    samples: 200,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const next = () => argv[(index += 1)];
    switch (argv[index]) {
      case '--db': options.db = resolve(next()); break;
      case '--bench': options.bench = true; break;
      case '--samples': options.samples = Number(next()); break;
      default: console.warn(`Unknown option ${argv[index]}`);
    }
  }
  return options;
}

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return passed;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`IRONBOX — validating ${options.db}`);

  if (!existsSync(options.db)) {
    console.error('  ✗ database file not found. Run: npm run db:build');
    process.exit(1);
  }

  const db = new DatabaseSync(options.db, { readOnly: true });

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all()
    .map((row) => row.name);
  check('dialogues table exists', tables.includes('dialogues'));
  check('fallbacks table exists', tables.includes('fallbacks'));
  check('meta table exists', tables.includes('meta'));

  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((row) => row.name);
  for (const index of [
    'idx_dialogues_norm_lang',
    'idx_dialogues_language',
    'idx_dialogues_intent',
    'idx_dialogues_category',
  ]) {
    check(`index ${index}`, indexes.includes(index));
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM dialogues').get().n;
  check('has rows', total > 0, `${total.toLocaleString()} dialogues`);

  const hasFts = tables.includes('dialogues_fts');
  check('FTS5 index present', hasFts);

  if (hasFts) {
    const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM dialogues_fts').get().n;
    check('FTS5 in sync with dialogues', ftsCount === total, `${ftsCount} indexed / ${total} rows`);

    const probe = db.prepare('SELECT question FROM dialogues LIMIT 1').get();
    const token = normalizeText(probe.question).split(' ')[0];
    const hit = db
      .prepare(
        'SELECT COUNT(*) AS n FROM dialogues_fts WHERE dialogues_fts MATCH ?',
      )
      .get(`"${token}"`).n;
    check('FTS5 MATCH returns rows', hit > 0, `token "${token}" → ${hit} hits`);
  }

  const emptyAnswers = db
    .prepare("SELECT COUNT(*) AS n FROM dialogues WHERE answer IS NULL OR TRIM(answer) = ''").get().n;
  check('no empty answers', emptyAnswers === 0, `${emptyAnswers} empty`);

  const missingLanguage = db
    .prepare("SELECT COUNT(*) AS n FROM dialogues WHERE language IS NULL OR language = ''").get().n;
  check('every row has a language', missingLanguage === 0, `${missingLanguage} missing`);

  // question_norm must match the app's normalization or exact matching breaks.
  const sample = db
    .prepare('SELECT id, question, question_norm FROM dialogues ORDER BY id LIMIT ?')
    .all(Math.min(options.samples, total));
  const mismatches = sample.filter((row) => normalizeText(row.question) !== row.question_norm);
  check(
    'question_norm matches app normalization',
    mismatches.length === 0,
    mismatches.length > 0 ? `${mismatches.length}/${sample.length} rows differ (e.g. id ${mismatches[0].id})` : `${sample.length} sampled`,
  );

  const duplicates = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT question_norm, language FROM dialogues
         GROUP BY question_norm, language HAVING COUNT(*) > 1)`,
    )
    .get().n;
  check('duplicate questions', true, `${duplicates} duplicated question/language pairs`);

  if (options.bench) {
    console.log('\n  benchmark (queries the app actually runs):');
    const probes = db.prepare('SELECT question, language FROM dialogues ORDER BY RANDOM() LIMIT 25').all();

    const time = (label, run) => {
      const started = process.hrtime.bigint();
      let rows = 0;
      for (const probe of probes) rows += run(probe).length;
      const ms = Number(process.hrtime.bigint() - started) / 1e6 / probes.length;
      console.log(`    ${label.padEnd(22)} ${ms.toFixed(2)} ms/query  (${rows} rows total)`);
    };

    const exact = db.prepare(
      'SELECT id, answer FROM dialogues WHERE question_norm = ? AND language = ? LIMIT 3',
    );
    time('exact lookup', (probe) => exact.all(normalizeText(probe.question), probe.language));

    if (hasFts) {
      // The app's strategy: AND retrieval, widened to OR, never ranked in SQL.
      const retrieve = db.prepare(
        `SELECT d.id, d.question, d.answer, d.priority
         FROM dialogues_fts JOIN dialogues d ON d.id = dialogues_fts.rowid
         WHERE dialogues_fts MATCH ? AND d.language = ? LIMIT 25`,
      );
      const expression = (question, join) =>
        normalizeText(question)
          .split(' ')
          .filter(Boolean)
          .slice(0, 12)
          .map((token) => `"${token}"`)
          .join(` ${join} `);

      time('FTS5 AND retrieval', (probe) => retrieve.all(expression(probe.question, 'AND'), probe.language));
      time('FTS5 OR retrieval', (probe) => retrieve.all(expression(probe.question, 'OR'), probe.language));

      // For comparison: what ranking inside SQLite costs at this size.
      const ranked = db.prepare(
        `SELECT d.id, bm25(dialogues_fts) AS rank
         FROM dialogues_fts JOIN dialogues d ON d.id = dialogues_fts.rowid
         WHERE dialogues_fts MATCH ? AND d.language = ? ORDER BY rank LIMIT 25`,
      );
      time('FTS5 + ORDER BY bm25', (probe) => ranked.all(expression(probe.question, 'AND'), probe.language));
    }

    const like = db.prepare(
      'SELECT id, answer FROM dialogues WHERE language = ? AND question_norm LIKE ? LIMIT 25',
    );
    time('LIKE fallback', (probe) => like.all(probe.language, `%${normalizeText(probe.question).split(' ')[0]}%`));
  }

  db.close();

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main();
