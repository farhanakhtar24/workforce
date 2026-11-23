/**
 * The store contract behind {@link MemoryService}. Two implementations ship:
 *
 * - `InMemoryMemoryStore` (`./stores/in-memory-memory-store.js`) — exact,
 *   synchronous-critical-section store for fast unit tests.
 * - `PostgresMemoryStore` (`./postgres/index.js`, subpath
 *   `@workforce/core/memory/postgres`) — pgvector-backed store. Import it ONLY
 *   via the `memory/postgres` subpath so consumers that don't need Postgres
 *   (the CLI) never load Prisma.
 *
 * Contract notes:
 * - Stores validate scope/path shape on writes (defense in depth) and never
 *   expose embedding vectors through any method returning blocks.
 * - `insertSupersedingBlock` is the atomic primitive both corrections
 *   (1 target) and compaction (N targets) build on: it inserts one pending
 *   block plus `supersedes` relations to every target, marks each target
 *   superseded, and fails typed if a target is missing, cross-scope, already
 *   superseded, or the new block itself.
 * - `runPathExclusive` serializes compaction work per (scope, path):
 *   Postgres runs it inside a transaction holding `pg_advisory_xact_lock`,
 *   the in-memory store uses a promise-chain mutex. The passed `ops` view is
 *   scoped to that critical section.
 * - Dates: stores expose ISO strings on blocks (see `./types.js`).
 */

import type { EmbeddingStatus, MemoryKind } from './kinds.js';
import type { MemoryMetadata, MemoryBlock, MemoryRelation } from './types.js';

/** Payload for inserting one block. `id` optional for deterministic tests. */
export interface MemoryBlockInsert {
  readonly id?: string;
  readonly scope: string;
  readonly path: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly confidence: number;
  /** Service normalizes absent metadata to `{}`. */
  readonly metadata?: MemoryMetadata;
  /** Defaults to `pending`. */
  readonly embeddingStatus?: EmbeddingStatus;
  /**
   * Optional creation timestamp override (ISO string, or Date for callers
   * holding one). Defaults to the store clock.
   */
  readonly createdAt?: string | Date;
}

/** Filters for `queryBlocks`. Absent filters are unconstrained. */
export interface MemoryQueryParams {
  readonly scope?: string;
  /** Exact path plus all descendants (`a` matches `a` and `a/b`, never `ab`). */
  readonly pathPrefix?: string;
  readonly kind?: MemoryKind;
  /** Case-insensitive substring match on content. */
  readonly keyword?: string;
  /** Default false: superseded blocks are hidden. */
  readonly includeSuperseded?: boolean;
  /** 1..100 enforced upstream; values <= 0 return no blocks. */
  readonly limit: number;
}

/** Options for the compaction-support listing (exact path, active only). */
export interface MemoryActiveBlockListOptions {
  readonly limit: number;
  /** `oldest` = ascending createdAt then id; `newest` = descending. */
  readonly order: 'oldest' | 'newest';
  readonly kind?: MemoryKind;
}

/** Raw vector candidate handed to `rankMemoryCandidates`. */
export interface MemoryVectorCandidate {
  /** Cosmetic distance already converted: `1 - (embedding <=> query)`. */
  readonly cosineSimilarity: number;
  readonly block: MemoryBlock;
}

export interface MemoryVectorSearchParams {
  readonly embedding: readonly number[];
  readonly limit: number;
  readonly scope?: string;
  readonly pathPrefix?: string;
  readonly kind?: MemoryKind;
}

export interface MemoryEmbeddingReadyUpdate {
  readonly embedding: readonly number[];
  readonly model: string;
  readonly embeddedAt: string | Date;
}

export interface MemoryEmbeddingFailedUpdate {
  readonly model: string;
}

/**
 * Operations view scoped to a `runPathExclusive` critical section. All three
 * methods execute in the same transaction/lock as the enclosing call.
 */
export interface MemoryStoreTxView {
  countActiveBlocksByPath(scope: string, path: string): Promise<number>;
  listActiveBlocksByPath(
    scope: string,
    path: string,
    options: MemoryActiveBlockListOptions,
  ): Promise<readonly MemoryBlock[]>;
  insertSupersedingBlock(
    data: MemoryBlockInsert,
    supersedeTargetIds: readonly string[],
  ): Promise<MemoryBlock>;
}

export interface MemoryStore extends MemoryStoreTxView {
  /**
   * Atomic write primitive: insert `data` (status pending by default) and
   * create `supersedes` relations to every target, marking each target
   * superseded by the new block. Validates (typed errors):
   * - target missing -> MemoryNotFoundError
   * - cross-scope target -> MemoryConflictError
   * - target already superseded -> MemoryConflictError
   * - new block superseding itself -> MemoryValidationError
   */
  insertSupersedingBlock(
    data: MemoryBlockInsert,
    supersedeTargetIds: readonly string[],
  ): Promise<MemoryBlock>;

  getBlock(id: string): Promise<MemoryBlock | null>;

  /** Missing ids are simply absent from the returned map. */
  getBlocks(ids: readonly string[]): Promise<ReadonlyMap<string, MemoryBlock>>;

  queryBlocks(params: MemoryQueryParams): Promise<readonly MemoryBlock[]>;

  /** Exact-path active (`supersededById IS NULL`) count for a (scope, path). */
  countActiveBlocksByPath(scope: string, path: string): Promise<number>;

  /** Active blocks on the EXACT path, ordered by createdAt then id. */
  listActiveBlocksByPath(
    scope: string,
    path: string,
    options: MemoryActiveBlockListOptions,
  ): Promise<readonly MemoryBlock[]>;

  /**
   * Serialize work per (scope, path). The lock is SHARED by implementations
   * but is NOT a single transaction: the Postgres store holds a session-level
   * `pg_advisory_lock` on a dedicated connection while `work` runs, and each
   * operation invoked through the `ops` view (e.g. `insertSupersedingBlock`)
   * opens its own short transaction underneath that lock. Concurrent calls
   * for the same key run one after another; different keys run independently.
   * A dropped lock-session socket releases the lock automatically.
   */
  runPathExclusive<T>(
    scope: string,
    path: string,
    work: (ops: MemoryStoreTxView) => Promise<T>,
  ): Promise<T>;

  /** Atomically store the vector and flip the block to `ready`. */
  markEmbeddingReady(id: string, update: MemoryEmbeddingReadyUpdate): Promise<void>;

  /** Flip the block to `failed` (best-effort path after errors). */
  markEmbeddingFailed(id: string, update: MemoryEmbeddingFailedUpdate): Promise<void>;

  /**
   * Nearest READY, non-superseded candidates by cosine distance. Postgres
   * uses pgvector `<=>` with an HNSW index; the in-memory store computes exact
   * cosine. Ties resolve deterministically (createdAt desc, then id asc).
   */
  nearestReadyCandidates(
    params: MemoryVectorSearchParams,
  ): Promise<readonly MemoryVectorCandidate[]>;

  /** Relations whose source is `id` (any type, supersedes included). */
  listRelationsBySource(id: string): Promise<readonly MemoryRelation[]>;

  /** Relations whose target is `id` (any type, supersedes included). */
  listRelationsByTarget(id: string): Promise<readonly MemoryRelation[]>;

  /** Bump `accessCount`/`lastAccessedAt` for returned search ids. Missing ids are ignored. */
  touchAccessed(ids: readonly string[]): Promise<void>;
}
