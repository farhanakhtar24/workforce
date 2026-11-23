import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlocksQuery,
  buildCreateBlockBody,
  buildSearchBody,
  extractApiErrorMessage,
  fetchMemoryBlocks,
  formatConfidence,
  formatDateTime,
  formatScore,
  hasPendingBlocks,
  isBlockId,
  isValidCompactExpectation,
  mapBlocksResponse,
  mapCompactResponse,
  mapCreateResponse,
  mapRelatedResponse,
  mapRetryResponse,
  mapSearchResponse,
  memoryBlocksEndpoint,
  memoryCompactEndpoint,
  memoryRelatedEndpoint,
  memoryRetryEndpoint,
  memorySearchEndpoint,
  retryBlockEmbedding,
  requestMemoryJson,
  resolveApiBaseUrl,
  API_BASE_URL_DEFAULT,
  MEMORY_ERROR_FALLBACK,
  MEMORY_LIST_ERROR,
  MEMORY_RETRY_ERROR,
  type BlocksFilterInput,
  type CreateBlockFormInput,
  type MemoryBlock,
  type MemoryFetch,
} from '../src/lib/memory.js';

/**
 * Offline, pure wire-contract tests for the /memory workspace (no live API,
 * no network). Pins the Phase 3 REST contract: exact endpoint URLs, omitted
 * empty filters, exact POST bodies, safe fixed errors, block validation that
 * never accepts embedding vectors, formatting, and the pending-poll predicate.
 */

function makeBlock(overrides: Partial<MemoryBlock> = {}): MemoryBlock {
  return {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    scope: 'default',
    path: 'research/small-language-models',
    kind: 'learning',
    content: 'MiniLM emits 384-dim vectors.',
    confidence: 0.8,
    embeddingStatus: 'pending',
    embeddingModel: null,
    accessCount: 0,
    supersededById: null,
    metadata: {},
    createdAt: '2026-11-19T10:00:00.000Z',
    updatedAt: null,
    embeddedAt: null,
    lastAccessedAt: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Endpoints + base URL                                                */
/* ------------------------------------------------------------------ */

test('memory endpoints: exact URLs with encoded ids', () => {
  const base = 'http://localhost:3001';
  assert.equal(memoryBlocksEndpoint(base), `${base}/api/memory/blocks`);
  assert.equal(
    memoryBlocksEndpoint(base, '?path=research'),
    `${base}/api/memory/blocks?path=research`,
  );
  assert.equal(memorySearchEndpoint(base), `${base}/api/memory/search`);
  assert.equal(
    memoryRelatedEndpoint(base, 'abc'),
    `${base}/api/memory/blocks/abc/related`,
  );
  assert.equal(
    memoryRetryEndpoint(base, 'x y/z'),
    `${base}/api/memory/blocks/x%20y%2Fz/retry`,
  );
  assert.notEqual(
    memoryCompactEndpoint(base),
    `${base}/api/memory/compactx`, // pins the exact path shape
  );
  assert.equal(memoryCompactEndpoint(base), `${base}/api/memory/compact`);
});

test('resolveApiBaseUrl: same rules as chat — default, trim, trailing slashes', () => {
  assert.equal(resolveApiBaseUrl(undefined), API_BASE_URL_DEFAULT);
  assert.equal(resolveApiBaseUrl('http://example.com//'), 'http://example.com');
  assert.equal(isBlockId('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true);
  assert.equal(isBlockId('not-a-uuid'), false);
  assert.equal(isBlockId(42), false);
});

/* ------------------------------------------------------------------ */
/* GET query mapping                                                   */
/* ------------------------------------------------------------------ */

test('buildBlocksQuery: omits every empty filter entirely', () => {
  const query = buildBlocksQuery({
    scope: '  ',
    path: '',
    kind: '',
    keyword: undefined,
    includeSuperseded: false,
    limit: undefined,
  });
  assert.equal(query, '');
  assert.equal(
    buildBlocksQuery({ includeSuperseded: false }),
    '',
    'includeSuperseded must appear only when true',
  );
});

test('buildBlocksQuery: encodes provided filters and keeps path prefixes as typed', () => {
  const filters: BlocksFilterInput = {
    scope: 'default',
    path: 'research/small-language-models',
    kind: 'learning',
    keyword: 'mini lm',
    limit: 50,
  };
  const query = buildBlocksQuery(filters);
  assert.ok(query.startsWith('?'));
  const params = new URLSearchParams(query);
  assert.equal(params.get('scope'), 'default');
  assert.equal(params.get('path'), 'research/small-language-models');
  assert.equal(params.get('kind'), 'learning');
  assert.equal(params.get('keyword'), 'mini lm');
  assert.equal(params.get('limit'), '50');
  assert.equal(params.has('includeSuperseded'), false);
});

test('buildBlocksQuery: includeSuperseded=true included; bad kind/limit dropped', () => {
  const query = buildBlocksQuery({ path: 'research', includeSuperseded: true, kind: 'nope' as string, limit: 999 });
  const params = new URLSearchParams(query);
  assert.equal(params.get('includeSuperseded'), 'true');
  assert.equal(params.has('kind'), false, 'unknown kind must be omitted');
  assert.equal(params.has('limit'), false, 'out-of-range limit must be omitted (API default 20 applies)');
  assert.equal(buildBlocksQuery({ limit: 0 }), '');
  assert.equal(buildBlocksQuery({ limit: 1.5 }), '');
});

/* ------------------------------------------------------------------ */
/* POST /api/memory/blocks body mapping                                */
/* ------------------------------------------------------------------ */

const baseInput: CreateBlockFormInput = {
  scope: 'default',
  path: 'research/small-language-models',
  kind: 'learning',
  content: '  MiniLM emits 384-dim vectors.  ',
  confidence: '0.9',
};

test('buildCreateBlockBody: trims values, applies defaults, exact wire shape', () => {
  const result = buildCreateBlockBody({ ...baseInput, supersedesId: undefined });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.body, {
    scope: 'default',
    path: 'research/small-language-models',
    kind: 'learning',
    content: 'MiniLM emits 384-dim vectors.',
    confidence: 0.9,
  });
  assert.equal('supersedesId' in result.body, false, 'absent optional must be absent, not undefined');

  const withSupersedes = buildCreateBlockBody({
    ...baseInput,
    confidence: 0,
    supersedesId: '  3f2504e0-4f89-41d3-9a0c-0305e82c3301 ',
  });
  assert.equal(withSupersedes.ok, true);
  if (withSupersedes.ok) {
    assert.equal(withSupersedes.body.supersedesId, '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    assert.equal(withSupersedes.body.confidence, 0);
  }
});

test('buildCreateBlockBody: rejects invalid input with safe field messages', () => {
  const cases: CreateBlockFormInput[] = [
    { ...baseInput, scope: '' },
    { ...baseInput, scope: 'x'.repeat(101) },
    { ...baseInput, path: '   ' },
    { ...baseInput, path: 'x'.repeat(201) },
    { ...baseInput, kind: 'not-a-kind' },
    { ...baseInput, content: '   ' },
    { ...baseInput, content: 'x'.repeat(1001) },
    { ...baseInput, confidence: '1.5' },
    { ...baseInput, confidence: '-0.1' },
    { ...baseInput, confidence: 'abc' },
    { ...baseInput, supersedesId: 'deadbeef' },
  ];
  for (const input of cases) {
    const result = buildCreateBlockBody(input);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
    if (!result.ok) {
      assert.equal(typeof result.error, 'string');
      assert.ok(result.error.length > 0);
      // Never echoes the offending raw value back.
      assert.equal(result.error.includes('x'.repeat(101)), false);
    }
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/memory/search body mapping                                */
/* ------------------------------------------------------------------ */

test('buildSearchBody: exact shape, empty optionals omitted', () => {
  const result = buildSearchBody({ query: '  small models  ', path: '  ', kind: '' });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.body, { query: 'small models' });

  const full = buildSearchBody({ query: 'q', path: 'research', kind: 'decision', limit: 5 });
  assert.ok(full.ok);
  if (full.ok) assert.deepEqual(full.body, { query: 'q', path: 'research', kind: 'decision', limit: 5 });
});

test('buildSearchBody: rejects empty/oversized query and drops bad limits', () => {
  assert.equal(buildSearchBody({ query: '   ' }).ok, false);
  assert.equal(buildSearchBody({ query: 'x'.repeat(1001) }).ok, false);
  const weird = buildSearchBody({ query: 'q', limit: 0 });
  assert.ok(weird.ok);
  if (weird.ok) assert.equal('limit' in weird.body, false);
});

/* ------------------------------------------------------------------ */
/* Safe errors                                                         */
/* ------------------------------------------------------------------ */

test('extractApiErrorMessage: fixed fallback for anything that is not safe JSON', () => {
  assert.equal(
    extractApiErrorMessage({ error: 'Related block not found.' }, MEMORY_ERROR_FALLBACK),
    'Related block not found.',
  );
  assert.equal(extractApiErrorMessage({ error: '' }, MEMORY_ERROR_FALLBACK), MEMORY_ERROR_FALLBACK);
  assert.equal(extractApiErrorMessage({ error: 42 }, MEMORY_ERROR_FALLBACK), MEMORY_ERROR_FALLBACK);
  assert.equal(extractApiErrorMessage(null, MEMORY_ERROR_FALLBACK), MEMORY_ERROR_FALLBACK);
  assert.equal(extractApiErrorMessage('oops', MEMORY_ERROR_FALLBACK), MEMORY_ERROR_FALLBACK);
});

test('requestMemoryJson: POST sends exact JSON body + content-type; non-OK safe error; never throws', async () => {
  const seen: Array<{ url: string; init: Parameters<MemoryFetch>[1] }> = [];
  const fetchImpl: MemoryFetch = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 201, json: async () => ({ fine: true }) };
  };
  const ok = await requestMemoryJson({
    url: 'http://localhost:3001/api/memory/blocks',
    method: 'POST',
    body: { scope: 'default', confidence: 0.8 },
    fallbackError: MEMORY_ERROR_FALLBACK,
    fetchImpl,
  });
  assert.equal(ok.ok, true);
  assert.equal(seen[0]?.init?.method, 'POST');
  assert.equal(seen[0]?.init?.headers?.['content-type'], 'application/json');
  assert.equal(seen[0]?.init?.body, '{"scope":"default","confidence":0.8}');

  const refusedFetch: MemoryFetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: 'Related block not found.' }),
  });
  const err = await requestMemoryJson({
    url: 'http://localhost:3001/api/memory/blocks',
    method: 'GET',
    fallbackError: MEMORY_ERROR_FALLBACK,
    fetchImpl: refusedFetch,
  });
  assert.deepEqual(err, { ok: false, error: 'Related block not found.' });

  const netDown: MemoryFetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const net = await requestMemoryJson({
    url: 'http://localhost:3001/api/memory/blocks',
    method: 'GET',
    fallbackError: MEMORY_LIST_ERROR,
    fetchImpl: netDown,
  });
  assert.deepEqual(net, { ok: false, error: MEMORY_LIST_ERROR });

  const junk: MemoryFetch = async () => ({ ok: true, status: 200, json: async () => Promise.reject(new Error('<html>')) });
  const bad = await requestMemoryJson({
    url: 'http://localhost:3001/api/memory/blocks',
    method: 'GET',
    fallbackError: MEMORY_LIST_ERROR,
    fetchImpl: junk,
  });
  assert.deepEqual(bad, { ok: false, error: MEMORY_LIST_ERROR });
});

/* ------------------------------------------------------------------ */
/* Response validation                                                 */
/* ------------------------------------------------------------------ */

test('mapBlocksResponse: keeps valid block payloads (including metadata pass-through)', () => {
  const block = makeBlock({
    metadata: { compactedFromIds: ['b'.repeat(36)], sourceCount: 3 },
    embeddingStatus: 'ready',
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    embeddedAt: '2026-11-19T10:01:00.000Z',
  });
  const result = mapBlocksResponse({ blocks: [block] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.length, 1);
    assert.deepEqual(result.value[0]?.metadata, block.metadata);
  }
  // Empty list is a valid list.
  assert.equal(mapBlocksResponse({ blocks: [] }).ok, true);
});

test('mapBlocksResponse: fixed safe error for malformed payloads, never echoes content', () => {
  const secret = 'SUPER-INTERNAL-TRACE-123';
  for (const raw of [null, 'x', 42, [], {}, { blocks: 'nope' }, { blocks: [{}] }, { blocks: [makeBlock({ kind: 'weird' as never })] }, { blocks: [makeBlock({ confidence: 2 })] }]) {
    const result = mapBlocksResponse(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, MEMORY_LIST_ERROR);
      assert.equal(result.error.includes(secret), false);
    }
  }
});

test('mapBlocksResponse: rejects blocks carrying embedding/vector keys — no vectors in the browser', () => {
  for (const key of ['embedding', 'embeddings', 'vector', 'embeddingVector']) {
    const leaky = makeBlock() as unknown as Record<string, unknown>;
    leaky[key] = [0.1, 0.2, 0.3];
    const result = mapBlocksResponse({ blocks: [leaky] });
    assert.equal(result.ok, false, `vector key "${key}" must invalidate the payload`);
    if (!result.ok) assert.equal(result.error, MEMORY_LIST_ERROR);
  }
});

test('mapCreateResponse: maps { block } or fails safely', () => {
  const ok = mapCreateResponse({ block: makeBlock() });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.path, 'research/small-language-models');
  assert.equal(mapCreateResponse({}).ok, false);
  assert.equal(mapCreateResponse({ block: null }).ok, false);
  assert.equal(mapCreateResponse(null).ok, false);
});

test('mapSearchResponse: maps cosine/recency/score; non-finite or missing fields rejected', () => {
  const ok = mapSearchResponse({
    results: [
      {
        block: makeBlock({ embeddingStatus: 'ready' }),
        cosineSimilarity: 0.9123001,
        recencyScore: 0.5,
        score: 0.8298841,
      },
    ],
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value[0]?.cosineSimilarity, 0.9123001);
    assert.equal(ok.value[0]?.score, 0.8298841);
  }
  assert.equal(mapSearchResponse({ results: 'nope' }).ok, false);
  assert.equal(
    mapSearchResponse({ results: [{ block: makeBlock(), cosineSimilarity: undefined, recencyScore: 0.5, score: 0.9 }] }).ok,
    false,
  );
  assert.equal(
    mapSearchResponse({ results: [{ block: makeBlock(), cosineSimilarity: NaN, recencyScore: 0.5, score: 0.9 }] }).ok,
    false,
  );
  assert.equal(
    mapSearchResponse({ results: [{ block: makeBlock({ embeddingStatus: 'weird' as never }), cosineSimilarity: 0.5, recencyScore: 0.5, score: 0.5 }] }).ok,
    false,
  );
});

test('mapRelatedResponse: maps requested block + outgoing/incoming (supersedes included)', () => {
  const other = makeBlock({ id: '11111111-1111-4111-8111-111111111111', kind: 'correction', path: 'research/small-language-models/v2' });
  const relation = {
    id: '22222222-2222-4222-8222-222222222222',
    sourceId: other.id,
    targetId: makeBlock().id,
    type: 'supersedes' as const,
    createdAt: '2026-11-19T10:05:00.000Z',
  };
  const ok = mapRelatedResponse({
    block: makeBlock(),
    outgoing: [{ relation, block: other }],
    incoming: [{ relation: { ...relation, type: 'contradicts' }, block: other }],
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.outgoing[0]?.relation.type, 'supersedes');
    assert.equal(ok.value.incoming[0]?.relation.type, 'contradicts');
    assert.equal(ok.value.outgoing[0]?.block.content, other.content);
  }

  const badType = mapRelatedResponse({
    block: makeBlock(),
    outgoing: [{ relation: { ...relation, type: 'loves' }, block: other }],
    incoming: [],
  });
  assert.equal(badType.ok, false);
  assert.equal(mapRelatedResponse({ block: makeBlock() }).ok, false);
  assert.equal(mapRelatedResponse(null).ok, false);
});

test('mapRetryResponse / mapCompactResponse: only documented queued payloads pass', () => {
  const retry = mapRetryResponse({ status: 'queued', blockId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' });
  assert.deepEqual(retry, { ok: true, value: { status: 'queued', blockId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } });
  assert.equal(mapRetryResponse({ status: 'ready' }).ok, false);
  assert.equal(mapRetryResponse({ status: 'queued' }).ok, false);
  assert.equal(mapRetryResponse(null).ok, false);

  const compact = mapCompactResponse({
    status: 'queued',
    scope: 'default',
    path: 'research',
    triggerBlockId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  });
  assert.ok(compact.ok);
  if (compact.ok) assert.equal(compact.value.path, 'research');
  assert.equal(mapCompactResponse({ status: 'queued', scope: 'default', path: 'research' }).ok, false, 'triggerBlockId required');
});

/* ------------------------------------------------------------------ */
/* Orchestration (stub fetch)                                          */
/* ------------------------------------------------------------------ */

test('fetchMemoryBlocks: GET with mapped query; 409 body error surfaced verbatim', async () => {
  const seen: Array<{ url: string; init: Parameters<MemoryFetch>[1] }> = [];
  const okFetch: MemoryFetch = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ blocks: [makeBlock()] }) };
  };
  const ok = await fetchMemoryBlocks({
    apiBaseUrl: 'http://localhost:3001',
    filters: { path: 'research/small-language-models', includeSuperseded: true, limit: 20 },
    fetchImpl: okFetch,
  });
  assert.equal(seen[0]?.init?.cache, 'no-store');
  assert.equal(seen[0]?.init?.method, 'GET');
  assert.equal(seen[0]?.init?.body, undefined, 'GET must not send a body');
  assert.equal(
    seen[0]?.url,
    // URLSearchParams percent-encodes the slash; Express decodes it back to
    // the same path-prefix value.
    'http://localhost:3001/api/memory/blocks?path=research%2Fsmall-language-models&includeSuperseded=true&limit=20',
  );
  assert.ok(ok.ok);

  const conflict: MemoryFetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'Block is already ready; only failed blocks can retry.' }),
  });
  const retried = await retryBlockEmbedding({
    apiBaseUrl: 'http://localhost:3001',
    blockId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    fetchImpl: conflict,
  });
  assert.deepEqual(retried, { ok: false, error: 'Block is already ready; only failed blocks can retry.' });

  // Malformed 202 body: fixed fallback, no internals.
  const bad202: MemoryFetch = async () => ({ ok: true, status: 202, json: async () => ({ status: 'queued' }) });
  const broken = await retryBlockEmbedding({
    apiBaseUrl: 'http://localhost:3001',
    blockId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    fetchImpl: bad202,
  });
  assert.deepEqual(broken, { ok: false, error: MEMORY_RETRY_ERROR });
});

test('retryBlockEmbedding: refuses to even fetch for a non-UUID block id', async () => {
  let called = false;
  const spy: MemoryFetch = async () => {
    called = true;
    return { ok: true, status: 202, json: async () => ({ status: 'queued', blockId: 'x' }) };
  };
  const result = await retryBlockEmbedding({
    apiBaseUrl: 'http://localhost:3001',
    blockId: '../../etc/passwd',
    fetchImpl: spy,
  });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

/* ------------------------------------------------------------------ */
/* Formatting + predicates                                             */
/* ------------------------------------------------------------------ */

test('hasPendingBlocks: polls only while at least one rendered block is pending', () => {
  assert.equal(hasPendingBlocks([makeBlock({ embeddingStatus: 'pending' })]), true);
  assert.equal(
    hasPendingBlocks([makeBlock({ embeddingStatus: 'ready' }), makeBlock({ embeddingStatus: 'pending' })]),
    true,
  );
  assert.equal(hasPendingBlocks([makeBlock({ embeddingStatus: 'ready' })]), false, 'ready-only stops polling');
  assert.equal(hasPendingBlocks([makeBlock({ embeddingStatus: 'failed' })]), false, 'failed-only stops polling');
  assert.equal(hasPendingBlocks([]), false, 'empty list stops polling');
  assert.equal(
    hasPendingBlocks([makeBlock({ embeddingStatus: 'ready', supersededById: 'x' })]),
    false,
    'superseded list stops polling',
  );
});

test('formatConfidence / formatScore: consistent fixed formatting, safe for junk', () => {
  assert.equal(formatConfidence(0.8), '80%');
  assert.equal(formatConfidence(0), '0%');
  assert.equal(formatConfidence(1), '100%');
  assert.equal(formatConfidence(0.856), '86%');
  assert.equal(formatConfidence(1.5), '(n/a)');
  assert.equal(formatConfidence(NaN), '(n/a)');
  assert.equal(formatScore(0.8512399), '0.851');
  assert.equal(formatScore(0.9), '0.900');
  assert.equal(formatScore(1), '1.000');
  assert.equal(formatScore(-Infinity), '(n/a)');
  assert.equal(formatScore(NaN), '(n/a)');
});

test('formatDateTime: deterministic UTC rendering with fixed fallbacks', () => {
  assert.equal(formatDateTime(null), '(not set)');
  assert.equal(formatDateTime(null, '—'), '—');
  assert.equal(formatDateTime(undefined), '(not set)');
  assert.equal(formatDateTime('2026-11-19T10:05:09.000Z'), '2026-11-19 10:05 UTC');
  assert.equal(formatDateTime('2026-11-19T23:59:59.999Z'), '2026-11-19 23:59 UTC');
  assert.equal(formatDateTime('not-a-date'), '(unknown)');
});

test('isValidCompactExpectation: more than 30 chars required (trimmed)', () => {
  assert.equal(isValidCompactExpectation('short note'), false);
  assert.equal(isValidCompactExpectation('x'.repeat(30)), false, 'exactly 30 is not more than 30');
  assert.equal(isValidCompactExpectation('x'.repeat(31)), true);
  assert.equal(isValidCompactExpectation(`   ${'y'.repeat(31)}   `), true);
  assert.equal(isValidCompactExpectation('   '), false, 'whitespace-only never counts');
});
