import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemorySchedulerStore,
  SchedulerNotFoundError,
  SchedulerService,
  type AgentTask,
} from './index.js';

/**
 * Ownership regression tests: tasks/executions persist an optional `ownerId`
 * (executions INHERIT the task's owner); list/get/claim/mark/retry bind the
 * owner EXACTLY (ownerless legacy rows are NEVER visible to an owner filter
 * and never satisfy an owner guard); startup reconciliation picks active
 * tasks with `ownerId IS NOT NULL` via `ownedOnly`; and ALL legacy behavior
 * is unchanged when no owner argument is passed.
 */

const UUID_PREFIX = '00000000-0000-4000-8000-';
let counter = 0;

function nextId(): string {
  counter += 1;
  return `${UUID_PREFIX}${String(counter).padStart(12, '0')}`;
}

const OWNER_A = 'user-owner-aaaaaaaa';
const OWNER_B = 'user-owner-bbbbbbbb';

function makeService() {
  const store = new InMemorySchedulerStore();
  return { store, service: new SchedulerService({ store }) };
}

async function seedTask(
  service: SchedulerService,
  options: { name?: string; ownerId?: string | null; isActive?: boolean } = {},
): Promise<AgentTask> {
  const task = await service.createTask({
    id: nextId(),
    name: options.name ?? 'Owned task',
    agentSlug: 'analyst',
    mode: 'plan',
    prompt: 'Do the scheduled work.',
    recurrenceType: 'DAILY',
    recurrenceConfig: { hour: 5, minute: 30 },
    ...(options.ownerId !== null && options.ownerId !== undefined ? { ownerId: options.ownerId } : {}),
  });
  if (options.isActive === false) {
    return service.setTaskActive({ id: task.id, isActive: false });
  }
  return task;
}

test('createTask persists an explicit ownerId; omitting it stays ownerless (legacy)', async () => {
  const { service } = makeService();
  const owned = await seedTask(service, { ownerId: OWNER_A });
  assert.equal(owned.ownerId, OWNER_A);

  const legacy = await seedTask(service, { ownerId: null });
  assert.equal(legacy.ownerId, null);
});

test('listTasks: exact ownerId filter, ownedOnly excludes legacy ownerless, isActive composes', async () => {
  const { service } = makeService();
  const ownedActiveA = await seedTask(service, { ownerId: OWNER_A, name: 'a-active' });
  const ownedActiveB = await seedTask(service, { ownerId: OWNER_B, name: 'b-active' });
  const ownedInactive = await seedTask(service, { ownerId: OWNER_A, name: 'a-inactive', isActive: false });
  const legacyActive = await seedTask(service, { name: 'legacy-active' });

  // Exact-match filter: other owners' AND ownerless rows never appear.
  const forA = await service.listTasks({ ownerId: OWNER_A });
  assert.deepEqual(forA.map((task) => task.id).sort(), [ownedActiveA.id, ownedInactive.id].sort());

  // EXACT owner + active: the startup reconcile selector.
  const reconcile = await service.listTasks({ ownerId: OWNER_A, isActive: true, ownedOnly: true });
  assert.deepEqual(reconcile.map((task) => task.id), [ownedActiveA.id]);

  // ownedOnly without an exact owner: EXCLUDES every ownerless legacy task.
  const ownedOnly = await service.listTasks({ ownedOnly: true, isActive: true });
  assert.deepEqual(ownedOnly.map((task) => task.id).sort(), [ownedActiveA.id, ownedActiveB.id].sort());

  // No filters: the exact old behavior (legacy rows included).
  const everyone = await service.listTasks();
  assert.deepEqual(everyone.map((task) => task.id).sort(), [
    ownedActiveA.id,
    ownedActiveB.id,
    ownedInactive.id,
    legacyActive.id,
  ].sort());
});

test('owner-required reconcile excludes legacy ownerless active tasks', async () => {
  const { service } = makeService();
  const legacyActive = await seedTask(service, { name: 'legacy' });
  const ownedActive = await seedTask(service, { ownerId: OWNER_A });
  await seedTask(service, { ownerId: OWNER_A, isActive: false });

  const selected = await service.listTasks({ isActive: true, ownedOnly: true });
  assert.deepEqual(selected.map((task) => task.id), [ownedActive.id]);
  assert.ok(!selected.some((task) => task.id === legacyActive.id));
});

test('getTask/updateTask/setTaskActive enforce the owner guard (null/404, no oracle)', async () => {
  const { service } = makeService();
  const task = await seedTask(service, { ownerId: OWNER_A });
  const legacy = await seedTask(service, { ownerId: null });

  assert.equal(await service.getTask(task.id, { expectedOwnerId: OWNER_B }), null);
  assert.equal(await service.getTask(legacy.id, { expectedOwnerId: OWNER_A }), null);
  assert.equal((await service.getTask(task.id, { expectedOwnerId: OWNER_A }))?.id, task.id);
  // No guard: old behavior.
  assert.equal((await service.getTask(task.id))?.id, task.id);

  await assert.rejects(
    () => service.updateTask({ id: task.id, name: 'Hijack', expectedOwnerId: OWNER_B }),
    SchedulerNotFoundError,
  );
  await assert.rejects(
    () => service.updateTask({ id: legacy.id, name: 'Hijack', expectedOwnerId: OWNER_A }),
    SchedulerNotFoundError,
  );
  const patched = await service.updateTask({ id: task.id, name: 'Owned patch', expectedOwnerId: OWNER_A });
  assert.equal(patched.name, 'Owned patch');
  assert.equal(patched.ownerId, OWNER_A); // owner is never rewritten by a patch

  await assert.rejects(
    () => service.setTaskActive({ id: task.id, isActive: false, expectedOwnerId: OWNER_B }),
    SchedulerNotFoundError,
  );
  await assert.rejects(
    () => service.setTaskActive({ id: legacy.id, isActive: false, expectedOwnerId: OWNER_A }),
    SchedulerNotFoundError,
  );
  const paused = await service.setTaskActive({ id: task.id, isActive: false, expectedOwnerId: OWNER_A });
  assert.equal(paused.isActive, false);
});

test('executions inherit the task owner; explicit ownerId overrides; legacy tasks stay ownerless', async () => {
  const { service } = makeService();
  const owned = await seedTask(service, { ownerId: OWNER_A });
  const legacy = await seedTask(service, { ownerId: null });

  const inherited = await service.createExecution(owned, { scheduledFor: '2026-06-01T05:30:00.000Z', trigger: 'SCHEDULED' });
  assert.equal(inherited.execution.ownerId, OWNER_A);
  assert.equal(inherited.execution.chatId, inherited.execution.id);

  const explicit = await service.createExecution(owned, {
    scheduledFor: '2026-06-02T05:30:00.000Z',
    trigger: 'MANUAL',
    ownerId: OWNER_B,
  });
  assert.equal(explicit.execution.ownerId, OWNER_B);

  const ownerless = await service.createExecution(legacy, { scheduledFor: '2026-06-01T05:30:00.000Z', trigger: 'SCHEDULED' });
  assert.equal(ownerless.execution.ownerId, null);
});

test('listExecutions binds the owner exactly; ownerless legacy rows are invisible', async () => {
  const { service } = makeService();
  const owned = await seedTask(service, { ownerId: OWNER_A });
  const legacy = await seedTask(service, { ownerId: null });
  const mine = await service.createExecution(owned, { scheduledFor: '2026-06-01T05:30:00.000Z', trigger: 'MANUAL' });
  await service.createExecution(legacy, { scheduledFor: '2026-06-01T05:30:00.000Z', trigger: 'MANUAL' });

  const mineList = await service.listExecutions({ ownerId: OWNER_A });
  assert.deepEqual(mineList.map((execution) => execution.id), [mine.execution.id]);

  // Identical scheduledFor on two tenants: both rows exist; filters separate.
  const everyone = await service.listExecutions();
  assert.equal(everyone.length, 2);
  assert.deepEqual(await service.listExecutions({ ownerId: OWNER_B }), []);
});

test('getExecution with a foreign owner guard reads as null (no oracle)', async () => {
  const { service } = makeService();
  const owned = await seedTask(service, { ownerId: OWNER_A });
  const mine = await service.createExecution(owned, { scheduledFor: '2026-06-01T05:30:00.000Z', trigger: 'MANUAL' });

  assert.equal(await service.getExecution(mine.execution.id, { expectedOwnerId: OWNER_B }), null);
  assert.equal((await service.getExecution(mine.execution.id, { expectedOwnerId: OWNER_A }))?.id, mine.execution.id);
  assert.equal((await service.getExecution(mine.execution.id))?.id, mine.execution.id);
});

test('claim binds the owner BEFORE the CAS (no status/attempt oracle), then CAS rules', async () => {
  const { service } = makeService();
  const owned = await seedTask(service, { ownerId: OWNER_A });
  const created = await service.createExecution(owned, { scheduledFor: '2026-06-01T05:30:00.000Z', trigger: 'MANUAL' });
  const executionId = created.execution.id;

  // Foreign owner + wrong allowedFrom: owner wins first -> 404.
  await assert.rejects(
    () => service.claimExecution({ id: executionId, attempt: 1, allowedFrom: 'RETRYING', expectedOwnerId: OWNER_B }),
    SchedulerNotFoundError,
  );
  await assert.rejects(
    () => service.claimExecution({ id: executionId, attempt: 1, allowedFrom: 'PENDING', expectedOwnerId: OWNER_B }),
    SchedulerNotFoundError,
  );

  // Right owner: atomic CAS claim works.
  const claimed = await service.claimExecution({ id: executionId, attempt: 1, allowedFrom: 'PENDING', expectedOwnerId: OWNER_A });
  assert.equal(claimed.status, 'RUNNING');
  assert.equal(claimed.attempt, 1);

  // Stale CAS with the right owner stays a 409 (never a 404).
  await assert.rejects(
    () => service.claimExecution({ id: executionId, attempt: 2, allowedFrom: 'PENDING', expectedOwnerId: OWNER_A }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /was expected to be PENDING but is RUNNING/);
      return true;
    },
  );
});

test('mark transitions bind the owner and keep idempotent-repeat semantics', async () => {
  const { service } = makeService();
  const owned = await seedTask(service, { ownerId: OWNER_A });
  const created = await service.createExecution(owned, { scheduledFor: '2026-06-01T05:30:00.000Z', trigger: 'MANUAL' });
  const id = created.execution.id;
  await service.claimExecution({ id, attempt: 1, allowedFrom: 'PENDING', expectedOwnerId: OWNER_A });

  await assert.rejects(
    () => service.markDeadLetter({ id, error: 'boom', expectedOwnerId: OWNER_B }),
    SchedulerNotFoundError,
  );
  const dead = await service.markDeadLetter({ id, error: 'boom', expectedOwnerId: OWNER_A });
  assert.equal(dead.status, 'DEAD_LETTER');
  assert.equal(dead.ownerId, OWNER_A);

  // Same owner + equivalent payload: still idempotent.
  const repeat = await service.markDeadLetter({ id, error: 'boom', expectedOwnerId: OWNER_A });
  assert.equal(repeat.status, 'DEAD_LETTER');
  // Different payload with the right owner: still the typed conflict.
  await assert.rejects(
    () => service.markDeadLetter({ id, error: 'different', expectedOwnerId: OWNER_A }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /payload differs/);
      return true;
    },
  );
});

test('RETRY binds owners: a foreign/ownerless source reads as 404, legacy tasks keep old behavior', async () => {
  const { service } = makeService();
  // Task A (owner A) with a DEAD_LETTER source execution (inherits owner A).
  const taskA = await seedTask(service, { ownerId: OWNER_A });
  const source = await service.createExecution(taskA, { scheduledFor: '2026-06-01T05:30:00.000Z', trigger: 'MANUAL' });
  const sourceId = source.execution.id;
  await service.claimExecution({ id: sourceId, attempt: 1, allowedFrom: 'PENDING', expectedOwnerId: OWNER_A });
  await service.markDeadLetter({ id: sourceId, error: 'boom', expectedOwnerId: OWNER_A });

  // Different-owner task B retrying owner A's source: 404 BEFORE the
  // DEAD_LETTER/same-task checks (no cross-tenant oracle).
  const taskB = await seedTask(service, { ownerId: OWNER_B });
  await assert.rejects(
    () => service.createExecution(taskB, { trigger: 'RETRY', scheduledFor: '2026-06-02T05:30:00.000Z', retryOfExecutionId: sourceId }),
    SchedulerNotFoundError,
  );

  // Same-owner task retrying its own DEAD_LETTER source: works.
  const retryA = await service.createExecution(taskA, {
    trigger: 'RETRY',
    scheduledFor: '2026-06-02T05:30:00.000Z',
    retryOfExecutionId: sourceId,
  });
  assert.equal(retryA.created, true);
  assert.equal(retryA.execution.ownerId, OWNER_A);

  // Legacy ownerless task keeps the exact old permissive behavior: its OWN
  // DEAD_LETTER source (ownerless, same task) retries without any owner.
  const legacyTask = await seedTask(service, { ownerId: null });
  const legacySource = await service.createExecution(legacyTask, {
    scheduledFor: '2026-06-01T05:30:00.000Z',
    trigger: 'MANUAL',
  });
  const legacySourceId = legacySource.execution.id;
  await service.claimExecution({ id: legacySourceId, attempt: 1, allowedFrom: 'PENDING' });
  await service.markDeadLetter({ id: legacySourceId, error: 'boom' });
  const legacyRetry = await service.createExecution(legacyTask, {
    trigger: 'RETRY',
    scheduledFor: '2026-06-02T05:30:00.000Z',
    retryOfExecutionId: legacySourceId,
  });
  assert.equal(legacyRetry.created, true);
  assert.equal(legacyRetry.execution.ownerId, null);
});
