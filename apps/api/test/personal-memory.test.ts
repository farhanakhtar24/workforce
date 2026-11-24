/**
 * Pre-Phase 6 opt-in personal memory tests (offline, fakes only — no
 * provider, no DB, no Redis): settings routes, capture gating + dedupe ids,
 * worker duplicate/empty/write contracts, bounded untrusted recall, purge
 * (delete/rewind) with branch no-copy, and the exact prompt/paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { LanguageModel, UIMessage } from 'ai';
import type { MemoryService } from '@workforce/core/memory';

import { createMockModel, textStep, startTestApp, userMessage, getJson, TEST_OWNER, type TestApp } from './helpers.js';
import { createInMemoryChatStore } from '../src/store/memory.js';
import type { ChatRef, ChatStore } from '../src/store/types.js';
import { userMemoryScope } from '@workforce/core/auth';
import {
  processPersonalCaptureJob,
  personalChatPath,
  type PersonalCaptureJob,
  type PersonalCaptureChatStore,
  type PersonalMemorySettingsLike,
} from '../src/memory/personal-capture.js';
import { buildCapturedContent, hasDurableText } from '../src/memory/personal-capture.js';
import { recallPersonalMemory, formatPersonalMemoryContext, PERSONAL_MEMORY_CONTEXT_HEADER } from '../src/memory/personal-recall.js';
import { personalCaptureJobId } from '../src/memory/bullmq-queue.js';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function fakeSettings(map: Map<string, boolean>): PersonalMemorySettingsLike & { setPersonalMemoryEnabled(id: string, enabled: boolean): Promise<{ personalMemoryEnabled: boolean }> } {
  return {
    get: async (id: string) => ({ personalMemoryEnabled: map.get(id) === true }),
    setPersonalMemoryEnabled: async (id: string, enabled: boolean) => {
      map.set(id, enabled);
      return { personalMemoryEnabled: enabled };
    },
  };
}

interface BlockRow {
  readonly id: string;
  readonly scope: string;
  readonly path: string;
  readonly kind: string;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  supersededById?: string | null;
}

/** Minimal MemoryService fake: search/query/write/purge over shared rows. */
function buildMemory(): {
  service: MemoryService;
  semanticCalls: Array<{ query: string; scope?: string; path?: string; limit?: number }>;
  purgeCalls: Array<{ scope: string; path: string; assistantMessageIds?: string[] }>;
  writes: Array<{ scope: string; path: string; kind: string; content: string; metadata: Record<string, unknown> }>;
  blocks: BlockRow[];
} {
  const semanticCalls: Array<{ query: string; scope?: string; path?: string; limit?: number }> = [];
  const purgeCalls: Array<{ scope: string; path: string; assistantMessageIds?: string[] }> = [];
  const writes: Array<{ scope: string; path: string; kind: string; content: string; metadata: Record<string, unknown> }> = [];
  const blocks: BlockRow[] = [];
  const withinPath = (block: BlockRow, prefix: string): boolean => block.path === prefix || block.path.startsWith(`${prefix}/`);
  const service = {
    async semanticSearch(input: { query: string; scope?: string; path?: string; limit?: number }) {
      semanticCalls.push({ ...input });
      return blocks
        .filter(
          (block) =>
            (input.scope === undefined ? true : block.scope === input.scope) &&
            (input.path === undefined ? true : withinPath(block, input.path)) &&
            block.supersededById === null,
        )
        .slice(0, input.limit ?? 20)
        .map((block) => ({ block, cosineSimilarity: 0.9, score: 0.9 }));
    },
    async queryBlocks(input: { scope?: string; pathPrefix?: string; limit?: number; includeSuperseded?: boolean }) {
      return blocks
        .filter(
          (block) =>
            (input.scope === undefined ? true : block.scope === input.scope) &&
            (input.pathPrefix === undefined ? true : withinPath(block, input.pathPrefix)) &&
            (input.includeSuperseded === true ? true : block.supersededById === null),
        )
        .slice(0, input.limit ?? 20);
    },
    async writeBlock(input: { scope: string; path: string; kind: string; content: string; metadata: Record<string, unknown> }) {
      writes.push({ ...input });
      blocks.push({ id: randomUUID(), supersededById: null, ...input });
      return { id: 'new-block', ...input, confidence: 0.8, embeddingStatus: 'pending' };
    },
    async purgeDerivedChatMemory(input: { scope: string; path: string; assistantMessageIds?: string[] }) {
      purgeCalls.push({ ...input });
      const doomed = blocks.filter(
        (block) =>
          block.scope === input.scope &&
          block.path === input.path &&
          (input.assistantMessageIds === undefined ? true : input.assistantMessageIds.includes(String((block.metadata as { assistantMessageId?: unknown }).assistantMessageId ?? ''))),
      );
      for (const block of doomed) {
        block.supersededById = block.id;
      }
      return doomed.length;
    },
  } as unknown as MemoryService;
  return { service, semanticCalls, purgeCalls, writes, blocks };
}

type StartOptions = NonNullable<Parameters<typeof startTestApp>[0]>;
type Personal = NonNullable<StartOptions['personal']>;

/** Chat POST helper (the stream body is consumed so background tasks drain). */
async function postChat(app: TestApp, chatId: string, message: UIMessage): Promise<Response> {
  return await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': `${chatId}:${message.id}` },
    body: JSON.stringify({ id: chatId, message }),
  });
}

/** Mock model that RECORDS every `system` string the pipeline sent. */
function createRecordingSystemModel(stepCount: number): { model: LanguageModel; systems: Array<unknown>; clone(): LanguageModel } {
  const systems: Array<unknown> = [];
  const build = (): LanguageModel => {
    const base = createMockModel({ steps: Array.from({ length: Math.max(1, stepCount) }, () => textStep()) });
    return {
      specificationVersion: 'v3',
      provider: 'mock',
      modelId: 'mock-recording',
      supportedUrls: {},
      async doStream(options: unknown) {
        // V3 call options carry `{ prompt: [<messages>] }` — `system` arrives
        // as the FIRST system message of the prompt array.
        const prompt = (options as { prompt?: Array<{ role?: unknown; content?: unknown }> }).prompt;
        const systemEntry = Array.isArray(prompt) ? prompt.find((entry) => (entry as { role?: unknown }).role === 'system') : undefined;
        const content = systemEntry === undefined ? undefined : (systemEntry as { content?: unknown }).content;
        const text = Array.isArray(content)
          ? content.map((part) => (typeof part === 'object' && part !== null ? String((part as { text?: unknown }).text ?? '') : '')).join('')
          : typeof content === 'string'
            ? content
            : undefined;
        systems.push(text);
        return base.doStream(options as never);
      },
    } as unknown as LanguageModel;
  };
  return { model: build(), systems, clone: build };
}

// ---------------------------------------------------------------------------
// Settings routes (contract)
// ---------------------------------------------------------------------------

test('settings: default false for absent rows; opt-in/out round-trips; strict body; per-owner isolation', async () => {
  const flags = new Map<string, boolean>();
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }), settings: fakeSettings(flags) });
  const foreignApp = await startTestApp({
    store,
    model: createMockModel({ steps: [textStep()] }),
    settings: fakeSettings(flags),
    auth: { staticOwner: { userId: 'owner-b-settings', email: 'b@example.com', emailVerified: true } },
  });
  try {
    const initial = await getJson({ port: app.port, path: '/api/settings' });
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { settings: { personalMemoryEnabled: false } }, 'absent UserSettings row is the opt-OUT default');

    const on = await fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personalMemoryEnabled: true }),
    });
    assert.equal(on.status, 200);
    assert.deepEqual((await on.json()) as unknown, { settings: { personalMemoryEnabled: true } });
    assert.deepEqual((await getJson({ port: app.port, path: '/api/settings' })).body, { settings: { personalMemoryEnabled: true } });

    const extra = await fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personalMemoryEnabled: true, scope: 'x' }),
    });
    assert.equal(extra.status, 400, 'strict {personalMemoryEnabled} only');
    const wrongType = await fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personalMemoryEnabled: 'yes' }),
    });
    assert.equal(wrongType.status, 400);
    const wrongCtype = await fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: 'PATCH',
      headers: {},
      body: JSON.stringify({ personalMemoryEnabled: true }),
    });
    assert.equal(wrongCtype.status, 415);

    const off = await fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personalMemoryEnabled: false }),
    });
    assert.deepEqual((await off.json()) as unknown, { settings: { personalMemoryEnabled: false } });
    assert.equal(flags.get(TEST_OWNER.userId), false, 'the flag is upserted for the session owner only');

    // Owner B never sees A's row.
    const foreign = await getJson({ port: foreignApp.port, path: '/api/settings' });
    assert.deepEqual(foreign.body, { settings: { personalMemoryEnabled: false } });
    assert.equal(flags.has('owner-b-settings'), false, 'a GET never creates rows');
  } finally {
    await app.close();
    await foreignApp.close();
  }
});

// ---------------------------------------------------------------------------
// Route gate: disabled → zero capture + zero recall; enabled → 1 job
// ---------------------------------------------------------------------------

test('personal memory route gate: disabled → zero capture jobs and zero recall reads; enabled → one deterministic capture', async () => {
  const flags = new Map<string, boolean>();
  const enqueued: Array<{ ownerId: string; scope: string; chatId: string; slug: string; userMessageId: string; assistantMessageId: string }> = [];
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const memory = buildMemory();
  const recording = createRecordingSystemModel(4);
  const personal: Personal = {
    settings: fakeSettings(flags),
    memory: memory.service,
    capture: {
      enqueueCapture: async (input) => {
        enqueued.push({ ...input });
        return true;
      },
    },
  };
  const app = await startTestApp({ store, model: recording.model, settings: fakeSettings(flags), personal });
  const foreignApp = await startTestApp({
    store,
    model: recording.clone(),
    settings: fakeSettings(flags),
    personal,
    auth: { staticOwner: { userId: 'owner-b-pm', email: 'b2@example.com', emailVerified: true } },
  });
  try {
    // Disabled chat: completes, ZERO capture, ZERO recall reads, no header.
    const off = await postChat(app, 'pm-off', userMessage('remember my dog Rex', 'm1'));
    assert.equal(off.status, 200);
    await off.text();
    assert.equal(enqueued.length, 0, 'disabled → NO capture job');
    assert.equal(memory.semanticCalls.length, 0, 'disabled → NO recall read');
    assert.equal(memory.writes.length, 0, 'disabled → no writes');
    assert.equal(
      recording.systems.some((system) => typeof system === 'string' && system.includes(PERSONAL_MEMORY_CONTEXT_HEADER)),
      false,
      'disabled → no memory context in the system prompt',
    );

    // Enabled owner: capture AFTER the assistant finish.
    flags.set(TEST_OWNER.userId, true);
    const enabled = await postChat(app, 'pm-on', userMessage('my dog is called Rex', 'm2'));
    assert.equal(enabled.status, 200);
    await enabled.text();
    await app.background.waitForAll(5_000);
    assert.equal(enqueued.length, 1, 'exactly one capture job for the completed assistant turn');
    const record = enqueued[0];
    assert.ok(record !== undefined);
    assert.equal(record.ownerId, TEST_OWNER.userId);
    assert.equal(record.scope, userMemoryScope(TEST_OWNER.userId), 'the scope is the derived per-user scope');
    assert.equal(record.chatId, 'pm-on');
    assert.equal(record.slug, 'general');
    assert.ok(record.userMessageId.length > 0);
    assert.ok(record.assistantMessageId.length > 0);
    assert.equal(
      personalCaptureJobId(record.scope, record.chatId, record.assistantMessageId),
      personalCaptureJobId(record.scope, record.chatId, record.assistantMessageId),
      'deterministic job id per (scope, chat, assistant message)',
    );

    // Disabled foreign owner: no capture (isolation).
    const foreign = await (
      await fetch(`http://127.0.0.1:${foreignApp.port}/api/agents/general/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'pm-b:mb' },
        body: JSON.stringify({ id: 'pm-b', message: userMessage('anything', 'mb') }),
      })
    ).text();
    assert.equal(foreign.length > 0, true);
    assert.equal(enqueued.length, 1, 'foreign owner stays disabled → nothing more');
  } finally {
    await app.close();
    await foreignApp.close();
  }
});

// ---------------------------------------------------------------------------
// Route: bounded untrusted recall injection + failure nonfatal
// ---------------------------------------------------------------------------

test('personal recall route: enabled → bounded UNTRUSTED context in the system prompt; failure → the turn still completes', async () => {
  const flags = new Map<string, boolean>([[TEST_OWNER.userId, true]]);
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const memory = buildMemory();
  await memory.service.writeBlock({
    scope: userMemoryScope(TEST_OWNER.userId),
    path: 'chats/older-chat',
    kind: 'observation',
    content: 'The user prefers terse answers and Rust examples.',
    confidence: 0.8,
    metadata: { source: 'personal-chat', chatId: 'older-chat', assistantMessageId: 'a-prev' },
  });
  await memory.service.writeBlock({
    scope: 'user-someone-else',
    path: 'chats/old',
    kind: 'observation',
    content: 'SECRET FROM ANOTHER USER',
    confidence: 0.8,
    metadata: { source: 'personal-chat', chatId: 'old', assistantMessageId: 'a-x' },
  });
  const recording = createRecordingSystemModel(3);
  const personal: Personal = { settings: fakeSettings(flags), memory: memory.service, capture: { enqueueCapture: async () => true } };
  const app = await startTestApp({ store, model: recording.model, settings: fakeSettings(flags), personal });
  try {
    const response = await postChat(app, 'pm-recall', userMessage('write a hello world?', 'mr1'));
    assert.equal(response.status, 200);
    await response.text();
    const system = recording.systems.find((value): value is string => typeof value === 'string' && value.includes(PERSONAL_MEMORY_CONTEXT_HEADER));
    assert.ok(system !== undefined, 'the memory context reached the system prompt');
    assert.equal(system.startsWith(PERSONAL_MEMORY_CONTEXT_HEADER), true, 'the untrusted framing leads the injection');
    assert.equal(system.includes('The user prefers terse answers'), true, 'owner-scope memory is visible');
    assert.equal(system.includes('SECRET FROM ANOTHER USER'), false, 'foreign scope NEVER leaks');
    assert.ok(system.length <= 2400, 'bounded injection');
    // One bounded semantic read: owner scope, chats prefix, top 3.
    assert.equal(memory.semanticCalls.length, 1);
    assert.equal(memory.semanticCalls[0]?.scope, userMemoryScope(TEST_OWNER.userId), 'recall reads ONLY the owner scope');
    assert.equal(memory.semanticCalls[0]?.path, 'chats');
    assert.equal(memory.semanticCalls[0]?.limit, 3);

    // Recall FAILURE (embedding down) → the turn still completes: 200.
    const failing = buildMemory();
    Object.assign(failing.service, {
      semanticSearch: async () => {
        throw new Error('embedding down');
      },
    });
    const failingApp = await startTestApp({ store, model: recording.clone(), settings: fakeSettings(flags), personal: { ...personal, memory: failing.service } });
    try {
      const resilient = await postChat(failingApp, 'pm-recall-fail', userMessage('any question?', 'mr2'));
      assert.equal(resilient.status, 200, 'recall failure is NONFATAL');
      await resilient.text();
    } finally {
      await failingApp.close();
    }
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Worker contracts: duplicate no-op / disabled no-op / empty / write shape
// ---------------------------------------------------------------------------

const SCOPE = userMemoryScope('owner-a');

function transcriptStore(
  userParts: unknown,
  assistantParts: unknown,
  ids: { user: string; assistant: string } = { user: 'u-turn', assistant: 'a-turn' },
): PersonalCaptureChatStore {
  return {
    async loadMessages(chat: ChatRef) {
      void chat;
      return [
        { id: ids.user, role: 'user', parts: userParts },
        { id: ids.assistant, role: 'assistant', parts: assistantParts },
      ] as never;
    },
  };
}

function captureJob(assistantMessageId: string): PersonalCaptureJob {
  return { ownerId: 'owner-a', scope: SCOPE, chatId: 'chat-1', slug: 'general', userMessageId: 'u-turn', assistantMessageId };
}

test('capture worker: duplicate assistant turn → no-op; disabled at processing → no write; tool-only turn → no block', async () => {
  const flags = new Map<string, boolean>([['owner-a', true]]);

  // Duplicate: a derived block with the same assistantMessageId exists at
  // the chat path (superseded included) → the job is an honest no-op.
  const withExisting = buildMemory();
  await withExisting.service.writeBlock({
    scope: SCOPE,
    path: personalChatPath('chat-1'),
    kind: 'observation',
    content: 'already captured',
    confidence: 0.8,
    metadata: { source: 'personal-chat', chatId: 'chat-1', assistantMessageId: 'a-turn' },
  });
  withExisting.writes.length = 0;
  const duplicate = await processPersonalCaptureJob(captureJob('a-turn'), {
    memory: withExisting.service,
    settings: fakeSettings(flags),
    chatStore: transcriptStore([{ type: 'text', text: 'x' }], [{ type: 'text', text: 'y' }]),
    logger: { warn: () => assert.fail('duplicate must never warn') },
  });
  assert.equal(duplicate, 'duplicate');
  assert.equal(withExisting.writes.length, 0, 'duplicate → NO second block');

  // Toggled-off at processing time → suppressed with no writes.
  flags.set('owner-a', false);
  const disabled = await processPersonalCaptureJob(captureJob('a-turn-2'), {
    memory: withExisting.service,
    settings: fakeSettings(flags),
    chatStore: transcriptStore([], []),
    logger: {},
  });
  assert.equal(disabled, 'disabled');

  // Tool-only / reasoning-only turns carry NO durable visible text.
  flags.set('owner-a', true);
  const empty = buildMemory();
  const emptyOutcome = await processPersonalCaptureJob(captureJob('a-turn-3'), {
    memory: empty.service,
    settings: fakeSettings(flags),
    chatStore: transcriptStore(
      [{ type: 'tool-calculate', toolCallId: 'tc', state: 'output-available', input: { expression: '1+1' } }],
      [{ type: 'step-start' }, { type: 'reasoning', text: 'thinking' }],
      { user: 'u-turn', assistant: 'a-turn-3' },
    ),
    logger: {},
  });
  assert.equal(emptyOutcome, 'empty');
  assert.equal(empty.writes.length, 0, 'tool-only/reasoning-only turns capture NOTHING');
});

test('capture worker: writes owner scope + chats/{chatId} + exact metadata; tool/reasoning parts NEVER in content', async () => {
  const flags = new Map<string, boolean>([['owner-a', true]]);
  const memory = buildMemory();
  const outcome = await processPersonalCaptureJob(captureJob('a-turn'), {
    memory: memory.service,
    settings: fakeSettings(flags),
    chatStore: transcriptStore(
      [
        { type: 'text', text: 'Please remember: my dog is called Rex.' },
        { type: 'tool-ask_user', toolCallId: 'tc', state: 'output-available', input: { options: ['SECRET_OPTION'] }, output: { answer: 'SECRET_ANSWER' } },
        { type: 'reasoning', text: 'SECRET_REASONS' },
      ],
      [{ type: 'text', text: 'Noted — Rex.' }],
    ),
    logger: {},
  });
  assert.equal(outcome, 'captured');
  assert.deepEqual(memory.writes[0], {
    scope: SCOPE,
    path: 'chats/chat-1',
    kind: 'observation',
    content: '[user] Please remember: my dog is called Rex.\n[assistant] Noted — Rex.',
    confidence: 0.8,
    metadata: { source: 'personal-chat', chatId: 'chat-1', assistantMessageId: 'a-turn' },
  });
  void memory.purgeCalls;
  // The written content is VISIBLE TEXT ONLY: tool payloads/reasoning never
  // reach the capture (the bounded derivation skips non-text parts).
  assert.equal(hasDurableText({ userParts: [{ type: 'tool-calculate', toolCallId: 'tc', state: 'output-available', input: { expression: 'SECRET' } }], assistantParts: [{ type: 'reasoning', text: 'SECRET_THOUGHTS' }] }), false);
  assert.equal(
    buildCapturedContent({ userParts: [{ type: 'text', text: 'hi' }], assistantParts: [{ type: 'text', text: 'there' }] }),
    '[user] hi\n[assistant] there',
  );
});

// ---------------------------------------------------------------------------
// Recall formatting: bounded, header-first, data bullets
// ---------------------------------------------------------------------------

test('recall format: at most 3 bounded data bullets under the untrusted header', () => {
  const blocks = Array.from({ length: 5 }, (_, index) => ({
    block: {
      id: `b${index}`,
      scope: SCOPE,
      path: `chats/c${index}`,
      kind: 'observation',
      content: `fact ${index} — ${'detail '.repeat(120)}`,
      confidence: 0.8,
      metadata: { source: 'personal-chat' },
    },
    cosineSimilarity: 0.9,
    score: 0.9,
  }));
  const context = formatPersonalMemoryContext(blocks as never);
  assert.ok(context !== null);
  const lines = context.split('\n');
  assert.equal(lines[0], PERSONAL_MEMORY_CONTEXT_HEADER);
  assert.ok(lines.length - 1 <= 3, 'at most 3 memory lines');
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith('- '), 'memory lines are data bullets');
  }
  assert.ok(context.length <= 2000, 'the whole context is bounded');
  const emptyOrNull = formatPersonalMemoryContext([] as never);
  assert.equal(emptyOrNull, null, 'no memories → no context');
});

// ---------------------------------------------------------------------------
// Purge: delete → whole path; rewind → removed assistant ids; branch none
// ---------------------------------------------------------------------------

test('purge hooks: delete purges the chat path; rewind purges ONLY removed assistant ids; branch copies nothing', async () => {
  const flags = new Map<string, boolean>([[TEST_OWNER.userId, true]]);
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const memory = buildMemory();
  const personal: Personal = { settings: fakeSettings(flags), memory: memory.service, capture: { enqueueCapture: async () => true } };
  const seedDerived = async (chatId: string, assistantId: string): Promise<void> => {
    await memory.service.writeBlock({
      scope: userMemoryScope(TEST_OWNER.userId),
      path: personalChatPath(chatId),
      kind: 'observation',
      content: `derived for ${assistantId}`,
      confidence: 0.8,
      metadata: { source: 'personal-chat', chatId, assistantMessageId: assistantId },
    });
  };
  await seedDerived('purge-chat', 'a1');
  await seedDerived('purge-chat', 'a2');
  await seedDerived('other-chat', 'a-other');
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }), settings: fakeSettings(flags), personal });
  const chat: ChatRef = { ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'purge-chat' };
  try {
    await store.appendMessage(chat, { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }] } as never);
    await store.appendMessage(chat, { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first' }] } as never);
    await store.appendMessage(chat, { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'two' }] } as never);
    await store.appendMessage(chat, { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'second' }] } as never);

    // REWIND through u2 (removes tail: u2+a2): purge ONLY the a2 block.
    const rewind = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/purge-chat/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u2' }),
    });
    assert.equal(rewind.status, 200);
    const rewindBody = (await rewind.json()) as { rewound: boolean; kept: number; removed: number; purgedPersonalMemoryBlocks?: number };
    assert.equal(rewindBody.rewound, true);
    assert.ok(rewindBody.purgedPersonalMemoryBlocks !== undefined, 'the purge count is reported (additive)');
    assert.equal(rewindBody.purgedPersonalMemoryBlocks, 1, 'only the removed a2 derived block purged');
    assert.deepEqual(memory.purgeCalls[0], {
      scope: userMemoryScope(TEST_OWNER.userId),
      path: 'chats/purge-chat',
      assistantMessageIds: ['a2'],
    });

    // BRANCH: transcript + model copies; derived memory NEVER copied/touched.
    memory.purgeCalls.length = 0;
    memory.writes.length = 0;
    const branch = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/purge-chat/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u1', newChatId: 'purge-clone' }),
    });
    assert.equal(branch.status, 201);
    assert.deepEqual(memory.writes, [], 'branch writes no derived-memory copies');
    assert.deepEqual(memory.purgeCalls, [], 'branch purges nothing');

    // DELETE the branch: zero derived blocks at its path → honest 0.
    const del = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/purge-clone`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const delBody = (await del.json()) as { deleted: boolean; purgedPersonalMemoryBlocks?: number };
    assert.equal(delBody.deleted, true);
    assert.equal(delBody.purgedPersonalMemoryBlocks, 0);

    // DELETE the source: the whole chat path purges.
    const delSource = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/purge-chat`, { method: 'DELETE' });
    assert.equal(delSource.status, 200);
    assert.deepEqual(
      memory.purgeCalls.slice(-1),
      [{ scope: userMemoryScope(TEST_OWNER.userId), path: 'chats/purge-chat' }],
      'the delete purge covers the whole chat path',
    );

    // Other chats survive a scoped delete purge.
    const survivor = await memory.service.semanticSearch({
      query: 'derived for a-other',
      scope: userMemoryScope(TEST_OWNER.userId),
      path: 'chats',
      limit: 3,
    });
    assert.equal(survivor.length, 1, 'other chats are never touched by a delete purge');
  } finally {
    await app.close();
  }
});

// Purge GATE ordering: a purge failure aborts delete/rewind with the
// transcript still intact (never claims a deletion it did not perform).
test('purge ordering: delete/rewind purge failures are honest 503s with the transcript intact', async () => {
  const flags = new Map<string, boolean>([[TEST_OWNER.userId, true]]);
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const memory = buildMemory();
  await memory.service.writeBlock({
    scope: userMemoryScope(TEST_OWNER.userId),
    path: personalChatPath('gate-chat'),
    kind: 'observation',
    content: 'derived block to purge',
    confidence: 0.8,
    metadata: { source: 'personal-chat', chatId: 'gate-chat', assistantMessageId: 'a-gate' },
  });
  const personal: Personal = {
    settings: fakeSettings(flags),
    memory: Object.assign(Object.create(Object.getPrototypeOf(memory.service)), memory.service, {
      purgeDerivedChatMemory: async () => {
        throw new Error('database down');
      },
    }),
    capture: { enqueueCapture: async () => true },
  };
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }), settings: fakeSettings(flags), personal });
  const chat: ChatRef = { ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'gate-chat' };
  try {
    await store.appendMessage(chat, { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }] } as never);
    await store.appendMessage(chat, { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first' }] } as never);

    // DELETE: the failing purge is a gate → fixed 503 BEFORE the store call;
    // the transcript remains, and only the (failed) purge was attempted.
    const del = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/gate-chat`, { method: 'DELETE' });
    assert.equal(del.status, 503);
    assert.deepEqual((await del.json()) as unknown, { error: 'Personal memory cleanup failed. Retry the delete.' });
    assert.equal((await store.loadMessages(chat)).length, 2, 'the transcript is intact (nothing was claimed deleted)');

    // REWIND: the failing purge gates likewise → fixed 503 + intact tail.
    const rewind = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/gate-chat/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u1' }),
    });
    assert.equal(rewind.status, 503);
    assert.deepEqual((await rewind.json()) as unknown, { error: 'Personal memory cleanup failed. Retry the rewind.' });
    assert.equal((await store.loadMessages(chat)).length, 2, 'the transcript is intact (nothing was claimed rewound)');
  } finally {
    await app.close();
  }
});

// Settings store failure: the fixed safe 503 (never user content / env).
// Busy delete precheck: an active generation costs ZERO purge, and a
// precheck read failure is the safe 503 with zero purge and zero delete.
test('delete busy gate: active stream → fixed 409 with ZERO purge and intact transcript; read failure → safe 503', async () => {
  const flags = new Map<string, boolean>([[TEST_OWNER.userId, true]]);
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const memory = buildMemory();
  await memory.service.writeBlock({
    scope: userMemoryScope(TEST_OWNER.userId),
    path: personalChatPath('busy-gate'),
    kind: 'observation',
    content: 'derived block that must survive a busy delete',
    confidence: 0.8,
    metadata: { source: 'personal-chat', chatId: 'busy-gate', assistantMessageId: 'a-busy' },
  });
  const personal: Personal = { settings: fakeSettings(flags), memory: memory.service, capture: { enqueueCapture: async () => true } };
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }), settings: fakeSettings(flags), personal });
  const chat: ChatRef = { ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'busy-gate' };
  try {
    await store.appendMessage(chat, { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }] } as never);
    await store.appendMessage(chat, { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first' }] } as never);
    await store.setActiveStreamId(chat, 'strm-busy');

    // Busy → existing fixed 409; the purge count stays untouched (zero purge
    // reads/writes) and the transcript + active marker are intact.
    const busy = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/busy-gate`, { method: 'DELETE' });
    assert.equal(busy.status, 409);
    assert.deepEqual((await busy.json()) as unknown, { error: 'Chat has an active generation. Resume or wait.' });
    assert.deepEqual(memory.purgeCalls, [], 'busy delete performs ZERO purge');
    assert.equal((await store.loadMessages(chat)).length, 2, 'the transcript is intact');
    assert.notEqual(await store.getActiveStreamId(chat), null, 'the active marker is intact');

    // The Lua busy check stays authoritative: once the marker is cleared the
    // SAME delete proceeds (purge runs exactly once, transcript then gone).
    await store.clearActiveStreamId(chat, 'strm-busy');
    const cleared = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/busy-gate`, { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    const body = (await cleared.json()) as { deleted: boolean; purgedPersonalMemoryBlocks: number };
    assert.equal(body.deleted, true);
    assert.equal(body.purgedPersonalMemoryBlocks, 1, 'the gated purge ran exactly once on the real delete');

    // Precheck READ failure: safe 503, zero purge, zero delete.
    const readStore = createInMemoryChatStore({ now: () => 5_000 });
    const brokenStore = new Proxy(readStore, {
      get(target, prop, receiver) {
        if (prop === 'getActiveStreamId') {
          return async () => {
            throw new Error('simulated redis outage');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const brokenApp = await startTestApp({ store: brokenStore as ChatStore, model: createMockModel({ steps: [textStep()] }), settings: fakeSettings(flags), personal: { ...personal, memory: memory.service } });
    try {
      const outage = await fetch(`http://127.0.0.1:${brokenApp.port}/api/agents/general/chat/busy-gate`, { method: 'DELETE' });
      assert.equal(outage.status, 503);
      assert.deepEqual((await outage.json()) as unknown, { error: 'Chat state is temporarily unavailable.' });
      assert.equal(memory.purgeCalls.length, 1, 'the read failure performs ZERO purge');
    } finally {
      await brokenApp.close();
    }
  } finally {
    await app.close();
  }
});

test('settings store failure: fixed 503 for GET and PATCH', async () => {
  const flags = new Map<string, boolean>();
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const broken = {
    get: async () => {
      throw new Error('User settings are temporarily unavailable.');
    },
    setPersonalMemoryEnabled: async () => {
      throw new Error('User settings are temporarily unavailable.');
    },
  };
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }), settings: broken as never });
  try {
    const got = await fetch(`http://127.0.0.1:${app.port}/api/settings`);
    assert.equal(got.status, 503);
    assert.deepEqual((await got.json()) as unknown, { error: 'User settings are temporarily unavailable.' });
    const patched = await fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personalMemoryEnabled: true }),
    });
    assert.equal(patched.status, 503);
  } finally {
    await app.close();
  }
});

// Recall failure unit: nonfatal null (route test above covers the turn path).
test('recall unit: settings read failure is nonfatal and returns null', async () => {
  const failing = {
    memory: {} as MemoryService,
    settings: {
      get: async () => {
        throw new Error('settings down');
      },
    },
    logger: { warn: () => undefined },
  };
  const result = await recallPersonalMemory(failing, { ownerId: 'owner-a', newestUserText: 'x' });
  assert.equal(result, null);
});

