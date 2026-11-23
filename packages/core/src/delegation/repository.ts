/**
 * The delegation repository contract. Two implementations ship:
 *
 * - `InMemoryDelegationRepository` (`./stores/in-memory-delegation-repository.js`)
 *   — exact synchronous-critical-section store for fast unit tests.
 * - `PrismaDelegationRepository` (`./postgres/index.js`, subpath
 *   `@workforce/core/delegation/postgres`) — Prisma/Postgres adapter, export
 *   ONLY via the subpath so pure imports never load Prisma.
 *
 * Contract notes (both implementations):
 * - Status writes follow `canTransitionDelegation` (see `./kinds.js`): the
 *   chain is pending -> running -> completed|failed|timeout; same-status
 *   writes are idempotent; a terminal status never becomes running/pending.
 *   Illegal transitions -> typed {@link DelegationConflictError} (409).
 * - `childChatId` is globally unique: creating a second delegation for the
 *   same child chat is a {@link DelegationConflictError}.
 * - `listByParent` is deterministic (createdAt then id; see `./types.js`).
 * - `completedAt` is stamped exactly once, at the first terminal write, and
 *   never rewritten by later (idempotent) same-status writes.
 * - All multi-field writes are atomic; scope/chat ownership is encoded in the
 *   ids themselves (parentChatId/childChatId are the keys).
 * - Dates: ISO strings at the public boundary.
 */

import type { DelegationStatus, DelegationTargetAgent, DelegationMode } from './kinds.js';
import type { Delegation } from './types.js';
import type {
  DelegationCreateInput,
  DelegationListByParentInput,
  DelegationUpdateStatusInput,
} from './schemas.js';

/**
 * Repository interface. Inputs are the RAW (z.input) shapes — defaults such as
 * `order: 'newest'` and `limit: 20` are applied by the implementation's Zod
 * schemas, so callers may pass partial objects safely.
 */
export interface DelegationRepository {
  /**
   * Record a new delegation (status `pending`). Duplicate `childChatId` ->
   * DelegationConflictError. The child chat is NOT created here — the API
   * layer owns chat/prompt transport; this repository only records the
   * hand-off.
   */
  create(input: DelegationCreateInput): Promise<Delegation>;

  get(id: string): Promise<Delegation | null>;

  /** Deterministic list of a parent's delegations (see `./types.js`). */
  listByParent(input: DelegationListByParentInput): Promise<readonly Delegation[]>;

  /** The delegation owning `childChatId`; null when absent. */
  getByChild(childChatId: string): Promise<Delegation | null>;

  /**
   * Transition the status machine. Same-status writes are idempotent and may
   * refresh `result`/`error`. Terminal -> anything-but-same and pending ->
   * terminal are rejected as conflicts. Missing id -> DelegationNotFoundError.
   * When `expectedFrom` is set, the write additionally requires the CURRENT
   * status to equal it atomically (single compare-and-set): two concurrent
   * claims of `expectedFrom: 'pending'` produce exactly one
   * {@link DelegationConflictError} and one winner.
   */
  updateStatus(input: DelegationUpdateStatusInput): Promise<Delegation>;
}

/** Convenience re-exports for API-side typing. */
export type { DelegationStatus, DelegationTargetAgent, DelegationMode };
