import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextModelPercent,
  detailsModelPercentSource,
  contextPercent,
  countToolParts,
  latestAssistantUsage,
  railBucketLine,
} from '../src/lib/session-rail.js';
import {
  filterModels,
  formatModelCardLines,
  formatModelTooltipLines,
  inputModality,
  mapModelDetails,
  MODEL_FIELD_UNKNOWN,
} from '../src/lib/models.js';

const BASE_DETAILS = {
  modelId: 'glm-5.3-flash',
  contextLength: 1048576,
  capabilities: ['tools'],
  parameterSize: null,
  thinking: null,
  pricing: null,
};

test('pricing mapping: null/absent fine; complete pair accepted; partial rejected', () => {
  assert.deepEqual(mapModelDetails({ modelId: 'glm', contextLength: null, capabilities: null, parameterSize: null, thinking: null }, 'glm').ok, true);
  const withPricing = mapModelDetails(
    {
      modelId: 'glm',
      contextLength: 1000,
      capabilities: null,
      parameterSize: null,
      thinking: null,
      pricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5 },
    },
    'glm',
  );
  assert.ok(withPricing.ok);
  if (withPricing.ok) {
    assert.deepEqual(withPricing.details.pricing, { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5 });
  }
  // Partial/invalid pricing must reject the payload (documented strictness).
  assert.equal(mapModelDetails({ modelId: 'glm', pricing: { inputUsdPerMillion: 0.5 } }, 'glm').ok, false);
  assert.equal(mapModelDetails({ modelId: 'glm', pricing: { inputUsdPerMillion: -1, outputUsdPerMillion: 1 } }, 'glm').ok, false);
  assert.equal(mapModelDetails({ modelId: 'glm', pricing: 'free' }, 'glm').ok, false);
});

test('input/output modalities: text always; image only with real vision capability', () => {
  assert.equal(inputModality(null), 'text');
  assert.equal(inputModality({ ...BASE_DETAILS, capabilities: null }), 'text');
  assert.equal(inputModality({ ...BASE_DETAILS, capabilities: ['vision'] }), 'text, image');
  assert.equal(inputModality({ ...BASE_DETAILS, capabilities: ['vision', 'tools'] }), 'text, image');
});

test('model card lines: provider, modalities, unknowns → Not reported, cost lines', () => {
  const lines = formatModelCardLines({
    details: {
      modelId: 'glm-5.3-flash',
      contextLength: 1048576,
      capabilities: ['vision', 'tools'],
      parameterSize: null,
      thinking: true,
      pricing: null,
    },
    name: 'GLM 5.3 Flash',
  });
  assert.equal(lines.provider, 'Ollama Cloud');
  assert.equal(lines.input, 'Input: text, image');
  assert.equal(lines.output, 'Output: text');
  assert.equal(lines.contextLength, 'Context length: 1,048,576');
  assert.equal(lines.parameterSize, `Parameter size: ${MODEL_FIELD_UNKNOWN}`);
  assert.equal(lines.pricing, 'Cost ($/1M tokens): Not configured');
  assert.equal(lines.thinking, 'Thinking: yes');

  const priced = formatModelCardLines({
    details: {
      modelId: 'glm-5.3-flash',
      contextLength: 1000,
      capabilities: [],
      parameterSize: '32b',
      thinking: false,
      pricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5 },
    },
    name: 'GLM 5.3 Flash',
  });
  assert.equal(priced.pricing, 'Cost ($/1M tokens): $0.5 input / $1.5 output');
  assert.equal(priced.thinking, 'Thinking: no');
  assert.equal(priced.lockReason, null);
});

test('picker filter: case-insensitive over name + id; empty query returns all', () => {
  const models = [
    { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', modifiedAt: null, capabilities: [], parameterSize: null, locked: false, lockReason: null },
    { id: 'kimi-k2', name: 'Kimi K2', modifiedAt: null, capabilities: [], parameterSize: null, locked: true, lockReason: 'locked' },
  ];
  assert.deepEqual(
    filterModels(models, '').map((m: { id: string }) => m.id),
    ['glm-5.3-flash', 'kimi-k2'],
  );
  assert.deepEqual(filterModels(models, 'kimi').map((m: { id: string }) => m.id), ['kimi-k2']);
  assert.deepEqual(filterModels(models, 'FLASH').map((m: { id: string }) => m.id), ['glm-5.3-flash']);
  assert.deepEqual(filterModels(models, 'zzz'), []);
});

test('context percent: latest-request tokens over real context; bounded and unknown', () => {
  assert.equal(contextPercent(0, 1000), 0);
  assert.equal(contextPercent(500, 1000), 50);
  assert.equal(contextPercent(1050, 1000), 100);
  assert.equal(contextPercent(1.2, 1000), null);
  assert.equal(contextPercent(-5, 1000), null);
  assert.equal(contextPercent(10, 0), null);
  assert.equal(contextPercent(10, null), null);
  assert.equal(contextPercent(null, 1000), null);
});

test('per-message helpers: latest assistant usage + real tool counts', () => {
  const userNoMeta = { role: 'user', parts: [] };
  const assistantWithUsage = {
    role: 'assistant',
    parts: [
      { type: 'text', text: 'hi' },
      { type: 'tool-calculate', state: 'output-available' },
      { type: 'tool-query_data', state: 'output-available' },
      { type: 'tool-ask_user', state: 'input-available' }, // HITL question: not a tool call
      { junk: true },
    ],
  };
  const withUsageMeta = (m: { role: string }): unknown => ({
    role: m.role,
    parts: [{ type: 'text', text: 'x' }],
    metadata: { usage: { inputTokens: 581, outputTokens: 76, totalTokens: 657 }, modelId: 'glm-5.3-flash' },
  });

  const messages = [userNoMeta, withUsageMeta({ role: 'assistant' } as never), assistantWithUsage, userNoMeta];
  // Latest assistant is assistantWithUsage WITHOUT metadata → usage null.
  assert.equal(latestAssistantUsage(messages as never), null);
  assert.equal(countToolParts(assistantWithUsage.parts as never), 2);
  assert.equal(countToolParts([]), 0);

  const metaOnly = [{}];
  const usage = latestAssistantUsage(metaMessages(metaOnly));
  assert.deepEqual(usage, {
    inputTokens: 581,
    outputTokens: 76,
    totalTokens: 657,
    modelId: 'glm-5.3-flash',
  });
  // Context % from real pair.
  assert.equal(contextPercent(581, 1048576), 0);
  assert.equal(contextPercent(581_000, 1_048_576), 55);
});

function metaMessages(rows: Array<Record<string, string>>): Array<{ role: string; parts: ReadonlyArray<unknown>; metadata?: unknown }> {
  return rows.map((row, i) => ({
    role: 'assistant',
    parts: [{ type: 'text', text: 'x' }],
    metadata:
      i === 0
        ? { usage: { inputTokens: 581, outputTokens: 76, totalTokens: 657 }, modelId: 'glm-5.3-flash' }
        : undefined,
  }));
}

test('context metric never mixes models: validated source + wrapper', () => {
  assert.deepEqual(
    detailsModelPercentSource({ modelId: 'm1', contextLength: 1000 }, 'm1'),
    { contextLength: 1000, modelId: 'm1' },
  );
  assert.equal(detailsModelPercentSource({ modelId: 'other', contextLength: 9 }, 'm1'), null);
  assert.equal(detailsModelPercentSource(undefined, 'm1'), null);
  assert.equal(detailsModelPercentSource({ modelId: 'm1', contextLength: 1000 }, null), null);
  // Wrapper: never mixes models — validated source only.
  assert.equal(contextModelPercent({ inputTokens: 50 }, { contextLength: 1000 }), 5);
  assert.equal(contextModelPercent({ inputTokens: 50 }, null), null);
  assert.equal(contextModelPercent(null, { contextLength: 1000 }), null);

  const bucket = { modelId: '(unattributed)', inputTokens: 434, outputTokens: 167, totalTokens: 601, messages: 1 };
  assert.equal(railBucketLine(bucket), 'unattributed — 434 in / 167 out');
  const normal = { modelId: 'glm-5.3-flash', inputTokens: 800, outputTokens: 400, totalTokens: 1200, messages: 2 };
  assert.equal(railBucketLine(normal), 'glm-5.3-flash — 800 in / 400 out');
});

test('model tooltip: exactly the five fields, honest cost fallback', () => {
  const empty = formatModelTooltipLines(null);
  assert.equal(empty.capabilities, 'Not reported');
  assert.equal(empty.input, 'text');
  assert.equal(empty.output, 'text');
  assert.equal(empty.cost, 'Not configured');

  const real = mapModelDetails(
    {
      modelId: 'glm-5.3-flash',
      contextLength: 1048576,
      capabilities: ['vision', 'tools'],
      parameterSize: null,
      thinking: true,
      pricing: { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.4 },
    },
    'glm-5.3-flash',
  );
  assert.ok(real.ok);
  if (!real.ok) return;
  const lines = formatModelTooltipLines(real.details);
  assert.equal(lines.capabilities, 'vision, tools');
  assert.equal(lines.input, 'text, image');
  assert.equal(lines.output, 'text');
  assert.equal(lines.cost, '$0.6 in / $2.4 out per 1M tokens');
});
