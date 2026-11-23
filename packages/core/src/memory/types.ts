/**
 * Core memory domain types shared by the service, stores, routes, and
 * adapters.
 *
 * ## Date representation (documented choice)
 * Every timestamp on a {@link MemoryBlock} or {@link MemoryRelation} is an
 * ISO 8601 UTC string (`2026-11-19T12:00:00.000Z`) at the public boundary.
 * This keeps blocks JSON-serializable for routes and queue payloads without a
 * normalization layer. Internal helpers accept `Date | string` where a Date is
 * natural (`MemoryDateInput` in `./recency.js`) and stores convert to their
 * native representation.
 *
 * ## Embeddings never cross this boundary
 * Vector values exist only inside stores. Blocks, search results, relation
 * views, and queue payloads never contain embedding data (they are not even
 * null placeholders), so nothing in this module can leak a vector to a UI.
 */

import type { EmbeddingStatus, MemoryKind, MemoryRelationType } from './kinds.js';

/** Bounded, JSON-serializable free-form object attached to a block. */
export type MemoryMetadata = Record<string, unknown>;

export interface MemoryBlock {
  readonly id: string;
  readonly scope: string;
  /** Normalized slash path, e.g. `projects/atlas/notes`. Exact path + descendants addressing. */
  readonly path: string;
  readonly kind: MemoryKind;
  /** Trimmed, 1..1000 characters. */
  readonly content: string;
  /** 0..1. */
  readonly confidence: number;
  readonly embeddingStatus: EmbeddingStatus;
  /** Model that produced the stored vector; null until embedded. */
  readonly embeddingModel: string | null;
  /** Times semantic search returned this block. */
  readonly accessCount: number;
  /** Id of the block that superseded this one, null while active. */
  readonly supersededById: string | null;
  readonly metadata: MemoryMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly embeddedAt: string | null;
  readonly lastAccessedAt: string | null;
}

export interface MemoryRelation {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: MemoryRelationType;
  readonly createdAt: string;
}

/** One ranked semantic search hit. `score` never contains embedding data. */
export interface MemorySearchResult {
  readonly block: MemoryBlock;
  /** Clamped cosine similarity in [-1, 1] used for the hybrid score. */
  readonly cosineSimilarity: number;
  /** Exponential recency decay in [0, 1] (see `recencyDecay`). */
  readonly recencyScore: number;
  /** `SEMANTIC_WEIGHT * cosineSimilarity + RECENCY_WEIGHT * recencyScore`. */
  readonly score: number;
}

/**
 * An `exploreRelated` view: the requested block plus its outgoing and incoming
 * relations, each paired with the full neighboring block. Superseded blocks
 * and supersedes relations are included.
 */
export interface MemoryRelatedEdge {
  readonly relation: MemoryRelation;
  readonly block: MemoryBlock;
}

export interface MemoryRelatedResult {
  readonly block: MemoryBlock;
  readonly outgoing: readonly MemoryRelatedEdge[];
  readonly incoming: readonly MemoryRelatedEdge[];
}
