import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Prisma, type PrismaClient } from '@workforce/core/generated/prisma';

import { PrismaSchedulerStore } from './index.js';
import { SchedulerConflictError, SchedulerNotFoundError } from '../errors.js';

/**
 * Fake Prisma ONLY — proves the Prisma scheduler store keeps the SAME
 * ownership semantics as the in-memory store: createTask persists `ownerId`,
 * listTasks carries ownerId/ownedOnly/isActive filters into the where clause
 * (ownedOnly = ownerId IS NOT NULL), executions inherit the locked task row's
 * owner, claim/mark owner guards read foreign/ownerless rows as 404 BEFORE
 * the CAS, and a raced P2025 maps to the SAME typed 404.
 */

type AnyArgs = Record<string, unknown>;

const TASK_ID = '00000000-0000-4000-8000-000000000001';
const EXEC_ID = '00000000-0000-4000-8000-000000000002';
const TIMESTAMP = new Date('2026-11-23T00:00:00.000Z');
const OWNER_A = 'user-owner-aaaaaaaa';
const OWNER_B = 'user-owner-bbbbbbbb';

function pError(code: 'P2002' | 'P2025'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion: 'test' });
}

function taskRow(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: TASK_ID,
    name: 'T',
    agentSlug: 'analyst',
    mode: 'plan',
    prompt: 'P',
    scope: 'default',
    recurrenceType: 'daily',
    recurrenceConfig: { hour: 5, minute: 30 },
    skipDates: [],
    isActive: true,
    timezone: 'UTC',
    nextRunAt: null,
    ownerId: OWNER_A,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function executionRow(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: EXEC_ID,
    taskId: TASK_ID,
    retryOfExecutionId: null,
    scheduledFor: TIMESTAMP,
    trigger: 'manual',
    status: 'pending',
    attempt: 0,
    maxAttempts: 3,
    durationMs: null,
    tokenUsage: null,
    error: null,
    chatId: EXEC_ID,
    queueJobId: null,
    repeatJobKey: null,
    ownerId: OWNER_A,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    finishedAt: null,
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
  findFirstImpl: ((args: AnyArgs) => unknown) | null = null;

  async findUnique(args: AnyArgs): Promise<unknown> {
    this.calls.push('findUnique');
    return this.findUniqueImpl ? this.findUniqueImpl(args) : null;
  }

  async findMany(args: AnyArgs): Promise<unknown[]> {
    this.calls.push('findMany');
    this.data.push(args);
    return this.findManyImpl ? this.findManyImpl(args) : [];
  }

  async findFirst(args: AnyArgs): Promise<unknown> {
    this.calls.push('findFirst');
    return this.findFirstImpl ? this.findFirstImpl(args) : null;
  }

  async create(args: AnyArgs): Promise<unknown> {
    this.calls.push('create');
    this.data.push(args);
    if (this.createImpl) {
      return this.createImpl(args);
    }
    return { id: 'generated' };
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

  agentTask = new FakeModel();
  agentTaskExecution = new FakeModel();

  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    this.log.push([strings.join('?'), ...values.map((value) => String(value))].join(' | '));
    void values;
    void strings;
    return Promise.resolve([{ id: 'locked-row' }]);
  }

  $queryRawTyped = undefined;

  async $transaction<T>(work: (tx: FakePrisma) => Promise<T>): Promise<T> {
    this.log.push('tx:begin');
    return await work(this);
  }
}

function makeStore(prisma: FakePrisma): PrismaSchedulerStore {
  return new PrismaSchedulerStore(prisma as unknown as PrismaClient);
}

const TASK_CREATE = {
  name: 'T',
  agentSlug: 'analyst' as const,
  mode: 'plan' as const,
  prompt: 'P',
  scope: 'default',
  recurrenceType: 'DAILY' as const,
  recurrenceConfig: { hour: 5, minute: 30 },
};

test('createTask persists ownerId on the task row', async () => {
  const prisma = new FakePrisma();
  prisma.agentTask.createImpl = () => taskRow();

  await makeStore(prisma).createTask({ ...TASK_CREATE, ownerId: OWNER_A });
  assert.equal((prisma.agentTask.data[0]!.data as AnyArgs).ownerId, OWNER_A);

  const legacy = new FakePrisma();
  legacy.agentTask.createImpl = () => taskRow();
  await makeStore(legacy).createTask({ ...TASK_CREATE });
  assert.equal((legacy.agentTask.data[0]!.data as AnyArgs).ownerId, null);
});

test('listTasks carries ownerId/ownedOnly/isActive filters into the where clause', async () => {
  const prisma = new FakePrisma();
  prisma.agentTask.findManyImpl = () => [taskRow()];

  // Exact owner + reconciliation selector (exact match AND owner required).
  await makeStore(prisma).listTasks({ ownerId: OWNER_A, ownedOnly: true, isActive: true, order: 'newest', limit: 50 });
  const where = prisma.agentTask.data[0]!.where as AnyArgs;
  assert.deepEqual(where.ownerId, { equals: OWNER_A, not: null });
  assert.deepEqual(where.isActive, true);

  // Exact owner WITHOUT ownedOnly: the plain scalar filter.
  const exact = new FakePrisma();
  await makeStore(exact).listTasks({ ownerId: OWNER_A, order: 'newest', limit: 50 });
  assert.equal((exact.agentTask.data[0]!.where as AnyArgs).ownerId, OWNER_A);

  // ownedOnly WITHOUT an exact owner: ownerId IS NOT NULL only.
  const ownedOnly = new FakePrisma();
  ownedOnly.agentTask.findManyImpl = () => [];
  await makeStore(ownedOnly).listTasks({ ownedOnly: true, order: 'newest', limit: 50 });
  const ownedOnlyWhere = ownedOnly.agentTask.data[0]!.where as AnyArgs;
  assert.deepEqual(ownedOnlyWhere.ownerId, { not: null });
  assert.equal('isActive' in ownedOnlyWhere, false);

  // No filters: the legacy unfiltered shape.
  const noFilter = new FakePrisma();
  noFilter.agentTask.findManyImpl = () => [];
  await makeStore(noFilter).listTasks({ order: 'newest', limit: 50 });
  assert.deepEqual(noFilter.agentTask.data[0]!.where as AnyArgs, {});
});

test('executions inherit the LOCKED task row owner; explicit ownerId overrides', async () => {
  const prisma = new FakePrisma();
  prisma.agentTaskExecution.findFirstImpl = () => null;
  prisma.agentTaskExecution.createImpl = () => executionRow();

  // The lock probe supplies the authoritative row owner (ownerless task):
  prisma.$queryRaw = (() => Promise.resolve([{ id: TASK_ID, ownerId: null }])) as FakePrisma['$queryRaw'];
  await makeStore(prisma).createExecution({ id: TASK_ID } as never, {
    scheduledFor: '2026-06-01T05:30:00.000Z',
    trigger: 'MANUAL',
  });
  assert.equal((prisma.agentTaskExecution.data[0]!.data as AnyArgs).ownerId, null);

  // Owned task row -> execution inherits it.
  prisma.$queryRaw = (() => Promise.resolve([{ id: TASK_ID, ownerId: OWNER_B }])) as FakePrisma['$queryRaw'];
  await makeStore(prisma).createExecution({ id: TASK_ID } as never, {
    scheduledFor: '2026-06-02T05:30:00.000Z',
    trigger: 'MANUAL',
  });
  assert.equal((prisma.agentTaskExecution.data[1]!.data as AnyArgs).ownerId, OWNER_B);

  // Explicit ownerId overrides the inheritance.
  await makeStore(prisma).createExecution({ id: TASK_ID } as never, {
    scheduledFor: '2026-06-03T05:30:00.000Z',
    trigger: 'MANUAL',
    ownerId: OWNER_A,
  });
  assert.equal((prisma.agentTaskExecution.data[2]!.data as AnyArgs).ownerId, OWNER_A);
});

test('getTask/getExecution/listExecutions bind the owner exactly (null reads, where filters)', async () => {
  const prisma = new FakePrisma();
  prisma.agentTask.findUniqueImpl = () => taskRow();
  prisma.agentTaskExecution.findUniqueImpl = () => executionRow();

  assert.equal(await makeStore(prisma).getTask(TASK_ID, { expectedOwnerId: OWNER_B }), null);
  assert.equal((await makeStore(prisma).getTask(TASK_ID, { expectedOwnerId: OWNER_A }))?.ownerId, OWNER_A);
  assert.equal(await makeStore(prisma).getExecution(EXEC_ID, { expectedOwnerId: OWNER_B }), null);

  const listPrisma = new FakePrisma();
  await makeStore(listPrisma).listExecutions({ ownerId: OWNER_A, order: 'newest', limit: 20 });
  assert.equal((listPrisma.agentTaskExecution.data[0]!.where as AnyArgs).ownerId, OWNER_A);
});

test('claim/mark enforce the owner guard as 404 BEFORE the CAS', async () => {
  const prisma = new FakePrisma();
  prisma.agentTaskExecution.findUniqueImpl = () => executionRow({ status: 'pending' });

  await assert.rejects(
    () => makeStore(prisma).claimExecution({ id: EXEC_ID, attempt: 1, allowedFrom: 'PENDING', expectedOwnerId: OWNER_B }),
    SchedulerNotFoundError,
  );
  // Wrong owner + wrong allowedFrom: owner still wins first (no status oracle).
  await assert.rejects(
    () => makeStore(prisma).claimExecution({ id: EXEC_ID, attempt: 1, allowedFrom: 'RETRYING', expectedOwnerId: OWNER_B }),
    SchedulerNotFoundError,
  );
  prisma.agentTaskExecution.updateImpl = () => executionRow({ status: 'running', attempt: 1 });
  const claimed = await makeStore(prisma).claimExecution({ id: EXEC_ID, attempt: 1, allowedFrom: 'PENDING', expectedOwnerId: OWNER_A });
  assert.equal(claimed.status, 'RUNNING');
});

test('a raced P2025 on claim maps to the SAME typed 404; P2002 keeps the typed 409', async () => {
  const p2025 = new FakePrisma();
  p2025.agentTaskExecution.findUniqueImpl = () => executionRow();
  p2025.agentTaskExecution.updateImpl = () => {
    throw pError('P2025');
  };
  await assert.rejects(
    () => makeStore(p2025).claimExecution({ id: EXEC_ID, attempt: 1, allowedFrom: 'PENDING', expectedOwnerId: OWNER_A }),
    SchedulerNotFoundError,
  );

  const p2002 = new FakePrisma();
  p2002.agentTaskExecution.findUniqueImpl = () => executionRow();
  p2002.agentTaskExecution.updateImpl = () => {
    throw pError('P2002');
  };
  await assert.rejects(
    () => makeStore(p2002).claimExecution({ id: EXEC_ID, attempt: 1, allowedFrom: 'PENDING', expectedOwnerId: OWNER_A }),
    SchedulerConflictError,
  );
});

test('getTask keeps the legacy no-guard behavior and P2025 on updateTask maps to 404', async () => {
  const prisma = new FakePrisma();
  prisma.agentTask.findUniqueImpl = () => taskRow();
  assert.equal((await makeStore(prisma).getTask(TASK_ID))?.id, TASK_ID);

  const gone = new FakePrisma();
  gone.agentTask.updateImpl = () => {
    throw pError('P2025');
  };
  await assert.rejects(
    () => makeStore(gone).updateTask({ id: TASK_ID, name: 'Renamed' }),
    SchedulerNotFoundError,
  );
});
