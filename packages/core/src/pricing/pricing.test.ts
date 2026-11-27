/**
 * Unit tests for the official pricing table + enforcement helpers: exact
 * default rates and aliases, fail-closed unknown/unpriced ids, override
 * precedence (input/output only, cached never invented), conservative cost
 * math, and the explicit-zero legitimacy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFICIAL_MODEL_RATES,
  conservativeCostUsd,
  effectiveModelPricing,
  isModelExplicitlyPriced,
  round6Usd,
} from './index.js';

test('official defaults: exact standard rates for verified table entries', () => {
  const expected: Record<string, [number, number | null, number]> = {
    'deepseek-v4-flash': [0.14, 0.028, 0.28],
    'deepseek-v4.1-flash': [0.14, 0.028, 0.28],
    'glm-5.3-flash': [0.15, 0.03, 0.5],
    'minimax-m3': [0.3, 0.06, 1.2],
    'minimax-m3.1-flash': [0.3, 0.06, 1.2],
    'glm-5.3': [1.4, 0.26, 4.4],
    'deepseek-v4-pro': [1.74, 0.29, 3.48],
    'deepseek-v4.1-pro': [1.74, 0.29, 3.48],
    'gpt-oss:20b': [0.1, 0.025, 0.5],
    'gpt-oss:120b': [0.25, 0.05, 1.0],
    'minimax-m3.1-pro': [0.6, 0.06, 2.4],
    'muse-spark': [0.8, 0.08, 2.4],
    'kimi-k2.7-code': [0.95, 0.19, 4.0],
    'kimi-k3.1-pro': [1.5, 0.15, 6.0],
    'kimi-k3': [1.5, 0.15, 6.0],
    'nemotron-3-ultra': [1.0, 0.1, 4.0],
    'qwen3.8-max': [2.0, 0.4, 6.0],
    'mimo-v2.6-pro': [2.0, 0.2, 6.0],
    'mimo-v2.6-flash': [0.5, 0.05, 1.5],
    'kimi-k2.6': [0.95, 0.19, 4.75],
    'mistral-large-4': [2.0, 0.2, 8.0],
    'nemotron-3-super': [2.0, 0.4, 8.0],
    'glm-5.2': [2.0, 0.4, 8.0],
    'qwen3.5': [0.6, 0.12, 3.6],
    'qwen3.7-max': [2.5, 0.5, 7.5],
    'gemma4:31b': [0.5, 0.1, 2.0],
    'gemma4:26b': [0.5, 0.1, 2.0],
  };
  for (const [id, [input, cachedInput, output]] of Object.entries(expected)) {
    assert.deepEqual(OFFICIAL_MODEL_RATES[id], { input, cachedInput, output }, id);
  }
});

test('exact aliases resolve to identical rates: deepseek-v4.1-flash:1017 and deepseek-v4-pro:0813', () => {
  assert.deepEqual(OFFICIAL_MODEL_RATES['deepseek-v4.1-flash:1017'], OFFICIAL_MODEL_RATES['deepseek-v4.1-flash']);
  assert.deepEqual(OFFICIAL_MODEL_RATES['deepseek-v4-pro:0813'], OFFICIAL_MODEL_RATES['deepseek-v4-pro']);
  // EXACT alias mapping only — close-but-different ids stay unpriced.
  assert.equal(isModelExplicitlyPriced(null, 'deepseek-v4.1-flash:1018'), false);
  assert.equal(isModelExplicitlyPriced(null, 'deepseek-v4-pro:813'), false);
});

test('fail-closed: unknown/unpriced ids resolve null (never invented rates)', () => {
  for (const unpriced of ['inkling-2-small', 'hy4', 'beam', 'muse-spark-open', 'clef:27b', 'muse-spark:1', 'GLM-5.3-flash', '']) {
    assert.equal(effectiveModelPricing(null, unpriced), null, unpriced);
    assert.equal(isModelExplicitlyPriced(null, unpriced), false, unpriced);
  }
});

test('override precedence: exact-id override wins; cached input stays unknown (never invented)', () => {
  const override = { 'glm-5.3-flash': { input: 1, output: 2 } };
  assert.deepEqual(effectiveModelPricing(override, 'glm-5.3-flash'), { input: 1, cachedInput: null, output: 2 });
  // Non-overridden ids fall back to the official table.
  assert.deepEqual(effectiveModelPricing(override, 'gpt-oss:20b'), { input: 0.1, cachedInput: 0.025, output: 0.5 });
  // An override WITHOUT input/output bounds (invalid) fails closed.
  assert.equal(isModelExplicitlyPriced({ bad: { input: -1, output: 1 } as never }, 'bad'), false);
  assert.equal(isModelExplicitlyPriced({ bad: { input: Number.NaN, output: 1 } as never }, 'bad'), false);
});

test('explicit zero override is a legitimate priced model (never $0 default confusion)', () => {
  const override = { 'glm-5.3-flash': { input: 0, output: 0 } };
  assert.equal(isModelExplicitlyPriced(override, 'glm-5.3-flash'), true);
  assert.deepEqual(effectiveModelPricing(override, 'glm-5.3-flash'), { input: 0, cachedInput: null, output: 0 });
});

test('conservative cost: standard input/output only; cachedInput never used in enforcement', () => {
  const rates = OFFICIAL_MODEL_RATES['glm-5.3-flash']!;
  // 1M input + 1M output = .15 + .50 = .65 (cached discount intentionally ignored).
  assert.equal(round6Usd(conservativeCostUsd(rates, 1_000_000, 1_000_000)), 0.65);
  assert.equal(round6Usd(conservativeCostUsd(rates, 0, 0)), 0);
  // Fractional tokens round UP (conservative): 1 input + 1 output at
  // (.15, .50)/1M → (1/(1/0.15/1e6))...: (1e-6 × .15) + (1e-6 × .50) = .65e-6.
  assert.equal(round6Usd(conservativeCostUsd(rates, 1, 1)), Math.round(0.65e-6 * 1_000_000) / 1_000_000);
  // Negative inputs clamp.
  assert.equal(conservativeCostUsd(rates, -5, 0), 0);
});

test('priced-but-locked split: kimi ids are priced yet the blocked policy stays separate', () => {
  assert.equal(isModelExplicitlyPriced(null, 'kimi-k2.7-code'), true);
  assert.equal(isModelExplicitlyPriced(null, 'kimi-k3'), true);
});
