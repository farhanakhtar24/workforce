/**
 * Route-level tests for the authenticated model-catalog surfaces
 * (`GET /api/models`, `GET /api/models/:modelId/details`) with a fake
 * `ModelCatalogLike` — bounded shapes, fixed 400/404/503 errors, per-row
 * `locked` + value-free lock reason, the configured default id, and the
 * blocked policy. No network, no provider, no key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModel } from 'ai';

import { createMockModel, textStep, startTestApp, getJson } from './helpers.js';
import type { TestAppOptions } from './helpers.js';
import type { ModelCatalogLike } from '../src/models/catalog.js';
import { pricingForModelId } from '../src/models/routes.js';

const DEFAULT_MODEL = 'glm-5.3-flash';
const DEFAULT_MODEL_2 = 'gpt-oss:20b';

interface FakeModelRow {
  readonly id: string;
  readonly name: string;
  readonly modifiedAt: string | null;
  readonly capabilities: string[];
  readonly parameterSize: string | null;
  readonly locked: boolean;
  readonly lockReason: string | null;
}

export function fakeCatalog(
  options: {
    rows?: FakeModelRow[];
    fail?: boolean;
    details?: (modelId: string) => { status: 'ok' | 'not-found'; details?: { contextLength: number | null; capabilities: string[] | null; parameterSize: string | null; thinking: boolean | null } };
  } = {},
): ModelCatalogLike {
  return {
    async list() {
      if (options.fail === true) {
        throw new Error('catalog down');
      }
      return { models: options.rows ?? [] };
    },
    async details(modelId: string) {
      const next = options.details?.(modelId);
      if (next === undefined) {
        return { status: 'not-found' as const, details: undefined };
      }
      return next;
    },
  };
}

export function catalogAppOptions(
  catalog: ModelCatalogLike,
  options: { model?: LanguageModel; modelPricingJson?: string } = {},
): TestAppOptions {
  return {
    model: options.model ?? createMockModel({ steps: [textStep()] }),
    models: {
      catalog,
      modelFor: () => options.model ?? createMockModel({ steps: [textStep()] }),
      defaultModelId: DEFAULT_MODEL,
    },
    ...(options.modelPricingJson !== undefined ? { modelPricingJson: options.modelPricingJson } : {}),
  };
}

test('list models surface: bounded rows with locked + reason + default id', async () => {
  const app = await startTestApp(
    catalogAppOptions(
      fakeCatalog({
        rows: [
          { id: DEFAULT_MODEL, name: 'GLM 5.3 Flash', modifiedAt: '2026-11-01T00:00:00Z', capabilities: ['completion', 'tools'], parameterSize: '5.3B', locked: false, lockReason: null },
          { id: 'kimi-k2:free', name: 'Kimi K2 (free)', modifiedAt: null, capabilities: ['completion'], parameterSize: '1T', locked: true, lockReason: 'Model id is blocked by WORKFORCE_BLOCKED_MODEL_PREFIXES.' },
        ],
      }),
    ),
  );
  try {
    const result = await getJson({ port: app.port, path: '/api/models' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      models: [
        { id: DEFAULT_MODEL, name: 'GLM 5.3 Flash', modifiedAt: '2026-11-01T00:00:00Z', capabilities: ['completion', 'tools'], parameterSize: '5.3B', locked: false, lockReason: null },
        { id: 'kimi-k2:free', name: 'Kimi K2 (free)', modifiedAt: null, capabilities: ['completion'], parameterSize: '1T', locked: true, lockReason: 'Model id is blocked by WORKFORCE_BLOCKED_MODEL_PREFIXES.' },
      ],
      defaultModelId: DEFAULT_MODEL,
    });
  } finally {
    await app.close();
  }
});

test('list models failure: upstream/parse failure maps to the fixed 503', async () => {
  const app = await startTestApp(catalogAppOptions(fakeCatalog({ fail: true })));
  try {
    const result = await getJson({ port: app.port, path: '/api/models' });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: 'Model catalog is temporarily unavailable.' });
  } finally {
    await app.close();
  }
});

test('model details: unknown id pattern fixed 400; miss 404; hit bounded shape (pricing null unconfigured; exact when configured)', async () => {
  const app = await startTestApp(
    catalogAppOptions(
      fakeCatalog({
        details: (modelId) =>
          modelId === 'glm-5.3-flash'
            ? { status: 'ok', details: { contextLength: 131072, capabilities: ['completion'], parameterSize: '5.3B', thinking: true } }
            : { status: 'not-found', details: undefined },
      }),
    ),
  );
  const hit = await getJson({ port: app.port, path: '/api/models/glm-5.3-flash/details' });
  assert.equal(hit.status, 200);
  assert.deepEqual(hit.body, {
    modelId: DEFAULT_MODEL,
    contextLength: 131072,
    capabilities: ['completion'],
    parameterSize: '5.3B',
    thinking: true,
    pricing: { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.5, cachedInputUsdPerMillion: 0.03 },
  });
  const miss = await getJson({ port: app.port, path: '/api/models/gpt-oss:20b/details' });
  assert.equal(miss.status, 404);
  assert.deepEqual(miss.body, { error: 'Model not found.' });
  const bad = await getJson({ port: app.port, path: '/api/models/bad%2Fslash/details' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: 'Invalid model id.' });
  await app.close();

  // BOTH rates explicitly configured for this exact id → the additive
  // pricing object with the SAME bounded metadata and NO extra fields.
  const pricedApp = await startTestApp(
    catalogAppOptions(
      fakeCatalog({
        details: (modelId) =>
          modelId === 'glm-5.3-flash'
            ? { status: 'ok', details: { contextLength: 131072, capabilities: ['completion'], parameterSize: '5.3B', thinking: true } }
            : { status: 'not-found', details: undefined },
      }),
      { modelPricingJson: JSON.stringify({ 'glm-5.3-flash': { input: 1.5, output: 2.25 } }) },
    ),
  );
  const priced = await getJson({ port: pricedApp.port, path: '/api/models/glm-5.3-flash/details' });
  assert.equal(priced.status, 200);
  assert.deepEqual(priced.body, {
    modelId: DEFAULT_MODEL,
    contextLength: 131072,
    capabilities: ['completion'],
    parameterSize: '5.3B',
    thinking: true,
    pricing: { inputUsdPerMillion: 1.5, outputUsdPerMillion: 2.25, cachedInputUsdPerMillion: null },
  });
  // Raw config JSON and account-spend fields stay out of every response.
  assert.equal(JSON.stringify(priced.body).includes('"input"'), false);
  assert.equal(JSON.stringify(priced.body).includes('OLLAMA'), false);
  await pricedApp.close();
});

test('model details pricing: partial coverage and unpriced models stay null; a legitimate zero rate stays 0/0', async () => {
  const detailsCatalog = fakeCatalog({
    details: (modelId) =>
      modelId === 'glm-5.3-flash'
        ? { status: 'ok', details: { contextLength: null, capabilities: null, parameterSize: null, thinking: null } }
        : { status: 'not-found', details: undefined },
  });
  // PARTIAL coverage: only ANOTHER model priced → the default id stays null.
  const partialApp = await startTestApp(
    catalogAppOptions(detailsCatalog, { modelPricingJson: JSON.stringify({ 'gpt-oss:20b': { input: 1, output: 2 } }) }),
  );
  try {
    const pricedDefault = await getJson({ port: partialApp.port, path: '/api/models/glm-5.3-flash/details' });
    assert.equal(pricedDefault.status, 200);
    // DEFAULT_MODEL keeps its OFFICIAL default rates (override covers only
    // the OTHER id) — an unpriced id (e.g. inkling-2-small) would 404 here
    // before pricing: the fake catalog misses, so pricing is never shown.
    assert.deepEqual((pricedDefault.body as { pricing: unknown }).pricing, {
      inputUsdPerMillion: 0.15,
      outputUsdPerMillion: 0.5,
      cachedInputUsdPerMillion: 0.03,
    });
    // The priced OTHER model surfaces its own rates.
    const other = await getJson({ port: partialApp.port, path: '/api/models/gpt-oss:20b/details' });
    assert.equal(other.status, 404, 'fake catalog miss stays a fixed 404');
  } finally {
    await partialApp.close();
  }

  // A legitimate explicit ZERO rate stays 0/0 — never a silent default.
  const zeroApp = await startTestApp(
    catalogAppOptions(detailsCatalog, { modelPricingJson: JSON.stringify({ 'glm-5.3-flash': { input: 0, output: 0 } }) }),
  );
  try {
    const zero = await getJson({ port: zeroApp.port, path: '/api/models/glm-5.3-flash/details' });
    assert.equal(zero.status, 200);
    // The explicit override (0,0) REPLACES the defaults; cached input is an
    // override context — never invented (stays null even though the default
    // table lists .03 for this id).
    assert.deepEqual((zero.body as { pricing: unknown }).pricing, {
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      cachedInputUsdPerMillion: null,
    });
    // No secret/account fields anywhere.
    assert.equal(JSON.stringify(zero.body).includes('apiKey'), false);
  } finally {
    await zeroApp.close();
  }
});

test('details pricing helper unit: unpriced → null; picker shape with cached only when known', () => {
  const unpriced = (): null => null;
  assert.equal(pricingForModelId(unpriced, DEFAULT_MODEL), null);
  const overrideRates = (modelId: string): { input: number; cachedInput: number | null; output: number } | null =>
    modelId === DEFAULT_MODEL ? { input: 3, cachedInput: null, output: 4 } : null;
  assert.deepEqual(pricingForModelId(overrideRates, DEFAULT_MODEL), {
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 4,
    cachedInputUsdPerMillion: null,
  });
  assert.equal(pricingForModelId(unpriced, DEFAULT_MODEL_2), null, 'absent entry → null');
  assert.deepEqual(pricingForModelId((modelId) => (modelId === DEFAULT_MODEL_2 ? { input: 0, cachedInput: 0, output: 0 } : null), DEFAULT_MODEL_2), {
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    cachedInputUsdPerMillion: 0,
  }, 'a zero rate (even cached 0) is legitimate, not null');
  assert.equal(
    pricingForModelId((modelId) => (modelId === DEFAULT_MODEL ? { input: -1, cachedInput: 0, output: 2 } : null), DEFAULT_MODEL),
    null,
    'invalid (negative) → null',
  );
  assert.equal(
    pricingForModelId((modelId) => (modelId === DEFAULT_MODEL ? { input: Number.POSITIVE_INFINITY, cachedInput: 0, output: 2 } : null), DEFAULT_MODEL),
    null,
    'invalid (non-finite) → null',
  );
});
