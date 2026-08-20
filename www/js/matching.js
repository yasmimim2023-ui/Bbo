/**
 * IRONBOX 1.0 — candidate scoring.
 *
 * Pure functions: given a user phrase and the ≤ searchLimit rows SQLite
 * returned, produce a confidence in 0..1 and an explanation of how it was
 * reached. Kept free of DOM and SQL so it can be unit tested and reused by
 * tools/validate-database.js.
 */

import { CONVERSATION_CONFIG, MATCHING_CONFIG } from './config.js';
import { clamp, coverage, tokenize, tokenOverlap } from './utils.js';

/** bm25 returns negative numbers (better = more negative). Map to 0..1. */
export function rankScore(rank, matchType) {
  if (matchType === 'exact') return 1;
  if (!Number.isFinite(rank)) return 0.3;
  if (rank <= 0) return clamp(Math.min(1, Math.abs(rank) / 12));
  return clamp(1 / (1 + rank));
}

/**
 * Score one candidate row against the query.
 * @returns {{score:number, signals:object}}
 */
export function scoreCandidate(query, row, options = {}) {
  const {
    config = MATCHING_CONFIG,
    intent = null,
    contextTokens = [],
    contextBoost = CONVERSATION_CONFIG.contextBoost,
  } = options;

  const stop = new Set(config.stopWords);
  const queryTokens = tokenize(query, stop);
  // Overlap is measured against the question alone: a row with a long keyword
  // list should not be punished by the symmetry of the overlap metric.
  const questionTokens = tokenize(row.question ?? '', stop);
  const searchableTokens = tokenize(`${row.question ?? ''} ${row.keywords ?? ''}`, stop);

  const overlap = tokenOverlap(queryTokens, questionTokens);
  const covered = coverage(queryTokens, searchableTokens);
  const ranked = rankScore(row.rank, row.matchType);
  const priority = clamp((row.priority ?? 0) / (config.maxPriority || 100));
  const intentHit = intent && row.intent === intent ? 1 : 0;
  const base = config.weights[row.matchType] ?? config.weights.keyword;

  const signals = config.signals;
  const usesContext = contextTokens.length > 0;

  // The denominator only counts signals that are actually in play, so a row is
  // never penalised for a signal the caller did not supply.
  const maximum =
    0.45 +
    signals.tokenOverlap +
    signals.coverage +
    signals.rank +
    signals.priority +
    (intent ? signals.intent : 0) +
    (usesContext ? contextBoost : 0);

  let raw =
    base * 0.45 +
    overlap * signals.tokenOverlap +
    covered * signals.coverage +
    ranked * signals.rank +
    priority * signals.priority +
    intentHit * signals.intent;

  // Small nudge when the row echoes something from the recent conversation.
  let contextHit = 0;
  if (usesContext) {
    contextHit = coverage(contextTokens, searchableTokens);
    raw += contextHit * contextBoost;
  }

  // No shared subject word means no evidence: without this, match type and
  // priority alone can push an unrelated row over the answer threshold — which
  // is how "what is the airspeed velocity of an unladen swallow" once drew a
  // confident answer about the assistant's features. Interrogatives do not
  // count, since "what" is shared by most questions ever asked.
  const interrogatives = new Set(config.interrogatives ?? []);
  const evidenceTokens = queryTokens.filter((token) => !interrogatives.has(token));
  const searchable = new Set(searchableTokens);
  const hasLexicalEvidence =
    intentHit === 1 ||
    (evidenceTokens.length > 0
      ? evidenceTokens.some((token) => searchable.has(token))
      : overlap > 0 || covered > 0);
  const score = hasLexicalEvidence ? clamp(raw / maximum) : 0;

  return {
    score,
    signals: {
      matchType: row.matchType,
      base,
      overlap: Number(overlap.toFixed(3)),
      coverage: Number(covered.toFixed(3)),
      rank: Number(ranked.toFixed(3)),
      priority: Number(priority.toFixed(3)),
      intent: intentHit,
      context: Number(contextHit.toFixed(3)),
    },
  };
}

/**
 * Rank candidates, de-duplicating by row id and keeping the best variant of
 * each. Input is already limited by SQL, so this stays cheap.
 */
export function rankCandidates(query, rows = [], options = {}) {
  const best = new Map();

  for (const row of rows) {
    const { score, signals } = scoreCandidate(query, row, options);
    const previous = best.get(row.id);
    if (!previous || score > previous.score) {
      best.set(row.id, { ...row, score, signals });
    }
  }

  return [...best.values()].sort(
    (a, b) => b.score - a.score || (b.priority ?? 0) - (a.priority ?? 0),
  );
}

/** Human-readable explanation for the admin panel. */
export function explainScore(candidate) {
  if (!candidate?.signals) return '';
  const { signals, score } = candidate;
  return [
    `score=${score.toFixed(3)}`,
    `type=${signals.matchType}`,
    `overlap=${signals.overlap}`,
    `coverage=${signals.coverage}`,
    `rank=${signals.rank}`,
    `priority=${signals.priority}`,
    signals.intent ? 'intent=1' : null,
    signals.context ? `context=${signals.context}` : null,
  ]
    .filter(Boolean)
    .join('  ');
}
