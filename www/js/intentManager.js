/**
 * IRONBOX 1.0 — intent detection and built-in commands.
 *
 * Two jobs:
 *   1. label a phrase with a coarse intent, which the matcher uses as a signal;
 *   2. answer a small set of device commands locally, without a database hit.
 *
 * Patterns are data, not code paths: adding an intent means adding an entry to
 * INTENT_PATTERNS, never editing the dialogue engine.
 */

import { ASSISTANT_CONFIG, PERSONALITY } from './config.js';
import { normalizeText } from './utils.js';

export const INTENT_PATTERNS = [
  { intent: 'greeting', patterns: ['hello', 'hi', 'hey', 'good morning', 'good evening', 'good afternoon'] },
  { intent: 'farewell', patterns: ['bye', 'goodbye', 'see you', 'good night'] },
  { intent: 'identity', patterns: ['who are you', 'what is your name', 'your name', 'what are you'] },
  { intent: 'capability', patterns: ['what can you do', 'help me', 'your features', 'commands'] },
  { intent: 'time', patterns: ['what time', 'current time', 'the time', 'what hour'] },
  { intent: 'date', patterns: ['what day', 'what date', 'today date', 'what is today'] },
  { intent: 'gratitude', patterns: ['thank you', 'thanks', 'appreciate it'] },
  { intent: 'affirmation', patterns: ['yes', 'yeah', 'correct', 'right', 'sure'] },
  { intent: 'negation', patterns: ['no', 'nope', 'not really', 'wrong'] },
  { intent: 'wellbeing', patterns: ['how are you', 'how do you feel', 'are you ok'] },
  { intent: 'compliment', patterns: ['you are great', 'good job', 'well done', 'nice work'] },
  { intent: 'insult', patterns: ['you are stupid', 'you are useless', 'shut up'] },
  { intent: 'repeat', patterns: ['repeat', 'say again', 'one more time'] },
  { intent: 'stop', patterns: ['stop', 'be quiet', 'silence'] },
];

/** Intents answered by the app itself, bypassing the dialogue database. */
export const LOCAL_COMMANDS = new Set(['time', 'date', 'stop', 'repeat']);

export class IntentManager {
  constructor({ patterns = INTENT_PATTERNS, personality = PERSONALITY } = {}) {
    this.patterns = patterns.map((entry) => ({
      intent: entry.intent,
      patterns: entry.patterns.map((pattern) => normalizeText(pattern)),
    }));
    this.personality = personality;
  }

  /**
   * @returns {{intent:string|null, confidence:number, matched:string|null}}
   */
  detect(text) {
    const norm = normalizeText(text);
    if (!norm) return { intent: null, confidence: 0, matched: null };

    let best = { intent: null, confidence: 0, matched: null };

    for (const entry of this.patterns) {
      for (const pattern of entry.patterns) {
        if (!pattern) continue;
        let confidence = 0;
        if (norm === pattern) confidence = 1;
        else if (norm.startsWith(`${pattern} `)) confidence = 0.85;
        else if (norm.includes(pattern)) confidence = 0.7;
        if (confidence > best.confidence) {
          best = { intent: entry.intent, confidence, matched: pattern };
        }
      }
    }

    return best;
  }

  isLocalCommand(intent) {
    return LOCAL_COMMANDS.has(intent);
  }

  /**
   * Answer a local command.
   * @returns {{answer:string, emotion:string, animation:string, source:string}|null}
   */
  handleLocalCommand(intent, { now = new Date(), locale = 'en-US', lastAnswer = null } = {}) {
    switch (intent) {
      case 'time':
        return {
          answer: `It is ${now.toLocaleTimeString(locale, {
            hour: '2-digit',
            minute: '2-digit',
          })}.`,
          emotion: 'neutral',
          animation: 'speaking',
          source: 'command',
        };
      case 'date':
        return {
          answer: `Today is ${now.toLocaleDateString(locale, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}.`,
          emotion: 'neutral',
          animation: 'speaking',
          source: 'command',
        };
      case 'stop':
        return {
          answer: '',
          emotion: 'neutral',
          animation: 'idle',
          source: 'command',
          silent: true,
        };
      case 'repeat':
        return lastAnswer
          ? { ...lastAnswer, source: 'command' }
          : {
              answer: `I have not said anything yet. Ask ${ASSISTANT_CONFIG.name} something first.`,
              emotion: 'confused',
              animation: 'confused',
              source: 'command',
            };
      default:
        return null;
    }
  }
}

export default IntentManager;
