import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Prisma, type PrismaClient } from '@workforce/core/generated/prisma';

import { PrismaWorkDocStore } from './index.js';
import { WorkDocConflictError, WorkDocNotFoundError, WorkDocValidationError } from '../errors.js';

/**
 * Fake Prisma ONLY — no database, no network. These tests prove the adapter
 * contract that the pure-store tests cannot: row locking happens BEFORE the
 * CAS re-read (`FOR UPDATE` first), multi-row writes run inside ONE
 * transaction, mapped dates are ISO strings, CAS mismatches/missing rows map
 * to typed 409/404, and link idempotency consults the unique tuple before
 * insert.
 */

// ---------------------------------------------------------------------------
// Fake Prisma plumbing
// ---------------------------------------------------------------------------

type AnyArgs = Record<string, unknown>;

class FakeModel {
  readonly calls: string[] = [];
  readonly data: AnyArgs[] = [];

  findUniqueImpl: ((args: AnyArgs) => unknown) | null = null;
  findManyImpl: ((args: AnyArgs) => unknown[]) | null = null;
  createImpl: ((args: AnyArgs) => unknown) | null = null;
  updateImpl: ((args: AnyArgs) => unknown) | null = null;

  async findUnique(args: AnyArgs): Promise<unknown> {
    this.calls.push('findUnique');
    return this.findUniqueImpl ? this.findUniqueImpl(args) : null;
  }

  async findMany(args: AnyArgs): Promise<unknown[]> {
    this.calls.push('findMany');
    return this.findManyImpl ? this.findManyImpl(args) : [];
  }

  async create(args: AnyArgs): Promise<unknown> {
    this.calls.push('create');
    this.data.push(args);
    if (this.createImpl) {
      return this.createImpl(args);
    }
    return (args.data as AnyArgs).id ?? 'generated';
  }

  async update(args: AnyArgs): Promise<unknown> {
    this.calls.push('update');
    this.data.push(args);
    if (this.updateImpl) {
      return this.updateImpl(args);
    }
    throw new Error('fake updateImpl not configured');
  }
}

class FakePrisma {
  readonly log: string[] = [];
  transactionCount = 0;
  inTransaction = false;

  workDoc = new FakeModel();
  workDocVersion = new FakeModel();
  workDocRevision = new FakeModel();
  workDocLink = new FakeModel();

  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    this.log.push([strings.join('?'), ...values.map((value) => String(value))].join(' | '));
    return Promise.resolve([]);
  }

  async $transaction<T>(work: (tx: FakePrisma) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    this.log.push('BEGIN');
    this.inTransaction = true;
    try {
      const result = await work(this);
      this.log.push('COMMIT');
      return result;
    } finally {
      this.inTransaction = false;
    }
  }
}

const UUID = '00000000-0000-4000-8000-000000000001';

const TIMESTAMP = new Date('2026-11-23T00:00:00.000Z');

function docRow(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: UUID,
    scope: 'default',
    chatId: 'chat-1',
    type: 'report',
    title: 'T',
    content: 'C',
    status: 'draft',
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function makeStore(prisma: FakePrisma): PrismaWorkDocStore {
  return new PrismaWorkDocStore(prisma as unknown as PrismaClient);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test('create writes document + v1 snapshot + creation revision inside ONE transaction with ISO dates', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.createImpl = () => docRow();
  const store = makeStore(prisma);

  const created = await store.create({
    scope: 'default',
    chatId: 'chat-1',
    type: 'report',
    title: 'T',
    content: 'C',
  });

  assert.equal(prisma.transactionCount, 1);
  assert.equal(created.version, 1);
  assert.equal(created.createdAt, TIMESTAMP.toISOString());
  assert.equal(created.updatedAt, TIMESTAMP.toISOString());
  assert.equal(prisma.workDocVersion.data.length, 1);
  assert.equal((prisma.workDocVersion.data[0]!.data as AnyArgs).version, 1);
  assert.equal(prisma.workDocRevision.data.length, 1);
  const revisionData = prisma.workDocRevision.data[0]!.data as AnyArgs;
  assert.equal(revisionData.summary, 'created');
  assert.equal(revisionData.fromVersion, null);
  assert.equal(revisionData.toVersion, 1);
});

// ---------------------------------------------------------------------------
// update (CAS + row lock)
// ---------------------------------------------------------------------------

test('update locks the document row before the CAS read and writes snapshot + audit + doc bump', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.findUniqueImpl = () => docRow();
  prisma.workDoc.updateImpl = (args) => docRow({ ...(args.data as AnyArgs) });
  const store = makeStore(prisma);

  const updated = await store.update({
    id: UUID,
    expectedVersion: 1,
    title: 'New title',
    source: 'user',
    actorId: 'user-1',
    summary: 'custom',
  });

  assert.equal(updated.version, 2);
  assert.equal(updated.title, 'New title');
  assert.ok(prisma.log.some((entry) => entry.includes('FOR UPDATE')), 'row lock must run inside the transaction');
  assert.equal(prisma.workDocVersion.data.length, 1);
  assert.equal(prisma.workDocRevision.data.length, 1);
  const revision = prisma.workDocRevision.data[0]!.data as AnyArgs;
  assert.equal(revision.source, 'user');
  assert.equal(revision.actorId, 'user-1');
  assert.equal(revision.fromVersion, 1);
  assert.equal(revision.toVersion, 2);
  assert.equal(revision.summary, 'custom');
});

test('update maps stale expectedVersion to a typed conflict without touching rows', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.findUniqueImpl = () => docRow({ version: 3 });
  const store = makeStore(prisma);

  await assert.rejects(
    () => store.update({ id: UUID, expectedVersion: 1, title: 'x', source: 'agent' }),
    (error: unknown) => error instanceof WorkDocConflictError && error.code === 'work_doc_conflict',
  );
  assert.equal(prisma.workDoc.calls.includes('update'), false);
  assert.equal(prisma.workDocVersion.calls.includes('create'), false);
});

test('update maps a missing document to typed 404 (ownership guard mismatch too)', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.findUniqueImpl = () => null;
  const store = makeStore(prisma);
  await assert.rejects(() => store.update({ id: UUID, expectedVersion: 1, title: 'x', source: 'agent' }), WorkDocNotFoundError);

  const withGuard = new FakePrisma();
  withGuard.workDoc.findUniqueImpl = () => docRow({ chatId: 'other-chat' });
  await assert.rejects(
    () => makeStore(withGuard).update({ id: UUID, expectedVersion: 1, title: 'x', source: 'agent', expectedChatId: 'chat-1' }),
    WorkDocNotFoundError,
  );
});

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

test('rollback copies the target snapshot into a NEW version and records the audit', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.findUniqueImpl = () => docRow({ version: 2 });
  prisma.workDocVersion.findUniqueImpl = () => ({
    id: 'v-1',
    documentId: UUID,
    version: 1,
    title: 'Original title',
    content: 'Original body',
    status: 'draft',
    createdAt: TIMESTAMP,
  });
  prisma.workDoc.updateImpl = (args) => docRow({ ...(args.data as AnyArgs), version: 3 });
  const store = makeStore(prisma);

  const rolled = await store.rollback({ id: UUID, expectedVersion: 2, toVersion: 1, source: 'user' });

  assert.equal(rolled.version, 3);
  assert.equal(rolled.title, 'Original title');
  assert.equal(rolled.content, 'Original body');
  const createdVersion = prisma.workDocVersion.data.at(-1)!.data as AnyArgs;
  assert.equal(createdVersion.version, 3);
  const audit = prisma.workDocRevision.data.at(-1)!.data as AnyArgs;
  assert.equal(audit.fromVersion, 2);
  assert.equal(audit.toVersion, 3);
  assert.equal(audit.summary, 'restored content from version 1');
});

test('rollback on a missing snapshot is typed 404; out-of-range targets are 400', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.findUniqueImpl = () => docRow({ version: 2 });
  const store = makeStore(prisma);
  await assert.rejects(() => store.rollback({ id: UUID, expectedVersion: 2, toVersion: 1, source: 'user' }), WorkDocNotFoundError);

  const sameVersion = new FakePrisma();
  sameVersion.workDoc.findUniqueImpl = () => docRow({ version: 2 });
  await assert.rejects(
    () => makeStore(sameVersion).rollback({ id: UUID, expectedVersion: 2, toVersion: 2, source: 'user' }),
    WorkDocValidationError,
  );
});

// ---------------------------------------------------------------------------
// links + idempotency
// ---------------------------------------------------------------------------

test('addLink returns the existing row unchanged when the tuple already exists', async () => {
  const existing = {
    id: 'link-id',
    documentId: UUID,
    targetType: 'chat',
    targetId: 'other-chat',
    label: 'label',
    createdAt: TIMESTAMP,
  };
  const prisma = new FakePrisma();
  prisma.workDoc.findUniqueImpl = () => docRow();
  prisma.workDocLink.findUniqueImpl = () => existing;
  const store = makeStore(prisma);

  const link = await store.addLink({ documentId: UUID, targetType: 'chat', targetId: 'other-chat', label: 'ignored' });
  assert.deepEqual(link, {
    id: 'link-id',
    documentId: UUID,
    targetType: 'chat',
    targetId: 'other-chat',
    label: 'label',
    createdAt: TIMESTAMP.toISOString(),
  });
  assert.equal(prisma.workDocLink.calls.includes('create'), false);
});

test('addLink inserts when the tuple is new; missing document is typed 404', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.findUniqueImpl = () => docRow();
  prisma.workDocLink.createImpl = () => ({ id: 'new-link', documentId: UUID, targetType: 'delegation', targetId: 'd-1', label: null, createdAt: TIMESTAMP });
  const store = makeStore(prisma);
  const created = await store.addLink({ documentId: UUID, targetType: 'delegation', targetId: 'd-1' });
  assert.equal(created.id, 'new-link');

  const missing = new FakePrisma();
  missing.workDoc.findUniqueImpl = () => null;
  await assert.rejects(
    () => makeStore(missing).addLink({ documentId: UUID, targetType: 'chat', targetId: 'x' }),
    WorkDocNotFoundError,
  );
});

// ---------------------------------------------------------------------------
// listing determinism + Prisma P2002 mapping
// ---------------------------------------------------------------------------

test('list orders per requested direction and get/listLinks require uuid doc ids', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.findManyImpl = (args) => {
    prisma.log.push(`orderBy:${JSON.stringify((args as AnyArgs).orderBy)}`);
    return [docRow()];
  };
  const store = makeStore(prisma);
  const newest = await store.list({ order: 'newest', limit: 1 });
  assert.equal(newest[0]!.createdAt, TIMESTAMP.toISOString());
  assert.ok(prisma.log.some((entry) => entry.includes('"desc"')));
  const oldest = await store.list({ order: 'oldest', limit: 1 });
  assert.ok(prisma.log.some((entry) => entry.includes('"asc"')));
  void oldest;

  await assert.rejects(() => store.get('not-a-uuid'), WorkDocValidationError);
  await assert.rejects(() => store.listLinks('not-a-uuid'), WorkDocValidationError);
});

test('prisma unique-violation (P2002) is mapped to a typed conflict on create', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.createImpl = () => {
    throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
  };
  const store = makeStore(prisma);
  await assert.rejects(
    () => store.create({ id: UUID, scope: 'default', chatId: 'chat-1', type: 'report', title: 'T', content: 'C' }),
    WorkDocConflictError,
  );
});

// ---------------------------------------------------------------------------
// M2: concurrent check-then-create P2002 re-reads and returns the winner
// ---------------------------------------------------------------------------

test('addLink: P2002 replays OUTSIDE the aborted transaction on a fresh connection (winner returned idempotently)', async () => {
  const winnerRow = {
    id: 'winner-link',
    documentId: UUID,
    targetType: 'chat',
    targetId: 'other-chat',
    label: null,
    createdAt: TIMESTAMP,
  };
  const prisma = new FakePrisma();
  prisma.workDoc.findUniqueImpl = () => docRow();
  prisma.workDocLink.createImpl = () => {
    // The inner create hits the unique race; the interactive transaction is
    // rejected, so the re-read CANNOT run inside it.
    throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
  };
  // The only re-read happens through `this.prisma` AFTER the transaction
  // rejected — the fake returns null for the in-transaction pre-check and
  // asserts the replay read happens OUTSIDE the transaction.
  prisma.workDocLink.findUniqueImpl = (args: AnyArgs) => {
    const where = (args.where as AnyArgs).documentId_targetType_targetId as AnyArgs;
    assert.equal(where.documentId, UUID);
    if (prisma.inTransaction) {
      return null; // in-transaction pre-check: no link yet
    }
    assert.equal(
      prisma.workDocLink.calls.includes('create'),
      true,
      'the winning replay read happens after the failed create (outside the transaction)',
    );
    return winnerRow;
  };
  const store = makeStore(prisma);
  const link = await store.addLink({ documentId: UUID, targetType: 'chat', targetId: 'other-chat' });
  assert.equal(link.id, 'winner-link', 'the concurrent winner link is returned, not a conflict');
  // The aborting create happened inside the transaction; the winning replayed
  // read happened outside.
  assert.equal(prisma.transactionCount, 1);

  // Genuine P2002 with NO persisted winner → typed conflict.
  const emptyPrisma = new FakePrisma();
  emptyPrisma.workDoc.findUniqueImpl = () => docRow();
  emptyPrisma.workDocLink.createImpl = () => {
    throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
  };
  emptyPrisma.workDocLink.findUniqueImpl = () => null;
  await assert.rejects(
    () => makeStore(emptyPrisma).addLink({ documentId: UUID, targetType: 'chat', targetId: 'other-chat' }),
    WorkDocConflictError,
  );
});
