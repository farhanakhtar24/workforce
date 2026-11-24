/**
 * Route-level integration tests over a real HTTP server (ephemeral port) with:
 * - injected mock model (ai/test MockLanguageModelV3) — no Ollama, no network,
 * - in-memory ChatStore + in-memory StreamContext — no Redis,
 * - real Express middleware, routes, adapter, serialization.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { MockLanguageModelV3 } from 'ai/test';
import type { UIMessage } from 'ai';

import {
  TEST_OWNER,
  createMockModel,
  createFailingModel,
  calculateStep,
  textStep,
  mockUsage,
  parseSseChunks,
  postChat,
  startTestApp,
  userMessage,
  seedMessages,
  TEST_ORIGINAL_ORIGIN,
} from './helpers.js';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createInMemoryStreamContext } from '../src/stream-context/memory.js';
import { STREAM_ERROR_TEXT } from '../src/generation.js';
import { IDEMPOTENCY_KEY_TTL_SECONDS } from '../src/store/types.js';
import type { ChatStore } from '../src/store/types.js';

const CHAT = 'chat-1';
/** The owner the buildApp test injection attaches ({@link TEST_OWNER}). */
const REF = { ownerId: TEST_OWNER.userId } as const;

function chatBody(message: { id: string; text: string }): { id: string; message: UIMessage } {
  return {
    id: CHAT,
    message: { id: message.id, role: 'user', parts: [{ type: 'text', text: message.text }] },
  };
}

test('GET /health returns {status:"ok"} with no details', async () => {
  const app = await startTestApp({
    model: createMockModel({ steps: [textStep()] }),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await app.close();
  }
});

test('unknown slugs 404 on every chat route', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const message = userMessage('hello');
    const post = await postChat({ port: app.port, slug: 'admin', body: { id: CHAT, message } });
    assert.equal(post.status, 404);
    assert.deepEqual(await post.json(), { error: 'Unknown agent slug.' });

    const hydration = await fetch(`http://127.0.0.1:${app.port}/api/agents/admin/chat/${CHAT}`);
    assert.equal(hydration.status, 404);

    const resume = await fetch(`http://127.0.0.1:${app.port}/api/agents/admin/chat/${CHAT}/stream`);
    assert.equal(resume.status, 404);
  } finally {
    await app.close();
  }
});

test('hydration: unknown chat is empty, no active stream, no-store', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { messages: [], hasActiveStream: false });
  } finally {
    await app.close();
  }
});

test('hydration: seeded chat returns stored UIMessages and no-store', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const stored: UIMessage[] = [
      { id: 'msg-user', role: 'user', parts: [{ type: 'text', text: 'seed' }] },
    ];
    await seedMessages(app.store, { ...REF, slug: 'general', chatId: CHAT }, stored);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { messages: UIMessage[]; hasActiveStream: boolean };
    assert.deepEqual(body.messages, stored);
    assert.equal(body.hasActiveStream, false);
  } finally {
    await app.close();
  }
});

test('hydration rejects unsafe chat ids with 400', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${'x'.repeat(65)}`);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.equal(typeof body.error, 'string');
  } finally {
    await app.close();
  }
});

test('POST requires application/json and an exactly-shaped body', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const wrongType = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'Idempotency-Key': `${CHAT}:m1` },
      body: 'hi',
    });
    assert.equal(wrongType.status, 415);

    const withWrapperKey = await postChat({
      port: app.port,
      body: { ...chatBody({ id: 'm1', text: 'hi' }), extra: true },
    });
    assert.equal(withWrapperKey.status, 400);

    const missingId = await postChat({
      port: app.port,
      body: { message: chatBody({ id: 'm1', text: 'hi' }).message },
    });
    assert.equal(missingId.status, 400);
  } finally {
    await app.close();
  }
});

test('POST requires Idempotency-Key in chatId:messageId form and matching the body', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const url = `http://127.0.0.1:${app.port}/api/agents/general/chat`;
    const missing = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody({ id: 'm1', text: 'hi' })),
    });
    assert.equal(missing.status, 400);

    const mismatch = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'chat-1:other-id' },
      body: JSON.stringify(chatBody({ id: 'm1', text: 'hi' })),
    });
    assert.equal(mismatch.status, 400);
  } finally {
    await app.close();
  }
});

test('POST happy path: SSE response, server-generated ids, full persistence', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const message = userMessage('hello', 'user-hi');
    const response = await postChat({
      port: app.port,
      body: { id: CHAT, message },
      headers: { Origin: TEST_ORIGINAL_ORIGIN },
    });
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('content-type') ?? '').startsWith('text/event-stream'));
    assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.equal(response.headers.get('access-control-allow-origin'), TEST_ORIGINAL_ORIGIN);

    const chunks = await parseSseChunks(response);
    const start = chunks.find((chunk) => chunk.type === 'start') as { type: string; messageId: string };
    assert.ok(start !== undefined, 'stream must contain a start chunk');
    assert.match(start.messageId, /^msg-/);
    const deltas = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk as unknown as { delta: string }).delta)
      .join('');
    assert.equal(deltas, 'Hello world!');
    assert.ok(chunks.some((chunk) => chunk.type === 'finish'));

    await app.background.waitForAll(2_000);
    const snapshot = (
      app.store as ReturnType<typeof import('../src/store/memory.js').createInMemoryChatStore>
    ).snapshot({ ...REF, slug: 'general', chatId: CHAT });
    assert.equal(snapshot.activeStreamId, null);
    const messages = snapshot.messages as UIMessage[];
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.id, 'user-hi');
    const assistant = messages[1];
    // The streamed assistant message id matches the persisted one: stable,
    // server-generated (never a client id).
    assert.match(assistant?.id ?? '', /^msg-/);
    assert.equal(assistant?.id, start.messageId);
    assert.equal(assistant?.role, 'assistant');
    const text = assistant?.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    assert.equal(text, 'Hello world!');

    // The streamed assistant message id matches the persisted one.
    assert.equal(assistant?.id, start.messageId);
  } finally {
    await app.close();
  }
});

test('second turn: model receives the converted prior history', async () => {
  const model = createMockModel({ steps: [textStep(), textStep()] });
  const app = await startTestApp({ model });
  try {
    const first = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'turn one' }) });
    assert.equal(first.status, 200);
    await parseSseChunks(first);
    await app.background.waitForAll(2_000);

    const second = await postChat({ port: app.port, body: chatBody({ id: 'm2', text: 'turn two' }) });
    assert.equal(second.status, 200);
    await parseSseChunks(second);
    await app.background.waitForAll(2_000);

    assert.equal(model.doStreamCalls.length, 2);
    const prompt = model.doStreamCalls[1]?.prompt ?? [];
    const texts = prompt.map((message) => {
      const content =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : (message.content as Array<{ type?: string; text?: string }>);
      return content
        .map((part) => (part.type === 'text' ? (part as { text: string }).text : ''))
        .join('');
    });
    assert.equal(texts.some((text) => text.includes('turn one')), true);
    assert.equal(texts.some((text) => text.includes('Hello world!')), true);
    assert.equal(texts.at(-1)?.includes('turn two'), true);
  } finally {
    await app.close();
  }
});

test('the model sees exactly one tool (calculate) and no tool_choice', async () => {
  const model = createMockModel({ steps: [calculateStep(), textStep()] });
  const app = await startTestApp({ model });
  try {
    const response = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'compute 2+2' }) });
    assert.equal(response.status, 200);
    await parseSseChunks(response);
    await app.background.waitForAll(2_000);

    assert.equal(model.doStreamCalls.length, 2);
    const firstCall = model.doStreamCalls[0];
    // The provider call gets an array of function tools.
    const tools = firstCall?.tools ?? [];
    assert.equal(Array.isArray(tools), true);
    assert.equal(tools.length, 1, 'exactly one tool');
    const tool = tools[0] as { type?: string; name?: string };
    assert.equal(tool?.type, 'function');
    assert.equal(tool?.name, 'calculate');
    const toolChoice = firstCall?.toolChoice as { type?: string } | undefined;
    assert.deepEqual(toolChoice, { type: 'auto' }, 'no forced tool_choice is sent');

    const secondCall = model.doStreamCalls[1];
    const secondPrompt = secondCall?.prompt ?? [];
    const hasToolResult = secondPrompt.some(
      (message) =>
        message.role === 'tool' ||
        (message.role === 'assistant' &&
          message.content.some((part) => (part as { type?: string }).type === 'tool-result')),
    );
    assert.equal(hasToolResult, true);
  } finally {
    await app.close();
  }
});

test('calculate tool parts persist with output and a stable id', async () => {
  const model = createMockModel({ steps: [calculateStep('21+21'), textStep()] });
  const app = await startTestApp({ model });
  try {
    const response = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'compute 21+21' }) });
    assert.equal(response.status, 200);
    const chunks = await parseSseChunks(response);
    const toolOutput = chunks.find(
      (chunk) => chunk.type === 'tool-output-available' && (chunk as { toolCallId?: string }).toolCallId === 'c1',
    ) as { output?: string } | undefined;
    assert.ok(toolOutput !== undefined, 'tool output must be streamed');
    assert.equal(toolOutput?.output, JSON.stringify({ result: 42 }));

    await app.background.waitForAll(2_000);
    const snapshot = (
      app.store as ReturnType<typeof import('../src/store/memory.js').createInMemoryChatStore>
    ).snapshot({ ...REF, slug: 'general', chatId: CHAT });
    const assistant = (snapshot.messages as UIMessage[])[1];
    const toolPart = assistant?.parts.find(
      (part) => part.type === 'tool-calculate',
    ) as { state?: string; input?: { expression: string }; output?: string } | undefined;
    assert.ok(toolPart !== undefined);
    assert.equal(toolPart?.state, 'output-available');
    assert.deepEqual(toolPart?.input, { expression: '21+21' });
    assert.equal(toolPart?.output, JSON.stringify({ result: 42 }));
  } finally {
    await app.close();
  }
});

test('stopWhen: generation stops at step 10 even if the model keeps calling tools', async () => {
  const endlessToolSteps = Array.from({ length: 14 }, () => calculateStep(`${Math.random()}`));
  const model = createMockModel({ steps: endlessToolSteps });
  const app = await startTestApp({ model });
  try {
    const response = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'loop' }) });
    assert.equal(response.status, 200);
    await parseSseChunks(response);
    await app.background.waitForAll(5_000);
    assert.equal(model.doStreamCalls.length, 10, 'stepCountIs(10) must bound the model steps');
  } finally {
    await app.close();
  }
});

test('duplicate POST with same key: 409, no second generation', async () => {
  const model = createMockModel({ steps: [textStep()] });
  const app = await startTestApp({ model });
  try {
    const body = chatBody({ id: 'm1', text: 'once' });
    const first = await postChat({ port: app.port, body });
    assert.equal(first.status, 200);
    await parseSseChunks(first);
    await app.background.waitForAll(2_000);

    const second = await postChat({ port: app.port, body });
    assert.equal(second.status, 409);
    const bodyJson = (await second.json()) as { error: string };
    // Same (chatId, messageId) can hit either guard first depending on race:
    // stored-duplicate or existing idempotency key. Both are 409 without a
    // second generation.
    assert.match(bodyJson.error, /already|generation for this message/i);
    assert.equal(model.doStreamCalls.length, 1, 'no second model invocation');
  } finally {
    await app.close();
  }
});

test('existing idempotency key with an unpersisted message: 409, zero extra model calls', async () => {
  const model = createMockModel({ steps: [textStep(), textStep()] });
  const app = await startTestApp({ model });
  try {
    // Simulate a concurrent first request that acquired the key but has not
    // persisted its user message yet (between SET NX and appendMessage).
    const chat = { ...REF, slug: 'general' as const, chatId: CHAT };
    await app.store.acquireIdempotencyKey(chat, `${CHAT}:m2`, 900);

    const second = await postChat({ port: app.port, body: chatBody({ id: 'm2', text: 'two' }) });
    assert.equal(second.status, 409);
    const bodyJson = (await second.json()) as { error: string };
    assert.match(bodyJson.error, /generation for this message/i);
    assert.equal(model.doStreamCalls.length, 0, 'zero model calls');
  } finally {
    await app.close();
  }
});

test('duplicate user message id (fresh key): 409, zero extra model calls, store intact', async () => {
  const model = createMockModel({ steps: [textStep()] });
  const app = await startTestApp({ model });
  try {
    const first = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'one' }) });
    assert.equal(first.status, 200);
    await parseSseChunks(first);
    await app.background.waitForAll(2_000);

    // Duplicate *user message id* via a different chat id in body (new key).
    const second = await postChat({
      port: app.port,
      body: { id: 'chat-2', message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'one' }] } },
    });
    assert.equal(second.status, 200); // different chat: key scope is per chat
    await parseSseChunks(second);
    await app.background.waitForAll(2_000);

    assert.equal(model.doStreamCalls.length, 2, 'a different chat generates its own turn');

    // Same chat, same message id, new key string → duplicate-id rejection.
    const url = `http://127.0.0.1:${app.port}/api/agents/general/chat`;
    const sameMessageSameChat = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `${CHAT}:m1` },
      body: JSON.stringify(chatBody({ id: 'm1', text: 'one' })),
    });
    assert.equal(sameMessageSameChat.status, 409);
    assert.equal(model.doStreamCalls.length, 2);
  } finally {
    await app.close();
  }
});

test('user message persists (atomic append) before the model is invoked', async () => {
  const model = createMockModel({ steps: [textStep()] });
  const events: string[] = [];
  const baseStore = (await import('../src/store/memory.js')).createInMemoryChatStore();
  const store: ChatStore = {
    ...baseStore,
    async appendMessage(chat, message) {
      events.push(`append:${message.id}/${message.role}`);
      return await baseStore.appendMessage(chat, message);
    },
  };
  const app = await startTestApp({ model, store });
  try {
    const response = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'hi' }) });
    assert.equal(response.status, 200);
    await parseSseChunks(response);
    await app.background.waitForAll(2_000);

    assert.equal(events.length, 2);
    assert.equal(events[0], 'append:m1/user', 'user message appended atomically first');
    assert.match(events[1] ?? '', /^append:[^/]+\/assistant$/, 'completion appends only its own response message');
    assert.equal(model.doStreamCalls.length, 1);
  } finally {
    await app.close();
  }
});

test('provider failure becomes a safe stream error; nothing sensitive leaks', async () => {
  const app = await startTestApp({ model: createFailingModel() });
  try {
    const response = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'hi' }) });
    assert.equal(response.status, 200, 'stream still starts even when the provider fails');
    const raw = await response.text();
    assert.ok(raw.includes(STREAM_ERROR_TEXT));
    assert.equal(raw.includes('provider unavailable'), false, 'raw provider error must not leak');

    await app.background.waitForAll(2_000);
    const snapshot = (
      app.store as ReturnType<typeof import('../src/store/memory.js').createInMemoryChatStore>
    ).snapshot({ ...REF, slug: 'general', chatId: CHAT });
    assert.equal(snapshot.activeStreamId, null);
    const messages = snapshot.messages as UIMessage[];
    assert.equal(messages.length, 1, 'no empty assistant message is persisted');
  } finally {
    await app.close();
  }
});

test('mid-stream provider failure is contained; partial assistant text persists', async () => {
  const midStreamFailure: Parameters<typeof createMockModel>[0]['steps'] = [
    [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'partial ' },
      { type: 'error', error: new Error('synthetic provider outage') },
    ],
  ];
  const model = createMockModel({ steps: midStreamFailure });
  const app = await startTestApp({ model });
  const backgroundErrors: unknown[] = [];
  try {
    const response = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'hi' }) });
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.ok(raw.includes(STREAM_ERROR_TEXT));
    assert.ok(raw.includes('partial '));
    assert.equal(raw.includes('synthetic provider outage'), false);

    await app.background.waitForAll(2_000);
    const snapshot = (
      app.store as ReturnType<typeof import('../src/store/memory.js').createInMemoryChatStore>
    ).snapshot({ ...REF, slug: 'general', chatId: CHAT });
    const messages = snapshot.messages as UIMessage[];
    assert.equal(messages.length, 2, 'partial assistant content is persisted');
    const assistant = messages[1];
    assert.equal(
      (assistant?.parts ?? []).some((part) => part.type === 'text' && (part as { text: string }).text.includes('partial')),
      true,
    );
    assert.equal(backgroundErrors.length, 0);
    void backgroundErrors;
  } finally {
    await app.close();
  }
});

test('client disconnect neither aborts the model nor drops persistence', async () => {
  const model = createMockModel({
    steps: [textStep()],
    chunkDelayMs: 60,
  });
  const app = await startTestApp({ model });
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': `${CHAT}:m1`,
      },
      body: JSON.stringify(chatBody({ id: 'm1', text: 'slow hello' })),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    // Consume a byte, then disconnect mid-stream.
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();

    await app.background.waitForAll(5_000);
    assert.equal(model.doStreamCalls.length, 1);
    // No request-close cancellation was forwarded to the model.
    const abortSignal = (
      model.doStreamCalls[0] as { abortSignal?: AbortSignal | null } | undefined
    )?.abortSignal;
    assert.ok(abortSignal === undefined || abortSignal === null);

    const snapshot = (
      app.store as ReturnType<typeof import('../src/store/memory.js').createInMemoryChatStore>
    ).snapshot({ ...REF, slug: 'general', chatId: CHAT });
    assert.equal(snapshot.activeStreamId, null, 'completion still clears its own marker');
    const messages = snapshot.messages as UIMessage[];
    const assistant = messages[1];
    assert.equal(
      (assistant?.parts ?? [])
        .map((part) => (part.type === 'text' ? (part as { text: string }).text : ''))
        .join(''),
      'Hello world!',
      'full assistant text persists despite the disconnect',
    );

    // The durable checkpoint copy received the whole stream.
    const memoryContext = app.streamContext as import('../src/stream-context/memory.js').InMemoryStreamContext;
    const stateDisconnect = memoryContext.state;
    assert.ok(stateDisconnect !== undefined);
    const streamIds = [...stateDisconnect.streams.keys()];
    assert.equal(streamIds.length, 1);
    const recorded = (stateDisconnect.streams.get(streamIds[0] as string) ?? []).join('');
    assert.ok(recorded.includes('finish'));
  } finally {
    await app.close();
  }
});

function idemKey(): string {
  return `${CHAT}:${'m'}${Math.random().toString(36).slice(2, 8)}`;
}

test('resume: 204 when no stream is active', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}/stream`);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    await app.close();
  }
});

test('resume: full SSE replay with the UI message stream headers', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const chat = { ...REF, slug: 'general' as const, chatId: CHAT };
    await app.store.setActiveStreamId(chat, 'strm-active');
    const recordedFrame = 'data: {"type":"text-delta","id":"t1","delta":"Hello "}\n\n';
    const stateResume = (app.streamContext as import('../src/stream-context/memory.js').InMemoryStreamContext).state;
    assert.ok(stateResume !== undefined);
    stateResume.streams.set('strm-active', [recordedFrame, 'data: [DONE]\n\n']);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}/stream`);
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('content-type') ?? '').startsWith('text/event-stream'));
    assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
    assert.equal(await response.text(), `${recordedFrame}data: [DONE]\n\n`);
  } finally {
    await app.close();
  }
});

test('resume: 204 when the active stream vanished (server-side finish/crash)', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const chat = { ...REF, slug: 'general' as const, chatId: CHAT };
    await app.store.setActiveStreamId(chat, 'strm-gone');
    // The memory context has no record of strm-gone: resumeExistingStream → undefined.
    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}/stream`);
    assert.equal(response.status, 204);
  } finally {
    await app.close();
  }
});

test('redis unavailable: hydration, chat POST, and resume all return explicit 503', async () => {
  const failure = async (): Promise<never> => {
    throw new Error('ECONNREFUSED 127.0.0.1:6379');
  };
  const store: ChatStore = {
    loadMessages: failure,
    appendMessage: failure,
    getActiveStreamId: failure,
    setActiveStreamId: failure,
    clearActiveStreamId: failure,
    acquireIdempotencyKey: failure,
    releaseIdempotencyKey: failure,
    answerPendingAskUser: failure,
    listRecentChats: failure,
    deleteChat: failure,
    branchChat: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:6379')),
    rewindChat: failure,
    getChatModel: failure,
    setChatModel: failure,
  };
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }), store });
  const seen: unknown[] = [];
  try {
    const hygiene = await getJsonSafe(app.port, `/api/agents/general/chat/${CHAT}`);
    assert.equal(hygiene.status, 503);

    const post = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'hi' }) });
    assert.equal(post.status, 503);

    const resume = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}/stream`);
    assert.equal(resume.status, 503);
    void seen;
  } finally {
    await app.close();
  }
});

test('postChat: idempotency key is scoped per chat (same key text, different chats)', async () => {
  const model = createMockModel({ steps: [textStep(), textStep()] });
  const app = await startTestApp({ model });
  try {
    const first = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'one' }) });
    assert.equal(first.status, 200);
    await parseSseChunks(first);
    await app.background.waitForAll(2_000);

    // Identical message id and key string in another chat: acquisition succeeds.
    const second = await postChat({
      port: app.port,
      body: { id: 'chat-other', message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'one' }] } },
    });
    assert.equal(second.status, 200);
    assert.equal(model.doStreamCalls.length, 2);
  } finally {
    await app.close();
  }
});

test('CORS: web origin allowed with Idempotency-Key; other origins rejected', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const preflight = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat`, {
      method: 'OPTIONS',
      headers: { Origin: TEST_ORIGINAL_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, idempotency-key' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), TEST_ORIGINAL_ORIGIN);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(preflight.headers.get('access-control-allow-headers')?.includes('Idempotency-Key'), true);

    // Chat DELETE and the per-chat model PUT must preflight cross-origin too.
    const preflightDelete = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}`, {
      method: 'OPTIONS',
      headers: { Origin: TEST_ORIGINAL_ORIGIN, 'Access-Control-Request-Method': 'DELETE' },
    });
    assert.equal(preflightDelete.status, 204);
    const allowMethodsDelete = (preflightDelete.headers.get('access-control-allow-methods') ?? '').toUpperCase();
    assert.equal(allowMethodsDelete.includes('DELETE'), true, 'DELETE allowed');
    assert.equal(preflightDelete.headers.get('access-control-allow-origin'), TEST_ORIGINAL_ORIGIN);
    assert.equal(preflightDelete.headers.get('access-control-allow-credentials'), 'true');

    const preflightPut = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}/model`, {
      method: 'OPTIONS',
      headers: { Origin: TEST_ORIGINAL_ORIGIN, 'Access-Control-Request-Method': 'PUT' },
    });
    assert.equal(preflightPut.status, 204);
    const allowMethodsPut = (preflightPut.headers.get('access-control-allow-methods') ?? '').toUpperCase();
    assert.equal(allowMethodsPut.includes('PUT'), true, 'PUT allowed');
    assert.equal(preflightPut.headers.get('access-control-allow-origin'), TEST_ORIGINAL_ORIGIN);

    const stranger = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(stranger.status, 204);
    assert.equal(stranger.headers.get('access-control-allow-origin'), null);
    // Foreign origins are equally rejected for the mutation preflights.
    const strangerDelete = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'DELETE' },
    });
    assert.equal(strangerDelete.headers.get('access-control-allow-origin'), null);
    const strangerPut = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}/model`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'PUT' },
    });
    assert.equal(strangerPut.headers.get('access-control-allow-origin'), null);
  } finally {
    await app.close();
  }
});

test('completion clears only its own active stream id (stale-clear protection)', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const chat = { ...REF, slug: 'general' as const, chatId: CHAT };
    await app.store.setActiveStreamId(chat, 'strm-older');
    // A newer stream started (server restart scenario):
    await app.store.setActiveStreamId(chat, 'strm-newer');
    // A late completion of the OLD stream must not clear the NEWER marker:
    const cleared = await app.store.clearActiveStreamId(chat, 'strm-older');
    assert.equal(cleared, false);
    assert.equal(await app.store.getActiveStreamId(chat), 'strm-newer');
    assert.equal(await app.store.clearActiveStreamId(chat, 'strm-newer'), true);
    assert.equal(await app.store.getActiveStreamId(chat), null);
  } finally {
    await app.close();
  }
});

test('full lifecycle: two turns keep history and leave no active stream', async () => {
  const model = createMockModel({ steps: [textStep(), textStep()] });
  const app = await startTestApp({ model });
  try {
    const first = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'turn one' }) });
    await parseSseChunks(first);
    const second = await postChat({ port: app.port, body: chatBody({ id: 'm2', text: 'turn two' }) });
    await parseSseChunks(second);
    await app.background.waitForAll(2_000);

    const snapshot = (
      app.store as ReturnType<typeof import('../src/store/memory.js').createInMemoryChatStore>
    ).snapshot({ ...REF, slug: 'general', chatId: CHAT });
    assert.equal((snapshot.messages as UIMessage[]).length, 4);
    assert.equal(snapshot.activeStreamId, null);
    assert.equal(snapshot.idempotencyKeys.size, 2, 'keys remain (never released once streaming)');
    assert.equal(
      [...snapshot.idempotencyKeys.values()].every((expiresInMs) => Math.abs(expiresInMs - Date.now() - IDEMPOTENCY_KEY_TTL_SECONDS * 1000) < 10_000),
      true,
      'idempotency TTL is 900s',
    );
  } finally {
    await app.close();
  }
});

async function getJsonSafe(port: number, path: string): Promise<{ status: number }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal((await response.json() as { error?: string }).error !== undefined, true);
  return { status: response.status };
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 3_000,
  message = 'waitFor timed out',
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// C1: the complete appended conversation is validated before any durable
// change; invalid newest messages 400 cleanly and corrupt stored history 503s.
// ---------------------------------------------------------------------------

test('invalid newest message: fixed 400, nothing durable stored, later turns still work', async () => {
  const model = createMockModel({ steps: [textStep()] });
  const app = await startTestApp({ model });
  try {
    // {type:'mystery'} passes the wire schema (opaque part objects) and fails
    // AI SDK validateUIMessages — the exact C1 gap.
    const badMessage = {
      id: 'bad-1',
      role: 'user',
      parts: [{ type: 'mystery' }],
    };
    const badResponse = await postChat({
      port: app.port,
      body: { id: CHAT, message: badMessage },
    });
    assert.equal(badResponse.status, 400);
    assert.deepEqual(await badResponse.json(), { error: 'Message failed validation for this chat.' });
    assert.equal(model.doStreamCalls.length, 0, 'provider untouched');

    // No key acquired, nothing appended, no brick: the chat still works.
    const memoryStore = (
      app.store as ReturnType<typeof import('../src/store/memory.js').createInMemoryChatStore>
    ).snapshot({ ...REF, slug: 'general', chatId: CHAT });
    assert.equal(memoryStore.messages.length, 0);
    assert.equal(memoryStore.idempotencyKeys.size, 0);

    const goodTurn = await postChat({ port: app.port, body: chatBody({ id: 'm-good', text: 'hello' }) });
    assert.equal(goodTurn.status, 200, 'later turns are not bricked by the rejected message');
    await parseSseChunks(goodTurn);
    assert.equal(model.doStreamCalls.length, 1);
  } finally {
    await app.close();
  }
});

test('corrupt pre-existing stored history: fixed 503, no provider work, nothing appended', async () => {
  const model = createMockModel({ steps: [textStep()] });
  const app = await startTestApp({ model });
  try {
    const chat = { ...REF, slug: 'general' as const, chatId: CHAT };
    // Append a structurally invalid UIMessage directly (simulates corrupt state).
    await app.store.appendMessage(chat, {
      id: 'corrupt',
      role: 'user',
      parts: [{ type: 'mystery' }],
    } as unknown as UIMessage);

    const post = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'hi' }) });
    assert.equal(post.status, 503);
    assert.deepEqual(await post.json(), { error: 'Chat state is temporarily unavailable.' });
    assert.equal(model.doStreamCalls.length, 0);

    const memoryStore = (
      app.store as ReturnType<typeof import('../src/store/memory.js').createInMemoryChatStore>
    ).snapshot(chat);
    assert.equal(memoryStore.messages.length, 1, 'nothing appended on top of corrupt state');
    assert.equal(memoryStore.idempotencyKeys.size, 0, 'no key acquired');
  } finally {
    await app.close();
  }
});

test('invalid newest message on top of corrupt stored history: 503 (stored classified first)', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const chat = { ...REF, slug: 'general' as const, chatId: CHAT };
    await app.store.appendMessage(chat, {
      id: 'corrupt',
      role: 'user',
      parts: [{ type: 'mystery' }],
    } as unknown as UIMessage);
    const post = await postChat({
      port: app.port,
      body: { id: CHAT, message: { id: 'also-bad', role: 'user', parts: [{ type: 'mystery' }] } },
    });
    assert.equal(post.status, 503);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// C2: append-only persistence — concurrent turns cannot clobber each other.
// ---------------------------------------------------------------------------

test('store-level: reversed completions retain every appended message', async () => {
  const store = (await import('../src/store/memory.js')).createInMemoryChatStore();
  const chat = { ...REF, slug: 'general' as const, chatId: 'c-concurrent' };
  await store.appendMessage(chat, { id: 'u1', role: 'user', parts: [] } as never);
  await store.appendMessage(chat, { id: 'u2', role: 'user', parts: [] } as never);
  // Stream 2 completes before stream 1.
  await store.appendMessage(chat, { id: 'a2', role: 'assistant', parts: [] } as never);
  await store.appendMessage(chat, { id: 'a1', role: 'assistant', parts: [] } as never);
  const ids = (await store.loadMessages(chat)).map((message) => (message as { id: string }).id);
  assert.deepEqual(ids, ['u1', 'u2', 'a2', 'a1']);
});

test('route-level: an earlier generation completing after a newer user append keeps that user', async () => {
  const slowFirstStep: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'slow ' },
    { type: 'text-delta', id: 't1', delta: 'answer' },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      usage: mockUsage(),
      finishReason: { unified: 'stop', raw: undefined },
    },
  ];
  const model = createMockModel({ steps: [slowFirstStep, textStep()], chunkDelayMs: 80 });
  const app = await startTestApp({ model });
  try {
    // Turn 1 starts and stays in-flight (slow streaming); the client keeps the
    // body buffered so the server keeps producing.
    const response1 = await postChat({ port: app.port, body: chatBody({ id: 'm1', text: 'turn one' }) });
    assert.equal(response1.status, 200);
    const textPromise1 = response1.text();
    await waitFor(
      async () =>
        (await app.store.loadMessages({ ...REF, slug: 'general', chatId: CHAT })).some(
          (message) => (message as { id?: string }).id === 'm1',
        ) && model.doStreamCalls.length >= 1,
      3_000,
      'turn 1 did not persist its user message in time',
    );

    // Turn 2 loads [user m1], appends user m2, and completes quickly (fast
    // second step served by the mock model).
    const response2 = await postChat({ port: app.port, body: chatBody({ id: 'm2', text: 'turn two' }) });
    assert.equal(response2.status, 200);
    await parseSseChunks(response2);
    await waitFor(
      async () =>
        (await app.store.loadMessages({ ...REF, slug: 'general', chatId: CHAT })).some(
          (message) => (message as { role?: string }).role === 'assistant',
        ),
      3_000,
      'turn 2 did not complete in time',
    );

    // Turn 1 finishes LAST. Before the append-only fix its whole-list save
    // deleted user m2; after the fix it appends exactly its own response.
    await textPromise1;
    await app.background.waitForAll(3_000);

    const messages = (await app.store.loadMessages({ ...REF, slug: 'general', chatId: CHAT })) as UIMessage[];
    const ids = messages.map((message) => message.id);
    assert.equal(messages.length, 4, `exactly four messages survive: ${ids.join(',')}`);
    assert.equal(ids.filter((id) => id === 'm1').length, 1, 'user m1 retained');
    assert.equal(ids.filter((id) => id === 'm2').length, 1, 'user m2 retained (not clobbered by turn 1 completion)');
    const assistants = messages.filter((message) => message.role === 'assistant');
    assert.equal(assistants.length, 2);
    const turn1Text = assistants
      .map((assistant) => assistant.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''))
      .find((text) => text.includes('slow'));
    assert.equal(turn1Text, 'slow answer', 'turn 1 assistant text persisted fully and exactly once');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// M1: body-parser failures map to fixed safe JSON responses.
// ---------------------------------------------------------------------------

test('malformed JSON body: fixed 400, not a 500', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `${CHAT}:m1` },
      body: '{"id": "chat-1", "message": {oops',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Malformed JSON request body.' });
  } finally {
    await app.close();
  }
});

test('oversized JSON body: fixed 413, not a 500', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const oversized = JSON.stringify({
      id: CHAT,
      message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] },
    });
    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `${CHAT}:m1` },
      body: oversized,
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'Request body is too large.' });
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// C3/H1: stale active stream markers are cleaned up on resume; the ack
// timeout of a post-crash stale producer is treated like a dead stream.
// ---------------------------------------------------------------------------

test('resume with a finished stream (null): marker compare-and-deleted, then 204', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const chat = { ...REF, slug: 'general' as const, chatId: CHAT };
    const context = app.streamContext as import('../src/stream-context/memory.js').InMemoryStreamContext;
    const state2 = context.state;
    assert.ok(state2 !== undefined);
    await app.store.setActiveStreamId(chat, 'strm-done');
    state2.streams.set('strm-done', ['data: {"type":"text-delta","id":"t","delta":"x"}\n\n']);
    state2.done.add('strm-done');

    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}/stream`);
    assert.equal(response.status, 204);
    assert.equal(await app.store.getActiveStreamId(chat), null, 'stale marker cleaned up');
    const hydration = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}`);
    const body = (await hydration.json()) as { hasActiveStream: boolean };
    assert.equal(body.hasActiveStream, false);
  } finally {
    await app.close();
  }
});

test('resume with a vanished stream (undefined): marker compare-and-deleted, then 204', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const chat = { ...REF, slug: 'general' as const, chatId: CHAT };
    await app.store.setActiveStreamId(chat, 'strm-gone');
    // No checkpoint record at all (crash before the durable copy registered).

    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}/stream`);
    assert.equal(response.status, 204);
    assert.equal(await app.store.getActiveStreamId(chat), null, 'stale marker cleaned up');
  } finally {
    await app.close();
  }
});

test('resume with a stale-producer ack timeout: marker compare-and-deleted, then 204', async () => {
  const app = await startTestApp({
    model: createMockModel({ steps: [textStep()] }),
    streamContext: {
      ...createInMemoryStreamContext(),
      resumeExistingStream: async () => {
        throw new Error('Timeout waiting for ack');
      },
    },
  });
  try {
    const chat = { ...REF, slug: 'general' as const, chatId: CHAT };
    await app.store.setActiveStreamId(chat, 'strm-stale-producer');

    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}/stream`);
    assert.equal(response.status, 204);
    assert.equal(await app.store.getActiveStreamId(chat), null, 'post-crash stale marker cleaned up');
  } finally {
    await app.close();
  }
});

test('resume with a generic failure: safe 503 and the marker is untouched', async () => {
  const app = await startTestApp({
    model: createMockModel({ steps: [textStep()] }),
    streamContext: {
      ...createInMemoryStreamContext(),
      resumeExistingStream: async () => {
        throw new Error('MOCKED_REDIS_FAILURE');
      },
    },
  });
  try {
    const chat = { ...REF, slug: 'general' as const, chatId: CHAT };
    await app.store.setActiveStreamId(chat, 'strm-live');

    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/${CHAT}/stream`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Stream resume is temporarily unavailable.' });
    assert.equal(await app.store.getActiveStreamId(chat), 'strm-live', 'no cleanup on non-timeout failures');
  } finally {
    await app.close();
  }
});

test('stream finish carries optional usage metadata; Phase 2 shape preserved', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const response = await postChat({ port: app.port, body: chatBody({ id: 'u-meta', text: 'hello' }) });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const chunks = raw
      .split('\n\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    // The finish chunk carries `messageMetadata.usage` when the provider
    // reported usage; every other chunk keeps its Phase 2 shape.
    const finish = chunks.find((chunk) => chunk.type === 'finish') as Record<string, unknown> | undefined;
    assert.notEqual(finish, undefined);
    assert.deepEqual(
      ((finish?.messageMetadata as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined),
      { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    );
    // The persisted assistant message carries the same metadata; old
    // consumers that ignore `metadata` are unaffected.
    const stored = (await app.store.loadMessages({ ...REF, slug: 'general', chatId: CHAT })) as UIMessage[];
    const assistant = stored[stored.length - 1] as UIMessage;
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(
      (assistant.metadata as Record<string, unknown> | undefined)?.usage,
      { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    );
  } finally {
    await app.close();
  }
});
