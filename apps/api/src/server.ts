/**
 * The only side-effectful module: real config → provider → Redis →
 * resumable-stream → Postgres (memory) → BullMQ (memory) → HTTP listen →
 * graceful shutdown.
 *
 * Startup contract (phase spec):
 * - Env files: gitignored `.env`/`.env.local` files (apps/api and repo root)
 *   are hydrated into `process.env` by `loadProjectEnvFiles()` inside
 *   `startServer`, BEFORE config reads it — shell-exported values always
 *   win (see `env.ts`). Apart from that no dotenv machinery: `OLLAMA_API_KEY`
 *   and `DATABASE_URL` are still read only through `process.env`.
 * - Tests never import this module
 *   (guarded by WORKFORCE_API_SKIP_LISTEN).
 * - The API key reaches only the provider factory; the database URL reaches
 *   only the Prisma client. Neither is ever logged.
 * - DB and Redis connections are bounded and fail startup safely: if either
 *   is unavailable the process exits instead of serving broken guarantees.
 * - Prisma migrations are NOT run here or in request handling — run
 *   `prisma migrate deploy` for the memory migration before starting.
 *
 * Graceful shutdown: stop accepting → wait (bounded) for tracked background
 * tasks (checkpoint pumping, persistence) → close the memory worker + queue →
 * disconnect Prisma → close Redis (existing chat clients). Idempotency keys
 * of started streams are intentionally NOT released (resume semantics).
 */
import type { Server } from 'node:http';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { PrismaClient } from '@workforce/core/generated/prisma';
import { MemoryService, type MemoryLogger } from '@workforce/core/memory';
import { createPostgresMemoryStore } from '@workforce/core/memory/postgres';
import { createBackgroundTracker } from './background.js';
import { loadApiConfig } from './config.js';
import { loadProjectEnvFiles } from './env.js';
import { consoleLogger, type SafeLogger } from './logging.js';
import { createResumableStreamAdapter } from './stream-context/resumable.js';
import { createRedisChatStore } from './store/redis.js';
import { buildApp } from './app.js';
import { createLocalEmbeddingProvider } from './memory/embedding.js';
import { createOllamaCompactor } from './memory/ollama-compactor.js';
import { BullMQMemoryJobQueue } from './memory/bullmq-queue.js';
import { createMemoryWorker, type MemoryWorkerHandle } from './memory/worker.js';

/**
 * Maps a startup failure to a SAFE, human-readable reason for logs — the only
 * field an operator sees besides `errorType`. Rules:
 * - Exact known messages map to fixed strings (missing keys, bounded connect
 *   timeouts).
 * - System `code`s (ECONNREFUSED / ETIMEDOUT / EADDRINUSE / ENOTFOUND /
 *   ECONNRESET) and known Prisma failure codes (P1000..P1003, P1008..P1012,
 *   P1017) are returned exactly — the code string alone, never its message.
 * - Safe `Error.name` regex only; otherwise a generic fixed string.
 * - NEVER returns error.message generally: messages may embed keys, URLs,
 *   request/response bodies, or stacks. This function returns fixed strings
 *   and allowlisted identifiers only. All inputs (message matching included)
 *   compare against fixed literals this codebase authored.
 */
export function startupFailureReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown startup failure';
  }
  // System and Prisma codes: exact allowlisted identifiers only.
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (['ECONNREFUSED', 'ETIMEDOUT', 'EADDRINUSE', 'ENOTFOUND', 'ECONNRESET'].includes(code)) {
      return code;
    }
    if (/^P10(0[0-3]|0[89]|1[0-2]|17)$/.test(code)) {
      return code;
    }
  }
  // Exact messages this codebase throws — safe to surface as fixed text.
  const { message, name } = error;
  if (typeof message === 'string') {
    if (message === 'OLLAMA_API_KEY is required to start the API server.') {
      return 'OLLAMA_API_KEY is missing';
    }
    if (message === 'DATABASE_URL is required to start the API server.') {
      return 'DATABASE_URL is missing';
    }
    // Env-file hydration failure (env.ts throws this fixed literal; parser
    // errors, paths and contents are never attached nor echoed).
    if (message === 'Environment file could not be loaded.') {
      return 'Environment file could not be loaded';
    }
    if (message === 'Redis connect timeout' || (message.startsWith('Redis ') && message.endsWith('connect timeout'))) {
      return 'Redis connection timed out';
    }
    if (message === 'Postgres connect timeout') {
      return 'Postgres connection timed out';
    }
    // Config errors compose schema-authored issue text; do NOT echo it — the
    // composed detail can contain schema-declared default URLs.
    if (message.startsWith('Invalid API configuration (values are never included)')) {
      return 'API configuration is invalid (check OLLAMA/REDIS/DATABASE settings)';
    }
  }
  // A bounded, identifier-shaped error name is the last safe surface.
  if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name)) {
    return name;
  }
  return 'unknown startup failure';
}

/** Milliseconds to wait for in-flight background work before giving up. */
const SHUTDOWN_DRAIN_MS = 10_000;
/** Milliseconds for each Redis connection at startup; failing fast beats hanging. */
const REDIS_CONNECT_TIMEOUT_MS = 5_000;
/** Milliseconds for the bounded Prisma `$connect` at startup. */
const DB_CONNECT_TIMEOUT_MS = 5_000;

async function connectWithTimeout(connect: () => Promise<unknown>, timeoutMs: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} connect timeout`));
    }, timeoutMs);
  });
  try {
    await Promise.race([connect(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Adapts the safe logger to the service's logging hook (ids/shapes only). */
function memoryLogger(logger: SafeLogger): MemoryLogger {
  return {
    warn: (message, error) => {
      if (error !== undefined) {
        logger.error(message, error);
      } else {
        logger.warn(message);
      }
    },
  };
}

export interface ApiServerHandle {
  app: ReturnType<typeof buildApp>;
  store: ReturnType<typeof createRedisChatStore>;
  background: ReturnType<typeof createBackgroundTracker>;
  redis: RedisClientType;
  /** Memory pipeline handles (BullMQ + worker + service). */
  memory: { service: MemoryService };
  server: Server;
  /** Closes everything; idempotent. */
  close(): Promise<void>;
}

export async function startServer(): Promise<ApiServerHandle> {
  const logger = consoleLogger;
  // Hydrate process.env from the gitignored env files BEFORE config reads
  // it (shell values always win). Runs once per real start; never on a bare
  // module import under WORKFORCE_API_SKIP_LISTEN (tests).
  loadProjectEnvFiles();
  const config = loadApiConfig();

  if (config.apiKey === null) {
    // Fixed text only; never mentions any key value.
    throw new Error('OLLAMA_API_KEY is required to start the API server.');
  }
  if (config.databaseUrl === null) {
    // Fixed text only; never mentions the URL value.
    throw new Error('DATABASE_URL is required to start the API server.');
  }

  const provider = createOpenAICompatible({
    name: 'ollama',
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });
  const model = provider.chatModel(config.model);

  const redis = createClient({ url: config.redisUrl });
  redis.on('error', () => {
    // node-redis also surfaces command errors through rejections; this
    // prevents an unhandled 'error' event from killing the process.
    logger.warn('redis-client-error');
  });
  await connectWithTimeout(
    () => redis.connect(),
    REDIS_CONNECT_TIMEOUT_MS,
    'Redis',
  );

  // Pub/sub needs dedicated connections: a subscriber connection cannot
  // multiplex regular commands (node-redis contract), hence duplicate().
  // Each duplicate is an independent connection and gets its own safe
  // 'error' listener, or an emit('error') would kill the process.
  const publisher = redis.duplicate();
  const subscriber = redis.duplicate();
  publisher.on('error', () => {
    logger.warn('redis-publisher-error');
  });
  subscriber.on('error', () => {
    logger.warn('redis-subscriber-error');
  });
  await connectWithTimeout(
    () => publisher.connect(),
    REDIS_CONNECT_TIMEOUT_MS,
    'Redis publisher',
  );
  await connectWithTimeout(
    () => subscriber.connect(),
    REDIS_CONNECT_TIMEOUT_MS,
    'Redis subscriber',
  );

  const background = createBackgroundTracker({
    onError: (error) => logger.error('background-task', error),
  });

  const streamContext = createResumableStreamAdapter({
    waitUntil: background.track,
    publisher,
    subscriber,
  });

  const store = createRedisChatStore(redis as unknown as Parameters<typeof createRedisChatStore>[0]);

  // -- Phase 3 memory wiring ------------------------------------------------
  // Prisma client for the pgvector memory store. The DATABASE_URL from config
  // is passed explicitly; the migration is NOT run here (see file header).
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  let queue: BullMQMemoryJobQueue | null = null;
  let worker: MemoryWorkerHandle | null = null;
  try {
    // Bounded connect: fail startup safely when the DB is unreachable.
    await connectWithTimeout(
      () => prisma.$connect(),
      DB_CONNECT_TIMEOUT_MS,
      'Postgres',
    );

    const memoryStore = createPostgresMemoryStore(prisma, {
      // Dedicated pg.Client session advisory locks need the raw database URL
      // (outside the Prisma pool); without it compaction cannot lock honestly.
      databaseUrl: config.databaseUrl,
    });
    const embeddingProvider = createLocalEmbeddingProvider({
      cacheDir: config.embeddingCacheDir,
    });
    const compactor = createOllamaCompactor({ model });
    const bullmqQueue = new BullMQMemoryJobQueue({ redisUrl: config.redisUrl });
    const memoryService = new MemoryService({
      store: memoryStore,
      embeddingProvider,
      queue: bullmqQueue,
      compactor,
      logger: memoryLogger(logger),
    });
    // Worker with its own blocking connection; concurrency 2 per spec.
    const workerHandle = createMemoryWorker({ service: memoryService, redisUrl: config.redisUrl, logger });
    queue = bullmqQueue;
    worker = workerHandle;

    // Startup honesty: PING the BullMQ queue connection (bounded). A down
    // Redis must fail startup instead of serving memory writes that all 503.
    await bullmqQueue.ping(REDIS_CONNECT_TIMEOUT_MS);

    const app = buildApp({
      config,
      store,
      streamContext,
      model,
      background,
      logger,
      memory: { service: memoryService, queue: bullmqQueue },
    });

    const server = app.listen(config.port);

    // Listen lifecycle: log success ONCE (fixed context + configured port) and
    // map async listen failures (e.g. EADDRINUSE) through the SAME safe
    // startup channel — the failure arrives outside the try/catch above, so
    // exit here with the safe reason instead of letting the event surface
    // unhandled. A post-listening server error only logs (the process keeps
    // serving; it is not a startup failure).
    let listening = false;
    server.once('listening', () => {
      listening = true;
      console.log(JSON.stringify({ level: 'info', context: 'api-listening', port: config.port }));
    });
    server.on('error', (error: unknown) => {
      consoleLogger.error('api-http-server-error', error);
      console.error(JSON.stringify({ level: 'error', context: 'api-http-server-error', startupReason: startupFailureReason(error) }));
      if (!listening) {
        process.exit(1);
      }
    });

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      // Safe on any Node that has it; closes kept-alive sockets so long-poll
      // clients do not delay shutdown. Missing there: no-op.
      if (typeof (server as { closeIdleConnections?: () => void }).closeIdleConnections === 'function') {
        (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
      }
      // 1. Wait (bounded) for checkpoint/persistence background work.
      await background.waitForAll(SHUTDOWN_DRAIN_MS);
      // 2. Close the memory worker (drains its active jobs) then the queue.
      try {
        await workerHandle.close();
      } catch (error) {
        logger.error('memory-worker-close-failed', error);
      }
      try {
        await bullmqQueue.close();
      } catch (error) {
        logger.error('memory-queue-close-failed', error);
      }
      // 3. Disconnect Postgres.
      try {
        await prisma.$disconnect();
      } catch (error) {
        logger.error('prisma-disconnect-failed', error);
      }
      // 4. Close the existing node-redis clients (resumable-stream owns
      // its own semantics; closing only AFTER everything above).
      await Promise.allSettled([redis.quit(), publisher.quit(), subscriber.quit()]);
    };

    return {
      app,
      store,
      background,
      redis,
      server,
      memory: { service: memoryService },
      close,
    };
  } catch (error) {
    // Fail startup safely: release whatever was created before surfacing.
    try {
      await worker?.close();
    } catch {
      /* best effort */
    }
    try {
      await queue?.close();
    } catch {
      /* best effort */
    }
    try {
      await prisma.$disconnect();
    } catch {
      /* best effort */
    }
    await Promise.allSettled([redis.quit().catch(() => undefined), publisher.quit().catch(() => undefined), subscriber.quit().catch(() => undefined)]);
    throw error;
  }
}

/** Entry point when run as an executable (skipped by tests via env guard). */
if (typeof process.env['WORKFORCE_API_SKIP_LISTEN'] !== 'string') {
  // resumable-stream 2.2.13 pumps its durable copy in an internal
  // `reader.read().then(...)` chain without a catch, so a Redis publish/sentinel
  // failure inside that pump becomes an unhandled rejection. Contain it here
  // so the process survives and keeps serving; the failure is logged by type
  // only (a dropped checkpoint chunk is NOT repaired by this — see README).
  process.on('unhandledRejection', (reason: unknown) => {
    consoleLogger.error('process-unhandled-rejection', reason);
  });

  void startServer()
    .then((handle) => {
      const signalHandler = (): void => {
        handle
          .close()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      };
      process.on('SIGTERM', signalHandler);
      process.on('SIGINT', signalHandler);
    })
    .catch((error: unknown) => {
      // Logged by type only; startup failures may contain env-derived text.
      consoleLogger.error('api-startup-failed', error);
      // Second FIXED line: the safe human-readable reason an operator can act
      // on (missing key, Redis timeout, EADDRINUSE, Prisma code, …).
      console.error(JSON.stringify({ level: 'error', context: 'api-startup-failed-reason', startupReason: startupFailureReason(error) }));
      process.exit(1);
    });
}
