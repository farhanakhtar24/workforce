/**
 * `query_data` tests (Phase 4): pure statement screening + row-cap wrapping +
 * the read-only transaction service (fake pool) + the REST route. No live
 * Postgres: the pool is an in-process fake; Postgres error-code semantics
 * (57014 statement timeout, 25006 read-only) are encoded exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

import { startTestApp } from './helpers.js';
import {
  DataQueryError,
  createDataQueryService,
  screenSql,
  wrapForRowCap,
  stripSqlComments,
  type QueryClientLike,
  type QueryPoolLike,
} from '../src/agents/data-query.js';

// ---------------------------------------------------------------------------
// screenSql (pure)
// ---------------------------------------------------------------------------

test('screen: plain SELECT and WITH statements pass (whitespace tolerated)', () => {
  assert.equal(screenSql('SELECT 1').ok, true);
  assert.equal(screenSql('  select * from chats where id <> 1').ok, true);
  assert.equal(screenSql('WITH c AS (SELECT 1) SELECT * FROM c').ok, true);
  assert.equal(screenSql('with t as (select count(*) from messages) select * from t').ok, true);
});

test('screen: leading keyword must be SELECT/WITH', () => {
  for (const sql of ['INSERT INTO chats VALUES (1)', 'update chats set id = 1', 'DELETE FROM chats', 'DROP TABLE chats', 'TRUNCATE chats', 'from x select 1', 'EXPLAIN SELECT 1', '']) {
    const result = screenSql(sql);
    assert.equal(result.ok, false, `expected rejection: ${sql}`);
  }
});

test('screen: semicolons and multiple statements rejected (including after comments)', () => {
  assert.equal(screenSql('SELECT 1;').ok, false);
  assert.equal(screenSql('SELECT 1; SELECT 2').ok, false);
  assert.equal(screenSql('SELECT 1 --; SELECT 2').ok, true, 'comment-only semicolons are stripped');
  assert.equal(screenSql('SELECT 1; -- trailing').ok, false);
});

test('screen: comments are stripped before the leading-keyword check', () => {
  assert.equal(screenSql('-- sneaky\nSELECT 1').ok, true);
  assert.equal(screenSql('/* sneaky */ SELECT 1').ok, true);
  assert.equal(screenSql('-- sneaky\nDELETE FROM chats').ok, false);
  assert.equal(screenSql('/* sneaky */\nUPDATE chats SET id = id').ok, false);
});

test('screen: data-modifying CTEs (mutation keyword anywhere) are rejected', () => {
  assert.equal(screenSql('WITH removed AS (DELETE FROM chats RETURNING *) SELECT * FROM removed').ok, false);
  assert.equal(screenSql("SELECT 'a string mentioning delete' FROM t").ok, false, 'string-literal mutation words are also rejected (accepted false positive, safer wrong side)');
  assert.equal(screenSql('SELECT created_at FROM chats').ok, true, 'word-boundary matching leaves identifiers alone');
  assert.equal(screenSql('SELECT 1 /* DROP TABLE */').ok, true, 'mutation words inside comments are stripped first');
});

test('screen: quotes survive comment stripping', () => {
  assert.equal(stripSqlComments("SELECT '--' , 1 /* x */ FROM t"), "SELECT '--' , 1  FROM t");
  assert.equal(screenSql("SELECT '-- not a comment'").ok, true);
});

// ---------------------------------------------------------------------------
// Row-cap wrapping (pure)
// ---------------------------------------------------------------------------

test('wrap: SELECT * FROM (sql) AS alias LIMIT cap+1', () => {
  assert.equal(wrapForRowCap('SELECT 1', 200), 'SELECT * FROM (SELECT 1) AS __workforce_rows LIMIT 201');
  assert.equal(wrapForRowCap('WITH c AS (SELECT 1) SELECT * FROM c', 5), 'SELECT * FROM (WITH c AS (SELECT 1) SELECT * FROM c) AS __workforce_rows LIMIT 6');
});

// ---------------------------------------------------------------------------
// Service with a fake pool
// ---------------------------------------------------------------------------

interface FakeRow {
  readonly cells: unknown[] | Record<string, unknown>;
}

class FakePool implements QueryPoolLike {
  readonly statements: string[] = [];
  readonly client: FakeClient;
  errorNext: Error | null = null;
  /** Predicate failure for transactional tests (the wrapped statement only). */
  failWhen: ((text: string) => Error | null) | null = null;
  connectFails: boolean = false;

  constructor(result: FakeRow[]) {
    this.client = new FakeClient(this, result);
  }

  async connect(): Promise<QueryClientLike> {
    if (this.connectFails) {
      throw new Error('database is down');
    }
    return this.client;
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeClient implements QueryClientLike {
  constructor(
    private readonly pool: FakePool,
    readonly result: FakeRow[],
    private readonly released = { released: false },
  ) {}

  async query(text: string): Promise<{ rows: unknown[]; fields: Array<{ name: string }>; rowCount: number }> {
    this.pool.statements.push(text);
    if (this.pool.failWhen !== null) {
      const failure = this.pool.failWhen(text);
      if (failure !== null) {
        this.pool.failWhen = null; // one-shot: the follow-up query must run clean
        throw failure;
      }
    }
    if (this.pool.errorNext !== null) {
      const error = this.pool.errorNext;
      this.pool.errorNext = null;
      throw error;
    }
    return {
      rows: this.result.map((row) => (typeof row.cells === 'object' && row.cells !== null && !Array.isArray(row.cells) ? (row.cells as Record<string, unknown>) : Array.isArray(row.cells) ? row.cells : [])) as unknown[],
      fields: [{ name: 'id' }, { name: 'content' }],
      rowCount: this.result.length,
    };
  }

  release(): void {
    this.released.released = true;
  }
}

async function serviceWith(): Promise<{ service: ReturnType<typeof createDataQueryService>; pool: FakePool }> {
  const pool = new FakePool([{ cells: { id: 'a', content: 'x' } }]);
  const service = createDataQueryService({ pool, statementTimeoutMs: 2000, rowCap: 3 });
  return { service, pool };
}

test('service: BEGIN READ ONLY + SET LOCAL statement_timeout precede the wrapped query, then COMMIT + session reset', async () => {
  const { service, pool } = await serviceWith();
  const result = await service.query('SELECT id FROM chats', undefined);
  assert.equal(result.truncated, false);
  assert.equal(result.rowCount, 1);
  assert.deepEqual(pool.statements, [
    'BEGIN READ ONLY',
    'SET LOCAL statement_timeout = 2000',
    wrapForRowCap('SELECT id FROM chats', 3),
    'COMMIT',
    // L3: guaranteed session reset before the client returns to the pool.
    'DISCARD ALL',
  ]);
});

test('service: over-cap result (cap+1 rows) errors row_cap, never silent truncation', async () => {
  const pool = new FakePool([
    { cells: { id: '1', content: 'a' } },
    { cells: { id: '2', content: 'b' } },
    { cells: { id: '3', content: 'c' } },
    { cells: { id: '4', content: 'd' } },
  ]);
  const service = createDataQueryService({ pool, statementTimeoutMs: 100, rowCap: 3 });
  await assert.rejects(
    () => service.query('SELECT id FROM chats'),
    (error: DataQueryError) => error.kind === 'row_cap',
  );
});

test('service: user limit truncates under the cap and reports truncated', async () => {
  const pool = new FakePool([
    { cells: { id: '1', content: 'a' } },
    { cells: { id: '2', content: 'b' } },
  ]);
  const service = createDataQueryService({ pool, statementTimeoutMs: 100, rowCap: 10 });
  const withLimit = await service.query('SELECT id FROM chats', 1);
  assert.equal(withLimit.truncated, true);
  assert.equal(withLimit.rowCount, 1);
  const withoutLimit = await service.query('SELECT id FROM chats');
  assert.equal(withoutLimit.truncated, false);
  assert.equal(withoutLimit.rowCount, 2);
});

test('service: screening failures raise invalid (never touch the pool)', async () => {
  const { service, pool } = await serviceWith();
  await assert.rejects(() => service.query('DELETE FROM chats'), (error: DataQueryError) => error.kind === 'invalid');
  assert.equal(pool.statements.length, 0);
});

test('service: bad limit raises invalid before the db', async () => {
  const { service, pool } = await serviceWith();
  await assert.rejects(() => service.query('SELECT 1', 0), (error: DataQueryError) => error.kind === 'invalid');
  await assert.rejects(() => service.query('SELECT 1', 1.5), (error: DataQueryError) => error.kind === 'invalid');
  assert.equal(pool.statements.length, 0);
});

test('service: pg 57014 → timeout; 25006 → read_only; other → unavailable', async () => {
  const timeoutPool = new FakePool([]);
  timeoutPool.errorNext = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const timeoutService = createDataQueryService({ pool: timeoutPool, statementTimeoutMs: 100, rowCap: 3 });
  await assert.rejects(() => timeoutService.query('SELECT 1'), (error: DataQueryError) => error.kind === 'timeout');

  const readOnlyPool = new FakePool([]);
  readOnlyPool.errorNext = Object.assign(new Error('cannot execute INSERT in a read-only transaction'), { code: '25006' });
  const readOnlyService = createDataQueryService({ pool: readOnlyPool, statementTimeoutMs: 100, rowCap: 3 });
  await assert.rejects(() => readOnlyService.query('SELECT 1'), (error: DataQueryError) => error.kind === 'read_only');

  const otherPool = new FakePool([]);
  otherPool.errorNext = new Error('syntax error at or near "from"');
  const otherService = createDataQueryService({ pool: otherPool, statementTimeoutMs: 100, rowCap: 3 });
  await assert.rejects(() => otherService.query('SELECT 1'), (error: DataQueryError) => error.kind === 'unavailable');

  const deadPool = new FakePool([]);
  deadPool.connectFails = true;
  const deadService = createDataQueryService({ pool: deadPool, statementTimeoutMs: 100, rowCap: 3 });
  await assert.rejects(() => deadService.query('SELECT 1'), (error: DataQueryError) => error.kind === 'unavailable');
});

// ---------------------------------------------------------------------------
// B1: no pool poisoning — the SAME client serves a valid query after failures
// L3: session-level side effects are screened; DISCARD ALL always runs
// ---------------------------------------------------------------------------

test('screen: session-state functions (advisory locks, set_config, pg_sleep) are rejected', () => {
  for (const sql of [
    'SELECT pg_advisory_lock(1)',
    'SELECT pg_advisory_unlock_all()',
    'SELECT pg_sleep(10)',
    'SELECT pg_sleep_for(interval \'1 hour\')',
    "SELECT set_config('workforce.escape', 'true', false)",
    'SELECT pg_terminate_backend(42)',
    'SELECT pg_read_file(\'/etc/passwd\')',
    'WITH sneaky AS (SELECT pg_advisory_lock(7)) SELECT * FROM sneaky',
    '-- comment\nSELECT set_config(\'a\',\'b\',true)',
  ]) {
    const result = screenSql(sql);
    assert.equal(result.ok, false, `expected rejection: ${sql}`);
    if (!result.ok) {
      assert.equal(result.reason, 'dangerous_function');
    }
  }
  // Comments cannot smuggle the token (they are stripped first).
  assert.equal(screenSql('SELECT /* pg_sleep */ 1').ok, true);
  // Ordinary identifiers are not false-positived at word level.
  assert.equal(screenSql('SELECT 1').ok, true);
});

test('B1: failed query (syntax error) rolls back, discards, releases — SAME client serves the next query', async () => {
  const { service, pool } = await serviceWith();
  pool.failWhen = (text) => (text.startsWith('SELECT * FROM (') ? new Error('syntax error at or near "fropm"') : null);
  await assert.rejects(() => service.query('SELECT fropm FROM x'), (error: DataQueryError) => error.kind === 'unavailable');

  // Recovery evidence on the very same client: rollback + discard issued…
  assert.ok(pool.statements.includes('ROLLBACK'));
  assert.ok(pool.statements.includes('DISCARD ALL'));
  // …and the NEXT valid query succeeds end-to-end on the SAME client.
  const followup = await service.query('SELECT id FROM chats');
  assert.equal(followup.rowCount, 1);
  assert.ok(!pool.statements.slice(-5).includes('ROLLBACK'), 'healthy run does not roll back');
  const last = pool.statements.at(-1);
  assert.equal(last, 'DISCARD ALL', 'every run ends with the session reset');
});

test('B1: statement timeout aborts mid-transaction — rollback + discard + same client recovery', async () => {
  const { service, pool } = await serviceWith();
  pool.failWhen = (text) => (text.startsWith('SELECT * FROM (') ? Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) : null);
  await assert.rejects(() => service.query('SELECT id FROM chats'), (error: DataQueryError) => error.kind === 'timeout');
  assert.ok(pool.statements.includes('ROLLBACK'), 'aborted transaction rolled back before release');
  assert.ok(pool.statements.includes('DISCARD ALL'));

  const followup = await service.query('SELECT id FROM chats', 1);
  assert.equal(followup.rowCount, 1);
  assert.equal(followup.truncated, false);
});

test('B1: row-cap abort rolls back instead of committing the oversized read; same client recovers', async () => {
  const pool = new FakePool([
    { cells: { id: '1', content: 'a' } },
    { cells: { id: '2', content: 'b' } },
    { cells: { id: '3', content: 'c' } },
    { cells: { id: '4', content: 'd' } },
  ]);
  const service = createDataQueryService({ pool, statementTimeoutMs: 100, rowCap: 3 });
  const before = pool.statements.length;
  await assert.rejects(() => service.query('SELECT id FROM chats'), (error: DataQueryError) => error.kind === 'row_cap');
  const statements = pool.statements.slice(before);
  assert.ok(statements.includes('ROLLBACK'), 'oversized read is NOT committed — rolled back');
  assert.ok(!statements.includes('COMMIT'));
  assert.ok(statements.includes('DISCARD ALL'));

  // Same client serves the next (under-cap, user-limited) query cleanly: the
  // rows source now yields only 2 rows.
  (pool.client as unknown as { result: FakeRow[] }).result = (pool.client as unknown as { result: FakeRow[] }).result.slice(0, 2);
  const after = await service.query('SELECT id FROM chats', 1);
  assert.equal(after.rowCount, 1);
  assert.equal(after.truncated, true);
  assert.equal(pool.statements.at(-1), 'DISCARD ALL');
});

test('L3: no leaked session state — every exit path (ok, invalid-sql, timeout) ends with DISCARD ALL', async () => {
  const { service, pool } = await serviceWith();
  await service.query('SELECT id FROM chats');
  assert.equal(pool.statements.at(-1), 'DISCARD ALL');
  assert.equal(pool.statements.filter((statement) => statement === 'DISCARD ALL').length, pool.statements.filter((statement) => statement === 'BEGIN READ ONLY').length, 'one discard per begin');
});

// ---------------------------------------------------------------------------
// REST route
// ---------------------------------------------------------------------------

function routeApp(pool: QueryPoolLike, rowCap = 3) {
  const service = createDataQueryService({ pool: pool as never, statementTimeoutMs: 100, rowCap });
  return startTestApp({ agents: { wire: true, dataQueryService: service, queryRowCap: rowCap } });
}

test('route: orchestrator and analyst may query; researcher and general get 404', async () => {
  const { service } = await serviceWith();
  const app = await startTestApp({ agents: { wire: true, dataQueryService: service } });
  try {
    const ok = await fetch(`http://127.0.0.1:${app.port}/api/agents/analyst/data/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1' }),
    });
    assert.equal(ok.status, 200);
    const blocked = await fetch(`http://127.0.0.1:${app.port}/api/agents/researcher/data/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1' }),
    });
    assert.equal(blocked.status, 404);
    const generalBlocked = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/data/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1' }),
    });
    assert.equal(generalBlocked.status, 404);
  } finally {
    await app.close();
  }
});

test('route: shape {query,limit} enforced; success shape columns/rows/rowCount/truncated', async () => {
  const pool = new FakePool([
    { cells: { id: '1', content: 'a' } },
    { cells: { id: '2', content: 'b' } },
  ]);
  const service = createDataQueryService({ pool, statementTimeoutMs: 100, rowCap: 10 });
  const app = await startTestApp({ agents: { wire: true, dataQueryService: service } });
  try {
    const good = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/data/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT id, content FROM chats LIMIT 5', limit: 1 }),
    });
    assert.equal(good.status, 200);
    const body = (await good.json()) as { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean };
    assert.deepEqual(body.columns, ['id', 'content']);
    assert.equal(body.rowCount, 1);
    assert.equal(body.truncated, true);

    const badQueryKey = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/data/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    });
    assert.equal(badQueryKey.status, 400);

    const extraField = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/data/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1', depth: 1 }),
    });
    assert.equal(extraField.status, 400);
  } finally {
    await app.close();
  }
});

test('route: safe errors — screening invalid 400, row cap 400 fixed, timeout/read-only mapped, no SQL echoed', async () => {
  const deadPool = new FakePool([]);
  const app = await routeApp(deadPool);
  try {
    const invalid = await fetch(`http://127.0.0.1:${app.port}/api/agents/orchestrator/data/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'DROP TABLE chats' }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'Invalid data query.' });

    const full = new FakePool([
      { cells: { id: '1', content: 'a' } },
      { cells: { id: '2', content: 'b' } },
      { cells: { id: '3', content: 'c' } },
      { cells: { id: '4', content: 'd' } },
    ]);
    const cappedApp = await routeApp(full);
    try {
      const capped = await fetch(`http://127.0.0.1:${cappedApp.port}/api/agents/orchestrator/data/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT id FROM chats' }),
      });
      assert.equal(capped.status, 400);
      assert.deepEqual(await capped.json(), { error: 'Data query exceeded the row cap.' });
    } finally {
      await cappedApp.close();
    }

    const timeoutPool = new FakePool([]);
    timeoutPool.errorNext = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const timeoutApp = await routeApp(timeoutPool);
    try {
      const timed = await fetch(`http://127.0.0.1:${timeoutApp.port}/api/agents/orchestrator/data/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT 1' }),
      });
      assert.equal(timed.status, 503);
      assert.deepEqual(await timed.json(), { error: 'Data query timed out.' });
    } finally {
      await timeoutApp.close();
    }

    const readOnlyPool = new FakePool([]);
    readOnlyPool.errorNext = Object.assign(new Error('cannot execute INSERT'), { code: '25006' });
    const readOnlyApp = await routeApp(readOnlyPool);
    try {
      const readOnly = await fetch(`http://127.0.0.1:${readOnlyApp.port}/api/agents/analyst/data/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT 1' }),
      });
      assert.equal(readOnly.status, 400);
      assert.deepEqual(await readOnly.json(), { error: 'Data queries must be read-only.' });
    } finally {
      await readOnlyApp.close();
    }

    // A real (never-yet-connected) Pool fails safely → 503, no URL/secrets.
    const liveApp = await startTestApp({
      agents: {
        wire: true,
        dataQueryService: createDataQueryService({
          pool: new Pool({ connectionString: 'postgresql://workforce:workforce@127.0.0.1:1/workforce' }),
          statementTimeoutMs: 100,
          rowCap: 3,
        }),
      },
    });
    try {
      const unavailable = await fetch(`http://127.0.0.1:${liveApp.port}/api/agents/orchestrator/data/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT 1' }),
      });
      assert.equal(unavailable.status, 503);
      const text = JSON.stringify(await unavailable.json());
      assert.ok(!text.includes('postgresql://'), 'connection URL never leaks');
    } finally {
      await liveApp.close();
    }
  } finally {
    await app.close();
  }
});
