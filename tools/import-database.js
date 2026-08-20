#!/usr/bin/env node
/**
 * IRONBOX 1.0 — build the packaged SQLite database.
 *
 *   node tools/import-database.js --input database/seed.csv
 *   node tools/import-database.js --input corpus.jsonl --append
 *   node tools/import-database.js --input corpus.jsonl --output build/ironbox.db
 *
 * Reads CSV / JSON / JSONL, applies database/schema.sql (+ FTS5 when the
 * SQLite build supports it) and writes an SQLite file to
 * www/assets/databases/ironbox.db by default.
 *
 * @capacitor-community/sqlite copies anything in `www/assets/databases/` into
 * the app's database folder on first run: a file named `ironbox.db` is
 * installed as `ironboxSQLite.db`, which is what a connection named `ironbox`
 * opens. See the README ("Shipping a large database").
 *
 * Import runs in batched transactions and streams JSONL line by line, so a
 * million-row corpus imports with bounded memory.
 *
 * Uses node:sqlite — no native build step, no extra dependency.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseCsvObjects } from './csv.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  input: join(root, 'database', 'seed.csv'),
  fallbacks: join(root, 'database', 'fallbacks.csv'),
  output: join(root, 'www', 'assets', 'databases', 'ironbox.db'),
  batch: 5000,
  language: 'en-US',
  append: false,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[(index += 1)];
    switch (arg) {
      case '--input': options.input = resolve(next()); break;
      case '--output': options.output = resolve(next()); break;
      case '--fallbacks': options.fallbacks = resolve(next()); break;
      case '--batch': options.batch = Number(next()); break;
      case '--language': options.language = next(); break;
      case '--append': options.append = true; break;
      case '--no-fallbacks': options.fallbacks = null; break;
      case '--help':
        console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0]);
        process.exit(0);
        break;
      default:
        console.warn(`Unknown option ${arg}`);
    }
  }
  return options;
}

/** Normalization must match www/js/utils.js — exact lookups depend on it. */
export function normalizeText(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function openDatabase(path, { append }) {
  mkdirSync(dirname(path), { recursive: true });
  if (!append && existsSync(path)) {
    unlinkSync(path);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    }
  }

  const db = new DatabaseSync(path);
  // The packaged file must be a single self-contained .db, so no WAL here.
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA synchronous = OFF');
  db.exec(readFileSync(join(root, 'database', 'schema.sql'), 'utf8').replace(/PRAGMA journal_mode[^;]*;/i, ''));

  let fts5 = true;
  try {
    db.exec(readFileSync(join(root, 'database', 'schema-fts5.sql'), 'utf8'));
  } catch (error) {
    fts5 = false;
    console.warn(`  ! FTS5 unavailable in this Node build: ${error.message}`);
    console.warn('    The database will import without a full-text index.');
  }
  return { db, fts5 };
}

function toRow(raw, language) {
  const question = String(raw.question ?? '').trim();
  const answer = String(raw.answer ?? '').trim();
  if (!question || !answer) return null;
  return [
    question,
    normalizeText(question),
    answer,
    raw.category || null,
    raw.emotion || 'neutral',
    raw.animation || raw.emotion || 'speaking',
    Number(raw.priority ?? 0) || 0,
    raw.language || language,
    raw.intent || null,
    raw.keywords || '',
  ];
}

async function* readRows(path, language) {
  const lower = path.toLowerCase();

  if (lower.endsWith('.csv')) {
    for (const raw of parseCsvObjects(readFileSync(path, 'utf8'))) yield raw;
    return;
  }

  if (lower.endsWith('.json')) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.dialogues ?? [];
    for (const raw of list) yield raw;
    return;
  }

  // .jsonl — streamed, so file size is irrelevant to memory use.
  const stream = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of stream) {
    const trimmed = line.trim();
    if (trimmed) yield JSON.parse(trimmed);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log('IRONBOX — importing dialogues');
  console.log(`  input : ${options.input}`);
  console.log(`  output: ${options.output}`);

  const started = Date.now();
  const { db, fts5 } = openDatabase(options.output, options);

  const insert = db.prepare(`INSERT INTO dialogues
    (question, question_norm, answer, category, emotion, animation,
     priority, language, intent, keywords)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  let imported = 0;
  let skipped = 0;
  let inTransaction = false;

  const begin = () => {
    if (!inTransaction) {
      db.exec('BEGIN');
      inTransaction = true;
    }
  };
  const commit = () => {
    if (inTransaction) {
      db.exec('COMMIT');
      inTransaction = false;
    }
  };

  for await (const raw of readRows(options.input, options.language)) {
    const row = toRow(raw, options.language);
    if (!row) {
      skipped += 1;
      continue;
    }
    begin();
    insert.run(...row);
    imported += 1;
    if (imported % options.batch === 0) {
      commit();
      if (imported % (options.batch * 10) === 0) {
        process.stdout.write(`\r  imported ${imported.toLocaleString()} rows…`);
      }
    }
  }
  commit();

  if (options.fallbacks && existsSync(options.fallbacks)) {
    const rows = parseCsvObjects(readFileSync(options.fallbacks, 'utf8'));
    const insertFallback = db.prepare(
      'INSERT INTO fallbacks (text, emotion, animation, language) VALUES (?,?,?,?)',
    );
    db.exec('BEGIN');
    for (const row of rows) {
      insertFallback.run(
        row.text,
        row.emotion || 'confused',
        row.animation || 'confused',
        row.language || options.language,
      );
    }
    db.exec('COMMIT');
    console.log(`\n  fallbacks: ${rows.length}`);
  }

  db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('imported_at', datetime('now'))");
  db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('row_count', '${imported}')`);
  if (fts5) db.exec("INSERT INTO dialogues_fts(dialogues_fts) VALUES('optimize')");
  db.exec('ANALYZE');
  db.exec('VACUUM');
  db.close();

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const bytes = statSync(options.output).size;
  console.log(`\n  imported: ${imported.toLocaleString()} rows (${skipped} skipped)`);
  console.log(`  fts5    : ${fts5 ? 'enabled' : 'NOT built'}`);
  console.log(`  size    : ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  time    : ${seconds}s`);
  console.log('done.');
}

// Only run when invoked directly, so tests can import normalizeText/helpers.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`import failed: ${error.message}`);
    process.exitCode = 1;
  });
}

export { main as importDatabase, toRow, readRows };
