#!/usr/bin/env node
/**
 * IRONBOX 1.0 — prepare packaged web assets.
 *
 *   node tools/prepare-assets.js
 *
 * Runs before every `cap sync`, and does three things:
 *   1. copies database/schema.sql and database/schema-fts5.sql into www/data/
 *      so the app can fetch them at runtime (one source of truth);
 *   2. converts database/seed.csv + fallbacks.csv into www/data/seed-dialogues.json;
 *   3. scans www/videos/ and writes www/data/animation-manifest.json — the
 *      packaged manifest, which the app treats as the *fallback* layer under
 *      whatever the external videos directory provides.
 *
 * Adding a new packaged video therefore needs no JavaScript change: drop the
 * file in www/videos/ and re-run this script (npm run prepare:assets).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvObjects } from './csv.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'www', 'data');
const videosDir = join(root, 'www', 'videos');

const LOOPING = new Set(['idle', 'listening', 'thinking', 'speaking', 'sleeping', 'fallback']);
const ALLOWED = ['.mp4', '.m4v', '.webm'];
const NAME_PATTERN = /^([a-z][a-z0-9]*(?:[-_][a-z][a-z0-9]*)*?)(?:[_-](\d{1,3}))?$/i;

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function copySchemas() {
  for (const file of ['schema.sql', 'schema-fts5.sql']) {
    const source = join(root, 'database', file);
    const target = join(dataDir, file);
    writeFileSync(target, readFileSync(source, 'utf8'));
    console.log(`  schema  → www/data/${file}`);
  }
}

function buildSeed() {
  const dialogues = parseCsvObjects(readFileSync(join(root, 'database', 'seed.csv'), 'utf8')).map(
    (row) => ({
      question: row.question,
      answer: row.answer,
      category: row.category || null,
      emotion: row.emotion || 'neutral',
      animation: row.animation || row.emotion || 'speaking',
      priority: Number(row.priority || 0),
      language: row.language || 'en-US',
      intent: row.intent || null,
      keywords: row.keywords || '',
    }),
  );

  const fallbacks = parseCsvObjects(
    readFileSync(join(root, 'database', 'fallbacks.csv'), 'utf8'),
  ).map((row) => ({
    text: row.text,
    emotion: row.emotion || 'confused',
    animation: row.animation || 'confused',
    language: row.language || 'en-US',
  }));

  writeFileSync(
    join(dataDir, 'seed-dialogues.json'),
    `${JSON.stringify({ dialogues, fallbacks }, null, 2)}\n`,
  );
  console.log(`  seed    → www/data/seed-dialogues.json (${dialogues.length} dialogues, ${fallbacks.length} fallbacks)`);
  return dialogues.length;
}

function parseName(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = filename.slice(dot).toLowerCase();
  if (!ALLOWED.includes(extension)) return null;
  const match = NAME_PATTERN.exec(filename.slice(0, dot));
  if (!match) return null;
  return {
    file: filename,
    category: match[1].toLowerCase().replace(/-/g, '_'),
    variant: match[2] ? Number.parseInt(match[2], 10) : null,
  };
}

function buildManifest() {
  ensureDir(videosDir);
  const files = readdirSync(videosDir).filter((name) => !name.startsWith('.'));
  const manifest = {};

  for (const filename of files) {
    const parsed = parseName(filename);
    if (!parsed) continue;
    manifest[parsed.category] ??= { videos: [] };
    manifest[parsed.category].videos.push({
      file: parsed.file,
      weight: 100,
      loop: LOOPING.has(parsed.category),
    });
  }

  for (const entry of Object.values(manifest)) {
    entry.videos.sort((a, b) => a.file.localeCompare(b.file));
  }

  writeFileSync(
    join(dataDir, 'animation-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const count = Object.values(manifest).reduce((sum, entry) => sum + entry.videos.length, 0);
  console.log(
    `  videos  → www/data/animation-manifest.json (${Object.keys(manifest).length} categories, ${count} videos)`,
  );
  if (count === 0) {
    console.log(
      '  note    : www/videos/ is empty — the app will use the procedural fallback until videos are added.',
    );
  }
  return manifest;
}

ensureDir(dataDir);
console.log('IRONBOX — preparing packaged assets');
copySchemas();
buildSeed();
buildManifest();
console.log('done.');
