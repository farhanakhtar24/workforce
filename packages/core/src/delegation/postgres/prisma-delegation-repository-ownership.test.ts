import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Prisma, type PrismaClient } from '@workforce/core/generated/prisma';

import { PrismaDelegationRepository } from './index.js';
import { DelegationNotFoundError } from '../errors.js';

/**
 * Fake Prisma ONLY — proves the Prisma repository keeps the SAME ownership
 * semantics as the in-memory store: create persists `ownerId`, listByParent
 * carries the owner filter into the where clause, get/getByChild owner guards
 * read foreign/ownerless rows as null, updateStatus binds the owner BEFORE
 * the `expectedFrom` claim, and a raced P2025 maps to the SAME typed 404.
 */

type AnyArgs = Record<string, unknown>;

const UUID = '00000000-0000-4000-8000-000000000001';
const TIMESTAMP = new Date('2026-11-23T00:00:00.000Z');
const OWNER_A = 'user-owner-aaaaaaaa';
const OWNER_B = 'user-owner-bbbbbbbb';

function delegationRow(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: UUID,
    scope: 'default',
    parentChatId: 'parent-1',
    childChatId: 'child-1',
    parentMessageId: 'message-1',
    targetAgent: 'analyst',
    mode: 'async',
    status: 'pending',
    task: 'task text',
    result: null,
    error: null,
    depth: 1,
    ownerId: OWNER_A,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    completedAt: null,
    ...overrides,
  };
}

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
    return delegationRow((args.data as AnyArgs) ?? {});
  }

  async update(args: AnyArgs): Promise<unknown> {
    this.calls.push('update');
    this.data.push(args);
    if (this.updateImpl) {
      return this.updateImpl(args);
    }
    return delegationRow({
      ...Object.fromEntries(Object.entries((args.data as AnyArgs) ?? {}).filter(([key]) => key !== 'where')),
      updatedAt: TIMESTAMP,
    });
  }
}

class FakePrisma {
  readonly log: string[] = [];

  delegation = new FakeModel();

  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    this.log.push([strings.join('?'), ...values.map((value) => String(value))].join(' | '));
    return Promise.resolve([{ id: 'locked-row' }]);
  }

  async $transaction<T>(work: (tx: FakePrisma) => Promise<T>): Promise<T> {
    this.log.push('BEGIN');
    return await work(this);
  }
}

function makeRepository(prisma: FakePrisma): PrismaDelegationRepository {
  return new PrismaDelegationRepository(prisma as unknown as PrismaClient);
}

const CREATE_INPUT = {
  scope: 'default',
  parentChatId: 'parent-1',
  childChatId: 'child-1',
  parentMessageId: 'message-1',
  targetAgent: 'analyst' as const,
  mode: 'async' as const,
  task: 'task text',
  depth: 1,
};

test('create persists ownerId; omitting it creates a legacy ownerless row', async () => {
  const owned = new FakePrisma();
  await makeRepository(owned).create({ ...CREATE_INPUT, ownerId: OWNER_A });
  assert.equal((owned.delegation.data[0]!.data as AnyArgs).ownerId, OWNER_A);

  const legacy = new FakePrisma();
  await makeRepository(legacy).create({ ...CREATE_INPUT });
  assert.equal((legacy.delegation.data[0]!.data as AnyArgs).ownerId, null);
});

test('listByParent carries the owner filter into the where clause', async () => {
  const prisma = new FakePrisma();
  prisma.delegation.findManyImpl = () => [delegationRow()];

  await makeRepository(prisma).listByParent({ parentChatId: 'parent-1', ownerId: OWNER_A });
  assert.equal((prisma.delegation.data[0]!.where as AnyArgs).ownerId, OWNER_A);

  const noFilter = new FakePrisma();
  await makeRepository(noFilter).listByParent({ parentChatId: 'parent-1' });
  assert.equal('ownerId' in (noFilter.delegation.data[0]!.where as AnyArgs), false);
});

test('get/getByChild owner guards read foreign/ownerless rows as null', async () => {
  const prisma = new FakePrisma();
  prisma.delegation.findUniqueImpl = () => delegationRow();

  assert.equal(await makeRepository(prisma).get(UUID, { expectedOwnerId: OWNER_B }), null);
  assert.equal((await makeRepository(prisma).get(UUID, { expectedOwnerId: OWNER_A }))?.ownerId, OWNER_A);
  assert.equal(await makeRepository(prisma).getByChild('child-1', { expectedOwnerId: OWNER_B }), null);

  const ownerless = new FakePrisma();
  ownerless.delegation.findUniqueImpl = () => delegationRow({ ownerId: null });
  assert.equal(await makeRepository(ownerless).get(UUID, { expectedOwnerId: OWNER_A }), null);
  assert.equal((await makeRepository(ownerless).get(UUID))?.id, UUID); // no guard: old behavior
});

test('updateStatus binds the owner BEFORE the atomic expectedFrom claim', async () => {
  const prisma = new FakePrisma();
  prisma.delegation.findUniqueImpl = () => delegationRow({ status: 'pending' });

  // Wrong owner BEFORE any claim logic -> 404 (not the status conflict).
  await assert.rejects(
    () => makeRepository(prisma).updateStatus({ id: UUID, status: 'running', expectedOwnerId: OWNER_B, expectedFrom: 'pending' }),
    DelegationNotFoundError,
  );
  assert.ok(!prisma.delegation.calls.includes('update'));

  const ok = await makeRepository(prisma).updateStatus({ id: UUID, status: 'running', expectedOwnerId: OWNER_A, expectedFrom: 'pending' });
  assert.equal(ok.status, 'running');
});

test('a raced P2025 on the locked status write maps to the SAME typed 404', async () => {
  const prisma = new FakePrisma();
  prisma.delegation.findUniqueImpl = () => delegationRow();
  prisma.delegation.updateImpl = () => {
    throw new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: 'test' });
  };

  await assert.rejects(
    () => makeRepository(prisma).updateStatus({ id: UUID, status: 'running', expectedOwnerId: OWNER_A }),
    DelegationNotFoundError,
  );
});
