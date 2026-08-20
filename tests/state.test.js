/**
 * State machine: legal transitions, animation dispatch by *category*, and
 * targeted preloading.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import StateManager from '../www/js/stateManager.js';
import { STATES } from '../www/js/config.js';

function fakes() {
  const played = [];
  const preloaded = [];
  const animations = {
    playAnimation: async (category, options) => {
      played.push({ category, options });
      return { category };
    },
    playEmotion: async (emotion, options) => {
      played.push({ category: `emotion:${emotion}`, options });
      return { category: emotion };
    },
  };
  const videos = {
    preloadForState: async (state) => {
      preloaded.push(state);
      return [];
    },
  };
  return { played, preloaded, animations, videos };
}

test('starts in IDLE and exposes the configured states', () => {
  const { animations, videos } = fakes();
  const states = new StateManager({ animationManager: animations, videoManager: videos });
  assert.equal(states.current, 'IDLE');
  assert.deepEqual(states.list(), Object.keys(STATES));
});

test('a legal transition plays the state animation category', async () => {
  const { played, animations, videos } = fakes();
  const states = new StateManager({ animationManager: animations, videoManager: videos });

  await states.listening();
  assert.equal(states.current, 'LISTENING');
  assert.equal(played.at(-1).category, 'listening', 'a category, never a filename');
  assert.equal(played.at(-1).options.loop, true);
});

test('an illegal transition is refused without throwing', async () => {
  const { animations, videos } = fakes();
  const states = new StateManager({ animationManager: animations, videoManager: videos });

  await states.transition('LISTENING');
  await states.transition('HAPPY');
  assert.equal(states.current, 'LISTENING', 'LISTENING → HAPPY is not declared legal');

  await states.transition('HAPPY', { force: true });
  assert.equal(states.current, 'HAPPY', 'force overrides the table');
});

test('unknown states are ignored', async () => {
  const { animations, videos } = fakes();
  const states = new StateManager({ animationManager: animations, videoManager: videos });
  await states.transition('TELEPORTING');
  assert.equal(states.current, 'IDLE');
});

test('IDLE and ERROR are reachable from anywhere', async () => {
  const { animations, videos } = fakes();
  const states = new StateManager({ animationManager: animations, videoManager: videos });

  await states.transition('LISTENING');
  await states.transition('PROCESSING');
  await states.transition('SPEAKING');
  assert.equal(states.current, 'SPEAKING');
  await states.error();
  assert.equal(states.current, 'ERROR');
  await states.idle();
  assert.equal(states.current, 'IDLE');
});

test('a full conversational cycle is legal end to end', async () => {
  const { played, animations, videos } = fakes();
  const states = new StateManager({ animationManager: animations, videoManager: videos });

  for (const step of ['LISTENING', 'PROCESSING', 'THINKING', 'SPEAKING', 'HAPPY', 'IDLE']) {
    await states.transition(step);
    assert.equal(states.current, step, `expected to reach ${step}`);
  }
  assert.deepEqual(
    played.map((entry) => entry.category),
    ['listening', 'thinking', 'thinking', 'speaking', 'happy', 'idle'],
  );
});

test('entering a state preloads only the likely next categories', async () => {
  const { preloaded, animations, videos } = fakes();
  const states = new StateManager({ animationManager: animations, videoManager: videos });

  await states.listening();
  await states.processing();
  assert.deepEqual(preloaded, ['LISTENING', 'PROCESSING']);
});

test('emotions map to states when one exists, else to the animation manager', async () => {
  const { played, animations, videos } = fakes();
  const states = new StateManager({ animationManager: animations, videoManager: videos });

  await states.transition('SPEAKING');
  await states.emotion('happy');
  assert.equal(states.current, 'HAPPY');

  await states.transition('IDLE');
  await states.emotion('neutral');
  assert.equal(states.current, 'IDLE', 'neutral has no state; the animation still plays');
  assert.equal(played.at(-1).category, 'emotion:neutral');
});

test('subscribers observe every change', async () => {
  const { animations, videos } = fakes();
  const states = new StateManager({ animationManager: animations, videoManager: videos });
  const seen = [];
  states.onChange((change) => seen.push(`${change.from}→${change.to}`));

  await states.listening();
  await states.processing();
  assert.deepEqual(seen, ['IDLE→LISTENING', 'LISTENING→PROCESSING']);
});

test('works without an animation manager attached', async () => {
  const states = new StateManager({});
  await states.transition('LISTENING');
  assert.equal(states.current, 'LISTENING');
  assert.equal(states.getStatus().animation, 'listening');
});
