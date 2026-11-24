/**
 * REAL Phase 4 multi-agent integration suite: the PRODUCTION stack end to end.
 *
 * - Real Prisma over the docker pgvector Postgres: `createPrismaWorkDocStore`
 *   and `createPrismaDelegationRepository` with the Phase 4 migration applied.
 * - Real Redis node-redis store (`createRedisChatStore`) + the PRODUCTION
 *   resumable-stream adapter over three real connections, so every child chat
 *   is a REAL streamed chat at `/api/agents/:slug/chat`.
 * - Real BullMQ delegation queue + real worker (`workforce-delegation` family)
 *   over real Redis with run-unique queue names.
 * - Real HTTP Express app (`buildApp`) with the full Phase 4 agent runtime
 *   (work docs, delegations, query_data) and the real pg Pool for query_data.
 * - Models are DETERMINISTIC AI SDK mocks (no Ollama, no API key, no network
 *   beyond the local stack); stream steps are fixed test strings.
 *
 * Isolation contract (mirrors memory.test.ts / redis-stream.test.ts):
 * - Run-unique ids everywhere: chat ids, run scope labels, stream keyPrefix,
 *   and the delegation queue name (`workforce-delegation-test-<RUN_ID>`).
 * - Cleanup deletes EXACTLY this run's rows (tracked ids, parameterized) and
 *   EXACTLY this run's Redis keys (exact ids for chat/idempotency keys; a SCAN
 *   restricted to the run-unique resumable-stream prefix for sentinels the
 *   server generates internally). No FLUSH, no other queues/databases touched.
 * - Worker close precedes queue obliteration; every wait/teardown is bounded.
 * - Stale-running recovery uses REAL DB timestamps injected through Prisma
 *   (never sleeps up to the 120s budget); query_data uses a short
 *   statement_timeout so timeouts fire deterministically and cheaply.
 *
 * Run: `npm run test:integration --workspace @workforce/api` (root
 * `npm run test:integration` delegates here). Requires Redis at
 * redis://127.0.0.1:6379 and Postgres at
 * postgresql://workforce:workforce@127.0.0.1:55432/workforce with the Phase 4
 * migration applied (values never printed; all failure text is fixed).
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { PrismaClient } from '@workforce/core/generated/prisma';
import { createClient, type RedisClientType } from 'redis';
import type { LanguageModel, UIMessage } from 'ai';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';

import {
  createBackgroundTracker,
  type BackgroundTaskTracker,
} from '../src/background.js';
import { DEFAULT_DATABASE_URL, loadApiConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import {
  createRedisChatStore,
  REDIS_KEY_PREFIX,
  type RedisLike,
} from '../src/store/redis.js';
import { createResumableStreamAdapter } from '../src/stream-context/resumable.js';
import type { ChatStore } from '../src/store/types.js';
import {
  createDelegationContextSigner,
  DELEGATION_CONTEXT_HEADER,
} from '../src/agents/delegation-context.js';
import {
  BullMQDelegationJobQueue,
  createDelegationWorker,
  delegationJobId,
  type DelegationJobQueue,
  type DelegationWorkerHandle,
} from '../src/agents/delegation-queue.js';
import { createDelegationRunJobClient } from '../src/agents/delegation-run-client.js';
import type { HostCapabilityDeps } from '../src/agents/host-capabilities.js';
import {
  createDataQueryService,
  type DataQueryService,
} from '../src/agents/data-query.js';
import {
  createPrismaDelegationRepository,
} from '@workforce/core/delegation/postgres';
import {
  createPrismaWorkDocStore,
} from '@workforce/core/work-docs/postgres';
import { WorkDocService } from '@workforce/core/work-docs';
import type { DelegationRepository, Delegation as CoreDelegation } from '@workforce/core/delegation';
import { createDelegationRoutes } from '../src/agents/delegation-routes.js';
import { Pool } from 'pg';
import { createMockModel, mockUsage } from '../test/helpers.js';

// -- Environment (values never printed; error text is fixed) -------------------

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const DATABASE_URL = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
const DELEGATION_QUEUE = `workforce-delegation-test-${RUN_ID}`;
const STREAM_KEY_PREFIX = `workforce:phase4:stream-live:${RUN_ID}`;
const CONNECT_TIMEOUT_MS = 5_000;
/** Test-only delegation budget ceiling: DB timestamp injection drives staleness. */
const TEST_DELEGATION_SECRET = 'phase4-live-integration-secret-0123456789abcdef';
const signer = createDelegationContextSigner(Buffer.from(TEST_DELEGATION_SECRET, 'utf8'));

// -- Deterministic model steps --------------------------------------------------

function textStep(delta: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta },
    { type: 'text-end', id: 't1' },
    { type: 'finish', usage: mockUsage(), finishReason: { unified: 'stop', raw: undefined } },
  ];
}

// -- Shared Prisma + bounded helpers -------------------------------------------

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${String(timeoutMs)}ms`)), timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } catch (error) {
    void error; // teardown failures must never hang the suite
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${message} (waited ${String(Date.now() - started)}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function connectOrDiePostgres(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe timeout')), CONNECT_TIMEOUT_MS);
  });
  try {
    await Promise.race([prisma.$connect(), timeout]);
  } catch {
    assert.fail(
      'Postgres is not reachable for the configured DATABASE_URL (default postgresql://workforce:workforce@127.0.0.1:55432/workforce). ' +
        'Start it from the repo root with `docker compose up -d postgres`, apply the Phase 4 migration, then re-run ' +
        '`npm run test:integration --workspace @workforce/api`. The offline suite never needs Postgres.',
    );
  } finally {
    clearTimeout(timer);
  }
}

function liveClient(): RedisClientType {
  return createClient({
    url: REDIS_URL,
    socket: { reconnectStrategy: false, connectTimeout: CONNECT_TIMEOUT_MS },
  });
}

async function connectOrDieRedis(client: RedisClientType): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe timeout')), CONNECT_TIMEOUT_MS);
  });
  try {
    await Promise.race([client.connect(), timeout]);
  } catch {
    assert.fail(
      'Redis is not reachable for the configured REDIS_URL (default redis://127.0.0.1:6379). ' +
        'Start it from the repo root with `docker compose up -d redis`, then re-run ' +
        '`npm run test:integration --workspace @workforce/api`. The offline suite never needs Redis.',
    );
  } finally {
    clearTimeout(timer);
  }
}

// -- Run-scoped registry -------------------------------------------------------

const trackedChats: Array<{ slug: string; chatId: string }> = [];
const trackedIdempotencyKeys: string[] = [];
const trackedDelegationIds: string[] = [];
const trackedDocIds: string[] = [];

function trackChat(slug: string, chatId: string): void {
  trackedChats.push({ slug, chatId });
}

function trackIdempotency(slug: string, chatId: string, messageId: string): void {
  trackedIdempotencyKeys.push(`${REDIS_KEY_PREFIX}:idempotency:${slug}:${chatId}:${messageId}`);
}

// -- Stack ---------------------------------------------------------------------

interface Phase4StackOptions {
  label: string;
  model: LanguageModel;
  /** Real delegation BullMQ queue + worker (async tests). */
  withQueue?: boolean;
  /** Real pg Pool for query_data with the given bounds. */
  dataQuery?: { poolMax: number; rowCap: number; statementTimeoutMs: number };
  /** Test-scoped delegation budget (recovery staleness uses DB timestamps). */
  delegationTimeoutMs?: number;
}

interface Phase4Stack {
  label: string;
  port: number;
  base: RedisClientType;
  store: ChatStore;
  repo: DelegationRepository;
  workDocs: WorkDocService;
  queue: DelegationJobQueue | null;
  dataQuery: DataQueryService | null;
  internalOrigin: string;
  /** Mints a signed `delegation-create` header for the OWN routes. */
  createHeader: (parentChatId: string, parentDepth: number) => string;
  close(): Promise<void>;
}

async function createPhase4Stack(options: Phase4StackOptions): Promise<Phase4Stack> {
  const delegationTimeoutMs = options.delegationTimeoutMs ?? 120_000;
  const label = `${options.label}-${RUN_ID}`;
  const base = liveClient();
  const publisher = liveClient();
  const subscriber = liveClient();
  for (const client of [base, publisher, subscriber]) {
    client.on('error', () => undefined);
  }
  await connectOrDieRedis(base);
  await connectOrDieRedis(publisher);
  await connectOrDieRedis(subscriber);

  const background = createBackgroundTracker({ onError: () => undefined });
  const store = createRedisChatStore(base as unknown as RedisLike);
  const streamContext = createResumableStreamAdapter({
    waitUntil: background.track,
    publisher,
    subscriber,
    keyPrefix: STREAM_KEY_PREFIX,
  });

  const INTERNAL_ORIGIN = `http://phase4-live-${options.label}`;
  let livePort = 0;
  const agentFetchFn: HostCapabilityDeps['fetchFn'] = (input, init) => {
    const rewritten = typeof input === 'string' ? input.replace(INTERNAL_ORIGIN, `http://127.0.0.1:${livePort}`) : input;
    return fetch(rewritten, init);
  };

  let queue: DelegationJobQueue | null = null;
  let worker: DelegationWorkerHandle | null = null;
  const redisClients: Array<{ quit(): Promise<unknown>; disconnect(): void }> = [];
  if (options.withQueue === true) {
    const delegationQueue = new BullMQDelegationJobQueue({
      redisUrl: REDIS_URL,
      queueName: DELEGATION_QUEUE,
      logger: { warn: () => undefined, error: () => undefined },
      reconnectStrategy: () => null, // fail fast; never hang the suite
    });
    queue = delegationQueue;
    const runClient = createDelegationRunJobClient({
      signer,
      fetchFn: agentFetchFn,
      baseUrl: INTERNAL_ORIGIN,
      delegationTimeoutMs,
    });
    worker = createDelegationWorker({
      runClient,
      redisUrl: REDIS_URL,
      queueName: DELEGATION_QUEUE,
      logger: { warn: () => undefined, error: () => undefined },
      reconnectStrategy: () => null,
    });
  }

  let pool: Pool | null = null;
  let dataQuery: DataQueryService | null = null;
  if (options.dataQuery !== undefined) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: options.dataQuery.poolMax,
    });
    dataQuery = createDataQueryService({
      pool,
      statementTimeoutMs: options.dataQuery.statementTimeoutMs,
      rowCap: options.dataQuery.rowCap,
    });
  }

  const config = loadApiConfig({ OLLAMA_API_KEY: 'test-only-not-a-real-key', REDIS_URL, DATABASE_URL });
  const app = buildApp({
    config,
    store,
    streamContext,
    model: options.model,
    background,
    agents: {
      hostDeps: { fetchFn: agentFetchFn, baseUrl: INTERNAL_ORIGIN, signer, delegationTimeoutMs },
      signer,
      workDocs: { service: new WorkDocService({ store: createPrismaWorkDocStore(prisma) }) },
      delegations: createDelegationRoutes({
        repo: createPrismaDelegationRepository(prisma),
        queue,
        chatStore: store,
        signer,
        fetchFn: agentFetchFn,
        baseUrl: INTERNAL_ORIGIN,
        delegationTimeoutMs,
        logger: { warn: () => undefined, error: () => undefined },
      }),
      dataQuery:
        dataQuery === null || options.dataQuery === undefined
          ? undefined
          : { service: dataQuery, rowCap: options.dataQuery.rowCap },
    },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'ephemeral test port');
  livePort = address.port;

  const ownedKeyPrefixes = new Set<string>([`${STREAM_KEY_PREFIX}:`]);

  async function close(): Promise<void> {
    // 1. Stop HTTP + drain tracked background work.
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
      10_000,
      'server close',
    );
    server.closeIdleConnections?.();
    await bounded(background.waitForAll(5_000), 6_000, 'background drain');

    // 2. Stop the worker BEFORE any queue obliteration (memory-suite order).
    if (worker !== null) {
      await bounded(worker.close(), 15_000, 'delegation worker close');
    }
    // 3. End the real pg pool.
    if (pool !== null) {
      await bounded(pool.end(), 10_000, 'query pool end');
    }

    // 4. Delete EXACTLY this run's Redis keys: tracked chat/idempotency keys,
    //    then a SCAN restricted to the run-unique resumable-stream prefix
    //    (server-internal sentinel keys are only discoverable this way).
    try {
      for (const { slug, chatId } of trackedChats) {
        await base.del(`${REDIS_KEY_PREFIX}:chat:${slug}:${chatId}:messages`);
        await base.del(`${REDIS_KEY_PREFIX}:chat:${slug}:${chatId}:active-stream`);
        // The activity-index member this run's appends created.
        await base.zRem(`${REDIS_KEY_PREFIX}:chat-index`, `${slug}:${chatId}`);
      }
      for (const key of trackedIdempotencyKeys) {
        await base.del(key);
      }
      for (const prefix of ownedKeyPrefixes) {
        let cursor = '0';
        do {
          // node-redis v6 scan(cursor, { MATCH, COUNT }) → { cursor, keys }.
          const scan = await base.scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 });
          cursor = scan.cursor;
          if (scan.keys.length > 0) {
            await base.del(scan.keys);
          }
        } while (cursor !== '0');
      }
    } catch (error) {
      void error;
    }

    // 5. Obliterate ONLY this run's delegation queue (worker already closed).
    if (options.withQueue === true) {
      try {
        const cleaner = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, retryStrategy: () => null });
        const testQueue = new Queue(DELEGATION_QUEUE, { connection: cleaner });
        await bounded(testQueue.obliterate({ force: true }), 10_000, 'delegation queue obliterate');
        await bounded(testQueue.close(), 5_000, 'delegation queue close');
        await bounded(cleaner.quit(), 5_000, 'delegation queue cleaner quit');
      } catch (error) {
        void error;
      }
      if (queue !== null) {
        await bounded((queue as unknown as { close(): Promise<void> }).close(), 15_000, 'delegation queue handle close');
      }
    }

    // 6. Quit the live redis clients (best effort).
    for (const client of [base, publisher, subscriber]) {
      try {
        await bounded(client.quit(), 3_000, 'redis client quit');
      } catch {
        client.disconnect();
      }
    }
    void redisClients;

    // 7. Exact DB cleanup: tracked delegation rows, tracked docs (children cascade).
    try {
      if (trackedDelegationIds.length > 0) {
        await bounded(prisma.delegation.deleteMany({ where: { id: { in: trackedDelegationIds } } }), 10_000, 'delegation cleanup');
      }
      if (trackedDocIds.length > 0) {
        await bounded(prisma.workDoc.deleteMany({ where: { id: { in: trackedDocIds } } }), 10_000, 'workdoc cleanup');
      }
    } catch (error) {
      void error;
    }
  }

  return {
    label,
    port: livePort,
    base,
    store,
    repo: createPrismaDelegationRepository(prisma),
    workDocs: new WorkDocService({ store: createPrismaWorkDocStore(prisma) }),
    queue,
    dataQuery,
    internalOrigin: INTERNAL_ORIGIN,
    createHeader: (parentChatId: string, parentDepth: number) =>
      signer.sign({ kind: 'delegation-create', parentChatId, parentDepth, expiresAt: Date.now() + 120_000 }),
    close,
  };
}

// -- Shared setup/teardown -----------------------------------------------------

before(async () => {
  await connectOrDiePostgres();
  const tables = await prisma.$queryRaw<Array<{ found: number }>>`
    SELECT COUNT(*)::int AS found FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('WorkDoc', 'WorkDocVersion', 'WorkDocRevision', 'WorkDocLink', 'Delegation')`;
  if (Number(tables[0]?.found ?? 0) !== 5) {
    throw new Error('Phase 4 tables missing — apply the Phase 4 migration first (root: npm run db:migrate).');
  }
  // Defensive pre-clean (a run id can never repeat): remove orphans of THIS run id.
  try {
    await prisma.delegation.deleteMany({ where: { parentChatId: { startsWith: `p4-${RUN_ID}` } } });
    await prisma.workDoc.deleteMany({ where: { chatId: { startsWith: `p4-${RUN_ID}` } } });
  } catch {
    /* first run: nothing to clean */
  }
});

after(async () => {
  await bounded(prisma.$disconnect(), 10_000, 'prisma disconnect');
});

// -- Small route helpers -------------------------------------------------------

function chatUrl(port: number, slug: string, path = ''): string {
  return `http://127.0.0.1:${port}/api/agents/${slug}${path}`;
}

async function postChatMessage(
  port: number,
  slug: string,
  chatId: string,
  message: UIMessage,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(chatUrl(port, slug, '/chat'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': `${chatId}:${message.id}`, ...headers },
    body: JSON.stringify({ id: chatId, message }),
  });
}

function userMessageLive(text: string, id: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

async function createDirectDelegation(
  repo: DelegationRepository,
  parentChatId: string,
  childChatId: string,
  target: 'analyst' | 'researcher',
  mode: 'sync' | 'async',
): Promise<CoreDelegation> {
  const row = await repo.create({
    parentChatId,
    childChatId,
    parentMessageId: 'pm-seeded',
    targetAgent: target,
    mode,
    task: 'Live delegated task: summarize the recorded migration notes.',
    depth: 1,
  });
  trackedDelegationIds.push(row.id);
  return row;
}

async function getDelegationDetail(port: number, id: string): Promise<CoreDelegation | undefined> {
  const response = await fetch(chatUrl(port, 'orchestrator', `/delegations/${id}`));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { delegation?: CoreDelegation };
  return body.delegation;
}

// ---------------------------------------------------------------------------
// Tests (sequential by node:test default)
// ---------------------------------------------------------------------------

test('live prerequisites: real Postgres tables + Redis reachable', { timeout: 15_000 }, async () => {
  const client = liveClient();
  try {
    await connectOrDieRedis(client);
    assert.equal(await client.ping(), 'PONG');
  } finally {
    await bounded(client.quit(), 3_000, 'prereq redis quit');
  }
  const docs = await prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM "WorkDoc"`;
  const delegations = await prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM "Delegation"`;
  assert.ok(Number(docs[0]?.count) >= 0);
  assert.ok(Number(delegations[0]?.count) >= 0);
});

test('live workdocs: real Prisma versions/CAS/rollback provenance through real REST + concurrent addLink idempotency', { timeout: 30_000 }, async () => {
  const model = createMockModel({ steps: [textStep('unused')] });
  const stack = await createPhase4Stack({ label: 'docs', model: model as unknown as LanguageModel });
  try {
    const chatId = `p4-${RUN_ID}-docs`;
    trackChat('orchestrator', chatId);

    // -- create: v1 draft + v1 snapshot + creation revision
    const created = await fetch(chatUrl(stack.port, 'orchestrator', '/work-docs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, type: 'report', title: 'Live migration report', content: 'v1 body' }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { document: { id: string; version: number; status: string } };
    const docId = createdBody.document.id;
    trackedDocIds.push(docId);
    assert.equal(createdBody.document.version, 1);
    assert.equal(createdBody.document.status, 'draft');

    let versions = await (await fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}/versions?chatId=${chatId}`))).json() as { versions: Array<{ version: number; content: string }> };
    assert.equal(versions.versions.length, 1);
    assert.equal(versions.versions[0]?.version, 1);
    assert.equal(versions.versions[0]?.content, 'v1 body');
    let revisions = await (await fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}/revisions?chatId=${chatId}`))).json() as { revisions: Array<{ source: string; fromVersion: number | null; toVersion: number }> };
    assert.equal(revisions.revisions.length, 1);
    assert.equal(revisions.revisions[0]?.fromVersion, null);
    assert.equal(revisions.revisions[0]?.toVersion, 1);
    assert.equal(revisions.revisions[0]?.source, 'agent');

    // -- source:'user' versioned update → v2 + audit provenance user
    const updated = await fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}/versions`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, expectedVersion: 1, content: 'v2 body', source: 'user' }),
    });
    assert.equal(updated.status, 200);
    const updatedBody = (await updated.json()) as { document: { version: number; content: string } };
    assert.equal(updatedBody.document.version, 2);
    assert.equal(updatedBody.document.content, 'v2 body');

    // -- stale CAS → fixed 409, no mutation
    const stale = await fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}/versions`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, expectedVersion: 1, content: 'LOST UPDATE' }),
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: 'Work document version conflict.' });
    versions = (await (await fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}/versions?chatId=${chatId}`))).json()) as { versions: Array<{ version: number; content: string }> };
    assert.equal(versions.versions.length, 2, 'the lost update wrote nothing');
    assert.equal(versions.versions[1]?.content, 'v2 body');

    // -- rollback v1 → NEW v3 with the ORIGINAL content; v1/v2 immutable
    const rolled = await fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}/rollback`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, expectedVersion: 2, toVersion: 1 }),
    });
    assert.equal(rolled.status, 200);
    const rolledBody = (await rolled.json()) as { document: { version: number; content: string; title: string } };
    assert.equal(rolledBody.document.version, 3);
    assert.equal(rolledBody.document.content, 'v1 body');
    assert.equal(rolledBody.document.title, 'Live migration report');
    versions = (await (await fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}/versions?chatId=${chatId}`))).json()) as { versions: Array<{ version: number; content: string }> };
    assert.deepEqual(versions.versions.map((v) => v.version), [1, 2, 3]);
    assert.deepEqual(versions.versions.map((v) => v.content), ['v1 body', 'v2 body', 'v1 body']);
    revisions = (await (await fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}/revisions?chatId=${chatId}`))).json()) as { revisions: Array<{ source: string; fromVersion: number | null; toVersion: number; summary: string }> };
    assert.equal(revisions.revisions.length, 3, 'one revision per mutating write: create, update, rollback');
    assert.equal(revisions.revisions[0]?.source, 'agent');
    assert.equal(revisions.revisions[1]?.source, 'user', 'the versioned update carried source user');
    assert.equal(revisions.revisions[1]?.toVersion, 2);
    assert.equal(revisions.revisions[2]?.toVersion, 3, 'rollback is its own revision 2→3');
    const singleV1 = (await (await fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}/versions/1?chatId=${chatId}`))).json()) as { version: { content: string } };
    assert.equal(singleV1.version.content, 'v1 body', 'history immutable');

    // -- concurrent identical addLink: all succeed with the SAME link id
    const linkAttempts = await Promise.all(
      [1, 2, 3].map(() =>
        fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}/links`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, targetType: 'chat', targetId: `${chatId}-child` }),
        }).then(async (response) => ({ status: response.status, body: (await response.json()) as { link?: { id: string } } })),
      ),
    );
    for (const attempt of linkAttempts) {
      assert.ok([200, 201].includes(attempt.status), `link attempt status ${String(attempt.status)} body ${JSON.stringify(attempt.body)}`);
    }
    const linkIds = new Set(linkAttempts.map((attempt) => attempt.body.link?.id));
    assert.equal(linkIds.size, 1, 'idempotent: every concurrent attempt resolves the same winner link');
    const links = (await (await fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}/links?chatId=${chatId}`))).json()) as { links: Array<{ id: string }> };
    assert.equal(links.links.length, 1);

    // Ownership: a foreign chat id reads as the fixed 404 (no existence leak).
    const foreign = await fetch(chatUrl(stack.port, 'orchestrator', `/work-docs/${docId}?chatId=p4-other-chat`));
    assert.equal(foreign.status, 404);
  } finally {
    await stack.close();
  }
});

test('live sync delegation: same-REST child chat, signed contexts, deterministic idempotency key', { timeout: 30_000 }, async () => {
  const model = createMockModel({ steps: [textStep('Live child answer text')] });
  const stack = await createPhase4Stack({ label: 'sync', model: model as unknown as LanguageModel });
  try {
    const parentChatId = `p4-${RUN_ID}-syncp`;
    trackChat('orchestrator', parentChatId);
    const seeded = userMessageLive('please summarize the migration notes', 'pm-sync');
    await stack.store.appendMessage({ slug: 'orchestrator', chatId: parentChatId }, seeded);

    const created = await fetch(chatUrl(stack.port, 'orchestrator', '/delegations'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [DELEGATION_CONTEXT_HEADER]: stack.createHeader(parentChatId, 0) },
      body: JSON.stringify({
        parentChatId,
        parentMessageId: 'pm-sync',
        target: 'researcher',
        task: 'Live delegated task: summarize the recorded migration notes.',
        mode: 'sync',
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { delegation: CoreDelegation & { result?: string }; childChatId: string };
    const row = createdBody.delegation;
    trackedDelegationIds.push(row.id);
    trackChat('researcher', row.childChatId);
    trackIdempotency('researcher', row.childChatId, `${row.childChatId}:${row.id}`); // deterministic child key (chat id twice by design)
    assert.equal(row.status, 'completed');
    assert.equal(row.result, 'Live child answer text');
    assert.equal(row.depth, 1);

    // The child chat is a REAL chat at the same REST endpoint with the
    // DETERMINISTIC idempotency key (childChatId:delegationId).
    const childHydration = await fetch(chatUrl(stack.port, 'researcher', `/chat/${row.childChatId}`));
    assert.equal(childHydration.status, 200);
    const childBody = (await childHydration.json()) as { messages: UIMessage[] };
    assert.equal(childBody.messages.length, 2, 'real persisted child user + assistant');
    assert.equal(childBody.messages[0]?.id, row.id, 'child user message id DERIVED from the delegation id');
    assert.equal(childBody.messages[0]?.role, 'user');
    assert.ok(JSON.stringify(childBody.messages[0]).includes('summarize the recorded migration notes'));
    assert.ok(JSON.stringify(childBody.messages[1]).includes('Live child answer text'));

    // The route stores `idempotencyKey(chat, headerKey)` where headerKey =
    // `${chatId}:${messageId}` — the chat id appears twice in the Redis key
    // by design (same as the Phase 2 live suite).
    const childIdemKey = `${REDIS_KEY_PREFIX}:idempotency:researcher:${row.childChatId}:${row.childChatId}:${row.id}`;
    trackIdempotency('researcher', row.childChatId, `${row.childChatId}:${row.id}`);
    const idemRaw = await stack.base.get(childIdemKey);
    assert.equal(idemRaw, '1', 'the child generation used the deterministic Idempotency-Key through the real route');
    const idemTtl = await stack.base.ttl(childIdemKey);
    assert.ok(idemTtl > 800 && idemTtl <= 900, `child idempotency TTL ~900s, got ${String(idemTtl)}s`);

    // NO direct child generation: the parent orchestrator chat never generated,
    // and exactly ONE model invocation happened (the child's).
    const parentHydration = await fetch(chatUrl(stack.port, 'orchestrator', `/chat/${parentChatId}`));
    const parentBody = (await parentHydration.json()) as { messages: UIMessage[] };
    assert.equal(parentBody.messages.length, 1, 'parent transcript is just the seeded user turn');
    assert.equal((model as unknown as { doStreamCalls: unknown[] }).doStreamCalls.length, 1, 'exactly one child generation');

    // Detail route shows the completed row with result + child link.
    const detail = await getDelegationDetail(stack.port, row.id);
    assert.equal(detail?.status, 'completed');
    assert.equal(detail?.result, 'Live child answer text');
    assert.equal(detail?.childChatId, row.childChatId);
  } finally {
    await stack.close();
  }
});

test('live async delegation: real BullMQ queue + worker drive the OWN run REST; terminal rerun is a no-op', { timeout: 45_000 }, async () => {
  const model = createMockModel({ steps: [textStep('Async worker answer')] });
  const stack = await createPhase4Stack({ label: 'async', model: model as unknown as LanguageModel, withQueue: true });
  try {
    const parentChatId = `p4-${RUN_ID}-asyncp`;
    trackChat('orchestrator', parentChatId);
    await stack.store.appendMessage({ slug: 'orchestrator', chatId: parentChatId }, userMessageLive('async please', 'pm-async'));

    const created = await fetch(chatUrl(stack.port, 'orchestrator', '/delegations'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [DELEGATION_CONTEXT_HEADER]: stack.createHeader(parentChatId, 0) },
      body: JSON.stringify({
        parentChatId,
        parentMessageId: 'pm-async',
        target: 'researcher',
        task: 'Async live task: check the delegation queue path.',
        mode: 'async',
      }),
    });
    assert.equal(created.status, 202);
    const createdBody = (await created.json()) as { delegation: CoreDelegation };
    const row = createdBody.delegation;
    trackedDelegationIds.push(row.id);
    trackChat('researcher', row.childChatId);
    trackIdempotency('researcher', row.childChatId, `${row.childChatId}:${row.id}`);
    assert.equal(row.status, 'pending');

    // The REAL worker picks the REAL BullMQ job and runs the OWN run REST.
    await waitFor(
      async () => (await getDelegationDetail(stack.port, row.id))?.status === 'completed',
      30_000,
      'async delegation never completed through the real worker',
    );
    const detail = await getDelegationDetail(stack.port, row.id);
    assert.equal(detail?.result, 'Async worker answer');
    assert.ok(detail?.completedAt !== null && detail?.completedAt !== undefined);

    // REAL BullMQ evidence: the deterministic job exists in COMPLETED state.
    assert.ok(stack.queue !== null);
    const delegationQueue = stack.queue as import('../src/agents/delegation-queue.js').BullMQDelegationJobQueue;
    const job = await delegationQueue.queue.getJob(delegationJobId(row.id));
    assert.ok(job !== undefined && job !== null, 'deterministic job id exists on the real queue');
    assert.equal(await job.getState(), 'completed');

    const childHydration = await fetch(chatUrl(stack.port, 'researcher', `/chat/${row.childChatId}`));
    const childBody = (await childHydration.json()) as { messages: UIMessage[] };
    assert.equal(childBody.messages.length, 2);
    assert.equal(childBody.messages[0]?.id, row.id, 'deterministic child id through the queue path too');

    // Re-run on the terminal row: executed:false, ZERO additional generation.
    const rerun = await fetch(chatUrl(stack.port, 'orchestrator', `/delegations/${row.id}/run`), {
      method: 'POST',
      headers: { [DELEGATION_CONTEXT_HEADER]: stack.createHeader(row.parentChatId, row.depth - 1) },
    });
    assert.equal(rerun.status, 200);
    const rerunBody = (await rerun.json()) as { executed: boolean };
    assert.equal(rerunBody.executed, false);
    const afterRerun = await fetch(chatUrl(stack.port, 'researcher', `/chat/${row.childChatId}`));
    const afterRerunBody = (await afterRerun.json()) as { messages: UIMessage[] };
    assert.equal(afterRerunBody.messages.length, 2);
    assert.equal((model as unknown as { doStreamCalls: unknown[] }).doStreamCalls.length, 1, 'no second child generation');
  } finally {
    await stack.close();
  }
});

test('live pending claim race: two concurrent /run on ONE pending row — one execution, Prisma CAS decides', { timeout: 30_000 }, async () => {
  const model = createMockModel({ steps: [textStep('Race winner answer')] });
  const stack = await createPhase4Stack({ label: 'race', model: model as unknown as LanguageModel });
  try {
    const parentChatId = `p4-${RUN_ID}-racep`;
    trackChat('orchestrator', parentChatId);
    await stack.store.appendMessage({ slug: 'orchestrator', chatId: parentChatId }, userMessageLive('race seed', 'pm-race'));

    // Created DIRECTLY through the real Prisma repository: the async worker
    // cannot consume this row first (sync mode; never enqueued).
    const row = await createDirectDelegation(stack.repo, parentChatId, `p4-${RUN_ID}-racechild`, 'researcher', 'sync');
    trackChat('researcher', row.childChatId);
    trackIdempotency('researcher', row.childChatId, `${row.childChatId}:${row.id}`);
    assert.equal(row.status, 'pending');

    const runHeader = stack.createHeader(row.parentChatId, row.depth - 1);
    const [first, second] = await Promise.all([
      fetch(chatUrl(stack.port, 'orchestrator', `/delegations/${row.id}/run`), {
        method: 'POST',
        headers: { [DELEGATION_CONTEXT_HEADER]: runHeader },
      }),
      fetch(chatUrl(stack.port, 'orchestrator', `/delegations/${row.id}/run`), {
        method: 'POST',
        headers: { [DELEGATION_CONTEXT_HEADER]: runHeader },
      }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstBody = (await first.json()) as { executed: boolean };
    const secondBody = (await second.json()) as { executed: boolean };
    assert.deepEqual([firstBody.executed, secondBody.executed].sort(), [false, true], 'exactly one runner claimed and executed');

    const detail = await getDelegationDetail(stack.port, row.id);
    assert.equal(detail?.status, 'completed');
    assert.equal(detail?.result, 'Race winner answer');

    const childHydration = await fetch(chatUrl(stack.port, 'researcher', `/chat/${row.childChatId}`));
    const childBody = (await childHydration.json()) as { messages: UIMessage[] };
    assert.equal(childBody.messages.length, 2, 'exactly ONE child generation under real Prisma CAS');
    assert.equal((model as unknown as { doStreamCalls: unknown[] }).doStreamCalls.length, 1);
  } finally {
    await stack.close();
  }
});

test('live ask_user byte-CAS: real Redis keeps options:[] arrays and huge literals byte-exact; newest answer + older sentinel', { timeout: 30_000 }, async () => {
  const model = createMockModel({ steps: [textStep('resumed after the answer'), textStep('continue answer')] });
  const stack = await createPhase4Stack({ label: 'hitl', model: model as unknown as LanguageModel });
  try {
    const slug = 'orchestrator';
    const chatId = `p4-${RUN_ID}-hitl`;
    trackChat(slug, chatId);
    trackIdempotency(slug, chatId, 'answer-1');
    const messagesKey = `${REDIS_KEY_PREFIX}:chat:${slug}:${chatId}:messages`;

    // Older pending: raw entry with a huge numeric literal + options:[] array —
    // the exact bytes the old cjson script would corrupt.
    const olderRaw =
      `{"id":"a-older","meta":{"big":12345678901234567890,"tiny":1.5},"role":"assistant",` +
      `"parts":[{"type":"tool-ask_user","toolCallId":"tc-old","state":"input-available",` +
      `"input":{"question":"Old byte question","options":[]}}]}`;
    const baseEntries = await stack.base.lRange(messagesKey, 0, -1);
    assert.equal(baseEntries.length, 0);
    await stack.base.rPush(messagesKey, olderRaw);
    await stack.base.rPush(messagesKey, JSON.stringify(userMessageLive('moving on', 'u-between')));

    // Newest pending: a REAL pending ask_user (normal object path).
    await stack.store.appendMessage(
      { slug, chatId },
      {
        id: 'a-newest',
        role: 'assistant',
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'tc-new',
            state: 'input-available',
            input: { question: 'Newest question', options: [] },
          },
        ],
      } as unknown as UIMessage,
    );

    // The answer turn through the REAL HTTP route: newest gets the real user
    // text, the older pending gets the bounded sentinel — both byte-CAS.
    const answered = await postChatMessage(stack.port, slug, chatId, userMessageLive('the real answer', 'answer-1'));
    assert.equal(answered.status, 200);
    const resumedChunks = await answered.text();
    assert.ok(resumedChunks.includes('resumed after the answer'), 'generation resumed over the full answered transcript');

    // RAW byte assertions on the OLD entry: only state + output changed.
    const entries = await stack.base.lRange(messagesKey, 0, -1);
    assert.equal(JSON.parse(entries[0] as string).id, 'a-older');
    const oldRaw = entries[0] as string;
    assert.ok(oldRaw.includes('"big":12345678901234567890'), 'huge numeric literal digit-exact (no cjson)');
    assert.ok(oldRaw.includes('"tiny":1.5'), 'decimal literal preserved');
    assert.ok(oldRaw.includes('"options":[]'), 'options stays an ARRAY, never {}');
    assert.ok(oldRaw.includes('"state":"output-available"'));
    assert.ok(oldRaw.includes('"output":{"answer":"(no answer given)"}'), 'older pending got the bounded sentinel');
    assert.ok(oldRaw.split('"output"').length === 2, 'exactly one output was inserted');
    assert.equal(JSON.parse(entries[1] as string).id, 'u-between', 'user messages untouched');
    const newestRaw = entries[2] as string;
    assert.ok(newestRaw.includes('"state":"output-available"'));
    assert.ok(newestRaw.includes('"output":{"answer":"the real answer"}'), 'newest pending got the real answer');

    // Hydration + conversion stay valid: the model call for THIS turn consumed
    // the resumed step over the answered transcript.
    assert.equal((model as unknown as { doStreamCalls: unknown[] }).doStreamCalls.length, 1);
    const nextTurn = await postChatMessage(stack.port, slug, chatId, userMessageLive('continue', 'u-next'));    assert.equal(nextTurn.status, 200, 'subsequent conversion over the answered transcript is valid');
    assert.ok(await nextTurn.text());
    trackIdempotency(slug, chatId, 'u-next');
    const count = await stack.base.lLen(messagesKey);
    assert.equal(count, 7, `append-only: exactly the seven entries [older, u-between, newest, answer u, resumed a, u-next, continue a] (got ${String(count)})`);
  } finally {
    await stack.close();
  }
});

test('live ask_user real concurrent race: CAS yields applied+unchanged and never corrupts', { timeout: 15_000 }, async () => {
  const model = createMockModel({ steps: [textStep('unused')] });
  const stack = await createPhase4Stack({ label: 'hitl-race', model: model as unknown as LanguageModel });
  try {
    const slug = 'orchestrator';
    const chatId = `p4-${RUN_ID}-hitlrace`;
    trackChat(slug, chatId);
    const messagesKey = `${REDIS_KEY_PREFIX}:chat:${slug}:${chatId}:messages`;
    await stack.store.appendMessage(
      { slug, chatId },
      {
        id: 'a-race',
        role: 'assistant',
        parts: [
          { type: 'tool-ask_user', toolCallId: 'tc-race', state: 'input-available', input: { question: 'Race', options: [] } },
        ],
      } as unknown as UIMessage,
    );

    // Two REAL concurrent store CAS calls for the SAME pending part.
    const [first, second] = await Promise.all([
      stack.store.answerPendingAskUser({ slug, chatId }, 'a-race', 'tc-race', 'answer-one'),
      stack.store.answerPendingAskUser({ slug, chatId }, 'a-race', 'tc-race', 'answer-two'),
    ]);
    const outcomes = [first, second].sort();
    assert.deepEqual(outcomes, ['applied', 'unchanged'], 'exactly one CAS wins; the loser re-reads and is a typed no-op');

    const entries = await stack.base.lRange(messagesKey, 0, -1);
    const raw = entries[0] as string;
    const parsed = JSON.parse(raw) as { parts: Array<{ state?: string; output?: { answer?: string } }> };
    assert.equal(parsed.parts[0]?.state, 'output-available');
    assert.ok(
      parsed.parts[0]?.output?.answer === 'answer-one' || parsed.parts[0]?.output?.answer === 'answer-two',
      `exactly one answer persisted, got ${String(parsed.parts[0]?.output?.answer)}`,
    );
    assert.equal(raw.split('"output"').length, 2, 'zero merge duplication / zero corruption');
    assert.ok(raw.includes('"options":[]'));
  } finally {
    await stack.close();
  }
});

test('live running recovery: deterministic child id; stale+transcript recovers; stale-without-transcript fails; terminal untouched', { timeout: 30_000 }, async () => {
  const model = createMockModel({ steps: [textStep('Recovered transcript answer')] });
  const stack = await createPhase4Stack({ label: 'recover', model: model as unknown as LanguageModel, delegationTimeoutMs: 700 });
  try {
    const parentChatId = `p4-${RUN_ID}-recoverp`;
    trackChat('orchestrator', parentChatId);
    await stack.store.appendMessage({ slug: 'orchestrator', chatId: parentChatId }, userMessageLive('recover', 'pm-rec'));

    // -- (a) A real run builds a completed child transcript, then the row is
    //        set back to stale running via REAL DB timestamps (no sleeping).
    const row = await createDirectDelegation(stack.repo, parentChatId, `p4-${RUN_ID}-recchild`, 'researcher', 'sync');
    trackChat('researcher', row.childChatId);
    trackIdempotency('researcher', row.childChatId, `${row.childChatId}:${row.id}`);
    const runOne = await fetch(chatUrl(stack.port, 'orchestrator', `/delegations/${row.id}/run`), {
      method: 'POST',
      headers: { [DELEGATION_CONTEXT_HEADER]: stack.createHeader(row.parentChatId, row.depth - 1) },
    });
    assert.equal(runOne.status, 200);
    const runOneBody = (await runOne.json()) as { executed: boolean; delegation: CoreDelegation };
    assert.equal(runOneBody.executed, true);
    assert.equal(runOneBody.delegation.status, 'completed');
    const childHydration = await fetch(chatUrl(stack.port, 'researcher', `/chat/${row.childChatId}`));
    const childBody = (await childHydration.json()) as { messages: UIMessage[] };
    assert.equal(childBody.messages.length, 2);
    assert.equal(childBody.messages[0]?.id, row.id, 'deterministic child message id (delegation.id)');

    await prisma.delegation.update({
      where: { id: row.id },
      data: { status: 'running', result: null, completedAt: null, updatedAt: new Date(Date.now() - 5_000) },
    });

    const recovered = await fetch(chatUrl(stack.port, 'orchestrator', `/delegations/${row.id}/run`), {
      method: 'POST',
      headers: { [DELEGATION_CONTEXT_HEADER]: stack.createHeader(row.parentChatId, row.depth - 1) },
    });
    assert.equal(recovered.status, 200);
    const recoveredBody = (await recovered.json()) as { executed: boolean; delegation: CoreDelegation };
    assert.equal(recoveredBody.executed, false, 'recovery never starts another child generation');
    assert.equal(recoveredBody.delegation.status, 'completed');
    assert.equal(recoveredBody.delegation.result, 'Recovered transcript answer', 'answer recovered from the durable child transcript');

    // -- (b) stale running WITHOUT any child transcript → failed (fixed text).
    const emptyRow = await createDirectDelegation(stack.repo, parentChatId, `p4-${RUN_ID}-recempty`, 'analyst', 'sync');
    trackChat('analyst', emptyRow.childChatId);
    trackIdempotency('analyst', emptyRow.childChatId, `${emptyRow.childChatId}:${emptyRow.id}`);
    await prisma.delegation.update({
      where: { id: emptyRow.id },
      data: { status: 'running', updatedAt: new Date(Date.now() - 5_000) },
    });
    const failed = await fetch(chatUrl(stack.port, 'orchestrator', `/delegations/${emptyRow.id}/run`), {
      method: 'POST',
      headers: { [DELEGATION_CONTEXT_HEADER]: stack.createHeader(emptyRow.parentChatId, emptyRow.depth - 1) },
    });
    assert.equal(failed.status, 200);
    const failedBody = (await failed.json()) as { executed: boolean; delegation: CoreDelegation };
    assert.equal(failedBody.executed, false);
    assert.equal(failedBody.delegation.status, 'failed');
    assert.equal(failedBody.delegation.error, 'The delegated task failed.');
    const emptyChild = await fetch(chatUrl(stack.port, 'analyst', `/chat/${emptyRow.childChatId}`));
    const emptyChildBody = (await emptyChild.json()) as { messages: UIMessage[] };
    assert.equal(emptyChildBody.messages.length, 0, 'no child generation happened for the recovery path');

    // -- (c) terminal row stays untouched (and unchanged on a later hydration).
    const after = await prisma.delegation.findUnique({ where: { id: row.id } });
    assert.equal(after?.result, 'Recovered transcript answer');
    const terminal = await fetch(chatUrl(stack.port, 'orchestrator', `/delegations/${row.id}/run`), {
      method: 'POST',
      headers: { [DELEGATION_CONTEXT_HEADER]: stack.createHeader(row.parentChatId, row.depth - 1) },
    });
    const terminalBody = (await terminal.json()) as { executed: boolean; delegation: CoreDelegation };
    assert.equal(terminalBody.executed, false);
    assert.equal(terminalBody.delegation.result, 'Recovered transcript answer');
    assert.equal((model as unknown as { doStreamCalls: unknown[] }).doStreamCalls.length, 1, 'only the one real child generation');
  } finally {
    await stack.close();
  }
});

test('live query_data: real read-only pool recovery, dangerous-function screening, row cap, statement timeout', { timeout: 45_000 }, async () => {
  const model = createMockModel({ steps: [textStep('unused')] });
  const stack = await createPhase4Stack({
    label: 'query',
    model: model as unknown as LanguageModel,
    dataQuery: { poolMax: 1, rowCap: 3, statementTimeoutMs: 700 },
  });
  try {
    const queryUrl = chatUrl(stack.port, 'analyst', '/data/query');
    const post = async (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(queryUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    // -- valid SELECT works over REAL Postgres (memory tables exist).
    const ok = await post({ query: 'SELECT COUNT(*)::int AS total FROM "MemoryBlock"' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body['columns'], ['total']);
    assert.equal(ok.body['truncated'], false);

    // -- dangerous session-state functions rejected before the DB.
    const advisory = await post({ query: 'SELECT pg_advisory_lock(1)' });
    assert.equal(advisory.status, 400);
    assert.deepEqual(advisory.body, { error: 'Invalid data query.' });
    const sleep = await post({ query: 'SELECT pg_sleep(5)' });
    assert.equal(sleep.status, 400);
    assert.deepEqual(sleep.body, { error: 'Invalid data query.' });
    const guc = await post({ query: 'SELECT set_config(\'search_path\', \'public\', false)' });
    assert.equal(guc.status, 400);
    assert.deepEqual(guc.body, { error: 'Invalid data query.' });
    // Advisory locks could not be leaked into the pool: run a real check.
    const locks = await prisma.$queryRaw<Array<{ held: number }>>`
      SELECT COUNT(*)::int AS held FROM pg_locks WHERE locktype = 'advisory'`;
    assert.equal(Number(locks[0]?.held ?? 0), 0, 'no advisory locks leaked into the pool');

    // -- syntax error then valid on the SAME pool (max 1 client): B1 recovery.
    const syntax = await post({ query: 'SELECT fropm FROM "MemoryBlock"' });
    assert.equal(syntax.status, 503);
    assert.deepEqual(syntax.body, { error: 'Data query service is temporarily unavailable.' });
    const recovered = await post({ query: 'SELECT COUNT(*)::int AS total FROM "MemoryBlock"' });
    assert.equal(recovered.status, 200, 'the pooled client recovered after the aborted transaction');
    assert.deepEqual(recovered.body['columns'], ['total']);

    // -- over-cap: cap+1 detection → fixed 400, never truncation; then recovery.
    const overCap = await post({ query: 'SELECT generate_series(1, 10) AS g' });
    assert.equal(overCap.status, 400);
    assert.deepEqual(overCap.body, { error: 'Data query exceeded the row cap.' });
    const capped = await post({ query: 'SELECT generate_series(1, 2) AS g' });
    assert.equal(capped.status, 200);
    assert.equal(capped.body['rowCount'], 2);
    assert.equal(capped.body['truncated'], false);

    // -- statement timeout fires on an expensive deterministic COUNT, then the
    //    same pool serves a valid query again.
    const slow = await post({ query: 'SELECT COUNT(*)::int AS n FROM generate_series(1, 50000000) AS g' });
    assert.equal(slow.status, 503);
    assert.deepEqual(slow.body, { error: 'Data query timed out.' });
    const afterTimeout = await post({ query: 'SELECT COUNT(*)::int AS total FROM "MemoryBlock"' });
    assert.equal(afterTimeout.status, 200, 'pool client recovered after the statement timeout');

    // -- no SQL / driver internals ever in a response body.
    const leakCheck = JSON.stringify([overCap.body, slow.body, syntax.body]);
    assert.match(leakCheck, /Invalid data query\.|Data query (exceeded the row cap\.|timed out\.)|temporarily unavailable\./);
    assert.doesNotMatch(leakCheck, /SELECT|generate_series|pg_|statement_timeout/i);
  } finally {
    await stack.close();
  }
});
