/**
 * Memory domain vocabulary: kinds, embedding statuses, relation types, and the
 * shared numeric constants pinned by the Phase 3 spec.
 *
 * The half-life table lives in `./recency.js`; this module only carries the
 * identity/constant layer so every other module can depend on it without
 * cycles.
 */

/** Every memory kind a block can carry. */
export const memoryKinds = ['learning', 'correction', 'changelog', 'observation', 'decision', 'preference'] as const;

export type MemoryKind = (typeof memoryKinds)[number];

/** Lifecycle of a block's embedding. */
export const embeddingStatuses = ['pending', 'ready', 'failed'] as const;

export type EmbeddingStatus = (typeof embeddingStatuses)[number];

/** Typed edges between blocks. */
export const memoryRelationTypes = ['supports', 'supersedes', 'contradicts'] as const;

export type MemoryRelationType = (typeof memoryRelationTypes)[number];

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (memoryKinds as readonly string[]).includes(value);
}

export function isEmbeddingStatus(value: unknown): value is EmbeddingStatus {
  return typeof value === 'string' && (embeddingStatuses as readonly string[]).includes(value);
}

export function isMemoryRelationType(value: unknown): value is MemoryRelationType {
  return typeof value === 'string' && (memoryRelationTypes as readonly string[]).includes(value);
}

/** Fixed embedding dimensionality for the whole memory corpus. */
export const MEMORY_EMBEDDING_DIMENSIONS = 384 as const;

/** Canonical embedding model for Workforce memory (all-MiniLM-L6-v2, 384 dims). */
export const MEMORY_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

/**
 * A compaction job is enqueued when the **exact** (scope, path) active block
 * count exceeds this value — i.e. at 31 active blocks, not at 30.
 */
export const COMPACTION_THRESHOLD = 30 as const;

/** Weight of cosine similarity in the hybrid score. Exact per spec. */
export const SEMANTIC_WEIGHT = 0.8 as const;

/** Weight of recency decay in the hybrid score. Exact per spec. */
export const RECENCY_WEIGHT = 0.2 as const;

/**
 * Maximum number of READY candidate vectors the store fetches before exact
 * ranking in TypeScript. Fetches stay bounded even when a path holds far more
 * blocks than a query's `limit`.
 */
export const SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT = 100 as const;
