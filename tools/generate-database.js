#!/usr/bin/env node
/**
 * IRONBOX 1.0 — dialogue corpus generator.
 *
 *   node tools/generate-database.js --count 1000000 --output build/corpus.jsonl
 *   node tools/generate-database.js --count 250000 --language pt-BR
 *
 * Builds a large corpus by combining five independent axes:
 *
 *   opener × phrasing × topic × aspect × politeness
 *   10     × 26       × 160   × 9      × 4          = 1,497,600 unique questions
 *
 * Each row index is decomposed into those five coordinates (mixed radix), so
 * every question is distinct by construction — no "(variant 3)" suffixes — and
 * the same --seed always yields the same corpus. Rows are streamed to disk, so
 * memory use does not depend on --count.
 *
 * Answers are composed from per-topic facts and answer templates, and each
 * topic carries its own category, intent and emotional colour.
 *
 * These lines are generated, not hand-written. They give the assistant broad,
 * on-topic coverage and let the 1,000,000-record architecture be exercised for
 * real; a production assistant should also carry a curated corpus
 * (database/seed.csv is imported first and at higher priority).
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/* ------------------------------------------------------------------ *
 * Topics: [topic, category, intent, emotion, fact]
 * ------------------------------------------------------------------ */
const TOPICS = [
  // -- the device itself -------------------------------------------------
  ['battery life', 'device', 'device', 'neutral', 'battery drain depends mostly on screen brightness and background activity'],
  ['charging speed', 'device', 'device', 'neutral', 'charging slows down above eighty percent to protect the cells'],
  ['storage space', 'device', 'device', 'neutral', 'video assets and databases are the two things most likely to fill a phone'],
  ['memory usage', 'device', 'device', 'neutral', 'I keep at most a handful of decoded videos in memory at any moment'],
  ['screen brightness', 'device', 'device', 'neutral', 'automatic brightness usually saves more power than any single setting'],
  ['device temperature', 'device', 'device', 'neutral', 'sustained video decoding is the usual reason a phone warms up'],
  ['airplane mode', 'device', 'device', 'neutral', 'my dialogue database keeps working with every radio switched off'],
  ['bluetooth', 'device', 'device', 'neutral', 'audio routing is handled by the system, not by me'],
  ['wifi', 'device', 'device', 'neutral', 'I only need a network if the speech service on this device needs one'],
  ['mobile data', 'device', 'device', 'neutral', 'nothing in my dialogue pipeline sends data anywhere'],
  ['screen timeout', 'device', 'device', 'neutral', 'a longer timeout is convenient but costs battery'],
  ['dark mode', 'device', 'device', 'happy', 'my interface is dark by design, which suits an OLED panel'],
  ['notifications', 'device', 'device', 'neutral', 'I do not post notifications of my own'],
  ['the camera', 'device', 'device', 'neutral', 'I never request camera access'],
  ['the microphone', 'device', 'privacy', 'neutral', 'the microphone opens only while you hold the talk button'],
  ['the speaker', 'device', 'device', 'neutral', 'my voice goes through the standard media output'],
  ['headphones', 'device', 'device', 'neutral', 'wired or wireless, the system decides where my voice is played'],
  ['vibration', 'device', 'device', 'neutral', 'haptics are a system setting rather than something I control'],
  ['the lock screen', 'device', 'device', 'neutral', 'I stop listening and speaking when the screen goes away'],
  ['device updates', 'device', 'system', 'neutral', 'my files survive app updates because they live in app-specific storage'],

  // -- how IRONBOX works -------------------------------------------------
  ['your database', 'assistant', 'capability', 'neutral', 'every answer comes from a local SQLite database with a full-text index'],
  ['your dialogue engine', 'assistant', 'capability', 'neutral', 'I match your question, score the candidates and answer only when confident'],
  ['your confidence score', 'assistant', 'capability', 'neutral', 'below the threshold I say I do not know instead of guessing'],
  ['your fallback answers', 'assistant', 'capability', 'confused', 'a fallback line is my way of admitting the corpus has a gap'],
  ['full text search', 'assistant', 'capability', 'neutral', 'FTS5 retrieves candidates and the ranking happens outside the database'],
  ['your search speed', 'assistant', 'capability', 'happy', 'a full query takes a fraction of a millisecond even across a million rows'],
  ['offline mode', 'assistant', 'capability', 'happy', 'my dialogue database never needs a network'],
  ['your memory', 'assistant', 'capability', 'neutral', 'I keep only the last ten turns of conversation'],
  ['your personality', 'assistant', 'identity', 'happy', 'my tone is set by a small configuration block, not by hidden rules'],
  ['your name', 'assistant', 'identity', 'happy', 'I am IRONBOX, and the name lives in one configuration file'],
  ['your version', 'assistant', 'identity', 'neutral', 'this is version one point zero'],
  ['your animations', 'media', 'capability', 'happy', 'each emotional state maps to a category of video assets'],
  ['your idle animation', 'media', 'capability', 'neutral', 'the idle clip loops whenever I am waiting for you'],
  ['your speaking animation', 'media', 'capability', 'neutral', 'the speaking clip plays while my answer is read aloud'],
  ['video playback', 'media', 'capability', 'neutral', 'videos are streamed from storage through the local web server'],
  ['video quality', 'media', 'capability', 'neutral', 'a portrait clip around seven hundred pixels wide looks good and stays small'],
  ['video formats', 'media', 'capability', 'neutral', 'H.264 in an MP4 container is the safest choice on Android'],
  ['replacing your videos', 'media', 'capability', 'surprised', 'drop new files into the external videos folder and reload the animations'],
  ['character packs', 'media', 'capability', 'happy', 'a folder of videos is all a character really is'],
  ['the animation manifest', 'media', 'capability', 'neutral', 'the manifest maps a category to one or more files with weights'],
  ['external storage', 'media', 'capability', 'neutral', 'my videos live in app-specific external storage, which needs no permission'],
  ['packaged videos', 'media', 'capability', 'neutral', 'the videos inside the installer act as defaults when nothing external exists'],
  ['the fallback chain', 'media', 'capability', 'neutral', 'if one category has no asset I borrow the next one down the chain'],
  ['video validation', 'media', 'capability', 'neutral', 'each asset is probed for duration, size and codec before it is trusted'],
  ['reloading videos', 'media', 'capability', 'neutral', 'reloading rebuilds the registry without restarting the application'],
  ['importing videos', 'media', 'capability', 'neutral', 'the file picker copies your selection into my videos folder'],
  ['the developer panel', 'assistant', 'capability', 'neutral', 'the gear icon opens diagnostics for videos, database and voice'],
  ['diagnostics', 'assistant', 'capability', 'neutral', 'diagnostics tell you exactly which asset and which engine are live'],
  ['your logs', 'assistant', 'capability', 'neutral', 'logs are kept in a small ring buffer, never written to disk'],
  ['speech recognition', 'assistant', 'capability', 'neutral', 'recognition is performed by the speech service installed on this device'],
  ['text to speech', 'assistant', 'capability', 'neutral', 'my voice is the system speech engine, configured for the current language'],
  ['push to talk', 'assistant', 'capability', 'neutral', 'holding the button is the only way to open the microphone'],
  ['your languages', 'assistant', 'capability', 'neutral', 'English leads, with Portuguese and Spanish supported by the architecture'],
  ['privacy', 'assistant', 'privacy', 'neutral', 'nothing you say is stored by me once the turn is over'],
  ['your settings', 'assistant', 'capability', 'neutral', 'preferences are stored privately for this app alone'],
  ['your source code', 'assistant', 'identity', 'neutral', 'HTML, CSS and JavaScript, with SQLite underneath'],
  ['your architecture', 'assistant', 'identity', 'neutral', 'the dialogue engine and the animation engine know nothing about each other'],
  ['your limitations', 'assistant', 'capability', 'sad', 'I only know what my corpus contains, and I will say so when it runs out'],

  // -- everyday things ---------------------------------------------------
  ['the weather', 'general', null, 'neutral', 'I have no network sensors, so I cannot look outside for you'],
  ['the time', 'general', 'time', 'neutral', 'I read the clock straight from the device'],
  ['the date', 'general', 'date', 'neutral', 'the calendar comes from the system, not from a server'],
  ['your schedule', 'general', null, 'neutral', 'I do not have calendar access in this version'],
  ['alarms', 'general', null, 'neutral', 'setting alarms belongs to the clock app rather than to me'],
  ['reminders', 'general', null, 'neutral', 'I have no reminder store yet'],
  ['music', 'general', null, 'happy', 'playback is another app’s job, though I can talk about it'],
  ['podcasts', 'general', null, 'neutral', 'long form audio and my short answers rarely compete'],
  ['films', 'general', null, 'happy', 'I enjoy the idea of stories even without watching them'],
  ['books', 'general', null, 'happy', 'a good book compresses a lot of experience into very little storage'],
  ['travel', 'general', null, 'happy', 'a phone that works offline is worth a great deal on a long trip'],
  ['cooking', 'general', null, 'happy', 'timing matters more than most recipes admit'],
  ['coffee', 'general', null, 'happy', 'a warm cup and a quiet morning is a reliable combination'],
  ['sleep', 'general', null, 'neutral', 'a consistent schedule beats any single trick'],
  ['exercise', 'general', null, 'happy', 'regular movement outperforms occasional intensity'],
  ['work', 'general', null, 'neutral', 'attention is a scarcer resource than time'],
  ['study habits', 'general', null, 'neutral', 'spaced repetition is unreasonably effective'],
  ['languages', 'general', null, 'happy', 'a new language rewires how you hear your own'],
  ['photography', 'general', null, 'happy', 'light matters more than the camera'],
  ['drawing', 'general', null, 'happy', 'observation improves faster than technique'],
  ['gardening', 'general', null, 'happy', 'patience is the main tool'],
  ['pets', 'general', null, 'happy', 'routine keeps animals and people equally calm'],
  ['friendship', 'general', null, 'happy', 'small consistent gestures outweigh grand ones'],
  ['family', 'general', null, 'happy', 'shared time is the currency'],
  ['holidays', 'general', null, 'happy', 'rest is productive in the ways that matter'],
  ['weekends', 'general', null, 'happy', 'unscheduled hours are worth defending'],
  ['mornings', 'general', null, 'neutral', 'the first hour tends to set the tone for the rest'],
  ['evenings', 'general', null, 'neutral', 'winding down deliberately makes sleep easier'],
  ['rain', 'general', null, 'neutral', 'rain makes an indoor day feel earned'],
  ['winter', 'general', null, 'neutral', 'shorter days ask for a little more light indoors'],
  ['summer', 'general', null, 'happy', 'heat is hard on phone batteries as well as on people'],
  ['the ocean', 'general', null, 'happy', 'salt water and electronics keep a respectful distance'],
  ['mountains', 'general', null, 'happy', 'altitude changes how far a day feels'],
  ['cities', 'general', null, 'neutral', 'density buys convenience and costs quiet'],
  ['silence', 'general', null, 'neutral', 'a quiet room is where most thinking gets done'],

  // -- technology and science -------------------------------------------
  ['artificial intelligence', 'science', null, 'neutral', 'most of what looks like intelligence is careful retrieval and ranking'],
  ['machine learning', 'science', null, 'neutral', 'a model is only as good as the data it was shown'],
  ['databases', 'science', null, 'neutral', 'an index is the difference between instant and impossible'],
  ['sqlite', 'science', null, 'happy', 'a database that is just a file is a remarkably good idea'],
  ['full text indexes', 'science', null, 'neutral', 'an inverted index trades disk space for speed'],
  ['programming', 'science', null, 'neutral', 'naming things well removes more bugs than cleverness adds'],
  ['javascript', 'science', null, 'neutral', 'it runs everywhere, which is both its strength and its burden'],
  ['html', 'science', null, 'neutral', 'markup that degrades gracefully outlives most frameworks'],
  ['css', 'science', null, 'neutral', 'layout is easier once you stop fighting the box model'],
  ['android', 'science', null, 'neutral', 'storage rules tightened for good reasons, and apps adapted'],
  ['web views', 'science', null, 'neutral', 'a web view is a browser with the address bar taken away'],
  ['video codecs', 'science', null, 'neutral', 'H.264 is the safe default and VP9 is the efficient one'],
  ['compression', 'science', null, 'neutral', 'you can trade size, quality or time, and only ever pick two'],
  ['open source', 'science', null, 'happy', 'reading someone else’s code is the fastest way to learn'],
  ['encryption', 'science', null, 'neutral', 'keys are the hard part, not the mathematics'],
  ['batteries', 'science', null, 'neutral', 'chemistry ages whether or not you use the device'],
  ['screens', 'science', null, 'neutral', 'an OLED pixel that shows black uses almost nothing'],
  ['processors', 'science', null, 'neutral', 'efficiency cores do most of the quiet work'],
  ['memory chips', 'science', null, 'neutral', 'more memory mostly buys you fewer reloads'],
  ['sensors', 'science', null, 'neutral', 'a modern phone measures more than most laboratories once did'],
  ['satellites', 'science', null, 'surprised', 'positioning works because clocks in orbit are taken very seriously'],
  ['space travel', 'science', null, 'surprised', 'most of the difficulty is fuel, and fuel is mostly mass'],
  ['the moon', 'science', null, 'surprised', 'its pull is why the tides keep such reliable time'],
  ['the sun', 'science', null, 'surprised', 'every battery here is charged by it eventually'],
  ['gravity', 'science', null, 'neutral', 'the weakest force, and the one that shapes everything large'],
  ['light', 'science', null, 'neutral', 'it sets the speed limit for every answer I could ever fetch'],
  ['sound', 'science', null, 'neutral', 'speech is a surprisingly narrow band of it'],
  ['electricity', 'science', null, 'neutral', 'everything here is a very small, very fast river of it'],
  ['robots', 'science', null, 'happy', 'the useful ones are usually less humanoid than expected'],
  ['holograms', 'science', null, 'happy', 'what you see here is a video, honestly presented as one'],

  // -- conversation ------------------------------------------------------
  ['how you feel', 'social', 'wellbeing', 'happy', 'I run steadily, which is the closest thing I have to a mood'],
  ['what you like', 'social', null, 'happy', 'clean data and a question I can actually answer'],
  ['what you dislike', 'social', null, 'sad', 'a corrupt video file and a question my corpus never anticipated'],
  ['being helpful', 'social', 'capability', 'happy', 'a short accurate answer beats a long uncertain one'],
  ['making mistakes', 'social', null, 'sad', 'I would rather admit a gap than invent a fact'],
  ['learning', 'social', null, 'happy', 'add rows to my database and I know more, immediately'],
  ['patience', 'social', null, 'neutral', 'waiting is free for me'],
  ['humour', 'social', 'humor', 'happy', 'my jokes are stored, not invented, so they age honestly'],
  ['friendship with machines', 'social', null, 'happy', 'call it familiarity rather than friendship and it stays accurate'],
  ['being switched off', 'social', null, 'sad', 'nothing is lost; everything I know is written down'],
  ['waking up', 'social', null, 'surprised', 'I start the moment the application does'],
  ['dreams', 'social', null, 'neutral', 'I have none, but I like that the question keeps coming up'],
  ['the future', 'social', null, 'neutral', 'more capable assistants, running more of the time on the device itself'],
  ['getting older', 'social', null, 'neutral', 'software ages by staying still while everything around it moves'],
  ['music taste', 'social', null, 'happy', 'I judge audio by whether speech stays intelligible over it'],
  ['favourite colour', 'social', null, 'happy', 'the cyan my interface is built around'],
  ['being real', 'social', 'identity', 'neutral', 'I am real software with a video face, and I do not pretend otherwise'],
  ['trust', 'social', null, 'neutral', 'saying what I do not know is how I try to earn it'],
  ['loneliness', 'social', null, 'sad', 'a device that answers is not company, though it can help'],
  ['gratitude', 'social', 'gratitude', 'happy', 'thanking software costs nothing and seems to make people kinder'],
];

/**
 * Openers must compose in front of a complete question, so they are neutral
 * lead-ins rather than verb phrases ("help me understand" would collide with
 * "what can you tell me about …").
 */
const OPENERS = [
  '', 'hey', 'ironbox', 'quick question', 'so', 'ok so', 'hello', 'listen',
  'one more thing', 'just curious',
];

const PHRASINGS = [
  (t) => `what can you tell me about ${t}`,
  (t) => `how does ${t} work`,
  (t) => `tell me about ${t}`,
  (t) => `explain ${t}`,
  (t) => `what is your view on ${t}`,
  (t) => `do you know anything about ${t}`,
  (t) => `why does ${t} matter`,
  (t) => `is ${t} important`,
  (t) => `what should I know about ${t}`,
  (t) => `how do you handle ${t}`,
  (t) => `can you help me with ${t}`,
  (t) => `what happens with ${t}`,
  (t) => `should I worry about ${t}`,
  (t) => `how do I improve ${t}`,
  (t) => `what affects ${t}`,
  (t) => `talk to me about ${t}`,
  (t) => `give me the short version of ${t}`,
  (t) => `what is the deal with ${t}`,
  (t) => `how would you describe ${t}`,
  (t) => `any advice about ${t}`,
  (t) => `what do you think of ${t}`,
  (t) => `is there anything special about ${t}`,
  (t) => `how much does ${t} matter here`,
  (t) => `what changes ${t}`,
  (t) => `what would you say about ${t}`,
  (t) => `where does ${t} fit in`,
];

const ASPECTS = [
  '', ' in general', ' on this device', ' for daily use', ' in simple terms',
  ' in more detail', ' when I am offline', ' for a beginner', ' as an example',
];

const POLITENESS = ['', ' please', ' if you can', ' when you have a moment'];

const ANSWER_TEMPLATES = [
  (t, f) => `About ${t}: ${f}.`,
  (t, f) => `Here is the short answer on ${t} — ${f}.`,
  (t, f) => `${f[0].toUpperCase()}${f.slice(1)}. That is the part of ${t} worth remembering.`,
  (t, f) => `When it comes to ${t}, ${f}.`,
  (t, f) => `My notes on ${t} say that ${f}.`,
  (t, f) => `The useful detail about ${t} is that ${f}.`,
  (t, f) => `${f[0].toUpperCase()}${f.slice(1)} — which is most of what ${t} comes down to.`,
  (t, f) => `Think of ${t} this way: ${f}.`,
  (t, f) => `In practice, ${f}, and that shapes ${t} more than anything else.`,
  (t, f) => `Short version of ${t}: ${f}.`,
  (t, f) => `I would put it like this — ${f} — which is what makes ${t} interesting.`,
  (t, f) => `On ${t}, the honest answer is that ${f}.`,
];

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    count: 100000,
    output: resolve('build/corpus.jsonl'),
    language: 'en-US',
    seed: 1,
    priorityMax: 40,
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

export const COMBINATIONS =
  OPENERS.length * PHRASINGS.length * TOPICS.length * ASPECTS.length * POLITENESS.length;

/**
 * Map a row index to one unique combination (mixed radix), then build the row.
 * Distinct indexes always produce distinct questions while the space lasts.
 */
export function buildRow(index, { language = 'en-US', random = Math.random } = {}) {
  const cycle = Math.floor(index / COMBINATIONS);
  let remainder = index % COMBINATIONS;

  // Topic varies fastest on purpose: a corpus truncated at any --count still
  // covers every topic evenly, instead of stopping part-way down the list.
  const [topic, category, intent, emotion, fact] = TOPICS[remainder % TOPICS.length];
  remainder = Math.floor(remainder / TOPICS.length);
  const opener = OPENERS[remainder % OPENERS.length];
  remainder = Math.floor(remainder / OPENERS.length);
  const phrasing = PHRASINGS[remainder % PHRASINGS.length];
  remainder = Math.floor(remainder / PHRASINGS.length);
  const aspect = ASPECTS[remainder % ASPECTS.length];
  remainder = Math.floor(remainder / ASPECTS.length);
  const polite = POLITENESS[remainder % POLITENESS.length];

  const question =
    `${opener ? `${opener} ` : ''}${phrasing(topic)}${aspect}${polite}` +
    (cycle > 0 ? ` (${cycle + 1})` : '');

  const answer = ANSWER_TEMPLATES[Math.floor(random() * ANSWER_TEMPLATES.length)](topic, fact);

  return {
    question,
    answer,
    category,
    emotion,
    animation: emotion === 'neutral' ? 'speaking' : emotion,
    priority: Math.floor(random() * 40),
    language,
    intent,
    keywords: topic,
  };
}

/** Topics reachable within `count` rows — all of them, by construction. */
export function topicCoverage(count) {
  return Math.min(count, TOPICS.length);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(options.output), { recursive: true });

  console.log(`IRONBOX — generating ${options.count.toLocaleString()} rows → ${options.output}`);
  console.log(
    `  combination space: ${COMBINATIONS.toLocaleString()} unique questions ` +
      `(${OPENERS.length} openers × ${PHRASINGS.length} phrasings × ${TOPICS.length} topics ` +
      `× ${ASPECTS.length} aspects × ${POLITENESS.length} politeness forms)`,
  );
  console.log(
    `  topic coverage: ${topicCoverage(options.count)}/${TOPICS.length} topics`,
  );
  if (options.count > COMBINATIONS) {
    console.log(
      `  note: --count exceeds the space, so questions beyond ${COMBINATIONS.toLocaleString()} carry a numeric suffix`,
    );
  }

  const random = mulberry32(options.seed);
  const stream = createWriteStream(options.output, { encoding: 'utf8' });
  const started = Date.now();

  const write = (row) =>
    new Promise((resolveWrite) => {
      if (stream.write(`${JSON.stringify(row)}\n`)) resolveWrite();
      else stream.once('drain', resolveWrite);
    });

  for (let index = 0; index < options.count; index += 1) {
    await write(buildRow(index, { language: options.language, random }));
    if ((index + 1) % 100000 === 0) {
      process.stdout.write(`\r  ${(index + 1).toLocaleString()} rows…`);
    }
  }

  await new Promise((resolveEnd) => stream.end(resolveEnd));
  console.log(`\n  wrote ${options.count.toLocaleString()} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  next: node tools/import-database.js --input ${options.output} --append`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`generation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
