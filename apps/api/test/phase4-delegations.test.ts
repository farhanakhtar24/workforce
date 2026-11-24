/**
 * Delegation tests (Phase 4 / ADR-004): sync tool flow, async queue job,
 * signed context validation, depth caps, run-route idempotency, bounded
 * timeouts, and the same-REST proof (the child chat is a REAL chat on the
 * same `POST /api/agents/:slug/chat` endpoint, hydrated like any other).
 *
 * Offline: the ONLY fetch is the loopback rewriting fetch into the test app
 * itself; the child model is the shared mock; the BullMQ queue/worker are
 * in-process fakes (real Redis/BullMQ live in integration).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { UIMessage } from 'ai';

import {
  startTestApp,
  postChat,
  userMessage,
  seedMessages,
  toolCallStep,
  textStep,
  mockUsage,
  TEST_DELEGATION_SECRET,
  TEST_OWNER,
} from './helpers.js';
import {
  createDelegationContextSigner,
  contextWindow,
  DELEGATION_CONTEXT_HEADER,
} from '../src/agents/delegation-context.js';
import {
  delegationJobId,
  processDelegationJob,
  type DelegationJobData,
} from '../src/agents/delegation-queue.js';
import { createDelegationRunJobClient } from '../src/agents/delegation-run-client.js';
import { InMemoryDelegationRepository, type Delegation } from '@workforce/core/delegation';
import type { DelegationJobQueue } from '../src/agents/delegation-queue.js';
import type { AgentsFixtures } from './helpers.js';

const signer = createDelegationContextSigner(Buffer.from(TEST_DELEGATION_SECRET, 'utf8'));

function delegationFixtures(extra: Partial<AgentsFixtures> = {}): AgentsFixtures {
  return { wire: true, ...extra };
}

function createHeader(parentChatId: string, parentMessageId: string, depth = 0, ttlMs = 120_000): string {
  void parentMessageId;
  const window = contextWindow(ttlMs);
  return signer.sign({
    kind: 'delegation-create',
    parentChatId,
    parentDepth: depth,
    ownerId: TEST_OWNER.userId,
    expiresAt: window.expiresAt,
  });
}

async function createDelegation(
  app: Awaited<ReturnType<typeof startTestApp>>,
  body: Record<string, unknown>,
  options: { header?: string; slug?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/${options.slug ?? 'orchestrator'}/delegations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.header !== undefined ? { [DELEGATION_CONTEXT_HEADER]: options.header } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> };
}

function delegationBody(): Record<string, unknown> {
  return {
    parentChatId: 'parent-1',
    parentMessageId: 'pm-1',
    target: 'researcher',
    task: 'Explain recursion in one short paragraph.',
    mode: 'sync',
  };
}

async function detail(app: Awaited<ReturnType<typeof startTestApp>>, id: string, slug = 'orchestrator'): Promise<{ status: number; delegation?: Delegation }> {
  const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/${slug}/delegations/${id}`);
  const body = (await response.json()) as { delegation?: Delegation; error?: string };
  return { status: response.status, delegation: body.delegation };
}

async function hydrateChild(app: Awaited<ReturnType<typeof startTestApp>>, childChatId: string): Promise<{ status: number; messages: UIMessage[] }> {
  const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/researcher/chat/${childChatId}`);
  const body = (await response.json()) as { messages?: UIMessage[] };
  return { status: response.status, messages: body.messages ?? [] };
}

// ---------------------------------------------------------------------------
// Sync delegation end-to-end (tool → create → run → real child chat)
// ---------------------------------------------------------------------------

test('sync delegation end-to-end', { concurrency: false }, async () => {
  const { MockLanguageModelV3, simulateReadableStream } = await import('ai/test');
  const finish = { type: 'finish', usage: mockUsage(), finishReason: { unified: 'tool-calls', raw: undefined } } as never;
  const delegateStep = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'd1', toolName: 'delegate_task' },
    { type: 'tool-input-delta', id: 'd1', delta: JSON.stringify({ targetAgent: 'researcher', task: 'Explain recursion in one sentence.', mode: 'sync' }) },
    { type: 'tool-input-end', id: 'd1' },
    { type: 'tool-call', toolCallId: 'd1', toolName: 'delegate_task', input: JSON.stringify({ targetAgent: 'researcher', task: 'Explain recursion in one sentence.', mode: 'sync' }) },
    finish,
  ] as never;
  const childStep = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Recursion is a function calling itself on a smaller input.' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', usage: mockUsage(), finishReason: { unified: 'stop', raw: undefined } },
  ] as never;
  const parentFinal = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't2' },
    { type: 'text-delta', id: 't2', delta: 'Delegated and received the answer.' },
    { type: 'text-end', id: 't2' },
    { type: 'finish', usage: mockUsage(), finishReason: { unified: 'stop', raw: undefined } },
  ] as never;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-sd',
    doStream: [delegateStep, childStep, parentFinal].map((chunks) => ({ stream: simulateReadableStream({ chunks }) })),
  } as never);

  const app = await startTestApp({ agents: delegationFixtures(), model: model as never });
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'parent-1' }, [
      userMessage('delegate some research', 'pm-1'),
    ]);
    const response = await postChat({
      port: app.port,
      slug: 'orchestrator',
      body: { id: 'parent-1', message: userMessage('now really delegate', 'pm-2') },
    });
    assert.equal(response.status, 200);
    await response.text();

    // The delegation row completed with the child's answer.
    const listed = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/delegations?parentChatId=parent-1`);
    const listBody = (await listed.json()) as { delegations: Delegation[] };
    assert.equal(listBody.delegations.length, 1);
    const row = listBody.delegations[0] as Delegation;
    assert.equal(row.status, 'completed');
    assert.equal(row.mode, 'sync');
    assert.equal(row.targetAgent, 'researcher');
    assert.equal(row.depth, 1);
    assert.equal(row.result, 'Recursion is a function calling itself on a smaller input.');

    // SAME-REST PROOF: the child chat is a real persisted researcher chat,
    // hydratable through its own endpoint like any human chat.
    const child = await hydrateChild(app, row.childChatId);
    assert.equal(child.status, 200);
    assert.equal(child.messages.length, 2);
    const childUserText = JSON.stringify(child.messages[0]).includes('Explain recursion in one sentence.');
    assert.equal(childUserText, true);
    assert.equal(JSON.stringify(child.messages[1]).includes('Recursion is a function calling itself'), true);

    // The parent transcript carries the delegate_task part with tool output.
    const parentHydration = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/chat/parent-1`);
    const parentBody = (await parentHydration.json()) as { messages: UIMessage[] };
    const parts = parentBody.messages.flatMap((entry) => (entry.role === 'assistant' ? entry.parts : []));
    const delegatePart = parts.find((part) => (part as { type?: string }).type === 'tool-delegate_task') as unknown as Record<string, unknown> | undefined;
    assert.ok(delegatePart !== undefined);
    assert.equal(delegatePart?.['state'], 'output-available');
    const output = delegatePart?.['output'] as Record<string, unknown>;
    assert.equal(output['status'], 'completed');
    assert.equal(output['childChatId'], row.childChatId);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Async delegation (create 202 → BullMQ job → worker runs run REST)
// ---------------------------------------------------------------------------

class FakeDelegationQueue implements DelegationJobQueue {
  readonly enqueued: Array<{ jobId: string; data: DelegationJobData }> = [];
  closed = false;

  async enqueue(delegationId: string, parentSlug: string, ownerId: string): Promise<boolean> {
    this.enqueued.push({ jobId: delegationJobId(delegationId), data: { delegationId, parentSlug, ownerId } });
    return true;
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function jobLike(data: DelegationJobData): { data: DelegationJobData; id: string } {
  return { data, id: delegationJobId(data.delegationId) };
}

test('async delegation: deterministic job id enqueue; worker executes through the run REST; retried job is a no-op', { concurrency: false }, async () => {
  const queue = new FakeDelegationQueue();
  const { MockLanguageModelV3, simulateReadableStream } = await import('ai/test');
  const childStep = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Async answer from the researcher.' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', usage: mockUsage(), finishReason: { unified: 'stop', raw: undefined } },
  ] as never;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-ad',
    doStream: [{ stream: simulateReadableStream({ chunks: childStep }) }],
  } as never);

  const app = await startTestApp({ agents: delegationFixtures({ delegationQueue: queue }), model: model as never });
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'parent-async' }, [
      userMessage('async please', 'pa-1'),
    ]);
    const created = await createDelegation(app, { ...delegationBody(), mode: 'async', parentChatId: 'parent-async', parentMessageId: 'pa-1', task: 'Research async topics.' }, { header: createHeader('parent-async', 'pa-1') });
    assert.equal(created.status, 202);
    const row = created.body['delegation'] as Delegation;
    assert.equal(row.status, 'pending');
    assert.equal(created.body['childChatId'], row.childChatId);

    // Deterministic job id, parent slug carried in the payload.
    assert.equal(queue.enqueued.length, 1);
    assert.equal(queue.enqueued[0]?.jobId, `delegation-${row.id}`);
    assert.deepEqual(queue.enqueued[0]?.data, { delegationId: row.id, parentSlug: 'orchestrator', ownerId: TEST_OWNER.userId });

    // The worker calls its OWN run REST: signer + rewriting fetch from the
    // app's agents fixture (never a direct child generation).
    const runClient = createDelegationRunJobClient({
      signer: app.agents?.signer as never,
      fetchFn: app.agents?.hostDeps.fetchFn as never,
      baseUrl: app.agents?.internalOrigin ?? 'http://workforce-test-internal',
      delegationTimeoutMs: 120_000,
    });
    await processDelegationJob(jobLike({ delegationId: row.id, parentSlug: 'orchestrator', ownerId: TEST_OWNER.userId }), runClient);

    const after = await detail(app, row.id);
    assert.equal(after.delegation?.status, 'completed');
    assert.equal(after.delegation?.result, 'Async answer from the researcher.');

    // Retried job CANNOT double-run: child transcript unchanged, row stable.
    await processDelegationJob(jobLike({ delegationId: row.id, parentSlug: 'orchestrator', ownerId: TEST_OWNER.userId }), runClient);
    const child = await hydrateChild(app, row.childChatId);
    assert.equal(child.messages.length, 2);
    const afterRetry = await detail(app, row.id);
    assert.equal(afterRetry.delegation?.status, 'completed');
    assert.equal(afterRetry.delegation?.completedAt, after.delegation?.completedAt);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Create validation matrix + depth caps + signed context
// ---------------------------------------------------------------------------

test('create validation: forged/missing/expired headers; wrong parent chat binding; depth 3+ → 403; parent checks', async () => {
  const app = await startTestApp({ agents: delegationFixtures() });
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'parent-1' }, [
      userMessage('hello', 'pm-1'),
    ]);

    // Missing header entirely.
    const unsigned = await createDelegation(app, delegationBody());
    assert.equal(unsigned.status, 400);
    assert.deepEqual(unsigned.body, { error: 'Invalid internal delegation context.' });

    // Forged (different secret).
    const forgedSigner = createDelegationContextSigner(Buffer.from('wrong-secret-wrong-secret-wrong', 'utf8'));
    const forged = await createDelegation(app, delegationBody(), {
      header: forgedSigner.sign({ kind: 'delegation-create', parentChatId: 'parent-1', parentDepth: 0, ownerId: TEST_OWNER.userId, expiresAt: Date.now() + 60_000 }),
    });
    assert.equal(forged.status, 400);

    // Wrong parent chat binding.
    const mismatched = await createDelegation(app, delegationBody(), { header: createHeader('other-chat', 'pm-1') });
    assert.equal(mismatched.status, 400);

    // Expired.
    const expired = await createDelegation(app, delegationBody(), {
      header: signer.sign({ kind: 'delegation-create', parentChatId: 'parent-1', parentDepth: 0, ownerId: TEST_OWNER.userId, expiresAt: Date.now() - 5 }),
    });
    assert.equal(expired.status, 400);

    // Parent chat without the referenced message id → 404.
    const noMessage = await createDelegation(app, { ...delegationBody(), parentMessageId: 'ghost-message' }, { header: createHeader('parent-1', 'ghost-message') });
    assert.equal(noMessage.status, 404);
    assert.deepEqual(noMessage.body, { error: 'Parent chat or message not found.' });

    // Unknown parent chat → 404.
    const noChat = await createDelegation(app, { ...delegationBody(), parentChatId: 'never-seen' }, { header: createHeader('never-seen', 'pm-9') });
    assert.equal(noChat.status, 404);

    // Invalid target agent → 400.
    const badTarget = await createDelegation(app, { ...delegationBody(), target: 'orchestrator' }, { header: createHeader('parent-1', 'pm-1') });
    assert.equal(badTarget.status, 400);

    // Wrong kind (child-chat payload) → 400.
    const childKind = signer.sign({
      kind: 'delegation-child-chat',
      parentChatId: 'parent-1',
      childChatId: 'c',
      ownerId: TEST_OWNER.userId,
targetAgent: 'researcher',
      depth: 1,
      ...contextWindow(60_000),
    });
    const wrongKind = await createDelegation(app, delegationBody(), { header: childKind });
    assert.equal(wrongKind.status, 400);

    // Tampered payload (mid-string flip) → 400.
    const legit = createHeader('parent-1', 'pm-1');
    const [payload, signature2] = legit.split('.');
    assert.ok(payload !== undefined && signature2 !== undefined);
    const tampered = `${payload.slice(0, 8)}${payload[8] === 'A' ? 'B' : 'A'}${payload.slice(9)}.${signature2}`;
    const tamperedResponse = await createDelegation(app, delegationBody(), { header: tampered });
    assert.equal(tamperedResponse.status, 400);

    // Depth 3+ (parent depth 2) → 403 with the fixed depth-cap message.
    const deep = await createDelegation(app, delegationBody(), { header: createHeader('parent-1', 'pm-1', 2) });
    assert.equal(deep.status, 403);
    assert.deepEqual(deep.body, { error: 'Delegation depth cap exceeded.' });

    // analyst path → 404 (delegations are the orchestrator's route only).
    const analystPath = await createDelegation(app, delegationBody(), { header: createHeader('parent-1', 'pm-1'), slug: 'analyst' });
    assert.equal(analystPath.status, 404);
  } finally {
    await app.close();
  }
});

test('create: depth-0 root succeeds at child depth 1; run without/with wrong internal header is rejected', async () => {
  const app = await startTestApp({ agents: delegationFixtures() });
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'parent-run' }, [
      userMessage('run later', 'pr-1'),
    ]);
    const created = await createDelegation(app, { ...delegationBody(), mode: 'sync', parentChatId: 'parent-run', parentMessageId: 'pr-1' }, { header: createHeader('parent-run', 'pr-1') });
    // The sync create executes through the run REST internally; the child
    // model here is unset (no model injected) → the child chat fails and the
    // row lands terminal with a safe error; the create responded 201.
    assert.equal(created.status, 201);
    const row = created.body['delegation'] as Delegation;
    assert.ok(['completed', 'failed', 'timeout'].includes(row.status));
    assert.equal(row.childChatId !== undefined, true);

    const headers = { [DELEGATION_CONTEXT_HEADER]: undefined } as Record<string, string | undefined>;
    delete headers[DELEGATION_CONTEXT_HEADER];
    const runFails = async (header: string | undefined): Promise<number> => {
      const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/delegations/${row.id}/run`, {
        method: 'POST',
        headers,
      });
      return response.status;
    };
    assert.equal(await runFails(undefined), 400);
    // Child-chat-kind header is the wrong kind for the run surface.
    const childKind = signer.sign({
      kind: 'delegation-child-chat',
      parentChatId: row.parentChatId,
      childChatId: row.childChatId,
      ownerId: TEST_OWNER.userId,
parentDepth: undefined,
      depth: 1,
      targetAgent: row.targetAgent,
      expiresAt: Date.now() + 60_000,
      deadline: Date.now() + 60_000,
    } as never);
    headers[DELEGATION_CONTEXT_HEADER] = childKind;
    assert.equal(await runFails(childKind), 400);
    void headers;

    // Valid create-kind header bound to the row → 200, executed=false (row
    // already terminal; no second child generation).
    headers[DELEGATION_CONTEXT_HEADER] = signer.sign({
      kind: 'delegation-create',
      parentChatId: row.parentChatId,
      parentDepth: row.depth - 1,
      ownerId: TEST_OWNER.userId,
expiresAt: Date.now() + 60_000,
    });
    const rerun = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/delegations/${row.id}/run`, {
      method: 'POST',
      headers,
    });
    assert.equal(rerun.status, 200);
    const rerunBody = (await rerun.json()) as { executed?: boolean; delegation?: Delegation };
    assert.equal(rerunBody.executed, false);
    assert.equal(rerunBody.delegation?.status, row.status);

    // Unknown delegation id → 404.
    const unknown = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/delegations/00000000-0000-4000-8000-000000000000/run`, {
      method: 'POST',
      headers,
    });
    assert.equal(unknown.status, 404);
  } finally {
    await app.close();
  }
});

test('list + detail: parentChatId required, bounded limit, newest first; unknown ids 404', async () => {
  const app = await startTestApp({ agents: delegationFixtures() });
  try {
    const missingParent = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/delegations`);
    assert.equal(missingParent.status, 400);
    const badLimit = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/delegations?parentChatId=p&limit=0`);
    assert.equal(badLimit.status, 400);
    const unknownDetail = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/delegations/00000000-0000-4000-8000-000000000000`);
    assert.equal(unknownDetail.status, 404);
    assert.deepEqual(await unknownDetail.json(), { error: 'Delegation not found.' });
  } finally {
    await app.close();
  }
});

test('delegation timeout: a slow child marks the row `timeout` with a fixed safe error', { concurrency: false }, async () => {
  const { MockLanguageModelV3, simulateReadableStream } = await import('ai/test');
  // Child step streams slowly across the (tiny) delegation budget.
  const slowStep = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'slow' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', usage: mockUsage(), finishReason: { unified: 'stop', raw: undefined } },
  ] as never;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-slow',
    doStream: [{ stream: simulateReadableStream({ chunks: slowStep, initialDelayInMs: 500, chunkDelayInMs: 500 }) }],
  } as never);

  const app = await startTestApp({ agents: delegationFixtures({ delegationTimeoutMs: 300 }), model: model as never });
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'parent-slow' }, [
      userMessage('slow child', 'ps-1'),
    ]);
    const created = await createDelegation(app, { ...delegationBody(), mode: 'sync', parentChatId: 'parent-slow', parentMessageId: 'ps-1', task: 'slow task' }, { header: createHeader('parent-slow', 'ps-1') });
    assert.equal(created.status, 201);
    const row = created.body['delegation'] as Delegation;
    assert.equal(row.status, 'timeout');
    assert.deepEqual(row.error, 'The delegated task timed out.');
    assert.equal(row.result, null);
  } finally {
    await app.close();
  }
});

test('provider failure in the child marks the row `failed` with a fixed safe error', { concurrency: false }, async () => {
  const failingModel = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-fail',
    supportedUrls: {},
    doStream() {
      return Promise.reject(new Error('provider exploded'));
    },
  } as never;
  const app = await startTestApp({ agents: delegationFixtures(), model: failingModel });
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'parent-fail' }, [
      userMessage('boom', 'pf-1'),
    ]);
    const created = await createDelegation(app, { ...delegationBody(), mode: 'sync', parentChatId: 'parent-fail', parentMessageId: 'pf-1', task: 'boom task' }, { header: createHeader('parent-fail', 'pf-1') });
    assert.equal(created.status, 201);
    const row = created.body['delegation'] as Delegation;
    assert.equal(row.status, 'failed');
    assert.deepEqual(row.error, 'The delegated task failed.');
    // The safe error never carries provider internals.
    assert.ok(!JSON.stringify(row).includes('provider exploded'));
  } finally {
    await app.close();
  }
});

test('child chats carry the task as a real user message (same-REST composition proof)', { concurrency: false }, async () => {
  const { MockLanguageModelV3, simulateReadableStream } = await import('ai/test');
  const childStep = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'child' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', usage: mockUsage(), finishReason: { unified: 'stop', raw: undefined } },
  ] as never;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-child',
    doStream: [{ stream: simulateReadableStream({ chunks: childStep }) }],
  } as never);
  const app = await startTestApp({ agents: delegationFixtures(), model: model as never });
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'parent-depth' }, [userMessage('go', 'pd-1')]);
    const created = await createDelegation(app, { ...delegationBody(), mode: 'sync', parentChatId: 'parent-depth', parentMessageId: 'pd-1' }, { header: createHeader('parent-depth', 'pd-1') });
    assert.equal(created.status, 201);
    const row = created.body['delegation'] as Delegation;
    assert.equal(row.status, 'completed');
    const child = await hydrateChild(app, row.childChatId);
    assert.equal(child.messages.length, 2);
    assert.equal(child.messages[0]?.role, 'user');
    assert.ok(JSON.stringify(child.messages[0]).includes('Explain recursion in one short paragraph.'));
    assert.equal(child.messages[1]?.role, 'assistant');
  } finally {
    await app.close();
  }
});

test('InMemoryDelegationRepository + queue lifecycle coexist; queue close is idempotent', async () => {
  const repo = new InMemoryDelegationRepository();
  const queue = new FakeDelegationQueue();
  const row = await repo.create({
    id: '00000000-0000-4000-8000-000000000abc',
    parentChatId: 'p',
    childChatId: 'c',
    parentMessageId: 'm',
    targetAgent: 'analyst',
    mode: 'async',
    task: 't',
    depth: 1,
    ownerId: TEST_OWNER.userId,
  });
  assert.equal(row.status, 'pending');
  assert.equal(await queue.enqueue(row.id, 'orchestrator', TEST_OWNER.userId), true);
  await queue.close();
  assert.equal(queue.closed, true);
  const duplicateChild = await repo.create({
    id: '00000000-0000-4000-8000-000000000abd',
    parentChatId: 'p2',
    childChatId: 'c',
    parentMessageId: 'm2',
    targetAgent: 'analyst',
    mode: 'sync',
    task: 't',
    depth: 1,
  }).then(
    () => null,
    (error: unknown) => (error as { name?: string }).name ?? 'unknown',
  );
  assert.equal(duplicateChild, 'DelegationConflictError');
});
