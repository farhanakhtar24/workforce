/**
 * REAL DB probes for the query_data RLS boundary (migration
 * `20261125000100_query_data_rls`, applied): executes the EXACT transaction
 * the API runs (BEGIN READ ONLY → SET LOCAL workforce.user_id /
 * workforce.memory_scope → SET LOCAL ROLE workforce_query_reader → SELECT)
 * over a real Postgres connection as the application/table-owner role.
 *
 * Proven here, against the real database:
 * - `SELECT 1` works under the reader role;
 * - Better Auth tables ("Session"/"Account") are DENIED (no grants);
 * - tenant rows (WorkDoc/Delegation/AgentTask) are visible ONLY for the
 *   bound owner, memory blocks ONLY for the bound scope (fail-closed: unset
 *   settings see ZERO rows);
 * - child rows (WorkDocVersion, MemoryRelation) inherit parent visibility;
 * - `set_config` escalation is denied (GUC re-pointing can never happen);
 * - normal table-owner Prisma writes (the seeding below) still bypass RLS —
 *   ENABLE, never FORCE.
 *
 * Cleanup deletes ONLY this run's rows (run-unique chat ids/scopes/ids) and
 * its User rows. No legacy or user data is ever touched.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { PrismaClient } from '@workforce/core/generated/prisma';
import { userMemoryScope } from '@workforce/core/auth';
import { DEFAULT_DATABASE_URL } from '../src/config.js';
import { WorkDocService } from '@workforce/core/work-docs';
import { createPrismaWorkDocStore } from '@workforce/core/work-docs/postgres';

const DATABASE_URL = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`;

const OWNER_A = `rls-owner-a-${RUN_ID}`;
const OWNER_B = `rls-owner-b-${RUN_ID}`;
const SCOPE_A = userMemoryScope(OWNER_A);
const SCOPE_B = userMemoryScope(OWNER_B);
const DOC_CHAT_A = `rls-${RUN_ID}-doc-a`;
const DOC_CHAT_B = `rls-${RUN_ID}-doc-b`;
const PARENT_CHAT = `rls-${RUN_ID}-del`;
const TASK_NAME = `rls-${RUN_ID}-task`;

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

/** The EXACT isolation transaction the API's query_data runs. */
async function readerQuery(client: PoolClient, userId: string | null, scope: string | null, sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
  const values: string[] = [];
  if (userId !== null) {
    values.push(userId);
  }
  if (scope !== null) {
    values.push(scope);
  }
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = 8000`);
    if (userId !== null) {
      await client.query(`SET LOCAL workforce.user_id = '${userId}'`);
    }
    if (scope !== null) {
      await client.query(`SET LOCAL workforce.memory_scope = '${scope}'`);
    }
    await client.query('SET LOCAL ROLE workforce_query_reader');
    const result = await client.query(sql);
    await client.query('COMMIT');
    return { rows: result.rows as unknown as Array<Record<string, unknown>> };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

function pgClassOf(error: unknown): string {
  return String((error as { code?: string }).code ?? '');
}

after(async () => {
  // Run-scoped rows first, then the run User rows. The table-owner
  // connection does every delete (RLS is ENABLE, not FORCE — owners bypass).
  try {
    await prisma.memoryRelation.deleteMany({ where: { source: { scope: SCOPE_A } } });
    await prisma.memoryRelation.deleteMany({ where: { source: { scope: SCOPE_B } } });
    await prisma.memoryBlock.deleteMany({ where: { scope: { in: [SCOPE_A, SCOPE_B] } } });
    await prisma.workDoc.deleteMany({ where: { chatId: { in: [DOC_CHAT_A, DOC_CHAT_B] } } });
    await prisma.delegation.deleteMany({ where: { parentChatId: PARENT_CHAT } });
    await prisma.agentTask.deleteMany({ where: { name: TASK_NAME } });
    await prisma.user.deleteMany({ where: { id: { in: [OWNER_A, OWNER_B] } } });
  } catch (error) {
    void error;
  }
  await prisma.$disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

let memoryBlockA1 = '';
let memoryBlockA2 = '';
let relationId = '';

before(async () => {
  // 1. Run owner identities are REAL Better Auth rows (ownerId FKs target
  //    "User") — created FIRST so every seeded row's FK resolves.
  for (const [id, email] of [[OWNER_A, 'rls-owner-a@example.com'], [OWNER_B, 'rls-owner-b@example.com']] as const) {
    await prisma.user.upsert({
      where: { id },
      create: { id, email, name: 'rls probe owner' },
      update: {},
    });
  }
  // 2. Seeded rows with NORMAL owner writes (Prisma, table-owner bypass; RLS
  //    is ENABLED but NOT FORCE, which proves the migration did NOT break
  //    normal Prisma owner writes). --------
  const workDocs = new WorkDocService({ store: createPrismaWorkDocStore(prisma) });
  const docA = await workDocs.create({ scope: 'default', chatId: DOC_CHAT_A, type: 'report', title: 'A doc', content: 'A content', ownerId: OWNER_A });
  const docB = await workDocs.create({ scope: 'default', chatId: DOC_CHAT_B, type: 'report', title: 'B doc', content: 'B content', ownerId: OWNER_B });
  // An owned CAS update creates A's SECOND version (child-row probe). B's
  // doc stays at v1 (cross-user child invisibility probe).
  await workDocs.update({
    id: docA.id,
    expectedVersion: 1,
    content: 'A content v2',
    source: 'user',
    actorId: OWNER_A,
    expectedScope: 'default',
    expectedChatId: DOC_CHAT_A,
    expectedOwnerId: OWNER_A,
  });

  await prisma.delegation.create({
    data: {
      parentChatId: PARENT_CHAT,
      childChatId: randomUUID(),
      parentMessageId: 'pm-rls',
      scope: 'default',
      targetAgent: 'researcher',
      mode: 'async',
      task: 'rls probe task',
      depth: 1,
      ownerId: OWNER_A,
    },
  });
  await prisma.agentTask.create({
    data: {
      name: TASK_NAME,
      agentSlug: 'general',
      mode: 'action',
      prompt: 'p',
      recurrenceType: 'once',
      recurrenceConfig: { runAt: '2026-12-01T09:00:00.000Z' },
      ownerId: OWNER_A,
    },
  });

  // Two memory blocks in A's scope plus one in B's; a relation between A's.
  const insertBlock = (scope: string, content: string): Promise<string> =>
    prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "MemoryBlock" ("scope", "path", "kind", "content", "confidence", "embeddingStatus", "metadata")
      VALUES (${scope}, ${`rls/${RUN_ID}/${Math.random().toString(36).slice(2, 8)}`}, 'learning', ${content}, 0.9, 'ready', '{}')
      RETURNING "id"`
      .then((rows) => String(rows[0]?.id));
  memoryBlockA1 = await insertBlock(SCOPE_A, 'A block one content');
  memoryBlockA2 = await insertBlock(SCOPE_A, 'A block two content');
  await insertBlock(SCOPE_B, 'B block content');
  const relation = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "MemoryRelation" ("sourceId", "targetId", "type") VALUES (${memoryBlockA1}::uuid, ${memoryBlockA2}::uuid, 'supports') RETURNING "id"`;
  relationId = String(relation[0]?.id);
});

test('RLS probe: SELECT 1 works under the reader role with owner-bound settings', async () => {
  const client = await pool.connect();
  try {
    const { rows } = await readerQuery(client, OWNER_A, SCOPE_A, 'SELECT 1 AS one');
    assert.equal(Number(rows[0]?.one ?? -1), 1);
  } finally {
    client.release();
  }
});

test('RLS probe: Better Auth tables are DENIED to the reader role (no grants)', async () => {
  const client = await pool.connect();
  try {
    await assert.rejects(
      () => readerQuery(client, OWNER_A, SCOPE_A, 'SELECT * FROM "Session"'),
      (error: unknown) => pgClassOf(error) === '42501',
      'Session must be denied',
    );
    await assert.rejects(
      () => readerQuery(client, OWNER_A, SCOPE_A, 'SELECT * FROM "Account"'),
      (error: unknown) => pgClassOf(error) === '42501',
      'Account must be denied',
    );
  } finally {
    client.release();
  }
});

test('RLS probe: WorkDoc/Delegation/AgentTask visible ONLY for the bound owner', async () => {
  const client = await pool.connect();
  try {
    const asA = await readerQuery(client, OWNER_A, null, `SELECT "ownerId" FROM "WorkDoc" WHERE "chatId" = '${DOC_CHAT_A}'`);
    assert.equal(asA.rows.length, 1, 'owner A sees exactly its own doc');
    assert.equal(asA.rows[0]?.ownerId, OWNER_A);

    const asB = await readerQuery(client, OWNER_B, null, `SELECT "ownerId" FROM "WorkDoc" WHERE "chatId" = '${DOC_CHAT_A}'`);
    assert.equal(asB.rows.length, 0, 'owner B sees NOTHING of owner A');

    const unset = await readerQuery(client, null, null, 'SELECT "ownerId" FROM "WorkDoc" LIMIT 5');
    assert.equal(unset.rows.length, 0, 'unset user_id binding is fail-closed: zero rows');

    const delegationRows = await readerQuery(client, OWNER_A, null, `SELECT "ownerId" FROM "Delegation" WHERE "parentChatId" = '${PARENT_CHAT}'`);
    assert.equal(delegationRows.rows.length, 1);

    const taskRows = await readerQuery(client, OWNER_A, null, `SELECT "ownerId" FROM "AgentTask" WHERE "name" = '${TASK_NAME}'`);
    assert.equal(taskRows.rows.length, 1);
  } finally {
    client.release();
  }
});

test('RLS probe: child tables inherit parent visibility (WorkDocVersion, MemoryRelation)', async () => {
  const client = await pool.connect();
  try {
    const versions = await readerQuery(client, OWNER_A, null, `SELECT d."ownerId" FROM "WorkDocVersion" v JOIN "WorkDoc" d ON d."id" = v."documentId" WHERE d."chatId" = '${DOC_CHAT_A}'`);
    assert.ok(versions.rows.length >= 2, 'the A document versions (v1 + update) are visible to owner A');
    assert.ok(versions.rows.every((row) => row.ownerId === OWNER_A));

    const versionAsB = await readerQuery(client, OWNER_B, null, `SELECT v.id FROM "WorkDocVersion" v JOIN "WorkDoc" d ON d."id" = v."documentId" WHERE d."chatId" = '${DOC_CHAT_A}'`);
    assert.equal(versionAsB.rows.length, 0, 'child rows follow the parent owner: B sees none');

    const relationAsA = await readerQuery(client, null, SCOPE_A, 'SELECT "id" FROM "MemoryRelation"');
    assert.deepEqual(relationAsA.rows.map((row) => row.id), [relationId], 'the in-scope relation is visible to its owner scope');
    const relationAsB = await readerQuery(client, null, SCOPE_B, 'SELECT "id" FROM "MemoryRelation"');
    assert.equal(relationAsB.rows.length, 0);
  } finally {
    client.release();
  }
});

test('RLS probe: MemoryBlock visible ONLY for the bound memory scope', async () => {
  const client = await pool.connect();
  try {
    const asA = await readerQuery(client, null, SCOPE_A, 'SELECT "id" FROM "MemoryBlock"');
    assert.deepEqual(
      asA.rows.map((row) => row.id).sort(),
      [memoryBlockA1, memoryBlockA2].sort(),
      'exactly the two A-scope blocks',
    );
    const asB = await readerQuery(client, null, SCOPE_B, 'SELECT "id" FROM "MemoryBlock"');
    assert.equal(asB.rows.length, 1, 'exactly the one B-scope block');
    const unset = await readerQuery(client, null, null, 'SELECT "id" FROM "MemoryBlock" LIMIT 5');
    assert.equal(unset.rows.length, 0, 'unset scope binding is fail-closed');
  } finally {
    client.release();
  }
});

test('RLS probe: set_config escalation is DENIED at the database', async () => {
  const client = await pool.connect();
  try {
    await assert.rejects(
      () =>
        readerQuery(client, OWNER_A, SCOPE_A, `SELECT set_config('workforce.user_id', '${OWNER_B}', true) AS evil, "ownerId" FROM "WorkDoc"`),
      (error: unknown) => pgClassOf(error) === '42501',
      'the reader role can never re-point the owner GUC',
    );
    // Same denial inside the same transaction AFTER the settings were bound.
    await assert.rejects(
      () =>
        (async () => {
          await client.query('BEGIN READ ONLY');
          await client.query(`SET LOCAL workforce.user_id = '${OWNER_A}'`);
          await client.query('SET LOCAL ROLE workforce_query_reader');
          await client.query(`SELECT set_config('workforce.memory_scope', 'default', true)`);
        })(),
      (error: unknown) => pgClassOf(error) === '42501',
    );
  } finally {
    client.release();
  }
});
