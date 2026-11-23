/**
 * Postgres/pgvector store for the memory domain. Exported ONLY from the
 * `@workforce/core/memory/postgres` subpath: importing this module loads the
 * generated Prisma client, so consumers that don't need Postgres (e.g. the
 * CLI, unit tests of the pure domain) must use `@workforce/core` or
 * `@workforce/core/memory` instead.
 *
 * ## Prisma usage
 * The caller constructs the PrismaClient (from this subpath's sibling export
 * `@workforce/core/generated/prisma`, or `@prisma/client` configured to the
 * same generated output) and hands it to {@link createPostgresMemoryStore}.
 * All data access is parameterized raw SQL through tagged templates — no
 * `sql.raw`, no string concatenation of user values:
 *
 * - Vector writes use `${literal}::vector` with the literal from
 *   `memoryVectorToPgLiteral` (validated: exactly 384 finite values).
 * - Candidate fetch uses pgvector cosine distance:
 *   `ORDER BY "embedding" <=> $1::vector ASC` on the HNSW cosine index, with
 *   `cosineSimilarity = 1 - (embedding <=> $1::vector)` returned per row.
 * - Embedding rows are NEVER returned; block projections omit the vector
 *   column entirely.
 * - Keyword filters use ILIKE with `escapeIlikePattern` (wildcard-safe), path
 *   prefixes use `starts_with(path, prefix)` semantics via equality-or-prefix
 *   conditions (no LIKE wildcards at all).
 * - All parameters are bound; identifiers are compiled-in column names, not
 *   user input.
 *
 * ## Transactions & locking
 * - `insertSupersedingBlock` runs inside one SHORT transaction: target rows are
 *   locked with `FOR UPDATE`, validated (same scope, not already superseded,
 *   not self), the block inserted, `supersedes` relations added, and targets
 *   marked superseded with a guarded re-check `... WHERE "supersededById" IS
 *   NULL` (row count must match). Compaction wraps each such write in its own
 *   short transaction beneath the lock — never one transaction around the LLM.
 * - `runPathExclusive` holds a SESSION-level
 *   `pg_advisory_lock(hashtext(scope || ':' || path))` on a dedicated
 *   `pg.Client` connection (`options.databaseUrl`), OUTSIDE the Prisma pool
 *   and outside any Prisma transaction; the compaction re-checks run against
 *   normal pooled Prisma client operations under the shared lock. A dropped
 *   socket releases the lock automatically.
 *
 * ## Vector search settings
 * `nearestReadyCandidates` runs inside ONE SHORT Prisma transaction: it first
 * applies `set_config('hnsw.ef_search', '200', true)` (parameterized; PG's
 * `SET LOCAL` cannot take bind parameters) and, when the installed pgvector
 * extension is `>= 0.8.0`, `set_config('hnsw.iterative_scan', 'relaxed_order',
 * true)` — probed once and cached as a capability boolean only. Settings
 * values are trusted constants; all user values remain bound parameters.
 *
 * ## Statuses
 * `markEmbeddingReady` atomically stores the vector + model + `embeddedAt`
 * and flips the row to `ready`. `markEmbeddingFailed` flips to `failed`
 * (keeping rows, never deleting). Failed/pending rows are excluded from
 * vector candidate fetches by `embeddingStatus = 'ready' AND "embedding" IS
 * NOT NULL`.
 */

import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { Prisma, PrismaClient } from '@workforce/core/generated/prisma';

import {
  MemoryConflictError,
  MemoryConfigurationError,
  MemoryNotFoundError,
  MemoryValidationError,
} from '../errors.js';
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  isEmbeddingStatus,
  isMemoryKind,
  isMemoryRelationType,
  type EmbeddingStatus,
} from '../kinds.js';
import { normalizeMemoryPath, normalizeScope } from '../paths.js';
import type {
  MemoryActiveBlockListOptions,
  MemoryBlockInsert,
  MemoryEmbeddingFailedUpdate,
  MemoryEmbeddingReadyUpdate,
  MemoryQueryParams,
  MemoryStore,
  MemoryStoreTxView,
  MemoryVectorCandidate,
  MemoryVectorSearchParams,
} from '../store.js';
import type { MemoryBlock, MemoryRelation, MemoryMetadata } from '../types.js';
import {
  HNSW_ITERATIVE_SCAN_MIN_EXTVERSION,
  SEMANTIC_HNSW_EF_SEARCH,
  compareExtensionVersion,
  ilikeContainsPattern,
  memoryVectorToPgLiteral,
} from './sql-utils.js';

type RawClient = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Dedicated lock session (pg) contracts
// ---------------------------------------------------------------------------

/** Options accepted by {@link PostgresMemoryStore} / `createPostgresMemoryStore`. */
export interface PostgresMemoryStoreOptions {
  /**
   * Postgres connection string used ONLY to open the dedicated advisory-lock
   * session for `runPathExclusive` (compaction). The compactor runs outside
   * any Prisma transaction, so this session is deliberately separate from the
   * Prisma connection pool. It is never logged or echoed in error messages.
   */
  readonly databaseUrl?: string;
  /**
   * Test seam: build the lock-session client. Defaults to `pg.Client`.
   * Must implement `connect`/`query`/`end`; socket teardown releases the
   * session-level advisory lock automatically.
   */
  readonly pgClientFactory?: MemoryPgClientFactory;
}

/** Config passed to a {@link MemoryPgClientFactory}; contains the connection string plus a connect timeout. */
export interface MemoryPgClientConfig {
  readonly connectionString: string;
  readonly connectionTimeoutMillis?: number;
}

/** Minimal pg-like client surface used for the advisory lock session. */
export interface MemoryPgClient {
  connect(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<MemoryPgQueryResult>;
  end(): Promise<void>;
}

export interface MemoryPgQueryResult {
  readonly rows: unknown[];
  readonly rowCount: number | null;
}

export type MemoryPgClientFactory = (config: MemoryPgClientConfig) => MemoryPgClient;

const DEFAULT_LOCK_SESSION_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Attach safe no-op listeners for `error` and `end` on a lock-session client.
 *
 * Why: only the DEFAULT factory (real `pg.Client`) can sit idle on a dropped
 * socket for the whole duration of a long compaction. When that socket dies
 * mid-idle, pg emits EventEmitter `error`; without a listener the process
 * crashes (unhandled 'error'). The guards neutralize the EVENT only — query
 * failures keep rejecting normally (runPathExclusive finally-block unlock/end
 * and typed errors still fire), nothing is logged, and the connection string
 * is never printed. Injection fakes may lack `.on`; the guard is then a no-op
 * and returns false.
 */
export const attachLockSessionEventGuards = (client: unknown): boolean => {
  const target = client as
    | { on?: (event: string, handler: (...args: unknown[]) => void) => unknown }
    | null
    | undefined;
  if (!target || typeof target.on !== 'function') {
    return false;
  }
  const noop = (): void => {};
  target.on('error', noop);
  target.on('end', noop);
  return true;
};

/**
 * Default lock-session factory: a plain `pg.Client` (constructed lazily — no
 * I/O here) with the idle-socket safety guards above attached. Injected
 * factories are returned untouched; attach the guards yourself if your fake
 * must receive them.
 */
export const defaultPgClientFactory: MemoryPgClientFactory = (config) => {
  const client = new Client(config) as unknown as MemoryPgClient;
  attachLockSessionEventGuards(client);
  return client;
};

/** Raw projection of a memory block row (no embedding column — by design). */
interface MemoryBlockRow {
  readonly id: string;
  readonly scope: string;
  readonly path: string;
  readonly kind: string;
  readonly content: string;
  readonly confidence: number;
  readonly embeddingStatus: string;
  readonly embeddingModel: string | null;
  readonly accessCount: number;
  readonly supersededById: string | null;
  readonly metadata: Prisma.JsonValue | string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly embeddedAt: Date | null;
  readonly lastAccessedAt: Date | null;
  readonly cosineSimilarity?: number;
}

interface SupersedeTargetRow {
  readonly id: string;
  readonly scope: string;
  readonly supersededById: string | null;
}

interface MemoryRelationRow {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: string;
  readonly createdAt: Date;
}

/** Column projection shared by every block read (embedding excluded). */
const BLOCK_COLUMNS = Prisma.sql`
  "id", "scope", "path", "kind", "content", "confidence",
  "embeddingStatus", "embeddingModel", "accessCount", "supersededById",
  "metadata", "createdAt", "updatedAt", "embeddedAt", "lastAccessedAt"
`;

function normalizeMetadata(metadata: MemoryBlockRow['metadata']): MemoryMetadata {
  if (metadata === null || metadata === undefined) {
    return {};
  }
  if (typeof metadata === 'string') {
    try {
      const parsed: unknown = JSON.parse(metadata);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as MemoryMetadata;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as MemoryMetadata;
  }
  return {};
}

function toIso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function mapBlockRow(row: MemoryBlockRow): MemoryBlock {
  if (!isMemoryKind(row.kind)) {
    throw new MemoryValidationError(`memory block ${row.id} has an unknown kind: ${String(row.kind)}`);
  }
  if (!isEmbeddingStatus(row.embeddingStatus)) {
    throw new MemoryValidationError(`memory block ${row.id} has an unknown embedding status`);
  }
  return {
    id: row.id,
    scope: row.scope,
    path: row.path,
    kind: row.kind,
    content: row.content,
    confidence: row.confidence,
    embeddingStatus: row.embeddingStatus,
    embeddingModel: row.embeddingModel,
    accessCount: row.accessCount,
    supersededById: row.supersededById,
    metadata: normalizeMetadata(row.metadata),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    embeddedAt: toIso(row.embeddedAt),
    lastAccessedAt: toIso(row.lastAccessedAt),
  };
}

function buildFilters(
  params: Pick<MemoryQueryParams, 'scope' | 'pathPrefix' | 'kind' | 'keyword' | 'includeSuperseded'>,
  options?: { includeStatus?: boolean },
): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (params.scope !== undefined) {
    conditions.push(Prisma.sql`"scope" = ${params.scope}`);
  }
  if (params.pathPrefix !== undefined) {
    // starts_with has no wildcard semantics; equality covers the exact path.
    conditions.push(Prisma.sql`("path" = ${params.pathPrefix} OR starts_with("path", ${params.pathPrefix + '/'}))`);
  }
  if (params.kind !== undefined) {
    conditions.push(Prisma.sql`"kind" = ${params.kind}::"MemoryKind"`);
  }
  if (params.keyword !== undefined) {
    // ESCAPE '~' neutralizes %, _, \ inside the keyword (see escapeIlikePattern).
    conditions.push(Prisma.sql`"content" ILIKE ${ilikeContainsPattern(params.keyword)} ESCAPE '~'`);
  }
  if (!params.includeSuperseded) {
    conditions.push(Prisma.sql`"supersededById" IS NULL`);
  }
  if (options?.includeStatus) {
    conditions.push(Prisma.sql`"embeddingStatus" = 'ready'::"EmbeddingStatus"`);
  }
  return conditions;
}

function whereClause(conditions: readonly Prisma.Sql[]): Prisma.Sql {
  if (conditions.length === 0) {
    return Prisma.empty;
  }
  return Prisma.sql` WHERE ${Prisma.join(conditions, ' AND ')}`;
}

function orderClause(order: 'oldest' | 'newest'): Prisma.Sql {
  return Prisma.sql` ORDER BY "createdAt" ${order === 'oldest' ? Prisma.sql`ASC` : Prisma.sql`DESC`}, "id" ASC`;
}

function assertInsertData(data: MemoryBlockInsert): { scope: string; path: string; status: EmbeddingStatus } {
  const scope = normalizeScope(data.scope);
  const path = normalizeMemoryPath(data.path);
  if (!isMemoryKind(data.kind)) {
    throw new MemoryValidationError(`unknown memory kind: ${String(data.kind)}`);
  }
  if (typeof data.content !== 'string' || data.content.trim().length === 0) {
    throw new MemoryValidationError('content must be a non-empty string');
  }
  if (!Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1) {
    throw new MemoryValidationError('confidence must be a number between 0 and 1');
  }
  const status = data.embeddingStatus ?? 'pending';
  if (!isEmbeddingStatus(status)) {
    throw new MemoryValidationError(`unknown embedding status: ${String(status)}`);
  }
  return { scope, path, status };
}

function toIsoInput(value?: string | Date): string {
  if (value === undefined) {
    return new Date().toISOString();
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new MemoryValidationError('timestamps must be valid dates or ISO strings');
  }
  return date.toISOString();
}

export class PostgresMemoryStore implements MemoryStore {
  private readonly prisma: PrismaClient;

  private readonly lockSessionOptions: PostgresMemoryStoreOptions | undefined;

  /**
   * Cached pgvector capability flag (boolean ONLY — never extension data/cache
   * of rows). `undefined` means "not probed yet" or "probe failed, retry
   * later": probes run inside a short transaction and transient failures must
   * not poison the cache.
   */
  private pgvectorSupportsIterativeScan?: boolean;

  constructor(prisma: PrismaClient, options?: PostgresMemoryStoreOptions) {
    this.prisma = prisma;
    this.lockSessionOptions = options;
  }

  // -- lock session helpers (finding: advisory lock must not sit inside a
  //    Prisma interactive transaction, which would pin a pooled connection
  //    for the whole compaction and trip the P2028 timeout) ---------------

  private lockKeyFor(scope: string, path: string): string {
    return `${scope}:${path}`;
  }

  private async acquireSessionLock(client: MemoryPgClient, lockKey: string): Promise<void> {
    // Deterministic signed-hashtext bigint key; deterministic per (scope, path).
    await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [lockKey]);
  }

  private async releaseSessionLock(client: MemoryPgClient, lockKey: string): Promise<void> {
    // Session-level unlock; a dropped socket releases the lock regardless.
    await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [lockKey]);
  }

  // -- helpers ---------------------------------------------------------------

  private async getBlockIn(client: RawClient, id: string): Promise<MemoryBlock | null> {
    const rows = await client.$queryRaw<MemoryBlockRow[]>`
      SELECT ${BLOCK_COLUMNS} FROM "MemoryBlock" WHERE "id" = ${id}::uuid
    `;
    const row = rows[0];
    return row ? mapBlockRow(row) : null;
  }

  private async countActiveBlocksByPathIn(client: RawClient, scope: string, path: string): Promise<number> {
    const normalizedScope = normalizeScope(scope);
    const normalizedPath = normalizeMemoryPath(path);
    const rows = await client.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count" FROM "MemoryBlock"
      WHERE "scope" = ${normalizedScope} AND "path" = ${normalizedPath} AND "supersededById" IS NULL
    `;
    return rows[0]?.count ?? 0;
  }

  private async listActiveBlocksByPathIn(
    client: RawClient,
    scope: string,
    path: string,
    options: MemoryActiveBlockListOptions,
  ): Promise<readonly MemoryBlock[]> {
    if (!Number.isFinite(options.limit) || options.limit <= 0) {
      return [];
    }
    const normalizedScope = normalizeScope(scope);
    const normalizedPath = normalizeMemoryPath(path);
    const kindCondition = options.kind !== undefined ? Prisma.sql` AND "kind" = ${options.kind}::"MemoryKind"` : Prisma.empty;
    const rows = await client.$queryRaw<MemoryBlockRow[]>`
      SELECT ${BLOCK_COLUMNS} FROM "MemoryBlock"
      WHERE "scope" = ${normalizedScope} AND "path" = ${normalizedPath} AND "supersededById" IS NULL${kindCondition}
      ${orderClause(options.order === 'oldest' ? 'oldest' : 'newest')}
      LIMIT ${Math.floor(options.limit)}::int4
    `;
    return rows.map(mapBlockRow);
  }

  private async insertSupersedingBlockIn(
    client: RawClient,
    data: MemoryBlockInsert,
    supersedeTargetIds: readonly string[],
  ): Promise<MemoryBlock> {
    const { scope, path, status } = assertInsertData(data);
    const targets = [...new Set(supersedeTargetIds)];
    const id = data.id ?? randomUUID();

    if (targets.includes(id)) {
      throw new MemoryValidationError(`memory block ${id} cannot supersede itself`);
    }

    const nowIso = toIsoInput();
    const createdAtIso = toIsoInput(data.createdAt);

    // Lock + validate targets so failures leave no partial state.
    if (targets.length > 0) {
      const targetRows = await client.$queryRaw<SupersedeTargetRow[]>`
        SELECT "id", "scope", "supersededById" FROM "MemoryBlock"
        WHERE "id" IN (${Prisma.join(targets.map((targetId) => Prisma.sql`${targetId}::uuid`))})
        FOR UPDATE
      `;
      const byId = new Map<string, SupersedeTargetRow>(targetRows.map((row) => [row.id, row]));
      for (const targetId of targets) {
        const row = byId.get(targetId);
        if (!row) {
          throw new MemoryNotFoundError(`memory block ${targetId} not found`);
        }
        if (row.scope !== scope) {
          throw new MemoryConflictError(
            `superseding block ${targetId} requires both blocks in the same scope (target is "${row.scope}", write is "${scope}")`,
          );
        }
        if (row.supersededById !== null) {
          throw new MemoryConflictError(`memory block ${targetId} is already superseded by ${row.supersededById}`);
        }
      }
    }

    const metadataJson = JSON.stringify(data.metadata ?? {});

    await client.$executeRaw`
      INSERT INTO "MemoryBlock"
        ("id", "scope", "path", "kind", "content", "confidence", "embeddingStatus", "metadata", "createdAt", "updatedAt")
      VALUES
        (${id}::uuid, ${scope}, ${path}, ${data.kind}::"MemoryKind", ${data.content},
         ${data.confidence}::double precision, ${status}::"EmbeddingStatus",
         ${metadataJson}::jsonb, ${createdAtIso}::timestamp, ${nowIso}::timestamp)
    `;

    if (targets.length > 0) {
      const relationRows = Prisma.join(
        targets.map((targetId) => Prisma.sql`(${randomUUID()}::uuid, ${id}::uuid, ${targetId}::uuid, 'supersedes'::"MemoryRelationType", ${nowIso}::timestamp)`),
      );
      await client.$executeRaw`
        INSERT INTO "MemoryRelation" ("id", "sourceId", "targetId", "type", "createdAt")
        VALUES ${relationRows}
      `;
      const updated = await client.$executeRaw`
        UPDATE "MemoryBlock"
        SET "supersededById" = ${id}::uuid, "updatedAt" = ${nowIso}::timestamp
        WHERE "id" IN (${Prisma.join(targets.map((targetId) => Prisma.sql`${targetId}::uuid`))})
          AND "supersededById" IS NULL
      `;
      if (updated !== targets.length) {
        // Concurrent supersede slipped between lock and mark (defensive; the
        // FOR UPDATE lock should already prevent this).
        throw new MemoryConflictError('a supersede target was superseded concurrently');
      }
      // supersededById is intentionally NON-unique in the database (many
      // sources may share one summary id); per-source one-successor integrity
      // comes from this guarded UPDATE plus the FOR UPDATE validation above.
    }

    return {
      id,
      scope,
      path,
      kind: data.kind,
      content: data.content,
      confidence: data.confidence,
      embeddingStatus: status,
      embeddingModel: null,
      accessCount: 0,
      supersededById: null,
      metadata: structuredClone(data.metadata ?? {}),
      createdAt: createdAtIso,
      updatedAt: nowIso,
      embeddedAt: null,
      lastAccessedAt: null,
    };
  }

  // -- MemoryStoreTxView (also used inside runPathExclusive) ------------------

  async countActiveBlocksByPath(scope: string, path: string): Promise<number> {
    return this.countActiveBlocksByPathIn(this.prisma, scope, path);
  }

  async listActiveBlocksByPath(
    scope: string,
    path: string,
    options: MemoryActiveBlockListOptions,
  ): Promise<readonly MemoryBlock[]> {
    return this.listActiveBlocksByPathIn(this.prisma, scope, path, options);
  }

  async insertSupersedingBlock(
    data: MemoryBlockInsert,
    supersedeTargetIds: readonly string[],
  ): Promise<MemoryBlock> {
    return this.prisma.$transaction(async (tx) => {
      return this.insertSupersedingBlockIn(tx, data, supersedeTargetIds);
    });
  }

  // -- block reads -------------------------------------------------------------

  async getBlock(id: string): Promise<MemoryBlock | null> {
    return this.getBlockIn(this.prisma, id);
  }

  async getBlocks(ids: readonly string[]): Promise<ReadonlyMap<string, MemoryBlock>> {
    const uniqueIds = [...new Set(ids)];
    const result = new Map<string, MemoryBlock>();
    if (uniqueIds.length === 0) {
      return result;
    }
    const rows = await this.prisma.$queryRaw<MemoryBlockRow[]>`
      SELECT ${BLOCK_COLUMNS} FROM "MemoryBlock"
      WHERE "id" IN (${Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}::uuid`))})
    `;
    for (const row of rows) {
      result.set(row.id, mapBlockRow(row));
    }
    return result;
  }

  async queryBlocks(params: MemoryQueryParams): Promise<readonly MemoryBlock[]> {
    if (!Number.isFinite(params.limit) || params.limit <= 0) {
      return [];
    }
    const conditions = buildFilters(params);
    const rows = await this.prisma.$queryRaw<MemoryBlockRow[]>`
      SELECT ${BLOCK_COLUMNS} FROM "MemoryBlock"${whereClause(conditions)}
      ${orderClause('newest')}
      LIMIT ${Math.floor(params.limit)}::int4
    `;
    return rows.map(mapBlockRow);
  }

  // -- compaction critical section ---------------------------------------------

  /**
   * Serialize work per (scope, path) with a SESSION-level advisory lock held
   * on a dedicated `pg.Client` connection OUTSIDE the Prisma pool and outside
   * any Prisma transaction. The compactor (LLM) runs inside `work` — it must
   * never hold a Prisma interactive transaction (P2028 5s/60s timeout risk
   * and a pinned pooled connection) — while each `ops` operation opens its
   * own short transaction underneath the shared lock. A dropped socket
   * releases the lock automatically (Postgres cleans up session locks), so a
   * crashed runner cannot wedge a path.
   */
  async runPathExclusive<T>(
    scope: string,
    path: string,
    work: (ops: MemoryStoreTxView) => Promise<T>,
  ): Promise<T> {
    const normalizedScope = normalizeScope(scope);
    const normalizedPath = normalizeMemoryPath(path);
    const lockKey = this.lockKeyFor(normalizedScope, normalizedPath);

    const databaseUrl = this.lockSessionOptions?.databaseUrl;
    if (!databaseUrl) {
      throw new MemoryConfigurationError(
        'createPostgresMemoryStore requires options.databaseUrl so compaction can acquire the per-path session lock',
      );
    }

    const clientFactory = this.lockSessionOptions?.pgClientFactory ?? defaultPgClientFactory;
    const client = clientFactory({
      connectionString: databaseUrl,
      connectionTimeoutMillis: DEFAULT_LOCK_SESSION_CONNECT_TIMEOUT_MS,
    });

    try {
      await client.connect();
    } catch (cause) {
      // cause may carry host details; never the URL. Generic message keeps
      // logs free of the connection string.
      throw new MemoryConfigurationError('could not open the memory lock session', { cause });
    }
    try {
      await this.acquireSessionLock(client, lockKey);

      try {
        // Ops run against the NORMAL Prisma pool; no interactive transaction
        // wraps `work`. Each mutating op (insertSupersedingBlock) opens its
        // own short transaction with the established FOR UPDATE + guarded
        // UPDATE atomicity.
        const ops: MemoryStoreTxView = {
          countActiveBlocksByPath: (opsScope, opsPath) => this.countActiveBlocksByPath(opsScope, opsPath),
          listActiveBlocksByPath: (opsScope, opsPath, opsOptions) =>
            this.listActiveBlocksByPath(opsScope, opsPath, opsOptions),
          insertSupersedingBlock: (data, targets) => this.insertSupersedingBlock(data, targets),
        };
        return await work(ops);
      } finally {
        // Best-effort unlock; if it fails, `client.end()` closes the session
        // and Postgres releases session locks on connection teardown anyway.
        try {
          await this.releaseSessionLock(client, lockKey);
        } catch {
          /* unlock failure must not mask work results or errors */
        }
      }
    } finally {
      try {
        await client.end();
      } catch {
        /* teardown failure must not mask work results or errors */
      }
    }
  }

  // -- embedding state -----------------------------------------------------------

  async markEmbeddingReady(id: string, update: MemoryEmbeddingReadyUpdate): Promise<void> {
    if (update.embedding.length !== MEMORY_EMBEDDING_DIMENSIONS) {
      throw new MemoryValidationError(
        `embedding must contain exactly ${MEMORY_EMBEDDING_DIMENSIONS} values, got ${update.embedding.length}`,
      );
    }
    const vectorLiteral = memoryVectorToPgLiteral(update.embedding);
    const model = update.model;
    if (typeof model !== 'string' || model.length === 0) {
      throw new MemoryValidationError('embedding model must be a non-empty string');
    }
    const embeddedAtIso = toIsoInput(update.embeddedAt);
    const nowIso = new Date().toISOString();
    const updated = await this.prisma.$executeRaw`
      UPDATE "MemoryBlock"
      SET "embedding" = ${vectorLiteral}::vector,
          "embeddingStatus" = 'ready'::"EmbeddingStatus",
          "embeddingModel" = ${model},
          "embeddedAt" = ${embeddedAtIso}::timestamp,
          "updatedAt" = ${nowIso}::timestamp
      WHERE "id" = ${id}::uuid
    `;
    if (updated === 0) {
      throw new MemoryNotFoundError(`memory block ${id} not found`);
    }
  }

  async markEmbeddingFailed(id: string, update: MemoryEmbeddingFailedUpdate): Promise<void> {
    const nowIso = new Date().toISOString();
    const updated = await this.prisma.$executeRaw`
      UPDATE "MemoryBlock"
      SET "embeddingStatus" = 'failed'::"EmbeddingStatus",
          "embeddingModel" = ${update.model},
          "updatedAt" = ${nowIso}::timestamp
      WHERE "id" = ${id}::uuid
    `;
    if (updated === 0) {
      throw new MemoryNotFoundError(`memory block ${id} not found`);
    }
  }

  // -- vector search ---------------------------------------------------------------

  /**
   * Fetch READY, non-superseded candidates inside ONE SHORT Prisma transaction
   * that first applies HNSW recall settings via parameterized `set_config`
   * (SET LOCAL cannot take bind parameters):
   * - `hnsw.ef_search` = {@link SEMANTIC_HNSW_EF_SEARCH} (200 > pgvector default 40;
   *   the fetch itself is capped at {@link SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT}).
   * - `hnsw.iterative_scan = relaxed_order` ONLY when the installed pgvector
   *   extension version is >= {@link HNSW_ITERATIVE_SCAN_MIN_EXTVERSION} (0.8.0).
   *   The capability probe result is cached as a boolean only; probe failures
   *   are not cached and retry on the next search.
   */
  async nearestReadyCandidates(params: MemoryVectorSearchParams): Promise<readonly MemoryVectorCandidate[]> {
    if (!Number.isFinite(params.limit) || params.limit <= 0) {
      return [];
    }
    const vectorLiteral = memoryVectorToPgLiteral(params.embedding);
    const conditions = buildFilters(
      { scope: params.scope, pathPrefix: params.pathPrefix, kind: params.kind, includeSuperseded: false },
      { includeStatus: true },
    );
    const rows = await this.prisma.$transaction(async (tx) => {
      // Trusted constants bound as values; no user input in settings.
      await tx.$queryRaw`SELECT set_config('hnsw.ef_search', ${String(SEMANTIC_HNSW_EF_SEARCH)}, true)`;
      if (this.pgvectorSupportsIterativeScan === undefined) {
        this.pgvectorSupportsIterativeScan = await this.probeIterativeScanSupport(tx);
      }
      if (this.pgvectorSupportsIterativeScan) {
        await tx.$queryRaw`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`;
      }
      return tx.$queryRaw<MemoryBlockRow[]>`
        SELECT ${BLOCK_COLUMNS},
               (1 - ("embedding" <=> ${vectorLiteral}::vector))::double precision AS "cosineSimilarity"
        FROM "MemoryBlock"
        WHERE "embedding" IS NOT NULL
          AND ${Prisma.join(conditions, ' AND ')}
        ORDER BY "embedding" <=> ${vectorLiteral}::vector ASC, "createdAt" DESC, "id" ASC
        LIMIT ${Math.floor(params.limit)}::int4
      `;
    });
    return rows.map((row) => {
      const block = mapBlockRow(row);
      const cosineSimilarity = typeof row.cosineSimilarity === 'number' ? row.cosineSimilarity : 0;
      return { cosineSimilarity, block };
    });
  }

  /**
   * Probe whether the installed pgvector extension supports
   * `hnsw.iterative_scan` (requires extversion >= 0.8.0). Returns the cached
   * boolean on success; on probe failure returns `undefined` so the caller
   * does NOT cache a possibly-wrong capability.
   */
  private async probeIterativeScanSupport(tx: RawClient): Promise<boolean | undefined> {
    try {
      const rows = await tx.$queryRaw<{ extversion: string }[]>`
        SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1
      `;
      const version = rows[0]?.extversion;
      if (typeof version !== 'string') {
        // Extension absent: deterministic negative result, safe to cache.
        return false;
      }
      return compareExtensionVersion(version, HNSW_ITERATIVE_SCAN_MIN_EXTVERSION);
    } catch {
      return undefined;
    }
  }

  // -- relations and access -----------------------------------------------------------

  private async listRelationsIn(
    client: RawClient,
    id: string,
    direction: 'source' | 'target',
  ): Promise<readonly MemoryRelation[]> {
    const rows = await client.$queryRaw<MemoryRelationRow[]>`
      SELECT "id", "sourceId", "targetId", "type"::text AS "type", "createdAt"
      FROM "MemoryRelation"
      WHERE ${direction === 'source' ? Prisma.sql`"sourceId"` : Prisma.sql`"targetId"`} = ${id}::uuid
      ORDER BY "createdAt" ASC, "id" ASC
    `;
    return rows.map((row) => {
      if (!isMemoryRelationType(row.type)) {
        throw new MemoryValidationError(`memory relation ${row.id} has an unknown type: ${String(row.type)}`);
      }
      return {
        id: row.id,
        sourceId: row.sourceId,
        targetId: row.targetId,
        type: row.type,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  async listRelationsBySource(id: string): Promise<readonly MemoryRelation[]> {
    return this.listRelationsIn(this.prisma, id, 'source');
  }

  async listRelationsByTarget(id: string): Promise<readonly MemoryRelation[]> {
    return this.listRelationsIn(this.prisma, id, 'target');
  }

  async touchAccessed(ids: readonly string[]): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return;
    }
    const nowIso = new Date().toISOString();
    await this.prisma.$executeRaw`
      UPDATE "MemoryBlock"
      SET "accessCount" = "accessCount" + 1,
          "lastAccessedAt" = ${nowIso}::timestamp,
          "updatedAt" = ${nowIso}::timestamp
      WHERE "id" IN (${Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}::uuid`))})
    `;
  }
}

/**
 * Build the pgvector-backed store. The caller owns the PrismaClient lifecycle
 * (`$disconnect`, and `prisma migrate deploy` of the memory migration in
 * `packages/core/prisma/migrations`).
 *
 * `options.databaseUrl` is REQUIRED for `runPathExclusive` (compaction): it
 * opens a dedicated pg session per run to hold the session-level advisory
 * lock while the compactor runs OUTSIDE any Prisma transaction. Callers that
 * never compact may omit it; the API/server integration must pass it.
 *
 * Signature: `createPostgresMemoryStore(prisma, options?:
 * PostgresMemoryStoreOptions)` with `options =
 * { databaseUrl: string, pgClientFactory?: (config) => MemoryPgClient }`.
 */
export function createPostgresMemoryStore(
  prisma: PrismaClient,
  options?: PostgresMemoryStoreOptions,
): MemoryStore {
  return new PostgresMemoryStore(prisma, options);
}
