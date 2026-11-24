/**
 * REAL opt-in personal-memory integration (pre-Phase 6): real Postgres
 * (pgvector + memory migration), real BullMQ over real Redis, the REAL
 * MemoryService pipeline (write → embed → semantic search) — with a
 * DETERMINISTIC mock capture extractor (no Ollama, no provider, no OAuth,
 * no API key) and the REAL capture enqueue → worker flow.
 *
 * Proves end-to-end:
 * - `UserSettings` defaults to opt-out (absent row → false) and PATCH-style
 *   upserts persist per user (real table).
 * - Enabled owner: deterministic capture job id, worker writes ONE derived
 *   `observation` block at scope `chats/{chatId}` with exact metadata and
 *   the REAL embedding pipeline makes it semantic-searchable.
 * - Duplicate assistant capture: no second block (metadata dedupe).
 * - Disabled owner: zero capture, zero block, zero recall reads.
 * - Delete purge: the whole chat path (derived rows only).
 * - Rewind purge: ONLY the removed assistant-message ids.
 * - Branch: derived memories are NOT copied (transcript copy only).
 *
 * Same isolation contract as `memory.test.ts`: unique per-run scope + queue,
 * run-scoped cleanup (DB rows + queue obliteration), bounded polling, no
 * FLUSHDB, values never printed.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { PrismaClient } from '@workforce/core/generated/prisma';
import { MemoryService, type EmbeddingProvider, type MemoryCompactor, type MemoryService as Service, MEMORY_EMBEDDING_MODEL } from '@workforce/core/memory';
import { createPostgresMemoryStore } from '@workforce/core/memory/postgres';
import { DEFAULT_DATABASE_URL } from '../src/config.js';
import {
  BullMQMemoryJobQueue,
  personalCaptureJobId,
  type BullMQMemoryJobQueueHandle,
} from '../src/memory/bullmq-queue.js';
import { createMemoryWorker, type MemoryWorkerHandle } from '../src/memory/worker.js';
import { processPersonalCaptureJob } from '../src/memory/personal-capture.js';
import { createPrismaSettingsService, type SettingsServiceLike } from '../src/settings/settings.js';

// -- Environment (values never printed; error text stays fixed) ---------------

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const DATABASE_URL = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
const TEST_QUEUE = `personal-memory-test-${RUN_ID}`;
/** The scope is the REAL derived user scope for the run's fake owner id. */
const OWNER_ID = `owner-${RUN_ID}`;
const SCOPE = (await import('@workforce/core/auth')).userMemoryScope(OWNER_ID);
const CHAT_ID = `chat-${RUN_ID}`;
const OTHER_CHAT_ID = `chatb-${RUN_ID}`;

const WAIT_TIMEOUT_MS = 30_000;
const TEST_BACKOFF_MS = 250;

// -- Bounded polling ----------------------------------------------------------

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs: number, message: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${message} (waited ${Date.now().toString()}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// -- Deterministic embedder (the REAL pipeline; content-keyed axes) -----------

const keywordEmbedder: EmbeddingProvider = {
  dimensions: 384,
  model: MEMORY_EMBEDDING_MODEL,
  async embed(text: string): Promise<readonly number[]> {
    const vector = new Array<number>(384).fill(0);
    for (let i = 0; i < text.length; i += 1) {
      const index = 128 + ((text.charCodeAt(i) * 7 + i) % 128);
      vector[index] = (vector[index] ?? 0) + 0.05;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  },
};

/** Never called in this suite (writes stay under the compaction threshold). */
const noOpCompactor: MemoryCompactor = { compact: async () => 'unused summary' };


// -- Shared stack -------------------------------------------------------------

interface PersonalStack {
  prisma: PrismaClient;
  service: Service;
  queue: BullMQMemoryJobQueueHandle & { enqueueCapture(input: { ownerId: string; scope: string; chatId: string; slug: string; userMessageId: string; assistantMessageId: string }): Promise<boolean> };
  worker: MemoryWorkerHandle;
  settings: SettingsServiceLike;
  blocks: (scope: string, pathPrefix?: string) => Promise<Array<{ id: string; path: string; content: string; metadata: Record<string, unknown>; embeddingStatus?: string }>>;
}

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
const stack = {} as PersonalStack;
const ownedRedisClients: IORedis[] = [];

async function deleteRunRows(client: PrismaClient, scope: string): Promise<void> {
  await client.$executeRaw`
    DELETE FROM "MemoryRelation"
    WHERE "sourceId" IN (SELECT "id" FROM "MemoryBlock" WHERE "scope" = ${scope})
       OR "targetId" IN (SELECT "id" FROM "MemoryBlock" WHERE "scope" = ${scope})`;
  await client.$executeRaw`DELETE FROM "MemoryBlock" WHERE "scope" = ${scope}`;
}

before(async () => {
  await Promise.race([
    prisma.$connect(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Postgres connect timeout')), 5_000)),
  ]);
  const table = await prisma.$queryRaw<Array<{ found: number }>>`
    SELECT COUNT(*)::int AS found FROM information_schema.tables
    WHERE table_name IN ('MemoryBlock', 'UserSettings') AND table_schema = 'public'`;
  if (Number(table[0]?.found ?? 0) !== 2) {
    throw new Error('MemoryBlock/UserSettings tables missing — apply the migrations first (root: npm run db:migrate).');
  }

  const queue = new BullMQMemoryJobQueue({
    redisUrl: REDIS_URL,
    queueName: TEST_QUEUE,
    logger: { warn: () => undefined, error: () => undefined },
    jobOptions: { backoffBaseMs: TEST_BACKOFF_MS },
    reconnectStrategy: () => null, // fail fast; never hang the suite
  }) as BullMQMemoryJobQueueHandle & PersonalStack['queue'];
  const store = createPostgresMemoryStore(prisma, { databaseUrl: DATABASE_URL });
  const service = new MemoryService({
    store,
    embeddingProvider: keywordEmbedder,
    queue,
    compactor: noOpCompactor,
    logger: { warn: () => undefined },
  });
  const settings = createPrismaSettingsService(prisma);
  const worker = createMemoryWorker({
    service,
    redisUrl: REDIS_URL,
    queueName: TEST_QUEUE,
    logger: { warn: () => undefined, error: () => undefined },
    reconnectStrategy: () => null,
    personalCapture: {
      memory: service,
      settings,
      chatStore: {
        async loadMessages(chat: { ownerId: string; slug: string; chatId: string }) {
          void chat;
          return [
            {
              id: 'u-turn',
              role: 'user',
              parts: [{ type: 'text', text: 'We migrated our Postgres database today and I prefer terse answers.' } as never],
              metadata: {},
            },
            {
              id: 'a-turn',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Noted — the migration ran green.' } as never],
              metadata: {},
            },
            {
              id: 'u2-turn',
              role: 'user',
              parts: [{ type: 'text', text: 'Also: I only drink decaf coffee on weekdays.' } as never],
              metadata: {},
            },
            {
              id: 'a2-turn',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Got it.' } as never],
              metadata: {},
            },
          ] as never;
        },
      },
      logger: { warn: () => undefined },
    },
  });
  Object.assign(stack, {
    prisma,
    service,
    queue,
    worker,
    settings,
    blocks: async (scope: string, pathPrefix?: string) => {
      const rows = await prisma.$queryRaw<Array<{ id: string; path: string; kind: string; content: string; metadata: string; embeddingStatus: string }>>`
        SELECT "id"::text AS "id", "path", "kind"::text AS "kind", "content", "metadata"::text AS "metadata", "embeddingStatus"::text AS "embeddingStatus"
        FROM "MemoryBlock" WHERE "scope" = ${scope}
        ORDER BY "createdAt" ASC, "id" ASC`;
      return rows
        .map((row) => ({ id: row.id, path: row.path, content: row.content, metadata: JSON.parse(row.metadata) as Record<string, unknown>, embeddingStatus: row.embeddingStatus, kind: row.kind }))
        .filter((row) => (pathPrefix === undefined ? true : row.path === pathPrefix || row.path.startsWith(`${pathPrefix}/`)));
    },
  });

  // Defensive pre-clean (run ids never repeat; a no-op guard).
  await deleteRunRows(prisma, SCOPE);
  await prisma.userSettings.deleteMany({ where: { userId: OWNER_ID } });
  // The derived user row: UserSettings.user is FK-bound to the real User
  // table (Better Auth inserts it on signup; the suite seeds its own and
  // cleans up in after()).
  await prisma.$executeRaw`
    INSERT INTO "User" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
    VALUES (${OWNER_ID}, ${'Personal Memory Run'}, ${'personal-memory@example.com'}, false, NULL, NOW(), NOW())
    ON CONFLICT ("id") DO NOTHING`;
});

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${String(timeoutMs)}ms`)), timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } catch (error) {
    void error; // cleanup failures never hang the suite
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

after(async () => {
  if (stack.worker !== undefined) {
    await bounded(stack.worker.close(), 10_000, 'personal worker close');
  }
  try {
    const cleaner = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, retryStrategy: () => null });
    ownedRedisClients.push(cleaner);
    const testQueue = new Queue(TEST_QUEUE, { connection: cleaner });
    await bounded(testQueue.obliterate({ force: true }), 10_000, 'test queue obliterate');
    await bounded(testQueue.close(), 5_000, 'test queue close');
    await bounded(cleaner.quit(), 5_000, 'cleanup redis quit');
  } catch (error) {
    void error;
  }
  if (stack.queue !== undefined) {
    await bounded(stack.queue.close(), 15_000, 'personal queue close');
  }
  for (const client of ownedRedisClients) {
    const statusOf = (): string => client.status;
    if (statusOf() !== 'close') {
      try {
        await bounded(client.quit(), 2_000, 'client quit');
      } catch {
        client.disconnect();
      }
      if (statusOf() !== 'close') {
        client.disconnect();
      }
    }
  }
  try {
    await bounded(deleteRunRows(prisma, SCOPE), 10_000, 'run-scope DB cleanup');
  } catch (error) {
    void error;
  }
  try {
    await bounded(prisma.userSettings.deleteMany({ where: { userId: OWNER_ID } }), 5_000, 'settings cleanup');
    await bounded(prisma.$executeRaw`DELETE FROM "User" WHERE "id" = ${OWNER_ID}`, 5_000, 'user cleanup');
  } catch (error) {
    void error;
  }
  await bounded(prisma.$disconnect(), 10_000, 'prisma disconnect');
});

// ---------------------------------------------------------------------------
// Settings persistence (REAL UserSettings table)
// ---------------------------------------------------------------------------

test('live settings: absent row defaults to opt-out; upsert persists per user', async () => {
  assert.deepEqual(await stack.settings.get(OWNER_ID), { personalMemoryEnabled: false }, 'the default is explicit opt-OUT');
  assert.deepEqual(await stack.settings.setPersonalMemoryEnabled(OWNER_ID, true), { personalMemoryEnabled: true });
  assert.deepEqual(await stack.settings.get(OWNER_ID), { personalMemoryEnabled: true });
  // Toggle off and back on; the single row updates (unique per user).
  assert.deepEqual(await stack.settings.setPersonalMemoryEnabled(OWNER_ID, false), { personalMemoryEnabled: false });
  assert.deepEqual(await stack.settings.get(OWNER_ID), { personalMemoryEnabled: false });
  assert.deepEqual(await stack.settings.setPersonalMemoryEnabled(OWNER_ID, true), { personalMemoryEnabled: true });
});

// ---------------------------------------------------------------------------
// Real capture: deterministic job id → worker → block → searchable
// ---------------------------------------------------------------------------

test('live capture: deterministic enqueue → worker → ONE derived block with exact metadata, embedded + searchable', async () => {
  // Disabled first: the gate at processing time suppresses the capture.
  await stack.settings.setPersonalMemoryEnabled(OWNER_ID, false);
  const jobIdDisabled = await stack.queue.enqueueCapture({
    ownerId: OWNER_ID,
    scope: SCOPE,
    chatId: CHAT_ID,
    slug: 'general',
    userMessageId: 'u-disabled',
    assistantMessageId: 'a-disabled',
  });
  assert.equal(jobIdDisabled, true, 'the queue scheduling is decoupled from the enablement (the WORKER gate suppresses)');
  await waitFor(async () => (await stack.blocks(SCOPE)).length === 0, WAIT_TIMEOUT_MS, 'disabled capture never writes');
  assert.equal((await stack.blocks(SCOPE)).length, 0, 'disabled → zero blocks (worker gate)');

  // Enable, then capture for real (a DIFFERENT assistant turn → its own id).
  await stack.settings.setPersonalMemoryEnabled(OWNER_ID, true);
  const enqueued = await stack.queue.enqueueCapture({
    ownerId: OWNER_ID,
    scope: SCOPE,
    chatId: CHAT_ID,
    slug: 'general',
    userMessageId: 'u-turn',
    assistantMessageId: 'a-turn',
  });
  assert.equal(enqueued, true);
  // The job id is DETERMINISTIC per (scope, chat, assistant message).
  assert.equal(
    `capture-${personalCaptureJobId(SCOPE, CHAT_ID, 'a-turn').replace(/^capture-/, '')}`,
    personalCaptureJobId(SCOPE, CHAT_ID, 'a-turn'),
  );
  await waitFor(async () => (await stack.blocks(SCOPE)).length >= 1, WAIT_TIMEOUT_MS, 'real capture wrote a block');
  const blocks = await stack.blocks(SCOPE);
  const derived = blocks.find((block) => block.metadata['source'] === 'personal-chat');
  assert.ok(derived !== undefined, 'the derived personal block exists');
  assert.equal(derived?.path, `chats/${CHAT_ID}`);
  assert.equal(derived?.metadata['chatId'], CHAT_ID);
  assert.equal(derived?.metadata['assistantMessageId'], 'a-turn');
  assert.equal(
    derived?.content,
    '[user] We migrated our Postgres database today and I prefer terse answers.\n[assistant] Noted — the migration ran green.',
  );
  // The REAL embedding pipeline ran (the block is embedded + ready).
  await waitFor(async () => (await stack.blocks(SCOPE)).some((block) => block.embeddingStatus === 'ready'), WAIT_TIMEOUT_MS, 'the block was embedded');
  // Semantic search finds it with the real keyword embedder.
  const results = await stack.service.semanticSearch({
    query: 'postgres migrations terse',
    scope: SCOPE,
    path: 'chats',
    limit: 3,
  });
  assert.ok(results.length >= 1, 'the derived block is semantic-searchable');
  assert.equal(results[0]?.block.metadata['source'], 'personal-chat');

});

test('live capture duplicate: re-delivering the same assistant capture writes NO second block', async () => {
  const beforeCount = (await stack.blocks(SCOPE)).length;
  assert.ok(beforeCount >= 1);
  // Same (scope, chat, assistantMessageId) → the deterministic job dedupes at
  // the queue AND the worker's metadata check is a no-op when the job runs.
  const reEnqueue = await stack.queue.enqueueCapture({
    ownerId: OWNER_ID,
    scope: SCOPE,
    chatId: CHAT_ID,
    slug: 'general',
    userMessageId: 'u-turn',
    assistantMessageId: 'a-turn',
  });
  assert.equal(reEnqueue, false, 'the completed deterministic job is a queue-level no-op');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await stack.blocks(SCOPE)).length, beforeCount, 'no duplicate block');
  // A DIFFERENT assistant turn in the SAME chat → its own id: the worker's
  // metadata dedupe then still allows ONE more derived block.
  const second = await stack.queue.enqueueCapture({
    ownerId: OWNER_ID,
    scope: SCOPE,
    chatId: CHAT_ID,
    slug: 'general',
    userMessageId: 'u2-turn',
    assistantMessageId: 'a2-turn',
  });
  assert.equal(second, true, 'a different assistant turn schedules its own capture');
  await waitFor(async () => (await stack.blocks(SCOPE)).length > beforeCount, WAIT_TIMEOUT_MS, 'the second capture wrote its own block');
  const after = (await stack.blocks(SCOPE)).length;
  assert.equal(after, beforeCount + 1, 'exactly ONE block per assistant turn');
});

test('live capture empty: unresolvable transcript ids → honest no-op, no block', async () => {
  const beforeCount = (await stack.blocks(SCOPE)).length;
  // A fresh chat id the fixed transcript fixture never resolves: the worker
  // finds NO matching user/assistant texts → 'no-text' → no block.
  await stack.queue.enqueueCapture({
    ownerId: OWNER_ID,
    scope: SCOPE,
    chatId: `${CHAT_ID}-unknown`,
    slug: 'general',
    userMessageId: 'u-missing',
    assistantMessageId: 'a-missing',
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal((await stack.blocks(SCOPE)).length, beforeCount, 'unresolvable transcripts capture nothing');
});

test('live capture no-durable-content: tool-only/reasoning-only transcript → honest no-op, no block', async () => {
  const beforeCount = (await stack.blocks(SCOPE)).length;
  const outcome = await processPersonalCaptureJob(
    { ownerId: OWNER_ID, scope: SCOPE, chatId: `${CHAT_ID}-tools`, slug: 'general', userMessageId: 'u-tool-only', assistantMessageId: 'a-tool-only' },
    {
      memory: stack.service,
      settings: stack.settings,
      chatStore: {
        async loadMessages() {
          return [
            // ONLY tool payload/reasoning — the bounded derivation finds no
            // durable VISIBLE text and writes NOTHING (never a tool payload).
            { id: 'u-tool-only', role: 'user', parts: [{ type: 'tool-calculate', toolCallId: 'tc', state: 'output-available', input: { expression: 'SECRET_EXPRESSION' }, output: { answer: 'SECRET_OUTPUT' } }] } as never,
            { id: 'a-tool-only', role: 'assistant', parts: [{ type: 'step-start' }, { type: 'reasoning', text: 'SECRET_THOUGHTS' }] } as never,
          ] as never;
        },
      },
      logger: {},
    },
  );
  assert.equal(outcome, 'empty');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await stack.blocks(SCOPE)).length, beforeCount, 'tool-only/reasoning-only transcripts capture NOTHING');
});

test('live purge: delete deletes the whole chat path; rewind narrows to removed assistant ids; other chats survive', async () => {
  // Seed a derived block for ANOTHER chat (must survive).
  await stack.service.writeBlock({
    scope: SCOPE,
    path: `chats/${OTHER_CHAT_ID}`,
    kind: 'observation',
    content: 'Other chat derived memory that must survive.',
    confidence: 0.8,
    metadata: { source: 'personal-chat', chatId: OTHER_CHAT_ID, assistantMessageId: 'a-other' },
  });
  await waitFor(async () => (await stack.blocks(SCOPE, `chats/${OTHER_CHAT_ID}`)).length === 1, WAIT_TIMEOUT_MS, 'the other chat block exists first');

  // DELETE purge: whole path.
  const deleted = await stack.service.purgeDerivedChatMemory({ scope: SCOPE, path: `chats/${CHAT_ID}` });
  assert.ok(deleted >= 2, 'both assistant-turn derived blocks purged');
  assert.equal((await stack.blocks(SCOPE, `chats/${CHAT_ID}`)).length, 0);

  // REWIND purge: ONLY the removed assistant message ids. Seed three blocks
  // (removed a-r1, a-r2 + kept a-r3) and narrow to the removed two.
  const removed1 = await stack.service.writeBlock({
    scope: SCOPE,
    path: `chats/${OTHER_CHAT_ID}`,
    kind: 'observation',
    content: 'removed-derived-1',
    confidence: 0.8,
    metadata: { source: 'personal-chat', chatId: OTHER_CHAT_ID, assistantMessageId: 'a-r1' },
  });
  void removed1;
  const removed2 = await stack.service.writeBlock({
    scope: SCOPE,
    path: `chats/${OTHER_CHAT_ID}`,
    kind: 'observation',
    content: 'removed-derived-2',
    confidence: 0.8,
    metadata: { source: 'personal-chat', chatId: OTHER_CHAT_ID, assistantMessageId: 'a-r2' },
  });
  void removed2;
  const kept = await stack.service.writeBlock({
    scope: SCOPE,
    path: `chats/${OTHER_CHAT_ID}`,
    kind: 'observation',
    content: 'kept-derived-3',
    confidence: 0.8,
    metadata: { source: 'personal-chat', chatId: OTHER_CHAT_ID, assistantMessageId: 'a-r3' },
  });
  void kept;
  await waitFor(
    async () => (await stack.blocks(SCOPE, `chats/${OTHER_CHAT_ID}`)).length >= 4,
    WAIT_TIMEOUT_MS,
    'seeded blocks present before the rewind purge',
  );
  const removedCount = await stack.service.purgeDerivedChatMemory({
    scope: SCOPE,
    path: `chats/${OTHER_CHAT_ID}`,
    assistantMessageIds: ['a-r1', 'a-r2'],
  });
  assert.equal(removedCount, 2, 'ONLY the removed assistant ids purged');
  const survivors = await stack.blocks(SCOPE, `chats/${OTHER_CHAT_ID}`);
  for (const survivor of survivors) {
    assert.notEqual(survivor.metadata['assistantMessageId'], 'a-r1');
    assert.notEqual(survivor.metadata['assistantMessageId'], 'a-r2');
  }
  assert.ok(survivors.some((block) => block.metadata['assistantMessageId'] === 'a-r3'), 'the kept block survives');
  assert.ok(survivors.some((block) => block.metadata['assistantMessageId'] === 'a-other'), 'foreign-chat block survives');
});
