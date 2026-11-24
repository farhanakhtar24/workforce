/**
 * `query_data` backend (Phase 4 + pre-Phase 6 DB-enforced isolation): one
 * read-only SELECT/WITH statement over the project Postgres, wrapped with a
 * row cap and a statement timeout, executed as the restricted
 * `workforce_query_reader` role with the owner-bound RLS policies.
 *
 * Layers (in order):
 * 1. `screenSql` (pure): strips comments, requires exactly one statement whose
 *    leading keyword is SELECT or WITH, rejects semicolons, blank SQL, and
 *    mutation keywords anywhere (data-modifying CTEs `WITH x AS (DELETE …)`
 *    included; string literals with those words are also rejected — accepted
 *    false positives, safer wrong side) plus the session-state function
 *    tokens (set_config/current_setting/advisory/…), so no statement can
 *    ever change its role or re-point the RLS policy GUCs.
 * 2. `wrapForRowCap` (pure): `SELECT * FROM ( <sql> ) AS __workforce_rows
 *    LIMIT <cap + 1>` — cap + 1 rows means over-cap → fixed 400, never silent
 *    truncation.
 * 3. Execution: one connection from the injected pool, `BEGIN READ ONLY`,
 *    `SET LOCAL statement_timeout = <ms>`, `SET LOCAL workforce.user_id` +
 *    `SET LOCAL workforce.memory_scope` (charset-validated owner context
 *    from the RESOLVED request identity — the DB-enforced isolation of the
 *    `20261125000100_query_data_rls` migration), `SET LOCAL ROLE
 *    workforce_query_reader`, the wrapped statement, `COMMIT`. All
 *    transaction-local state reverts at the end; `DISCARD ALL` always runs.
 *
 * Errors: fixed safe messages only — SQL text, Postgres errors, connection
 * URLs and secrets never appear in any thrown message or log.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';

/** Result rows carried to the route; `truncated` reflects client-side `limit`. */
export interface DataQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly unknown[][];
  readonly rowCount: number;
  readonly truncated: boolean;
}

/** Typed failure the route maps to fixed HTTP errors without echoing content. */
export class DataQueryError extends Error {
  readonly kind: 'invalid' | 'row_cap' | 'timeout' | 'read_only' | 'unavailable';

  constructor(kind: DataQueryError['kind'], message: string) {
    super(message);
    this.name = 'DataQueryError';
    this.kind = kind;
  }
}

/** Postgres statement_timeout cancellation code (`statement_timeout` fired). */
const PG_QUERY_CANCELED = '57014';
/** Postgres code raised when a write is attempted in a READ ONLY transaction. */
const PG_READ_ONLY_TRANSACTION = '25006';

// ---------------------------------------------------------------------------
// Pure screening + wrapping
// ---------------------------------------------------------------------------

/** Strips `--` line comments and `/* … *\/` block comments (quote-aware). */
export function stripSqlComments(sql: string): string {
  let output = '';
  let index = 0;
  let inSingleQuote = false;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (inSingleQuote) {
      if (char === "'") {
        if (next === "'") {
          output += "''";
          index += 2;
          continue;
        }
        inSingleQuote = false;
      }
      output += char;
      index += 1;
      continue;
    }
    if (char === "'") {
      inSingleQuote = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

const MUTATION_KEYWORDS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'upsert',
  'create',
  'alter',
  'drop',
  'truncate',
  'grant',
  'revoke',
  'copy',
  'call',
  'do',
  'set',
  'begin',
  'commit',
  'abort',
  'rollback',
  'savepoint',
  'vacuum',
  'analyze',
  'reindex',
  'cluster',
  'discard',
  'notify',
  'listen',
  'lock',
  'import',
  'refresh',
  'reassign',
  'move',
]);

const WORDISH = /^[A-Za-z]+$/;

export type SqlScreenResult =
  | { ok: true; statement: string }
  | { ok: false; reason: 'empty' | 'multiple_statements' | 'leading_keyword' | 'mutation_keyword' | 'dangerous_function' };

/**
 * Session-level side-effect functions: advisory locks, GUC writes and delay
 * primitives poison a pooled connection even inside a READ ONLY transaction.
 * Plain substring matching (case-insensitive, comment-stripped text) keeps
 * these out; false positives on ordinary SQL are accepted — the safer wrong
 * side.
 */
const DANGEROUS_FUNCTION_TOKENS: readonly string[] = [
  'pg_advisory',
  'pg_sleep',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_read_file',
  'pg_ls_dir',
  'pg_stat_file',
  'lo_import',
  'lo_export',
  'set_config',
  'current_setting',
];

/**
 * Pure statement screen: one statement only, leading SELECT/WITH, no
 * semicolons, no mutation keywords, no session-state functions. Returns a
 * reason code (never the SQL).
 */
export function screenSql(rawSql: string): SqlScreenResult {
  if (typeof rawSql !== 'string' || rawSql.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const stripped = stripSqlComments(rawSql);
  const statement = stripped.trim();
  if (statement.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (statement.includes(';')) {
    return { ok: false, reason: 'multiple_statements' };
  }
  const firstWordMatch = /^[A-Za-z]+/.exec(statement);
  const leading = firstWordMatch?.[0] ?? '';
  if (!WORDISH.test(leading) || (leading.toLowerCase() !== 'select' && leading.toLowerCase() !== 'with')) {
    return { ok: false, reason: 'leading_keyword' };
  }
  const lowered = statement.toLowerCase();
  // Session-state tokens are checked FIRST (specific, non-keyword tokens like
  // pg_advisory/set_config would otherwise surface as a generic mutation hit).
  for (const token of DANGEROUS_FUNCTION_TOKENS) {
    if (lowered.includes(token)) {
      return { ok: false, reason: 'dangerous_function' };
    }
  }
  // Any mutation keyword anywhere in the statement rejects it (data-modifying
  // CTEs hide writes behind a legal WITH). Keyword-boundary matched, so
  // identifiers like `created_at` never trigger it.
  const keywordPattern = /[A-Za-z]+/g;
  let match: RegExpExecArray | null;
  while ((match = keywordPattern.exec(statement)) !== null) {
    const word = match[0];
    if (WORDISH.test(word) && MUTATION_KEYWORDS.has(word.toLowerCase())) {
      return { ok: false, reason: 'mutation_keyword' };
    }
  }
  return { ok: true, statement };
}

/**
 * Wraps the statement with a bounded row cap: `cap + 1` rows prove the answer
 * exceeds the cap (fixed error) without silently dropping rows.
 */
export function wrapForRowCap(statement: string, cap: number): string {
  return `SELECT * FROM (${statement}) AS __workforce_rows LIMIT ${String(cap + 1)}`;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Minimal structural pool surface (real `pg.Pool` satisfies it; tests fake). */
export interface QueryClientLike {
  query(text: string): Promise<{ rows: unknown[]; fields: Array<{ name: string }>; rowCount?: number }>;
  release(): void;
}

export interface QueryPoolLike {
  connect(): Promise<QueryClientLike>;
  end?(): Promise<void>;
}

export interface DataQueryServiceOptions {
  /** Bounded read-only pool; production builds one over DATABASE_URL. */
  readonly pool: QueryPoolLike;
  /** statement_timeout in ms (default from `QUERY_STATEMENT_TIMEOUT_MS`). */
  readonly statementTimeoutMs: number;
  /** Row cap enforced with cap+1 detection (default `QUERY_ROW_CAP`). */
  readonly rowCap: number;
}

const ROW_ALIAS = '__workforce_rows';

export function createDataQueryService(options: DataQueryServiceOptions): DataQueryService {
  return new DataQueryService(options);
}

/** Narrow result the transaction returns (pg QueryResult satisfies it). */
interface QueryOutcome {
  readonly rows: unknown[];
  readonly fields: Array<{ name: string }>;
  readonly rowCount?: number;
}

/**
 * The authenticated owner context bound into the query transaction:
 * `workforce.user_id` (RLS `ownerId` policies) and `workforce.memory_scope`
 * (RLS `scope` policies). NEVER accepted from SQL, body, or query strings —
 * only from the RESOLVED auth owner at the route/token boundary.
 */
export interface DataQueryOwner {
  /** Better Auth `User.id` (ownerId policy binding). */
  readonly ownerId: string;
  /** `userMemoryScope(ownerId)` (memory block scope policy binding). */
  readonly memoryScope: string;
}

/** Owner id shape (Better Auth `User.id`): no quotes/semicolons/GUC tricks. */
const DATA_QUERY_OWNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Memory scope shape (`userMemoryScope` output charset). */
const DATA_QUERY_MEMORY_SCOPE_PATTERN = /^[a-z0-9_-]{1,64}$/;

/**
 * Validates the shapes: the values are interpolated into `SET LOCAL`
 * (Postgres cannot parameterize SET), so the charset guarantee IS the
 * injection firewall on top of the RLS boundary itself.
 */
function validateQueryOwner(owner: DataQueryOwner | undefined): DataQueryOwner {
  if (owner === undefined || owner === null) {
    // Fail-closed: an unauthenticated context never reaches the database.
    throw new DataQueryError('invalid', 'owner context');
  }
  if (typeof owner.ownerId !== 'string' || !DATA_QUERY_OWNER_ID_PATTERN.test(owner.ownerId)) {
    throw new DataQueryError('invalid', 'owner id');
  }
  if (typeof owner.memoryScope !== 'string' || !DATA_QUERY_MEMORY_SCOPE_PATTERN.test(owner.memoryScope)) {
    throw new DataQueryError('invalid', 'memory scope');
  }
  return owner;
}

export class DataQueryService {
  private readonly pool: QueryPoolLike;
  private readonly statementTimeoutMs: number;
  private readonly rowCap: number;

  constructor(options: DataQueryServiceOptions) {
    if (!options?.pool || typeof options.pool.connect !== 'function') {
      throw new DataQueryError('unavailable', 'Data query service requires a pool.');
    }
    this.pool = options.pool;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.rowCap = options.rowCap;
  }

  /**
   * Runs ONE screened statement in a READ ONLY transaction with a statement
   * timeout AND the DB-enforced isolation boundary: the authenticated owner
   * context binds the RLS policies, the statement then executes under
   * `SET LOCAL ROLE workforce_query_reader` (NOLOGIN role, NOBYPASSRLS, and
   * — per migration `20261125000100_query_data_rls` — SELECT-only on the
   * nine data tables with RLS policies that bind `ownerId`/`scope` to the
   * transaction GUCs; the Better Auth tables carry no grants at all).
   * `limit` (user-supplied, bounded by the cap) truncates the returned rows
   * client-side after the cap+1 fetch and reports `truncated`. `SELECT 1`
   * keeps working under the same role (it touches no tables).
   *
   * The owner context is REQUIRED (fail-closed): an unauthenticated caller
   * never reaches the database, and the context is only ever passed from
   * the resolved request owner — never from SQL, body, or query strings.
   *
   * Pool hygiene (B1): on EVERY non-committed failure the transaction is
   * rolled back best-effort and the session is reset with `DISCARD ALL`
   * before the client is released — an aborted transaction never poisons a
   * pooled connection for the next tenant of that client. All role/GUC/
   * timeout state is `SET LOCAL` and reverts at transaction end anyway.
   */
  async query(rawSql: string, limit?: number, owner?: DataQueryOwner): Promise<DataQueryResult> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > this.rowCap)) {
      throw new DataQueryError('invalid', 'limit');
    }
    const ownerContext = validateQueryOwner(owner);
    const screen = screenSql(rawSql);
    if (!screen.ok) {
      throw new DataQueryError('invalid', screen.reason);
    }
    const wrapped = wrapForRowCap(screen.statement, this.rowCap);

    let client: QueryClientLike;
    try {
      client = await this.pool.connect();
    } catch {
      throw new DataQueryError('unavailable', 'connect');
    }
    try {
      const result = await this.runInTransaction(client, wrapped, ownerContext);
      const rows: unknown[][] = (result.rows as unknown[]).map((row) =>
        Array.isArray(row) ? row : Object.values(row as Record<string, unknown>),
      );
      const columns = (result.fields ?? []).map((field) => String(field.name));
      const truncated = limit !== undefined && rows.length > limit;
      const boundedRows = truncated ? rows.slice(0, limit) : rows;
      return {
        columns,
        rows: boundedRows,
        rowCount: boundedRows.length,
        truncated,
      };
    } finally {
      // Session-level reset no matter how the transaction ended: leftover
      // session state (locks/SETs) cannot leak into the next borrower.
      try {
        await client.query('DISCARD ALL');
      } catch {
        /* best effort: the pool owns the client's fate */
      }
      try {
        client.release();
      } catch {
        /* best effort: pool owns recovery */
      }
    }
  }

  private async runInTransaction(client: QueryClientLike, wrapped: string, owner: DataQueryOwner): Promise<QueryOutcome> {
    let began = false;
    try {
      await client.query('BEGIN READ ONLY');
      began = true;
      // `SET LOCAL` is transaction-scoped and cannot be parameterized; the
      // only interpolations are the integer (validated at config load) and
      // the owner/scope strings (charset-validated above) — on top of the
      // RLS boundary, never instead of it.
      await client.query(`SET LOCAL statement_timeout = ${String(this.statementTimeoutMs)}`);
      await client.query(`SET LOCAL workforce.user_id = '${owner.ownerId}'`);
      await client.query(`SET LOCAL workforce.memory_scope = '${owner.memoryScope}'`);
      // The user statement runs as the restricted reader role: NOLOGIN (can
      // never be a session identity), NOBYPASSRLS, and per the migration
      // holding SELECT ONLY on the policy-bound data tables.
      await client.query('SET LOCAL ROLE workforce_query_reader');
      const result = await client.query(wrapped);
      const rowCount = Array.isArray(result.rows) ? result.rows.length : 0;
      if (rowCount > this.rowCap) {
        // Rows beyond the cap are discarded: cap+1 detection is a hard 400,
        // never silent truncation, so the read result is not committed.
        throw new DataQueryError('row_cap', 'row cap exceeded');
      }
      await client.query('COMMIT');
      return result;
    } catch (error: unknown) {
      if (began) {
        // Best-effort ROLLBACK before the release: an aborted or half-open
        // transaction must not poison the pooled client (B1). `SET LOCAL
        // ROLE` reverts with the transaction end in every case.
        try {
          await client.query('ROLLBACK');
        } catch {
          /* best effort */
        }
      }
      if (error instanceof DataQueryError) {
        throw error;
      }
      const code = (error as { code?: unknown }).code;
      if (code === PG_QUERY_CANCELED || (error as { name?: unknown }).name === 'AbortError') {
        throw new DataQueryError('timeout', 'statement timeout');
      }
      if (code === PG_READ_ONLY_TRANSACTION) {
        throw new DataQueryError('read_only', 'read only');
      }
      // A missing/ungranted query role or denied privileges (e.g. the RLS
      // migration has not been applied, or membership is missing) maps to
      // the same honest 503: fail-closed, never a weaker fallback path.
      throw new DataQueryError('unavailable', 'query failed');
    }
  }
}

/** Route-level safe mapping: never echoes SQL, PG errors, or URLs. */
export function dataQueryErrorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof DataQueryError) {
    switch (error.kind) {
      case 'invalid':
        return { status: 400, message: 'Invalid data query.' };
      case 'row_cap':
        return { status: 400, message: 'Data query exceeded the row cap.' };
      case 'timeout':
        return { status: 503, message: 'Data query timed out.' };
      case 'read_only':
        return { status: 400, message: 'Data queries must be read-only.' };
      case 'unavailable':
        return { status: 503, message: 'Data query service is temporarily unavailable.' };
    }
  }
  return { status: 500, message: 'Internal server error.' };
}

/** Re-export for the server wiring (pool type only; no runtime import chain). */
export type { Pool };
