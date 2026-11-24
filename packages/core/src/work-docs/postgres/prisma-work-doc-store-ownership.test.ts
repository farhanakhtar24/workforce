import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Prisma, type PrismaClient } from '@workforce/core/generated/prisma';

import { PrismaWorkDocStore } from './index.js';
import { WorkDocNotFoundError } from '../errors.js';

/**
 * Fake Prisma ONLY — proves the Prisma adapter keeps the SAME ownership
 * semantics as the in-memory store: create persists `ownerId`, list filters
 * put the owner into the SQL where clause, get/listLinks owner guards read
 * foreign/ownerless rows as null/404, and a raced P2025 on a locked CAS write
 * maps to the SAME typed 404.
 */

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
    this.data.push(args);
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
    return (args.data as AnyArgs);
  }
}

class FakePrisma {
  readonly log: string[] = [];

  workDoc = new FakeModel();
  workDocVersion = new FakeModel();
  workDocRevision = new FakeModel();
  workDocLink = new FakeModel();

  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    this.log.push([strings.join('?'), ...values.map((value) => String(value))].join(' | '));
    return Promise.resolve([{ id: 'locked-row' }]);
  }

  async $transaction<T>(work: (tx: FakePrisma) => Promise<T>): Promise<T> {
    this.log.push('BEGIN');
    return await work(this);
  }
}

const UUID = '00000000-0000-4000-8000-000000000001';
const TIMESTAMP = new Date('2026-11-23T00:00:00.000Z');
const OWNER_A = 'user-owner-aaaaaaaa';
const OWNER_B = 'user-owner-bbbbbbbb';

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
    ownerId: OWNER_A,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function makeStore(prisma: FakePrisma): PrismaWorkDocStore {
  return new PrismaWorkDocStore(prisma as unknown as PrismaClient);
}

const CREATE_BASE = {
  scope: 'default',
  chatId: 'chat-1',
  type: 'report' as const,
  title: 'T',
  content: 'C',
};

test('create persists ownerId on the document row', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.createImpl = () => docRow();
  const store = makeStore(prisma);

  await store.create({ ...CREATE_BASE, ownerId: OWNER_A });

  assert.equal((prisma.workDoc.data[0]!.data as AnyArgs).ownerId, OWNER_A);
});

test('list puts the exact owner filter into the where clause', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.findManyImpl = () => [docRow()];
  const store = makeStore(prisma);

  await store.list({ chatId: 'chat-1', ownerId: OWNER_A, order: 'newest', limit: 20 });
  const where = prisma.workDoc.data[0]!.where as AnyArgs;
  assert.equal(where.ownerId, OWNER_A);

  // Absent filter: where stays owner-free (legacy unfiltered behavior).
  const noFilter = new FakePrisma();
  noFilter.workDoc.findManyImpl = () => [];
  await makeStore(noFilter).list({ chatId: 'chat-1', order: 'newest', limit: 20 });
  assert.equal('ownerId' in (noFilter.workDoc.data[0]!.where as AnyArgs), false);
});

test('get/listLinks read foreign owners as null (owner guard in the adapter)', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.findUniqueImpl = () => docRow({ ownerId: OWNER_A });
  const store = makeStore(prisma);

  assert.equal(await store.get(UUID, { expectedOwnerId: OWNER_B }), null);
  assert.equal((await store.get(UUID, { expectedOwnerId: OWNER_A }))?.ownerId, OWNER_A);
  await assert.rejects(() => store.listLinks(UUID, { expectedOwnerId: OWNER_B }), WorkDocNotFoundError);
  // Ownerless legacy row under an owner guard reads as null.
  const ownerless = new FakePrisma();
  ownerless.workDoc.findUniqueImpl = () => docRow({ ownerId: null });
  assert.equal(await makeStore(ownerless).get(UUID, { expectedOwnerId: OWNER_A }), null);
  // No guard: old behavior.
  assert.equal((await makeStore(prisma).get(UUID))?.id, UUID);
});

test('update enforces the owner guard as 404 BEFORE the CAS', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.findUniqueImpl = () => docRow();
  prisma.workDoc.updateImpl = (args) => docRow({ ...(args.data as AnyArgs), updatedAt: TIMESTAMP });
  const store = makeStore(prisma);

  await assert.rejects(
    () => store.update({ id: UUID, expectedVersion: 1, title: 'Hijack', source: 'user', expectedOwnerId: OWNER_B }),
    WorkDocNotFoundError,
  );
  const ok = await store.update({ id: UUID, expectedVersion: 1, title: 'Ok', source: 'user', expectedOwnerId: OWNER_A });
  assert.equal(ok.version, 2);
});

test('a raced P2025 on the locked CAS write maps to the SAME typed 404', async () => {
  const prisma = new FakePrisma();
  prisma.workDoc.findUniqueImpl = () => docRow({ ownerId: OWNER_A });
  prisma.workDoc.updateImpl = () => {
    throw new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: 'test' });
  };
  const store = makeStore(prisma);

  await assert.rejects(
    () => store.update({ id: UUID, expectedVersion: 1, title: 'Ok', source: 'user', expectedOwnerId: OWNER_A }),
    WorkDocNotFoundError,
  );
});
