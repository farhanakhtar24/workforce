import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryWorkDocStore,
  WorkDocConflictError,
  WorkDocNotFoundError,
  WorkDocService,
  WorkDocValidationError,
  type WorkDoc,
} from './index.js';

/**
 * Ownership regression tests (pre-Phase 6 foundation): owner ids are Better
 * Auth TEXT user ids; creation persists an optional `ownerId`; owner
 * filters/guards match EXACTLY (ownerless legacy rows are NEVER visible to an
 * owner filter), mismatching reads are null/404 with no existence oracle, and
 * ALL legacy behavior is unchanged when no owner argument is passed.
 */

let counter = 0;

function nextId(suffix: number): string {
  const hex = (counter * 100 + suffix).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

const OWNER_A = 'user-owner-aaaaaaaa';
const OWNER_B = 'user-owner-bbbbbbbb';

function makeHarness() {
  counter += 1;
  const store = new InMemoryWorkDocStore();
  const service = new WorkDocService({ store });
  const chatId = `chat-shared-${counter}`;
  return { store, service, chatId };
}

async function seedOwned(
  service: WorkDocService,
  chatId: string,
  ownerId: string | null,
  id: string,
): Promise<WorkDoc> {
  // The service-level create schema has NO `id` (store-level only); seed then
  // look the deterministic ordering up via the owner filter instead.
  void id;
  return service.create({
    chatId,
    type: 'report',
    title: 'Shared chat doc',
    content: 'Body content.',
    ...(ownerId !== null ? { ownerId } : {}),
  });
}

test('create persists an explicit ownerId; omitting it stays ownerless (legacy)', async () => {
  const { service, chatId } = makeHarness();
  const owned = await seedOwned(service, chatId, OWNER_A, nextId(1));
  assert.equal(owned.ownerId, OWNER_A);

  const legacy = await seedOwned(service, chatId, null, nextId(2));
  assert.equal(legacy.ownerId, null);
});

test('creating with an invalid owner id is a validation error', async () => {
  const { service, chatId } = makeHarness();
  await assert.rejects(
    () => service.create({ chatId, type: 'report', title: 'T', content: 'B', ownerId: '   ' }),
    WorkDocValidationError,
  );
  await assert.rejects(
    () => service.create({ chatId, type: 'report', title: 'T', content: 'B', ownerId: 'x'.repeat(129) }),
    WorkDocValidationError,
  );
});

test('two owners with identical scope+chatId never cross: owner filters are exact', async () => {
  const { service, chatId } = makeHarness();
  const docA = await seedOwned(service, chatId, OWNER_A, nextId(1));
  const docB = await seedOwned(service, chatId, OWNER_B, nextId(2));
  const legacy = await seedOwned(service, chatId, null, nextId(3));

  const ownedByA = await service.list({ chatId, ownerId: OWNER_A });
  assert.deepEqual(ownedByA.map((doc) => doc.id), [docA.id]);
  const ownedByB = await service.list({ chatId, ownerId: OWNER_B });
  assert.deepEqual(ownedByB.map((doc) => doc.id), [docB.id]);

  // Ownerless legacy rows are invisible to ANY owner filter...
  const noLegacy = await service.list({ chatId, ownerId: OWNER_A });
  assert.ok(!noLegacy.some((doc) => doc.id === legacy.id));
  // ...and to an owner guard, reading as absent (no existence oracle).
  assert.equal(await service.get(legacy.id, { expectedOwnerId: OWNER_A }), null);

  // No filter -> exactly the old full-chat behavior (legacy rows included).
  const everyone = await service.list({ chatId });
  assert.deepEqual(everyone.map((doc) => doc.id).sort(), [docA.id, docB.id, legacy.id].sort());
});

test('ownerless legacy docs stay invisible when an owner filter is supplied', async () => {
  const { service, chatId } = makeHarness();
  const legacy = await seedOwned(service, chatId, null, nextId(1));
  assert.equal(legacy.ownerId, null);

  assert.deepEqual(await service.list({ ownerId: OWNER_A }), []);
  assert.equal(await service.get(legacy.id, { expectedOwnerId: OWNER_A }), null);
  assert.equal((await service.get(legacy.id))?.id, legacy.id); // no filter: old behavior
});

test('get with a foreign owner filter reads as null (no oracle)', async () => {
  const { service, chatId } = makeHarness();
  const docA = await seedOwned(service, chatId, OWNER_A, nextId(1));

  assert.equal((await service.get(docA.id, { expectedOwnerId: OWNER_A }))?.id, docA.id);
  assert.equal(await service.get(docA.id, { expectedOwnerId: OWNER_B }), null);
  assert.equal((await service.get(docA.id))?.id, docA.id); // no filter: old behavior
});

test('mutations enforce the owner guard as 404 and never leak existence', async () => {
  const { service, chatId } = makeHarness();
  const docA = await seedOwned(service, chatId, OWNER_A, nextId(1));
  const legacy = await seedOwned(service, chatId, null, nextId(2));

  // Foreign owner -> 404 (same type as a missing document).
  await assert.rejects(
    () =>
      service.update({
        id: docA.id,
        expectedVersion: 1,
        title: 'Hijack',
        source: 'user',
        expectedOwnerId: OWNER_B,
      }),
    WorkDocNotFoundError,
  );
  // Ownerless legacy -> 404 under ANY owner guard.
  await assert.rejects(
    () =>
      service.update({
        id: legacy.id,
        expectedVersion: 1,
        title: 'Hijack',
        source: 'user',
        expectedOwnerId: OWNER_A,
      }),
    WorkDocNotFoundError,
  );

  // Matching owner: CAS still rules (stale version -> 409, not 404).
  await assert.rejects(
    () =>
      service.update({
        id: docA.id,
        expectedVersion: 7,
        title: 'Too late',
        source: 'user',
        expectedOwnerId: OWNER_A,
      }),
    WorkDocConflictError,
  );

  // Scope/chat guards compose with the owner guard.
  await assert.rejects(
    () =>
      service.update({
        id: docA.id,
        expectedVersion: 1,
        title: 'Wrong chat',
        source: 'user',
        expectedOwnerId: OWNER_A,
        expectedChatId: 'chat-foreign',
      }),
    WorkDocNotFoundError,
  );

  // Correct owner + expectedVersion -> wins; ownerId is never rewritten.
  const updated = await service.update({
    id: docA.id,
    expectedVersion: 1,
    title: 'Owned update',
    source: 'user',
    expectedOwnerId: OWNER_A,
  });
  assert.equal(updated.ownerId, OWNER_A);
  assert.equal(updated.version, 2);
});

test('rollback and addLink honor the owner guard too', async () => {
  const { service, chatId } = makeHarness();
  const docA = await seedOwned(service, chatId, OWNER_A, nextId(1));

  await assert.rejects(
    () =>
      service.rollback({
        id: docA.id,
        expectedVersion: 1,
        toVersion: 1,
        source: 'user',
        expectedOwnerId: OWNER_B,
      }),
    WorkDocNotFoundError,
  );
  const bumped = await service.update({
    id: docA.id,
    expectedVersion: 1,
    title: 'Bump',
    source: 'user',
    expectedOwnerId: OWNER_A,
  });
  assert.equal(bumped.version, 2);
  // Owner guard wrong -> 404 even though the version target is reachable.
  await assert.rejects(
    () =>
      service.rollback({
        id: docA.id,
        expectedVersion: 2,
        toVersion: 1,
        source: 'user',
        expectedOwnerId: OWNER_B,
      }),
    WorkDocNotFoundError,
  );
  const rolled = await service.rollback({
    id: docA.id,
    expectedVersion: 2,
    toVersion: 1,
    source: 'user',
    expectedOwnerId: OWNER_A,
  });
  assert.equal(rolled.version, 3);

  await assert.rejects(
    () =>
      service.addLink({
        id: docA.id,
        targetType: 'chat',
        targetId: 'target-1',
        expectedOwnerId: OWNER_B,
      }),
    WorkDocNotFoundError,
  );
  const link = await service.addLink({
    id: docA.id,
    targetType: 'chat',
    targetId: 'target-1',
    expectedOwnerId: OWNER_A,
  });
  assert.equal(link.documentId, docA.id);
});

test('history listings and links read as 404 under a foreign owner guard', async () => {
  const { service, chatId } = makeHarness();
  const docA = await seedOwned(service, chatId, OWNER_A, nextId(1));

  assert.deepEqual(await service.listVersions({ id: docA.id, expectedOwnerId: OWNER_A }), [
    (await service.listVersions({ id: docA.id }))[0],
  ]);
  await assert.rejects(
    () => service.listVersions({ id: docA.id, expectedOwnerId: OWNER_B }),
    WorkDocNotFoundError,
  );
  await assert.rejects(
    () => service.listRevisions({ id: docA.id, expectedOwnerId: OWNER_B }),
    WorkDocNotFoundError,
  );
  await assert.rejects(() => service.listLinks(docA.id, { expectedOwnerId: OWNER_B }), WorkDocNotFoundError);
});

test('store.get/list/listLinks accept the owner guards directly (both adapters share the contract)', async () => {
  const { store, service, chatId } = makeHarness();
  const docA = await seedOwned(service, chatId, OWNER_A, nextId(1));

  assert.equal(await store.get(docA.id, { expectedOwnerId: OWNER_B }), null);
  assert.deepEqual(await store.list({ chatId, ownerId: OWNER_A, order: 'newest', limit: 20 }), [docA]);
  assert.deepEqual(await store.list({ ownerId: OWNER_B, order: 'newest', limit: 20 }), []);
});
