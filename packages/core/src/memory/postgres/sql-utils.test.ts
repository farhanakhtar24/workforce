import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MEMORY_EMBEDDING_DIMENSIONS, MemoryEmbeddingError, SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT } from '../index.js';
import {
  HNSW_ITERATIVE_SCAN_MIN_EXTVERSION,
  SEMANTIC_HNSW_EF_SEARCH,
  compareExtensionVersion,
  escapeIlikePattern,
  ilikeContainsPattern,
  memoryVectorToPgLiteral,
} from './sql-utils.js';

// ---------------------------------------------------------------------------
// HNSW / candidate fetch settings (finding 4)
// ---------------------------------------------------------------------------

test('HNSW fetch settings exceed the pgvector defaults and the 100-candidate fetch cap', () => {
  // pgvector's default hnsw.ef_search is 40; the adapter must search harder.
  assert.strictEqual(SEMANTIC_HNSW_EF_SEARCH, 200);
  assert.ok(SEMANTIC_HNSW_EF_SEARCH > 40);
  // Candidate fetch cap: up to 100 candidates per search (default limit 20).
  assert.strictEqual(SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT, 100);
  // iterative_scan feature gate is pgvector 0.8.0.
  assert.strictEqual(HNSW_ITERATIVE_SCAN_MIN_EXTVERSION, '0.8.0');
});

test('compareExtensionVersion handles dotted versions with missing segments', () => {
  assert.strictEqual(compareExtensionVersion('0.8.0', '0.8.0'), true);
  assert.strictEqual(compareExtensionVersion('0.8.1', '0.8.0'), true);
  assert.strictEqual(compareExtensionVersion('0.9.2', '0.8.0'), true);
  assert.strictEqual(compareExtensionVersion('1.0.0', '0.8.0'), true);
  assert.strictEqual(compareExtensionVersion('0.7.4', '0.8.0'), false);
  assert.strictEqual(compareExtensionVersion('0.79.0', '0.8.0'), true); // numeric, not lexicographic
  assert.strictEqual(compareExtensionVersion('0.8', '0.8.0'), true);
  assert.strictEqual(compareExtensionVersion('0.7', '0.8.0'), false);
  assert.strictEqual(compareExtensionVersion('', '0.8.0'), false);
  assert.strictEqual(compareExtensionVersion('abc', '0.8.0'), false);
  assert.strictEqual(compareExtensionVersion('0.8.0', ''), false);
});

// ---------------------------------------------------------------------------
// pgvector literal building
// ---------------------------------------------------------------------------

test('memoryVectorToPgLiteral formats 384 finite vectors as pgvector text input', () => {
  const vector = new Array<number>(MEMORY_EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 1;
  vector[383] = -0.5;
  const literal = memoryVectorToPgLiteral(vector);
  assert.ok(literal.startsWith('[1,'));
  assert.ok(literal.endsWith(',-0.5]'));
  assert.strictEqual(literal.split(',').length, MEMORY_EMBEDDING_DIMENSIONS);

  const zeros = memoryVectorToPgLiteral(new Array<number>(MEMORY_EMBEDDING_DIMENSIONS).fill(0));
  const zerosText = Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => '0').join(',');
  assert.strictEqual(zeros, `[${zerosText}]`);
});

test('memoryVectorToPgLiteral rejects wrong length and non-finite values', () => {
  assert.throws(() => memoryVectorToPgLiteral(new Array<number>(383).fill(0)), MemoryEmbeddingError);
  assert.throws(() => memoryVectorToPgLiteral(new Array<number>(385).fill(0)), MemoryEmbeddingError);
  const withNaN = new Array<number>(MEMORY_EMBEDDING_DIMENSIONS).fill(0);
  withNaN[17] = Number.NaN;
  assert.throws(() => memoryVectorToPgLiteral(withNaN), MemoryEmbeddingError);
  const withInfinity = new Array<number>(MEMORY_EMBEDDING_DIMENSIONS).fill(0);
  withInfinity[0] = Number.POSITIVE_INFINITY;
  assert.throws(() => memoryVectorToPgLiteral(withInfinity), MemoryEmbeddingError);
});

// ---------------------------------------------------------------------------
// ILIKE keyword escaping (wildcard injection safety)
// ---------------------------------------------------------------------------

test('escapeIlikePattern neutralizes LIKE wildcards and the escape char', () => {
  // '%' and '_' become wildcard-literals via the '~' escape char.
  assert.strictEqual(escapeIlikePattern('50%_boost'), '50~%~_boost');
  // The escape char itself is escaped so '~' matches literally.
  assert.strictEqual(escapeIlikePattern('a~b'), 'a~~b');
  // Backslashes pass through as literal characters (escape char is '~').
  assert.strictEqual(escapeIlikePattern('back\\slash'), 'back~\\slash');
  assert.strictEqual(escapeIlikePattern('plain'), 'plain');
  assert.strictEqual(escapeIlikePattern(''), '');
});

test('ilikeContainsPattern builds a wrapped substring pattern', () => {
  assert.strictEqual(ilikeContainsPattern('atlas'), '%atlas%');
  assert.strictEqual(ilikeContainsPattern('100%'), '%100~%%');
  assert.strictEqual(ilikeContainsPattern('_x_'), '%~_x~_%');
});

test('sql-utils module is importable without Prisma (CLI-safe surface)', async () => {
  const sqlUtils = await import('./sql-utils.js');
  assert.strictEqual(typeof sqlUtils.memoryVectorToPgLiteral, 'function');
  assert.strictEqual(typeof sqlUtils.escapeIlikePattern, 'function');
  assert.strictEqual(typeof sqlUtils.ilikeContainsPattern, 'function');
});
