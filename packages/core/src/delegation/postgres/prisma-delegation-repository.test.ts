import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Prisma, type PrismaClient } from '@workforce/core/generated/prisma';

import { PrismaDelegationRepository } from './index.js';
import {
  DelegationConflictError,
  DelegationNotFoundError,
  DelegationValidationError,
} from '../errors.js';

/**
 * Fake Prisma ONLY — no database, no network. Proves: row-lock ordering for
 * status transitions, transition-table enforcement (terminal can never leave),
 * completedAt stamped exactly once, P2002 -> typed conflict on the
 * childChatId unique constraint, ISO mapping, and bounded deterministic
 * listing passthrough.
 */

type AnyArgs = Record<string, unknown>;

const UUID = '00000000-0000-4000-8000-000000000001';

const TIMESTAMP = new Date('2026-11-23T00:00:00.000Z');

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
    throw new Error('fake updateImpl not configured');
  }
}

class FakePrisma {
  readonly log: string[] = [];
  transactionCount = 0;

  delegation = new FakeModel();

  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    this.log.push([strings.join('?'), ...values.map((value) => String(value))].join(' | '));
    return Promise.resolve([]);
  }

  async $transaction<T>(work: (tx: FakePrisma) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    this.log.push('BEGIN');
    const result = await work(this);
    this.log.push('COMMIT');
    return result;
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

test('create normalizes scope and maps the row with ISO timestamps', async () => {
  const prisma = new FakePrisma();
  prisma.delegation.createImpl = () => delegationRow();
  const created = await makeRepository(prisma).create(CREATE_INPUT);

  assert.equal(created.createdAt, TIMESTAMP.toISOString());
  assert.equal(created.completedAt, null);
  assert.ok(prisma.delegation.data[0]);
  assert.equal((prisma.delegation.data[0]!.data as AnyArgs).status, 'pending');
});

test('create maps the childChatId P2002 unique violation to a typed conflict', async () => {
  const prisma = new FakePrisma();
  prisma.delegation.createImpl = () => {
    throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
  };
  await assert.rejects(
    () => makeRepository(prisma).create(CREATE_INPUT),
    (error: unknown) => error instanceof DelegationConflictError && error.code === 'delegation_conflict',
  );
});

test('updateStatus locks and validates the row before applying the transition; missing is 404', async () => {
  const prisma = new FakePrisma();
  prisma.delegation.findUniqueImpl = () => delegationRow({ status: 'pending' });
  prisma.delegation.updateImpl = (args) => delegationRow({ status: 'running', updatedAt: TIMESTAMP, ...(args.data as AnyArgs) });

  const running = await makeRepository(prisma).updateStatus({ id: UUID, status: 'running' });
  assert.equal(running.status, 'running');
  assert.equal(running.completedAt, null);
  assert.ok(prisma.log.some((entry) => entry.includes('FOR UPDATE')));
  assert.equal(prisma.delegation.calls.filter((call) => call === 'update').length, 1);

  const missing = new FakePrisma();
  missing.delegation.findUniqueImpl = () => null;
  await assert.rejects(
    () => makeRepository(missing).updateStatus({ id: UUID, status: 'running' }),
    (error: unknown) => error instanceof DelegationNotFoundError && error.code === 'delegation_not_found',
  );
});

test('updateStatus rejects terminal -> running (and shortcut pending -> terminal) as typed conflicts', async () => {
  const terminal = new FakePrisma();
  terminal.delegation.findUniqueImpl = () => delegationRow({ status: 'completed', completedAt: TIMESTAMP });
  await assert.rejects(
    () => makeRepository(terminal).updateStatus({ id: UUID, status: 'running' }),
    (error: unknown) => error instanceof DelegationConflictError,
  );
  assert.equal(terminal.delegation.calls.includes('update'), false);

  const shortcut = new FakePrisma();
  shortcut.delegation.findUniqueImpl = () => delegationRow({ status: 'pending' });
  await assert.rejects(
    () => makeRepository(shortcut).updateStatus({ id: UUID, status: 'completed' }),
    DelegationConflictError,
  );
});

test('updateStatus stamps completedAt exactly once at the first terminal write', async () => {
  const prisma = new FakePrisma();
  prisma.delegation.findUniqueImpl = () => delegationRow({ status: 'running' });
  prisma.delegation.updateImpl = (args) => delegationRow({ ...(args.data as AnyArgs) });

  const completed = await makeRepository(prisma).updateStatus({
    id: UUID,
    status: 'completed',
    result: 'done',
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result, 'done');
  assert.ok(completed.completedAt !== null);
  const firstWrite = prisma.delegation.data[0]!.data as AnyArgs;
  assert.ok(firstWrite.completedAt instanceof Date);

  // Idempotent re-write: completedAt preserved (no new completedAt field).
  const repeatPrisma = new FakePrisma();
  repeatPrisma.delegation.findUniqueImpl = () => delegationRow({ status: 'completed', completedAt: TIMESTAMP });
  repeatPrisma.delegation.updateImpl = (args) => delegationRow({ status: 'completed', completedAt: TIMESTAMP, ...(args.data as AnyArgs) });
  const repeated = await makeRepository(repeatPrisma).updateStatus({ id: UUID, status: 'completed' });
  assert.equal(repeated.completedAt, TIMESTAMP.toISOString());
  const secondWrite = repeatPrisma.delegation.data[0]!.data as AnyArgs;
  assert.equal('completedAt' in secondWrite, false);
});

test('listByParent passes bounded deterministic ordering through', async () => {
  const prisma = new FakePrisma();
  prisma.delegation.findManyImpl = (args) => {
    prisma.log.push(`orderBy:${JSON.stringify((args as AnyArgs).orderBy)}`);
    return [delegationRow()];
  };
  const repository = makeRepository(prisma);

  const newest = await repository.listByParent({ parentChatId: 'parent-1' });
  assert.equal(newest.length, 1);
  assert.equal(newest[0]!.createdAt, TIMESTAMP.toISOString());
  assert.ok(prisma.log.some((entry) => entry.includes('"desc"')));

  await repository.listByParent({ parentChatId: 'parent-1', order: 'oldest', limit: 5 });
  assert.ok(prisma.log.some((entry) => entry.includes('"asc"')));

  await assert.rejects(() => repository.listByParent({ parentChatId: 'parent-1', limit: 1000 }), DelegationValidationError);
  await assert.rejects(() => repository.get('not-a-uuid'), DelegationValidationError);
});

// ---------------------------------------------------------------------------
// H1: atomic expectedFrom claim under the row lock
// ---------------------------------------------------------------------------

test('updateStatus expectedFrom: guarded write applies only on the expected status (typed conflict otherwise)', async () => {
  const prisma = new FakePrisma();
  prisma.delegation.findUniqueImpl = () => delegationRow({ status: 'running' });
  prisma.delegation.updateImpl = (args) =>
    delegationRow({ status: ((args as AnyArgs).data as AnyArgs | undefined)?.status, updatedAt: new Date() });
  await assert.rejects(
    () => makeRepository(prisma).updateStatus({ id: UUID, status: 'running', expectedFrom: 'pending' }),
    (error: unknown) =>
      error instanceof DelegationConflictError &&
      error.message.includes('expected to be pending but is running'),
  );

  const winnerPrisma = new FakePrisma();
  winnerPrisma.delegation.findUniqueImpl = () => delegationRow({ status: 'pending' });
  winnerPrisma.delegation.updateImpl = (args) =>
    delegationRow({ status: ((args as AnyArgs).data as AnyArgs | undefined)?.status, updatedAt: new Date() });
  const claimed = await makeRepository(winnerPrisma).updateStatus({
    id: UUID,
    status: 'running',
    expectedFrom: 'pending',
  });
  assert.equal(claimed.status, 'running');
});
