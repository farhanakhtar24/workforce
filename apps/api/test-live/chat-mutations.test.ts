/**
 * Live Redis integration for the authenticated chat MUTATIONS (pre-Phase 6
 * lifecycle): DELETE / branch / destructive rewind against REAL Redis
 * through the REAL Express app (staticOwner test-only identity; no provider,
 * no network beyond this process). Byte-exact raw preservation (huge numeric
 * literals, `options: []`), active-stream refusal, cross-owner same-id
 * isolation, and run-scoped cleanup (exact keys, never legacy/user data).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type RedisClientType } from 'redis';
import type { LanguageModel } from 'ai';

import {
  createBackgroundTracker,
  type BackgroundTaskTracker,
} from '../src/background.js';
import { loadApiConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import {
  REDIS_KEY_PREFIX,
  chatIndexKey,
  createRedisChatStore,
  type RedisLike,
} from '../src/store/redis.js';
import { createInMemoryStreamContext } from '../src/stream-context/memory.js';
import { createMockModel, textStep, TEST_OWNER, TEST_OWNER_B } from '../test/helpers.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
/** Unique per run: cleanup deletes EXACTLY these keys, nothing else. */
const RUN_ID = `mut-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const OWNER_ID = `owner-${RUN_ID}`;
const SLUG = 'general';
const CHAT_ID = `${RUN_ID}-chat`;
const BRANCH_ID = `${RUN_ID}-branch`;
const CROSS_ID = `${RUN_ID}-cross`;

const RAW_HUGE = `{"id":"a1","role":"assistant","parts":[{"type":"tool-ask_user","toolCallId":"tc1","state":"output-available","output":{"answer":"answer one"},"input":{"question":"q","options":[],"meta":{"big":12345678901234567890,"tiny":1.5,"flag":true}}}]}`;

interface LiveStack {
  base: RedisClientType;
  port: number;
  ownKey(key: string): void;
  ownMember(member: string): void;
  close(): Promise<void>;
}

async function createLiveStack(
  model: LanguageModel,
  staticOwner: { userId: string; email: string; emailVerified: boolean },
  options: { catalogRows?: string[] } = {},
): Promise<LiveStack> {
  const base = createClient({
    url: REDIS_URL,
    socket: { reconnectStrategy: false, connectTimeout: 2500 },
  });
  base.on('error', () => undefined);
  await base.connect();

  const background = createBackgroundTracker({ onError: () => undefined });
  const store = createRedisChatStore(base as unknown as RedisLike);
  const streamContext = createInMemoryStreamContext();
  const config = loadApiConfig({ OLLAMA_API_KEY: 'test-only-not-a-real-key', PORT: '3001', REDIS_URL });
  const app = buildApp({
    config,
    store,
    streamContext,
    model,
    background,
    auth: { staticOwner: staticOwner },
    models:
      options.catalogRows === undefined
        ? undefined
        : {
            catalog: {
              async list() {
                return {
                  models: options.catalogRows!.map((id) => ({
                    id,
                    name: id,
                    modifiedAt: null,
                    capabilities: [] as string[],
                    parameterSize: null,
                    locked: false,
                    lockReason: null,
                  })),
                };
              },
              async details(modelId: string) {
                void modelId;
                return { status: 'ok' as const, details: { contextLength: null, capabilities: null, parameterSize: null, thinking: null } };
              },
            },
            modelFor: () => model,
            defaultModelId: 'glm-5.3-flash',
          },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');

  const ownedKeys = new Set<string>();
  const ownedMembers = new Set<string>();
  return {
    base,
    port: address.port,
    ownKey(key: string): void {
      ownedKeys.add(key);
    },
    ownMember(member: string): void {
      ownedMembers.add(member);
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      server.closeIdleConnections();
      await background.waitForAll(3000);
      await Promise.allSettled([...ownedKeys].map((key) => base.del(key)));
      await Promise.allSettled([...ownedMembers].map((member) => base.zRem(chatIndexKey(OWNER_ID), member)));
      await Promise.allSettled([base.quit()]);
    },
  };
}

/** Reads the raw list directly (byte assertions use RAW, not parsed). */
async function rawList(base: RedisClientType, ownerId: string, chatId: string): Promise<string[]> {
  return await base.lRange(`${REDIS_KEY_PREFIX}:chat:${ownerId}:${SLUG}:${chatId}:messages`, 0, -1);
}

test('live: destructive rewind keeps RAW bytes, releases removed-user keys, refuses while active', { timeout: 30_000 }, async () => {
  const model = createMockModel({ steps: [textStep(), textStep(), textStep()] });
  const stack = await createLiveStack(model as unknown as LanguageModel, {
    userId: OWNER_ID,
    email: 'live-mutations@example.com',
    emailVerified: true,
  });
  const messagesKey = `${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${CHAT_ID}:messages`;
  try {
    // Seed EXACT raw storage entries (like a real generation would persist).
    const userRaw1 = JSON.stringify({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first live question' }] });
    const userRaw2 = JSON.stringify({ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second live question' }] });
    await stack.base.rPush(messagesKey, userRaw1);
    await stack.base.rPush(messagesKey, RAW_HUGE);
    await stack.base.rPush(messagesKey, userRaw2);
    stack.ownKey(messagesKey);
    stack.ownKey(`${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${CHAT_ID}:active-stream`);
    stack.ownKey(`${REDIS_KEY_PREFIX}:idempotency:${OWNER_ID}:${SLUG}:${CHAT_ID}:${CHAT_ID}:u1`);
    stack.ownKey(`${REDIS_KEY_PREFIX}:idempotency:${OWNER_ID}:${SLUG}:${CHAT_ID}:${CHAT_ID}:u2`);
    stack.ownMember(`${SLUG}:${CHAT_ID}`);
    await stack.base.set(`${REDIS_KEY_PREFIX}:idempotency:${OWNER_ID}:${SLUG}:${CHAT_ID}:${CHAT_ID}:u1`, '1', { EX: 900 });
    await stack.base.set(`${REDIS_KEY_PREFIX}:idempotency:${OWNER_ID}:${SLUG}:${CHAT_ID}:${CHAT_ID}:u2`, '1', { EX: 900 });
    await stack.base.zAdd(chatIndexKey(OWNER_ID), [{ value: `${SLUG}:${CHAT_ID}`, score: Date.now() }]);

    // Active stream → fixed 409, nothing trimmed.
    await stack.base.set(`${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${CHAT_ID}:active-stream`, 'strm-live', { EX: 300 });
    const busy = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat/${CHAT_ID}/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'a1' }),
    });
    assert.equal(busy.status, 409);
    assert.equal((await rawList(stack.base, OWNER_ID, CHAT_ID)).length, 3);

    // Clear the marker → rewind through a1 (removes u2's turn tail: u2 + nothing after).
    await stack.base.del(`${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${CHAT_ID}:active-stream`);
    const rewound = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat/${CHAT_ID}/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'a1' }),
    });
    assert.equal(rewound.status, 200);
    const rewoundBody = (await rewound.json()) as { rewound: boolean; kept: number; removed: number; hasActiveStream: boolean };
    assert.equal(rewoundBody.rewound, true);
    assert.equal(rewoundBody.kept, 2);
    assert.equal(rewoundBody.removed, 1);
    assert.equal(rewoundBody.hasActiveStream, false);

    // RAW byte assertions through REAL Redis: userRaw1 + RAW_HUGE byte-identical.
    assert.deepEqual(await rawList(stack.base, OWNER_ID, CHAT_ID), [userRaw1, RAW_HUGE]);

    // Removed user id u2's key released; u1's key kept.
    const u2Key = await stack.base.get(`${REDIS_KEY_PREFIX}:idempotency:${OWNER_ID}:${SLUG}:${CHAT_ID}:${CHAT_ID}:u2`);
    assert.equal(u2Key, null, 'removed turn key released (regenerable)');
    const u1Key = await stack.base.get(`${REDIS_KEY_PREFIX}:idempotency:${OWNER_ID}:${SLUG}:${CHAT_ID}:${CHAT_ID}:u1`);
    assert.notEqual(u1Key, null, 'kept turn key survives');

    // DELETE round-trip: removes list + index member.
    const deleted = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat/${CHAT_ID}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const deletedBody = (await deleted.json()) as { deleted: boolean; purgedPersonalMemoryBlocks?: number };
    assert.equal(deletedBody.deleted, true);
    assert.deepEqual(await rawList(stack.base, OWNER_ID, CHAT_ID), []);
    const member = await stack.base.zScore(chatIndexKey(OWNER_ID), `${SLUG}:${CHAT_ID}`);
    assert.equal(member, null, 'index member ZREM-ed');
  } finally {
    await stack.close();
  }
});

test('live: branch copies RAW bytes through the selected message; cross-owner same chat id isolated', { timeout: 30_000 }, async () => {
  const model = createMockModel({ steps: [textStep(), textStep()] });
  const stack = await createLiveStack(model as unknown as LanguageModel, {
    userId: OWNER_ID,
    email: 'live-mutations@example.com',
    emailVerified: true,
  });
  const srcKey = `${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${CHAT_ID}:messages`;
  const srcBranchKey = `${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${BRANCH_ID}:messages`;
  const crossKey = `${REDIS_KEY_PREFIX}:chat:${TEST_OWNER_B.userId}:${SLUG}:${CROSS_ID}:messages`;
  const branchIndexMember = `${SLUG}:${BRANCH_ID}`;
  const crossIndexMember = `${SLUG}:${CROSS_ID}`;
  try {
    const userRaw1 = JSON.stringify({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'branch base live' }] });
    await stack.base.rPush(srcKey, userRaw1);
    await stack.base.rPush(srcKey, RAW_HUGE);
    stack.ownKey(srcKey);
    stack.ownKey(srcBranchKey);
    stack.ownKey(`${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${BRANCH_ID}:active-stream`);
    stack.ownMember(branchIndexMember);
    stack.ownMember(crossIndexMember);

    const branched = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat/${CHAT_ID}/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'a1', newChatId: BRANCH_ID }),
    });
    assert.equal(branched.status, 201);
    assert.deepEqual((await branched.json()) as unknown, { branched: true, destinationChatId: BRANCH_ID, copiedMessages: 2 });
    // Byte-exact raw copy in REAL Redis.
    assert.deepEqual(await rawList(stack.base, OWNER_ID, BRANCH_ID), [userRaw1, RAW_HUGE]);
    // Source untouched.
    assert.deepEqual(await rawList(stack.base, OWNER_ID, CHAT_ID), [userRaw1, RAW_HUGE]);
    // Destination indexed.
    assert.ok((await stack.base.zScore(chatIndexKey(OWNER_ID), branchIndexMember)) !== null, 'branch index member written');

    // Cross-owner: same chat id under owner B, built via owner B's OWN app
    // (the source must be invisible → fixed404), destination independent.
    const foreignStack = await createLiveStack(model as unknown as LanguageModel, {
      userId: TEST_OWNER_B.userId,
      email: 'live-mutations-b@example.com',
      emailVerified: true,
    });
    try {
      const foreign = await fetch(`http://127.0.0.1:${foreignStack.port}/api/agents/${SLUG}/chat/${CHAT_ID}/branch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'u1', newChatId: CROSS_ID }),
      });
      assert.equal(foreign.status, 404, 'owner B cannot read owner A\u2019s source');
      assert.deepEqual((await foreign.json()) as unknown, { error: 'Chat not found.' });
      assert.deepEqual(await rawList(foreignStack.base, TEST_OWNER_B.userId, CROSS_ID), [], "owner B\u2019s same-id destination untouched");
      // And owner B CAN branch its OWN chat with the same slug+chatId pair.
      await foreignStack.base.rPush(crossKey, JSON.stringify({ id: 'b1', role: 'user', parts: [{ type: 'text', text: 'B\u2019s own content' }] }));
      foreignStack.ownKey(crossKey);
      const ownBranch = await fetch(`http://127.0.0.1:${foreignStack.port}/api/agents/${SLUG}/chat/${CROSS_ID}/branch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'b1', newChatId: `${CROSS_ID}-b` }),
      });
      assert.equal(ownBranch.status, 201, 'same-id chat under owner B works in its own scope');
      foreignStack.ownKey(`${REDIS_KEY_PREFIX}:chat:${TEST_OWNER_B.userId}:${SLUG}:${CROSS_ID}-b:messages`);
    } finally {
      await foreignStack.close();
    }
  } finally {
    await stack.close();
  }
});

test('live: per-chat MODEL selection — real-Redis get/set, branch copy, rewind keep, delete remove; blocked + absent fixed400', { timeout: 30_000 }, async () => {
  const model = createMockModel({ steps: [textStep(), textStep()] });
  const stack = await createLiveStack(
    model as unknown as LanguageModel,
    {
      userId: OWNER_ID,
      email: 'live-mutations@example.com',
      emailVerified: true,
    },
    { catalogRows: ['glm-5.3-flash', 'gpt-oss:20b'] },
  );
  const modelKey = `${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${CHAT_ID}:model`;
  try {
    stack.ownKey(modelKey);
    const modelPath = `/api/agents/${SLUG}/chat/${CHAT_ID}/model`;

    // Unset → the default; raw Redis GET confirms nothing stored.
    const initial = await fetch(`http://127.0.0.1:${stack.port}${modelPath}`);
    assert.equal(initial.status, 200);
    assert.deepEqual((await initial.json()) as unknown, { modelId: 'glm-5.3-flash' });
    assert.equal(await stack.base.get(modelKey), null);

    // PUT a cataloged model → 200 + persisted plain string in REAL Redis.
    const put = await fetch(`http://127.0.0.1:${stack.port}${modelPath}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'gpt-oss:20b' }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual((await put.json()) as unknown, { modelId: 'gpt-oss:20b' });
    assert.equal(await stack.base.get(modelKey), 'gpt-oss:20b');

    // Rejections: blocked (case-insensitive), absent from catalog, malformed.
    for (const [blockedId, expected, status] of [
      ['kimi-k2:free', 'Model id is blocked by WORKFORCE_BLOCKED_MODEL_PREFIXES.', 400],
      ['KIMI-K2-THINKING', 'Model id is blocked by WORKFORCE_BLOCKED_MODEL_PREFIXES.', 400],
      ['never-in-catalog:1b', 'Model is not available.', 400],
      ['bad/slash', 'modelId must be 1-80 characters of A-Z a-z 0-9 . _ : -', 400],
    ] as const) {
      const rejected = await fetch(`http://127.0.0.1:${stack.port}${modelPath}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: blockedId }),
      });
      assert.equal(rejected.status, status, blockedId);
      assert.deepEqual((await rejected.json()) as unknown, { error: expected });
      assert.equal(await stack.base.get(modelKey), 'gpt-oss:20b', `nothing written by ${blockedId}`);
    }

    // Seed the transcript + REWIND: the model selection survives.
    const messagesKey = `${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${CHAT_ID}:messages`;
    const userRaw1 = JSON.stringify({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'live model question' }] });
    await stack.base.rPush(messagesKey, userRaw1);
    stack.ownKey(messagesKey);
    stack.ownMember(`${SLUG}:${CHAT_ID}`);
    await stack.base.zAdd(chatIndexKey(OWNER_ID), [{ value: `${SLUG}:${CHAT_ID}`, score: Date.now() }]);
    const rewound = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat/${CHAT_ID}/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u1' }),
    });
    assert.equal(rewound.status, 200);
    assert.equal(await stack.base.get(modelKey), 'gpt-oss:20b', 'rewind preserves the model selection');

    // BRANCH: the model copy happens inside the same atomic Lua script.
    const branchModelKey = `${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${BRANCH_ID}:model`;
    stack.ownKey(`${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${BRANCH_ID}:messages`);
    stack.ownKey(branchModelKey);
    stack.ownKey(`${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${BRANCH_ID}:active-stream`);
    stack.ownMember(`${SLUG}:${BRANCH_ID}`);
    const branched = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat/${CHAT_ID}/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u1', newChatId: BRANCH_ID }),
    });
    assert.equal(branched.status, 201);
    assert.equal(await stack.base.get(branchModelKey), 'gpt-oss:20b', 'branch copies the model atomically');

    // DELETE removes the setting together with the chat.
    const deleted = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat/${CHAT_ID}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal(await stack.base.get(modelKey), null, 'delete removed the model key');
    assert.equal(await stack.base.get(branchModelKey), 'gpt-oss:20b', 'the branch\u2019s copy survives the source delete');
  } finally {
    await stack.close();
  }
});

test('live: usage endpoint — exact sums over REAL stored usage; pricing absent → null with the stable reason', { timeout: 30_000 }, async () => {
  const model = createMockModel({ steps: [textStep()] });
  const stack = await createLiveStack(model as unknown as LanguageModel, {
    userId: OWNER_ID,
    email: 'live-mutations@example.com',
    emailVerified: true,
  });
  try {
    const messagesKey = `${REDIS_KEY_PREFIX}:chat:${OWNER_ID}:${SLUG}:${CHAT_ID}:messages`;
    const assistantRaw = JSON.stringify({
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'live usage answer' }],
      metadata: { modelId: 'glm-5.3-flash', usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } },
    });
    const legacyRaw = JSON.stringify({
      id: 'a2',
      role: 'assistant',
      parts: [{ type: 'text', text: 'pre-provenance' }],
      metadata: { other: true, usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
    });
    await stack.base.rPush(messagesKey, assistantRaw);
    await stack.base.rPush(messagesKey, legacyRaw);
    stack.ownKey(messagesKey);
    stack.ownMember(`${SLUG}:${CHAT_ID}`);

    const usage = await fetch(`http://127.0.0.1:${stack.port}/api/agents/${SLUG}/chat/${CHAT_ID}/usage`);
    assert.equal(usage.status, 200);
    assert.deepEqual((await usage.json()) as unknown, {
      inputTokens: 103,
      outputTokens: 44,
      totalTokens: 147,
      models: [
        { modelId: '(unattributed)', inputTokens: 3, outputTokens: 4, totalTokens: 7, messages: 1 },
        { modelId: 'glm-5.3-flash', inputTokens: 100, outputTokens: 40, totalTokens: 140, messages: 1 },
      ],
      estimatedCostUsd: null,
      costReason: 'pricing_not_configured',
    });
  } finally {
    await stack.close();
  }
});
