/**
 * Unit tests for `summarizeChatUsage` (pure): exact token sums with bounded
 * integers, the total=input+output fallback, per-model buckets keyed by
 * `metadata.modelId` (else `(unattributed)`), invalid usage entries skipped,
 * and the cost contract: `priced` | `pricing_not_configured` | `partial`,
 * 6-decimal rounding, cost only when EVERY used model is priced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_USAGE_UNATTRIBUTED, summarizeChatUsage } from '../src/usage/usage.js';
import type { ModelPricing } from '../src/usage/usage.js';

function assistant(modelId: string | undefined, usage: unknown): { id: string; role: string; metadata: Record<string, unknown> } {
  return { id: `a-${modelId ?? 'none'}-${JSON.stringify(usage)}`, role: 'assistant', metadata: { ...(modelId !== undefined ? { modelId } : {}), usage } as Record<string, unknown> };
}

test('sums: bounded ints, total fallback to input+output, invalid entries skipped', () => {
  const stored = [
    assistant('m-a', { inputTokens: 100, outputTokens: 40, totalTokens: 140 }),
    assistant('m-b', { inputTokens: 10, outputTokens: 5 }), // no total
    assistant(undefined, { inputTokens: 3, outputTokens: 4, totalTokens: 7 }), // unattributed
    assistant('m-a', 'garbage'), // invalid usage skipped
    // Every field out of bounds EXCEPT a valid zero → counts with honest 0s.
    assistant('m-a', { inputTokens: 2_147_483_648, outputTokens: 0, totalTokens: 2_147_483_648 }),
    // Non-assistant roles never counted.
    { id: 'u1', role: 'user', metadata: { usage: { inputTokens: 99, outputTokens: 99, totalTokens: 99 } } },
    { id: 'e', role: 'assistant', metadata: { modelId: 'm-a' } }, // no usage
  ];
  const summary = summarizeChatUsage(stored, null);
  assert.deepEqual(summary, {
    inputTokens: 113,
    outputTokens: 49,
    totalTokens: 162,
    models: [
      { modelId: MODEL_USAGE_UNATTRIBUTED, inputTokens: 3, outputTokens: 4, totalTokens: 7, messages: 1 },
      { modelId: 'm-a', inputTokens: 100, outputTokens: 40, totalTokens: 140, messages: 2 },
      { modelId: 'm-b', inputTokens: 10, outputTokens: 5, totalTokens: 15, messages: 1 },
    ],
    estimatedCostUsd: null,
    costReason: 'pricing_not_configured',
  });
});

test('buckets grouped across many messages; sorted by modelId for a stable shape', () => {
  const stored = [
    assistant('m-b', { inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    assistant('m-a', { inputTokens: 2, outputTokens: 2, totalTokens: 4 }),
    assistant('m-b', { inputTokens: 3, outputTokens: 3, totalTokens: 6 }),
  ];
  const summary = summarizeChatUsage(stored, null);
  assert.deepEqual(summary.models, [
    { modelId: 'm-a', inputTokens: 2, outputTokens: 2, totalTokens: 4, messages: 1 },
    { modelId: 'm-b', inputTokens: 4, outputTokens: 4, totalTokens: 8, messages: 2 },
  ]);
});

test('cost: pricing_not_configured / partial / priced with 6-decimal rounding', () => {
  const messages = [assistant('m-a', { inputTokens: 1_500_000, outputTokens: 500_000, totalTokens: 2_000_000 })];
  const pricingNotConfigured = summarizeChatUsage(messages, null);
  assert.deepEqual(
    { cost: pricingNotConfigured.estimatedCostUsd, reason: pricingNotConfigured.costReason },
    { cost: null, reason: 'pricing_not_configured' },
  );

  const ratesA: Record<string, ModelPricing> = { 'm-a': { input: 2, output: 4 } };
  const priced = summarizeChatUsage(messages, ratesA);
  assert.equal(priced.costReason, 'priced');
  // (1.5M × $2 + 0.5M × $4)/1M = $5 exactly; carries 6 decimals.
  assert.equal(priced.estimatedCostUsd, 5);

  const partial = summarizeChatUsage([...messages, assistant('m-b', { inputTokens: 10, outputTokens: 10, totalTokens: 20 })], ratesA);
  assert.deepEqual({ cost: partial.estimatedCostUsd, reason: partial.costReason }, { cost: null, reason: 'partial' });

  const fractional = summarizeChatUsage([assistant('f', { inputTokens: 1, outputTokens: 1, totalTokens: 2 })], { f: { input: 0.111, output: 0.05 } });
  assert.equal(fractional.estimatedCostUsd, Math.round((0.111 + 0.05) / 1_000_000 * 1_000_000) / 1_000_000);
});

test('cost: modelId in metadata not matching the id pattern buckets unattributed', () => {
  const summary = summarizeChatUsage([assistant('bad/id', { inputTokens: 1, outputTokens: 1, totalTokens: 2 })], null);
  assert.equal(summary.models[0]?.modelId, MODEL_USAGE_UNATTRIBUTED);
});
