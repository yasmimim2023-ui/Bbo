#!/usr/bin/env node
/**
 * IRONBOX 1.0 — synthetic corpus generator.
 *
 *   node tools/generate-database.js --count 1000000 --output build/corpus.jsonl
 *   node tools/generate-database.js --count 250000 --language pt-BR
 *
 * Produces a JSONL corpus for load-testing the 1,000,000-record architecture.
 * Rows are generated combinatorially (topic × phrasing × qualifier), streamed
 * to disk, and never held in memory. Feed the result to import-database.js.
 *
 * These are synthetic strings for benchmarking, not curated dialogue content —
 * ship your own corpus for a real assistant.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOPICS = [
  'battery life', 'the weather', 'my schedule', 'the time zone', 'this device',
  'offline mode', 'the database', 'video playback', 'speech recognition',
  'text to speech', 'the animation system', 'storage space', 'the microphone',
  'privacy', 'the display', 'performance', 'memory usage', 'the language setting',
  'holograms', 'the assistant name', 'notifications', 'system updates',
  'dark mode', 'the developer panel', 'diagnostics', 'the manifest',
  'character packs', 'external videos', 'packaged videos', 'fallback behaviour',
];

const PHRASINGS = [
  (topic) => `what can you tell me about ${topic}`,
  (topic) => `how does ${topic} work`,
  (topic) => `tell me about ${topic}`,
  (topic) => `explain ${topic}`,
  (topic) => `is ${topic} available`,
  (topic) => `can you check ${topic}`,
  (topic) => `why is ${topic} important`,
  (topic) => `do you support ${topic}`,
  (topic) => `what happens to ${topic}`,
  (topic) => `should I worry about ${topic}`,
];

const QUALIFIERS = [
  '', ' right now', ' on this phone', ' offline', ' in detail', ' briefly',
  ' for a beginner', ' after a restart', ' during playback', ' while charging',
];

const EMOTIONS = ['neutral', 'happy', 'surprised', 'confused', 'sad'];
const CATEGORIES = ['device', 'media', 'system', 'general', 'assistant'];

function parseArgs(argv) {
  const options = {
    count: 100000,
    output: resolve('build/corpus.jsonl'),
    language: 'en-US',
    seed: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const next = () => argv[(index += 1)];
    switch (argv[index]) {
      case '--count': options.count = Number(next()); break;
      case '--output': options.output = resolve(next()); break;
      case '--language': options.language = next(); break;
      case '--seed': options.seed = Number(next()); break;
      default: console.warn(`Unknown option ${argv[index]}`);
    }
  }
  return options;
}

/** Deterministic PRNG so a corpus can be reproduced exactly. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(options.output), { recursive: true });

  const random = mulberry32(options.seed);
  const stream = createWriteStream(options.output, { encoding: 'utf8' });
  const started = Date.now();

  console.log(`IRONBOX — generating ${options.count.toLocaleString()} rows → ${options.output}`);

  let written = 0;
  let variant = 0;

  const writeRow = (row) =>
    new Promise((resolveWrite) => {
      if (stream.write(`${JSON.stringify(row)}\n`)) resolveWrite();
      else stream.once('drain', resolveWrite);
    });

  while (written < options.count) {
    const topic = TOPICS[written % TOPICS.length];
    const phrasing = PHRASINGS[Math.floor(written / TOPICS.length) % PHRASINGS.length];
    const qualifier = QUALIFIERS[Math.floor(written / (TOPICS.length * PHRASINGS.length)) % QUALIFIERS.length];
    // After the base combinations are exhausted, add a numbered variant so
    // every question in the corpus stays unique.
    const cycle = Math.floor(written / (TOPICS.length * PHRASINGS.length * QUALIFIERS.length));
    if (cycle > 0) variant = cycle;

    const question = `${phrasing(topic)}${qualifier}${variant ? ` (case ${variant})` : ''}`;
    const emotion = EMOTIONS[Math.floor(random() * EMOTIONS.length)];

    await writeRow({
      question,
      answer: `Regarding ${topic}: this is generated benchmark answer ${written + 1}.`,
      category: CATEGORIES[Math.floor(random() * CATEGORIES.length)],
      emotion,
      animation: emotion === 'neutral' ? 'speaking' : emotion,
      priority: Math.floor(random() * 40),
      language: options.language,
      intent: null,
      keywords: topic,
    });

    written += 1;
    if (written % 100000 === 0) {
      process.stdout.write(`\r  ${written.toLocaleString()} rows…`);
    }
  }

  await new Promise((resolveEnd) => stream.end(resolveEnd));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n  wrote ${written.toLocaleString()} rows in ${seconds}s`);
  console.log(`  next: node tools/import-database.js --input ${options.output}`);
}

main().catch((error) => {
  console.error(`generation failed: ${error.message}`);
  process.exitCode = 1;
});
