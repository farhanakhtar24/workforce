import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_CATALOG_UNAVAILABLE,
  MODEL_DETAILS_INVALID_ID,
  MODEL_DETAILS_NOT_FOUND,
  MODEL_FIELD_UNKNOWN,
  MODEL_SELECTION_ERROR,
  chatModelEndpoint,
  fetchModelCatalog,
  fetchModelDetails,
  modelsEndpoint,
  modelDetailsEndpoint,
  mapModelCatalog,
  mapModelDetails,
  formatModelDetailLines,
  isModelId,
} from '../src/lib/models.js';
import {
  fetchChatModel,
  putChatModel,
} from '../src/lib/models.js';
import {
  chatUsageEndpoint,
  fetchChatUsage,
  formatUsageBucket,
  formatUsageCost,
  formatUsageTotals,
  mapUsageSummary,
  usageFromMetadata,
} from '../src/lib/chat-usage.js';
import {
  mapSettings,
  settingsEndpoint,
  SETTINGS_FALLBACK_ERROR,
  PERSONAL_MEMORY_EXPLANATION,
  PERSONAL_MEMORY_SCOPE_NOTE,
} from '../src/lib/settings.js';

const BASE = 'http://localhost:3001';
const CHAT = '52790846-b7b8-4520-8def-23aacf5a96f8';
const SLUG = 'orchestrator';

function jsonFetch(status: number, body: unknown): { impl: never; body?: undefined } {
  const impl = (async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as never;
  return { impl, body: undefined };
}

test('model id contract mirrors the API pattern', () => {
  assert.equal(isModelId('glm-5.3-flash'), true);
  assert.equal(isModelId('gpt-oss:120b'), true);
  assert.equal(isModelId('kimi-k2:1t'), true);
  assert.equal(isModelId('bad id'), false);
  assert.equal(isModelId(''), false);
  assert.equal(isModelId('x'.repeat(81)), false);
  const ok = 'y'.repeat(80);
  assert.equal(isModelId(ok), true);
});

test('endpoint URLs with encoding and trailing-slash normalization', () => {
  assert.equal(modelsEndpoint(BASE), `${BASE}/api/models`);
  assert.equal(modelsEndpoint(`${BASE}/`), `${BASE}/api/models`);
  assert.equal(
    modelDetailsEndpoint(BASE, 'gpt-oss:120b'),
    `${BASE}/api/models/gpt-oss%3A120b/details`,
  );
  assert.equal(modelDetailsEndpoint(BASE, 'bad id'), null);
  assert.equal(
    chatModelEndpoint(BASE, SLUG, CHAT),
    `${BASE}/api/agents/orchestrator/chat/${CHAT}/model`,
  );
  assert.equal(chatModelEndpoint(BASE, 'bad slug', CHAT), null);
  assert.equal(chatUsageEndpoint(BASE, SLUG, CHAT), `${BASE}/api/agents/orchestrator/chat/${CHAT}/usage`);
});

test('catalog mapping: valid rows; malformed payloads fail with the fixed error', () => {
  const valid = {
    models: [
      {
        id: 'glm-5.3-flash',
        name: 'GLM 5.3 Flash',
        modifiedAt: '2026-11-20T00:00:00.000Z',
        capabilities: ['thinking', 'tools'],
        parameterSize: null,
        locked: false,
        lockReason: null,
      },
      {
        id: 'kimi-k2:1t',
        name: 'Kimi K2 1T',
        modifiedAt: null,
        capabilities: [],
        parameterSize: '32b',
        locked: true,
        lockReason: 'Model id is blocked by WORKFORCE_BLOCKED_MODEL_PREFIXES.',
      },
    ],
    defaultModelId: 'glm-5.3-flash',
  };
  const result = mapModelCatalog(valid);
  assert.ok(result.ok);
  assert.equal(result.models.length, 2);
  assert.equal(result.defaultModelId, 'glm-5.3-flash');
  assert.equal(result.models[1].locked, true);
  assert.ok(result.models[1].lockReason !== null);

  for (const payload of [
    null,
    7,
    {},
    { models: 'no' },
    { models: [null] },
    { models: [{ id: 'bad id', name: 'x', capabilities: [], locked: false }] },
    { models: [{ id: 'ok-id', name: '', capabilities: [], locked: false }] },
    { models: [{ id: 'ok-id', name: 'x', capabilities: 'no', locked: false }] },
    { models: [{ id: 'ok-id', name: 'x', capabilities: [], locked: 'true' }] },
    { models: [], defaultModelId: 'bad id' },
  ]) {
    const failed = mapModelCatalog(payload);
    assert.equal(failed.ok, false, JSON.stringify(payload));
    if (!failed.ok) assert.equal(failed.error, MODEL_CATALOG_UNAVAILABLE);
  }
});

test('catalog fetch: 503 maps to the documented safe copy', async () => {
  const { impl } = jsonFetch(503, { error: 'Model catalog is temporarily unavailable.' });
  const result = await fetchModelCatalog({ apiBaseUrl: BASE, fetchImpl: impl });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, MODEL_CATALOG_UNAVAILABLE);
    assert.equal(result.status, 503);
  }
});

test('details mapping: nulls tolerated, thinking object means true, id must match', () => {
  const full = {
    modelId: 'glm-5.3-flash',
    contextLength: 131072,
    capabilities: null,
    parameterSize: '',
    thinking: { cap: true },
    pricing: null,
  };
  const mapped = mapModelDetails(full, 'glm-5.3-flash');
  assert.ok(mapped.ok);
  if (mapped.ok) {
    assert.equal(mapped.details.contextLength, 131072);
    assert.equal(mapped.details.capabilities, null);
    assert.equal(mapped.details.parameterSize, null);
    assert.equal(mapped.details.thinking, true);
  }

  assert.equal(mapModelDetails({ modelId: 'other', contextLength: 1 }, 'glm-5.3-flash').ok, false);
  assert.equal(mapModelDetails(null, 'g').ok, false);
  assert.equal(mapModelDetails({ contextLength: 8 }, 'g').ok, false);
});

test('details fetch: 404/400 safe copies', async () => {
  const notFound = jsonFetch(404, { error: 'Model not found.' });
  const nf = await fetchModelDetails({ apiBaseUrl: BASE, modelId: 'glm-5.3-flash', fetchImpl: notFound.impl });
  assert.equal(nf.ok, false);
  if (!nf.ok) {
    assert.equal(nf.error, MODEL_DETAILS_NOT_FOUND);
    assert.equal(nf.status, 404);
  }
  const invalid = jsonFetch(400, { error: 'Invalid model id.' });
  // Client-side pattern gate fires before fetch.
  const rejected = await fetchModelDetails({ apiBaseUrl: BASE, modelId: 'bad id!', fetchImpl: invalid.impl });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error, MODEL_DETAILS_INVALID_ID);
    assert.equal(rejected.status, 400);
  }
});

test('per-chat model GET/PUT: strict mapping + fixed selection error', async () => {
  const get = jsonFetch(200, { modelId: 'glm-5.3-flash' });
  const read = await fetchChatModel({ apiBaseUrl: BASE, slug: SLUG, chatId: CHAT, fetchImpl: get.impl });
  assert.deepEqual(read, { ok: true, modelId: 'glm-5.3-flash' });

  const put = jsonFetch(200, { modelId: 'glm-5.3-flash' });
  const write = await putChatModel({ apiBaseUrl: BASE, slug: SLUG, chatId: CHAT, modelId: 'glm-5.3-flash', fetchImpl: put.impl });
  assert.deepEqual(write, { ok: true, modelId: 'glm-5.3-flash' });

  const badBody = jsonFetch(200, { modelId: 'not matching' });
  const rejected = await putChatModel({ apiBaseUrl: BASE, slug: SLUG, chatId: CHAT, modelId: 'glm-5.3-flash', fetchImpl: badBody.impl });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error, MODEL_SELECTION_ERROR);

  const unavailable = jsonFetch(400, {});
  const blocked = await putChatModel({ apiBaseUrl: BASE, slug: SLUG, chatId: CHAT, modelId: 'kimi-k2:1t', fetchImpl: unavailable.impl });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error, MODEL_SELECTION_ERROR);
});

test('details display lines: real values, Not reported fallbacks, lock reason, thinking', () => {
  const real = formatModelDetailLines({
    modelId: 'glm-5.3-flash',
    details: {
      modelId: 'glm-5.3-flash',
      contextLength: 131072,
      capabilities: ['thinking', 'tools'],
      parameterSize: null,
      thinking: true,
      pricing: null,
    },
    modifiedAt: '2026-11-20T00:00:00.000Z',
  });
  assert.equal(real.parameterSize, 'Parameter size: Not reported');
  assert.equal(real.contextLength, 'Context length: 131,072');
  assert.equal(real.capabilities, 'Capabilities: thinking, tools');
  assert.equal(real.modifiedAt, '2026-11-20T00:00:00.000Z');
  assert.equal(real.thinkingText, 'Thinking: yes');

  const unknown = formatModelDetailLines({ modelId: 'x', details: null });
  assert.equal(unknown.capabilities, `Capabilities: ${MODEL_FIELD_UNKNOWN}`);
  assert.equal(unknown.parameterSize, `Parameter size: ${MODEL_FIELD_UNKNOWN}`);
  assert.equal(unknown.contextLength, `Context length: ${MODEL_FIELD_UNKNOWN}`);
  assert.equal(unknown.modifiedAt, null);
  assert.equal(unknown.thinkingText, null);
});

test('usage mapping: totals + buckets; cost requires priced reason', () => {
  const valid = {
    inputTokens: 1234,
    outputTokens: 567,
    totalTokens: 1801,
    models: [
      {
        modelId: 'glm-5.3-flash',
        inputTokens: 800,
        outputTokens: 400,
        totalTokens: 1200,
        messages: 2,
      },
      { modelId: '(unattributed)', inputTokens: 434, outputTokens: 167, totalTokens: 601, messages: 1 },
    ],
    estimatedCostUsd: null,
    costReason: 'pricing_not_configured',
  };
  const mapped = mapUsageSummary(valid);
  assert.ok(mapped.ok);
  if (mapped.ok) {
    assert.equal(mapped.summary.totalTokens, 1801);
    assert.equal(mapped.summary.models.length, 2);
    assert.equal(mapped.summary.estimatedCostUsd, null);
  }

  assert.equal(mapUsageSummary({ inputTokens: 1, outputTokens: 2 }).ok, false);
  assert.equal(mapUsageSummary({ models: [] }).ok, false);
  assert.equal(
    mapUsageSummary({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      models: [{ modelId: 'x', inputTokens: 1, outputTokens: 1, totalTokens: 2, messages: 0 }],
      estimatedCostUsd: 0.5,
      costReason: 'pricing_not_configured',
    }).ok,
    false,
  ); // cost without 'priced' reason → reject (never show invented $)
});

test('usage endpoints + display formatting', () => {
  assert.equal(chatUsageEndpoint(BASE, 'bad/slug', CHAT), null);
  const summary = {
    inputTokens: 1234,
    outputTokens: 567,
    totalTokens: 1801,
    models: [{ modelId: '(unattributed)', inputTokens: 434, outputTokens: 167, totalTokens: 601, messages: 1 }],
    estimatedCostUsd: 0.004205,
    costReason: 'priced' as const,
  };
  assert.equal(formatUsageTotals(summary), '1,234 in / 567 out · 1,801 total');
  assert.equal(formatUsageBucket(summary.models[0]), 'unattributed messages: 434 in / 167 out');
  const cost = formatUsageCost(summary);
  assert.deepEqual(cost, { kind: 'estimated', value: 'Estimated cost: $0.0042' });
  const reasonOnly = formatUsageCost({ ...summary, estimatedCostUsd: null, costReason: 'partial' });
  assert.deepEqual(reasonOnly, { kind: 'reason', text: 'Partial pricing' });
  const none = formatUsageCost({ ...summary, estimatedCostUsd: null, costReason: 'pricing_not_configured' });
  assert.deepEqual(none, { kind: 'reason', text: 'Pricing not configured' });
});

test('usage: malformed bodies rejected at the mapping layer', () => {
  assert.equal(mapUsageSummary({ totalTokens: 1, inputTokens: 1, outputTokens: 1, models: [{ modelId: 'x', inputTokens: 0, outputTokens: 0, totalTokens: 0, messages: 'a' }] }).ok, false);
  assert.equal(mapUsageSummary({ inputTokens: 1.5, outputTokens: 1, totalTokens: 2, models: [] }).ok, false);
});

test('per-message metadata usage: strict, snake/camel tolerated, absent → null', () => {
  assert.deepEqual(
    usageFromMetadata({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, modelId: 'glm-5.3-flash' }),
    { inputTokens: 10, outputTokens: 5, totalTokens: 15, modelId: 'glm-5.3-flash' },
  );
  assert.deepEqual(usageFromMetadata({ usage: { input_tokens: 10 }, modelId: 'm' }), {
    inputTokens: 10,
    outputTokens: 0,
    totalTokens: null,
    modelId: 'm',
  });
  assert.equal(usageFromMetadata(undefined), null);
  assert.equal(usageFromMetadata(null), null);
  assert.equal(usageFromMetadata({}), null);
  assert.equal(usageFromMetadata({ usage: {} }), null);
  assert.deepEqual(usageFromMetadata({ usage: { totalTokens: 9 } }), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 9,
    modelId: null,
  });
});

test('settings mapping + endpoints + copy (REAL nested wire shape)', () => {
  assert.equal(settingsEndpoint(BASE), `${BASE}/api/settings`);
  // GET and PATCH both answer { settings: { personalMemoryEnabled } }.
  assert.deepEqual(mapSettings({ settings: { personalMemoryEnabled: true } }), {
    ok: true,
    settings: { personalMemoryEnabled: true },
  });
  assert.deepEqual(mapSettings({ settings: { personalMemoryEnabled: false } }), {
    ok: true,
    settings: { personalMemoryEnabled: false },
  });
  // Flat shape (legacy/incorrect) must FAIL safely — no production fallback.
  const flat = mapSettings({ personalMemoryEnabled: true });
  assert.equal(flat.ok, false);
  if (!flat.ok) {
    assert.equal(flat.error, SETTINGS_FALLBACK_ERROR);
    assert.equal(flat.status, 502);
  }
  // Malformed nested values fail safely too.
  for (const payload of [
    { settings: { personalMemoryEnabled: 'yes' } },
    { settings: { personalMemoryEnabled: null } },
    { settings: {} },
    { settings: null },
    { settings: 'x' },
    { settings: [] },
    null,
    'x',
    7,
    {},
  ]) {
    const result = mapSettings(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    if (!result.ok) assert.equal(result.error, SETTINGS_FALLBACK_ERROR);
  }
  assert.ok(PERSONAL_MEMORY_EXPLANATION.includes('durable observations from completed chats'));
  assert.ok(PERSONAL_MEMORY_EXPLANATION.includes('up to 3 relevant memories as untrusted context'));
  assert.ok(PERSONAL_MEMORY_EXPLANATION.includes('Off by default'));
  assert.ok(PERSONAL_MEMORY_SCOPE_NOTE.includes('nothing is imported retroactively'));
});
