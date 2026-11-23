/**
 * Exact hybrid ranking: `score = SEMANTIC_WEIGHT * cosine + RECENCY_WEIGHT * recency`,
 * with cosine clamped defensively to [-1, 1] and recency in [0, 1] by
 * construction (documented choice: the clamp range is [-1, 1]; cosine is not
 * shifted to [0, 1] before ranking, so a negative cosine ranks below 0.2 *
 * recency and essentially never surfaces a block).
 *
 * Determinism contract:
 * - Non-finite cosine/inputs collapse to 0 (finite guards).
 * - Sorting is by exact score equality (===): higher score first; ties break
 *   to the newer block first, then by ascending block id.
 * - Floating-point sums are computed in candidate order, so the same input
 *   always produces the same order.
 */

import { MemoryValidationError } from './errors.js';
import { RECENCY_WEIGHT, SEMANTIC_WEIGHT } from './kinds.js';
import { recencyDecay, type MemoryDateInput } from './recency.js';
import type { MemoryBlock } from './types.js';

/** A raw candidate handed to the ranker by a store. */
export interface MemoryRankCandidate {
  readonly block: MemoryBlock;
  readonly cosineSimilarity: number;
}

/** A ranked candidate: the block plus the three score components. */
export interface MemoryRankedCandidate {
  readonly block: MemoryBlock;
  readonly cosineSimilarity: number;
  readonly recencyScore: number;
  readonly score: number;
}

/** Clamp to [-1, 1]; non-finite collapses to 0. */
export function clampCosine(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

/**
 * Rank candidates by the exact hybrid formula and return up to `limit`
 * results in deterministic order. `now` may be a Date or ISO string and must
 * be finite; `limit` <= 0 (or non-finite/NaN) returns an empty array.
 */
export function rankMemoryCandidates(
  candidates: readonly MemoryRankCandidate[],
  now: MemoryDateInput,
  limit: number,
): MemoryRankedCandidate[] {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new MemoryValidationError('ranking `now` must be a valid date or ISO timestamp');
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }

  const ranked = candidates.map((candidate) => {
    const cosineSimilarity = clampCosine(candidate.cosineSimilarity);
    const recencyScore = recencyDecay(candidate.block.kind, candidate.block.createdAt, now);
    const rawScore = SEMANTIC_WEIGHT * cosineSimilarity + RECENCY_WEIGHT * recencyScore;
    const score = Number.isFinite(rawScore) ? rawScore : 0;
    return { block: candidate.block, cosineSimilarity, recencyScore, score };
  });

  ranked.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    const aMs = Date.parse(a.block.createdAt);
    const bMs = Date.parse(b.block.createdAt);
    if (aMs !== bMs) {
      // Newest first wins ties.
      return bMs - aMs;
    }
    // Then deterministic ascending id order.
    if (a.block.id !== b.block.id) {
      return a.block.id < b.block.id ? -1 : 1;
    }
    return 0;
  });

  return ranked.slice(0, Math.floor(limit));
}
