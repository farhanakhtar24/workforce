import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryDelegationRepository,
  DelegationNotFoundError,
  DelegationValidationError,
} from './index.js';

/**
 * Ownership regression tests: creation persists an optional `ownerId`; owner
 * filters/guards match EXACTLY (ownerless legacy rows are NEVER visible to an
 * owner filter); `getByChild`/`updateStatus` bind the owner WITHOUT breaking
 * the atomic `expectedFrom` claim; and ALL legacy behavior is unchanged when
 * no owner argument is passed.
 */

const UUID_PREFIX = '00000000-0000-4000-8000-';
let counter = 0;

function nextId(): string {
  counter += 1;
  return `${UUID_PREFIX}${String(counter).padStart(12, '0')}`;
}

const OWNER_A = 'user-owner-aaaaaaaa';
const OWNER_B = 'user-owner-bbbbbbbb';

function makeHarness() {
  counter += 1;
  const repo = new InMemoryDelegationRepository();
  const parentChatId = `parent-shared-${counter}`;
  return { repo, parentChatId };
}

async function seed(
  repo: InMemoryDelegationRepository,
  parentChatId: string,
  childChatId: string,
  ownerId: string | null,
): Promise<string> {
  const row = await repo.create({
    id: nextId(),
    parentChatId,
    childChatId,
    parentMessageId: 'message-1',
    targetAgent: 'analyst',
    mode: 'sync',
    task: 'Do the thing.',
    depth: 1,
    ...(ownerId !== null ? { ownerId } : {}),
  });
  return row.id;
}

test('create persists an explicit ownerId; omitting it stays ownerless (legacy)', async () => {
  const { repo, parentChatId } = makeHarness();
  const row = await repo.create({
    parentChatId,
    childChatId: 'child-owned',
    parentMessageId: 'message-1',
    targetAgent: 'analyst',
    mode: 'sync',
    task: 'Do the thing.',
    depth: 1,
    ownerId: OWNER_A,
  });
  assert.equal(row.ownerId, OWNER_A);

  const legacy = await repo.create({
    parentChatId,
    childChatId: 'child-legacy',
    parentMessageId: 'message-1',
    targetAgent: 'analyst',
    mode: 'sync',
    task: 'Do the thing.',
    depth: 1,
  });
  assert.equal(legacy.ownerId, null);
});

test('invalid owner ids are validation errors', async () => {
  const { repo, parentChatId } = makeHarness();
  await assert.rejects(
    () =>
      repo.create({
        parentChatId,
        childChatId: 'child-1',
        parentMessageId: 'message-1',
        targetAgent: 'analyst',
        mode: 'sync',
        task: 'Do the thing.',
        depth: 1,
        ownerId: '   ',
      }),
    DelegationValidationError,
  );
  await assert.rejects(
    () =>
      repo.create({
        parentChatId,
        childChatId: 'child-2',
        parentMessageId: 'message-1',
        targetAgent: 'analyst',
        mode: 'sync',
        task: 'Do the thing.',
        depth: 1,
        ownerId: 'x'.repeat(129),
      }),
    DelegationValidationError,
  );
});

test('two owners sharing identical parentChatId never cross (child ids are globally unique)', async () => {
  const { repo, parentChatId } = makeHarness();
  const idA = await seed(repo, parentChatId, 'child-a', OWNER_A);
  const idB = await seed(repo, parentChatId, 'child-b', OWNER_B);
  const idLegacy = await seed(repo, parentChatId, 'child-legacy', null);

  const forA = await repo.listByParent({ parentChatId, ownerId: OWNER_A });
  assert.deepEqual(forA.map((row) => row.id), [idA]);
  const forB = await repo.listByParent({ parentChatId, ownerId: OWNER_B });
  assert.deepEqual(forB.map((row) => row.id), [idB]);

  // Ownerless legacy rows are invisible to ANY owner filter...
  const noLegacy = await repo.listByParent({ parentChatId, ownerId: OWNER_A });
  assert.ok(!noLegacy.some((row) => row.id === idLegacy));
  // ...and to an owner guard on the child lookup (no existence oracle).
  assert.equal(await repo.getByChild('child-legacy', { expectedOwnerId: OWNER_A }), null);

  // No filter -> the old full-parent behavior (legacy rows included).
  const everyone = await repo.listByParent({ parentChatId });
  assert.deepEqual(everyone.map((row) => row.id).sort(), [idA, idB, idLegacy].sort());

  // Child lookups bind the owner exactly.
  assert.equal((await repo.getByChild('child-a', { expectedOwnerId: OWNER_A }))?.id, idA);
  assert.equal(await repo.getByChild('child-a', { expectedOwnerId: OWNER_B }), null);
  await assert.rejects(() => repo.getByChild('child-a', { expectedOwnerId: '   ' }), DelegationValidationError);
});

test('ownerless legacy delegations stay invisible when an owner filter is supplied', async () => {
  const { repo, parentChatId } = makeHarness();
  const idLegacy = await seed(repo, parentChatId, 'child-legacy', null);

  assert.deepEqual(await repo.listByParent({ parentChatId, ownerId: OWNER_A }), []);
  assert.equal(await repo.get(idLegacy, { expectedOwnerId: OWNER_A }), null);
  assert.equal(await repo.getByChild('child-legacy', { expectedOwnerId: OWNER_A }), null);
  // No filter: the exact old behavior.
  assert.equal((await repo.get(idLegacy))?.id, idLegacy);
});

test('updateStatus binds the owner BEFORE the atomic expectedFrom claim (no status oracle)', async () => {
  const { repo, parentChatId } = makeHarness();
  const idA = await seed(repo, parentChatId, 'child-a', OWNER_A);

  // Foreign owner + wrong claim status: the OWNER wins first -> 404, never a
  // status/claim oracle.
  await assert.rejects(
    () => repo.updateStatus({ id: idA, status: 'running', expectedOwnerId: OWNER_B, expectedFrom: 'pending' }),
    DelegationNotFoundError,
  );
  // Wrong owner alone -> 404.
  await assert.rejects(
    () => repo.updateStatus({ id: idA, status: 'running', expectedOwnerId: OWNER_B }),
    DelegationNotFoundError,
  );
  // Invalid owner guard shape (empty) -> 400 before anything else.
  await assert.rejects(
    () => repo.updateStatus({ id: idA, status: 'running', expectedOwnerId: '  ' }),
    DelegationValidationError,
  );

  // Right owner + expectedFrom: the atomic claim still works exactly once.
  const claimed = await repo.updateStatus({ id: idA, status: 'running', expectedOwnerId: OWNER_A, expectedFrom: 'pending' });
  assert.equal(claimed.status, 'running');
  await assert.rejects(
    () => repo.updateStatus({ id: idA, status: 'running', expectedOwnerId: OWNER_A, expectedFrom: 'pending' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /was expected to be pending/);
      return true;
    },
  );
});

test('ownerless legacy rows read as 404 under any expectedOwnerId guard', async () => {
  const { repo, parentChatId } = makeHarness();
  const idLegacy = await seed(repo, parentChatId, 'child-legacy', null);

  await assert.rejects(
    () => repo.updateStatus({ id: idLegacy, status: 'running', expectedOwnerId: OWNER_A }),
    DelegationNotFoundError,
  );
  // No guard: the old status machine applies untouched.
  const moved = await repo.updateStatus({ id: idLegacy, status: 'running' });
  assert.equal(moved.status, 'running');
});
