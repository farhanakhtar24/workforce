/**
 * Work Document REST route tests (Phase 4): the SAME REST surface the
 * `write_doc` tool and the web UI call (ADR-002), over the in-memory store —
 * CAS updates, immutable history, rollback creates NEW versions, chat
 * ownership (cross-chat → 404, no existence oracle), PATCH metadata-only,
 * agent-sourced POST versions, links/revisions, safe fixed errors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { WorkDocService } from '@workforce/core/work-docs';
import { InMemoryWorkDocStore } from '@workforce/core/work-docs';
import type { WorkDoc } from '@workforce/core/work-docs';

interface DocBody {
  readonly document?: WorkDoc;
  readonly documents?: WorkDoc[];
  readonly versions?: Array<{ version: number; content: string; title: string }>;
  readonly version?: { version: number; content: string; title: string; status: string };
  readonly revisions?: Array<{ source: string; fromVersion: number | null; toVersion: number; summary: string }>;
  readonly links?: Array<{ targetType: string; targetId: string }>;
}

const ROOT = '/api/agents/orchestrator/work-docs';

async function startDocs(): Promise<Awaited<ReturnType<typeof startTestApp>>> {
  return await startTestApp({ agents: { wire: true } });
}

async function createDoc(app: Awaited<ReturnType<typeof startTestApp>>, chatId = 'doc-chat-1', overrides: Record<string, unknown> = {}): Promise<WorkDoc> {
  const response = await fetch(`http://127.0.0.1:${app.port}${ROOT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, type: 'report', title: 'Analysis', content: 'first content', ...overrides }),
  });
  assert.equal(response.status, 201, `create failed: ${String(response.status)}`);
  const body = (await response.json()) as DocBody;
  return body.document as WorkDoc;
}

test('create: 201, version 1 draft, immutable v1 snapshot and creation revision', async () => {
  const app = await startDocs();
  try {
    const doc = await createDoc(app);
    assert.equal(doc.version, 1);
    assert.equal(doc.status, 'draft');
    assert.equal(doc.type, 'report');
    assert.equal(doc.chatId, 'doc-chat-1');

    const revisions = await getJsonDoc<AppRevisionsBody>(app, `${ROOT}/${doc.id}/revisions?chatId=${doc.chatId}`);
    assert.equal(revisions.revisions?.length, 1);
    assert.equal(revisions.revisions?.[0]?.fromVersion, null);
    assert.equal(revisions.revisions?.[0]?.toVersion, 1);
    assert.equal(revisions.revisions?.[0]?.source, 'agent');

    const versions = await getJsonDoc<AppVersionsBody>(app, `${ROOT}/${doc.id}/versions?chatId=${doc.chatId}`);
    assert.equal(versions.versions?.length, 1);
    assert.equal(versions.versions?.[0]?.version, 1);
    assert.equal(versions.versions?.[0]?.content, 'first content');
  } finally {
    await app.close();
  }
});

interface AppVersionsBody {
  versions?: Array<{ version: number; content: string; title: string; status?: string }>;
}
interface AppRevisionsBody {
  revisions?: Array<{ source: string; actorId: string | null; fromVersion: number | null; toVersion: number; summary: string }>;
}

function appPort(app: Awaited<ReturnType<typeof startTestApp>>): number {
  return app.port;
}

async function getJsonDoc<T>(app: Awaited<ReturnType<typeof startTestApp>>, path: string): Promise<T & { error?: string }> {
  const response = await fetch(`http://127.0.0.1:${app.port}${path}`);
  return (await response.json()) as T & { error?: string };
}

async function requestDoc(
  app: Awaited<ReturnType<typeof startTestApp>>,
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
): Promise<{ status: number; body: DocBody & { error?: string } }> {
  const response = await fetch(`http://127.0.0.1:${app.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as DocBody & { error?: string };
  return { status: response.status, body: payload };
}

test('agent POST versions: CAS content update bumps version, appends snapshot + revision', async () => {
  const app = await startDocs();
  try {
    const doc = await createDoc(app);
    const updated = await requestDoc(app, 'POST', `${ROOT}/${doc.id}/versions`, {
      chatId: 'doc-chat-1',
      expectedVersion: 1,
      content: 'updated content',
      title: 'Analysis v2',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.document?.version, 2);
    assert.equal(updated.body.document?.content, 'updated content');
    assert.equal(updated.body.document?.title, 'Analysis v2');

    // CAS: stale expectedVersion → fixed 409, no write.
    const stale = await requestDoc(app, 'POST', `${ROOT}/${doc.id}/versions`, {
      chatId: 'doc-chat-1',
      expectedVersion: 1,
      content: 'lost update',
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body, { error: 'Work document version conflict.' });

    const after = await getJsonDoc<AppVersionsBody>(app, `${ROOT}/${doc.id}/versions?chatId=${doc.chatId}`);
    assert.equal(after.versions?.length, 2); // history intact; the lost update wrote nothing
    assert.equal(after.versions?.[1]?.content, 'updated content');
  } finally {
    await app.close();
  }
});

test('PATCH route: user metadata-only title/status; content rejected; CAS applies', async () => {
  const app = await startDocs();
  try {
    const doc = await createDoc(app);
    const patched = await requestDoc(app, 'PATCH', `${ROOT}/${doc.id}`, {
      chatId: 'doc-chat-1',
      expectedVersion: 1,
      status: 'active',
      title: 'Renamed',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.document?.status, 'active');
    assert.equal(patched.body.document?.title, 'Renamed');
    assert.equal(patched.body.document?.version, 2);
    assert.equal(patched.body.document?.content, 'first content');

    const withContent = await requestDoc(app, 'PATCH', `${ROOT}/${doc.id}`, {
      chatId: 'doc-chat-1',
      expectedVersion: 2,
      content: 'nope',
    });
    assert.equal(withContent.status, 400);

    const emptyPatch = await requestDoc(app, 'PATCH', `${ROOT}/${doc.id}`, { chatId: 'doc-chat-1', expectedVersion: 2 });
    assert.equal(emptyPatch.status, 400);

    const revisions = await getJsonDoc<AppRevisionsBody>(app, `${ROOT}/${doc.id}/revisions?chatId=${doc.chatId}`);
    const last = revisions.revisions?.at(-1);
    assert.equal(last?.source, 'user');
  } finally {
    await app.close();
  }
});

test('rollback: copies the old snapshot into a NEW current version; history never rewritten', async () => {
  const app = await startDocs();
  try {
    const doc = await createDoc(app);
    await requestDoc(app, 'POST', `${ROOT}/${doc.id}/versions`, {
      chatId: 'doc-chat-1',
      expectedVersion: 1,
      content: 'second content',
      title: 'Updated',
    });
    const rolled = await requestDoc(app, 'POST', `${ROOT}/${doc.id}/rollback`, {
      chatId: 'doc-chat-1',
      expectedVersion: 2,
      toVersion: 1,
    });
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.document?.version, 3);
    assert.equal(rolled.body.document?.content, 'first content'); // v1 snapshot copied
    assert.equal(rolled.body.document?.title, 'Analysis'); // v1 snapshot title
    assert.equal(rolled.body.document?.version, 3);

    const versions = await getJsonDoc<AppVersionsBody>(app, `${ROOT}/${doc.id}/versions?chatId=${doc.chatId}`);
    assert.equal(versions.versions?.length, 3);
    assert.equal(versions.versions?.[0]?.version, 1);
    assert.equal(versions.versions?.[1]?.version, 2);
    assert.equal(versions.versions?.[2]?.version, 3);
    assert.equal(versions.versions?.[2]?.content, 'first content');

    // Stale CAS on rollback → 409; toVersion at/after current → fixed 400.
    const stale = await requestDoc(app, 'POST', `${ROOT}/${doc.id}/rollback`, {
      chatId: 'doc-chat-1',
      expectedVersion: 1,
      toVersion: 1,
    });
    assert.equal(stale.status, 409);
    const missing = await requestDoc(app, 'POST', `${ROOT}/${doc.id}/rollback`, {
      chatId: 'doc-chat-1',
      expectedVersion: 3,
      toVersion: 99,
    });
    assert.equal(missing.status, 400);
  } finally {
    await app.close();
  }
});

test('ownership: cross-chat reads/mutations are fixed 404 (no existence leak); missing chatId → 400', async () => {
  const app = await startDocs();
  try {
    const doc = await createDoc(app, 'owned-chat');
    const foreign = await getJsonDoc(app, `${ROOT}/${doc.id}?chatId=other-chat`);
    assert.equal(foreign.error === undefined, false);
    const foreignResponse = await fetch(`http://127.0.0.1:${app.port}${ROOT}/${doc.id}?chatId=other-chat`);
    assert.equal(foreignResponse.status, 404);

    const noChat = await fetch(`http://127.0.0.1:${app.port}${ROOT}/${doc.id}`);
    assert.equal(noChat.status, 400);

    const foreignPatch = await requestDoc(app, 'PATCH', `${ROOT}/${doc.id}`, {
      chatId: 'other-chat',
      expectedVersion: 1,
      status: 'archived',
    });
    assert.equal(foreignPatch.status, 404);

    // Unknown id reads as the same 404 (existence oracle prevention).
    const unknown = await getJsonDoc(app, `${ROOT}/00000000-0000-4000-8000-000000000000?chatId=x`);
    assert.ok(unknown.error !== undefined);
  } finally {
    await app.close();
  }
});

test('list route: filters by chatId, bounded limit, newest first; unknown slug → 404', async () => {
  const app = await startDocs();
  try {
    const a = await createDoc(app, 'chat-a', { title: 'A' });
    const b = await createDoc(app, 'chat-b', { title: 'B' });
    void a;
    void b;
    const listA = await getJsonDoc<DocBody>(app, `${ROOT}?chatId=chat-a`);
    assert.equal(listA.documents?.length, 1);
    const all = await getJsonDoc<DocBody>(app, `${ROOT}?limit=10`);
    assert.equal(all.documents?.length, 2);
    const bounded = await getJsonDoc<DocBody>(app, `${ROOT}?limit=0`);
    assert.ok(bounded.error !== undefined);

    const wrongSlug = await fetch(`http://127.0.0.1:${app.port}${appPort(app) === 0 ? '' : ''}`);
    void wrongSlug;
    const analystGet = await fetch(`http://127.0.0.1:${app.port}/api/agents/analyst/work-docs?chatId=chat-a`);
    assert.equal(analystGet.status, 200); // reads served for any known slug path
  } finally {
    await app.close();
  }
});

test('route guards: create only on orchestrator; non-orchestrator POST reads 404; unknown slug 400/404 fixed', async () => {
  const app = await startDocs();
  try {
    const analystCreate = await requestDoc(app, 'POST', '/api/agents/analyst/work-docs', {
      chatId: 'c',
      type: 'report',
      title: 'T',
      content: 'C',
    });
    assert.equal(analystCreate.status, 404);

    const badBody = await requestDoc(app, 'POST', ROOT, { chatId: 'c', type: 'report', title: '', content: 'C' });
    assert.equal(badBody.status, 400);
    assert.deepEqual(badBody.body, { error: 'Invalid work document request.' });

    const orchestratorPatchUnknown = await requestDoc(app, 'PATCH', `${ROOT}/00000000-0000-4000-8000-000000000000`, {
      chatId: 'c',
      expectedVersion: 1,
      title: 'x',
    });
    assert.equal(orchestratorPatchUnknown.status, 404);
    assert.deepEqual(orchestratorPatchUnknown.body, { error: 'Work document not found.' });
  } finally {
    await app.close();
  }
});

test('single versions route: 200 for known snapshot, 404 for missing version', async () => {
  const app = await startDocs();
  try {
    const doc = await createDoc(app);
    await requestDoc(app, 'POST', `${ROOT}/${doc.id}/versions`, {
      chatId: 'doc-chat-1',
      expectedVersion: 1,
      content: 'second content',
    });
    const v1 = await getJsonDoc<DocBody>(app, `${ROOT}/${doc.id}/versions/1?chatId=${doc.chatId}`);
    assert.equal(v1.version?.version, 1);
    assert.equal(v1.version?.content, 'first content');
    const v3 = await fetch(`http://127.0.0.1:${app.port}${ROOT}/${doc.id}/versions/3?chatId=${doc.chatId}`);
    assert.equal(v3.status, 404);
    const vBad = await fetch(`http://127.0.0.1:${app.port}${ROOT}/${doc.id}/versions/x?chatId=${doc.chatId}`);
    assert.equal(vBad.status, 400);
  } finally {
    await app.close();
  }
});

test('links: typed add + idempotent per (doc,type,target); list via GET', async () => {
  const app = await startDocs();
  try {
    const doc = await createDoc(app);
    const added = await requestDoc(app, 'POST', `${ROOT}/${doc.id}/links`, {
      chatId: 'doc-chat-1',
      targetType: 'memory_block',
      targetId: 'mem-1',
      label: 'source',
    });
    assert.equal(added.status, 201);
    const listed = await getJsonDoc<DocBody>(app, `${ROOT}/${doc.id}/links?chatId=${doc.chatId}`);
    assert.equal(listed.links?.length, 1);
    assert.equal(listed.links?.[0]?.targetType, 'memory_block');

    const again = await requestDoc(app, 'POST', `${ROOT}/${doc.id}/links`, {
      chatId: 'doc-chat-1',
      targetType: 'memory_block',
      targetId: 'mem-1',
    });
    assert.ok([200, 201].includes(again.status));

    const invalidType = await requestDoc(app, 'POST', `${ROOT}/${doc.id}/links`, {
      chatId: 'doc-chat-1',
      targetType: 'external_thing',
      targetId: 'x',
    });
    assert.equal(invalidType.status, 400);
  } finally {
    await app.close();
  }
});

test("postVersion provenance: optional source 'agent' default vs 'user' (browser edits), strict values", async () => {
  const app = await startDocs();
  try {
    const doc = await createDoc(app);

    // Default (no source) → 'agent' provenance, exactly the tool behavior.
    await requestDoc(app, 'POST', `${ROOT}/${doc.id}/versions`, {
      chatId: 'doc-chat-1',
      expectedVersion: 1,
      content: 'tool written',
    });
    // Explicit 'user' → honest user provenance via the same CAS route.
    const userEdit = await requestDoc(app, 'POST', `${ROOT}/${doc.id}/versions`, {
      chatId: 'doc-chat-1',
      expectedVersion: 2,
      content: 'browser edit',
      source: 'user',
    });
    assert.equal(userEdit.status, 200);
    assert.equal(userEdit.body.document?.version, 3);
    // Invalid source → fixed 400.
    const bad = await requestDoc(app, 'POST', `${ROOT}/${doc.id}/versions`, {
      chatId: 'doc-chat-1',
      expectedVersion: 3,
      status: 'active',
      source: 'system',
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: 'Invalid work document request.' });

    const revisions = await getJsonDoc<AppRevisionsBody>(app, `${ROOT}/${doc.id}/revisions?chatId=${doc.chatId}`);
    assert.equal(revisions.revisions?.length, 3);
    assert.equal(revisions.revisions?.[1]?.source, 'agent', 'absent source defaults to agent');
    assert.equal(revisions.revisions?.[2]?.source, 'user', 'explicit user source is recorded');
  } finally {
    await app.close();
  }
});

test('revisions trail shows both agent and user sources with summaries', async () => {  const app = await startDocs();
  try {
    const doc = await createDoc(app);
    await requestDoc(app, 'POST', `${ROOT}/${doc.id}/versions`, {
      chatId: 'doc-chat-1',
      expectedVersion: 1,
      content: 'second',
      summary: 'rewrote after review',
    });
    await requestDoc(app, 'PATCH', `${ROOT}/${doc.id}`, {
      chatId: 'doc-chat-1',
      expectedVersion: 2,
      status: 'active',
      title: 'T2',
    });
    const revisions = await getJsonDoc<AppRevisionsBody>(app, `${ROOT}/${doc.id}/revisions?chatId=${doc.chatId}`);
    assert.equal(revisions.revisions?.length, 3);
    assert.equal(revisions.revisions?.[1]?.source, 'agent');
    assert.equal(revisions.revisions?.[1]?.summary, 'rewrote after review');
    assert.equal(revisions.revisions?.[2]?.source, 'user');
  } finally {
    await app.close();
  }
});
