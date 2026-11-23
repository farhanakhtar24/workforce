import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELEGATION_LIST_ERROR,
  DELEGATION_TEXT_LIMIT,
  buildDelegationsListQuery,
  childChatUrlFor,
  delegationsListEndpoint,
  fetchDelegations,
  formatDelegationTime,
  hasActiveDelegations,
  mapDelegationsResponse,
  truncateDelegationText,
  delegationStatusLabel,
  type Delegation,
  type DelegationFetch,
} from '../src/lib/delegations.js';

/**
 * Pure delegation wire-contract tests, pinned against
 * apps/api/src/agents/delegation-routes.ts:
 * - GET /api/agents/orchestrator/delegations REQUIRES parentChatId
 *   (1..64 of A-Za-z0-9_-) and honors limit 1..100, newest first.
 * - Row shape = core Delegation: status machine pending → running →
 *   completed | failed | timeout; mode sync|async; target analyst|researcher;
 *   child depth 1..2; result/error nullable texts.
 * - The browser NEVER calls the guarded /run route (no manual retry).
 */

const DELEGATION_ID = '11111111-2222-4333-8444-555555555555';
const CHILD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function delegation(overrides: Record<string, unknown> = {}): Delegation {
  return {
    id: DELEGATION_ID,
    scope: 'default',
    parentChatId: 'parent-1',
    childChatId: CHILD_ID,
    parentMessageId: 'pmsg-1',
    targetAgent: 'researcher',
    mode: 'sync',
    status: 'completed',
    task: 'Summarize the memory research.',
    result: 'Worker answer text',
    error: null,
    depth: 1,
    createdAt: '2026-11-23T10:00:00.000Z',
    updatedAt: '2026-11-23T10:02:00.000Z',
    completedAt: '2026-11-23T10:02:00.000Z',
    ...overrides,
  } as Delegation;
}

test('delegationsListEndpoint + buildDelegationsListQuery: parentChatId REQUIRED and bounded', () => {
  assert.equal(delegationsListEndpoint('http://localhost:3001'), 'http://localhost:3001/api/agents/orchestrator/delegations');
  assert.equal(buildDelegationsListQuery({ parentChatId: 'parent-1' }), '?parentChatId=parent-1');
  assert.equal(buildDelegationsListQuery({ parentChatId: 'parent-1', limit: 100 }), '?parentChatId=parent-1&limit=100');
  // Missing/unsafe parent → empty query (the fetch wrapper then refuses).
  assert.equal(buildDelegationsListQuery({}), '');
  assert.equal(buildDelegationsListQuery({ parentChatId: '  ' }), '');
  assert.equal(buildDelegationsListQuery({ parentChatId: '../etc' }), '');
  assert.equal(buildDelegationsListQuery({ parentChatId: 'x'.repeat(65) }), '');
  assert.equal(buildDelegationsListQuery({ parentChatId: 'p', limit: 0 }), '?parentChatId=p');
  assert.equal(buildDelegationsListQuery({ parentChatId: 'p', limit: 101 }), '?parentChatId=p');
  assert.equal(buildDelegationsListQuery({ parentChatId: 'p', limit: 2.5 }), '?parentChatId=p');
});

test('mapDelegationsResponse: valid rows mapped; malformed rows rejected with a fixed error', () => {
  const ok = mapDelegationsResponse({ delegations: [delegation()] });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.delegations[0]?.status, 'completed');
    assert.equal(ok.delegations[0]?.result, 'Worker answer text');
    assert.equal(ok.delegations[0]?.error, null);
  }
  const pendingNoResult = mapDelegationsResponse({
    delegations: [delegation({ status: 'pending', result: null, completedAt: null, mode: 'async' })],
  });
  assert.equal(pendingNoResult.ok, true);

  for (const [label, bad] of Object.entries({
    nullPayload: null,
    notObject: 'nope',
    missingList: {},
    badList: { delegations: 'no' },
    badStatus: { delegations: [delegation({ status: 'zombie' })] },
    badTarget: { delegations: [delegation({ targetAgent: 'orchestrator' })] },
    badMode: { delegations: [delegation({ mode: 'later' })] },
    depthTooDeep: { delegations: [delegation({ depth: 3 })] },
    depthZero: { delegations: [delegation({ depth: 0 })] },
    emptyTask: { delegations: [delegation({ task: '' })] },
    childIdMissing: { delegations: [delegation({ childChatId: '' })] },
    badParent: { delegations: [delegation({ parentChatId: 'bad id' })] },
    badCompletedAt: { delegations: [delegation({ completedAt: 17 as unknown as string })] },
  })) {
    const mapped = mapDelegationsResponse(bad as unknown);
    assert.equal(mapped.ok, false, label);
    if (!mapped.ok) assert.equal(mapped.error, DELEGATION_LIST_ERROR); // fixed, no payload echo
  }
});

test('hasActiveDelegations polls only pending/running', () => {
  assert.equal(hasActiveDelegations([]), false);
  assert.equal(hasActiveDelegations([delegation({ status: 'completed' })]), false);
  assert.equal(hasActiveDelegations([delegation({ status: 'failed' })]), false);
  assert.equal(hasActiveDelegations([delegation({ status: 'timeout' })]), false);
  assert.equal(hasActiveDelegations([delegation({ status: 'pending' })]), true);
  assert.equal(hasActiveDelegations([delegation({ status: 'running' })]), true);
  assert.equal(hasActiveDelegations([delegation({ status: 'completed' }), delegation({ status: 'pending' })]), true);
});

test('status labels + timestamps are safe and total', () => {
  assert.equal(delegationStatusLabel('pending'), 'Waiting to start');
  assert.equal(delegationStatusLabel('running'), 'Child chat running');
  assert.equal(delegationStatusLabel('completed'), 'Completed');
  assert.equal(delegationStatusLabel('failed'), 'Failed');
  assert.equal(delegationStatusLabel('timeout'), 'Timed out');
  assert.equal(formatDelegationTime(null), '(not set)');
  assert.equal(formatDelegationTime('2026-11-23T10:00:00.000Z'), '2026-11-23 10:00 UTC');
  assert.equal(truncateDelegationText('x'.repeat(DELEGATION_TEXT_LIMIT + 5)).endsWith('…'), true);
  assert.equal(truncateDelegationText('short').length, 5);
});

test('childChatUrlFor: canonical agent-scoped URLs; workers and safe ids only', () => {
  assert.deepEqual(childChatUrlFor(CHILD_ID, 'analyst'), { href: `/agents/analyst/chat/${CHILD_ID}` });
  assert.deepEqual(childChatUrlFor(CHILD_ID, 'researcher'), { href: `/agents/researcher/chat/${CHILD_ID}` });
  assert.equal(childChatUrlFor(CHILD_ID, 'orchestrator'), null);
  assert.equal(childChatUrlFor('bad/id', 'analyst'), null);
});

/* ------------------------------------------------------------------ */
/* fetchDelegations                                                    */
/* ------------------------------------------------------------------ */

test('fetchDelegations: no-store GET with the required query; maps rows', async () => {
  const calls: { url: string; init?: Parameters<DelegationFetch>[1] }[] = [];
  const fetchImpl: DelegationFetch = async (input, init) => {
    calls.push({ url: input, init });
    return { ok: true, status: 200, json: async () => ({ delegations: [delegation({ status: 'running' })] }) };
  };
  const result = await fetchDelegations({ apiBaseUrl: 'http://localhost:3001', parentChatId: 'parent-1', limit: 100, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.url, 'http://localhost:3001/api/agents/orchestrator/delegations?parentChatId=parent-1&limit=100');
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[0]?.init?.cache, 'no-store');
  if (result.ok) assert.equal(hasActiveDelegations(result.delegations), true);
});

test('fetchDelegations: unsafe chatId refuses locally with a fixed per-chat message', async () => {
  const neverCalled: DelegationFetch = async () => {
    throw new Error('must not fetch');
  };
  const refused = await fetchDelegations({ apiBaseUrl: 'http://localhost:3001', parentChatId: 'bad id', fetchImpl: neverCalled });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.includes('per chat'), true);
});

test('fetchDelegations: safe API errors surface verbatim, everything else collapses', async () => {
  const conflict: DelegationFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'Invalid delegation request.' }) });
  const bad = await fetchDelegations({ apiBaseUrl: 'http://localhost:3001', parentChatId: 'p', fetchImpl: conflict });
  assert.deepEqual(bad, { ok: false, error: 'Invalid delegation request.' });

  const internal: DelegationFetch = async () => ({ ok: false, status: 503, json: async () => 'INTERNAL TRACE <stack>' });
  const down = await fetchDelegations({ apiBaseUrl: 'http://localhost:3001', parentChatId: 'p', fetchImpl: internal });
  assert.deepEqual(down, { ok: false, error: DELEGATION_LIST_ERROR });

  const network: DelegationFetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const net = await fetchDelegations({ apiBaseUrl: 'http://localhost:3001', parentChatId: 'p', fetchImpl: network });
  assert.deepEqual(net, { ok: false, error: DELEGATION_LIST_ERROR });

  const junkBody: DelegationFetch = async () => ({ ok: true, status: 200, json: async () => ({ delegations: [{}] }) });
  const junk = await fetchDelegations({ apiBaseUrl: 'http://localhost:3001', parentChatId: 'p', fetchImpl: junkBody });
  assert.deepEqual(junk, { ok: false, error: DELEGATION_LIST_ERROR });
});
