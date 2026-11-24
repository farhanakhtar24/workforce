/**
 * HITL (`ask_user`) tests (Phase 4): the execute-less tool ends the model turn
 * with a persisted `input-available` question; the next user message is turned
 * into `output-available { answer }` BEFORE validation/conversion/resume;
 * invalid inputs never mutate the question; duplicate submits never
 * double-answer; user messages stay append-only.
 *
 * Both stores are covered: the in-memory store and the Redis store semantics
 * (the HITL Lua script emulated in-process, mirroring store-redis.test.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { UIMessage } from 'ai';

import {
  createMockModel,
  postChat,
  parseSseChunks,
  startTestApp,
  textStep,
  seedMessages,
  userMessage,
  assistantMessageWithAskUser,
  randomId,
  TEST_OWNER,
} from './helpers.js';
import {
  ANSWER_PENDING_ASK_USER_LUA,
  APPEND_MESSAGE_WITH_INDEX_LUA,
  REDIS_KEY_PREFIX,
  createRedisChatStore,
  type RedisLike,
} from '../src/store/redis.js';
import { ASK_USER_NO_ANSWER } from '../src/store/types.js';
import { createInMemoryChatStore } from '../src/store/memory.js';
import type { ChatStore } from '../src/store/types.js';
import type { AgentsFixtures } from './helpers.js';

const AGENTS: AgentsFixtures = { wire: true };

function agentsApp(steps: Parameters<typeof createMockModel>[0]['steps']) {
  return startTestApp({ agents: AGENTS, model: createMockModel({ steps }) });
}

interface AskUserToolPart {
  readonly type?: string;
  readonly state?: string;
  readonly toolCallId?: string;
  readonly input?: unknown;
  readonly output?: unknown;
}

async function storedParts(app: Awaited<ReturnType<typeof startTestApp>>, chatId: string): Promise<Array<{ id: string; role: string; parts: AskUserToolPart[] }>> {
  const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/chat/${chatId}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { messages: Array<{ id: string; role: string; parts: AskUserToolPart[] }> };
  return body.messages;
}

function askUserPart(parts: AskUserToolPart[]): AskUserToolPart[] {
  return parts.filter((part) => part.type === 'tool-ask_user');
}

test('ask_user tool call ends the turn with a persisted input-available question and no tool result', { concurrency: false }, async () => {
  const chatId = 'hitl-start';
  const app = await agentsApp([
    // Ask the user, then (after resume) finish with plain text.
    [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'q1', toolName: 'ask_user' },
      { type: 'tool-input-delta', id: 'q1', delta: JSON.stringify({ question: 'Which scope should I analyze?' }) },
      { type: 'tool-input-end', id: 'q1' },
      { type: 'tool-call', toolCallId: 'q1', toolName: 'ask_user', input: JSON.stringify({ question: 'Which scope should I analyze?' }) },
      { type: 'finish', usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, finishReason: { unified: 'tool-calls', raw: undefined } },
    ],
    textStep(),
  ]);
  try {
    const response = await postChat({ port: app.port, slug: 'orchestrator', body: { id: chatId, message: userMessage('analyze things', 'u1') } });
    assert.equal(response.status, 200);
    const chunks = await parseSseChunks(response);
    // The stream carries the question as tool input WITHOUT any tool result.
    const toolInput = chunks.find((chunk) => chunk.type === 'tool-input-available');
    assert.ok(toolInput !== undefined);
    const chunkRecord = toolInput as unknown as Record<string, unknown>;
    assert.equal(chunkRecord['toolName'], 'ask_user');
    assert.deepEqual(chunkRecord['input'], { question: 'Which scope should I analyze?' });

    const messages = await storedParts(app, chatId);
    const assistant = messages.find((entry) => entry.role === 'assistant');
    assert.ok(assistant !== undefined);
    const pending = askUserPart(assistant.parts);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.state, 'input-available');
    assert.deepEqual(pending[0]?.input, { question: 'Which scope should I analyze?' });
    assert.equal(pending[0]?.output, undefined);
  } finally {
    await app.close();
  }
});

test('next user turn answers the pending question (output-available) then generation resumes', { concurrency: false }, async () => {
  const chatId = 'hitl-resume';
  const app = await agentsApp([textStep(), textStep()]);
  try {
    // Seed: a pending ask_user question as the LATEST assistant message.
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId }, [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello orchestrator' }] },
      assistantMessageWithAskUser({ id: 'a1', question: 'Which scope?', toolCallId: 'tc-1' }),
    ]);
    const answer = postChat({ port: app.port, slug: 'orchestrator', body: { id: chatId, message: userMessage('use the default scope', 'u2') } });
    const response = await answer;
    assert.equal(response.status, 200);
    await response.text();

    const messages = await storedParts(app, chatId);
    assert.equal(messages.length, 4); // u1, a1(answered), u2, a2
    const answered = messages[1];
    const part = askUserPart(answered?.parts ?? [])[0];
    assert.ok(part !== undefined);
    assert.equal(part.state, 'output-available');
    assert.deepEqual(part.output, { answer: 'use the default scope' });

    // Users stay append-only: u1 and u2 untouched, a1 only got a part update.
    assert.equal(messages[0]?.id, 'u1');
    assert.equal(messages[2]?.id, 'u2');
    assert.equal(messages[3]?.role, 'assistant');
  } finally {
    await app.close();
  }
});

test('an invalid new message fails 400 and never answers or mutates the pending question', { concurrency: false }, async () => {
  const chatId = 'hitl-invalid';
  const app = await agentsApp([textStep(), textStep()]);
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId }, [
      assistantMessageWithAskUser({ id: 'a1', question: 'Pick A or B?', toolCallId: 'tc-2' }),
    ]);
    // 256 parts (oversized) → invalid newest message.
    const parts = Array.from({ length: 65 }, () => ({ type: 'text', text: 'x' }));
    const broken = await postChat({
      port: app.port,
      slug: 'orchestrator',
      body: { id: chatId, message: { id: 'u-bad', role: 'user', parts } },
    });
    assert.equal(broken.status, 400);

    const messages = await storedParts(app, chatId);
    assert.equal(messages.length, 1);
    const part = askUserPart(messages[0]?.parts ?? [])[0];
    assert.equal(part?.state, 'input-available');
  } finally {
    await app.close();
  }
});

test('duplicate submit (same idempotency key) 409s and never double-answers', { concurrency: false }, async () => {
  const chatId = 'hitl-duplicate';
  const app = await agentsApp([textStep(), textStep()]);
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId }, [
      assistantMessageWithAskUser({ id: 'a1', question: 'Confirm?', toolCallId: 'tc-3' }),
    ]);
    const body = { id: chatId, message: userMessage('yes', 'u2') };
    const first = await postChat({ port: app.port, slug: 'orchestrator', body });
    assert.equal(first.status, 200);
    await first.text();
    const second = await postChat({ port: app.port, slug: 'orchestrator', body });
    assert.equal(second.status, 409);

    // Exactly ONE answer landed: the first request's, and it is unchanged.
    const answered = await storedParts(app, chatId);
    const parts = askUserPart(answered[0]?.parts ?? []);
    assert.deepEqual(parts[0]?.output, { answer: 'yes' });
  } finally {
    await app.close();
  }
});

test('a stale/mismatched answers map to no-op updates (unresolved pending does not stick turns)', { concurrency: false }, async () => {
  const store = createInMemoryChatStore();
  const chat = { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'stale-1' };
  await store.appendMessage(chat, assistantMessageWithAskUser({ id: 'a1', question: 'Q?', toolCallId: 'tc-9' }));
  // Wrong assistant message id: typed no-op.
  assert.equal(await store.answerPendingAskUser(chat, 'a-other', 'tc-9', 'answer'), 'unchanged');
  // Wrong toolCallId: typed no-op.
  assert.equal(await store.answerPendingAskUser(chat, 'a1', 'tc-x', 'answer'), 'unchanged');
  // Correct call resolves once; repeating is an idempotent typed no-op.
  assert.equal(await store.answerPendingAskUser(chat, 'a1', 'tc-9', 'answer'), 'applied');
  assert.equal(await store.answerPendingAskUser(chat, 'a1', 'tc-9', 'another'), 'unchanged');
  const loaded = await store.loadMessages(chat);
  const part = askUserPart((loaded[0] as { parts: AskUserToolPart[] }).parts)[0];
  assert.deepEqual(part?.output, { answer: 'answer' });
  // A user message appended after still loads untouched and the list grows.
  await store.appendMessage(chat, userMessage('ok', 'u9'));
  assert.equal((await store.loadMessages(chat)).length, 2);
});

// ---------------------------------------------------------------------------
// Redis store: HITL Lua semantics emulated in-process (same pattern as
// store-redis.test.ts; real-Redis Lua execution is integration-tested live).
// ---------------------------------------------------------------------------

class HitlTinyRedis implements RedisLike {
  readonly lists = new Map<string, string[]>();
  readonly data = new Map<string, string>();
  lastEval: string | null = null;
  readonly lsets: Array<{ key: string; index: number; value: string }> = [];
  /** Optional concurrent-writer hook fired BEFORE each CAS eval. */
  beforeEachEval: ((key: string) => void) | null = null;
  /** Sorted sets (activity index), only ever exercised via the append script. */
  readonly zsets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string, _options?: { EX?: number; NX?: boolean }): Promise<unknown> {
    this.data.set(key, value);
    return 'OK';
  }
  async del(key: string): Promise<number> {
    const existed = this.data.delete(key);
    this.lists.delete(key);
    return existed ? 1 : 0;
  }
  async rPush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }
  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }
  async lIndex(key: string, index: number): Promise<string | null> {
    return this.lists.get(key)?.[index] ?? null;
  }
  async lSet(key: string, index: number, value: string): Promise<void> {
    const list = this.lists.get(key);
    if (list === undefined || list[index] === undefined) {
      throw new Error('no such key/index');
    }
    list[index] = value;
    this.lsets.push({ key, index, value });
  }
  async lLen(key: string): Promise<number> {
    return (this.lists.get(key) ?? []).length;
  }
  async zAdd(key: string, members: Array<{ value: string; score: number }>): Promise<number> {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    this.zsets.set(key, zset);
    for (const member of members) {
      zset.set(member.value, member.score);
    }
    return members.length;
  }
  async zRangeWithScores(key: string): Promise<Array<{ value: string; score: number }>> {
    const zset = this.zsets.get(key);
    if (zset === undefined) {
      return [];
    }
    return [...zset.entries()].map(([value, score]) => ({ value, score }));
  }
  async scan(): Promise<{ cursor: string; keys: string[] }> {
    return { cursor: '0', keys: [] };
  }
  async zScore(): Promise<number | null> {
    return null;
  }
  async eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown> {
    this.lastEval = script;
    // The activity-index append script: emulate TYPE → RPUSH → ZADD exactly.
    if (script === APPEND_MESSAGE_WITH_INDEX_LUA) {
      if (this.data.has(options?.keys?.[1] ?? '')) {
        return -1;
      }
      const listKey = options?.keys?.[0] ?? '';
      const [entry, score, member] = options?.arguments ?? [];
      await this.rPush(listKey, entry ?? '');
      this.zsets.set(options?.keys?.[1] ?? '', new Map([[member ?? '', Number(score ?? '0')]]));
      return 1;
    }
    if (script !== ANSWER_PENDING_ASK_USER_LUA) {
      throw new Error('unexpected script');
    }
    // Precise emulation of the byte-CAS: LINDEX compare (string equality)
    // before LSET — exactly what the script does. Simulated concurrent
    // writers run first, so a race yields a strict byte mismatch (0, no LSET).
    this.beforeEachEval?.(options?.keys?.[0] ?? '');
    const key = options?.keys?.[0] ?? '';
    const [indexRaw, expectedRaw, nextRaw] = options?.arguments ?? [];
    const current = await this.lIndex(key, Number(indexRaw));
    if (current !== expectedRaw) {
      return 0;
    }
    await this.lSet(key, Number(indexRaw), nextRaw ?? '');
    return 1;
  }
}

test('redis store: ask_user answers CAS exactly one entry off the raw bytes (no cjson, no re-serialize)', async () => {
  const redis = new HitlTinyRedis();
  const store = createRedisChatStore(redis);
  const chat = { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'hitl-redis' };
  await store.appendMessage(chat, userMessage('hi', 'u1'));
  // Raw entry carries `options: []` (an ARRAY, not {}) and a numeric literal
  // far outside double precision — the round-trip hazards of the old cjson
  // script.
  const raw = `{"id":"a1","role":"assistant","parts":[{"type":"tool-ask_user","state":"input-available","toolCallId":"tc","input":{"question":"Q","options":[],"meta":{"big":12345678901234567890,"tiny":1.5,"flag":true}}}]}`;
  await redis.rPush(`${REDIS_KEY_PREFIX}:chat:${TEST_OWNER.userId}:orchestrator:hitl-redis:messages`, raw);

  const resolved = await store.answerPendingAskUser(chat, 'a1', 'tc', 'the answer');
  assert.equal(resolved, 'applied');
  assert.equal(redis.lastEval, ANSWER_PENDING_ASK_USER_LUA);
  // Exactly ONE LSET; entry count unchanged; user entry untouched.
  assert.equal(redis.lsets.length, 1);
  const entries = redis.lists.get(`${REDIS_KEY_PREFIX}:chat:${TEST_OWNER.userId}:orchestrator:hitl-redis:messages`) ?? [];
  assert.equal(entries.length, 2);

  // BYTE assertions on the stored entry: options stayed `[]`, the large
  // numeric literal kept `12345678901234567890` digit-for-digit, 1.5 stayed
  // `1.5`, booleans untouched; only `state` changed and `output` was inserted.
  const answered = entries[1] ?? '';
  assert.ok(answered.includes('"options":[]'), 'empty array stays an array (never {})');
  assert.ok(answered.includes('"big":12345678901234567890'), 'large integer literal preserved digit-exact');
  assert.ok(answered.includes('"tiny":1.5'));
  assert.ok(answered.includes('"flag":true'));
  assert.ok(answered.includes('"state":"output-available"'));
  assert.ok(answered.includes('"output":{"answer":"the answer"}'));
  // Untouched byte regions: the id prefix is identical to the original raw.
  assert.ok(answered.startsWith('{"id":"a1","role":"assistant","parts":[{"type":"tool-ask_user","state"'));

  const loaded = (await store.loadMessages(chat)) as Array<{ role: string; parts: AskUserToolPart[] }>;
  assert.equal(loaded[0]?.role, 'user');
  const part = askUserPart(loaded[1]?.parts ?? [])[0];
  assert.equal(part?.state, 'output-available');
  assert.deepEqual(part?.output, { answer: 'the answer' });
  // The parsed input is value-identical for everything JSON.parse can express.
  assert.deepEqual((part?.input as { meta?: { tiny?: number; flag?: boolean } }).meta?.tiny, 1.5);
  assert.equal((part?.input as { options?: unknown[] }).options !== undefined && Array.isArray((part?.input as { options?: unknown[] }).options), true);

  // Second call: typed no-op (part is not pending anymore), no LSET.
  const lsetsBefore = redis.lsets.length;
  assert.equal(await store.answerPendingAskUser(chat, 'a1', 'tc', 'second'), 'unchanged');
  assert.equal(redis.lsets.length, lsetsBefore);
  // Missing ids: typed no-ops, never throws.
  assert.equal(await store.answerPendingAskUser(chat, 'a-missing', 'tc', 'x'), 'unchanged');
  assert.equal(await store.answerPendingAskUser({ ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'nope' } satisfies { ownerId: string; slug: string; chatId: string }, 'a1', 'tc', 'x'), 'unchanged');
});

test('redis store: stale CAS (concurrent writer between read and CAS) reports stale WITHOUT corrupting', async () => {
  const redis = new HitlTinyRedis();
  const store = createRedisChatStore(redis);
  const chat = { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'hitl-stale' };
  await store.appendMessage(chat, assistantMessageWithAskUser({ id: 'a1', question: 'Q', toolCallId: 'tc' }));
  const messagesKey = `${REDIS_KEY_PREFIX}:chat:${TEST_OWNER.userId}:orchestrator:hitl-stale:messages`;

  let racedCount = 0;
  redis.beforeEachEval = () => {
    // Simulated concurrent writers on EVERY attempt: each CAS sees different
    // bytes than it read, so all retries lose without any LSET landing.
    racedCount += 1;
    const list = redis.lists.get(messagesKey) ?? [];
    list[0] = `{"id":"a1","role":"assistant","parts":[{"type":"tool-ask_user","state":"input-available","toolCallId":"tc","input":{"question":"reworded by writer ${String(racedCount)}","options":[],"big":12345678901234567890}}]}`;
    redis.lists.set(messagesKey, list);
  };

  const outcome = await store.answerPendingAskUser(chat, 'a1', 'tc', 'late answer');
  assert.equal(outcome, 'stale', 'CAS lost after bounded retries');
  assert.equal(racedCount >= 2, true, 'the store retried with fresh reads');
  // NO LSET ever landed: the concurrent writer's bytes are intact (no
  // whole-list rewrite, no merged/corrupted entry).
  assert.equal(redis.lsets.length, 0);
  const rawEntries = redis.lists.get(messagesKey) ?? [];
  assert.ok((rawEntries[0] ?? '').includes('"reworded by writer'), 'racing writer bytes intact');
  assert.ok(!(rawEntries[0] ?? '').includes('"output"'));
  assert.ok((rawEntries[0] ?? '').includes('"options":[]'), 'no {} corruption of the racing entry');
  assert.ok((rawEntries[0] ?? '').includes('"big":12345678901234567890'));

  // Fresh call without the racing writer succeeds from the new bytes.
  redis.beforeEachEval = null;
  assert.equal(await store.answerPendingAskUser(chat, 'a1', 'tc', 'the answer'), 'applied');
  const after = redis.lists.get(messagesKey) ?? [];
  assert.ok((after[0] ?? '').includes('"output":{"answer":"the answer"}'));
  assert.equal(redis.lsets.length, 1);
});

test('hydration shows the answered state after resume (mid-stream refresh safe)', { concurrency: false }, async () => {
  const chatId = 'hitl-hydration';
  const app = await agentsApp([textStep(), textStep()]);
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId }, [
      assistantMessageWithAskUser({ id: 'a1', question: 'Ready?', toolCallId: 'tc-5' }),
    ]);
    const before = await storedParts(app, chatId);
    assert.equal(askUserPart(before[0]?.parts ?? [])[0]?.state, 'input-available');
    const response = await postChat({ port: app.port, slug: 'orchestrator', body: { id: chatId, message: userMessage('yes', 'u2') } });
    assert.equal(response.status, 200);
    await response.text();
    const after = await storedParts(app, chatId);
    assert.equal(askUserPart(after[0]?.parts ?? [])[0]?.state, 'output-available');
  } finally {
    await app.close();
  }
});

test('unresolved pending questions from older assistant messages do not block new turns', { concurrency: false }, async () => {
  const chatId = 'hitl-old-pending';
  const app = await agentsApp([textStep(), textStep(), textStep()]);
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId }, [
      assistantMessageWithAskUser({ id: 'a-older', question: 'Old question', toolCallId: 'tc-old' }),
      { id: 'u-between', role: 'user', parts: [{ type: 'text', text: 'moving on' }] },
      { id: 'a-latest', role: 'assistant', parts: [{ type: 'text', text: 'sure.' }] },
    ]);
    // Latest assistant message has NO pending ask_user → the OLD pending
    // question (the newest pending overall) receives the actual new user
    // answer; no unmatched tool call can wedge later turns.
    const response = await postChat({ port: app.port, slug: 'orchestrator', body: { id: chatId, message: userMessage('and now', 'u-new') } });
    assert.equal(response.status, 200);
    const chunks = await parseSseChunks(response);
    assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'), 'the turn generates normally');
    const messages = await storedParts(app, chatId);
    const older = messages[0];
    const oldPart = askUserPart(older?.parts ?? [])[0];
    assert.equal(oldPart?.state, 'output-available', 'old pending question resolved');
    if (oldPart?.state === 'output-available') {
      assert.deepEqual(oldPart?.output, { answer: 'and now' });
    }
    // User messages remain append-only.
    assert.equal(messages[1]?.id, 'u-between');
  } finally {
    await app.close();
  }
});

test('in-memory store matches Redis semantics: co-located values byte/value-stable across the answer', { concurrency: false }, async () => {
  const store = createInMemoryChatStore();
  const chat = { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: 'hitl-memory' };
  await store.appendMessage(chat, {
    id: 'a-m',
    role: 'assistant',
    parts: [
      {
        type: 'tool-ask_user',
        toolCallId: 'tc-m',
        state: 'input-available',
        input: { question: 'Pick', options: [] as string[], meta: { big: 1.5, tiny: 0.1, flag: true, list: [1, [2, 3]] } },
      },
    ],
  } as unknown as UIMessage);
  const before = (await store.loadMessages(chat))[0] as { parts: Array<Record<string, unknown>> };
  const inputBefore = (before.parts[0] as { input: Record<string, unknown> }).input;

  assert.equal(await store.answerPendingAskUser(chat, 'a-m', 'tc-m', 'memory answer'), 'applied');
  assert.equal(await store.answerPendingAskUser(chat, 'a-m', 'tc-m', 'again'), 'unchanged');

  const loaded = (await store.loadMessages(chat))[0] as { parts: Array<Record<string, unknown>> };
  const part = loaded.parts[0] as { state: string; input: Record<string, unknown>; output?: { answer: string } };
  assert.equal(part.state, 'output-available');
  assert.deepEqual(part.output, { answer: 'memory answer' });
  const inputAfter = (loaded.parts[0] as { input: Record<string, unknown> }).input;
  // Co-located payload survives untouched: options stays an ARRAY, nested
  // numbers/arrays/booleans value-identical (never {}-collapsed or re-ranged).
  assert.deepEqual(inputBefore, inputAfter);
  assert.equal(Array.isArray(inputAfter['options']), true);
  assert.deepEqual(inputAfter['options'], []);
  assert.deepEqual(inputAfter['meta'], { big: 1.5, tiny: 0.1, flag: true, list: [1, [2, 3]] });
});

test('multi-assistant stale pendings: newest gets the real answer, older get the bounded sentinel', { concurrency: false }, async () => {
  const chatId = 'hitl-multi-stale';
  const app = await agentsApp([textStep(), textStep()]);
  try {
    await seedMessages(app.store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId }, [
      { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'start' }] },
      assistantMessageWithAskUser({ id: 'a-1', question: 'First question', toolCallId: 'tc-1' }),
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'skip that' }] },
      assistantMessageWithAskUser({ id: 'a-2', question: 'Second question', toolCallId: 'tc-2' }),
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'and again' }] },
      // The LATEST assistant message has NO pending parts: generation
      // previously wedged without a result here.
      { id: 'a-3', role: 'assistant', parts: [{ type: 'text', text: 'text only' }] },
    ]);
    const response = await postChat({ port: app.port, slug: 'orchestrator', body: { id: chatId, message: userMessage('the real answer', 'u3') } });
    assert.equal(response.status, 200);
    await response.text();
    const messages = await storedParts(app, chatId);
    const first = askUserPart(messages[1]?.parts ?? [])[0];
    const second = askUserPart(messages[3]?.parts ?? [])[0];
    assert.equal(first?.state, 'output-available');
    assert.deepEqual(first?.output, { answer: ASK_USER_NO_ANSWER }, 'older pending gets the bounded sentinel');
    assert.equal(second?.state, 'output-available');
    assert.deepEqual(second?.output, { answer: 'the real answer' }, 'newest pending gets the real answer');
    // User parts are append-only and untouched.
    assert.deepEqual(messages[6]?.parts, [{ type: 'text', text: 'the real answer' }]);
    // The turn resumed over the full answered transcript.
    const appended = messages.at(-1);
    assert.equal(appended?.role, 'assistant');
  } finally {
    await app.close();
  }
});
