import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WORK_DOC_HISTORY_LIMIT_MAX,
  WORK_DOC_LIST_LIMIT_MAX,
  WORK_DOC_MAX_CONTENT_LENGTH,
  WORK_DOC_MAX_SUMMARY_LENGTH,
  WORK_DOC_MAX_TITLE_LENGTH,
  InMemoryWorkDocStore,
  WorkDocConflictError,
  WorkDocNotFoundError,
  WorkDocService,
  WorkDocValidationError,
  createWorkDocInputSchema,
  parseWorkDocInput,
  rollbackWorkDocInputSchema,
  updateWorkDocInputSchema,
  type WorkDoc,
} from './index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CHAT_A = 'chat-1111';
const CHAT_B = 'chat-2222';

let docCounter = 0;

function makeHarness() {
  docCounter += 1;
  const store = new InMemoryWorkDocStore();
  const service = new WorkDocService({ store });
  return { store, service, chatId: `${CHAT_A}-${docCounter}`, chatB: `${CHAT_B}-${docCounter}` };
}

async function seedDoc(
  service: WorkDocService,
  chatId: string,
  overrides?: { scope?: string; type?: 'report' | 'plan' | 'analysis'; status?: 'draft' | 'active' | 'archived' },
): Promise<WorkDoc> {
  return service.create({
    chatId,
    type: overrides?.type ?? 'report',
    title: 'Atlas launch plan',
    content: 'Original content for the document.',
    scope: overrides?.scope ?? 'default',
    status: overrides?.status ?? 'draft',
  });
}

// ---------------------------------------------------------------------------
// Schemas and bounds
// ---------------------------------------------------------------------------

test('work doc schemas enforce the documented bounds and normalization', () => {
  const ok = parseWorkDocInput(createWorkDocInputSchema, {
    chatId: '  chat-x  ',
    type: 'plan',
    title: '  Trimmed title  ',
    content: 'body',
  });
  assert.equal(ok.scope, 'default');
  assert.equal(ok.chatId, 'chat-x');
  assert.equal(ok.title, 'Trimmed title');
  assert.equal(ok.status, 'draft');

  assert.throws(
    () => parseWorkDocInput(createWorkDocInputSchema, { chatId: 'c', type: 'plan', title: '', content: 'body' }),
    WorkDocValidationError,
  );
  assert.throws(
    () =>
      parseWorkDocInput(createWorkDocInputSchema, {
        chatId: 'c',
        type: 'plan',
        title: 'x'.repeat(WORK_DOC_MAX_TITLE_LENGTH + 1),
        content: 'body',
      }),
    WorkDocValidationError,
  );
  assert.throws(
    () =>
      parseWorkDocInput(createWorkDocInputSchema, {
        chatId: 'c',
        type: 'plan',
        title: 't',
        content: 'x'.repeat(WORK_DOC_MAX_CONTENT_LENGTH + 1),
      }),
    WorkDocValidationError,
  );
  assert.throws(
    () => parseWorkDocInput(createWorkDocInputSchema, { chatId: 'c', type: 'memo', title: 't', content: 'b' }),
    WorkDocValidationError,
  );
  // Unknown keys are rejected (strictObject).
  assert.throws(
    () => parseWorkDocInput(createWorkDocInputSchema, { chatId: 'c', type: 'plan', title: 't', content: 'b', rogue: 1 }),
    WorkDocValidationError,
  );
  // Memory-domain scope rules reused (uppercase normalized).
  const scoped = parseWorkDocInput(createWorkDocInputSchema, {
    scope: 'Atlas_Team',
    chatId: 'c',
    type: 'analysis',
    title: 't',
    content: 'b',
  });
  assert.equal(scoped.scope, 'atlas_team');
  assert.throws(
    () => parseWorkDocInput(createWorkDocInputSchema, { scope: 'bad scope!', chatId: 'c', type: 'plan', title: 't', content: 'b' }),
    WorkDocValidationError,
  );
  assert.throws(
    () => parseWorkDocInput(rollbackWorkDocInputSchema, { id: '00000000-0000-4000-8000-000000000001', expectedVersion: 1, toVersion: 0, source: 'user' }),
    WorkDocValidationError,
  );
});

test('update schema requires a change and a CAS version', () => {
  const base = { id: '00000000-0000-4000-8000-000000000001', expectedVersion: 3, source: 'agent' as const };
  assert.throws(
    () => parseWorkDocInput(updateWorkDocInputSchema, { ...base }),
    /update must change at least one of title, content, or status/,
  );
  const ok = parseWorkDocInput(updateWorkDocInputSchema, { ...base, status: 'active' });
  assert.equal(ok.status, 'active');
  assert.throws(
    () => parseWorkDocInput(updateWorkDocInputSchema, { ...base, title: 't', expectedVersion: 0 }),
    WorkDocValidationError,
  );
  assert.throws(
    () =>
      parseWorkDocInput(updateWorkDocInputSchema, {
        ...base,
        title: 't',
        summary: 'x'.repeat(WORK_DOC_MAX_SUMMARY_LENGTH + 1),
      }),
    WorkDocValidationError,
  );
  assert.throws(
    () => parseWorkDocInput(updateWorkDocInputSchema, { ...base, title: 't', source: 'robot' }),
    WorkDocValidationError,
  );
});

// ---------------------------------------------------------------------------
// Lifecycle through the service on the in-memory store
// ---------------------------------------------------------------------------

test('create starts at version 1 with an immutable snapshot and a creation revision', async () => {
  const { service } = makeHarness();
  const doc = await service.create({ chatId: 'chat-1', type: 'report', title: 'T', content: 'C' });

  assert.equal(doc.version, 1);
  assert.equal(doc.status, 'draft');
  assert.equal(doc.scope, 'default');
  assert.ok(!Number.isNaN(Date.parse(doc.createdAt)));
  assert.equal(doc.createdAt, doc.updatedAt);

  const versions = await service.listVersions({ id: doc.id });
  assert.equal(versions.length, 1);
  assert.equal(versions[0]!.version, 1);
  assert.equal(versions[0]!.title, 'T');
  assert.equal(versions[0]!.content, 'C');

  const revisions = await service.listRevisions({ id: doc.id });
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]!.toVersion, 1);
  assert.equal(revisions[0]!.fromVersion, null);
  assert.equal(revisions[0]!.source, 'agent');
  assert.equal(revisions[0]!.summary, 'created');
});

test('update performs CAS: bumps version, writes snapshot and audit atomically', async () => {
  const { service } = makeHarness();
  const doc = await seedDoc(service, 'chat-1');

  const updated = await service.update({
    id: doc.id,
    expectedVersion: 1,
    title: 'New title',
    content: 'New content',
    status: 'active',
    source: 'user',
    summary: 'rewrote the plan',
  });

  assert.equal(updated.version, 2);
  assert.equal(updated.title, 'New title');
  assert.equal(updated.content, 'New content');
  assert.equal(updated.status, 'active');

  const versions = await service.listVersions({ id: doc.id });
  assert.equal(versions.length, 2);
  assert.equal(versions[1]!.version, 2);

  const revisions = await service.listRevisions({ id: doc.id });
  assert.equal(revisions.length, 2);
  const audit = revisions[1]!;
  assert.equal(audit.fromVersion, 1);
  assert.equal(audit.toVersion, 2);
  assert.equal(audit.source, 'user');
  assert.equal(audit.summary, 'rewrote the plan');
  assert.equal(audit.actorId, null);
});

test('update records actorId for agent and user sources', async () => {
  const { service } = makeHarness();
  const doc = await seedDoc(service, 'chat-1');
  const byUser = await service.update({
    id: doc.id,
    expectedVersion: 1,
    title: 'User edit',
    source: 'user',
    actorId: 'user-42',
  });
  void byUser;
  const revision = (await service.listRevisions({ id: doc.id }))[1]!;
  assert.equal(revision.source, 'user');
  assert.equal(revision.actorId, 'user-42');

  const byAgent = await service.update({
    id: doc.id,
    expectedVersion: 2,
    title: 'Agent edit',
    source: 'agent',
    actorId: 'agent-7',
  });
  void byAgent;
  const second = (await service.listRevisions({ id: doc.id }))[2]!;
  assert.equal(second.source, 'agent');
  assert.equal(second.actorId, 'agent-7');
});

test('stale expectedVersion conflicts (409) and missing documents are 404', async () => {
  const { service } = makeHarness();
  const doc = await seedDoc(service, 'chat-1');

  assert.rejects(
    () => service.update({ id: doc.id, expectedVersion: 99, title: 'stale', source: 'agent' }),
    (error: unknown) => error instanceof WorkDocConflictError && error.code === 'work_doc_conflict',
  );
  await assert.rejects(
    () =>
      service.rollback({
        id: doc.id,
        expectedVersion: 99,
        toVersion: 1,
        source: 'user',
      }),
    WorkDocConflictError,
  );
  await assert.rejects(
    () =>
      service.update({
        id: '00000000-0000-4000-8000-0000000000ff',
        expectedVersion: 1,
        title: 'x',
        source: 'agent',
      }),
    (error: unknown) => error instanceof WorkDocNotFoundError && error.code === 'work_doc_not_found',
  );
  // The failed writes left no history.
  assert.equal((await service.listVersions({ id: doc.id })).length, 1);
  assert.equal((await service.listRevisions({ id: doc.id })).length, 1);
});

test('concurrent same-document updates produce exactly one winner and one typed conflict', async () => {
  const { service } = makeHarness();
  const doc = await seedDoc(service, 'chat-1');

  const first = service.update({ id: doc.id, expectedVersion: 1, title: 'Winner A', source: 'agent' });
  const second = service.update({ id: doc.id, expectedVersion: 1, title: 'Winner B', source: 'agent' });
  const settled = await Promise.allSettled([first, second]);

  const fulfilled = settled.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = settled.filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.status === 'rejected' && rejected[0]!.reason instanceof WorkDocConflictError);

  const final = await service.get(doc.id);
  assert.equal(final?.version, 2);
  assert.equal((await service.listVersions({ id: doc.id })).length, 2);
});

test('rollback copies the target snapshot into a NEW version and never rewrites history', async () => {
  const { service } = makeHarness();
  const doc = await seedDoc(service, 'chat-1');
  const v2 = await service.update({ id: doc.id, expectedVersion: 1, title: 'Edited', content: 'Edited body', status: 'active', source: 'agent' });
  void v2;

  const rolled = await service.rollback({ id: doc.id, expectedVersion: 2, toVersion: 1, source: 'user' });
  assert.equal(rolled.version, 3);
  assert.equal(rolled.title, 'Atlas launch plan');
  assert.equal(rolled.content, 'Original content for the document.');
  assert.equal(rolled.status, 'draft');

  const versions = await service.listVersions({ id: doc.id });
  assert.equal(versions.length, 3);
  // Version 1 snapshot untouched; version 2 snapshot untouched; v3 copies v1.
  assert.equal(versions[0]!.version, 1);
  assert.equal(versions[0]!.title, 'Atlas launch plan');
  assert.equal(versions[1]!.version, 2);
  assert.equal(versions[1]!.title, 'Edited');
  assert.equal(versions[2]!.version, 3);
  assert.equal(versions[2]!.title, 'Atlas launch plan');

  const revisions = await service.listRevisions({ id: doc.id });
  const audit = revisions[2]!;
  assert.equal(audit.fromVersion, 2);
  assert.equal(audit.toVersion, 3);
  assert.equal(audit.source, 'user');
  assert.equal(audit.summary, 'restored content from version 1');
});

test('rollback refuses the current version and rejects out-of-range targets', async () => {
  const { service } = makeHarness();
  const doc = await seedDoc(service, 'chat-1');

  await assert.rejects(
    () => service.rollback({ id: doc.id, expectedVersion: 1, toVersion: 1, source: 'user' }),
    WorkDocValidationError,
  );
  await assert.rejects(
    () => service.rollback({ id: doc.id, expectedVersion: 1, toVersion: 5, source: 'user' }),
    WorkDocValidationError,
  );
  // Out-of-range targets (>= current version) fail fast as 400.
  const advanced = await service.update({ id: doc.id, expectedVersion: 1, title: 'v2', source: 'agent' });
  void advanced;
  await assert.rejects(
    () => service.rollback({ id: doc.id, expectedVersion: 2, toVersion: 99, source: 'user' }),
    WorkDocValidationError,
  );
  // A stale expectedVersion never even reaches the target lookup.
  await assert.rejects(
    () => service.rollback({ id: doc.id, expectedVersion: 1, toVersion: 1, source: 'user' }),
    WorkDocConflictError,
  );
});

// ---------------------------------------------------------------------------
// Listing, pagination, links
// ---------------------------------------------------------------------------

test('list filters by scope/chat/type/status with bounded deterministic pagination', async () => {
  const { service, store, chatId, chatB } = makeHarness();

  // Seeded with explicit createdAt stamps so ordering assertions are exact
  // (equal stamps would fall back to the deterministic id tie-break).
  const base = Date.parse('2026-11-23T00:00:00.000Z');
  const stamp = (offset: number): string => new Date(base + offset).toISOString();
  const docA = await store.create({ scope: 'project', chatId, type: 'report', title: 'A', content: 'A body', createdAt: stamp(0) });
  const docB = await store.create({ scope: 'project', chatId, type: 'plan', title: 'B', content: 'B body', createdAt: stamp(1) });
  const docC = await store.create({ scope: 'project', chatId: chatB, type: 'report', title: 'C', content: 'C body', createdAt: stamp(2) });
  const other = await service.create({ chatId: chatB, type: 'report', title: 'Other scope', content: 'Other body', scope: 'other' });
  void other;

  const all = await service.list({ scope: 'project', order: 'oldest' });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((doc) => doc.id), [docA.id, docB.id, docC.id]);

  const newest = await service.list({ scope: 'project' });
  assert.deepEqual(newest.map((doc) => doc.id), [docC.id, docB.id, docA.id]);

  const byChat = await service.list({ chatId, order: 'oldest' });
  assert.deepEqual(byChat.map((doc) => doc.id), [docA.id, docB.id]);

  const byType = await service.list({ type: 'plan' });
  assert.deepEqual(byType.map((doc) => doc.id), [docB.id]);

  const limited = await service.list({ scope: 'project', limit: 2, order: 'newest' });
  assert.deepEqual(limited.map((doc) => doc.id), [docC.id, docB.id]);

  await assert.rejects(() => service.list({ limit: WORK_DOC_LIST_LIMIT_MAX + 1 }), WorkDocValidationError);
  await assert.rejects(() => service.list({ limit: 0 }), WorkDocValidationError);
});

test('history listings are bounded and reorder deterministically', async () => {
  const { service } = makeHarness();
  const doc = await seedDoc(service, 'chat-1');
  for (let i = 0; i < 5; i += 1) {
    await service.update({ id: doc.id, expectedVersion: i + 1, title: `v${i + 2}`, source: 'agent' });
  }

  const oldestFirst = await service.listVersions({ id: doc.id });
  assert.deepEqual(oldestFirst.map((version) => version.version), [1, 2, 3, 4, 5, 6]);
  const newestFirst = await service.listVersions({ id: doc.id, order: 'newest' });
  assert.deepEqual(newestFirst.map((version) => version.version), [6, 5, 4, 3, 2, 1]);

  const page = await service.listVersions({ id: doc.id, limit: 2 });
  assert.deepEqual(page.map((version) => version.version), [1, 2]);

  const revisionsNewest = await service.listRevisions({ id: doc.id, order: 'newest', limit: 3 });
  assert.deepEqual(revisionsNewest.map((revision) => revision.toVersion), [6, 5, 4]);

  await assert.rejects(() => service.listVersions({ id: doc.id, limit: WORK_DOC_HISTORY_LIMIT_MAX + 1 }), WorkDocValidationError);
  await assert.rejects(() => service.listVersions({ id: '00000000-0000-4000-8000-00000000dead' }), WorkDocNotFoundError);
  await assert.rejects(() => service.listRevisions({ id: '00000000-0000-4000-8000-00000000dead' }), WorkDocNotFoundError);
});

test('links are typed, bounded, and idempotent per document/target tuple', async () => {
  const { service } = makeHarness();
  const doc = await seedDoc(service, 'chat-1');

  const first = await service.addLink({ id: doc.id, targetType: 'memory_block', targetId: '00000000-0000-4000-8000-000000000001', label: 'Source note' });
  const duplicate = await service.addLink({ id: doc.id, targetType: 'memory_block', targetId: '00000000-0000-4000-8000-000000000001', label: 'Different label' });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.label, 'Source note');

  const chatLink = await service.addLink({ id: doc.id, targetType: 'chat', targetId: 'other-chat' });
  const delegationLink = await service.addLink({ id: doc.id, targetType: 'delegation', targetId: 'del-1' });

  const links = await service.listLinks(doc.id);
  assert.equal(links.length, 3);
  assert.deepEqual(
    [...links.map((link) => link.targetType)].sort(),
    ['chat', 'delegation', 'memory_block'],
  );
  // Deterministic order: repeated listing returns the identical sequence
  // (same-millisecond links tie-break on id).
  const again = await service.listLinks(doc.id);
  assert.deepEqual(again.map((link) => link.id), links.map((link) => link.id));

  await assert.rejects(
    () => service.addLink({ id: '00000000-0000-4000-8000-0000000000ff', targetType: 'chat', targetId: 'x' }),
    WorkDocNotFoundError,
  );
  await assert.rejects(
    () => service.addLink({ id: doc.id, targetType: 'memory_block', targetId: 'x'.repeat(129) }),
    WorkDocValidationError,
  );
  void chatLink;
  void delegationLink;
});

// ---------------------------------------------------------------------------
// Service boundary behavior
// ---------------------------------------------------------------------------

test('the service requires an explicit store and maps invalid ids to validation errors', async () => {
  assert.throws(() => new WorkDocService({ store: undefined as unknown as InMemoryWorkDocStore }), WorkDocValidationError);
  const { service } = makeHarness();
  await assert.rejects(() => service.get('not-a-uuid'), WorkDocValidationError);
  await assert.rejects(() => service.listLinks('not-a-uuid'), WorkDocValidationError);
});

test('error messages never echo document or link content', async () => {
  const { service } = makeHarness();
  const doc = await seedDoc(service, 'chat-1');
  try {
    await service.update({
      id: '00000000-0000-4000-8000-0000000000ff',
      expectedVersion: 1,
      content: 'SECRET-BODY-CONTENT',
      source: 'agent',
    });
    assert.fail('expected rejection');
  } catch (error: unknown) {
    assert.ok(error instanceof WorkDocNotFoundError);
    assert.ok(!String(error.message).includes('SECRET-BODY-CONTENT'));
  }
  try {
    await service.update({ id: doc.id, expectedVersion: 42, title: 'x'.repeat(201), source: 'agent' });
    assert.fail('expected rejection');
  } catch (error: unknown) {
    assert.ok(error instanceof WorkDocValidationError);
    assert.ok(!String(error.message).includes('x'.repeat(201)));
  }
});

test('scope/chat ownership guards reject foreign-scope and foreign-chat mutations as 404', async () => {
  const { service } = makeHarness();
  const doc = await seedDoc(service, 'chat-1', { scope: 'owned' });

  // Matching guards pass.
  const updated = await service.update({
    id: doc.id,
    expectedVersion: 1,
    title: 'Allowed',
    source: 'agent',
    expectedScope: 'owned',
    expectedChatId: 'chat-1',
  });
  assert.equal(updated.title, 'Allowed');

  // A foreign chat id gets a 404 that never confirms cross-tenant existence.
  await assert.rejects(
    () => service.update({ id: doc.id, expectedVersion: 2, title: 'Nope', source: 'agent', expectedChatId: 'other-chat' }),
    (error: unknown) => error instanceof WorkDocNotFoundError && error.code === 'work_doc_not_found',
  );
  await assert.rejects(
    () => service.update({ id: doc.id, expectedVersion: 2, title: 'Nope', source: 'agent', expectedScope: 'elsewhere' }),
    WorkDocNotFoundError,
  );
  await assert.rejects(
    () => service.rollback({ id: doc.id, expectedVersion: 2, toVersion: 1, source: 'user', expectedChatId: 'other-chat' }),
    WorkDocNotFoundError,
  );
  await assert.rejects(
    () => service.addLink({ id: doc.id, targetType: 'chat', targetId: 'x', expectedScope: 'elsewhere' }),
    WorkDocNotFoundError,
  );

  // Every failed write left state untouched.
  const final = await service.get(doc.id);
  assert.equal(final?.title, 'Allowed');
  assert.equal(final?.version, 2);
  assert.equal((await service.listLinks(doc.id)).length, 0);
});
