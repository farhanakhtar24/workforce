/**
 * Pure, testable request/response helpers for the `/memory` workspace.
 *
 * Contract source of truth: Phase 3 memory REST routes (docs/phases/phase-3-memory.md
 * and `apps/api/src/http/routes.ts`):
 * - POST /api/memory/blocks              201 { block }
 * - GET  /api/memory/blocks              200 { blocks } — filters omit when empty
 * - POST /api/memory/search              200 { results } — score = 0.8·cosine + 0.2·recency
 * - GET  /api/memory/blocks/:id/related  200 { block, outgoing, incoming }
 * - POST /api/memory/blocks/:id/retry    202 { status: 'queued', blockId } — 409 when ready
 * - POST /api/memory/compact             202 { status: 'queued', scope, path, triggerBlockId }
 *
 * Memory blocks are metadata only: public fields never include embedding
 * vectors, and the validators below reject any payload that carries one.
 */

/** The six fixed memory kinds (ADR-003). */
export const MEMORY_KINDS = [
  'learning',
  'correction',
  'changelog',
  'observation',
  'decision',
  'preference',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Write lifecycle: pending → ready | failed. Only `ready` enters search. */
export const EMBEDDING_STATUSES = ['pending', 'ready', 'failed'] as const;
export type EmbeddingStatus = (typeof EMBEDDING_STATUSES)[number];

/** Typed relations between blocks (superseding is a `supersedes` relation). */
export const RELATION_TYPES = ['supports', 'supersedes', 'contradicts'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface MemoryBlock {
  id: string;
  scope: string;
  path: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  embeddingStatus: EmbeddingStatus;
  embeddingModel: string | null;
  accessCount: number;
  supersededById: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string | null;
  embeddedAt: string | null;
  lastAccessedAt: string | null;
}

export interface MemoryRelation {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationType;
  createdAt: string;
}

export interface RelatedBlocks {
  block: MemoryBlock;
  outgoing: Array<{ relation: MemoryRelation; block: MemoryBlock }>;
  incoming: Array<{ relation: MemoryRelation; block: MemoryBlock }>;
}

export interface SearchResultItem {
  block: MemoryBlock;
  cosineSimilarity: number;
  recencyScore: number;
  score: number;
}

export interface RetryQueued {
  status: 'queued';
  blockId: string;
}

export interface CompactQueued {
  status: 'queued';
  scope: string;
  path: string;
  triggerBlockId: string;
}

/**
 * Same base-URL resolution the chat client uses (kept local so the memory
 * helpers stay dependency-free).
 */
export const API_BASE_URL_DEFAULT = 'http://localhost:3001';

export function resolveApiBaseUrl(envValue: string | undefined): string {
  const trimmed = envValue?.trim();
  if (!trimmed) return API_BASE_URL_DEFAULT;
  return trimmed.replace(/\/+$/, '');
}

/** Memory-route endpoint builders. Ids are UUIDs and are always encoded. */
export function memoryBlocksEndpoint(apiBaseUrl: string, query?: string): string {
  return `${apiBaseUrl}/api/memory/blocks${query ?? ''}`;
}

export function memorySearchEndpoint(apiBaseUrl: string): string {
  return `${apiBaseUrl}/api/memory/search`;
}

export function memoryRelatedEndpoint(apiBaseUrl: string, blockId: string): string {
  return `${apiBaseUrl}/api/memory/blocks/${encodeURIComponent(blockId)}/related`;
}

export function memoryRetryEndpoint(apiBaseUrl: string, blockId: string): string {
  return `${apiBaseUrl}/api/memory/blocks/${encodeURIComponent(blockId)}/retry`;
}

export function memoryCompactEndpoint(apiBaseUrl: string): string {
  return `${apiBaseUrl}/api/memory/compact`;
}

/* ------------------------------------------------------------------ */
/* Bounded lengths (client-side friction; the API re-validates).       */
/* ------------------------------------------------------------------ */

export const SCOPE_MAX_LENGTH = 100;
export const PATH_MAX_LENGTH = 200;
export const KEYWORD_MAX_LENGTH = 100;
export const QUERY_MAX_LENGTH = 1000;
/** Fixed content bound from the phase-3 design: plain text, 1..1000 chars. */
export const CONTENT_MAX_LENGTH = 1000;
/** The browse-panel limit options; anything else collapses to omitted. */
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;

/** UUID shape used by block ids and `supersedesId` (any RFC-4122 variant). */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBlockId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return (
    typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
  );
}

export function isEmbeddingStatus(value: unknown): value is EmbeddingStatus {
  return (
    typeof value === 'string' &&
    (EMBEDDING_STATUSES as readonly string[]).includes(value)
  );
}

export function isRelationType(value: unknown): value is RelationType {
  return (
    typeof value === 'string' && (RELATION_TYPES as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/* GET /api/memory/blocks — query-string mapping                       */
/* ------------------------------------------------------------------ */

export interface BlocksFilterInput {
  scope?: string;
  path?: string;
  kind?: string;
  keyword?: string;
  includeSuperseded?: boolean;
  limit?: number;
}

/**
 * Builds the encoded query string for GET /api/memory/blocks. Empty filters
 * (missing, blank after trim) are omitted entirely, `includeSuperseded` only
 * appears when true, and an out-of-range/non-integer `limit` is omitted (the
 * API then applies its default of 20). Path prefix filters are passed as
 * typed — the API owns prefix/semantics.
 */
export function buildBlocksQuery(filters: BlocksFilterInput): string {
  const params = new URLSearchParams();
  const text = (value: string | undefined, key: string): void => {
    const trimmed = value?.trim();
    if (trimmed) params.set(key, trimmed);
  };
  text(filters.scope, 'scope');
  text(filters.path, 'path');
  if (isMemoryKind(filters.kind)) params.set('kind', filters.kind);
  text(filters.keyword, 'keyword');
  if (filters.includeSuperseded === true) params.set('includeSuperseded', 'true');
  if (
    typeof filters.limit === 'number' &&
    Number.isInteger(filters.limit) &&
    filters.limit >= LIMIT_MIN &&
    filters.limit <= LIMIT_MAX
  ) {
    params.set('limit', String(filters.limit));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

/* ------------------------------------------------------------------ */
/* POST /api/memory/blocks — body mapping + validation                 */
/* ------------------------------------------------------------------ */

export interface CreateBlockFormInput {
  scope: string;
  path: string;
  kind: string;
  content: string;
  confidence: string | number;
  supersedesId?: string;
}

export type CreateBlockBodyResult =
  | { ok: true; body: CreateBlockBody }
  | { ok: false; error: string };

export interface CreateBlockBody {
  scope: string;
  path: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  supersedesId?: string;
}

/**
 * Validates and maps the create form into the exact POST body. Defaults:
 * scope `default`, confidence `0.8`. `supersedesId` is only included when a
 * syntactically valid UUID is supplied. Everything else becomes one safe,
 * field-naming message (never an echo of the raw value).
 */
export function buildCreateBlockBody(input: CreateBlockFormInput): CreateBlockBodyResult {
  const scope = input.scope.trim();
  if (!scope) return fail('Scope is required (defaults to "default").');
  if (scope.length > SCOPE_MAX_LENGTH) {
    return fail(`Scope must be at most ${SCOPE_MAX_LENGTH} characters.`);
  }

  const path = input.path.trim();
  if (!path) return fail('Path is required, e.g. research/small-language-models.');
  if (path.length > PATH_MAX_LENGTH) {
    return fail(`Path must be at most ${PATH_MAX_LENGTH} characters.`);
  }

  if (!isMemoryKind(input.kind)) return fail('Choose a memory kind from the list.');

  const content = input.content.trim();
  if (!content) return fail('Content is required.');
  if (content.length > CONTENT_MAX_LENGTH) {
    return fail(`Content must be at most ${CONTENT_MAX_LENGTH} characters.`);
  }

  const confidence =
    typeof input.confidence === 'number' ? input.confidence : Number(input.confidence);
  if (
    input.confidence === '' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return fail('Confidence must be a number between 0 and 1.');
  }

  const rawSupersedes = input.supersedesId?.trim() ?? '';
  let supersedesId: string | undefined;
  if (rawSupersedes) {
    if (!UUID_PATTERN.test(rawSupersedes)) {
      return fail('Supersedes ID must be a block UUID.');
    }
    supersedesId = rawSupersedes;
  }

  return {
    ok: true,
    body: {
      scope,
      path,
      kind: input.kind,
      content,
      confidence,
      ...(supersedesId !== undefined ? { supersedesId } : {}),
    },
  };
}

function fail(error: string): CreateBlockBodyResult {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* POST /api/memory/search — body mapping                              */
/* ------------------------------------------------------------------ */

export interface SearchFormInput {
  query: string;
  path?: string;
  kind?: string;
  limit?: number;
}

export type SearchBodyResult =
  | { ok: true; body: SearchBody }
  | { ok: false; error: string };

export interface SearchBody {
  query: string;
  path?: string;
  kind?: MemoryKind;
  limit?: number;
}

/**
 * Exact `{ query, scope?, path?, kind?, limit? }` wire body; empty optionals
 * are omitted, `limit` must be an integer within bounds to be included, and
 * `kind` only when it is one of the six fixed kinds.
 */
export function buildSearchBody(input: SearchFormInput): SearchBodyResult {
  const query = input.query.trim();
  if (!query) return { ok: false, error: 'Search query is required.' };
  if (query.length > QUERY_MAX_LENGTH) {
    return { ok: false, error: `Query must be at most ${QUERY_MAX_LENGTH} characters.` };
  }

  const path = input.path?.trim();
  const body: SearchBody = { query };
  if (path) body.path = path;
  if (isMemoryKind(input.kind)) body.kind = input.kind;
  if (
    typeof input.limit === 'number' &&
    Number.isInteger(input.limit) &&
    input.limit >= LIMIT_MIN &&
    input.limit <= LIMIT_MAX
  ) {
    body.limit = input.limit;
  }
  return { ok: true, body };
}

/* ------------------------------------------------------------------ */
/* Compaction expectation gate (client-side only)                      */
/* ------------------------------------------------------------------ */

/** A compaction needs an intentional, >30-char expectation note. */
export const COMPACT_EXPECTATION_MIN_LENGTH = 30;

export function isValidCompactExpectation(text: string): boolean {
  return text.trim().length > COMPACT_EXPECTATION_MIN_LENGTH;
}

/* ------------------------------------------------------------------ */
/* Polling predicate                                                   */
/* ------------------------------------------------------------------ */

/**
 * Poll the open browse list only while at least one rendered block is still
 * `pending` (waiting for its embedding). Ready-only, failed-only, empty and
 * superseded-only lists all return false — polling must stop there.
 */
export function hasPendingBlocks(blocks: readonly MemoryBlock[]): boolean {
  return blocks.some((block) => block.embeddingStatus === 'pending');
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** `0.8` → `"80%"`; anything non-finite/out of range renders as `(n/a)`. */
export function formatConfidence(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 1) return '(n/a)';
  return `${Math.round(value * 100)}%`;
}

/** Fixed 3-decimal display for cosine/recency/score; safe for any junk. */
export function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '(n/a)';
  return value.toFixed(3);
}

/**
 * Deterministic UTC timestamp: `2026-11-19 14:05 UTC`. `null` (never
 * embedded / never accessed) and unparseable strings become fixed text.
 */
export function formatDateTime(
  value: string | null | undefined,
  fallback = '(not set)',
): string {
  if (value === null || value === undefined) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '(unknown)';
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Truncation for card summaries; same convention as chat tool text. */
export const MEMORY_TEXT_LIMIT = 240;

export function truncateMemoryText(value: string, limit = MEMORY_TEXT_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/* ------------------------------------------------------------------ */
/* Safe errors                                                         */
/* ------------------------------------------------------------------ */

export const MEMORY_ERROR_FALLBACK = 'Something went wrong. Please try again.';
export const MEMORY_LIST_ERROR = 'Memory list is temporarily unavailable. Refresh to retry.';
export const MEMORY_CREATE_ERROR = 'Block could not be created. Try again.';
export const MEMORY_SEARCH_ERROR = 'Memory search is temporarily unavailable. Try again.';
export const MEMORY_RELATED_ERROR = 'Related blocks are temporarily unavailable. Try again.';
export const MEMORY_RETRY_ERROR = 'Retry could not be queued. Try again.';
export const MEMORY_COMPACT_ERROR = 'Compaction could not be queued. Check the path and try again.';

/**
 * Errors are always safe JSON `{"error": "<message>"}`. Pull the fixed API
 * message out; anything else (non-JSON, missing/empty/non-string field) gets
 * the fixed fallback. Raw payloads, stacks and internals never surface.
 */
export function extractApiErrorMessage(raw: unknown, fallback: string): string {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    'error' in raw &&
    typeof (raw as { error: unknown }).error === 'string' &&
    (raw as { error: string }).error.length > 0
  ) {
    return (raw as { error: string }).error;
  }
  return fallback;
}

/**
 * Minimal fetch surface shared by every memory call (a real browser `fetch`
 * satisfies it; tests pass stubs). `status` is optional so stubs stay short.
 */
export interface MemoryFetch {
  (
    input: string,
    init?: {
      method?: 'GET' | 'POST';
      cache?: 'no-store';
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
}

export type MemoryRequestResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: string };

/**
 * One JSON request helper: never throws, `no-store` always, JSON in/out.
 * Non-OK responses and parse failures collapse to the fixed fallback unless
 * the body carries the documented safe `{ error }` message.
 */
export async function requestMemoryJson(options: {
  url: string;
  method: 'GET' | 'POST';
  body?: unknown;
  fallbackError: string;
  fetchImpl?: MemoryFetch;
}): Promise<MemoryRequestResult> {
  const { url, method, body, fallbackError, fetchImpl = browserApiFetch } = options;
  const init: NonNullable<Parameters<MemoryFetch>[1]> = {
    method,
    cache: 'no-store',
    headers: { accept: 'application/json' },
  };
  if (method === 'POST' && body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    try {
      init.body = JSON.stringify(body);
    } catch {
      return { ok: false, error: fallbackError };
    }
  }
  try {
    const response = await fetchImpl(url, init);
    let raw: unknown = null;
    try {
      raw = await response.json();
    } catch {
      if (response.ok) return { ok: false, error: fallbackError };
      raw = null;
    }
    if (response.ok) return { ok: true, status: response.status ?? 0, body: raw };
    const authError = requestAuthError(response.status ?? 0);
    if (authError !== null) return { ok: false, error: authError };
    return {
      ok: false,
      error: extractApiErrorMessage(raw, fallbackError),
    };
  } catch {
    return { ok: false, error: fallbackError };
  }
}

/* ------------------------------------------------------------------ */
/* Response validation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Keys that must never appear on a public block: embedding vectors stay
 * server-side. Any payload carrying one is rejected wholesale.
 */
const FORBIDDEN_VECTOR_KEYS = ['embedding', 'embeddings', 'vector', 'embeddingVector'] as const;

import { browserApiFetch, requestAuthError } from './api';
export type MemoryResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestampOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * Shallow structural check of one MemoryBlock. Rejects non-plain objects,
 * wrong-typed required fields and — deliberately — any block that still
 * carries an embedding/vector key.
 */
export function mapMemoryBlock(raw: unknown): MemoryResult<MemoryBlock> {
  if (!isPlainObject(raw)) return { ok: false, error: MEMORY_ERROR_FALLBACK };
  for (const key of FORBIDDEN_VECTOR_KEYS) {
    if (key in raw) return { ok: false, error: MEMORY_ERROR_FALLBACK };
  }
  const b = raw as Record<string, unknown>;
  const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

  if (
    !str(b.id) ||
    !str(b.scope) ||
    !str(b.path) ||
    !str(b.content) ||
    !isMemoryKind(b.kind) ||
    !isEmbeddingStatus(b.embeddingStatus) ||
    typeof b.confidence !== 'number' ||
    !Number.isFinite(b.confidence) ||
    b.confidence < 0 ||
    b.confidence > 1 ||
    (b.embeddingModel !== null && typeof b.embeddingModel !== 'string') ||
    typeof b.accessCount !== 'number' ||
    !Number.isFinite(b.accessCount) ||
    b.accessCount < 0 ||
    (b.supersededById !== null && typeof b.supersededById !== 'string') ||
    !isPlainObject(b.metadata) ||
    !str(b.createdAt) ||
    !isTimestampOrNull(b.updatedAt) ||
    !isTimestampOrNull(b.embeddedAt) ||
    !isTimestampOrNull(b.lastAccessedAt)
  ) {
    return { ok: false, error: MEMORY_ERROR_FALLBACK };
  }
  return {
    ok: true,
    value: {
      id: b.id,
      scope: b.scope,
      path: b.path,
      kind: b.kind,
      content: b.content,
      confidence: b.confidence,
      embeddingStatus: b.embeddingStatus,
      embeddingModel: b.embeddingModel,
      accessCount: b.accessCount,
      supersededById: b.supersededById,
      metadata: b.metadata,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      embeddedAt: b.embeddedAt,
      lastAccessedAt: b.lastAccessedAt,
    },
  };
}

function mapRelation(raw: unknown): MemoryResult<MemoryRelation> {
  if (!isPlainObject(raw)) return { ok: false, error: MEMORY_ERROR_FALLBACK };
  const r = raw as Record<string, unknown>;
  const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  if (!str(r.id) || !str(r.sourceId) || !str(r.targetId) || !isRelationType(r.type) || !str(r.createdAt)) {
    return { ok: false, error: MEMORY_ERROR_FALLBACK };
  }
  return {
    ok: true,
    value: { id: r.id, sourceId: r.sourceId, targetId: r.targetId, type: r.type, createdAt: r.createdAt },
  };
}

function blocksPayloadError(error: string): MemoryResult<never> {
  return { ok: false, error };
}

/* GET /api/memory/blocks → { blocks } */
export function mapBlocksResponse(raw: unknown, error = MEMORY_LIST_ERROR): MemoryResult<MemoryBlock[]> {
  if (!isPlainObject(raw) || !Array.isArray(raw.blocks)) return blocksPayloadError(error);
  const blocks: MemoryBlock[] = [];
  for (const entry of raw.blocks) {
    const mapped = mapMemoryBlock(entry);
    if (!mapped.ok) return blocksPayloadError(error);
    blocks.push(mapped.value);
  }
  return { ok: true, value: blocks };
}

/* POST /api/memory/blocks → { block } */
export function mapCreateResponse(raw: unknown, error = MEMORY_CREATE_ERROR): MemoryResult<MemoryBlock> {
  if (!isPlainObject(raw)) return blocksPayloadError(error);
  return mapMemoryBlock(raw.block);
}

/* POST /api/memory/search → { results } */
export function mapSearchResponse(raw: unknown, error = MEMORY_SEARCH_ERROR): MemoryResult<SearchResultItem[]> {
  if (!isPlainObject(raw) || !Array.isArray(raw.results)) return blocksPayloadError(error);
  const results: SearchResultItem[] = [];
  for (const entry of raw.results) {
    if (!isPlainObject(entry)) return blocksPayloadError(error);
    const block = mapMemoryBlock(entry.block);
    if (!block.ok) return blocksPayloadError(error);
    const cosine = (entry as Record<string, unknown>).cosineSimilarity;
    const recency = (entry as Record<string, unknown>).recencyScore;
    const score = (entry as Record<string, unknown>).score;
    if (
      typeof cosine !== 'number' || !Number.isFinite(cosine) ||
      typeof recency !== 'number' || !Number.isFinite(recency) ||
      typeof score !== 'number' || !Number.isFinite(score)
    ) {
      return blocksPayloadError(error);
    }
    results.push({ block: block.value, cosineSimilarity: cosine, recencyScore: recency, score });
  }
  return { ok: true, value: results };
}

/* GET /api/memory/blocks/:id/related → { block, outgoing, incoming } */
export function mapRelatedResponse(raw: unknown, error = MEMORY_RELATED_ERROR): MemoryResult<RelatedBlocks> {
  if (!isPlainObject(raw) || !Array.isArray(raw.outgoing) || !Array.isArray(raw.incoming)) {
    return blocksPayloadError(error);
  }
  const block = mapMemoryBlock(raw.block);
  if (!block.ok) return blocksPayloadError(error);
  const edge = (
    entry: unknown,
  ): MemoryResult<{ relation: MemoryRelation; block: MemoryBlock }> => {
    if (!isPlainObject(entry)) return blocksPayloadError(error);
    const relation = mapRelation((entry as Record<string, unknown>).relation);
    if (!relation.ok) return blocksPayloadError(error);
    const neighbor = mapMemoryBlock((entry as Record<string, unknown>).block);
    if (!neighbor.ok) return blocksPayloadError(error);
    return { ok: true, value: { relation: relation.value, block: neighbor.value } };
  };
  const outgoing = [];
  for (const entry of raw.outgoing) {
    const mapped = edge(entry);
    if (!mapped.ok) return blocksPayloadError(error);
    outgoing.push(mapped.value);
  }
  const incoming = [];
  for (const entry of raw.incoming) {
    const mapped = edge(entry);
    if (!mapped.ok) return blocksPayloadError(error);
    incoming.push(mapped.value);
  }
  return { ok: true, value: { block: block.value, outgoing, incoming } };
}

/* POST /api/memory/blocks/:id/retry → { status: 'queued', blockId } */
export function mapRetryResponse(raw: unknown, error = MEMORY_RETRY_ERROR): MemoryResult<RetryQueued> {
  if (!isPlainObject(raw) || raw.status !== 'queued' || typeof raw.blockId !== 'string' || raw.blockId.length === 0) {
    return blocksPayloadError(error);
  }
  return { ok: true, value: { status: 'queued', blockId: raw.blockId } };
}

/* POST /api/memory/compact → { status, scope, path, triggerBlockId } */
export function mapCompactResponse(raw: unknown, error = MEMORY_COMPACT_ERROR): MemoryResult<CompactQueued> {
  if (
    !isPlainObject(raw) ||
    raw.status !== 'queued' ||
    typeof raw.scope !== 'string' ||
    typeof raw.path !== 'string' ||
    typeof raw.triggerBlockId !== 'string' ||
    raw.triggerBlockId.length === 0
  ) {
    return blocksPayloadError(error);
  }
  return {
    ok: true,
    value: { status: 'queued', scope: raw.scope, path: raw.path, triggerBlockId: raw.triggerBlockId },
  };
}

/* ------------------------------------------------------------------ */
/* One-call orchestration per endpoint                                 */
/* ------------------------------------------------------------------ */

export type BlocksFetchResult =
  | { ok: true; blocks: MemoryBlock[] }
  | { ok: false; error: string };

export async function fetchMemoryBlocks(options: {
  apiBaseUrl: string;
  filters: BlocksFilterInput;
  fetchImpl?: MemoryFetch;
}): Promise<BlocksFetchResult> {
  const { apiBaseUrl, filters, fetchImpl } = options;
  const url = memoryBlocksEndpoint(apiBaseUrl, buildBlocksQuery(filters));
  const result = await requestMemoryJson({
    url,
    method: 'GET',
    fallbackError: MEMORY_LIST_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapBlocksResponse(result.body);
  return mapped.ok ? { ok: true, blocks: mapped.value } : mapped;
}

export type CreateBlockResult =
  | { ok: true; block: MemoryBlock }
  | { ok: false; error: string };

export async function createMemoryBlock(options: {
  apiBaseUrl: string;
  input: CreateBlockFormInput;
  fetchImpl?: MemoryFetch;
}): Promise<CreateBlockResult> {
  const { apiBaseUrl, input, fetchImpl } = options;
  const body = buildCreateBlockBody(input);
  if (!body.ok) return body;
  const result = await requestMemoryJson({
    url: memoryBlocksEndpoint(apiBaseUrl),
    method: 'POST',
    body: body.body,
    fallbackError: MEMORY_CREATE_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapCreateResponse(result.body);
  return mapped.ok ? { ok: true, block: mapped.value } : mapped;
}

export type SearchFetchResult =
  | { ok: true; results: SearchResultItem[] }
  | { ok: false; error: string };

export async function searchMemoryBlocks(options: {
  apiBaseUrl: string;
  input: SearchFormInput;
  fetchImpl?: MemoryFetch;
}): Promise<SearchFetchResult> {
  const { apiBaseUrl, input, fetchImpl } = options;
  const body = buildSearchBody(input);
  if (!body.ok) return body;
  const result = await requestMemoryJson({
    url: memorySearchEndpoint(apiBaseUrl),
    method: 'POST',
    body: body.body,
    fallbackError: MEMORY_SEARCH_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapSearchResponse(result.body);
  return mapped.ok ? { ok: true, results: mapped.value } : mapped;
}

export type RelatedFetchResult =
  | { ok: true; related: RelatedBlocks }
  | { ok: false; error: string };

export async function fetchRelatedBlocks(options: {
  apiBaseUrl: string;
  blockId: string;
  fetchImpl?: MemoryFetch;
}): Promise<RelatedFetchResult> {
  const { apiBaseUrl, blockId, fetchImpl } = options;
  if (!isBlockId(blockId)) return { ok: false, error: MEMORY_RELATED_ERROR };
  const result = await requestMemoryJson({
    url: memoryRelatedEndpoint(apiBaseUrl, blockId),
    method: 'GET',
    fallbackError: MEMORY_RELATED_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapRelatedResponse(result.body);
  return mapped.ok ? { ok: true, related: mapped.value } : mapped;
}

export type RetryResult =
  | { ok: true; retry: RetryQueued }
  | { ok: false; error: string };

export async function retryBlockEmbedding(options: {
  apiBaseUrl: string;
  blockId: string;
  fetchImpl?: MemoryFetch;
}): Promise<RetryResult> {
  const { apiBaseUrl, blockId, fetchImpl } = options;
  if (!isBlockId(blockId)) return { ok: false, error: MEMORY_RETRY_ERROR };
  const result = await requestMemoryJson({
    url: memoryRetryEndpoint(apiBaseUrl, blockId),
    method: 'POST',
    fallbackError: MEMORY_RETRY_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapRetryResponse(result.body);
  return mapped.ok ? { ok: true, retry: mapped.value } : mapped;
}

export type CompactResult =
  | { ok: true; compact: CompactQueued }
  | { ok: false; error: string };

export async function compactMemoryPath(options: {
  apiBaseUrl: string;
  scope: string;
  path: string;
  fetchImpl?: MemoryFetch;
}): Promise<CompactResult> {
  const { apiBaseUrl, scope, path, fetchImpl } = options;
  if (!scope.trim() || !path.trim()) {
    return { ok: false, error: MEMORY_COMPACT_ERROR };
  }
  const result = await requestMemoryJson({
    url: memoryCompactEndpoint(apiBaseUrl),
    method: 'POST',
    body: { scope: scope.trim(), path: path.trim() },
    fallbackError: MEMORY_COMPACT_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapCompactResponse(result.body);
  return mapped.ok ? { ok: true, compact: mapped.value } : mapped;
}
