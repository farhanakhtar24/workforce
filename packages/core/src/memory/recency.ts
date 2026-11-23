/**
 * Recency decay for memory ranking.
 *
 * `recencyDecay(kind, createdAt, now)` returns `0.5 ^ (ageDays / halfLife)`
 * where `ageDays = max(0, (now - createdAt) / 86_400_000)`. A block created in
 * the future (clock skew) has age 0 and therefore decays to exactly 1.0.
 *
 * Half-lives in days, per spec:
 *   learning 30, correction 90, changelog 180, observation 14,
 *   decision 180, preference 90.
 *
 * Guards (documented contract):
 * - An unknown `kind` throws {@link MemoryValidationError} (programmer error).
 * - Non-finite/invalid dates produce 0 (treat the block as fully decayed).
 */

import { memoryKinds, type MemoryKind } from './kinds.js';
import { MemoryValidationError } from './errors.js';

/** Half-life of each memory kind, in days. */
export const MEMORY_RECENCY_HALF_LIFE_DAYS: Readonly<Record<MemoryKind, number>> = {
  learning: 30,
  correction: 90,
  changelog: 180,
  observation: 14,
  decision: 180,
  preference: 90,
};

const MILLISECONDS_PER_DAY = 86_400_000;

/** Dates cross the public boundary as ISO strings, but Date is accepted too. */
export type MemoryDateInput = Date | string;

function toEpochMs(value: MemoryDateInput): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Exponential recency decay in `[0, 1]`: `0.5 ^ (ageDays / halfLife)`.
 * `createdAt` and `now` may be ISO strings or Date objects.
 */
export function recencyDecay(kind: MemoryKind, createdAt: MemoryDateInput, now: MemoryDateInput): number {
  if (!(memoryKinds as readonly string[]).includes(kind)) {
    throw new MemoryValidationError(`unknown memory kind: ${String(kind)}`);
  }
  const createdMs = toEpochMs(createdAt);
  const nowMs = toEpochMs(now);
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) {
    return 0;
  }
  const ageDays = Math.max(0, (nowMs - createdMs) / MILLISECONDS_PER_DAY);
  return Math.pow(0.5, ageDays / MEMORY_RECENCY_HALF_LIFE_DAYS[kind]);
}
