/**
 * Animation registry: discovery, manifest merging, fallback resolution and
 * scale. These are the guarantees that let a character be swapped after build.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildManifestFromFiles,
  manifestFiles,
  mergeManifests,
  normalizeManifest,
  parseVideoFilename,
  resolveCategory,
  selectVideo,
  summarizeManifest,
} from '../www/js/animationRegistry.js';

test('parses the filename convention', () => {
  assert.deepEqual(parseVideoFilename('happy_02.mp4'), {
    file: 'happy_02.mp4',
    category: 'happy',
    variant: 2,
    extension: '.mp4',
  });
  assert.equal(parseVideoFilename('idle.mp4').category, 'idle');
  assert.equal(parseVideoFilename('idle.mp4').variant, null);
  assert.equal(parseVideoFilename('surprised-3.webm').category, 'surprised');
  assert.equal(parseVideoFilename('notes.txt'), null, 'non-video extensions are rejected');
  assert.equal(parseVideoFilename('nodot'), null);
});

test('discovers categories from filenames without any code change', () => {
  const manifest = buildManifestFromFiles([
    'idle.mp4',
    'happy_01.mp4',
    'happy_02.mp4',
    'happy_03.mp4',
    'readme.txt',
  ]);

  assert.deepEqual(Object.keys(manifest).sort(), ['happy', 'idle']);
  assert.equal(manifest.happy.videos.length, 3);
  assert.deepEqual(
    manifest.happy.videos.map((video) => video.file),
    ['happy_01.mp4', 'happy_02.mp4', 'happy_03.mp4'],
    'variations are ordered by their numeric suffix',
  );
  assert.equal(manifest.idle.videos[0].loop, true, 'idle loops by default');
  assert.equal(manifest.happy.videos[0].loop, false, 'emotions do not loop by default');
});

test('adding a variation file needs no manifest edit', () => {
  const before = buildManifestFromFiles(['happy_01.mp4']);
  const after = buildManifestFromFiles(['happy_01.mp4', 'happy_02.mp4']);
  assert.equal(before.happy.videos.length, 1);
  assert.equal(after.happy.videos.length, 2);
});

test('normalizes the loose manifest shapes a human may write', () => {
  const fromArray = normalizeManifest({ happy: ['a.mp4'] });
  const fromObject = normalizeManifest({ happy: { videos: ['a.mp4'] } });
  const fromFull = normalizeManifest({
    happy: { videos: [{ file: 'a.mp4', weight: 50, loop: true }] },
  });

  assert.equal(fromArray.happy.videos[0].file, 'a.mp4');
  assert.equal(fromArray.happy.videos[0].weight, 100);
  assert.deepEqual(fromObject.happy.videos[0], fromArray.happy.videos[0]);
  assert.equal(fromFull.happy.videos[0].weight, 50);
  assert.equal(fromFull.happy.videos[0].loop, true);
  assert.deepEqual(normalizeManifest({ broken: [{ weight: 5 }] }), {}, 'entries without a file are dropped');
});

test('external manifest repoints a category at a differently named file', () => {
  const packaged = buildManifestFromFiles(['idle.mp4', 'happy_01.mp4']);
  const external = normalizeManifest({ happy: ['characterB_happy.mp4'] });
  const merged = mergeManifests(packaged, external);

  assert.deepEqual(merged.happy.videos.map((video) => video.file), ['characterB_happy.mp4']);
  assert.deepEqual(merged.idle.videos.map((video) => video.file), ['idle.mp4'],
    'categories the override does not mention are preserved');
});

test('external files override packaged ones per category', () => {
  const packaged = buildManifestFromFiles(['idle.mp4', 'happy_01.mp4']);
  const discovered = buildManifestFromFiles(['happy_01.mp4', 'happy_02.mp4']);
  const merged = mergeManifests(packaged, discovered);
  assert.equal(merged.happy.videos.length, 2);
});

test('resolves through the fallback chain when a category is empty', () => {
  const manifest = buildManifestFromFiles(['idle.mp4', 'speaking.mp4']);

  const happy = resolveCategory('happy', manifest);
  assert.equal(happy.category, 'speaking');
  assert.equal(happy.fallbackUsed, true);
  assert.deepEqual(happy.chain, ['happy', 'speaking']);

  const idle = resolveCategory('idle', manifest);
  assert.equal(idle.category, 'idle');
  assert.equal(idle.fallbackUsed, false);
});

test('falls back further down the chain and finally returns null', () => {
  const onlyIdle = buildManifestFromFiles(['idle.mp4']);
  assert.equal(resolveCategory('confused', onlyIdle).category, 'idle');
  assert.equal(resolveCategory('happy', {}), null, 'nothing playable → caller uses the canvas');
});

test('a video marked invalid is skipped in favour of a sibling', () => {
  const manifest = buildManifestFromFiles(['happy_01.mp4', 'happy_02.mp4']);
  const resolved = resolveCategory('happy', manifest, {
    isPlayable: (video) => video.file !== 'happy_01.mp4',
  });
  assert.deepEqual(resolved.videos.map((video) => video.file), ['happy_02.mp4']);
});

test('all variations invalid → the category falls back', () => {
  const manifest = buildManifestFromFiles(['happy_01.mp4', 'idle.mp4']);
  const resolved = resolveCategory('happy', manifest, {
    isPlayable: (video) => !video.file.startsWith('happy'),
  });
  assert.equal(resolved.category, 'idle');
});

test('selection honours weights and avoids immediate repeats', () => {
  const manifest = normalizeManifest({
    happy: {
      videos: [
        { file: 'a.mp4', weight: 0 },
        { file: 'b.mp4', weight: 100 },
      ],
    },
  });
  const resolved = resolveCategory('happy', manifest);

  assert.equal(selectVideo(resolved, { random: () => 0.5 }).file, 'b.mp4', 'zero weight is skipped');
  assert.equal(selectVideo(resolved, { preferFile: 'a.mp4' }).file, 'a.mp4', 'pinning wins');

  const two = resolveCategory('happy', normalizeManifest({ happy: ['a.mp4', 'b.mp4'] }));
  assert.equal(selectVideo(two, { avoidFile: 'a.mp4', random: () => 0.1 }).file, 'b.mp4');
  const single = resolveCategory('happy', normalizeManifest({ happy: ['a.mp4'] }));
  assert.equal(
    selectVideo(single, { avoidFile: 'a.mp4' }).file,
    'a.mp4',
    'the only asset is still played rather than nothing',
  );
});

test('scales past 300 videos with no hard-coded limit', () => {
  const categories = ['idle', 'listening', 'thinking', 'speaking', 'happy', 'sad', 'angry', 'surprised'];
  const files = [];
  for (const category of categories) {
    for (let index = 1; index <= 50; index += 1) {
      files.push(`${category}_${String(index).padStart(2, '0')}.mp4`);
    }
  }
  assert.equal(files.length, 400);

  const manifest = buildManifestFromFiles(files);
  const summary = summarizeManifest(manifest);
  assert.equal(summary.videos, 400);
  assert.equal(summary.categories, 8);
  assert.equal(manifestFiles(manifest).length, 400);
  assert.equal(summary.byCategory.happy, 50);
  assert.ok(resolveCategory('happy', manifest).videos.length === 50);
});
