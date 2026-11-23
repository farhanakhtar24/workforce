import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DELEGATION_MAX_ERROR_LENGTH,
  DELEGATION_MAX_TASK_LENGTH,
  InMemoryDelegationRepository,
  MAX_DELEGATION_DEPTH,
  DelegationConflictError,
  DelegationNotFoundError,
  DelegationValidationError,
  canTransitionDelegation,
  delegationTransitions,
  parseDelegationInput,
  createDelegationInputSchema,
  type Delegation,
  type ParsedDelegationCreateInput,
} from './index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let counter = 0;

type CreateOverrides = Partial<ParsedDelegationCreateInput>;

function makeCreateInput(overrides?: CreateOverrides): ParsedDelegationCreateInput {
  counter += 1;
  return {
    scope: 'default',
    parentChatId: `parent-${counter}`,
    childChatId: `child-${counter}`,
    parentMessageId: `message-${counter}`,
    targetAgent: 'analyst' as const,
    mode: 'async' as const,
    task: 'Analyze the Q3 dataset',
    depth: 1,
    ...overrides,
  };
}

async function seed(
  repository: InMemoryDelegationRepository,
  overrides?: CreateOverrides,
): Promise<Delegation> {
  return repository.create(makeCreateInput(overrides));
}

// ---------------------------------------------------------------------------
// Schemas and bounds
// ---------------------------------------------------------------------------

test('delegation schemas enforce documented bounds and child-depth vocabulary', () => {
  const parsed = parseDelegationInput(createDelegationInputSchema, makeCreateInput({ scope: 'Atlas_Team' }));
  assert.equal(parsed.scope, 'atlas_team');
  assert.equal(parsed.task, 'Analyze the Q3 dataset');

  assert.throws(
    () => parseDelegationInput(createDelegationInputSchema, makeCreateInput({ depth: 0 })),
    /delegation input \(depth:/,
  );
  assert.throws(
    () => parseDelegationInput(createDelegationInputSchema, makeCreateInput({ depth: MAX_DELEGATION_DEPTH + 1 })),
    DelegationValidationError,
  );
  assert.throws(
    () => parseDelegationInput(createDelegationInputSchema, makeCreateInput({ task: 'x'.repeat(DELEGATION_MAX_TASK_LENGTH + 1) })),
    DelegationValidationError,
  );
  assert.throws(
    () => parseDelegationInput(createDelegationInputSchema, makeCreateInput({ targetAgent: 'orchestrator' as unknown as 'analyst' })),
    DelegationValidationError,
  );
  assert.throws(
    () => parseDelegationInput(createDelegationInputSchema, { ...makeCreateInput(), rogue: true }),
    DelegationValidationError,
  );
  assert.throws(
    () => parseDelegationInput(createDelegationInputSchema, makeCreateInput({ childChatId: '' })),
    DelegationValidationError,
  );
});

test('the transition table encodes pending -> running -> terminal, no shortcuts', () => {
  assert.deepEqual([...delegationTransitions.pending], ['running']);
  assert.deepEqual([...delegationTransitions.running], ['completed', 'failed', 'timeout']);
  assert.deepEqual([...delegationTransitions.completed], []);
  assert.deepEqual([...delegationTransitions.failed], []);
  assert.deepEqual([...delegationTransitions.timeout], []);

  assert.equal(canTransitionDelegation('pending', 'running'), true);
  assert.equal(canTransitionDelegation('running', 'completed'), true);
  assert.equal(canTransitionDelegation('running', 'failed'), true);
  assert.equal(canTransitionDelegation('running', 'timeout'), true);
  // Direct shortcut pending -> terminal is NOT allowed.
  assert.equal(canTransitionDelegation('pending', 'completed'), false);
  assert.equal(canTransitionDelegation('pending', 'failed'), false);
  // Terminal states never leave.
  assert.equal(canTransitionDelegation('completed', 'running'), false);
  assert.equal(canTransitionDelegation('failed', 'running'), false);
  assert.equal(canTransitionDelegation('timeout', 'running'), false);
  assert.equal(canTransitionDelegation('completed', 'pending'), false);
  assert.equal(canTransitionDelegation('completed', 'failed'), false);
  // Idempotent same-status writes are always allowed.
  for (const status of ['pending', 'running', 'completed', 'failed', 'timeout'] as const) {
    assert.equal(canTransitionDelegation(status, status), true, `${status} -> ${status} must be idempotent`);
  }
});

// ---------------------------------------------------------------------------
// Repository lifecycle
// ---------------------------------------------------------------------------

test('create records a pending delegation and getByChild resolves the 1:1 mapping', async () => {
  const repository = new InMemoryDelegationRepository();
  const created = await seed(repository, { mode: 'sync', targetAgent: 'researcher', depth: 2 });

  assert.equal(created.status, 'pending');
  assert.equal(created.result, null);
  assert.equal(created.error, null);
  assert.equal(created.completedAt, null);
  assert.equal(created.targetAgent, 'researcher');
  assert.equal(created.mode, 'sync');
  assert.equal(created.depth, 2);

  const byChild = await repository.getByChild(created.childChatId);
  assert.equal(byChild?.id, created.id);
  assert.equal(await repository.getByChild('unknown-child'), null);
  const fetched = await repository.get(created.id);
  assert.equal(fetched?.id, created.id);
  assert.equal(await repository.get('00000000-0000-4000-8000-0000000000ff'), null);
});

test('duplicate childChatId is a conflict; scope normalization is applied', async () => {
  const repository = new InMemoryDelegationRepository();
  const first = await seed(repository, { scope: 'Atlas_Team' });
  assert.equal(first.scope, 'atlas_team');

  await assert.rejects(
    () => repository.create(makeCreateInput({ childChatId: first.childChatId })),
    (error: unknown) => error instanceof DelegationConflictError && error.code === 'delegation_conflict',
  );
});

test('updateStatus walks pending -> running -> completed and stamps completedAt once', async () => {
  const repository = new InMemoryDelegationRepository();
  const created = await seed(repository);

  const running = await repository.updateStatus({ id: created.id, status: 'running' });
  assert.equal(running.status, 'running');
  assert.equal(running.completedAt, null);

  const completed = await repository.updateStatus({
    id: created.id,
    status: 'completed',
    result: 'Analysis finished with 12 findings',
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result, 'Analysis finished with 12 findings');
  assert.ok(completed.completedAt !== null);

  // Idempotent same-status write: terminal state kept, completedAt preserved.
  const repeated = await repository.updateStatus({
    id: created.id,
    status: 'completed',
    result: 'Repeated write',
  });
  assert.equal(repeated.status, 'completed');
  assert.equal(repeated.completedAt, completed.completedAt);
  assert.equal(repeated.result, 'Repeated write');
});

test('failure and timeout paths carry bounded safe error text', async () => {
  const repository = new InMemoryDelegationRepository();
  const failing = await seed(repository);
  await repository.updateStatus({ id: failing.id, status: 'running' });
  const failed = await repository.updateStatus({
    id: failing.id,
    status: 'failed',
    error: 'child worker reported: invalid dataset scope',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'child worker reported: invalid dataset scope');
  assert.ok(failed.completedAt !== null);

  const timingOut = await seed(repository, { mode: 'sync' });
  await repository.updateStatus({ id: timingOut.id, status: 'running' });
  const timedOut = await repository.updateStatus({ id: timingOut.id, status: 'timeout' });
  assert.equal(timedOut.status, 'timeout');
  assert.ok(timedOut.completedAt !== null);

  await assert.rejects(
    () => repository.updateStatus({ id: failing.id, status: 'failed', error: 'e'.repeat(DELEGATION_MAX_ERROR_LENGTH + 1) }),
    DelegationValidationError,
  );
});

test('illegal transitions (terminal -> running, pending -> terminal) are typed 409 conflicts', async () => {
  const repository = new InMemoryDelegationRepository();
  const created = await seed(repository);

  // pending -> completed shortcut is rejected.
  await assert.rejects(
    () => repository.updateStatus({ id: created.id, status: 'completed' }),
    (error: unknown) => error instanceof DelegationConflictError && error.code === 'delegation_conflict',
  );

  await repository.updateStatus({ id: created.id, status: 'running' });
  await repository.updateStatus({ id: created.id, status: 'completed' });

  // Terminal -> running rejected; terminal -> pending rejected.
  await assert.rejects(() => repository.updateStatus({ id: created.id, status: 'running' }), DelegationConflictError);
  await assert.rejects(() => repository.updateStatus({ id: created.id, status: 'pending' }), DelegationConflictError);

  // The record is untouched by the failed writes.
  const after = await repository.get(created.id);
  assert.equal(after?.status, 'completed');
  assert.equal(await repository.updateStatus({ id: created.id, status: 'completed' }).then((d) => d.status), 'completed');

  await assert.rejects(
    () => repository.updateStatus({ id: '00000000-0000-4000-8000-0000000000ff', status: 'running' }),
    (error: unknown) => error instanceof DelegationNotFoundError && error.code === 'delegation_not_found',
  );
});

test('listByParent is deterministic (createdAt then id) and bounded', async () => {
  const repository = new InMemoryDelegationRepository();
  const base = Date.parse('2026-11-23T00:00:00.000Z');
  const first = await seed(repository, { parentChatId: 'parent-shared', createdAt: new Date(base) });
  const second = await seed(repository, { parentChatId: 'parent-shared', createdAt: new Date(base + 1) });
  const third = await seed(repository, { parentChatId: 'parent-shared', createdAt: new Date(base + 2) });
  await seed(repository, { parentChatId: 'parent-other' });

  const newest = await repository.listByParent({ parentChatId: 'parent-shared' });
  assert.deepEqual(newest.map((delegation) => delegation.id), [third.id, second.id, first.id]);

  const oldest = await repository.listByParent({ parentChatId: 'parent-shared', order: 'oldest' });
  assert.deepEqual(oldest.map((delegation) => delegation.id), [first.id, second.id, third.id]);

  const page = await repository.listByParent({ parentChatId: 'parent-shared', limit: 2 });
  assert.equal(page.length, 2);
  assert.deepEqual(page.map((delegation) => delegation.id), [third.id, second.id]);

  await assert.rejects(
    () => repository.listByParent({ parentChatId: 'parent-shared', limit: 500 }),
    DelegationValidationError,
  );
});

test('immutability: returned records are structured clones safe from caller mutation', async () => {
  const repository = new InMemoryDelegationRepository();
  const created = await seed(repository);
  (created as { status?: string }).status = 'hacked';
  const fetched = await repository.get(created.id);
  assert.equal(fetched?.status, 'pending');
});

test('depth helpers re-exported from the agent cap stay consistent', async () => {
  const { allowsDelegation, childDepth, ROOT_AGENT_DEPTH } = await import('./index.js');
  assert.equal(ROOT_AGENT_DEPTH, 0);
  assert.equal(allowsDelegation(0), true);
  assert.equal(allowsDelegation(1), true);
  assert.equal(allowsDelegation(2), false);
  assert.equal(childDepth(1), 2);
  assert.throws(() => childDepth(2));
});

// ---------------------------------------------------------------------------
// H1: atomic expectedFrom claim (concurrent claimants, exactly one winner)
// ---------------------------------------------------------------------------

test('updateStatus expectedFrom claim: pending → running wins once; losers get typed conflicts', async () => {
  const repo = new InMemoryDelegationRepository();
  const created = await repo.create(makeCreateInput());

  await assert.rejects(
    () => repo.updateStatus({ id: created.id, status: 'running', expectedFrom: 'failed' }),
    DelegationConflictError,
  );

  const claimed = await repo.updateStatus({ id: created.id, status: 'running', expectedFrom: 'pending' });
  assert.equal(claimed.status, 'running');

  // A second candidate racing for the same pending claim conflicts; a
  // same-status write WITHOUT expectedFrom stays idempotent.
  await assert.rejects(
    () => repo.updateStatus({ id: created.id, status: 'running', expectedFrom: 'pending' }),
    DelegationConflictError,
  );
  const refreshed = await repo.updateStatus({ id: created.id, status: 'running' });
  assert.equal(refreshed.status, 'running');
});

test('CONCURRENT deferred claims: exactly ONE transition to running of N candidates', async () => {
  const repo = new InMemoryDelegationRepository();
  const created = await repo.create(makeCreateInput());

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const claims = Array.from({ length: 5 }, () => (async () => {
    await gate;
    try {
      const row = await repo.updateStatus({ id: created.id, status: 'running', expectedFrom: 'pending' });
      return { won: true as const, row };
    } catch (error) {
      if (error instanceof DelegationConflictError) {
        return { won: false as const };
      }
      throw error;
    }
  })());

  release();
  const settled = await Promise.all(claims);
  const winners = settled.filter((outcome) => outcome.won);
  assert.equal(winners.length, 1, 'exactly one claimant transitions pending → running');

  const persisted = await repo.get(created.id);
  assert.equal(persisted?.status, 'running');
});
