/**
 * {@link MemoryStore} implementation for fast unit tests. Same contract as the
 * Postgres adapter (same typed errors, same ordering guarantees), backed by
 * plain Maps with exact cosine over in-process vectors.
 *
 * This is a TEST store: `MemoryService` always requires an explicit store and
 * there is no hidden production fallback anywhere in `@workforce/core`.
 *
 * Concurrency model: JavaScript is single-threaded, and every write runs
 * without an intervening `await` between check and mutation, so writes are
 * atomic. `runPathExclusive` serializes via a promise-chain mutex per
 * (scope, path) key so concurrent compaction jobs observe the same
 * re-check-then-act semantics as the Postgres advisory lock.
 */

import { randomUUID } from 'node:crypto';

import { MemoryConflictError, MemoryEmbeddingError, MemoryNotFoundError, MemoryValidationError } from '../errors.js';
import { MEMORY_EMBEDDING_DIMENSIONS, type EmbeddingStatus, type MemoryKind } from '../kinds.js';
import { normalizeMemoryPath, normalizeScope } from '../paths.js';
import type {
  DerivedChatPurgeParams,
  MemoryActiveBlockListOptions,
  MemoryBlockInsert,
  MemoryEmbeddingFailedUpdate,
  MemoryEmbeddingReadyUpdate,
  MemoryQueryParams,
  MemoryStore,
  MemoryStoreTxView,
  MemoryVectorCandidate,
  MemoryVectorSearchParams,
} from '../store.js';
import type { MemoryBlock, MemoryRelation } from '../types.js';
import { isPathWithin } from '../paths.js';
/** Clamp for in-memory cosine so both stores feed the ranker the same range. */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const valueA = a[index] as number;
    const valueB = b[index] as number;
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  const similarity = dot / denominator;
  if (!Number.isFinite(similarity)) {
    return 0;
  }
  return Math.min(1, Math.max(-1, similarity));
}

function toIso(value?: string | Date): string {
  if (value === undefined) {
    return new Date().toISOString();
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new MemoryValidationError('timestamps must be valid dates or ISO strings');
  }
  return date.toISOString();
}

/** Structured clone keeps internal state safe from caller mutation. */
function cloneBlock(block: MemoryBlock): MemoryBlock {
  return structuredClone(block);
}

/**
 * Validated (chars `A-Za-z0-9_-`, 1..64 each), deduplicated, bounded
 * (<= 512) assistant-message id set; `null` when the caller purges the whole
 * exact path.
 */
const PURGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PURGE_MAX_IDS = 512;

function normalizePurgeMessageIds(ids: readonly string[] | undefined): string[] | null {
  if (ids === undefined) {
    return null;
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new MemoryValidationError('assistantMessageIds must be a non-empty array of message ids');
  }
  if (ids.length > PURGE_MAX_IDS) {
    throw new MemoryValidationError(`assistantMessageIds must list at most ${PURGE_MAX_IDS} ids`);
  }
  const unique = [...new Set(ids)];
  for (const id of unique) {
    if (typeof id !== 'string' || PURGE_ID_PATTERN.test(id) === false) {
      throw new MemoryValidationError('assistantMessageIds entries must be 1..64 characters of A-Z a-z 0-9 _ -');
    }
  }
  return unique;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly blocks = new Map<string, MemoryBlock>();

  /** Vectors live here, keyed by block id — never on MemoryBlock. */
  private readonly embeddings = new Map<string, readonly number[]>();

  private readonly relations = new Map<string, MemoryRelation>();

  private readonly locks = new Map<string, Promise<unknown>>();

  // -- writes ----------------------------------------------------------------

  async insertSupersedingBlock(
    data: MemoryBlockInsert,
    supersedeTargetIds: readonly string[],
  ): Promise<MemoryBlock> {
    const scope = normalizeScope(data.scope);
    const path = normalizeMemoryPath(data.path);
    const kind = data.kind;
    const content = data.content;
    const confidence = data.confidence;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new MemoryValidationError('confidence must be a number between 0 and 1');
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new MemoryValidationError('content must be a non-empty string');
    }

    const targets = [...new Set(supersedeTargetIds)];
    const id = data.id ?? randomUUID();

    if (targets.includes(id)) {
      throw new MemoryValidationError(`memory block ${id} cannot supersede itself`);
    }

    const nowIso = toIso();
    const createdAtIso = toIso(data.createdAt);

    // Validate targets first so a failure never leaves partial state.
    const validatedTargets: MemoryBlock[] = targets.map((targetId) => {
      const target = this.blocks.get(targetId);
      if (!target) {
        throw new MemoryNotFoundError(`memory block ${targetId} not found`);
      }
      if (target.scope !== scope) {
        throw new MemoryConflictError(
          `superseding block ${targetId} requires both blocks in the same scope (target is "${target.scope}", write is "${scope}")`,
        );
      }
      if (target.supersededById !== null) {
        throw new MemoryConflictError(`memory block ${targetId} is already superseded by ${target.supersededById}`);
      }
      return target;
    });

    const status: EmbeddingStatus = data.embeddingStatus ?? 'pending';
    const block: MemoryBlock = {
      id,
      scope,
      path,
      kind,
      content,
      confidence,
      embeddingStatus: status,
      embeddingModel: null,
      accessCount: 0,
      supersededById: null,
      metadata: structuredClone(data.metadata ?? {}),
      createdAt: createdAtIso,
      updatedAt: nowIso,
      embeddedAt: null,
      lastAccessedAt: null,
    };
    this.blocks.set(id, block);

    for (const target of validatedTargets) {
      const relation: MemoryRelation = {
        id: randomUUID(),
        sourceId: id,
        targetId: target.id,
        type: 'supersedes',
        createdAt: nowIso,
      };
      this.relations.set(relationKey(relation.id), relation);
      const current = this.blocks.get(target.id) as MemoryBlock;
      this.blocks.set(target.id, {
        ...current,
        supersededById: id,
        updatedAt: nowIso,
      });
    }

    return cloneBlock(block);
  }

  // -- block reads -----------------------------------------------------------

  async getBlock(id: string): Promise<MemoryBlock | null> {
    const block = this.blocks.get(id);
    return block ? cloneBlock(block) : null;
  }

  async getBlocks(ids: readonly string[]): Promise<ReadonlyMap<string, MemoryBlock>> {
    const result = new Map<string, MemoryBlock>();
    for (const id of ids) {
      const block = this.blocks.get(id);
      if (block) {
        result.set(id, cloneBlock(block));
      }
    }
    return result;
  }

  async queryBlocks(params: MemoryQueryParams): Promise<readonly MemoryBlock[]> {
    if (!Number.isFinite(params.limit) || params.limit <= 0) {
      return [];
    }
    const keyword = params.keyword?.toLowerCase();
    const matches = [...this.blocks.values()].filter((block) => {
      if (params.scope !== undefined && block.scope !== params.scope) {
        return false;
      }
      if (params.pathPrefix !== undefined && !isPathWithin(params.pathPrefix, block.path)) {
        return false;
      }
      if (params.kind !== undefined && block.kind !== params.kind) {
        return false;
      }
      if (!params.includeSuperseded && block.supersededById !== null) {
        return false;
      }
      if (keyword !== undefined && !block.content.toLowerCase().includes(keyword)) {
        return false;
      }
      return true;
    });
    matches.sort(compareNewestFirst);
    return matches.slice(0, Math.floor(params.limit)).map(cloneBlock);
  }

  async countActiveBlocksByPath(scope: string, path: string): Promise<number> {
    const targetScope = normalizeScope(scope);
    const targetPath = normalizeMemoryPath(path);
    let count = 0;
    for (const block of this.blocks.values()) {
      if (block.scope === targetScope && block.path === targetPath && block.supersededById === null) {
        count += 1;
      }
    }
    return count;
  }

  async listActiveBlocksByPath(
    scope: string,
    path: string,
    options: MemoryActiveBlockListOptions,
  ): Promise<readonly MemoryBlock[]> {
    if (!Number.isFinite(options.limit) || options.limit <= 0) {
      return [];
    }
    const targetScope = normalizeScope(scope);
    const targetPath = normalizeMemoryPath(path);
    const matches = [...this.blocks.values()].filter((block) => {
      if (block.scope !== targetScope || block.path !== targetPath || block.supersededById !== null) {
        return false;
      }
      return options.kind === undefined || block.kind === options.kind;
    });
    matches.sort(options.order === 'oldest' ? compareOldestFirst : compareNewestFirst);
    return matches.slice(0, Math.floor(options.limit)).map(cloneBlock);
  }

  // -- compaction critical section -------------------------------------------

  async runPathExclusive<T>(
    scope: string,
    path: string,
    work: (ops: MemoryStoreTxView) => Promise<T>,
  ): Promise<T> {
    const normalizedScope = normalizeScope(scope);
    const normalizedPath = normalizeMemoryPath(path);
    const key = `${normalizedScope}\u0000${normalizedPath}`;
    const previous = this.locks.get(key) ?? Promise.resolve();

    const run = async (): Promise<T> => {
      // The in-memory store is serial already; `this` satisfies the tx view.
      const ops: MemoryStoreTxView = {
        countActiveBlocksByPath: (opsScope, opsPath) => this.countActiveBlocksByPath(opsScope, opsPath),
        listActiveBlocksByPath: (opsScope, opsPath, opsOptions) =>
          this.listActiveBlocksByPath(opsScope, opsPath, opsOptions),
        insertSupersedingBlock: (data, targets) => this.insertSupersedingBlock(data, targets),
      };
      return work(ops);
    };

    const result = previous.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    });
    return result;
  }

  // -- embedding state -------------------------------------------------------

  async markEmbeddingReady(id: string, update: MemoryEmbeddingReadyUpdate): Promise<void> {
    const block = this.blocks.get(id);
    if (!block) {
      throw new MemoryNotFoundError(`memory block ${id} not found`);
    }
    if (update.embedding.length !== MEMORY_EMBEDDING_DIMENSIONS) {
      throw new MemoryEmbeddingError(
        `embedding must contain exactly ${MEMORY_EMBEDDING_DIMENSIONS} values, got ${update.embedding.length}`,
      );
    }
    for (const value of update.embedding) {
      if (!Number.isFinite(value)) {
        throw new MemoryEmbeddingError('embedding values must all be finite');
      }
    }
    const nowIso = toIso();
    this.embeddings.set(id, [...update.embedding]);
    this.blocks.set(id, {
      ...block,
      embeddingStatus: 'ready',
      embeddingModel: update.model,
      embeddedAt: toIso(update.embeddedAt),
      updatedAt: nowIso,
    });
  }

  async markEmbeddingFailed(id: string, update: MemoryEmbeddingFailedUpdate): Promise<void> {
    const block = this.blocks.get(id);
    if (!block) {
      throw new MemoryNotFoundError(`memory block ${id} not found`);
    }
    this.blocks.set(id, {
      ...block,
      embeddingStatus: 'failed',
      embeddingModel: update.model,
      updatedAt: toIso(),
    });
  }

  // -- vector search -----------------------------------------------------------

  async nearestReadyCandidates(params: MemoryVectorSearchParams): Promise<readonly MemoryVectorCandidate[]> {
    if (!Number.isFinite(params.limit) || params.limit <= 0) {
      return [];
    }
    if (params.embedding.length !== MEMORY_EMBEDDING_DIMENSIONS) {
      throw new MemoryEmbeddingError(
        `query embedding must contain exactly ${MEMORY_EMBEDDING_DIMENSIONS} values, got ${params.embedding.length}`,
      );
    }
    for (const value of params.embedding) {
      if (!Number.isFinite(value)) {
        throw new MemoryEmbeddingError('query embedding values must all be finite');
      }
    }
    const candidates: MemoryVectorCandidate[] = [];
    for (const block of this.blocks.values()) {
      const vector = this.embeddings.get(block.id);
      if (!vector || block.embeddingStatus !== 'ready' || block.supersededById !== null) {
        continue;
      }
      if (params.scope !== undefined && block.scope !== params.scope) {
        continue;
      }
      if (params.pathPrefix !== undefined && !isPathWithin(params.pathPrefix, block.path)) {
        continue;
      }
      if (params.kind !== undefined && block.kind !== params.kind) {
        continue;
      }
      candidates.push({ cosineSimilarity: cosineSimilarity(params.embedding, vector), block: cloneBlock(block) });
    }
    candidates.sort((a, b) => {
      if (a.cosineSimilarity !== b.cosineSimilarity) {
        return b.cosineSimilarity - a.cosineSimilarity;
      }
      const aMs = Date.parse(a.block.createdAt);
      const bMs = Date.parse(b.block.createdAt);
      if (aMs !== bMs) {
        return bMs - aMs;
      }
      if (a.block.id !== b.block.id) {
        return a.block.id < b.block.id ? -1 : 1;
      }
      return 0;
    });
    return candidates.slice(0, Math.floor(params.limit));
  }

  // -- relations and access ----------------------------------------------------

  async listRelationsBySource(id: string): Promise<readonly MemoryRelation[]> {
    const found = [...this.relations.values()]
      .filter((relation) => relation.sourceId === id)
      .sort(compareRelations);
    return found.map(cloneRelation);
  }

  async listRelationsByTarget(id: string): Promise<readonly MemoryRelation[]> {
    const found = [...this.relations.values()]
      .filter((relation) => relation.targetId === id)
      .sort(compareRelations);
    return found.map(cloneRelation);
  }

  async touchAccessed(ids: readonly string[]): Promise<void> {
    const nowIso = toIso();
    for (const id of ids) {
      const block = this.blocks.get(id);
      if (!block) {
        continue;
      }
      this.blocks.set(id, {
        ...block,
        accessCount: block.accessCount + 1,
        lastAccessedAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  async purgeDerivedChatBlocks(params: DerivedChatPurgeParams): Promise<number> {
    const targetScope = normalizeScope(params.scope);
    const targetPath = normalizeMemoryPath(params.path);
    const ids = normalizePurgeMessageIds(params.assistantMessageIds);
    // Single-threaded: one synchronous pass is atomic (same model as writes).
    const doomed: string[] = [];
    for (const [id, block] of this.blocks.entries()) {
      if (block.scope !== targetScope || block.path !== targetPath) {
        continue;
      }
      if (ids !== null && ids.includes(String(block.metadata['assistantMessageId'] ?? '')) === false) {
        continue;
      }
      doomed.push(id);
    }
    for (const id of doomed) {
      this.blocks.delete(id);
    }
    // Relations whose SOURCE was deleted cascade; incoming relations (this
    // block as target) vanish with the row deletion as well (the Postgres FK
    // contract mirrored here) — the relation map loses both directions.
    for (const [key, relation] of [...this.relations.entries()]) {
      if (doomed.includes(relation.sourceId) || doomed.includes(relation.targetId)) {
        this.relations.delete(key);
      }
    }
    return doomed.length;
  }
}

// -- helpers ------------------------------------------------------------------

function relationKey(relationId: string): string {
  return relationId;
}

function cloneRelation(relation: MemoryRelation): MemoryRelation {
  return structuredClone(relation);
}

function compareOldestFirst(a: MemoryBlock, b: MemoryBlock): number {
  const aMs = Date.parse(a.createdAt);
  const bMs = Date.parse(b.createdAt);
  if (aMs !== bMs) {
    return aMs - bMs;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

/** Newest (createdAt desc) first; ties break by ASCENDING id (deterministic). */
function compareNewestFirst(a: MemoryBlock, b: MemoryBlock): number {
  const aMs = Date.parse(a.createdAt);
  const bMs = Date.parse(b.createdAt);
  if (aMs !== bMs) {
    return bMs - aMs;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

function compareRelations(a: MemoryRelation, b: MemoryRelation): number {
  const aMs = Date.parse(a.createdAt);
  const bMs = Date.parse(b.createdAt);
  if (aMs !== bMs) {
    return aMs - bMs;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}
