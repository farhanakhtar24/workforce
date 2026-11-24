/**
 * Server-proxied model catalog for the configured Ollama cloud origin.
 *
 * The catalog NEVER exposes the API key or any account-level information:
 * - `list()` calls the official `GET <origin>/api/tags` with a bounded
 *   timeout, caches the parsed + bounded result for 60 s (single-flight on
 *   miss), and maps failures to {@link ModelCatalogUnavailableError} (route:
 *   fixed 503).
 * - `details()` calls the official `POST <origin>/api/show` with the model id,
 *   caches per model id for 6 hours, bounds concurrent upstream calls with a
 *   fixed-slot semaphore, and extracts ONLY actual fields (never guessed):
 *   `contextLength` from a `model_info` key whose suffix is
 *   `.context_length`, plus `capabilities` / `parameterSize` / `thinking`
 *   when the response carries them — otherwise `null`.
 *
 * Model ids are validated server-side with
 * {@link MODEL_ID_PATTERN} (`^[A-Za-z0-9._:-]{1,80}$`).
 */
import type { ApiConfig } from '../config.js';

/** Exact model-id contract (bounded, no quotes/slashes/whitespace). */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

/** Fixed, value-free lock reason for blocked model ids (never echoes input). */
export const MODEL_LOCK_REASON = 'Model id is blocked by WORKFORCE_BLOCKED_MODEL_PREFIXES.';

/** True when `modelId` matches any blocked prefix, case-insensitive. */
export function isBlockedModelId(modelId: string, prefixes: readonly string[]): boolean {
  if (typeof modelId !== 'string') {
    return false;
  }
  const lower = modelId.toLowerCase();
  return prefixes.some((prefix) => lower.startsWith(prefix));
}

export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

/** One bounded catalog row (locked rows still surface; selection rejects). */
export interface ModelCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly modifiedAt: string | null;
  readonly capabilities: readonly string[];
  readonly parameterSize: string | null;
  readonly locked: boolean;
  readonly lockReason: string | null;
}

/** Model details from the official show endpoint; absent stats stay `null`. */
export interface ModelDetails {
  readonly contextLength: number | null;
  readonly capabilities: readonly string[] | null;
  readonly parameterSize: string | null;
  readonly thinking: boolean | null;
}

/** Catalog failure → route answers the fixed safe 503. */
export class ModelCatalogUnavailableError extends Error {
  constructor() {
    super('Model catalog is temporarily unavailable.');
    this.name = 'ModelCatalogUnavailableError';
  }
}

/** Minimal structural surface (the real catalog satisfies it; tests fake it). */
export interface ModelCatalogLike {
  list(): Promise<{ readonly models: readonly ModelCatalogEntry[] }>;
  /** `'not-found'` = the upstream show endpoint answered a model miss. */
  details(modelId: string): Promise<{ status: 'ok' | 'not-found'; details?: ModelDetails }>;
}

/** Minimal bounded fetch (global fetch satisfies it; tests record). */
export type CatalogFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ModelCatalogOptions {
  /** OLLAMA_BASE_URL from config; the cloud origin is derived from it. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly blockedPrefixes: readonly string[];
  /** Injectable fetch (tests); default globalThis.fetch. */
  readonly fetchFn?: CatalogFetch;
  /** Injectable epoch-ms clock (tests). */
  readonly now?: () => number;
  /** Bounded upstream call budgets (ms). */
  readonly listTimeoutMs?: number;
  readonly detailsTimeoutMs?: number;
}

/** Cache TTLs (documented): list 60 s, show details 6 h. */
export const MODEL_LIST_TTL_MS = 60_000;
export const MODEL_DETAILS_TTL_MS = 6 * 60 * 60 * 1000;
/** Bounded concurrent upstream `show` calls; the rest queue behind them. */
export const MODEL_DETAILS_CONCURRENCY = 4;

/** One semaphore slot controller for the bounded-concurrency `show` calls. */
class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (this.running < MODEL_DETAILS_CONCURRENCY) {
      this.running += 1;
      return () => {
        this.running -= 1;
        const next = this.queue.shift();
        if (next !== undefined) {
          next();
        }
      };
    }
    return await new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.running += 1;
        resolve(() => {
          this.running -= 1;
          const next2 = this.queue.shift();
          if (next2 !== undefined) {
            next2();
          }
        });
      });
    });
  }
}

function catalogOrigin(baseUrl: string): string {
  // config validates baseUrl as an http(s) URL; the origin carries no path,
  // so the official /api/* endpoints are composed safely from it.
  return new URL(baseUrl).origin;
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const safe = safeString;

function safeCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function safeCapabilitiesOrNull(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Parses one /api/tags row into a bounded entry (skips unusable rows). */
function parseTagRow(row: unknown, blockedPrefixes: readonly string[]): ModelCatalogEntry | null {
  if (row === null || typeof row !== 'object') {
    return null;
  }
  const record = row as Record<string, unknown>;
  const details = (record['details'] ?? null) as Record<string, unknown> | null;
  const id = safeString(record['model']) ?? safeString(record['name']);
  if (id === null || !isModelId(id)) {
    return null;
  }
  const name = safeString(record['name']) ?? id;
  return {
    id,
    name,
    modifiedAt: safeString(record['modified_at']),
    capabilities: safeCapabilities(record['capabilities']),
    parameterSize: safe(details?.['parameter_size']) ?? safe(record['parameter_size']),
    locked: isBlockedModelId(id, blockedPrefixes),
    lockReason: isBlockedModelId(id, blockedPrefixes) ? MODEL_LOCK_REASON : null,
  };
}

/**
 * `contextLength` ONLY from an actual `model_info` key whose suffix is
 * `.context_length` (or the bare key); `null` when the response carries none
 * — never guessed from architecture names or defaults.
 */
function contextLengthOf(modelInfo: Record<string, unknown>): number | null {
  const keys = Object.keys(modelInfo).sort();
  for (const key of keys) {
    if (key === 'context_length' || key.endsWith('.context_length')) {
      const value = modelInfo[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value;
      }
    }
  }
  return null;
}

function thinkingOf(value: unknown): boolean | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  // An object capacity descriptor still means the model thinks.
  return typeof value === 'object' && value !== null ? true : null;
}

export function createModelCatalog(options: ModelCatalogOptions): ModelCatalogLike {
  const origin = catalogOrigin(options.baseUrl);
  const fetchFn: CatalogFetch = options.fetchFn ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const listTimeoutMs = options.listTimeoutMs ?? 10_000;
  const detailsTimeoutMs = options.detailsTimeoutMs ?? 15_000;
  const semaphore = new Semaphore();

  interface ListCache {
    readonly at: number;
    readonly models: readonly ModelCatalogEntry[];
  }
  let listCache: ListCache | null = null;
  let listInFlight: Promise<{ models: readonly ModelCatalogEntry[] }> | null = null;
  const detailsCache = new Map<string, { at: number; result: { status: 'ok' | 'not-found'; details?: ModelDetails } }>();
  const detailsInFlight = new Map<string, Promise<{ status: 'ok' | 'not-found'; details?: ModelDetails }>>();

  async function list(): Promise<{ readonly models: readonly ModelCatalogEntry[] }> {
    if (listCache !== null && now() - listCache.at < MODEL_LIST_TTL_MS) {
      return { models: listCache.models };
    }
    if (listInFlight !== null) {
      return await listInFlight;
    }
    listInFlight = (async (): Promise<{ models: readonly ModelCatalogEntry[] }> => {
      try {
        const response = await fetchFn(`${origin}/api/tags`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(listTimeoutMs),
        });
        if (!response.ok) {
          throw new ModelCatalogUnavailableError();
        }
        const body = (await response.json()) as { models?: unknown };
        const rows = Array.isArray(body.models) ? body.models : [];
        const models = rows
          .map((row) => parseTagRow(row, options.blockedPrefixes))
          .filter((entry): entry is ModelCatalogEntry => entry !== null);
        listCache = { at: now(), models };
        return { models };
      } catch (error) {
        if (error instanceof ModelCatalogUnavailableError) {
          throw error;
        }
        throw new ModelCatalogUnavailableError();
      } finally {
        listInFlight = null;
      }
    })();
    return await listInFlight;
  }

  async function details(modelId: string): Promise<{ status: 'ok' | 'not-found'; details?: ModelDetails }> {
    const cached = detailsCache.get(modelId);
    if (cached !== undefined && now() - cached.at < MODEL_DETAILS_TTL_MS) {
      return cached.result;
    }
    const inFlight = detailsInFlight.get(modelId);
    if (inFlight !== undefined) {
      return await inFlight;
    }
    // Reserve the single-flight slot BEFORE awaiting the semaphore: concurrent
    // calls share exactly one upstream call. The semaphore then bounds how
    // many of those reserved flights actually run upstream concurrently.
    const flight = (async (): Promise<{ status: 'ok' | 'not-found'; details?: ModelDetails }> => {
      const release = await semaphore.acquire();
      try {
        const response = await fetchFn(`${origin}/api/show`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ model: modelId }),
          signal: AbortSignal.timeout(detailsTimeoutMs),
        });
        if (response.status === 404) {
          const result = { status: 'not-found' as const };
          detailsCache.set(modelId, { at: now(), result });
          return result;
        }
        if (!response.ok) {
          throw new ModelCatalogUnavailableError();
        }
        const body = (await response.json()) as Record<string, unknown>;
        const modelInfo = (body['model_info'] ?? null) as Record<string, unknown> | null;
        const showDetails = (body['details'] ?? null) as Record<string, unknown> | null;
        const parsed: ModelDetails = {
          contextLength: modelInfo === null ? null : contextLengthOf(modelInfo),
          capabilities: safeCapabilitiesOrNull(body['capabilities']),
          parameterSize: showDetails === null ? null : safe(showDetails['parameter_size']),
          thinking: thinkingOf(body['thinking']),
        };
        const result = { status: 'ok' as const, details: parsed };
        detailsCache.set(modelId, { at: now(), result });
        return result;
      } catch (error) {
        if (error instanceof ModelCatalogUnavailableError) {
          throw error;
        }
        throw new ModelCatalogUnavailableError();
      } finally {
        detailsInFlight.delete(modelId);
        release();
      }
    })();
    detailsInFlight.set(modelId, flight);
    return await flight;
  }

  return { list, details };
}

export type { ApiConfig };
