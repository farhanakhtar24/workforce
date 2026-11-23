/**
 * REAL local embedding smoke — NOT part of the offline/Redis integration
 * suites. Uses the REAL `createLocalEmbeddingProvider` (Transformers.js,
 * `Xenova/all-MiniLM-L6-v2`, 384 dims) against a PROJECT-LOCAL gitignored
 * cache directory. No mocks, no API key, no Ollama.
 *
 * First run downloads the model from HuggingFace into
 * `apps/api/.cache/workforce-models` (allowed; the cache is NEVER deleted
 * afterwards — later runs load from disk only).
 *
 * Run: `npm run test:embedding --workspace @workforce/api`
 *
 * Deliberately SEPARATE from `npm test` and `test:integration`: the offline
 * and Redis suites never import this file and never need the model.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_EMBEDDING_MODEL } from '@workforce/core/memory';
import { createLocalEmbeddingProvider, type LocalEmbeddingProvider } from '../src/memory/embedding.js';

// Project-local model cache: apps/api/.cache/workforce-models (gitignored).
const CACHE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.cache',
  'workforce-models',
);

/** Cosine similarity for already-normalized vectors; plain finite math. */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot; // both vectors are unit-norm
}

// Provider construction is side-effect-free; the model loads on first embed.
const provider: LocalEmbeddingProvider = createLocalEmbeddingProvider({ cacheDir: CACHE_DIR });

/** Small memo so later tests reuse already-computed vectors. */
const vectors = new Map<string, readonly number[]>();

async function embedCached(text: string): Promise<readonly number[]> {
  const cached = vectors.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const vector = await provider.embed(text);
  vectors.set(text, vector);
  return vector;
}

before(async () => {
  assert.equal(provider.dimensions, 384);
  assert.equal(provider.model, MEMORY_EMBEDDING_MODEL);
});

test('local embedding provider loads the MiniLM model (first run downloads to the project cache)', { timeout: 600_000 }, async () => {
  const vector = await provider.embed('the database migration completed successfully');
  assert.equal(vector.length, 384);
});

test('embed returns exactly 384 finite numbers', { timeout: 300_000 }, async () => {
  const vector = await embedCached('the database migration completed successfully');
  assert.equal(vector.length, 384);
  for (const value of vector) {
    assert.ok(Number.isFinite(value), 'vector values must be finite');
  }
});

test('embedded vectors are L2-normalized (norm ≈ 1)', { timeout: 120_000 }, async () => {
  const vector = await embedCached('the database migration completed successfully');
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit norm, got ${String(norm)}`);
});

test('same input is deterministic (byte-for-byte stable vector)', { timeout: 300_000 }, async () => {
  const first = await embedCached('deterministic embedding smoke test input');
  const second = await provider.embed('deterministic embedding smoke test input');
  assert.equal(first.length, second.length);
  for (let i = 0; i < first.length; i += 1) {
    assert.equal(first[i], second[i], `vector drifted at index ${String(i)}`);
  }
});

test('relevance: related sentences score clearly above unrelated ones', { timeout: 300_000 }, async () => {
  const migration = await embedCached('the database migration completed successfully');
  const related = await embedCached('database schema migration finished with no errors');
  const wildlife = await embedCached('zebra jungle wildlife photography equipment');

  const relatedScore = cosine(migration, related);
  const unrelatedScore = cosine(migration, wildlife);
  assert.ok(relatedScore > 0.3, `related pair should score high, got ${String(relatedScore)}`);
  assert.ok(
    relatedScore - unrelatedScore > 0.15,
    `related must clearly outrank unrelated: ${String(relatedScore)} vs ${String(unrelatedScore)}`,
  );

  // Semantic (not just lexical) check: distinct wordings of the same idea stay
  // clearly above random text without sharing keywords.
  const synonym = await embedCached('the schema upgrade finished without problems');
  const synonymScore = cosine(migration, synonym);
  assert.ok(
    synonymScore - unrelatedScore > 0.1,
    `synonym phrasing should outrank unrelated text: ${String(synonymScore)} vs ${String(unrelatedScore)}`,
  );
});
