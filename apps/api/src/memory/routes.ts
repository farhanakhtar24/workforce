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
import type { SafeLogger } from '../logging.js';

export const INVALID_MEMORY_REQUEST = 'Invalid memory request.';
export const MEMORY_NOT_FOUND = 'Memory block not found.';
export const MEMORY_CONFLICT = 'Memory conflict.';
export const QUEUE_UNAVAILABLE = 'Memory queue is temporarily unavailable.';
export const SERVICE_UNAVAILABLE = 'Memory service is temporarily unavailable.';

export interface MemoryRouteDeps {
  service: MemoryService;
  queue: MemoryJobQueue;
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

  // -- POST /api/memory/blocks -------------------------------------------------

  const createBlock: RequestHandler = handler(async (req, res) => {
    const input = parseMemoryInput(writeBlockInputSchema, req.body);
    const block = await service.writeBlock(input);
    jsonResponse(res, 201, { block });
  });

  // -- GET /api/memory/blocks ---------------------------------------------------

  const listBlocks: RequestHandler = handler(async (req, res) => {
    const input = parseMemoryInput(queryBlocksInputSchema, parseBlocksQuery(req.query as Record<string, unknown>));
    const blocks = await service.queryBlocks(input);
    jsonResponse(res, 200, { blocks });
  });

  // -- POST /api/memory/search --------------------------------------------------

  const search: RequestHandler = handler(async (req, res) => {
    const input = parseMemoryInput(semanticSearchInputSchema, req.body);
    const results: readonly MemorySearchResult[] = await service.semanticSearch(input);
    jsonResponse(res, 200, { results });
  });

  // -- GET /api/memory/blocks/:id/related ---------------------------------------

  const related: RequestHandler = handler(async (req, res) => {
    const id = parseMemoryInput(memoryIdSchema, req.params['id']);
    const result: MemoryRelatedResult = await service.exploreRelated(id);
    jsonResponse(res, 200, { block: result.block, outgoing: result.outgoing, incoming: result.incoming });
  });

  // -- POST /api/memory/blocks/:id/retry ----------------------------------------

  const retryEmbedding: RequestHandler = handler(async (req, res) => {
    const id = parseMemoryInput(memoryIdSchema, req.params['id']);
    // Read-only existence check: exploreRelated throws NotFound when missing.
    const existing = await service.exploreRelated(id);
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
    const input = parseMemoryInput(compactPathInputSchema, req.body);
    const triggerBlockId = randomUUID();
    try {
      await queue.enqueueCompaction(input.scope, input.path, triggerBlockId);
    } catch (cause) {
      throw new MemoryQueueError('failed to enqueue compaction job', { cause });
    }
    jsonResponse(res, 202, { status: 'queued', scope: input.scope, path: input.path, triggerBlockId });
  });

  return { createBlock, listBlocks, search, related, retryEmbedding, enqueueCompaction };
}
