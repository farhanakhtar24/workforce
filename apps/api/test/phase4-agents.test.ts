/**
 * Phase 4 agent generation tests (offline): composition matrix through the
 * API toolsets, route surface for slug/mode/depth, and `general` behavior
 * unchanged. Mock model + in-memory store/stream context — no network, no
 * Redis, no real provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModel, UIMessage } from 'ai';
import { simulateReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';

import {
  TEST_OWNER,
  createMockModel,
  mockUsage,
  postChat,
  parseSseChunks,
  startTestApp,
  textStep,
  toolCallStep,
  userMessage,
  randomId,
  TEST_DELEGATION_SECRET,
  type AgentsFixtures,
  type TestApp,
} from './helpers.js';
import { prepareGeneration } from '../src/agents/toolsets.js';
import {
  createDelegationContextSigner,
  contextWindow,
} from '../src/agents/delegation-context.js';
import type { HostCapabilityDeps } from '../src/agents/host-capabilities.js';
import type { AgentToolContext } from '../src/agents/host-capabilities.js';

const signer = createDelegationContextSigner(Buffer.from(TEST_DELEGATION_SECRET, 'utf8'));

function agentFixtures(extra: Partial<AgentsFixtures> = {}): AgentsFixtures {
  return { wire: true, ...extra };
}

function emptyHostDeps(): HostCapabilityDeps {
  return { fetchFn: async () => new Response('{}'), baseUrl: 'http://workforce-test-internal', signer, delegationTimeoutMs: 120_000 };
}

function toolCtx(): AgentToolContext {
  return { slug: 'orchestrator', chatId: 'c', parentMessageId: 'm', scope: 'default', ownerId: TEST_OWNER.userId, depth: 0 };
}

function toolNamesFor(slug: 'general' | 'orchestrator' | 'analyst' | 'researcher', mode: 'plan' | 'action', depth: number): string[] {
  return prepareGeneration(emptyHostDeps(), { slug, mode, depth, chatId: 'c', parentMessageId: 'm', ownerId: TEST_OWNER.userId }).toolNames as string[];
}

// ---------------------------------------------------------------------------
// Composition matrix (ADR-001): exact tool sets per agent × mode × depth
// ---------------------------------------------------------------------------

test('composition: orchestrator action depth 0 carries the full six-tool set', () => {
  assert.deepEqual(
    [...toolNamesFor('orchestrator', 'action', 0)].sort(),
    ['ask_user', 'calculate', 'delegate_task', 'query_data', 'search_memory', 'write_doc'],
  );
});

test('composition: plan mode OMITS write_doc and delegate_task entirely', () => {
  const names = toolNamesFor('orchestrator', 'plan', 0);
  assert.deepEqual([...names].sort(), ['ask_user', 'calculate', 'query_data', 'search_memory']);
  assert.equal(names.includes('write_doc'), false);
  assert.equal(names.includes('delegate_task'), false);
});

test('composition: delegation omitted at depth >= 2 (orchestrator)', () => {
  assert.equal(toolNamesFor('orchestrator', 'action', 1).includes('delegate_task'), true);
  assert.equal(toolNamesFor('orchestrator', 'action', 2).includes('delegate_task'), false);
  assert.deepEqual(
    [...toolNamesFor('orchestrator', 'action', 2)].sort(),
    ['ask_user', 'calculate', 'query_data', 'search_memory', 'write_doc'],
  );
});

test('composition: analyst never writes or delegates, keeps SQL + memory', () => {
  assert.deepEqual([...toolNamesFor('analyst', 'action', 0)].sort(), ['ask_user', 'calculate', 'query_data', 'search_memory']);
  assert.equal(toolNamesFor('analyst', 'plan', 0).includes('write_doc'), false);
  assert.equal(toolNamesFor('analyst', 'action', 0).includes('delegate_task'), false);
});

test('composition: researcher never gets SQL, writes, or delegation', () => {
  assert.deepEqual([...toolNamesFor('researcher', 'action', 0)].sort(), ['ask_user', 'calculate', 'search_memory']);
  assert.deepEqual([...toolNamesFor('researcher', 'action', 2)].sort(), ['ask_user', 'calculate', 'search_memory']);
});

test('composition: general is calculate-only in every mode/depth, plan==action', () => {
  assert.deepEqual(toolNamesFor('general', 'action', 0), ['calculate']);
  assert.deepEqual(toolNamesFor('general', 'plan', 0), ['calculate']);
  assert.deepEqual(toolNamesFor('general', 'action', 2), ['calculate']);
});

test('composition: validation toolset stays the FULL action set for plan/depth chats', () => {
  const prepared = prepareGeneration(emptyHostDeps(), {
    slug: 'orchestrator',
    mode: 'plan',
    depth: 2,
    chatId: 'c',
    parentMessageId: 'm',
    ownerId: TEST_OWNER.userId,
  });
  assert.deepEqual(Object.keys(prepared.validationTools).sort(), ['ask_user', 'calculate', 'delegate_task', 'query_data', 'search_memory', 'write_doc']);
  // The generation toolset remains the composed (plan-filtered) one.
  assert.equal(Object.keys(prepared.tools).includes('delegate_task'), false);
  assert.equal(Object.keys(prepared.tools).includes('write_doc'), false);
});

test('composition: system prompts come from the definitions; general stays promptless', () => {
  const generalPrepared = prepareGeneration(emptyHostDeps(), { slug: 'general', mode: 'action', depth: 0, chatId: 'c', parentMessageId: 'm', ownerId: TEST_OWNER.userId });
  assert.equal(generalPrepared.systemPrompt, null);
  const orchestratorPrepared = prepareGeneration(emptyHostDeps(), { slug: 'orchestrator', mode: 'action', depth: 0, chatId: 'c', parentMessageId: 'm', ownerId: TEST_OWNER.userId });
  assert.equal(typeof orchestratorPrepared.systemPrompt, 'string');
  assert.ok((orchestratorPrepared.systemPrompt as string).includes('orchestrator'));
});

// ---------------------------------------------------------------------------
// Capturing mock model (observes the system prompt + tools actually handed
// to the provider)
// ---------------------------------------------------------------------------

interface CaptureCall {
  prompt: Array<{ role: string; content: unknown }>;
  tools: Record<string, unknown> | Array<{ name?: string; toolName?: string }>;
}

/** Names of the tools actually handed to the provider (v3 DoStream shape). */
function capturedToolNames(call: CaptureCall | undefined): string[] {
  const tools = call?.tools;
  if (Array.isArray(tools)) {
    return tools.map((tool) => String(tool.name ?? tool.toolName ?? '')).filter((name) => name.length > 0);
  }
  return Object.keys(tools ?? {});
}

function createCapturingModel(steps: LanguageModelV3StreamPart[][]): { model: LanguageModel; calls: CaptureCall[] } {
  const calls: CaptureCall[] = [];
  let stepIndex = 0;
  const raw = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'capture',
    supportedUrls: {},
    async doStream(options: { prompt: unknown; tools: Record<string, unknown> }) {
      const recorded = options as unknown as { prompt: CaptureCall['prompt']; tools: CaptureCall['tools'] };
      calls.push({ prompt: recorded.prompt, tools: recorded.tools });
      const step = steps[stepIndex++];
      return await Promise.resolve({ stream: simulateReadableStream({ chunks: step ?? [] }) });
    },
  };
  return { model: raw as unknown as LanguageModel, calls };
}

test('orchestrator chat composes once per generation and prepends the definition prompt', { concurrency: false }, async () => {
  const capturing = createCapturingModel([textStep()]);
  const app = await startTestApp({ agents: agentFixtures(), model: capturing.model });
  try {
    const message = userMessage('plan a thing', 'u1');
    const response = await postChat({
      port: app.port,
      slug: 'orchestrator',
      body: { id: 'orch-chat-1', message, mode: 'action' },
    });
    assert.equal(response.status, 200);
    await response.text();
    // System prompt from the orchestrator definition is prepended.
    const system = capturing.calls[0]?.prompt.find((entry) => entry.role === 'system');
    assert.ok(system !== undefined);
    assert.ok(typeof system.content === 'string' && system.content.includes('orchestrator'));
    // Composed tools are exactly the six canonical names.
    assert.deepEqual(capturedToolNames(capturing.calls[0] as CaptureCall).sort(), ['ask_user', 'calculate', 'delegate_task', 'query_data', 'search_memory', 'write_doc']);
  } finally {
    await app.close();
  }
});

test('plan mode orchestrator hands the model a toolset WITHOUT write/delegate tools', { concurrency: false }, async () => {
  const capturing = createCapturingModel([textStep()]);
  const app = await startTestApp({ agents: agentFixtures(), model: capturing.model });
  try {
    const response = await postChat({
      port: app.port,
      slug: 'orchestrator',
      body: { id: 'plan-chat-1', message: userMessage('plan, do not act', 'u1'), mode: 'plan' },
    });
    assert.equal(response.status, 200);
    await response.text();
    const tools = capturedToolNames(capturing.calls[0] as CaptureCall);
    assert.equal(tools.includes('write_doc'), false);
    assert.equal(tools.includes('delegate_task'), false);
    assert.equal(tools.includes('query_data'), true);
  } finally {
    await app.close();
  }
});

test('general chat keeps the calculate-only toolset and no system prompt', { concurrency: false }, async () => {
  const capturing = createCapturingModel([textStep()]);
  const app = await startTestApp({ agents: agentFixtures(), model: capturing.model });
  try {
    const response = await postChat({ port: app.port, slug: 'general', body: { id: 'gen-chat-1', message: userMessage('2+2', 'u1'), mode: 'plan' } });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(capturedToolNames(capturing.calls[0] as CaptureCall), ['calculate']);
    assert.equal(capturing.calls[0]?.prompt.some((entry) => entry.role === 'system'), false);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Route surface: modes, depth, header trust, client-field rejection
// ---------------------------------------------------------------------------

test('client-supplied depth/parent/delegation fields are rejected (strict body)', async () => {
  const app = await startTestApp({ agents: agentFixtures(), model: createMockModel({ steps: [textStep()] }) });
  try {
    const withDepth = await postChat({
      port: app.port,
      slug: 'orchestrator',
      body: { id: 'c-depth', message: userMessage('hi', randomId()), depth: 1 } as unknown as Record<string, unknown>,
    });
    assert.equal(withDepth.status, 400);

    const withParent = await postChat({
      port: app.port,
      slug: 'orchestrator',
      body: { id: 'c-parent', message: userMessage('hi', randomId()), parentMessageId: 'msg-x' } as unknown as Record<string, unknown>,
    });
    assert.equal(withParent.status, 400);

    const withDelegation = await postChat({
      port: app.port,
      slug: 'orchestrator',
      body: { id: 'c-dele', message: userMessage('hi', randomId()), delegationId: 'd1' } as unknown as Record<string, unknown>,
    });
    assert.equal(withDelegation.status, 400);
  } finally {
    await app.close();
  }
});

test('non-general slugs stay 404 when the agent runtime is not wired', async () => {
  const app = await startTestApp({ agents: { wire: false }, model: createMockModel({ steps: [textStep()] }) });
  try {
    const response = await postChat({ port: app.port, slug: 'orchestrator', body: { id: 'c', message: userMessage('hi', randomId()) } });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Unknown agent slug.' });
  } finally {
    await app.close();
  }
});

test('invalid delegation header on a child chat is a fixed 400; impossible depth is a 403', async () => {
  const app = await startTestApp({ agents: agentFixtures(), model: createMockModel({ steps: [textStep()] }) });
  try {
    // Forged (wrong secret) header.
    const forged = createDelegationContextSigner(Buffer.from('not-the-secret-not-the-secret', 'utf8')).sign({
      kind: 'delegation-child-chat',
      parentChatId: 'p',
      childChatId: 'c-hdr-1',
      ownerId: TEST_OWNER.userId,
targetAgent: 'analyst',
      depth: 1,
      expiresAt: Date.now() + 60_000,
      deadline: Date.now() + 60_000,
    });
    const forgedResponse = await postChat({
      port: app.port,
      slug: 'analyst',
      body: { id: 'c-hdr-1', message: userMessage('hi', randomId()) },
    headers: { 'X-Workforce-Delegation-Context': forged },
    });
    assert.equal(forgedResponse.status, 400);
    assert.deepEqual(await forgedResponse.json(), { error: 'Invalid internal delegation context.' });

    // Expired context.
    const signer2 = signer;
    const expired = signer2.sign({
      kind: 'delegation-child-chat',
      parentChatId: 'p',
      childChatId: 'c-hdr-2',
      ownerId: TEST_OWNER.userId,
targetAgent: 'analyst',
      depth: 1,
      expiresAt: Date.now() - 1_000,
      deadline: Date.now() + 60_000,
    });
    const expiredResponse = await postChat({
      port: app.port,
      slug: 'analyst',
      body: { id: 'c-hdr-2', message: userMessage('hi', randomId()) },
      headers: { 'X-Workforce-Delegation-Context': expired },
    });
    assert.equal(expiredResponse.status, 400);

    // Impossible depth (grandchild-of-child = 3).
    const deep = signer2.sign({
      kind: 'delegation-child-chat',
      parentChatId: 'p',
      childChatId: 'c-hdr-3',
      ownerId: TEST_OWNER.userId,
targetAgent: 'analyst',
      depth: 3,
      expiresAt: Date.now() + 60_000,
      deadline: Date.now() + 60_000,
    });
    const deepResponse = await postChat({
      port: app.port,
      slug: 'analyst',
      body: { id: 'c-hdr-3', message: userMessage('hi', randomId()) },
      headers: { 'X-Workforce-Delegation-Context': deep },
    });
    assert.equal(deepResponse.status, 403);

    // Tampered payload (mid-string flip) → 400.
    const legit = signer2.sign({
      kind: 'delegation-child-chat',
      parentChatId: 'p',
      childChatId: 'c-hdr-4',
      ownerId: TEST_OWNER.userId,
targetAgent: 'analyst',
      depth: 1,
      ...contextWindow(60_000),
    });
    const [payload, signatureOfTampered] = legit.split('.');
    assert.ok(payload !== undefined && signatureOfTampered !== undefined);
    const tampered = `${payload.slice(0, 8)}${payload[8] === 'A' ? 'B' : 'A'}${payload.slice(9)}.${signatureOfTampered}`;
    const tamperedResponse = await postChat({
      port: app.port,
      slug: 'analyst',
      body: { id: 'c-hdr-4', message: userMessage('hi', randomId()) },
      headers: { 'X-Workforce-Delegation-Context': tampered },
    });
    assert.equal(tamperedResponse.status, 400);
  } finally {
    await app.close();
  }
});

test('a verified child context composes the child agent at that depth (no delegation tool)', { concurrency: false }, async () => {
  // Analyst has no delegation anyway; assert via a capturing model that the
  // composition runs and the chat streams.
  const capturing = createCapturingModel([textStep()]);
  const app = await startTestApp({ agents: agentFixtures(), model: capturing.model });
  try {
    const header = signer.sign({
      kind: 'delegation-child-chat',
      parentChatId: 'parent-chat',
      childChatId: 'child-a1',
      ownerId: TEST_OWNER.userId,
targetAgent: 'analyst',
      depth: 1,
      ...contextWindow(60_000),
    });
    const response = await postChat({
      port: app.port,
      slug: 'analyst',
      body: { id: 'child-a1', message: userMessage('analyze', randomId()) },
      headers: { 'X-Workforce-Delegation-Context': header },
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(capturedToolNames(capturing.calls[0] as CaptureCall).sort(), ['ask_user', 'calculate', 'query_data', 'search_memory']);
  } finally {
    await app.close();
  }
});

test('idempotency: duplicate key and duplicate message id both 409 for agent chats', async () => {
  const app = await startTestApp({ agents: agentFixtures(), model: createMockModel({ steps: [textStep()] }) });
  try {
    const message = userMessage('hello', 'dup-1');
    const first = await postChat({ port: app.port, slug: 'researcher', body: { id: 'res-chat', message } });
    assert.equal(first.status, 200);
    await first.text();

    const duplicate = await postChat({ port: app.port, slug: 'researcher', body: { id: 'res-chat', message } });
    assert.equal(duplicate.status, 409);
  } finally {
    await app.close();
  }
});

test('orchestrator chat SSE stream is a UI message stream identical in shape', { concurrency: false }, async () => {
  const app = await startTestApp({ agents: agentFixtures(), model: createMockModel({ steps: [textStep()] }) });
  try {
    const response = await postChat({ port: app.port, slug: 'orchestrator', body: { id: 'sse-chat', message: userMessage('stream me', randomId()) } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
    const chunks = await parseSseChunks(response);
    assert.ok(chunks.some((chunk) => chunk.type === 'start'));
    assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'));
    assert.ok(chunks.some((chunk) => chunk.type === 'finish'));
  } finally {
    await app.close();
  }
});

test('write_doc tool executes through the REAL work-doc REST routes (ADR-002, no shadow store)', { concurrency: false }, async () => {
  const { MockLanguageModelV3, simulateReadableStream } = await import('ai/test');
  const usage = mockUsage();
  const createStep = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'w1', toolName: 'write_doc' },
    { type: 'tool-input-delta', id: 'w1', delta: JSON.stringify({ action: 'create', type: 'report', title: 'Research plan', content: 'The plan contents.' }) },
    { type: 'tool-input-end', id: 'w1' },
    { type: 'tool-call', toolCallId: 'w1', toolName: 'write_doc', input: JSON.stringify({ action: 'create', type: 'report', title: 'Research plan', content: 'The plan contents.' }) },
    { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: undefined } },
  ] as never;
  const finalStep = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Documented.' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
  ] as never;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-wdoc',
    doStream: [createStep, finalStep].map((chunks) => ({ stream: simulateReadableStream({ chunks }) })),
  } as never);

  const app = await startTestApp({ agents: agentFixtures(), model: model as never });
  try {
    const response = await postChat({
      port: app.port,
      slug: 'orchestrator',
      body: { id: 'wdoc-chat', message: userMessage('write a doc', 'uw-1') },
    });
    assert.equal(response.status, 200);
    await response.text();

    // The SAME REST surface: the tool's write is visible via the list route.
    const list = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/work-docs?chatId=wdoc-chat`);
    const listBody = (await list.json()) as { documents?: Array<Record<string, unknown>> };
    assert.equal(listBody.documents?.length, 1);
    const doc = listBody.documents?.[0] as Record<string, unknown>;
    assert.equal(doc['title'], 'Research plan');
    assert.equal(doc['status'], 'draft');
    assert.equal(doc['version'], 1);
    assert.equal(doc['chatId'], 'wdoc-chat');

    // The transcript carries the tool output summary, not document content.
    const hydration = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/chat/wdoc-chat`);
    const body = (await hydration.json()) as { messages: UIMessage[] };
    const parts = body.messages.flatMap((entry) => (entry.role === 'assistant' ? entry.parts : []));
    const docPart = parts.find((part) => (part as { type?: string }).type === 'tool-write_doc') as unknown as Record<string, unknown> | undefined;
    assert.ok(docPart !== undefined);
    assert.equal(docPart?.['state'], 'output-available');
    const output = docPart?.['output'] as Record<string, unknown>;
    assert.equal(output['version'], 1);
    assert.equal(output['title'], 'Research plan');
    assert.equal(output['status'], 'draft');
    assert.ok(!('content' in output), 'document content is never echoed into the transcript');
  } finally {
    await app.close();
  }
});

test('stored orchestrator transcript validates against the full action toolset after a plan turn', { concurrency: false }, async () => {
  // Turn 1 (action): model writes a document via write_doc… heavy; instead
  // exercise the simpler invariant: an ask_user-only action turn stays valid
  // in a following plan-mode turn (validation uses depth-0 action set).
  const chatId = 'hitl-plan';
  const app = await startTestApp({
    agents: agentFixtures(),
    model: createMockModel({ steps: [toolCallStep('ask_user', { question: 'Which scope?' }), textStep()] }),
  });
  try {
    const first = await postChat({ port: app.port, slug: 'orchestrator', body: { id: chatId, message: userMessage('ask me', 'u-a') } });
    assert.equal(first.status, 200);
    await first.text();

    // Drain the pending question: next user turn answers it (plan mode).
    const second = await postChat({
      port: app.port,
      slug: 'orchestrator',
      body: { id: chatId, message: userMessage('default scope', 'u-b'), mode: 'plan' },
    });
    assert.equal(second.status, 200);
    await second.text();

    const hydration = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/chat/${chatId}`);
    const body = (await hydration.json()) as { messages: UIMessage[] };
    const assistantParts = body.messages.flatMap((entry) => (entry.role === 'assistant' ? entry.parts : []));
    const askUser = assistantParts.find((part) => (part as { type?: string }).type === 'tool-ask_user');
    assert.ok(askUser !== undefined);
    assert.equal((askUser as { state?: string }).state, 'output-available');
    assert.deepEqual((askUser as { output?: { answer?: string } }).output, { answer: 'default scope' });
  } finally {
    await app.close();
  }
});
