/**
 * Core delegation domain types (pure data; transport lives in the API layer).
 *
 * ## Date representation (documented choice, mirrors memory/work-docs)
 * Every timestamp is an ISO 8601 UTC string at the public boundary.
 *
 * ## Deterministic ordering (documented)
 * `listByParent` orders by createdAt, with the record id as the tie-break, so
 * pages are stable even for same-millisecond writes: `oldest` = ascending
 * createdAt then id; `newest` = descending both.
 */

import type { DelegationMode, DelegationStatus, DelegationTargetAgent } from './kinds.js';

export interface Delegation {
  readonly id: string;
  readonly scope: string;
  readonly parentChatId: string;
  /** Globally unique: one child chat belongs to exactly one delegation. */
  readonly childChatId: string;
  readonly parentMessageId: string;
  readonly targetAgent: DelegationTargetAgent;
  readonly mode: DelegationMode;
  readonly status: DelegationStatus;
  /** Trimmed, 1..10000 characters. */
  readonly task: string;
  /** Trimmed, 1..100000 characters when supplied; null until completed. */
  readonly result: string | null;
  /** Trimmed, 1..1000 characters when supplied; host passes SAFE text only. */
  readonly error: string | null;
  /**
   * The CHILD agent's composition depth (1..2): a depth-0 orchestrator's
   * delegation carries depth 1, a depth-1 agent's delegation carries depth 2.
   */
  readonly depth: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the delegation first reaches a terminal status; never rewritten. */
  readonly completedAt: string | null;
}
