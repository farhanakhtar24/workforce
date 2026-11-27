/**
 * Phase 3 memory routes (ADR-aligned with the Phase 2 endpoint table):
 *
 * - POST /api/memory/blocks            — write a block, enqueue its embed job
 * - GET  /api/memory/blocks            — list blocks (strict query validation)
 * - POST /api/memory/search            — hybrid semantic search
 * - GET  /api/memory/blocks/:id/related — block + outgoing/incoming relations
 * - POST /api/memory/blocks/:id/retry   — requeue a failed/pending embed
 * - POST /api/memory/compact           — enqueue an on-demand compaction
 *
 * Error contract (fixed safe strings only — never core issue text, submitted
 * content, DB/provider bodies, URLs, or stacks):
 * - validation -> 400 "Invalid memory request."
 * - not found  -> 404 "Memory block not found."
 * - conflict   -> 409 "Memory conflict."
 * - queue      -> 503 "Memory queue is temporarily unavailable."
 * - other memory failures (embedding/compaction/store/Prisma/unexpected)
 *   -> 503 "Memory service is temporarily unavailable."
 *
 * Deps are injected ({ service, queue }): `buildApp` callers may omit them
 * (the routes are then absent), production always supplies both.
 * GET strings are validated strictly: `limit` only accepts integer strings,
 * `includeSuperseded` only `true`/`false`; junk values fail 400 instead of
 * being silently coerced or defaulted.
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response, RequestHandler } from 'express';
import {
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryQueueError,
  MemoryValidationError,
  memoryIdSchema,
  compactPathInputSchema,
  parseMemoryInput,
  queryBlocksInputSchema,
  semanticSearchInputSchema,
  writeBlockInputSchema,
  type MemoryJobQueue,
  type MemoryRelatedResult,
  type MemorySearchResult,
  type MemoryService,
} from '@workforce/core/memory';
import { userMemoryScope } from '@workforce/core/auth';
import type { SafeLogger } from '../logging.js';
import { ownerOf } from '../auth/owner.js';

export const INVALID_MEMORY_REQUEST = 'Invalid memory request.';
export const MEMORY_NOT_FOUND = 'Memory block not found.';
export const MEMORY_CONFLICT = 'Memory conflict.';
export const QUEUE_UNAVAILABLE = 'Memory queue is temporarily unavailable.';
export const SERVICE_UNAVAILABLE = 'Memory service is temporarily unavailable.';

export interface MemoryRouteDeps {
  service: MemoryService;
  queue: MemoryJobQueue;
  /**
   * Pre-Phase 6 hourly budget (optional): links a derived user memory scope
   * to its owner so the memory WORKER can attribute DOLLAR-ONLY compaction
   * usage. Absent = legacy behavior (compaction not budget-attributable).
   */
  budgetHook?: {
    recordScopeOwner(scope: string, ownerId: string): Promise<void>;
  };
  logger?: SafeLogger;
}

export interface MemoryRouteHandlers {
  createBlock: RequestHandler;
  listBlocks: RequestHandler;
  search: RequestHandler;
  related: RequestHandler;
  retryEmbedding: RequestHandler;
  enqueueCompaction: RequestHandler;
}

/** Maps a thrown error to a safe fixed HTTP response; everything else → 503. */
export function memoryErrorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof MemoryValidationError) {
    return { status: 400, message: INVALID_MEMORY_REQUEST };
  }
  if (error instanceof MemoryNotFoundError) {
    return { status: 404, message: MEMORY_NOT_FOUND };
  }
  if (error instanceof MemoryConflictError) {
    return { status: 409, message: MEMORY_CONFLICT };
  }
  if (error instanceof MemoryQueueError) {
    return { status: 503, message: QUEUE_UNAVAILABLE };
  }
  // MemoryEmbeddingError / MemoryCompactionError / store / Prisma /
  // unexpected: the pipeline is broken, say so without leaking the cause.
  return { status: 503, message: SERVICE_UNAVAILABLE };
}

// ---------------------------------------------------------------------------
// GET query parsing: strings are mapped strictly, junk fails 400.
// ---------------------------------------------------------------------------

const KNOWN_QUERY_FIELDS = new Set(['scope', 'path', 'kind', 'keyword', 'includeSuperseded', 'limit']);
const INTEGER_STRING = /^-?\d+$/;

/**
 * Express `req.query` values can be string | string[] | nested ParsedQs.
 * Only plain string values are candidates; anything else is passed through
 * UNCHANGED so the strict schema rejects it (never joined or coerced).
 * `limit`: integer strings become numbers (schema still bounds 1..100).
 * `includeSuperseded`: exactly 'true'/'false' become booleans.
 * Unknown fields pass through so `strictObject` rejects them.
 */
export function parseBlocksQuery(query: Record<string, unknown>): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!KNOWN_QUERY_FIELDS.has(key)) {
      parsed[key] = value;
      continue;
    }
    if (key === 'limit') {
      parsed[key] =
        typeof value === 'string' && INTEGER_STRING.test(value) ? Number(value) : value;
      continue;
    }
    if (key === 'includeSuperseded') {
      parsed[key] = value === 'true' ? true : value === 'false' ? false : value;
      continue;
    }
    parsed[key] = value;
  }
  return parsed;
}

export function createMemoryRoutes(deps: MemoryRouteDeps): MemoryRouteHandlers {
  const { service, queue } = deps;
  const logger = deps.logger ?? undefined;

  /** Wrapper: memory errors map to fixed safe JSON; unknown → safe 503. */
  const handler = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => {
    return (req, res) => {
      void fn(req, res).catch((error: unknown) => {
        const mapped = memoryErrorStatus(error);
        logger?.error('memory-route-failure', error);
        res.status(mapped.status);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ error: mapped.message }));
      });
    };
  };

  const jsonResponse = (res: Response, status: number, body: unknown): void => {
    res.status(status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };

  /**
   * Owner-scoped memory: the forced scope is derived from the RESOLVED owner
   * (`userMemoryScope(owner.userId)` from `@workforce/core/auth`) and every
   * read/write/search/compaction runs inside it. A client-supplied `scope`
   * (body or query) is STRIPPED IN FULL before schema parsing — replaced,
   * never merged — so another user's scope name can never be targeted, no
   * other user's blocks can ever leak into a response, and a client cannot
   * even trip validation by naming a foreign scope. Unauthenticated reach
   * (impossible behind the app-wide owner middleware) is a 401.
   */
  const scopeOf = async (req: Request, res: Response): Promise<string | null> => {
    const owner = ownerOf(res);
    if (owner === null) {
      res.status(401);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Authentication required.' }));
      return null;
    }
    const scope = userMemoryScope(owner.userId);
    // Hourly-budget attribution: persist the scope → owner link
    // (idempotent) so the compaction worker can reserve dollar usage.
    if (deps.budgetHook !== undefined) {
      try {
        await deps.budgetHook.recordScopeOwner(scope, owner.userId);
      } catch (error) {
        logger?.error('memory-scope-owner-link', error);
      }
    }
    return scope;
  };

  /** Removes the client-supplied `scope` before schema parsing (ignore). */
  const withoutClientScope = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }
    const { scope: _ignored, ...rest } = value as Record<string, unknown>;
    return rest;
  };

  // -- POST /api/memory/blocks -------------------------------------------------

  const createBlock: RequestHandler = handler(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (scope === null) {
      return;
    }
    const input = parseMemoryInput(writeBlockInputSchema, {
      ...(withoutClientScope(req.body) as Record<string, unknown>),
      scope,
    });
    const block = await service.writeBlock(input);
    jsonResponse(res, 201, { block });
  });

  // -- GET /api/memory/blocks ---------------------------------------------------

  const listBlocks: RequestHandler = handler(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (scope === null) {
      return;
    }
    const queryWithoutScope = withoutClientScope(req.query as Record<string, unknown>) as Record<string, unknown>;
    const input = parseMemoryInput(queryBlocksInputSchema, {
      ...parseBlocksQuery(queryWithoutScope),
      scope,
    });
    const blocks = await service.queryBlocks(input);
    jsonResponse(res, 200, { blocks });
  });

  // -- POST /api/memory/search --------------------------------------------------

  const search: RequestHandler = handler(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (scope === null) {
      return;
    }
    const input = parseMemoryInput(semanticSearchInputSchema, {
      ...(withoutClientScope(req.body) as Record<string, unknown>),
      scope,
    });
    const results: readonly MemorySearchResult[] = await service.semanticSearch(input);
    jsonResponse(res, 200, { results });
  });

  // -- GET /api/memory/blocks/:id/related ---------------------------------------

  const related: RequestHandler = handler(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (scope === null) {
      return;
    }
    const id = parseMemoryInput(memoryIdSchema, req.params['id']);
    const result = await requireOwnerBlock(service.exploreRelated(id), scope);
    const outgoing = result.outgoing.filter((entry) => entry.block.scope === scope);
    const incoming = result.incoming.filter((entry) => entry.block.scope === scope);
    jsonResponse(res, 200, { block: result.block, outgoing, incoming });
  });

  // -- POST /api/memory/blocks/:id/retry ----------------------------------------

  const retryEmbedding: RequestHandler = handler(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (scope === null) {
      return;
    }
    const id = parseMemoryInput(memoryIdSchema, req.params['id']);
    // Read-only ownership check first: a foreign/legacy-scope id reads as the
    // same fixed 404 and never reveals existence or embedding state.
    const existing = await requireOwnerBlock(service.exploreRelated(id), scope);
    if (existing.block.embeddingStatus === 'ready') {
      throw new MemoryConflictError('memory block embedding is already ready');
    }
    try {
      await queue.enqueueEmbedding(id);
    } catch (cause) {
      throw new MemoryQueueError('failed to requeue embedding job', { cause });
    }
    // Note: a `failed` block stays `failed` until a worker actually succeeds;
    // the 202 says the job was queued, nothing more.
    jsonResponse(res, 202, { status: 'queued', blockId: existing.block.id });
  });

  // -- POST /api/memory/compact ---------------------------------------------------

  const enqueueCompaction: RequestHandler = handler(async (req, res) => {
    const scope = await scopeOf(req, res);
    if (scope === null) {
      return;
    }
    const input = parseMemoryInput(compactPathInputSchema, {
      ...(withoutClientScope(req.body) as Record<string, unknown>),
      scope,
    });
    // The client scope is stripped in full: compaction only ever runs on the
    // forced owner scope.
    const triggerBlockId = randomUUID();
    try {
      await queue.enqueueCompaction(scope, input.path, triggerBlockId);
    } catch (cause) {
      throw new MemoryQueueError('failed to enqueue compaction job', { cause });
    }
    jsonResponse(res, 202, { status: 'queued', scope, path: input.path, triggerBlockId });
  });

  return { createBlock, listBlocks, search, related, retryEmbedding, enqueueCompaction };
}

/**
 * Ownership filter on an unscoped block read (`exploreRelated` is id-only in
 * the core contract): a block from another scope (another user's private
 * scope, or any legacy/anonymous scope like `default`) reads as typed 404 —
 * never an existence oracle, never content exposure.
 */
async function requireOwnerBlock(
  read: Promise<MemoryRelatedResult>,
  expectedScope: string,
): Promise<MemoryRelatedResult> {
  const result = await read;
  if (result.block.scope !== expectedScope) {
    throw new MemoryNotFoundError(`memory block not found in the caller's scope`);
  }
  return result;
}
