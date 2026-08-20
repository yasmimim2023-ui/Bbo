#!/usr/bin/env node
/**
 * IRONBOX 1.0 — packaged video validation.
 *
 *   node tools/validate-videos.js
 *   node tools/validate-videos.js --dir /path/to/videos --strict
 *
 * Checks the packaged animation assets before they go into an APK:
 *   • filenames follow the <category>[_NN].<ext> convention (so automatic
 *     discovery can pick them up without a manifest edit)
 *   • the manifest and the directory agree
 *   • every core animation category resolves, directly or through the
 *     configured fallback chain
 *   • codec/container/resolution are Android-friendly (needs ffprobe;
 *     skipped with a warning when ffprobe is unavailable)
 *
 * Exit code is non-zero on failure with --strict, so it can gate a build.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED = ['.mp4', '.m4v', '.webm'];
const NAME_PATTERN = /^([a-z][a-z0-9]*(?:[-_][a-z][a-z0-9]*)*?)(?:[_-](\d{1,3}))?$/i;
const MIN_BYTES = 1024;
const CORE_CATEGORIES = [
  'idle', 'listening', 'thinking', 'speaking',
  'happy', 'sad', 'angry', 'surprised', 'confused', 'error', 'sleeping',
];
const FALLBACKS = {
  idle: ['fallback'],
  listening: ['idle', 'fallback'],
  thinking: ['listening', 'idle', 'fallback'],
  speaking: ['idle', 'fallback'],
  happy: ['speaking', 'idle', 'fallback'],
  sad: ['speaking', 'idle', 'fallback'],
  angry: ['speaking', 'idle', 'fallback'],
  surprised: ['speaking', 'idle', 'fallback'],
  confused: ['thinking', 'speaking', 'idle', 'fallback'],
  error: ['confused', 'idle', 'fallback'],
  sleeping: ['idle', 'fallback'],
};

function parseArgs(argv) {
  const options = {
    dir: join(root, 'www', 'videos'),
    manifest: join(root, 'www', 'data', 'animation-manifest.json'),
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const next = () => argv[(index += 1)];
    switch (argv[index]) {
      case '--dir': options.dir = resolve(next()); break;
      case '--manifest': options.manifest = resolve(next()); break;
      case '--strict': options.strict = true; break;
      default: console.warn(`Unknown option ${argv[index]}`);
    }
  }
  return options;
}

function hasFfprobe() {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function probe(path) {
  const output = execFileSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,pix_fmt,duration:format=duration,format_name',
      '-of', 'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(output);
  const stream = parsed.streams?.[0] ?? {};
  return {
    codec: stream.codec_name ?? null,
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    pixelFormat: stream.pix_fmt ?? null,
    duration: Number(stream.duration ?? parsed.format?.duration ?? 0),
    container: parsed.format?.format_name ?? null,
  };
}

function parseName(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = filename.slice(dot).toLowerCase();
  if (!ALLOWED.includes(extension)) return null;
  const match = NAME_PATTERN.exec(filename.slice(0, dot));
  if (!match) return null;
  return { file: filename, category: match[1].toLowerCase().replace(/-/g, '_'), extension };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`IRONBOX — validating videos in ${options.dir}`);

  if (!existsSync(options.dir)) {
    console.error('  ✗ directory not found');
    process.exit(1);
  }

  const ffprobeAvailable = hasFfprobe();
  if (!ffprobeAvailable) {
    console.warn('  ! ffprobe not found — codec/resolution checks skipped');
  }

  const entries = readdirSync(options.dir).filter((name) => !name.startsWith('.'));
  const byCategory = new Map();
  const problems = [];
  let valid = 0;

  for (const filename of entries) {
    const path = join(options.dir, filename);
    if (statSync(path).isDirectory()) continue;

    const parsed = parseName(filename);
    if (!parsed) {
      problems.push(`${filename}: unrecognised name or extension (expected <category>[_NN].mp4)`);
      continue;
    }

    const bytes = statSync(path).size;
    if (bytes < MIN_BYTES) {
      problems.push(`${filename}: only ${bytes} bytes — truncated or empty`);
      continue;
    }

    let detail = `${(bytes / 1024).toFixed(0)} KB`;
    if (ffprobeAvailable) {
      try {
        const info = probe(path);
        detail += `, ${info.codec}, ${info.width}x${info.height}, ${info.duration.toFixed(1)}s`;
        if (info.codec !== 'h264' && info.codec !== 'vp8' && info.codec !== 'vp9') {
          problems.push(`${filename}: codec "${info.codec}" is not broadly supported on Android (prefer H.264)`);
        }
        if (info.pixelFormat && info.pixelFormat !== 'yuv420p') {
          problems.push(`${filename}: pixel format "${info.pixelFormat}" — many devices only decode yuv420p`);
        }
        if (!info.duration) {
          problems.push(`${filename}: no readable duration`);
        }
      } catch (error) {
        problems.push(`${filename}: ffprobe failed — ${error.message.split('\n')[0]}`);
        continue;
      }
    }

    valid += 1;
    if (!byCategory.has(parsed.category)) byCategory.set(parsed.category, []);
    byCategory.get(parsed.category).push(filename);
    console.log(`  ✓ ${filename.padEnd(22)} ${detail}`);
  }

  console.log(`\n  categories: ${byCategory.size}, files: ${valid}`);

  // Manifest agreement
  if (existsSync(options.manifest)) {
    const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
    const manifestFiles = new Set(
      Object.values(manifest).flatMap((entry) => entry.videos.map((video) => video.file)),
    );
    for (const file of manifestFiles) {
      if (!entries.includes(file)) {
        problems.push(`manifest references missing file: ${file}`);
      }
    }
    const missingFromManifest = [...byCategory.values()]
      .flat()
      .filter((file) => !manifestFiles.has(file));
    if (missingFromManifest.length > 0) {
      problems.push(
        `not in the packaged manifest (run npm run prepare:assets): ${missingFromManifest.join(', ')}`,
      );
    }
  } else {
    problems.push('www/data/animation-manifest.json is missing — run npm run prepare:assets');
  }

  // Coverage: does every core category resolve, directly or via fallback?
  console.log('\n  category coverage:');
  for (const category of CORE_CATEGORIES) {
    if (byCategory.has(category)) {
      console.log(`    ✓ ${category.padEnd(11)} ${byCategory.get(category).length} file(s)`);
      continue;
    }
    const via = (FALLBACKS[category] ?? []).find((candidate) => byCategory.has(candidate));
    if (via) console.log(`    → ${category.padEnd(11)} falls back to "${via}"`);
    else console.log(`    ! ${category.padEnd(11)} no asset and no fallback — procedural canvas will be used`);
  }

  if (problems.length > 0) {
    console.log('\n  problems:');
    for (const problem of problems) console.log(`    ✗ ${problem}`);
    if (options.strict) process.exitCode = 1;
  } else {
    console.log('\n  no problems found.');
  }
}

main();
