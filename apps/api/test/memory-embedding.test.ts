/**
 * Unit tests for the local embedding provider — all through the injected
 * `loadModule` seam (no model, no network, no ONNX runtime). Proves:
 * cache forwarding (`cache_dir` + `env.cacheDir`), q8/cpu + mean/normalize
 * options, exactly-384 output for both tensor shapes, singleton reuse, and
 * retry-after-failure for BOTH the module import and the pipeline
 * construction — without a process restart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_EMBEDDING_MODEL } from '@workforce/core/memory';
import {
  createLocalEmbeddingProvider,
  type TransformersModuleLike,
} from '../src/memory/embedding.js';

const CACHE_DIR = '/abs/.cache/workforce-models';

interface Captured {
  pipelineKind: string;
  pipelineModel: string;
  pipelineOptions: Record<string, unknown>;
  embedCalls: Array<{ text: string; options: { pooling: string; normalize: boolean } }>;
}

function fakeModule(overrides?: {
  pipelineThrows?: Error;
  tensorShape?: 'tolist' | 'flatData';
}): TransformersModuleLike & { captured: Captured } {
  const captured: Captured = {
    pipelineKind: '',
    pipelineModel: '',
    pipelineOptions: {},
    embedCalls: [],
  };
  const vector = new Array<number>(384).fill(0);
  for (let i = 0; i < 384; i += 1) {
    vector[i] = i / 384;
  }
  const tensor =
    overrides?.tensorShape === 'flatData'
      ? { data: new Float32Array(vector) }
      : { tolist: () => [vector] };
  return {
    captured,
    env: {},
    pipeline: async (kind, model, options) => {
      captured.pipelineKind = kind;
      captured.pipelineModel = model;
      captured.pipelineOptions = options as Record<string, unknown>;
      if (overrides?.pipelineThrows !== undefined) {
        throw overrides.pipelineThrows;
      }
      return async (text: string, embedOptions: { pooling: string; normalize: boolean }) => {
        captured.embedCalls.push({ text, options: embedOptions });
        return tensor;
      };
    },
  };
}

test('embed forwards cache_dir and env.cacheDir, requests q8/cpu pipeline exactly once', async () => {
  const mod = fakeModule();
  let loadCount = 0;
  const provider = createLocalEmbeddingProvider({
    cacheDir: CACHE_DIR,
    loadModule: async () => {
      loadCount += 1;
      return mod;
    },
  });
  await provider.embed('hello');
  assert.equal(loadCount, 1);
  assert.equal(mod.captured.pipelineKind, 'feature-extraction');
  assert.equal(mod.captured.pipelineModel, 'Xenova/all-MiniLM-L6-v2');
  assert.equal(mod.env?.cacheDir, CACHE_DIR);
  assert.equal(mod.captured.pipelineOptions.cache_dir, CACHE_DIR);
  assert.deepEqual(mod.captured.pipelineOptions.dtype, 'q8');
  assert.deepEqual(mod.captured.pipelineOptions.device, 'cpu');
  assert.equal((mod.captured.pipelineOptions.env as { cacheDir: string }).cacheDir, CACHE_DIR);
  // Singleton: second embed reuses the loaded module.
  await provider.embed('again');
  assert.equal(loadCount, 1);
});

test('extractor calls mean pooling with normalization for a single string', async () => {
  const mod = fakeModule();
  const provider = createLocalEmbeddingProvider({ cacheDir: CACHE_DIR, loadModule: async () => mod });
  await provider.embed('single string');
  assert.equal(mod.captured.embedCalls.length, 1);
  assert.deepEqual(mod.captured.embedCalls[0]?.options, { pooling: 'mean', normalize: true });
});

test('embed returns exactly 384 finite numbers (nested tolist tensor)', async () => {
  const provider = createLocalEmbeddingProvider({
    cacheDir: CACHE_DIR,
    loadModule: async () => fakeModule(),
  });
  const vector = await provider.embed('hello');
  assert.equal(vector.length, 384);
  assert.equal(provider.dimensions, 384);
  assert.equal(provider.model, MEMORY_EMBEDDING_MODEL);
  for (const value of vector) {
    assert.equal(typeof value, 'number');
    assert.ok(Number.isFinite(value));
  }
});

test('embed returns exactly 384 finite numbers (flat data tensor)', async () => {
  const provider = createLocalEmbeddingProvider({
    cacheDir: CACHE_DIR,
    loadModule: async () => fakeModule({ tensorShape: 'flatData' }),
  });
  const vector = await provider.embed('hello');
  assert.equal(vector.length, 384);
  assert.ok(Number.isFinite(vector[0] ?? NaN));
});

test('module import rejection resets the singleton: second embed succeeds without restart', async () => {
  const mod = fakeModule();
  let attempt = 0;
  const provider = createLocalEmbeddingProvider({
    cacheDir: CACHE_DIR,
    loadModule: async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('transient import failure');
      }
      return mod;
    },
  });
  await assert.rejects(() => provider.embed('first'), /transient import failure/);
  const vector = await provider.embed('second');
  assert.equal(vector.length, 384);
  assert.equal(attempt, 2);
  assert.equal(mod.captured.pipelineModel, 'Xenova/all-MiniLM-L6-v2');
});

test('pipeline construction rejection resets the pipeline singleton: retry succeeds', async () => {
  let loadCount = 0;
  const provider = createLocalEmbeddingProvider({
    cacheDir: CACHE_DIR,
    loadModule: async () => {
      loadCount += 1;
      const mod = fakeModule();
      const realPipeline = mod.pipeline;
      let pipelineCalls = 0;
      mod.pipeline = async (kind, model, options) => {
        pipelineCalls += 1;
        if (pipelineCalls === 1) {
          throw new Error('pipeline download failed');
        }
        return realPipeline(kind, model, options);
      };
      return mod;
    },
  });
  await assert.rejects(() => provider.embed('first'), /pipeline download failed/);
  const vector = await provider.embed('second');
  assert.equal(vector.length, 384);
  // The module itself stays cached; only the pipeline singleton resets.
  assert.equal(loadCount, 1);
});

test('preload warms the pipeline without embedding anything', async () => {
  const mod = fakeModule();
  const provider = createLocalEmbeddingProvider({ cacheDir: CACHE_DIR, loadModule: async () => mod });
  await provider.preload();
  assert.equal(mod.captured.embedCalls.length, 0);
  assert.equal(mod.captured.pipelineModel, 'Xenova/all-MiniLM-L6-v2');
});
