import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORK_DOC_CONFLICT_HINT,
  WORK_DOC_DISPLAY_LIMIT,
  WORK_DOC_LIST_ERROR,
  WORK_DOC_SUMMARY_MAX,
  WORK_DOC_TITLE_MAX,
  buildWorkDocCreateBody,
  buildWorkDocListQuery,
  buildWorkDocPatchBody,
  buildWorkDocRollbackBody,
  buildWorkDocVersionBody,
  createWorkDoc,
  fetchWorkDocDetail,
  fetchWorkDocList,
  fetchWorkDocRevisions,
  fetchWorkDocVersions,
  mapWorkDocDetailResponse,
  mapWorkDocListResponse,
  mapWorkDocLink,
  mapWorkDocRevision,
  mapWorkDocUpdateResponse,
  mapWorkDocVersion,
  postWorkDocVersion,
  rollbackWorkDoc,
  truncateWorkDocContent,
  updateWorkDocMetadata,
  workDocPagePath,
  workDocsListEndpoint,
  workDocDetailEndpoint,
  workDocLinkHref,
  workDocVersionsEndpoint,
  workDocRevisionsEndpoint,
  workDocLinksEndpoint,
  workListPagePath,
  workDocVersionLine,
  type WorkDoc,
  type WorkFetch,
} from '../src/lib/workdocs.js';

/**
 * Pure Work-Docs wire-contract tests, pinned against
 * apps/api/src/agents/work-doc-routes.ts:
 * - GET list needs no chatId; EVERY doc-scoped call needs the owning chatId
 *   (query for GETs, body for mutations) — cross-chat reads are fixed 404.
 * - PATCH body is exactly {chatId, expectedVersion, title?, status?}.
 * - Rollback body is {chatId, expectedVersion, toVersion, summary?, source}.
 * - Versioned content edits go through the REAL versions route
 *   (POST …/versions {chatId, expectedVersion, content?, title?, status?, summary?, source:'user'}).
 * - Fixed API error texts: 400 'Invalid work document request.',
 *   404 'Work document not found.', 409 'Work document version conflict.'
 */

const DOC_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = '99999999-8888-4777-a666-555555555555';
const CHAT = 'chat-abc';
const BASE = 'http://localhost:3001';

const VALID_DOC: WorkDoc = {
  id: DOC_UUID,
  scope: 'default',
  chatId: CHAT,
  type: 'report',
  title: 'Findings',
  content: 'Body text',
  status: 'draft',
  version: 3,
  createdAt: '2026-11-23T10:00:00.000Z',
  updatedAt: '2026-11-23T11:00:00.000Z',
};

/* ------------------------------------------------------------------ */
/* Endpoints + page paths                                              */
/* ------------------------------------------------------------------ */

test('endpoint builders: exact URLs, orchestrator namespace, encoded ids, chatId everywhere', () => {
  assert.equal(workDocsListEndpoint(BASE, '?chatId=x'), `${BASE}/api/agents/orchestrator/work-docs?chatId=x`);
  assert.equal(workDocsListEndpoint(BASE), `${BASE}/api/agents/orchestrator/work-docs`);
  assert.equal(
    workDocDetailEndpoint(BASE, DOC_UUID, CHAT),
    `${BASE}/api/agents/orchestrator/work-docs/${DOC_UUID}?chatId=${CHAT}`,
  );
  assert.equal(
    workDocVersionsEndpoint(BASE, DOC_UUID, CHAT, 50),
    `${BASE}/api/agents/orchestrator/work-docs/${DOC_UUID}/versions?chatId=${CHAT}&limit=50`,
  );
  assert.equal(
    workDocVersionsEndpoint(BASE, DOC_UUID, CHAT),
    `${BASE}/api/agents/orchestrator/work-docs/${DOC_UUID}/versions?chatId=${CHAT}`,
  );
  assert.equal(
    workDocRevisionsEndpoint(BASE, DOC_UUID, CHAT),
    `${BASE}/api/agents/orchestrator/work-docs/${DOC_UUID}/revisions?chatId=${CHAT}`,
  );
  assert.equal(
    workDocLinksEndpoint(BASE, DOC_UUID, CHAT),
    `${BASE}/api/agents/orchestrator/work-docs/${DOC_UUID}/links?chatId=${CHAT}`,
  );
  const odd = '../etc';
  assert.equal(
    workDocDetailEndpoint(BASE, odd as string, 'a b'),
    `${BASE}/api/agents/orchestrator/work-docs/..%2Fetc?chatId=a%20b`,
  );
});

test('page paths carry the owning chat', () => {
  assert.equal(workDocPagePath(DOC_UUID, CHAT), `/work/${DOC_UUID}?chatId=${CHAT}`);
  assert.equal(workListPagePath(CHAT), `/work?chatId=${CHAT}`);
  assert.equal(workListPagePath(undefined), '/work');
  assert.equal(workListPagePath(''), '/work');
});

/* ------------------------------------------------------------------ */
/* Query + body builders                                               */
/* ------------------------------------------------------------------ */

test('buildWorkDocListQuery: empty filters omitted, unknown enums dropped, limit bounded', () => {
  assert.equal(buildWorkDocListQuery({}), '');
  assert.equal(buildWorkDocListQuery({ scope: 'default', chatId: CHAT, type: 'report', status: 'draft', limit: 50 }),
    `?scope=default&chatId=${CHAT}&type=report&status=draft&limit=50`);
  // chatId must be a safe id or it is dropped entirely.
  assert.equal(buildWorkDocListQuery({ chatId: '../../etc' }), '');
  assert.equal(buildWorkDocListQuery({ type: 'unknown' }), '');
  assert.equal(buildWorkDocListQuery({ status: 'flying' }), '');
  assert.equal(buildWorkDocListQuery({ limit: 0 }), '');
  assert.equal(buildWorkDocListQuery({ limit: 101 }), '');
  assert.equal(buildWorkDocListQuery({ limit: 20.5 }), '');
  assert.equal(buildWorkDocListQuery({ limit: 100 }), '?limit=100');
});

test('buildWorkDocPatchBody: metadata + CAS version; requires chatId and one field', () => {
  const ok = buildWorkDocPatchBody({ chatId: CHAT, expectedVersion: 3, title: 'New', status: 'active' });
  assert.deepEqual(ok, { ok: true, body: { chatId: CHAT, expectedVersion: 3, title: 'New', status: 'active' } });
  // Numeric-string versions normalize.
  const numeric = buildWorkDocPatchBody({ chatId: CHAT, expectedVersion: '7', status: 'archived' });
  if (numeric.ok) assert.equal(numeric.body.expectedVersion, 7);
  // A blank title is dropped, so a status must come along — otherwise refused.
  assert.equal(buildWorkDocPatchBody({ chatId: CHAT, expectedVersion: 3, title: '   ' }).ok, false);
  const noTitle = buildWorkDocPatchBody({ chatId: CHAT, expectedVersion: 3, title: '   ', status: 'draft' });
  assert.deepEqual(noTitle, { ok: true, body: { chatId: CHAT, expectedVersion: 3, status: 'draft' } });
  // No field → error, not a no-op PATCH.
  assert.equal(buildWorkDocPatchBody({ chatId: CHAT, expectedVersion: 3 }).ok, false);
  // Ownership context is mandatory.
  assert.equal(buildWorkDocPatchBody({ chatId: 'bad id', expectedVersion: 3, status: 'draft' }).ok, false);
  // Version must be a whole number ≥ 1.
  assert.equal(buildWorkDocPatchBody({ chatId: CHAT, expectedVersion: 0, status: 'draft' }).ok, false);
  assert.equal(buildWorkDocPatchBody({ chatId: CHAT, expectedVersion: 'x', status: 'draft' }).ok, false);
  // Bounds.
  assert.equal(buildWorkDocPatchBody({ chatId: CHAT, expectedVersion: 1, title: 'x'.repeat(WORK_DOC_TITLE_MAX + 1) }).ok, false);
  assert.equal(buildWorkDocPatchBody({ chatId: CHAT, expectedVersion: 1, status: 'unknown' }).ok, false);
});

test('buildWorkDocRollbackBody: BOTH versions required, source user, summary optional', () => {
  const rollbackInput = (value: object): ReturnType<typeof buildWorkDocRollbackBody> =>
    buildWorkDocRollbackBody(value as Parameters<typeof buildWorkDocRollbackBody>[0]);
  const ok = buildWorkDocRollbackBody({ chatId: CHAT, expectedVersion: 5, toVersion: 2, summary: 'restore' });
  assert.deepEqual(ok, {
    ok: true,
    body: { chatId: CHAT, expectedVersion: 5, toVersion: 2, summary: 'restore', source: 'user' },
  });
  assert.deepEqual(buildWorkDocRollbackBody({ chatId: CHAT, expectedVersion: '5', toVersion: '2' }), {
    ok: true,
    body: { chatId: CHAT, expectedVersion: 5, toVersion: 2, source: 'user' },
  });
  assert.equal(rollbackInput({ chatId: CHAT, expectedVersion: 5 }).ok, false);
  assert.equal(rollbackInput({ chatId: CHAT, toVersion: 2 }).ok, false);
  assert.equal(rollbackInput({ chatId: CHAT, expectedVersion: -1, toVersion: 2 }).ok, false);
  assert.equal(rollbackInput({ chatId: 'bad id', expectedVersion: 1, toVersion: 1 }).ok, false);
  assert.equal(
    rollbackInput({ chatId: CHAT, expectedVersion: 1, toVersion: 1, summary: 's'.repeat(WORK_DOC_SUMMARY_MAX + 1) }).ok,
    false,
  );
});

test('buildWorkDocCreateBody: chat + type + title + content bounded', () => {
  const ok = buildWorkDocCreateBody({ chatId: CHAT, type: 'plan', title: ' Plan ', content: ' steps ' });
  assert.deepEqual(ok, { ok: true, body: { chatId: CHAT, type: 'plan', title: 'Plan', content: 'steps' } });
  assert.equal(buildWorkDocCreateBody({ chatId: 'bad id', type: 'plan', title: 'T', content: 'C' }).ok, false);
  assert.equal(buildWorkDocCreateBody({ chatId: CHAT, type: 'memo', title: 'T', content: 'C' }).ok, false);
  assert.equal(buildWorkDocCreateBody({ chatId: CHAT, type: 'plan', title: '', content: 'C' }).ok, false);
  assert.equal(buildWorkDocCreateBody({ chatId: CHAT, type: 'plan', title: 'T', content: '  ' }).ok, false);
});

test('buildWorkDocVersionBody: real versions-route contract with CAS version + user source', () => {
  const ok = buildWorkDocVersionBody({ chatId: CHAT, expectedVersion: 4, content: ' new body ', summary: 'fix' });
  assert.deepEqual(ok, {
    ok: true,
    body: { chatId: CHAT, expectedVersion: 4, content: 'new body', summary: 'fix', source: 'user' },
  });
  // Title/status variants also route through the versioned path.
  const titleOnly = buildWorkDocVersionBody({ chatId: CHAT, expectedVersion: '4', title: 'Retitled' });
  assert.deepEqual(titleOnly, { ok: true, body: { chatId: CHAT, expectedVersion: 4, title: 'Retitled', source: 'user' } });
  // Nothing to change → refused client-side (no-op versions pollute history).
  assert.equal(buildWorkDocVersionBody({ chatId: CHAT, expectedVersion: 4 }).ok, false);
  assert.equal(buildWorkDocVersionBody({ chatId: CHAT, expectedVersion: 4, content: '   ' }).ok, false);
  assert.equal(buildWorkDocVersionBody({ chatId: 'bad id', expectedVersion: 4, content: 'C' }).ok, false);
  assert.equal(buildWorkDocVersionBody({ chatId: CHAT, expectedVersion: 'no', content: 'C' }).ok, false);
});

/* ------------------------------------------------------------------ */
/* Response mapping                                                    */
/* ------------------------------------------------------------------ */

test('document/version/revision/link mappers accept valid rows and reject malformed ones', () => {
  assert.equal(mapWorkDocListResponse({ documents: [VALID_DOC] }).ok, true);
  for (const bad of [
    null,
    {},
    { documents: 'no' },
    { documents: [{ ...VALID_DOC, id: 'not-a-uuid' }] },
    { documents: [{ ...VALID_DOC, type: 'memo' }] },
    { documents: [{ ...VALID_DOC, status: 'flying' }] },
    { documents: [{ ...VALID_DOC, version: 0 }] },
  ]) {
    const mapped = mapWorkDocListResponse(bad);
    assert.equal(mapped.ok, false);
    if (!mapped.ok) assert.equal(mapped.error, WORK_DOC_LIST_ERROR); // fixed, no payload echo
  }

  const version = {
    id: OTHER_UUID,
    documentId: DOC_UUID,
    version: 2,
    title: 'T',
    content: 'C',
    status: 'active',
    createdAt: '2026-11-23T09:00:00.000Z',
  };
  assert.equal(mapWorkDocVersion(version).ok, true);
  assert.equal(mapWorkDocVersion({ ...version, version: -1 }).ok, false);
  assert.equal(mapWorkDocVersion(null).ok, false);

  const revision = {
    id: OTHER_UUID,
    documentId: DOC_UUID,
    source: 'user',
    actorId: CHAT,
    fromVersion: 1,
    toVersion: 2,
    summary: 'why',
    createdAt: '2026-11-23T09:00:00.000Z',
  };
  assert.equal(mapWorkDocRevision(revision).ok, true);
  const initial = mapWorkDocRevision({ ...revision, fromVersion: null, actorId: null });
  assert.equal(initial.ok, true);
  assert.equal(mapWorkDocRevision({ ...revision, source: 'robot' }).ok, false);
  assert.equal(mapWorkDocRevision({ ...revision, toVersion: 0 }).ok, false);

  const link = { id: OTHER_UUID, documentId: DOC_UUID, targetType: 'chat', targetId: 'c1', label: null, createdAt: '2026-11-23T09:00:00.000Z' };
  assert.equal(mapWorkDocLink(link).ok, true);
  assert.equal(mapWorkDocLink({ ...link, targetType: 'email' }).ok, false);
});

test('mapWorkDocDetailResponse: document + recentVersions + links', () => {
  const detail = mapWorkDocDetailResponse({
    document: VALID_DOC,
    recentVersions: [
      {
        id: OTHER_UUID,
        documentId: DOC_UUID,
        version: 3,
        title: 'Findings',
        content: 'Body text',
        status: 'draft',
        createdAt: '2026-11-23T11:00:00.000Z',
      },
    ],
    links: [{ id: OTHER_UUID, documentId: DOC_UUID, targetType: 'memory_block', targetId: 'b1', label: null, createdAt: '2026-11-23T09:00:00.000Z' }],
  });
  assert.equal(detail.ok, true);
  const broken = mapWorkDocDetailResponse({ document: VALID_DOC, recentVersions: [] });
  assert.equal(broken.ok, false);
  assert.equal(mapWorkDocUpdateResponse({ document: VALID_DOC }).ok, true);
  assert.equal(mapWorkDocUpdateResponse({}).ok, false);
});

/* ------------------------------------------------------------------ */
/* Safe CAS conflict + error plumbing                                  */
/* ------------------------------------------------------------------ */

function workFetchStub(response: { ok: boolean; status?: number; body?: unknown }): {
  fetchImpl: WorkFetch;
  calls: { url: string; init?: Parameters<WorkFetch>[1] }[];
} {
  const calls: { url: string; init?: Parameters<WorkFetch>[1] }[] = [];
  return {
    calls,
    fetchImpl: async (input, init) => {
      calls.push({ url: input, init });
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.body,
      };
    },
  };
}

test('updateWorkDocMetadata: PATCH body exact, 409 surfaces the fixed conflict text + hint', async () => {
  const { fetchImpl, calls } = workFetchStub({ ok: false, status: 409, body: { error: 'Work document version conflict.' } });
  const result = await updateWorkDocMetadata({
    apiBaseUrl: BASE,
    workDocId: DOC_UUID,
    body: { chatId: CHAT, expectedVersion: 3, status: 'active' },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, 'Work document version conflict.');
    assert.equal(WORK_DOC_CONFLICT_HINT.includes('Refresh'), true);
  }
  const call = calls[0];
  assert.equal(call?.init?.method, 'PATCH');
  assert.equal(call?.init?.cache, 'no-store');
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    chatId: CHAT,
    expectedVersion: 3,
    status: 'active',
  });
});

test('fetchWorkDocDetail: no-store GET; malformed/safe-error mapping; wrong ids never fetch', async () => {
  const { fetchImpl, calls } = workFetchStub({
    ok: true,
    status: 200,
    body: {
      document: VALID_DOC,
      recentVersions: [],
      links: [],
    },
  });
  const ok = await fetchWorkDocDetail({ apiBaseUrl: BASE, workDocId: DOC_UUID, chatId: CHAT, fetchImpl });
  assert.equal(ok.ok, true);
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[0]?.init?.cache, 'no-store');

  const refused: WorkFetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'Work document not found.' }) });
  const missing = await fetchWorkDocDetail({ apiBaseUrl: BASE, workDocId: DOC_UUID, chatId: CHAT, fetchImpl: refused });
  assert.deepEqual(missing, { ok: false, error: 'Work document not found.' });

  // Cross-chat-style id problems never produce a fetch at all.
  const noChat = await fetchWorkDocDetail({ apiBaseUrl: BASE, workDocId: DOC_UUID, chatId: '', fetchImpl });
  assert.equal(noChat.ok, false);
  assert.equal(calls.length, 1); // only the successful first call happened
  const badId = await fetchWorkDocDetail({ apiBaseUrl: BASE, workDocId: 'junk', chatId: CHAT, fetchImpl });
  assert.equal(badId.ok, false);

  const garbage: WorkFetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const down = await fetchWorkDocDetail({ apiBaseUrl: BASE, workDocId: DOC_UUID, chatId: CHAT, fetchImpl: garbage });
  if (!down.ok) assert.equal(down.error.includes('ECONNREFUSED'), false);
});

test('postWorkDocVersion + rollbackWorkDoc + createWorkDoc hit the real routes exactly', async () => {
  const version = workFetchStub({ ok: true, status: 200, body: { document: { ...VALID_DOC, version: 4, content: 'new' } } });
  const versionResult = await postWorkDocVersion({
    apiBaseUrl: BASE,
    workDocId: DOC_UUID,
    body: { chatId: CHAT, expectedVersion: 3, content: 'new', source: 'user' },
    fetchImpl: version.fetchImpl,
  });
  assert.equal(versionResult.ok, true);
  assert.equal(version.calls[0]?.url, `${BASE}/api/agents/orchestrator/work-docs/${DOC_UUID}/versions`);
  // UI-driven content edits are recorded as USER revisions.
  assert.deepEqual(JSON.parse(String(version.calls[0]?.init?.body)), {
    chatId: CHAT,
    expectedVersion: 3,
    content: 'new',
    source: 'user',
  });

  const rollback = workFetchStub({ ok: true, status: 200, body: { document: { ...VALID_DOC, version: 4 } } });
  const rollbackResult = await rollbackWorkDoc({
    apiBaseUrl: BASE,
    workDocId: DOC_UUID,
    body: { chatId: CHAT, expectedVersion: 3, toVersion: 1, source: 'user' },
    fetchImpl: rollback.fetchImpl,
  });
  assert.equal(rollbackResult.ok, true);
  assert.equal(rollback.calls[0]?.url, `${BASE}/api/agents/orchestrator/work-docs/${DOC_UUID}/rollback`);
  assert.deepEqual(JSON.parse(String(rollback.calls[0]?.init?.body)), {
    chatId: CHAT,
    expectedVersion: 3,
    toVersion: 1,
    source: 'user',
  });

  const created = workFetchStub({ ok: true, status: 201, body: { document: VALID_DOC } });
  const createResult = await createWorkDoc({
    apiBaseUrl: BASE,
    body: { chatId: CHAT, type: 'analysis', title: 'T', content: 'C' },
    fetchImpl: created.fetchImpl,
  });
  assert.equal(createResult.ok, true);
  assert.equal(created.calls[0]?.url, `${BASE}/api/agents/orchestrator/work-docs`);
  assert.equal(created.calls[0]?.init?.method, 'POST');
});

test('list versions/revisions mappers and fetches stay fixed on junk', async () => {
  assert.equal(
    (await fetchWorkDocVersions({ apiBaseUrl: BASE, workDocId: DOC_UUID, chatId: CHAT, fetchImpl: workFetchStub({ ok: false, status: 404, body: { error: 'Work document not found.' } }).fetchImpl })).ok,
    false,
  );
  assert.equal(
    (await fetchWorkDocRevisions({ apiBaseUrl: BASE, workDocId: DOC_UUID, chatId: CHAT, fetchImpl: workFetchStub({ ok: false, status: 403, body: 'SECRET' }).fetchImpl })).ok,
    false,
  );
  const junk = await fetchWorkDocList({ apiBaseUrl: BASE, filters: {}, fetchImpl: workFetchStub({ ok: true, status: 200, body: { documents: [] } }).fetchImpl });
  assert.deepEqual(junk, { ok: true, documents: [] });
  const badPayload = await fetchWorkDocList({ apiBaseUrl: BASE, filters: {}, fetchImpl: workFetchStub({ ok: true, status: 200, body: { documents: 'no' } }).fetchImpl });
  assert.deepEqual(badPayload, { ok: false, error: WORK_DOC_LIST_ERROR });
});

/* ------------------------------------------------------------------ */
/* Links + display shaping                                             */
/* ------------------------------------------------------------------ */

test('workDocLinkHref: typed targets map to in-app pages without cross-chat leaks', () => {
  const base = {
    id: OTHER_UUID,
    documentId: DOC_UUID,
    createdAt: '2026-11-23T09:00:00.000Z',
  };
  const memory = mapWorkDocLink({ ...base, targetType: 'memory_block', targetId: 'block-x', label: null });
  const chat = mapWorkDocLink({ ...base, targetType: 'chat', targetId: 'c_9', label: 'Origin chat' });
  const delegation = mapWorkDocLink({ ...base, targetType: 'delegation', targetId: 'zzz', label: null });
  assert.ok(memory.ok && chat.ok && delegation.ok);

  if (memory.ok) {
    assert.deepEqual(workDocLinkHref(memory.value, CHAT), { href: '/memory', text: 'Memory block' });
  }
  if (chat.ok) {
    assert.deepEqual(workDocLinkHref(chat.value, CHAT), { href: '/chat/c_9', text: 'Origin chat' });
  }
  if (delegation.ok) {
    assert.deepEqual(workDocLinkHref(delegation.value, CHAT), {
      href: `/delegations?chatId=${CHAT}`,
      text: 'Delegations in this chat',
    });
  }
  // The memory link is context-free; unsafe link targets / chat contexts
  // render as text, never as a wrong link.
  if (memory.ok) {
    assert.deepEqual(workDocLinkHref(memory.value, ''), { href: '/memory', text: 'Memory block' });
  }
  if (delegation.ok) {
    assert.equal(workDocLinkHref(delegation.value, ''), null);
  }
  const unsafeChatLink = mapWorkDocLink({ ...base, targetType: 'chat', targetId: '../x', label: null });
  if (unsafeChatLink.ok) assert.equal(workDocLinkHref(unsafeChatLink.value, CHAT), null);
});

test('display shaping: content truncation and version lines', () => {
  const long = 'c'.repeat(WORK_DOC_DISPLAY_LIMIT + 10);
  assert.equal(truncateWorkDocContent(long).length, WORK_DOC_DISPLAY_LIMIT + 1);
  assert.equal(truncateWorkDocContent('short'), 'short');
  assert.equal(
    workDocVersionLine({
      id: OTHER_UUID,
      documentId: DOC_UUID,
      version: 2,
      title: 'T',
      content: 'C',
      status: 'active',
      createdAt: '2026-11-23T09:05:00.000Z',
    }),
    'v2 · active · 2026-11-23 09:05 UTC',
  );
});
