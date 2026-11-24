/**
 * BullMQ-backed `MemoryJobQueue` (Phase 3).
 *
 * Job design (deterministic ids — dedupe by id, never by wall-clock):
 * - The queue is named {@link MEMORY_QUEUE_NAME} (`workforce-memory`).
 * - Embedding jobs: id `embed-<block UUID>` — one job per block id; retries
 *   reuse the same id, so at-least-once delivery can't wedge duplicates.
 * - Compaction jobs: id `compact-<sha256>` where the digest is taken over
 *   `scope/path|triggerBlockId`. The id itself contains no colon, and
 *   different triggers (i.e. new writes past the threshold) get new jobs.
 * - Every job: `attempts: 3`, exponential backoff starting at 1000 ms.
 * - Duplicate safety: an existing job in `waiting`/`delayed`/`active`/`paused`
 *   or `completed` state is a no-op; a `failed` job is REMOVED then re-added
 *   under the same id (genuine requeue — a failed embedding must be able to
 *   run again; `completed` jobs must not re-run idempotent work).
 * - The ioredis connection uses `maxRetriesPerRequest: null` (required by
 *   BullMQ's blocking operations). It is closed by {@link close}.
 */
import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import type { MemoryJobQueue } from '@workforce/core/memory';
import type { SafeLogger } from '../logging.js';

/** Queue name fixed by the Phase 3 spec. */
export const MEMORY_QUEUE_NAME = 'workforce-memory';

/** Attempts for every memory job (BullMQ `attempts`, incl. the first run). */
export const MEMORY_JOB_ATTEMPTS = 3;

/** Base delay (ms) of the exponential backoff for retried jobs. */
export const MEMORY_JOB_BACKOFF_BASE_MS = 1000;

/** Discriminated payload carried by every job on the memory queue. */
export type MemoryJobData =
  | { kind: 'embed'; blockId: string }
  | { kind: 'compact'; scope: string; path: string; triggerBlockId: string }
  /**
   * Pre-Phase 6 opt-in personal-memory capture: ONE deterministic job per
   * (scope, chatId, assistantMessageId). The job carries ids ONLY (never
   * message text) — the worker re-loads the transcript, re-checks the
   * enablement, and writes at most one derived block per assistant turn.
   */
  | {
      kind: 'capture';
      ownerId: string;
      scope: string;
      chatId: string;
      slug: string;
      userMessageId: string;
      assistantMessageId: string;
    };

/** Deterministic embed job id: UUID-based, no runtime state. */
export function memoryEmbedJobId(blockId: string): string {
  return `embed-${blockId}`;
}

/** Deterministic compaction job id: sha256 over scope/path + trigger UUID. */
export function memoryCompactJobId(scope: string, path: string, triggerBlockId: string): string {
  const digest = createHash('sha256').update(`${scope}/${path}|${triggerBlockId}`).digest('hex');
  return `compact-${digest}`;
}

/** Deterministic capture job id: sha256 over scope/chat/assistant message. */
export function personalCaptureJobId(scope: string, chatId: string, assistantMessageId: string): string {
  const digest = createHash('sha256').update(`${scope}|${chatId}|${assistantMessageId}`).digest('hex');
  return `capture-${digest}`;
}

/** Job states that mean the job still exists AND must not be re-added. */
const IN_FLIGHT_STATES = new Set(['active', 'waiting', 'delayed', 'paused']);

/** Safe ids for the capture payload (API id contract, bounded count). */
const CAPTURE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isBoundedId(value: unknown): boolean {
  return typeof value === 'string' && CAPTURE_ID_PATTERN.test(value);
}

export function isMemoryJobData(value: unknown): value is MemoryJobData {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const data = value as {
    kind?: unknown;
    blockId?: unknown;
    scope?: unknown;
    path?: unknown;
    triggerBlockId?: unknown;
    ownerId?: unknown;
    chatId?: unknown;
    slug?: unknown;
    userMessageId?: unknown;
    assistantMessageId?: unknown;
  };
  if (data.kind === 'embed') {
    return typeof data.blockId === 'string' && data.blockId.length > 0;
  }
  if (data.kind === 'compact') {
    return (
      typeof data.scope === 'string' &&
      typeof data.path === 'string' &&
      typeof data.triggerBlockId === 'string'
    );
  }
  if (data.kind === 'capture') {
    return (
      isBoundedId(data.ownerId) &&
      typeof data.scope === 'string' &&
      data.scope.length > 0 &&
      data.scope.length <= 64 &&
      isBoundedId(data.chatId) &&
      isBoundedId(data.slug) &&
      isBoundedId(data.userMessageId) &&
      isBoundedId(data.assistantMessageId)
    );
  }
  return false;
}

/** Minimal structural surface of a BullMQ `Job` (so tests can inject fakes). */
export interface QueueJobLike {
  getState(): Promise<string>;
  remove(): Promise<void>;
}

/** Minimal structural surface of a BullMQ `Queue`. */
export interface QueueLike {
  add(name: string, data: MemoryJobData, opts?: unknown): Promise<QueueJobLike | undefined>;
  getJob(jobId: string): Promise<QueueJobLike | undefined | null>;
  close?(): Promise<void>;
}

/** BullMQ job options shared by every memory job (production defaults). */
export const MEMORY_JOB_OPTS = {
  attempts: MEMORY_JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: MEMORY_JOB_BACKOFF_BASE_MS },
  // Keep completed jobs inspectable for a week (bounded, capped count) so
  // deterministic-id dedupe sees "completed" and never re-runs finished work.
  removeOnComplete: { age: 604_800, count: 10_000 },
} as const;

/** Per-queue overrides (tests shorten backoff/attempts; production never does). */
export interface MemoryJobOptionsOverride {
  attempts?: number;
  backoffBaseMs?: number;
}

/** Builds the job options, with optional overrides (same shape as prod). */
export function memoryJobOptions(overrides?: MemoryJobOptionsOverride): {
  attempts: number;
  backoff: { type: string; delay: number };
  removeOnComplete: { age: number; count: number };
} {
  return {
    attempts: overrides?.attempts ?? MEMORY_JOB_ATTEMPTS,
    backoff: {
      type: MEMORY_JOB_OPTS.backoff.type,
      delay: overrides?.backoffBaseMs ?? MEMORY_JOB_BACKOFF_BASE_MS,
    },
    removeOnComplete: { ...MEMORY_JOB_OPTS.removeOnComplete },
  };
}

/**
 * ioredis reconnect strategy override (tests fail fast so hangs cannot hide).
 * ioredis names it `retryStrategy` at runtime; `false` disables reconnection.
 */
export type RedisReconnectStrategy = (retries: number) => number | void | null;

export interface BullMQMemoryJobQueueOptions {
  /** Redis URL; required unless a prebuilt `queue` is injected (tests). */
  redisUrl?: string;
  /** Injected queue (tests); when present, no ioredis connection is created. */
  queue?: QueueLike;
  /** Queue name override; default {@link MEMORY_QUEUE_NAME} (tests isolate). */
  queueName?: string;
  /** Safe logger for connection-level errors (type only, no values). */
  logger?: SafeLogger;
  /** Job option overrides; default = production attempts/backoff. */
  jobOptions?: MemoryJobOptionsOverride;
  /** ioredis reconnect strategy override (tests use fail-fast). */
  reconnectStrategy?: RedisReconnectStrategy;
}

export interface BullMQMemoryJobQueueHandle extends MemoryJobQueue {
  /**
   * PINGs the queue's ioredis connection with a bounded timeout. Used at
   * startup so a down Redis fails the server honestly. No-op when a test
   * injected the queue (no connection to check).
   */
  ping(timeoutMs?: number): Promise<void>;
  /** Closes the BullMQ queue and its ioredis connection; idempotent. */
  close(): Promise<void>;
}

/**
 * Enqueue helper shared by both job kinds. Existing job states decide:
 * in-flight/completed → no-op (return `false`), failed → remove + re-add
 * under the SAME id (return `true`), absent → fresh add (return `true`).
 */
async function enqueueWithId(
  queue: QueueLike,
  name: string,
  data: MemoryJobData,
  jobId: string,
  jobOptions?: MemoryJobOptionsOverride,
): Promise<boolean> {
  const existing = await queue.getJob(jobId);
  if (existing !== undefined && existing !== null) {
    const state = await existing.getState();
    if (state !== 'failed') {
      // Waiting/delayed/active/paused: already scheduled. Completed: the
      // idempotent work already ran (embeddings short-circuit; compactions
      // skip as `already_compacted`). Re-adding either would only churn.
      return false;
    }
    // BullMQ keeps failed jobs in the queue; a new add with the same id is
    // ignored while the failed job exists, so remove first to genuinely
    // requeue. The service re-derives all state from the store on retry.
    await existing.remove();
  }
  await queue.add(name, data, { ...memoryJobOptions(jobOptions), jobId });
  return true;
}

export class BullMQMemoryJobQueue implements MemoryJobQueue {
  readonly queue: QueueLike;

  private closed = false;

  private readonly jobOptions: MemoryJobOptionsOverride | undefined;
  private readonly reconnectStrategy: RedisReconnectStrategy | undefined;
  private readonly connectionOptions: RedisOptions | null = null;

  constructor(options: BullMQMemoryJobQueueOptions) {
    const queueName = options.queueName ?? MEMORY_QUEUE_NAME;
    this.jobOptions = options.jobOptions;
    this.reconnectStrategy = options.reconnectStrategy;
    if (options.queue !== undefined) {
      this.queue = options.queue;
      return;
    }
    if (options.redisUrl === undefined) {
      throw new Error('BullMQMemoryJobQueue requires a redisUrl (or an injected queue).');
    }
    // BullMQ OWNS the connection when given a config object: it creates,
    // duplicates (blocking commands) and closes every socket on close() —
    // passing an instance leaks duplicated sockets when close() hangs.
    this.connectionOptions = redisConnectionOptions(options.redisUrl, options.reconnectStrategy);
    this.queue = new Queue<MemoryJobData, void, string>(queueName, {
      connection: this.connectionOptions,
    }) as unknown as QueueLike;
  }

  async enqueueEmbedding(blockId: string): Promise<void> {
    if (this.closed) {
      throw new Error('memory queue is closed');
    }
    if (!isMemoryJobData({ kind: 'embed', blockId })) {
      throw new Error('invalid embed job payload');
    }
    await enqueueWithId(
      this.queue,
      'embed',
      { kind: 'embed', blockId },
      memoryEmbedJobId(blockId),
      this.jobOptions,
    );
  }

  /**
   * Deterministic, idempotent personal-memory capture enqueue for ONE
   * completed assistant turn. Same-id dedupe: waiting/delayed/active/paused
   * or `completed` jobs are a no-op; a `failed` job is removed and
   * re-queued under the SAME id (the worker re-checks enablement and the
   * derived-block metadata before writing, so duplicates can never land).
   */
  async enqueueCapture(input: {
    ownerId: string;
    scope: string;
    chatId: string;
    slug: string;
    userMessageId: string;
    assistantMessageId: string;
  }): Promise<boolean> {
    if (this.closed) {
      throw new Error('memory queue is closed');
    }
    if (!isMemoryJobData({ ...input, kind: 'capture' })) {
      throw new Error('invalid capture job payload');
    }
    return await enqueueWithId(
      this.queue,
      'capture',
      { kind: 'capture', ...input },
      personalCaptureJobId(input.scope, input.chatId, input.assistantMessageId),
      this.jobOptions,
    );
  }

  async ping(timeoutMs = 5_000): Promise<void> {
    if (this.connectionOptions === null) {
      return; // injected queue: nothing to check (tests)
    }
    // One-off client we own fully: quit (graceful) or disconnect (hard).
    const client = new IORedis(this.connectionOptions);
    try {
      await connectWithTimeout((c) => c.ping(), client, timeoutMs);
    } finally {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
  }

  async enqueueCompaction(scope: string, path: string, triggerBlockId: string): Promise<void> {
    if (this.closed) {
      throw new Error('memory queue is closed');
    }
    const data: MemoryJobData = { kind: 'compact', scope, path, triggerBlockId };
    if (!isMemoryJobData(data)) {
      throw new Error('invalid compaction job payload');
    }
    await enqueueWithId(
      this.queue,
      'compact',
      data,
      memoryCompactJobId(scope, path, triggerBlockId),
      this.jobOptions,
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    // BullMQ owns every socket it created (main + blockable duplicates), so
    // queue.close() is the ONLY correct teardown. It is bounded anyway: if a
    // future BullMQ version hangs, the outer caller cannot wait forever.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 10_000);
      void Promise.resolve(this.queue.close?.()).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
  }
}

/**
 * Builds plain ioredis/BullMQ connection options from a URL:
 * - `maxRetriesPerRequest: null` is REQUIRED (BullMQ blocks on the connection).
 * - `rediss://` gets `tls: {}` (node-ioredis TLS contract); `redis://` gets none.
 * - A numeric database path (`redis://host/2`) becomes `db: 2`, matching the
 *   chat stack's node-redis URL parsing; an empty/`/` path leaves db default (0).
 * - Invalid noninteger database paths (negative, decimal, extra slashes, junk)
 *   throw a FIXED configuration error that never echoes the URL or its
 *   credentials; the same goes for non-redis protocols.
 * - username/password/host/port are preserved from the URL parse.
 *
 * The URL value itself is never logged or included in any error.
 */
export function redisConnectionOptions(
  redisUrl: string,
  reconnectStrategy?: RedisReconnectStrategy,
): RedisOptions {
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(
      'REDIS_URL must be a redis:// or rediss:// URL (fixed configuration error; the URL value is never echoed)',
    );
  }
  const isTls = parsed.protocol === 'rediss:';
  // pathname is '/' or empty for a default-URL parse; '/2' selects database 2.
  const dbSegment = parsed.pathname.replace(/^\//, '');
  let db: number | undefined;
  if (dbSegment !== '') {
    if (!/^\d+$/.test(dbSegment)) {
      throw new Error(
        'REDIS_URL database path must be an integer like /2 (fixed configuration error; the URL value is never echoed)',
      );
    }
    db = Number(dbSegment);
  }
  // URL keeps IPv6 hosts bracketed; ioredis wants the bare address.
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const defaults: RedisOptions = {
    host,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    maxRetriesPerRequest: null,
    ...(parsed.username !== '' && parsed.username !== 'default'
      ? { username: parsed.username }
      : {}),
    ...(parsed.password !== '' ? { password: parsed.password } : {}),
    ...(isTls ? { tls: {} } : {}),
    ...(db !== undefined ? { db } : {}),
    ...(reconnectStrategy !== undefined ? { retryStrategy: reconnectStrategy } : {}),
  } as RedisOptions;
  return defaults;
}

/** PINGs a minimal ioredis surface with a hard timeout; fails calls honestly. */
export function connectWithTimeout(
  ping: (client: { ping(): Promise<unknown> }) => Promise<unknown>,
  client: { ping(): Promise<unknown> },
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Redis queue PING timeout after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    ping(client).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Redis queue PING failed'));
      },
    );
  });
}
