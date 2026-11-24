/**
 * Owner-resolution + cross-owner isolation tests (pre-Phase 6):
 * - the fixed 401 fail-closed surface on every route family (ownerMode none),
 * - the signed internal owner contexts (`internal-owner`, delegation create)
 *   resolving WITHOUT a browser session, a fixed 400 on browser/internal
 *   owner disagreements, and no access for unsigned headers,
 * - the email allowlist denial (fixed 403, no data access),
 * - `GET /api/auth/providers` public booleans only,
 * - two users with the SAME slug+chatId are fully isolated (shared store),
 * - cross-owner reads on work docs / delegations / scheduler read as fixed
 *   404 with no existence oracle, and ownerless rows can never run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDelegationContextSigner,
  internalOwnerHeader,
  type DelegationContextSigner,
} from '../src/agents/delegation-context.js';
import type { ProviderAvailability } from '../src/auth/index.js';
import type { WorkforceAuth } from '../src/auth/factory.js';
import { verifyRunHeader, type DelegationRunDeps } from '../src/agents/delegation-run.js';
import { createInMemoryChatStore } from '../src/store/memory.js';
import { InMemoryWorkDocStore, WorkDocService } from '@workforce/core/work-docs';
import { InMemoryDelegationRepository } from '@workforce/core/delegation';
import { InMemorySchedulerStore } from '@workforce/core/scheduler';
import {
  TEST_OWNER,
  TEST_OWNER_B,
  TEST_DELEGATION_SECRET,
  FakeSchedulerQueue,
  getJson,
  schedulerRunHeaders,
  silentLogger,
  startTestApp,
  seedMessages,
  userMessage,
  type AgentsFixtures,
} from './helpers.js';

const signer: DelegationContextSigner = createDelegationContextSigner(Buffer.from(TEST_DELEGATION_SECRET, 'utf8'));

interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/** Structural Better Auth stand-in resolving ONE fixed session for every call. */
function fakeAuthWithSession(user: SessionUser | null): WorkforceAuth {
  return {
    api: {
      getSession: async () => (user === null ? null : { user }),
    },
  } as unknown as WorkforceAuth;
}

const PROVIDERS_BOTH: ProviderAvailability = {
  google: { available: true, issue: null },
  github: { available: true, issue: null },
};

function agentFixtures(extra: Partial<AgentsFixtures> = {}): AgentsFixtures {
  return { wire: true, ...extra };
}

// ---------------------------------------------------------------------------
// Fail-closed 401 + route families
// ---------------------------------------------------------------------------

test('auth absent: every route family answers the fixed 401 with no data', async () => {
  const app = await startTestApp({
    ownerMode: 'none',
    agents: agentFixtures(),
    scheduler: { queue: new FakeSchedulerQueue() },
  });
  try {
    const checks: Array<{ path: string; method: string; body?: unknown }> = [
      { path: '/api/agents/general/chat', method: 'POST', body: { id: 'c1', message: userMessage('hi', 'm1') } },
      { path: '/api/agents/general/chat/c1', method: 'GET' },
      { path: '/api/agents/general/chat/c1/stream', method: 'GET' },
      { path: '/api/chats', method: 'GET' },
      { path: '/api/agents/orchestrator/work-docs', method: 'POST', body: { chatId: 'c', type: 'report', title: 't', content: 'c' } },
      { path: '/api/agents/orchestrator/delegations?parentChatId=c', method: 'GET' },
      { path: '/api/scheduler/tasks', method: 'POST', body: { name: 'x', agentSlug: 'general', mode: 'action', prompt: 'p', recurrenceType: 'ONCE', recurrenceConfig: { runAt: '2026-12-01T09:00:00.000Z' } } },
      { path: '/api/scheduler/executions', method: 'GET' },
    ];
    for (const check of checks) {
      const headers: Record<string, string> = check.body !== undefined ? { 'content-type': 'application/json' } : {};
      if (check.path === '/api/agents/general/chat') {
        headers['Idempotency-Key'] = 'c1:m1';
      }
      const response = await fetch(`http://127.0.0.1:${app.port}${check.path}`, {
        method: check.method,
        headers,
        ...(check.body !== undefined ? { body: JSON.stringify(check.body) } : {}),
      });
      assert.equal(response.status, 401, `${check.method} ${check.path}`);
      assert.deepEqual((await response.json()) as unknown, { error: 'Authentication required.' });
    }
    // /health stays public.
    const health = await getJson({ port: app.port, path: '/health' });
    assert.equal(health.status, 200);
  } finally {
    await app.close();
  }
});

test('auth absent on memory: owner-gated fixed 401 (memory deps wired)', async () => {
  const { MemoryService, InMemoryMemoryStore, MEMORY_EMBEDDING_MODEL } = await import('@workforce/core/memory');
  const embedder = {
    dimensions: 4,
    model: MEMORY_EMBEDDING_MODEL,
    embed: async () => [0, 0, 0, 0],
  };
  const failingQueue = {
    async enqueueEmbedding(): Promise<void> {
      throw new Error('never used in this test');
    },
    async enqueueCompaction(): Promise<void> {
      throw new Error('never used in this test');
    },
  };
  const service = new MemoryService({ store: new InMemoryMemoryStore(), embeddingProvider: embedder as never, queue: failingQueue as never, compactor: null as never });
  const app = await startTestApp({
    ownerMode: 'none',
    memory: { service, queue: failingQueue as never },
  });
  try {
    const list = await getJson({ port: app.port, path: '/api/memory/blocks' });
    assert.equal(list.status, 401);
    const search = await fetch(`http://127.0.0.1:${app.port}/api/memory/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'q' }),
    });
    assert.equal(search.status, 401);
    assert.deepEqual((await search.json()) as unknown, { error: 'Authentication required.' });
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Real auth deps: allowlist + internal signed owners (no Better Auth mount)
// ---------------------------------------------------------------------------

async function buildAuthApp(options: {
  sessionUser: SessionUser | null;
  allowlist: readonly string[];
}): Promise<{ server: import('node:http').Server; port(): number; close(): Promise<void> }> {
  const { buildApp } = await import('../src/app.js');
  const { loadApiConfig } = await import('../src/config.js');
  const { createInMemoryStreamContext } = await import('../src/stream-context/memory.js');
  const { createBackgroundTracker } = await import('../src/background.js');
  const app = buildApp({
    config: loadApiConfig(),
    store: createInMemoryChatStore(),
    streamContext: createInMemoryStreamContext(),
    model: {} as never,
    background: createBackgroundTracker({ onError: () => undefined }),
    auth: {
      auth: fakeAuthWithSession(options.sessionUser),
      emailAllowlist: options.allowlist,
      signer,
      providerAvailability: PROVIDERS_BOTH,
    },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const port = address.port;
  return {
    server,
    port: () => port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

test('allowlisted session passes; a non-allowlisted email is a fixed 403 with no data', async () => {
  const allowed = await buildAuthApp({
    sessionUser: { id: TEST_OWNER_B.userId, email: TEST_OWNER_B.email, emailVerified: true },
    allowlist: [TEST_OWNER_B.email],
  });
  try {
    const response = await getJson({ port: allowed.port(), path: '/api/chats' });
    assert.equal(response.status, 200, 'allowlisted identity reads its (empty) data');
  } finally {
    await allowed.close();
  }

  const denied = await buildAuthApp({
    sessionUser: { id: TEST_OWNER_B.userId, email: 'outsider@example.com', emailVerified: true },
    allowlist: [TEST_OWNER_B.email],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${denied.port()}/api/chats`);
    assert.equal(response.status, 403);
    assert.deepEqual((await response.json()) as unknown, { error: 'Access denied.' });
  } finally {
    await denied.close();
  }
});

test('internal owner header resolves without a session; conflicting browser identity is a fixed 400', async () => {
  const anonymous = await buildAuthApp({ sessionUser: null, allowlist: [] });
  try {
    const port = anonymous.port();
    // Signed internal owner (no browser session): hydration works.
    const hydration = await fetch(`http://127.0.0.1:${port}/api/agents/general/chat/c-a1`, {
      headers: internalOwnerHeader(signer, TEST_OWNER_B.userId),
    });
    assert.equal(hydration.status, 200);
    assert.deepEqual((await hydration.json()) as unknown, { messages: [], hasActiveStream: false });
    // Plain anonymous call: fixed 401.
    const gated = await fetch(`http://127.0.0.1:${port}/api/agents/general/chat/c-a1`);
    assert.equal(gated.status, 401);
    // An unsigned forge of the internal header: fixed 400 (never access).
    const forgedPayload = Buffer.from(
      JSON.stringify({ kind: 'internal-owner', ownerId: TEST_OWNER_B.userId, expiresAt: Date.now() + 60_000 }),
    ).toString('base64url');
    const forged = await fetch(`http://127.0.0.1:${port}/api/agents/general/chat/c-a1`, {
      headers: { 'X-Workforce-Internal-Owner': `${forgedPayload}.forged-signature` },
    });
    assert.equal(forged.status, 400);
  } finally {
    await anonymous.close();
  }

  const mixed = await buildAuthApp({
    sessionUser: { id: TEST_OWNER.userId, email: TEST_OWNER.email, emailVerified: true },
    allowlist: [],
  });
  try {
    // Browser session owner A + internal signed owner B: fixed 400, and the
    // request is NEVER served as either identity.
    const conflict = await fetch(`http://127.0.0.1:${mixed.port()}/api/agents/general/chat/c-m1`, {
      headers: internalOwnerHeader(signer, TEST_OWNER_B.userId),
    });
    assert.equal(conflict.status, 400);
    assert.deepEqual((await conflict.json()) as unknown, { error: 'Authentication context mismatch.' });

    // P2: an INVALID (present but forged) internal header is a fixed 400
    // even when a VALID browser session exists — the session never rescues it.
    const forgedPayload = Buffer.from(
      JSON.stringify({ kind: 'internal-owner', ownerId: TEST_OWNER_B.userId, expiresAt: Date.now() + 60_000 }),
    ).toString('base64url');
    const sessionPlusForged = await fetch(`http://127.0.0.1:${mixed.port()}/api/agents/general/chat/c-m2`, {
      headers: { 'X-Workforce-Internal-Owner': `${forgedPayload}.forged-signature` },
    });
    assert.equal(sessionPlusForged.status, 400);
    assert.deepEqual((await sessionPlusForged.json()) as unknown, { error: 'Authentication context mismatch.' });

    // ...and an EXPIRED internal header is exactly as rejected.
    const expiredInternal = await fetch(`http://127.0.0.1:${mixed.port()}/api/agents/general/chat/c-m3`, {
      headers: {
        'X-Workforce-Internal-Owner': signer.sign({
          kind: 'internal-owner',
          ownerId: TEST_OWNER.userId,
          expiresAt: Date.now() - 5_000,
        }),
      },
    });
    assert.equal(expiredInternal.status, 400);

    // Session + VALID internal header with the SAME owner is fine.
    const sameOwner = await fetch(`http://127.0.0.1:${mixed.port()}/api/agents/general/chat/c-m4`, {
      headers: internalOwnerHeader(signer, TEST_OWNER.userId),
    });
    assert.equal(sameOwner.status, 200);
  } finally {
    await mixed.close();
  }
});

// ---------------------------------------------------------------------------
// Providers route
// ---------------------------------------------------------------------------

test('GET /api/auth/providers returns booleans only (public); no data without auth', async () => {
  const { buildApp } = await import('../src/app.js');
  const { loadApiConfig } = await import('../src/config.js');
  const { createInMemoryStreamContext } = await import('../src/stream-context/memory.js');
  const { createBackgroundTracker } = await import('../src/background.js');
  const app = buildApp({
    config: loadApiConfig(),
    store: createInMemoryChatStore(),
    streamContext: createInMemoryStreamContext(),
    model: {} as never,
    background: createBackgroundTracker({ onError: () => undefined }),
    auth: {
      auth: fakeAuthWithSession(null),
      emailAllowlist: [],
      signer,
      providerAvailability: {
        google: { available: true, issue: null },
        github: { available: false, issue: 'GITHUB_CLIENT_SECRET is missing: the provider must be configured as a COMPLETE pair' },
      },
    },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/providers`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()) as unknown, { google: true, github: false });
    const gated = await fetch(`http://127.0.0.1:${address.port}/api/chats`);
    assert.equal(gated.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// Cross-owner isolation (same slug + chatId)
// ---------------------------------------------------------------------------

test('two users with the same slug+chatId are fully isolated (store + routes + idempotency)', async () => {
  const sharedStore = createInMemoryChatStore();
  const { createMockModel, textStep } = await import('./helpers.js');
  const model = createMockModel({ steps: [textStep()] });
  const appA = await startTestApp({ store: sharedStore, model, auth: { staticOwner: TEST_OWNER } });
  const appB = await startTestApp({ store: sharedStore, model, auth: { staticOwner: TEST_OWNER_B } });
  try {
    const postA = await fetch(`http://127.0.0.1:${appA.port}/api/agents/general/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'same-chat:m1' },
      body: JSON.stringify({ id: 'same-chat', message: userMessage('hello A', 'm1') }),
    });
    assert.equal(postA.status, 200);
    await postA.text();

    // Owner B sees NOTHING under the same slug+chatId — and the idempotency
    // key space is per owner, so B can run the identical turn freely.
    const hydrationB = await getJson({ port: appB.port, path: '/api/agents/general/chat/same-chat' });
    assert.equal(hydrationB.status, 200);
    assert.deepEqual(hydrationB.body, { messages: [], hasActiveStream: false });
    const postB = await fetch(`http://127.0.0.1:${appB.port}/api/agents/general/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'same-chat:m1' },
      body: JSON.stringify({ id: 'same-chat', message: userMessage('hello B', 'm1') }),
    });
    assert.equal(postB.status, 200, 'same key text under a different owner is a different key');
    await postB.text();

    // A sees only its own transcript; the listings are per owner too.
    const hydrationA = await getJson({ port: appA.port, path: '/api/agents/general/chat/same-chat' });
    const messagesA = (hydrationA.body as { messages: Array<{ role: string; parts: Array<{ text: string }> }> }).messages;
    // A: its user message + its own streamed assistant reply (B's data NEVER
    // merged into A's transcript).
    assert.equal(messagesA.length, 2);
    assert.match(messagesA[0]?.parts[0]?.text ?? '', /A/);
    const listA = await getJson({ port: appA.port, path: '/api/chats' });
    assert.deepEqual(
      (listA.body as { chats: Array<{ messageCount: number }> }).chats.map((chat) => chat.messageCount),
      [2],
    );
    const listB = await getJson({ port: appB.port, path: '/api/chats' });
    assert.deepEqual(
      (listB.body as { chats: Array<{ messageCount: number }> }).chats.map((chat) => chat.messageCount),
      [1],
    );
  } finally {
    await appA.close();
    await appB.close();
  }
});

// ---------------------------------------------------------------------------
// Cross-owner 404 on the Postgres-domain resources + ownerless refusal
// ---------------------------------------------------------------------------

async function crossOwnerApps(): Promise<{
  a: Awaited<ReturnType<typeof startTestApp>>;
  b: Awaited<ReturnType<typeof startTestApp>>;
  workDocService: WorkDocService;
  delegationRepo: InMemoryDelegationRepository;
  schedulerStore: InMemorySchedulerStore;
}> {
  const workDocService = new WorkDocService({ store: new InMemoryWorkDocStore() });
  const delegationRepo = new InMemoryDelegationRepository();
  const schedulerStore = new InMemorySchedulerStore();
  const fakeQueue = { enqueue: async (): Promise<boolean> => true, ping: async (): Promise<void> => undefined, close: async (): Promise<void> => undefined };
  const a = await startTestApp({
    auth: { staticOwner: TEST_OWNER },
    model: {} as never,
    agents: agentFixtures({
      workDocService,
      delegationRepo,
      delegationQueue: fakeQueue as never,
    }),
    scheduler: { store: schedulerStore, queue: new FakeSchedulerQueue() },
  });
  const b = await startTestApp({
    auth: { staticOwner: TEST_OWNER_B },
    model: {} as never,
    agents: agentFixtures({
      workDocService,
      delegationRepo,
      delegationQueue: fakeQueue as never,
    }),
    scheduler: { store: schedulerStore, queue: new FakeSchedulerQueue() },
  });
  return { a, b, workDocService, delegationRepo, schedulerStore };
}

test('cross-owner: work docs, delegations, and scheduler rows read as fixed 404 for another user', async () => {
  const { a, b } = await crossOwnerApps();
  try {
    // Work doc created by A.
    const docResponse = await fetch(`http://127.0.0.1:${a.port}/api/agents/orchestrator/work-docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'chat-own-a', type: 'report', title: 'A doc', content: 'A content' }),
    });
    assert.equal(docResponse.status, 201);
    const doc = (await docResponse.json()) as { document: { id: string } };
    const foreignDoc = await getJson({ port: b.port, path: `/api/agents/orchestrator/work-docs/${doc.document.id}?chatId=chat-own-a` });
    assert.equal(foreignDoc.status, 404);
    assert.deepEqual(foreignDoc.body, { error: 'Work document not found.' });
    // Owner A still reads it; owner B's list is empty (owner filter forced).
    assert.equal((await getJson({ port: a.port, path: `/api/agents/orchestrator/work-docs/${doc.document.id}?chatId=chat-own-a` })).status, 200);
    const bList = await getJson({ port: b.port, path: '/api/agents/orchestrator/work-docs' });
    assert.deepEqual((bList.body as { documents: unknown[] }).documents, []);

    // Delegation created by A (route verifies the signed create context).
    await seedMessages(a.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'chat-own-a' }, [userMessage('seed parent', 'pm-1')]);
    const expires = Date.now() + 60_000;
    const delegationResponse = await fetch(`http://127.0.0.1:${a.port}/api/agents/orchestrator/delegations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Workforce-Delegation-Context': signer.sign({
          kind: 'delegation-create',
          parentChatId: 'chat-own-a',
          parentDepth: 0,
          ownerId: TEST_OWNER.userId,
          expiresAt: expires,
        }),
        ...internalOwnerHeader(signer, TEST_OWNER.userId),
        'X-Dummy-Depth-Note': 'depth-cap checked on the context',
      },
      body: JSON.stringify({ parentChatId: 'chat-own-a', parentMessageId: 'pm-1', target: 'researcher', task: 'T', mode: 'async' }),
    });
    assert.equal(delegationResponse.status, 202);
    const delegation = (await delegationResponse.json()) as { delegation: { id: string } };
    const foreignDelegation = await getJson({ port: b.port, path: `/api/agents/orchestrator/delegations/${delegation.delegation.id}` });
    assert.equal(foreignDelegation.status, 404);
    assert.deepEqual(foreignDelegation.body, { error: 'Delegation not found.' });
    const foreignList = await getJson({ port: b.port, path: '/api/agents/orchestrator/delegations?parentChatId=chat-own-a' });
    assert.deepEqual((foreignList.body as { delegations: unknown[] }).delegations, []);

    // Scheduler task created by A.
    const taskResponse = await fetch(`http://127.0.0.1:${a.port}/api/scheduler/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A task', agentSlug: 'general', mode: 'action', prompt: 'p', recurrenceType: 'ONCE', recurrenceConfig: { runAt: '2026-12-01T09:00:00.000Z' } }),
    });
    assert.equal(taskResponse.status, 201);
    const task = (await taskResponse.json()) as { task: { id: string } };
    // Manual run by A executes; foreign reads are 404 with no oracle.
    const foreignTask = await getJson({ port: b.port, path: `/api/scheduler/tasks/${task.task.id}` });
    assert.equal(foreignTask.status, 404);
    assert.deepEqual(foreignTask.body, { error: 'Task not found.' });
    const foreignTasks = await getJson({ port: b.port, path: '/api/scheduler/tasks' });
    assert.deepEqual((foreignTasks.body as { tasks: unknown[] }).tasks, []);
    const foreignRun = await fetch(`http://127.0.0.1:${b.port}/api/scheduler/tasks/${task.task.id}/run`, {
      method: 'POST',
    });
    assert.equal(foreignRun.status, 404);
  } finally {
    await a.close();
    await b.close();
  }
});

// ---------------------------------------------------------------------------
// P0 regression: worker-only run routes under REAL auth deps (getSession null)
// ---------------------------------------------------------------------------

test('worker routes: real auth deps (no session) no longer 401 valid signed worker calls; forged/missing stay rejected; browser routes stay gated', async () => {
  const { buildApp } = await import('../src/app.js');
  const { loadApiConfig } = await import('../src/config.js');
  const { createInMemoryStreamContext } = await import('../src/stream-context/memory.js');
  const { createBackgroundTracker } = await import('../src/background.js');
  const { createSchedulerRoutes } = await import('../src/scheduler/routes.js');
  const { SchedulerService, InMemorySchedulerStore } = await import('@workforce/core/scheduler');
  const { FakeSchedulerQueue } = await import('./helpers.js');

  const store = new InMemorySchedulerStore();
  const service = new SchedulerService({ store });
  const queue = new FakeSchedulerQueue();
  // No model/plumbing needed: the owned task is PAUSED, so the signed run
  // records a SKIPPED outcome with zero provider calls (row-derived owner).
  const ownedTask = await service.createTask({
    name: 'Worker regression task',
    agentSlug: 'general',
    mode: 'action',
    prompt: 'never runs while paused',
    recurrenceType: 'ONCE',
    recurrenceConfig: { runAt: '2026-12-01T09:00:00.000Z' },
    ownerId: TEST_OWNER.userId,
  });
  await service.setTaskActive({ id: ownedTask.id, isActive: false, expectedOwnerId: TEST_OWNER.userId });

  const app = buildApp({
    config: loadApiConfig(),
    store: createInMemoryChatStore(),
    streamContext: createInMemoryStreamContext(),
    model: {} as never,
    background: createBackgroundTracker({ onError: () => undefined }),
    // REAL auth deps: the session resolver returns null for every request.
    auth: {
      auth: fakeAuthWithSession(null),
      emailAllowlist: [],
      signer,
      providerAvailability: PROVIDERS_BOTH,
    },
    scheduler: {
      service,
      queue,
      run: { fetchFn: async () => new Response('{}'), baseUrl: 'http://test', executionTimeoutMs: 60_000, metadataTimeoutMs: 5_000, staleRunningMs: 30_000, signer, logger: silentLogger },
      logger: silentLogger,
    },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const port = address.port;

    // Missing worker header (signed context present alone): fixed 401
    // (fail-closed convention tripwire).
    const missingWorkerHeader = await fetch(`http://127.0.0.1:${port}/api/scheduler/tasks/${ownedTask.id}/run-scheduled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Workforce-Internal-Scheduler': schedulerRunHeaders({ taskId: ownedTask.id })['X-Workforce-Internal-Scheduler'] },
      body: JSON.stringify({ scheduledFor: '2026-12-01T09:00:00.000Z', attempt: 1 }),
    });
    assert.equal(missingWorkerHeader.status, 401);
    assert.deepEqual((await missingWorkerHeader.json()) as unknown, { error: 'Scheduler worker header required.' });

    // The literal convention header WITHOUT the signed context: fixed 400.
    const unsigned = await fetch(`http://127.0.0.1:${port}/api/scheduler/tasks/${ownedTask.id}/run-scheduled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Workforce-Scheduler-Worker': '1' },
      body: JSON.stringify({ scheduledFor: '2026-12-01T09:00:00.000Z', attempt: 1 }),
    });
    assert.equal(unsigned.status, 400);

    // Signed context bound to a DIFFERENT id: fixed 400.
    const misbound = await fetch(`http://127.0.0.1:${port}/api/scheduler/tasks/${ownedTask.id}/run-scheduled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...schedulerRunHeaders({ taskId: '00000000-0000-4000-8000-00000000dead' }) },
      body: JSON.stringify({ scheduledFor: '2026-12-01T09:00:00.000Z', attempt: 1 }),
    });
    assert.equal(misbound.status, 400);

    // VALID signed worker call: SUCCESS — the route runs even with a
    // session-resolver that returns null for every browser request (P0: the
    // worker routes no longer sit behind the browser owner gate).
    const valid = await fetch(`http://127.0.0.1:${port}/api/scheduler/tasks/${ownedTask.id}/run-scheduled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...schedulerRunHeaders({ taskId: ownedTask.id }) },
      body: JSON.stringify({ scheduledFor: '2026-12-01T09:00:00.000Z', attempt: 1 }),
    });
    assert.equal(valid.status, 200);
    const validBody = (await valid.json()) as { ok?: unknown; skipped?: unknown; execution?: { status?: string; ownerId?: string } };
    assert.equal(validBody.ok, true);
    assert.equal(validBody.skipped, true);
    assert.equal(validBody.execution?.status, 'SKIPPED');
    assert.equal(validBody.execution?.ownerId, TEST_OWNER.userId, 'the owner comes from the row');

    // The same app still gates every browser route on the session (the
    // session resolver really is null here — no staticOwner masking).
    const browser = await fetch(`http://127.0.0.1:${port}/api/chats`);
    assert.equal(browser.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('ownerless rows cannot run: the signed run context can never bind to a legacy row', async () => {
  const repo = new InMemoryDelegationRepository();
  const ownerlessDelegation = await repo.create({
    parentChatId: 'p',
    childChatId: 'c',
    parentMessageId: 'pm',
    targetAgent: 'researcher',
    mode: 'async',
    task: 't',
    depth: 1,
    // ownerId omitted → ownerless legacy row.
  });
  assert.equal(ownerlessDelegation.ownerId, null);
  const runDeps: DelegationRunDeps = {
    signer,
    fetchFn: async () => new Response('{}'),
    baseUrl: 'http://test',
    delegationTimeoutMs: 60_000,
    repo,
  };
  // A header naming SOME user can never bind to an ownerless row — 404,
  // exactly the "legacy rows become inaccessible" contract.
  const header = signer.sign({
    kind: 'delegation-create',
    parentChatId: 'p',
    parentDepth: 0,
    ownerId: TEST_OWNER.userId,
    expiresAt: Date.now() + 60_000,
  });
  assert.deepEqual(verifyRunHeader(runDeps, header, ownerlessDelegation), { ok: false, status: 404 });
});
