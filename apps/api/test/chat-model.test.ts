/**
 * Pre-Phase 6 model lifecycle tests: per-chat model selection (GET/PUT +
 * validation + blocked policy + catalog presence), default resolution,
 * generation-time routing/provenance (`modelFor` routing + `metadata.modelId`
 * on the hydrated assistant message), the authenticated usage endpoint
 * (exact token sums, per-model buckets, cost with the explicit pricing JSON),
 * and delegation child model inheritance. Offline only — no live provider,
 * no key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModel, UIMessage } from 'ai';

import {
  createMockModel,
  textStep,
  startTestApp,
  userMessage,
  seedMessages,
  TEST_OWNER,
  TEST_OWNER_B,
  getJson,
  TEST_DELEGATION_SECRET,
  type TestApp,
} from './helpers.js';
import { createInMemoryChatStore } from '../src/store/memory.js';
import type { ChatRef } from '../src/store/types.js';
import { summarizeChatUsage, MODEL_USAGE_UNATTRIBUTED, type ModelPricing } from '../src/usage/usage.js';
import { isBlockedModelId, isModelId, MODEL_LOCK_REASON, type ModelCatalogLike } from '../src/models/catalog.js';
import {
  createDelegationContextSigner,
  DELEGATION_CONTEXT_HEADER,
} from '../src/agents/delegation-context.js';

void isModelId;
void textStep;

const BLOCKED_PREFIXES = ['kimi'];
const DEFAULT_MODEL = 'glm-5.3-flash';
const OTHER_MODEL = 'gpt-oss:20b';

interface CatalogRow {
  readonly id: string;
  readonly name: string;
}

interface CatalogRow {
  readonly id: string;
  readonly name: string;
}

interface ModelsComposition {
  readonly catalog: {
    list(): Promise<{ models: Array<{ id: string; name: string; modifiedAt: string | null; capabilities: string[]; parameterSize: string | null; locked: boolean; lockReason: string | null }> }>;
    details(modelId: string): Promise<{ status: 'ok' | 'not-found'; details: { contextLength: number | null; capabilities: string[] | null; parameterSize: string | null; thinking: boolean | null } | undefined }>;
  };
  readonly modelFor: (modelId: string) => LanguageModel;
  readonly defaultModelId: string;
}

/** Fake catalog + recording modelFor (the mock model runs any id offline). */
function modelsComposition(
  model: LanguageModel,
  options: { rows?: readonly CatalogRow[]; calls?: string[]; fail?: boolean } = {},
): ModelsComposition {
  const rows: readonly CatalogRow[] = options.rows ?? [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }, { id: OTHER_MODEL, name: OTHER_MODEL }];
  return {
    catalog: {
      async list() {
        if (options.fail === true) {
          throw new Error('catalog down');
        }
        return {
          models: rows.map((row) => ({
            id: row.id,
            name: row.name,
            modifiedAt: null,
            capabilities: [],
            parameterSize: null,
            locked: isBlockedModelId(row.id, BLOCKED_PREFIXES),
            lockReason: isBlockedModelId(row.id, BLOCKED_PREFIXES) ? MODEL_LOCK_REASON : null,
          })),
        };
      },
            async details(modelId: string): Promise<{ status: 'ok' | 'not-found'; details: { contextLength: number | null; capabilities: string[] | null; parameterSize: string | null; thinking: boolean | null } | undefined }> {
        void modelId;
        return { status: 'ok' as const, details: { contextLength: null, capabilities: null, parameterSize: null, thinking: null } };
      },
    },
    modelFor: (modelId: string): LanguageModel => {
      options.calls?.push(modelId);
      return model;
    },
    defaultModelId: DEFAULT_MODEL,
  };
}

async function startSelApp(models: ModelsComposition): Promise<TestApp> {
  return await startTestApp({ model: createMockModel({ steps: [textStep()] }), models });
}

/** POST /api/agents/:segments[0]/chat with the canonical idempotency key. */
async function postChatBody(port: number, segments: readonly string[], chatId: string, message: UIMessage): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/api/agents/${segments[0]}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': `${chatId}:${message.id}` },
    body: JSON.stringify({ id: chatId, message }),
  });
}

// ---------------------------------------------------------------------------
// Blocked policy (unit)
// ---------------------------------------------------------------------------

test('blocked policy: case-insensitive prefixes; exact ids unaffected', () => {
  assert.equal(isBlockedModelId('kimi-k2:free', BLOCKED_PREFIXES), true);
  assert.equal(isBlockedModelId('KIMI-K2-THINKING', BLOCKED_PREFIXES), true);
  assert.equal(isBlockedModelId('kimi', BLOCKED_PREFIXES), true);
  assert.equal(isBlockedModelId('glm-5.3-flash', BLOCKED_PREFIXES), false);
  assert.equal(isBlockedModelId('mik-test', BLOCKED_PREFIXES), false);
});

// ---------------------------------------------------------------------------
// Route: GET/PUT /model
// ---------------------------------------------------------------------------

test('model selection: GET returns the default; PUT applies; per-owner isolation', async () => {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const models = modelsComposition(createMockModel({ steps: [textStep()] }));
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }), models });
  try {
    const owner = { ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'sel-1' } as ChatRef;
    await seedMessages(store, owner, [userMessage('seed', 'u1')]);
    const modelPath = '/api/agents/general/chat/sel-1/model';

    const initial = await getJson({ port: app.port, path: modelPath });
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { modelId: DEFAULT_MODEL });

    const put = await fetch(`http://127.0.0.1:${app.port}${modelPath}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: OTHER_MODEL }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual((await put.json()) as unknown, { modelId: OTHER_MODEL });
    assert.deepEqual((await getJson({ port: app.port, path: modelPath })).body, { modelId: OTHER_MODEL });
    assert.deepEqual(await store.getChatModel(owner), OTHER_MODEL);

    // Cross-owner SAME chat id: owner B's unset chat stays on the default.
    const foreign = await startTestApp({
      store,
      model: createMockModel({ steps: [textStep()] }),
      models,
      auth: { staticOwner: TEST_OWNER_B },
    });
    try {
      const foreignGet = await getJson({ port: foreign.port, path: modelPath });
      assert.deepEqual(foreignGet.body, { modelId: DEFAULT_MODEL });
      // B branches its own chat: A's model is NOT inherited (different owner).
      await seedMessages(store, { ownerId: TEST_OWNER_B.userId, slug: 'general', chatId: 'sel-b' }, [userMessage('b', 'u1'), { id: 'a1-b', role: 'assistant', parts: [] } as unknown as UIMessage]);
      const foreignBranch = await fetch(`http://127.0.0.1:${foreign.port}/api/agents/general/chat/sel-b/branch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'a1-b', newChatId: 'sel-b-clone' }),
      });
      assert.equal(foreignBranch.status, 201);
      const foreignClone = await getJson({ port: foreign.port, path: '/api/agents/general/chat/sel-b-clone/model' });
      assert.deepEqual(foreignClone.body, { modelId: DEFAULT_MODEL }, 'no cross-owner model inheritance');
    } finally {
      await foreign.close();
    }
  } finally {
    await app.close();
  }
});

test('model selection rejections: blocked fixed400, absent fixed400, malformed, catalog 503', async () => {
  const models = modelsComposition(createMockModel({ steps: [textStep()] }));
  const downModels = modelsComposition(createMockModel({ steps: [textStep()] }), { fail: true });
  const app = await startSelApp(models);
  const downApp = await startSelApp(downModels);
  try {
    const modelPath = `/api/agents/general/chat/sel-x/model`;
    const put = async (port: number, bodyValue: unknown, withCtype = true): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${modelPath}`, {
        method: 'PUT',
        headers: withCtype ? { 'content-type': 'application/json' } : {},
        ...(bodyValue === undefined ? {} : { body: JSON.stringify(bodyValue) }),
      });

    for (const blockedId of ['kimi-k2:free', 'KIMI-K2-THINKING']) {
      const response = await put(app.port, { modelId: blockedId });
      assert.equal(response.status, 400, blockedId);
      assert.deepEqual((await response.json()) as unknown, { error: MODEL_LOCK_REASON });
    }
    const absent = await put(app.port, { modelId: 'never-in-catalog:1b' });
    assert.equal(absent.status, 400);
    assert.deepEqual((await absent.json()) as unknown, { error: 'Model is not available.' });
    assert.equal((await put(app.port, { nope: 1 })).status, 400);
    const badCharset = await put(app.port, { modelId: 'bad/slash' });
    assert.equal(badCharset.status, 400);
    assert.equal((await put(app.port, undefined, false)).status, 415);

    const down = await put(downApp.port, { modelId: OTHER_MODEL });
    assert.equal(down.status, 503);
    assert.deepEqual((await down.json()) as unknown, { error: 'Model catalog is temporarily unavailable.' });

    // Nothing was ever written (GET still returns the default).
    const unchanged = await getJson({ port: app.port, path: modelPath });
    assert.deepEqual(unchanged.body, { modelId: DEFAULT_MODEL });
  } finally {
    await app.close();
    await downApp.close();
  }
});

// ---------------------------------------------------------------------------
// Generation: routing + provenance + blocked-at-generation
// ---------------------------------------------------------------------------

test('generation routing: modelFor receives the resolved id; PUT affects the next generation; blocked after set → fixed400', async () => {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const model = createMockModel({ steps: [textStep(), textStep(), textStep(), textStep()] });
  const modelForCalls: string[] = [];
  const models = modelsComposition(model, { calls: modelForCalls });
  const app = await startTestApp({ store, model, models });
  try {
    const owner = { ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'gen-1' } as ChatRef;
    await seedMessages(store, owner, [userMessage('seed', 'u0')]);

    const first = await postChatBody(app.port, ['general'], 'gen-1', userMessage('hello one', 'm1'));
    assert.equal(first.status, 200);
    await first.text();
    assert.deepEqual(modelForCalls, [DEFAULT_MODEL]);
    const hydration = await getJson({ port: app.port, path: '/api/agents/general/chat/gen-1' });
    const messages = (hydration.body as { messages: Array<{ id?: unknown; metadata?: Record<string, unknown> }> }).messages;
    const firstAssistant = messages.find((entry) => entry.id !== 'u0' && entry.id !== 'm1');
    assert.ok(firstAssistant !== undefined);
    assert.equal(firstAssistant.metadata?.modelId, DEFAULT_MODEL, 'model provenance persisted on the assistant finish');
    assert.deepEqual(firstAssistant.metadata?.['usage'], { inputTokens: 12, outputTokens: 7, totalTokens: 19 });

    const put = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/gen-1/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: OTHER_MODEL }),
    });
    assert.equal(put.status, 200);
    const second = await postChatBody(app.port, ['general'], 'gen-1', userMessage('hello two', 'm2'));
    assert.equal(second.status, 200);
    await second.text();
    assert.deepEqual(modelForCalls, [DEFAULT_MODEL, OTHER_MODEL], 'the new selection routed to the next generation');

    // Simulated policy change AFTER selection: the generation is the defense.
    await store.setChatModel(owner, 'kimi-k2:free');
    const third = await postChatBody(app.port, ['general'], 'gen-1', userMessage('hello three', 'm3'));
    assert.equal(third.status, 400);
    assert.deepEqual((await third.json()) as unknown, { error: 'Model is not allowed.' });
    assert.deepEqual(modelForCalls, [DEFAULT_MODEL, OTHER_MODEL], 'the blocked generation never reached a model');

    // Unset again → default again.
    await store.setChatModel(owner, null);
    const fourth = await postChatBody(app.port, ['general'], 'gen-1', userMessage('hello four', 'm4'));
    assert.equal(fourth.status, 200);
    await fourth.text();
    assert.deepEqual(modelForCalls, [DEFAULT_MODEL, OTHER_MODEL, DEFAULT_MODEL]);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Usage endpoint
// ---------------------------------------------------------------------------

test('usage: token sums + per-model buckets; absent pricing → null with the stable reason', async () => {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }) });
  try {
    const owner = { ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'usg-1' } as ChatRef;
    await store.appendMessage(owner, {
      id: 'a-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'one' }],
      metadata: { modelId: DEFAULT_MODEL, usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } },
    } as never);
    await store.appendMessage(owner, {
      id: 'a-2',
      role: 'assistant',
      parts: [{ type: 'text', text: 'two' }],
      metadata: { modelId: OTHER_MODEL, usage: { inputTokens: 10, outputTokens: 5 } },
    } as never);
    await store.appendMessage(owner, {
      id: 'a-3',
      role: 'assistant',
      parts: [{ type: 'text', text: 'unattributed' }],
      metadata: { other: true, usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
    } as never);
    await store.appendMessage(owner, {
      id: 'a-4',
      role: 'assistant',
      parts: [{ type: 'text', text: 'no usage' }],
      metadata: { modelId: OTHER_MODEL },
    } as never);
    await seedMessages(store, owner, [userMessage('ask', 'u-0')]);

    const result = await getJson({ port: app.port, path: '/api/agents/general/chat/usg-1/usage' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      inputTokens: 113,
      outputTokens: 49,
      totalTokens: 162,
      models: [
        { modelId: MODEL_USAGE_UNATTRIBUTED, inputTokens: 3, outputTokens: 4, totalTokens: 7, messages: 1 },
        { modelId: DEFAULT_MODEL, inputTokens: 100, outputTokens: 40, totalTokens: 140, messages: 1 },
        { modelId: OTHER_MODEL, inputTokens: 10, outputTokens: 5, totalTokens: 15, messages: 1 },
      ],
      estimatedCostUsd: null,
      costReason: 'pricing_not_configured',
    });

    // Cross-owner SAME chat id: empty transcript for the foreign owner.
    const foreign = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }), auth: { staticOwner: TEST_OWNER_B } });
    try {
      const foreignUsage = await getJson({ port: foreign.port, path: '/api/agents/general/chat/usg-1/usage' });
      assert.equal(foreignUsage.status, 200);
      assert.deepEqual((foreignUsage.body as { inputTokens: unknown }).inputTokens, 0);
    } finally {
      await foreign.close();
    }
  } finally {
    await app.close();
  }
});

test('usage cost: only with explicit pricing for EVERY used model; partial stays null', () => {
  const pricing: Record<string, ModelPricing> = { [DEFAULT_MODEL]: { input: 1, output: 2 } };
  const stored = [
    {
      id: 'a-1',
      role: 'assistant',
      metadata: { modelId: DEFAULT_MODEL, usage: { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 } },
    },
    {
      id: 'a-2',
      role: 'assistant',
      metadata: { modelId: DEFAULT_MODEL, usage: { inputTokens: 200_000, outputTokens: 100_000, totalTokens: 300_000 } },
    },
    {
      id: 'a-3',
      role: 'assistant',
      metadata: { modelId: OTHER_MODEL, usage: { inputTokens: 1_000, outputTokens: 1, totalTokens: 1_001 } },
    },
    { id: 'a-4', role: 'assistant', metadata: { usage: 'garbage' } },
  ];
  const partial = summarizeChatUsage(stored, pricing);
  assert.equal(partial.costReason, 'partial');
  assert.equal(partial.estimatedCostUsd, null, 'OTHER_MODEL lacks rates → NO cost, never partially priced');

  const fullPricing: Record<string, ModelPricing> = {
    ...pricing,
    [OTHER_MODEL]: { input: 0.5, output: 0.5 },
  };
  const priced = summarizeChatUsage(stored, fullPricing);
  assert.equal(priced.costReason, 'priced');
  assert.equal(
    priced.estimatedCostUsd,
    2.4005,
    'per-million rates applied exactly (6-decimal rounding; the 1-token output term is below the rounding precision)',
  );

  const unattributed = summarizeChatUsage(
    [{ id: 'a-x', role: 'assistant', metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } }],
    fullPricing,
  );
  assert.equal(unattributed.models.length, 1);
  assert.equal(unattributed.models[0]?.modelId, MODEL_USAGE_UNATTRIBUTED);
  assert.equal(unattributed.costReason, 'partial', 'the unattributed bucket is unpriceable by contract');
});

test('usage route with configured pricing: estimatedCostUsd computed via OLLAMA_MODEL_PRICING_JSON', async () => {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const app = await startTestApp({
    store,
    model: createMockModel({ steps: [textStep()] }),
    modelPricingJson: JSON.stringify({ [DEFAULT_MODEL]: { input: 2, output: 4 } }),
  });
  try {
    const owner = { ownerId: TEST_OWNER.userId, slug: 'general', chatId: 'usg-p' } as ChatRef;
    await store.appendMessage(owner, {
      id: 'a-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'x' }],
      metadata: { modelId: DEFAULT_MODEL, usage: { inputTokens: 1_000_000, outputTokens: 250_000, totalTokens: 1_250_000 } },
    } as never);
    await seedMessages(store, owner, [userMessage('ask', 'u-0')]);
    const result = await getJson({ port: app.port, path: '/api/agents/general/chat/usg-p/usage' });
    assert.equal(result.status, 200);
    assert.equal((result.body as { estimatedCostUsd: number | null }).estimatedCostUsd, 3);
    assert.equal((result.body as { costReason: string }).costReason, 'priced');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Delegation child inherits the parent chat model
// ---------------------------------------------------------------------------

test('delegation child inherits the parent chat selected model (offline, same-REST run)', async () => {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const models = modelsComposition(createMockModel({ steps: [textStep(), textStep()] }));
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }), models, agents: {} });
  try {
    const parentChat = 'dl-parent';
    await seedMessages(store, { ownerId: TEST_OWNER.userId, slug: 'orchestrator', chatId: parentChat }, [userMessage('please summarize', 'pm-1')]);
    const put = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/chat/${parentChat}/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: OTHER_MODEL }),
    });
    assert.equal(put.status, 200);

    const signer = createDelegationContextSigner(Buffer.from(TEST_DELEGATION_SECRET, 'utf8'));
    const header = signer.sign({
      kind: 'delegation-create',
      parentChatId: parentChat,
      parentDepth: 0,
      ownerId: TEST_OWNER.userId,
      expiresAt: Date.now() + 120_000,
    });
    const created = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/delegations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [DELEGATION_CONTEXT_HEADER]: header,
      },
      body: JSON.stringify({ parentChatId: parentChat, parentMessageId: 'pm-1', target: 'researcher', task: 'Summarize the notes.', mode: 'sync' }),
    });
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const delegation = (await created.json()) as { delegation: { id: string; childChatId: string } };

    const childModel = await getJson({ port: app.port, path: `/api/agents/researcher/chat/${delegation.delegation.childChatId}/model` });
    assert.deepEqual(childModel.body, { modelId: OTHER_MODEL }, 'the child inherited the parent chat model');
  } finally {
    await app.close();
  }
});
