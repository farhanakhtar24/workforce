/**
 * Focused offline tests for the DB-enforced `query_data` isolation
 * (pre-Phase 6 fix): the transaction binds the authenticated owner context
 * into per-transaction GUCs and executes ONLY as the restricted
 * `workforce_query_reader` role (NOLOGIN, NOBYPASSRLS; SELECT-only on the
 * nine policy-bound data tables per migration
 * `20261125000100_query_data_rls`). The owner context is required,
 * charset-validated, and only ever comes from the resolved request identity —
 * never from the SQL, the body, or query strings. `SELECT 1` keeps working.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { userMemoryScope } from '@workforce/core/auth';
import { TEST_OWNER } from './helpers.js';
import {
  createDataQueryService,
  type QueryClientLike,
  type QueryPoolLike,
} from '../src/agents/data-query.js';

const OWNER = { ownerId: TEST_OWNER.userId, memoryScope: userMemoryScope(TEST_OWNER.userId) };

interface FakePg {
  pool: QueryPoolLike;
  statements: string[];
  released: { held: boolean };
  errorNext: Error | null;
}

function fakePg(): FakePg {
  const state: FakePg = {
    statements: [],
    released: { held: false },
    errorNext: null,
    // eslint-disable-next-line -- assigned below
    pool: null as unknown as QueryPoolLike,
  };
  const client: QueryClientLike = {
    async query(text: string) {
      state.statements.push(text);
      if (state.errorNext !== null) {
        const error = state.errorNext;
        state.errorNext = null;
        throw error;
      }
      return { rows: [{ id: 'r' }], fields: [{ name: 'id' }], rowCount: 1 };
    },
    release() {
      state.released.held = true;
    },
  };
  state.pool = { connect: async () => client };
  return state;
}

test('query: BEGIN → timeout → owner GUCs → SET LOCAL ROLE → user SELECT (as the reader role) → COMMIT → DISCARD', async () => {
  const pg = fakePg();
  const service = createDataQueryService({ pool: pg.pool, statementTimeoutMs: 2000, rowCap: 10 });
  const result = await service.query('SELECT 1', undefined, OWNER);
  assert.equal(result.rowCount, 1, 'SELECT 1 keeps working under the reader role');
  assert.deepEqual(pg.statements, [
    'BEGIN READ ONLY',
    'SET LOCAL statement_timeout = 2000',
    `SET LOCAL workforce.user_id = '${TEST_OWNER.userId}'`,
    `SET LOCAL workforce.memory_scope = '${userMemoryScope(TEST_OWNER.userId)}'`,
    'SET LOCAL ROLE workforce_query_reader',
    'SELECT * FROM (SELECT 1) AS __workforce_rows LIMIT 11',
    'COMMIT',
    'DISCARD ALL',
  ]);
});

test('query: the owner context is REQUIRED (fail-closed) and charset-validated before any DB touch', async () => {
  const pg = fakePg();
  const service = createDataQueryService({ pool: pg.pool, statementTimeoutMs: 100, rowCap: 5 });
  // Missing context never reaches the database.
  await assert.rejects(() => service.query('SELECT 1'), (error: unknown) => (error as { kind: string }).kind === 'invalid');
  await assert.rejects(
    () => service.query('SELECT 1', undefined, { ownerId: 'bad;owner', memoryScope: OWNER.memoryScope }),
    (error: unknown) => (error as { kind: string }).kind === 'invalid',
  );
  await assert.rejects(
    () => service.query('SELECT 1', undefined, { ownerId: OWNER.ownerId, memoryScope: `x'; DROP SCHEMA public;--` }),
    (error: unknown) => (error as { kind: string }).kind === 'invalid',
  );
  assert.equal(pg.statements.length, 0, 'no statement ever ran without a valid context');
});

test('query: session-state vectors stay screened (set_config can never re-point the RLS GUCs)', async () => {
  const pg = fakePg();
  const service = createDataQueryService({ pool: pg.pool, statementTimeoutMs: 100, rowCap: 5 });
  for (const sql of [
    `SELECT set_config('workforce.user_id', 'someone-else', true)`,
    `SELECT pg_catalog.set_config('workforce.memory_scope', 'default', true)`,
    `SELECT CASE WHEN true THEN set_config('a','b',true) ELSE 1 END`,
    `SELECT current_setting('workforce.user_id', true)`,
    'SELECT pg_advisory_lock(1)',
    'SELECT 1; SELECT 2',
  ] as const) {
    await assert.rejects(
      () => service.query(sql, undefined, OWNER),
      (error: unknown) => (error as { kind: string }).kind === 'invalid',
      sql,
    );
  }
  assert.equal(pg.statements.length, 0, 'nothing beyond SELECT-only single statements reaches the pool');
});

test('query: isolation failures map to honest 503 (missing role / denied privileges), never a weaker fallback', async () => {
  const pg = fakePg();
  pg.errorNext = Object.assign(new Error('role "workforce_query_reader" is not a member of role...'), { code: '42501' });
  const service = createDataQueryService({ pool: pg.pool, statementTimeoutMs: 100, rowCap: 5 });
  await assert.rejects(
    () => service.query('SELECT 1', undefined, OWNER),
    (error: unknown) => (error as { kind: string }).kind === 'unavailable' && (error as { message: string }).message.includes('query failed'),
  );
  assert.equal(pg.released.held, true, 'the client is always released back to the pool');
});
