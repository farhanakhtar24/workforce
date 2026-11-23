import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgresMemoryStore,
  attachLockSessionEventGuards,
  defaultPgClientFactory,
  type MemoryPgClient,
  type MemoryPgClientConfig,
  type MemoryPgClientFactory,
  type MemoryPgQueryResult,
} from './index.js';
import type { MemoryBlockInsert } from '../store.js';
import type { MemoryBlock } from '../types.js';

/**
 * Prisma/pg mocks ONLY — no database, no network. These tests prove:
 * 1. runPathExclusive holds a session-level advisory lock on a dedicated pg
 *    client OUTSIDE Prisma: lock -> work -> unlock -> end, on success AND on
 *    error; no Prisma interactive transaction ever wraps `work`.
 * 2. Each insertSupersedingBlock keeps its own short transaction (atomicity
 *    is preserved), including the guarded UPDATE conflict path.
 * 3. nearestReadyCandidates runs in ONE short transaction that sets
 *    hnsw.ef_search=200 (> pgvector default 40) with parameterized set_config
 *    and only enables hnsw.iterative_scan when extversion >= 0.8.0, caching
 *    the capability boolean (probe failures are NOT cached and retry).
 */

// ---------------------------------------------------------------------------
// Fake pg client
// ---------------------------------------------------------------------------

class FakePgClient implements MemoryPgClient {
  readonly config: MemoryPgClientConfig;
  readonly timeline: string[];

  failConnect: Error | null = null;
  failUnlock = false;
  failEnd = false;
  /** Advisory queries captured for SQL-shape assertions (parameter binding). */
  lastLockQuery: { text: string; values: readonly unknown[] } | null = null;
  lastUnlockQuery: { text: string; values: readonly unknown[] } | null = null;

  constructor(config: MemoryPgClientConfig, timeline: string[]) {
    this.config = config;
    this.timeline = timeline;
  }

  async connect(): Promise<void> {
    if (this.failConnect) {
      this.timeline.push('connect-failed');
      throw this.failConnect;
    }
    this.timeline.push('connect');
  }

  async query(text: string, values?: readonly unknown[]): Promise<MemoryPgQueryResult> {
    if (text.includes('pg_advisory_lock')) {
      this.lastLockQuery = { text, values: values ?? [] };
      this.timeline.push('lock');
    } else if (text.includes('pg_advisory_unlock')) {
      this.lastUnlockQuery = { text, values: values ?? [] };
      this.timeline.push('unlock');
      if (this.failUnlock) {
        throw new Error('unlock rejected');
      }
    }
    return { rows: [], rowCount: 1 };
  }

  async end(): Promise<void> {
    this.timeline.push('end');
    if (this.failEnd) {
      throw new Error('end failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Fake Prisma client (raw SQL + interactive transaction recorder)
// ---------------------------------------------------------------------------

type RawRow = Record<string, unknown>;

type SqlTag =
  | 'ef_search'
  | 'iterative_scan'
  | 'extversion'
  | 'candidates'
  | 'count'
  | 'for_update'
  | 'blocks'
  | 'insert_block'
  | 'insert_relations'
  | 'supersede_update';

function tagSql(sql: string, values: readonly unknown[]): string {
  if (sql.includes('set_config') && sql.includes('hnsw.ef_search')) {
    return values.length > 0 ? `ef_search=${String(values[0])}` : 'ef_search';
  }
  if (sql.includes('set_config')) {
    return 'iterative_scan';
  }
  if (sql.includes('pg_extension')) {
    return 'extversion';
  }
  if (sql.includes('cosineSimilarity')) {
    return 'candidates';
  }
  if (sql.includes('COUNT(*)')) {
    return 'count';
  }
  if (sql.includes('FOR UPDATE')) {
    return 'for_update';
  }
  if (sql.includes('UPDATE "MemoryBlock"')) {
    return 'supersede_update';
  }
  if (sql.includes('INSERT INTO "MemoryRelation"')) {
    return 'insert_relations';
  }
  if (sql.includes('INSERT INTO "MemoryBlock"')) {
    return 'insert_block';
  }
  return 'blocks';
}

class FakePrisma {
  readonly log: string[] = [];
  readonly timeline: string[];
  transactionCount = 0;

  extensionRows: RawRow[] = [];
  targetRows: RawRow[] = [];
  candidateRows: RawRow[] = [];
  blockRows: RawRow[] = [];
  countValue = 0;
  updateRowCount = 0;
  failOnProbe = false;

  constructor(timeline: string[]) {
    this.timeline = timeline;
  }

  async $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const sql = strings.join('?');
    const tag = tagSql(sql, values);
    this.log.push(`query:${tag}`);
    if (tag === 'extversion') {
      if (this.failOnProbe) {
        throw new Error('probe down');
      }
      return this.extensionRows as T;
    }
    if (tag === 'candidates') {
      return this.candidateRows as T;
    }
    if (tag === 'count') {
      return [{ count: this.countValue }] as T;
    }
    if (tag === 'for_update') {
      return this.targetRows as T;
    }
    return this.blockRows as T;
  }

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    this.log.push(`exec:${tagSql(strings.join('?'), values)}`);
    return this.updateRowCount;
  }

  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    this.timeline.push('tx:begin');
    this.log.push('tx:begin');
    try {
      const result = await fn(this);
      this.timeline.push('tx:commit');
      this.log.push('tx:commit');
      return result;
    } catch (cause) {
      this.timeline.push('tx:rollback');
      this.log.push('tx:rollback');
      throw cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DATABASE_URL = 'postgresql://workforce:secret@hidden-host:5432/workforce';

interface FakeWorld {
  timeline: string[];
  prismaLog: string[];
  clients: FakePgClient[];
  factoryCalls: MemoryPgClientConfig[];
  factoryCallCount: number;
  prisma: FakePrisma;
  store: PostgresMemoryStore;
  /** Failure knobs applied by the factory to the NEXT constructed client (clients are built lazily inside runPathExclusive). */
  pending: {
    failConnect: Error | null;
    failUnlock: boolean;
    failEnd: boolean;
  };
}

function makeWorld(options?: { databaseUrl?: string }): FakeWorld {
  const timeline: string[] = [];
  const clients: FakePgClient[] = [];
  const factoryCalls: MemoryPgClientConfig[] = [];
  let factoryCallCount = 0;
  const pending = {
    failConnect: null as Error | null,
    failUnlock: false,
    failEnd: false,
  };
  const factory: MemoryPgClientFactory = (config) => {
    factoryCallCount += 1;
    factoryCalls.push(config);
    const client = new FakePgClient(config, timeline);
    client.failConnect = pending.failConnect;
    client.failUnlock = pending.failUnlock;
    client.failEnd = pending.failEnd;
    clients.push(client);
    return client;
  };
  const prisma = new FakePrisma(timeline);
  const store = new PostgresMemoryStore(
    prisma as unknown as import('@workforce/core/generated/prisma').PrismaClient,
    {
      // Explicit `databaseUrl: undefined` must stay undefined so the
      // missing-options test exercises the typed configuration guard.
      databaseUrl: options && 'databaseUrl' in options ? options.databaseUrl : DATABASE_URL,
      pgClientFactory: factory,
    },
  );
  return { timeline, prismaLog: prisma.log, clients, factoryCalls, factoryCallCount, prisma, store, pending };
}

function makeInsert(overrides?: Partial<MemoryBlockInsert>): MemoryBlockInsert {
  return {
    scope: 'ops',
    path: 'a/b',
    kind: 'learning',
    content: 'summary content',
    confidence: 0.5,
    metadata: {},
    ...overrides,
  };
}

function makeBlockRow(overrides: RawRow = {}): RawRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    scope: 'ops',
    path: 'a/b',
    kind: 'learning',
    content: 'body',
    confidence: 0.5,
    embeddingStatus: 'ready',
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    accessCount: 0,
    supersededById: null,
    metadata: {},
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
    embeddedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
    lastAccessedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Finding 1: session-level lock outside Prisma
// ---------------------------------------------------------------------------

test('runPathExclusive: dedicated pg session takes lock, work runs without Prisma transaction wrapper, unlock then end', async () => {
  const world = makeWorld();
  world.prisma.targetRows = [{ id: 't-1', scope: 'ops', supersededById: null }];
  world.prisma.updateRowCount = 1;

  const result = await world.store.runPathExclusive('ops', 'a/b', async (ops) => {
    await ops.countActiveBlocksByPath('ops', 'a/b');
    await ops.listActiveBlocksByPath('ops', 'a/b', { limit: 1, order: 'oldest' });
    await ops.insertSupersedingBlock(makeInsert(), ['t-1']);
    return 'done';
  });

  assert.strictEqual(result, 'done');

  // Lock lifecycle on the dedicated session: connect -> lock -> ... -> unlock -> end.
  assert.deepStrictEqual(world.timeline, [
    'connect',
    'lock',
    'tx:begin',
    'tx:commit',
    'unlock',
    'end',
  ]);

  // Exactly ONE Prisma interactive transaction, and it belongs to
  // insertSupersedingBlock (atomicity preserved), NOT to the lock scope.
  assert.strictEqual(world.prisma.transactionCount, 1);

  // The advisory lock never went through Prisma.
  assert.ok(!world.prismaLog.some((entry) => entry.includes('pg_advisory')));
  // The lock query used the deterministic hashtext bigint form.
  const lockQuery = world.clients[0]?.config;
  assert.ok(lockQuery);
  assert.strictEqual(lockQuery.connectionString, DATABASE_URL);

  // Prisma op ordering inside the insert transaction.
  assert.deepStrictEqual(world.prismaLog, [
    'query:count',
    'query:blocks',
    'tx:begin',
    'query:for_update',
    'exec:insert_block',
    'exec:insert_relations',
    'exec:supersede_update',
    'tx:commit',
  ]);
});

test('runPathExclusive: lock key is a bound parameter, never spliced into SQL', async () => {
  const world = makeWorld();
  await world.store.runPathExclusive('ops', 'logs/app-server', async () => 'ok');
  const client = world.clients[0];
  assert.ok(client);

  const lock = client.lastLockQuery;
  assert.ok(lock);
  // Parameterized form: hashtext over $1, key delivered via bind values.
  assert.ok(lock.text.includes('pg_advisory_lock(hashtext($1)::bigint)'));
  assert.ok(!lock.text.includes('ops:logs/app-server'));
  assert.deepStrictEqual([...lock.values], ['ops:logs/app-server']);

  const unlock = client.lastUnlockQuery;
  assert.ok(unlock);
  assert.ok(unlock.text.includes('pg_advisory_unlock(hashtext($1)::bigint)'));
  assert.deepStrictEqual([...unlock.values], ['ops:logs/app-server']);

  // The connection string carries no path fragments.
  assert.ok(!client.config.connectionString.includes('ops:logs/app-server'));
  assert.strictEqual(world.timeline[0], 'connect');
});

test('runPathExclusive: work failure still unlocks and ends, then rethrows the original error', async () => {
  const world = makeWorld();
  const failure = new Error('compactor exploded');

  await assert.rejects(
    () =>
      world.store.runPathExclusive('ops', 'a/b', async () => {
        throw failure;
      }),
    (error: unknown) => {
      assert.strictEqual(error, failure); // original error, not wrapped
      return true;
    },
  );

  assert.deepStrictEqual(world.timeline, ['connect', 'lock', 'unlock', 'end']);
  assert.strictEqual(world.prisma.transactionCount, 0);
});

test('runPathExclusive: unlock failure does not mask the work result; end still runs', async () => {
  const world = makeWorld();
  world.pending.failUnlock = true;

  const result = await world.store.runPathExclusive('ops', 'a/b', async () => 42);
  assert.strictEqual(result, 42);
  assert.deepStrictEqual(world.timeline, ['connect', 'lock', 'unlock', 'end']);
});

test('runPathExclusive: end failure does not mask the work result', async () => {
  const world = makeWorld();
  world.pending.failEnd = true;
  const result = await world.store.runPathExclusive('ops', 'a/b', async () => 7);
  assert.strictEqual(result, 7);
  assert.deepStrictEqual(world.timeline, ['connect', 'lock', 'unlock', 'end']);
});

test('runPathExclusive: connect failure throws MemoryConfigurationError without echoing the URL, no lock/end', async () => {
  const world = makeWorld();
  world.pending.failConnect = new Error('connect ECONNREFUSED hidden-host:5432');

  await assert.rejects(
    () => world.store.runPathExclusive('ops', 'a/b', async () => 'never'),
    (error: unknown) => {
      assert.strictEqual((error as { name?: string }).name, 'MemoryConfigurationError');
      assert.strictEqual((error as { code?: string }).code, 'memory_configuration_error');
      const message = (error as Error).message;
      const cause = String((error as { cause?: Error }).cause);
      assert.ok(!message.includes(DATABASE_URL));
      assert.ok(!message.includes('secret'));
      assert.ok(!cause.includes(DATABASE_URL));
      return true;
    },
  );

  assert.deepStrictEqual(world.timeline, ['connect-failed']);
  assert.strictEqual(world.factoryCalls.length, 1);
  assert.strictEqual(world.factoryCalls[0]?.connectionTimeoutMillis, 10_000);
});

test('runPathExclusive without options.databaseUrl throws MemoryConfigurationError before building a client', async () => {
  const world = makeWorld({ databaseUrl: undefined });
  await assert.rejects(
    () => world.store.runPathExclusive('ops', 'a/b', async () => 'never'),
    (error: unknown) => {
      assert.strictEqual((error as { code?: string }).code, 'memory_configuration_error');
      return true;
    },
  );
  assert.strictEqual(world.factoryCalls.length, 0);
  assert.strictEqual(world.prisma.transactionCount, 0);
});

// ---------------------------------------------------------------------------
// Finding 1: insertSupersedingBlock atomicity (short transaction) remains
// ---------------------------------------------------------------------------

test('insertSupersedingBlock keeps its own short transaction and validates targets', async () => {
  const world = makeWorld({ databaseUrl: undefined });
  world.prisma.targetRows = [
    { id: 't-1', scope: 'ops', supersededById: null },
    { id: 't-2', scope: 'ops', supersededById: null },
  ];
  world.prisma.updateRowCount = 2;

  const block = await world.store.insertSupersedingBlock(makeInsert(), ['t-1', 't-2']);
  assert.strictEqual(block.kind, 'learning');
  assert.strictEqual(block.path, 'a/b');
  assert.strictEqual(block.embeddedAt, null);
  assert.strictEqual(world.prisma.transactionCount, 1);
  assert.deepStrictEqual(world.timeline, ['tx:begin', 'tx:commit']);
  assert.deepStrictEqual(world.prismaLog, [
    'tx:begin',
    'query:for_update',
    'exec:insert_block',
    'exec:insert_relations',
    'exec:supersede_update',
    'tx:commit',
  ]);
});

test('insertSupersedingBlock rolls back everything when the guarded UPDATE misses a row', async () => {
  const world = makeWorld({ databaseUrl: undefined });
  world.prisma.targetRows = [{ id: 't-1', scope: 'ops', supersededById: null }];
  // Simulate a concurrent supersede slipping past FOR UPDATE: only 0 rows updated.
  world.prisma.updateRowCount = 0;

  await assert.rejects(
    () => world.store.insertSupersedingBlock(makeInsert(), ['t-1']),
    (error: unknown) => {
      assert.strictEqual((error as { name?: string }).name, 'MemoryConflictError');
      return true;
    },
  );
  assert.deepStrictEqual(world.timeline, ['tx:begin', 'tx:rollback']);
});

// ---------------------------------------------------------------------------
// Finding 2: HNSW settings inside one short Prisma transaction
// ---------------------------------------------------------------------------

test('nearestReadyCandidates sets ef_search=200 and (pgvector >= 0.8.0) iterative_scan, all in ONE short transaction', async () => {
  const world = makeWorld({ databaseUrl: undefined });
  world.prisma.extensionRows = [{ extversion: '0.8.0' }];
  world.prisma.candidateRows = [
    { ...makeBlockRow({ id: 'c-1' }), cosineSimilarity: 0.9 },
    { ...makeBlockRow({ id: 'c-2' }), cosineSimilarity: 0.1 },
  ];

  const candidates = await world.store.nearestReadyCandidates({
    embedding: new Array<number>(384).fill(0.1),
    limit: 100,
  });

  assert.strictEqual(candidates.length, 2);
  assert.strictEqual(candidates[0]?.block.id, 'c-1');
  assert.strictEqual(candidates[0]?.cosineSimilarity, 0.9);

  // One short transaction around settings + fetch; no other transactions.
  assert.strictEqual(world.prisma.transactionCount, 1);
  // ef_search bound as the trusted constant 200 (> pgvector default 40).
  assert.ok(world.prismaLog.includes('query:ef_search=200'));
  // iterative_scan enabled because the probe found 0.8.0.
  assert.ok(world.prismaLog.includes('query:iterative_scan'));
  assert.ok(world.prismaLog.includes('query:extversion'));
  assert.ok(world.prismaLog.includes('query:candidates'));
  assert.deepStrictEqual(world.timeline, ['tx:begin', 'tx:commit']);
});

test('nearestReadyCandidates caches the capability boolean: no repeated probe on later searches', async () => {
  const world = makeWorld({ databaseUrl: undefined });
  world.prisma.extensionRows = [{ extversion: '0.8.0' }];
  world.prisma.candidateRows = [{ ...makeBlockRow({ id: 'c-1' }), cosineSimilarity: 0.5 }];

  await world.store.nearestReadyCandidates({ embedding: new Array<number>(384).fill(0.1), limit: 10 });
  await world.store.nearestReadyCandidates({ embedding: new Array<number>(384).fill(0.1), limit: 10 });

  const probes = world.prismaLog.filter((entry) => entry === 'query:extversion');
  assert.strictEqual(probes.length, 1); // cached after the first search
  assert.strictEqual(world.prismaLog.filter((entry) => entry === 'query:ef_search=200').length, 2);
  assert.strictEqual(world.prismaLog.filter((entry) => entry === 'query:iterative_scan').length, 2);
  // Each search stays its own short transaction.
  assert.strictEqual(world.prisma.transactionCount, 2);
});

test('nearestReadyCandidates skips iterative_scan for pgvector < 0.8.0 (and caches that)', async () => {
  const world = makeWorld({ databaseUrl: undefined });
  world.prisma.extensionRows = [{ extversion: '0.7.4' }];
  world.prisma.candidateRows = [{ ...makeBlockRow({ id: 'c-1' }), cosineSimilarity: 0.5 }];

  await world.store.nearestReadyCandidates({ embedding: new Array<number>(384).fill(0.1), limit: 10 });
  await world.store.nearestReadyCandidates({ embedding: new Array<number>(384).fill(0.1), limit: 10 });

  assert.ok(!world.prismaLog.includes('query:iterative_scan'));
  // Deterministic negative result IS cached: exactly one probe total.
  assert.strictEqual(world.prismaLog.filter((entry) => entry === 'query:extversion').length, 1);
  assert.ok(world.prismaLog.filter((entry) => entry === 'query:ef_search=200').length === 2);
});

test('nearestReadyCandidates treats a MISSING vector extension as "no iterative scan" and caches it', async () => {
  const world = makeWorld({ databaseUrl: undefined });
  world.prisma.extensionRows = [];
  world.prisma.candidateRows = [];

  await world.store.nearestReadyCandidates({ embedding: new Array<number>(384).fill(0.1), limit: 10 });
  await world.store.nearestReadyCandidates({ embedding: new Array<number>(384).fill(0.1), limit: 10 });

  assert.ok(!world.prismaLog.includes('query:iterative_scan'));
  assert.strictEqual(world.prismaLog.filter((entry) => entry === 'query:extversion').length, 1);
  assert.deepStrictEqual(world.prismaLog.filter((entry) => entry === 'query:candidates').length, 2);
});

test('nearestReadyCandidates retries the capability probe after a failure and still returns candidates', async () => {
  const world = makeWorld({ databaseUrl: undefined });
  world.prisma.failOnProbe = true;
  world.prisma.candidateRows = [{ ...makeBlockRow({ id: 'c-1' }), cosineSimilarity: 0.25 }];

  const first = await world.store.nearestReadyCandidates({ embedding: new Array<number>(384).fill(0.1), limit: 10 });
  assert.strictEqual(first.length, 1);
  assert.ok(!world.prismaLog.includes('query:iterative_scan'));

  // Failure is NOT cached: probe runs again (and fails again here).
  world.prisma.failOnProbe = false;
  world.prisma.extensionRows = [{ extversion: '0.8.0' }];
  await world.store.nearestReadyCandidates({ embedding: new Array<number>(384).fill(0.1), limit: 10 });
  assert.strictEqual(world.prismaLog.filter((entry) => entry === 'query:extversion').length, 2);
  assert.ok(world.prismaLog.includes('query:iterative_scan'));
});

// ---------------------------------------------------------------------------
// Regression: supersededById is many-to-one (compaction 23505 defect)
// ---------------------------------------------------------------------------

test('schema + migrations: supersededById is non-unique with a plain index; bootstrap migration untouched', () => {
  // src/memory/postgres/*.test.ts -> packages/core (three levels up).
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

  const schema = readFileSync(path.join(packageRoot, 'prisma/schema.prisma'), 'utf8');
  const supersededField = schema
    .split('\n')
    .find((line) => line.includes('supersededById') && line.includes('String?'));
  assert.ok(supersededField);
  assert.ok(!supersededField.includes('@unique'));
  assert.ok(schema.includes('@@index([supersededById])'));
  assert.ok(schema.includes('@@index([sourceId])'));

  // The bootstrap migration keeps its history intact (including the mistake).
  const bootstrap = readFileSync(
    path.join(packageRoot, 'prisma/migrations/20261119000000_memory_core/migration.sql'),
    'utf8',
  );
  assert.ok(bootstrap.includes('"MemoryBlock_supersededById_key" UNIQUE'));
  // ...and is not retro-edited into a fix.
  assert.ok(!bootstrap.includes('DROP CONSTRAINT'));

  // Exactly one forward fix-up migration: drops the constraint, adds the index.
  const migrationsDir = path.join(packageRoot, 'prisma/migrations');
  const entries = readdirSync(migrationsDir).filter((entry) => entry !== 'migration_lock.toml');
  assert.deepStrictEqual(entries, [
    '20261119000000_memory_core',
    '20261120000000_memory_superseded_by_many_to_one',
    '20261120000100_memory_relation_tuple_unique',
  ]);
  const fixup = readFileSync(
    path.join(migrationsDir, '20261120000000_memory_superseded_by_many_to_one/migration.sql'),
    'utf8',
  );
  assert.ok(fixup.includes('DROP CONSTRAINT IF EXISTS "MemoryBlock_supersededById_key"'));
  assert.ok(fixup.includes('CREATE INDEX IF NOT EXISTS "MemoryBlock_supersededById_idx" ON "MemoryBlock"("supersededById")'));
  assert.ok(!fixup.includes('CREATE TABLE'));
  assert.ok(!fixup.includes('DROP TABLE'));

  // Tuple-uniqueness fix-up migration is idempotent and guarded.
  const tuple = readFileSync(
    path.join(migrationsDir, '20261120000100_memory_relation_tuple_unique/migration.sql'),
    'utf8',
  );
  assert.ok(tuple.includes('MemoryRelation_sourceId_targetId_type_key'));
  assert.ok(tuple.includes('IF NOT EXISTS'));
  assert.ok(tuple.includes('UNIQUE ("sourceId", "targetId", "type")'));
});

test('compaction-shaped batch: 30 sources share one supersededById via one guarded UPDATE', async () => {
  const world = makeWorld({ databaseUrl: undefined });
  const sourceIds = Array.from({ length: 30 }, (_, index) => {
    const digits = String(index).padStart(12, '0');
    return `00000000-0000-4000-8000-${digits}`;
  });
  world.prisma.targetRows = sourceIds.map((id) => ({ id, scope: 'ops', supersededById: null }));
  // The single non-unique UPDATE marks every source with the summary id.
  world.prisma.updateRowCount = 30;

  const summary = await world.store.insertSupersedingBlock(makeInsert(), sourceIds);

  assert.ok(summary.id);
  assert.strictEqual(world.prisma.transactionCount, 1);
  assert.strictEqual(world.prismaLog.filter((entry) => entry === 'exec:supersede_update').length, 1);
  assert.deepStrictEqual(world.timeline, ['tx:begin', 'tx:commit']);
  // Guard intact: the affected-row count must equal the target count.
  assert.strictEqual(world.prisma.updateRowCount, 30);
});

test('compaction-shaped batch: a partial guarded UPDATE (29 of 30) still rolls back everything', async () => {
  const world = makeWorld({ databaseUrl: undefined });
  const sourceIds = Array.from({ length: 30 }, (_, index) => {
    const digits = String(index).padStart(12, '0');
    return `00000000-0000-4000-8000-${digits}`;
  });
  world.prisma.targetRows = sourceIds.map((id) => ({ id, scope: 'ops', supersededById: null }));
  // One source got superseded concurrently: guard fires, whole write aborts.
  world.prisma.updateRowCount = 29;

  await assert.rejects(
    () => world.store.insertSupersedingBlock(makeInsert(), sourceIds),
    (error: unknown) => {
      assert.strictEqual((error as { name?: string }).name, 'MemoryConflictError');
      return true;
    },
  );
  assert.deepStrictEqual(world.timeline, ['tx:begin', 'tx:rollback']);
});

// ---------------------------------------------------------------------------
// Mapping sanity: candidate rows keep the block projection (no embedding data)
// ---------------------------------------------------------------------------

test('candidate rows map into MemoryBlock without any embedding fields', async () => {
  const world = makeWorld({ databaseUrl: undefined });
  world.prisma.candidateRows = [{ ...makeBlockRow({ id: 'c-9' }), cosineSimilarity: 0.75 }];
  const candidates = await world.store.nearestReadyCandidates({ embedding: new Array<number>(384).fill(0), limit: 5 });
  const block: MemoryBlock = candidates[0]?.block as MemoryBlock;
  assert.strictEqual(block.id, 'c-9');
  assert.strictEqual(block.embeddingStatus, 'ready');
  assert.strictEqual(Object.hasOwn(block, 'embedding'), false);
  assert.strictEqual(Object.hasOwn(block, 'cosineSimilarity'), false);
});

// ---------------------------------------------------------------------------
// Idle-socket safety guards on the DEFAULT factory only (HIGH finding)
// ---------------------------------------------------------------------------

test('defaultPgClientFactory attaches exactly one no-op error/end guard on the REAL pg.Client (constructed, never connected)', () => {
  const client = defaultPgClientFactory({
    // Real pg.Client construction performs no I/O; safe without a database.
    connectionString: 'postgresql://workforce:workforce@hidden-host:5432/workforce',
    connectionTimeoutMillis: 10_000,
  });

  const emitter = client as unknown as {
    listenerCount(event: string): number;
    listeners(event: string): Array<(...args: unknown[]) => void>;
  };
  assert.strictEqual(emitter.listenerCount('error'), 1);
  assert.strictEqual(emitter.listenerCount('end'), 1);

  // Handlers are no-ops: a socket dropped mid-compaction must not crash the
  // process via unhandled EventEmitter 'error', must not throw, and must not
  // log anything (including the URL).
  const errorHandler = emitter.listeners('error')[0];
  const endHandler = emitter.listeners('end')[0];
  assert.strictEqual(typeof errorHandler, 'function');
  assert.strictEqual(typeof endHandler, 'function');
  assert.doesNotThrow(() => errorHandler?.(new Error('socket dropped mid-compaction')));
  assert.doesNotThrow(() => endHandler?.());

  // Guard removal would leave a lone idle session; this is cleanup only.
  const raw = client as unknown as { removeAllListeners(event: string): unknown };
  raw.removeAllListeners('error');
  raw.removeAllListeners('end');
  assert.strictEqual(emitter.listenerCount('error'), 0);
});

test('attachLockSessionEventGuards skips injected fakes without .on and never throws', () => {
  // Fake without .on (existing tests' shape): no listeners required.
  const bare = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.strictEqual(attachLockSessionEventGuards(bare), false);
  assert.strictEqual(attachLockSessionEventGuards(null), false);
  assert.strictEqual(attachLockSessionEventGuards(undefined), false);

  // Fake WITH .on gets both events registered, nothing more.
  const attached: string[] = [];
  const fake = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      attached.push(event);
      assert.strictEqual(typeof handler, 'function');
    },
  };
  assert.strictEqual(attachLockSessionEventGuards(fake), true);
  assert.deepStrictEqual(attached, ['error', 'end']);
});
