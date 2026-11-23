/**
 * {@link MemoryService} — orchestration over a {@link MemoryStore}, an
 * {@link EmbeddingProvider}, a {@link MemoryJobQueue}, and a
 * {@link MemoryCompactor}.
 *
 * ## Async ownership rules
 * The service owns the *contracts* of the async pipeline, not its transport:
 * - `writeBlock` commits the block (pending, plus optional supersedes
 *   relation/marking in one atomic store call), THEN enqueues the embedding
 *   job keyed by block id. If enqueueing fails the block is marked `failed`
 *   and a typed {@link MemoryQueueError} is thrown — the write happened, but
 *   the pipeline is honestly reported as not scheduled.
 * - After a write, if the exact-path active count crossed
 *   {@link COMPACTION_THRESHOLD}, a compaction job is enqueued. A compaction
 *   enqueue failure is logged through the injected (safe) logger and
 *   swallowed: it never undoes a valid write, and the next write to the path
 *   triggers the enqueue again.
 * - The queue itself (e.g. BullMQ) is injected; nothing in `@workforce/core`
 *   ships or constructs a queue implementation.
 *
 * ## Deterministic embedding jobs
 * Embedding jobs carry only a block id. `processEmbedding(blockId)` re-loads
 * the block, so a retried job always reflects current state and repeated
 * runs are idempotent (a `ready` block with the same model short-circuits).
 *
 * ## Secrets and PII
 * Logging callbacks receive identifiers and shapes only. Block content,
 * vectors, and provider request/response bodies are never logged or returned.
 */

import {
  COMPACTION_THRESHOLD,
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL,
  SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT,
} from './kinds.js';
import {
  MemoryCompactionError,
  MemoryEmbeddingError,
  MemoryNotFoundError,
  MemoryQueueError,
  MemoryValidationError,
} from './errors.js';
import { rankMemoryCandidates, type MemoryRankedCandidate } from './ranking.js';
import {
  normalizeMemoryPath,
  normalizeScope,
} from './paths.js';
import {
  parseMemoryInput,
  compactPathInputSchema,
  isBoundedMetadata,
  queryBlocksInputSchema,
  semanticSearchInputSchema,
  writeBlockInputSchema,
  type MemoryCompactPathInput,
  type MemoryQueryBlocksInput,
  type MemorySemanticSearchInput,
  type MemoryWriteBlockInput,
  type ParsedSemanticSearchInput,
  type ParsedWriteBlockInput,
} from './schemas.js';
import type {
  MemoryStore,
  MemoryStoreTxView,
  MemoryVectorCandidate,
} from './store.js';
import type {
  MemoryBlock,
  MemoryMetadata,
  MemoryRelatedResult,
  MemoryRelation,
  MemorySearchResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Infrastructure interfaces the host application implements
// ---------------------------------------------------------------------------

/**
 * Embedding provider contract. `dimensions` is pinned to the literal 384 so a
 * mismatched provider can never pass typechecking silently. Text in, plain
 * finite float vector out — provider SDKs stay OUTSIDE `@workforce/core`.
 */
export interface EmbeddingProvider {
  readonly dimensions: 384;
  readonly model: string;
  embed(text: string): Promise<readonly number[]>;
}

/**
 * Async job queue contract. Implementations (e.g. BullMQ-backed) should make
 * jobs durable; the service treats a rejected enqueue as "not scheduled".
 */
export interface MemoryJobQueue {
  /** Enqueue one embedding job; jobs are identified by block id. */
  enqueueEmbedding(blockId: string): Promise<void>;
  /** Enqueue one compaction job; re-runs are idempotent inside the service. */
  enqueueCompaction(scope: string, path: string, triggerBlockId: string): Promise<void>;
}

/**
 * Compactor contract (typically an LLM prompt in the host app). Receives the
 * OLDEST {@link COMPACTION_THRESHOLD} active blocks of one exact path and must
 * return a plain summary string; the service trims it and enforces 1..1000
 * characters.
 */
export interface MemoryCompactor {
  compact(request: MemoryCompactionRequest): Promise<string>;
}

/** Optional logger hook. Failures inside the logger are contained. */
export interface MemoryLogger {
  debug?(message: string): void;
  warn?(message: string, error?: unknown): void;
}

export interface MemoryServiceOptions {
  store: MemoryStore;
  embeddingProvider: EmbeddingProvider;
  queue: MemoryJobQueue;
  compactor: MemoryCompactor;
  /** Injected for compaction enqueue failures etc.; defaults to no logging. */
  logger?: MemoryLogger;
  /** Injectable clock; defaults to `new Date()`. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Job-facing results
// ---------------------------------------------------------------------------

/** Request payload handed to a {@link MemoryCompactor}. */
export interface MemoryCompactionRequest {
  readonly scope: string;
  readonly path: string;
  readonly triggerBlockId: string;
  /** The OLDEST active blocks of the exact path, ascending createdAt. */
  readonly blocks: readonly MemoryBlock[];
}

export type MemoryCompactionOutcome =
  | {
      readonly status: 'created';
      readonly summary: MemoryBlock;
      readonly compactedCount: number;
      readonly compactedFromIds: readonly string[];
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'below_threshold' | 'already_compacted';
      /** Id of the pre-existing summary when `already_compacted`, else null. */
      readonly summaryId: string | null;
    };

export interface MemoryEmbeddingOutcome {
  readonly blockId: string;
  readonly model: string;
  /** `embedded` — fresh work done; `already_ready` — idempotent no-op. */
  readonly status: 'embedded' | 'already_ready';
  readonly embeddedAt: string | null;
}

/** Validated service options; `logger`/`now` get safe defaults. */
interface ResolvedOptions {
  readonly store: MemoryStore;
  readonly embeddingProvider: EmbeddingProvider;
  readonly queue: MemoryJobQueue;
  readonly compactor: MemoryCompactor;
  readonly logger: MemoryLogger;
  readonly now: () => Date;
}

function resolveOptions(options: MemoryServiceOptions): ResolvedOptions {
  return {
    store: options.store,
    embeddingProvider: options.embeddingProvider,
    queue: options.queue,
    compactor: options.compactor,
    logger: options.logger ?? {},
    now: options.now ?? (() => new Date()),
  };
}

/**
 * Compaction summaries carry this metadata so re-delivered jobs (at-least-once
 * queues) can prove the trigger is already represented and skip instead of
 * creating a duplicate summary.
 */
function isCompactionSummaryFor(block: MemoryBlock, triggerBlockId: string): boolean {
  if (block.kind !== 'learning') {
    return false;
  }
  const compactedFromIds = block.metadata['compactedFromIds'];
  if (Array.isArray(compactedFromIds) && compactedFromIds.includes(triggerBlockId)) {
    return true;
  }
  return block.metadata['triggerBlockId'] === triggerBlockId;
}

// ---------------------------------------------------------------------------
// Safe provider-cause classification for compaction failures
// ---------------------------------------------------------------------------

const PROVIDER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const PROVIDER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Deterministic, SAFE cause classification for compactor (LLM provider)
 * failures. The output may end up in BullMQ `failedReason` and API responses,
 * so it must never carry the provider error's message, response body, request
 * URL, headers, stack, or cause chain: only a fixed-vocabulary class:
 *
 * 1. timeout:   name is `AbortError`/`TimeoutError` (incl. DOMException-like)
 *               -> `provider timeout`
 * 2. status:    object with numeric integer `statusCode` 100..599
 *               -> `provider HTTP <status>` (digits only)
 * 3. code:      `code` matching /^[A-Z][A-Z0-9_]{0,63}$/ (ECONNREFUSED, ...)
 *               -> `provider <code>`
 * 4. name:      `Error.name` matching /^[A-Za-z][A-Za-z0-9_]{0,63}$/
 *               (e.g. AI_NoOutputGeneratedError) -> `provider <name>`
 * 5. otherwise  -> `provider unknown error`
 *
 * Priority timeout -> status -> code -> name. Everything else about the cause
 * stays attached to the {@link MemoryCompactionError} via its `cause` for
 * internal diagnostics only.
 */
export function classifyProviderCause(cause: unknown): string {
  if (cause === null || typeof cause !== 'object') {
    return 'provider unknown error';
  }
  const candidate = cause as { readonly name?: unknown; readonly statusCode?: unknown; readonly code?: unknown };
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return 'provider timeout';
  }
  const statusCode = candidate.statusCode;
  if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) {
    return `provider HTTP ${statusCode}`;
  }
  const code = candidate.code;
  if (typeof code === 'string' && PROVIDER_CODE_PATTERN.test(code)) {
    return `provider ${code}`;
  }
  if (name.length > 0 && PROVIDER_NAME_PATTERN.test(name)) {
    return `provider ${name}`;
  }
  return 'provider unknown error';
}

export class MemoryService {
  private readonly options: ResolvedOptions;

  private readonly logger: MemoryLogger;

  constructor(options: MemoryServiceOptions) {
    this.options = resolveOptions(options);
    this.logger = this.options.logger;
  }

  // -- logging helpers (never let a broken logger break the pipeline) -------

  private safeDebug(message: string): void {
    try {
      this.logger.debug?.(message);
    } catch {
      /* logging must never throw into business logic */
    }
  }

  private safeWarn(message: string, error?: unknown): void {
    try {
      this.logger.warn?.(message, error);
    } catch {
      /* logging must never throw into business logic */
    }
  }

  // -- validation helpers ----------------------------------------------------

  private parseWriteInput(input: MemoryWriteBlockInput): ParsedWriteBlockInput {
    return parseMemoryInput(writeBlockInputSchema, input);
  }

  private parseQueryInput(input: MemoryQueryBlocksInput) {
    return parseMemoryInput(queryBlocksInputSchema, input);
  }

  private parseSemanticInput(input: MemorySemanticSearchInput): ParsedSemanticSearchInput {
    return parseMemoryInput(semanticSearchInputSchema, input);
  }

  private validateEmbeddingProvider(): void {
    const provider = this.options.embeddingProvider;
    if (provider.dimensions !== MEMORY_EMBEDDING_DIMENSIONS) {
      throw new MemoryEmbeddingError(
        `embedding provider declares ${String(provider.dimensions)} dimensions; ` +
          `memory requires exactly ${MEMORY_EMBEDDING_DIMENSIONS}`,
      );
    }
    if (provider.model !== MEMORY_EMBEDDING_MODEL) {
      throw new MemoryEmbeddingError(
        `embedding provider model "${provider.model}" does not match the required ` +
          `model "${MEMORY_EMBEDDING_MODEL}"`,
      );
    }
  }

  /** Validate an embedder output: exactly 384 finite numbers. */
  private validateEmbeddingVector(vector: readonly unknown[], context: 'block' | 'query'): void {
    if (!Array.isArray(vector) || vector.length !== MEMORY_EMBEDDING_DIMENSIONS) {
      throw new MemoryEmbeddingError(
        `embedding provider returned ${Array.isArray(vector) ? vector.length : 'non-array'} ` +
          `values for the ${context} embedding; expected exactly ${MEMORY_EMBEDDING_DIMENSIONS}`,
      );
    }
    for (const value of vector) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new MemoryEmbeddingError(
          `embedding provider returned a non-finite value for the ${context} embedding`,
        );
      }
    }
  }

  // ===========================================================================
  // writeBlock
  // ===========================================================================

  /**
   * Insert a pending block (optionally superseding `supersedesId`, which must
   * live in the same (scope, exact path or any path) scope — same scope, target
   * exists, not itself, not already superseded), then enqueue the embedding
   * job. See module docs for enqueue-failure semantics.
   */
  async writeBlock(input: MemoryWriteBlockInput): Promise<MemoryBlock> {
    const parsed = this.parseWriteInput(input);
    const now = this.options.now();

    const metadata: MemoryMetadata = parsed.metadata ?? {};
    if (!isBoundedMetadata(metadata)) {
      // Defense in depth: the schema already validates this.
      throw new MemoryValidationError('memory metadata must be a bounded JSON object');
    }

    const block = await this.options.store.insertSupersedingBlock(
      {
        scope: parsed.scope,
        path: parsed.path,
        kind: parsed.kind,
        content: parsed.content,
        confidence: parsed.confidence,
        metadata,
        embeddingStatus: 'pending',
        createdAt: now.toISOString(),
      },
      parsed.supersedesId ? [parsed.supersedesId] : [],
    );

    // Enqueue AFTER commit; the job carries only the id.
    try {
      await this.options.queue.enqueueEmbedding(block.id);
    } catch (cause) {
      await this.failEmbeddingQuietly(block.id, `embedding enqueue failed for block ${block.id}`, cause);
      throw new MemoryQueueError(`failed to enqueue embedding job for block ${block.id}`, { cause });
    }

    await this.considerCompactionEnqueue(parsed.scope, parsed.path, block.id);
    return block;
  }

  /**
   * Log (never throw) a compaction enqueue failure. The write stays valid and
   * the next write to this path will trigger the enqueue again.
   */
  private async considerCompactionEnqueue(scope: string, path: string, triggerBlockId: string): Promise<void> {
    const activeCount = await this.options.store.countActiveBlocksByPath(scope, path);
    if (activeCount <= COMPACTION_THRESHOLD) {
      return;
    }
    try {
      await this.options.queue.enqueueCompaction(scope, path, triggerBlockId);
    } catch (cause) {
      this.safeWarn(
        `memory compaction enqueue failed for ${scope}:${path} (trigger ${triggerBlockId}); ` +
          'the write remains valid and the next write will retry the enqueue',
        cause,
      );
    }
  }

  /** Best-effort `failed` marking; failures are logged, never thrown. */
  private async failEmbeddingQuietly(blockId: string, message: string, cause: unknown): Promise<void> {
    try {
      await this.options.store.markEmbeddingFailed(blockId, {
        model: this.options.embeddingProvider.model,
      });
    } catch (markFailure) {
      this.safeWarn(`${message}; marking block ${blockId} failed`, markFailure);
      return;
    }
    this.safeWarn(message, cause);
  }

  // ===========================================================================
  // queryBlocks
  // ===========================================================================

  /**
   * Newest-first listing. `path` is a prefix filter covering the exact path
   * plus descendants; `keyword` is a case-insensitive substring filter on
   * content (never part of semantic ranking); superseded blocks are hidden
   * unless `includeSuperseded` is set.
   */
  async queryBlocks(input: MemoryQueryBlocksInput): Promise<readonly MemoryBlock[]> {
    const parsed = this.parseQueryInput(input);
    return this.options.store.queryBlocks({
      scope: parsed.scope,
      pathPrefix: parsed.path,
      kind: parsed.kind,
      keyword: parsed.keyword,
      includeSuperseded: parsed.includeSuperseded,
      limit: parsed.limit,
    });
  }

  // ===========================================================================
  // semanticSearch
  // ===========================================================================

  /**
   * Hybrid semantic search: the store fetches up to
   * {@link SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT} READY, non-superseded
   * candidates by cosine distance; ranking happens exactly here in
   * TypeScript via {@link rankMemoryCandidates}. Access stats are bumped for
   * the returned ids AFTER ranking so score/order cannot change mid-flight.
   */
  async semanticSearch(input: MemorySemanticSearchInput): Promise<readonly MemorySearchResult[]> {
    const parsed = this.parseSemanticInput(input);
    this.validateEmbeddingProvider();

    const queryVector = await this.options.embeddingProvider.embed(parsed.query);
    this.validateEmbeddingVector(queryVector, 'query');

    const candidates: readonly MemoryVectorCandidate[] = await this.options.store.nearestReadyCandidates({
      embedding: queryVector,
      limit: SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT,
      scope: parsed.scope,
      pathPrefix: parsed.path,
      kind: parsed.kind,
    });

    const ranked: readonly MemoryRankedCandidate[] = rankMemoryCandidates(
      candidates.map((candidate) => ({
        block: candidate.block,
        cosineSimilarity: candidate.cosineSimilarity,
      })),
      this.options.now(),
      parsed.limit,
    );

    if (ranked.length > 0) {
      try {
        await this.options.store.touchAccessed(ranked.map((candidate) => candidate.block.id));
      } catch (cause) {
        // Access accounting is best-effort; results are already ranked.
        this.safeWarn('memory access stats update failed after semanticSearch', cause);
      }
    }

    return ranked;
  }

  // ===========================================================================
  // exploreRelated
  // ===========================================================================

  /**
   * The requested block plus outgoing and incoming relations, each with the
   * full neighbor block. All relation types are included (supersedes
   * included); ordering is deterministic (relation createdAt asc, then id).
   */
  async exploreRelated(blockId: string): Promise<MemoryRelatedResult> {
    const block = await this.options.store.getBlock(blockId);
    if (!block) {
      throw new MemoryNotFoundError(`memory block ${blockId} not found`);
    }

    const [outgoingRelations, incomingRelations] = await Promise.all([
      this.options.store.listRelationsBySource(blockId),
      this.options.store.listRelationsByTarget(blockId),
    ]);

    const neighborIds = new Set<string>();
    for (const relation of outgoingRelations) {
      neighborIds.add(relation.targetId);
    }
    for (const relation of incomingRelations) {
      neighborIds.add(relation.sourceId);
    }
    const neighbors = await this.options.store.getBlocks([...neighborIds]);

    return {
      block,
      outgoing: buildEdges(outgoingRelations, neighbors, (relation) => relation.targetId),
      incoming: buildEdges(incomingRelations, neighbors, (relation) => relation.sourceId),
    };
  }

  // ===========================================================================
  // processEmbedding (worker-facing)
  // ===========================================================================

  /**
   * Embed one block and flip it to `ready` atomically. Idempotent for
   * `ready` blocks with the same model. Any provider/store failure marks the
   * block `failed` when possible and rethrows so queue-level retries (BullMQ)
   * can pick the job back up.
   */
  async processEmbedding(blockId: string): Promise<MemoryEmbeddingOutcome> {
    const provider = this.options.embeddingProvider;
    const block = await this.options.store.getBlock(blockId);
    if (!block) {
      throw new MemoryNotFoundError(`memory block ${blockId} not found`);
    }

    // Idempotent no-op: already embedded with the same model.
    if (block.embeddingStatus === 'ready' && block.embeddedAt !== null && block.embeddingModel === provider.model) {
      return { blockId: block.id, model: provider.model, status: 'already_ready', embeddedAt: block.embeddedAt };
    }

    try {
      // Model/dimension validation happens BEFORE embed work so a
      // misconfigured provider fails fast, marks the block failed, and the
      // rethrow lets queue retries surface the real cause.
      this.validateEmbeddingProvider();
      const vector = await provider.embed(block.content);
      this.validateEmbeddingVector(vector, 'block');
      const embeddedAt = this.options.now();
      await this.options.store.markEmbeddingReady(block.id, {
        embedding: vector,
        model: provider.model,
        embeddedAt,
      });
      return { blockId: block.id, model: provider.model, status: 'embedded', embeddedAt: embeddedAt.toISOString() };
    } catch (cause) {
      await this.failEmbeddingQuietly(block.id, `embedding failed for block ${block.id}`, cause);
      // Rethrow the ORIGINAL error so queue retries carry the real cause.
      throw cause;
    }
  }

  // ===========================================================================
  // processCompaction (worker-facing)
  // ===========================================================================

  /**
   * Compact one exact (scope, path) when it holds more than
   * {@link COMPACTION_THRESHOLD} active blocks.
   *
   * Runs under `runPathExclusive` (session-level advisory lock per scope+path in
   * Postgres, held on a dedicated pg connection outside Prisma; promise-chain
   * mutex in memory), and RE-CHECKS state under the lock:
   *
   * 1. If the trigger block is already represented by an active summary
   *    (metadata `compactedFromIds`/`triggerBlockId`), the run is a no-op
   *    (`skipped/already_compacted`); the pending summary's embedding job is
   *    re-enqueued when needed, which makes retried jobs safe under
   *    at-least-once delivery without creating duplicate summaries.
   * 2. If the exact-path active count is <= threshold -> `skipped/
   *    below_threshold`.
   * 3. Otherwise the OLDEST 30 active blocks are handed to the compactor, the
   *    trimmed summary must be 1..1000 chars, and ONE pending `learning`
   *    summary block is inserted on the same (scope, path) with confidence =
   *    min(source confidences, clamped to [0,1]) and metadata carrying
   *    `compactedFromIds` + `triggerBlockId`. Every source gets a `supersedes`
   *    relation to the summary and is marked superseded. Source rows are
   *    preserved (never deleted).
   *
   * Embedding of the summary is enqueued AFTER commit. If that enqueue fails,
   * the summary is marked `failed` and a {@link MemoryQueueError} is thrown —
   * the job retries later and lands in branch 1, so sources are never
   * compacted twice.
   */
  async processCompaction(scopeRaw: string, pathRaw: string, triggerBlockId: string): Promise<MemoryCompactionOutcome> {
    const scope = normalizeScope(scopeRaw);
    const path = normalizeMemoryPath(pathRaw);

    const outcome = await this.options.store.runPathExclusive(scope, path, async (tx: MemoryStoreTxView) => {
      // (1) Re-delivery protection: is this trigger already represented?
      const summaries = await tx.listActiveBlocksByPath(scope, path, {
        limit: 1,
        order: 'newest',
        kind: 'learning',
      });
      const existing = summaries.find((candidate) => isCompactionSummaryFor(candidate, triggerBlockId));
      if (existing) {
        // The trigger is already represented; retry-safe skip. A not-yet-ready
        // summary gets its embedding job re-enqueued after the lock releases.
        return { status: 'skipped' as const, reason: 'already_compacted' as const, summaryId: existing.id };
      }

      // (2) Threshold recheck under the lock.
      const activeCount = await tx.countActiveBlocksByPath(scope, path);
      if (activeCount <= COMPACTION_THRESHOLD) {
        return { status: 'skipped' as const, reason: 'below_threshold' as const, summaryId: null };
      }

      // (3) Compact the OLDEST active blocks of the exact path.
      const sources = await tx.listActiveBlocksByPath(scope, path, {
        limit: COMPACTION_THRESHOLD,
        order: 'oldest',
      });
      if (sources.length === 0 || sources.length > COMPACTION_THRESHOLD) {
        // Defensive: caller contract violation (store bug). Fail honestly.
        throw new MemoryCompactionError(
          `compaction selected ${sources.length} sources for ${scope}:${path}; expected 1..${COMPACTION_THRESHOLD}`,
        );
      }

      let rawSummary: string;
      try {
        rawSummary = await this.options.compactor.compact({
          scope,
          path,
          triggerBlockId,
          blocks: sources,
        });
      } catch (cause) {
        // Public message carries a deterministic SAFE classification only (no
        // provider message/body/URL/stack); the raw cause stays attached via
        // `cause` for internal diagnostics and BullMQ stack traces.
        throw new MemoryCompactionError(
          `memory compactor failed for ${scope}:${path} (${classifyProviderCause(cause)})`,
          { cause },
        );
      }

      const summaryContent = typeof rawSummary === 'string' ? rawSummary.trim() : '';
      if (summaryContent.length < 1 || summaryContent.length > 1000) {
        throw new MemoryCompactionError(
          'memory compactor must return a plain summary of 1..1000 characters after trimming',
        );
      }

      const sourceConfidences = sources.map((source) =>
        Number.isFinite(source.confidence) ? Math.min(1, Math.max(0, source.confidence)) : 0,
      );
      const summaryConfidence = sourceConfidences.length > 0 ? Math.min(...sourceConfidences) : 0;

      const compactedFromIds = sources.map((source) => source.id);
      const metadata: MemoryMetadata = { compactedFromIds, triggerBlockId };
      if (!isBoundedMetadata(metadata)) {
        throw new MemoryCompactionError(
          `compaction metadata for ${sources.length} sources exceeds the metadata bounds`,
        );
      }

      // Atomic under the shared path lock (each write opens its own short
      // transaction): summary + relations + marks.
      const summary = await tx.insertSupersedingBlock(
        {
          scope,
          path,
          kind: 'learning',
          content: summaryContent,
          confidence: summaryConfidence,
          metadata,
          embeddingStatus: 'pending',
          createdAt: this.options.now().toISOString(),
        },
        compactedFromIds,
      );

      return {
        status: 'created' as const,
        summary,
        compactedCount: sources.length,
        compactedFromIds,
      };
      });

    // (4) AFTER commit: ensure the summary has an embedding job.
    if (outcome.status === 'created') {
      await this.ensureSummaryEmbedding(outcome.summary);
    } else if (outcome.status === 'skipped' && outcome.reason === 'already_compacted') {
      const { summaryId } = outcome;
      if (summaryId) {
        const summary = await this.options.store.getBlock(summaryId);
        if (summary && summary.embeddingStatus !== 'ready') {
          await this.ensureSummaryEmbedding(summary);
        }
      }
    }

    return outcome;
  }

  /**
   * Enqueue the summary embedding. Failure marks the summary failed and
   * throws {@link MemoryQueueError}; the job retry path re-enters
   * `processCompaction`, finds `already_compacted`, and tries the enqueue
   * again — sources stay superseded exactly once.
   */
  private async ensureSummaryEmbedding(summary: MemoryBlock): Promise<void> {
    try {
      await this.options.queue.enqueueEmbedding(summary.id);
    } catch (cause) {
      await this.failEmbeddingQuietly(
        summary.id,
        `summary embedding enqueue failed for block ${summary.id}`,
        cause,
      );
      throw new MemoryQueueError(`failed to enqueue embedding job for summary block ${summary.id}`, { cause });
    }
  }
}

// ---------------------------------------------------------------------------
// Edge-building helper for exploreRelated (deterministic order)
// ---------------------------------------------------------------------------

function buildEdges(
  relations: readonly MemoryRelation[],
  neighbors: ReadonlyMap<string, MemoryBlock>,
  neighborId: (relation: MemoryRelation) => string,
): MemoryRelatedResult['outgoing'] {
  return relations
    .slice()
    .sort((a, b) => {
      const aMs = Date.parse(a.createdAt);
      const bMs = Date.parse(b.createdAt);
      if (aMs !== bMs) {
        return aMs - bMs;
      }
      if (a.id !== b.id) {
        return a.id < b.id ? -1 : 1;
      }
      return 0;
    })
    .flatMap((relation) => {
      const block = neighbors.get(neighborId(relation));
      // A missing neighbor can only happen if the row vanished mid-flight;
      // skipping keeps the view honest instead of inventing nulls.
      return block ? [{ relation, block }] : [];
    });
}
