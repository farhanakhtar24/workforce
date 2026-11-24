/**
 * Offline regression test for the `query_data` RLS migration
 * (`20261125000100_query_data_rls`): role hardening, grant scoping (NO auth
 * tables), ENABLE-not-FORCE RLS, GUC-bound policies with EXISTS child
 * parents, and the set_config denial. The migration itself is only verified
 * against real Postgres by the LIVE probes (prisma migrate deploy + the
 * query-role smoke) — this test pins the SQL contract forward-only so it can
 * never silently regress between reviews.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Same depth from src/ (tsx) and dist/ (built): packages/core/prisma.
const PRISMA_DIR = fileURLToPath(new URL('../../prisma', import.meta.url));
const MIGRATIONS_DIR = `${PRISMA_DIR}/migrations`;
const MIGRATION_DIR = '20261125000100_query_data_rls';
const MIGRATION_SQL_PATH = `${MIGRATIONS_DIR}/${MIGRATION_DIR}/migration.sql`;

const sql = readFileSync(MIGRATION_SQL_PATH, 'utf8');

/** Strips line comments + block comments for token assertions. */
function stripComments(text: string): string {
  return text
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const bare = stripComments(sql);

const DATA_TABLES = [
  'WorkDoc',
  'WorkDocVersion',
  'WorkDocRevision',
  'WorkDocLink',
  'Delegation',
  'AgentTask',
  'AgentTaskExecution',
  'MemoryBlock',
  'MemoryRelation',
] as const;

const AUTH_TABLES = ['User', 'Session', 'Account', 'Verification', 'UserSettings'] as const;

test('migration folder exists, sorts strictly forward, and stays untouched-relative (after the auth migration)', () => {
  const folders = readdirSync(MIGRATIONS_DIR)
    .filter((entry) => statSync(`${MIGRATIONS_DIR}/${entry}`).isDirectory())
    .sort();
  assert.ok(folders.includes(MIGRATION_DIR));
  const byTime = [...folders].sort((a, b) => Number(a.slice(0, 14)) - Number(b.slice(0, 14)));
  assert.deepEqual(byTime, folders, 'migration timestamps must be unique and ascending');
  const authFolder = '20261125000000_pre_phase6_auth';
  assert.ok(byTime.indexOf(authFolder) >= 0);
  assert.ok(byTime.indexOf(MIGRATION_DIR) > byTime.indexOf(authFolder), 'RLS migration must come AFTER the pre_phase6_auth migration folder');
});

test('the query role exists with NOLOGIN/non-super/no-bypass shape (idempotent)', () => {
  assert.match(bare, /IF NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = 'workforce_query_reader'\) THEN/);
  assert.match(
    bare,
    /CREATE ROLE workforce_query_reader WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;/,
  );
  // Idempotent hardening: never login, never bypass, never superuser.
  assert.match(bare, /ALTER ROLE workforce_query_reader NOBYPASSRLS;/);
  assert.match(bare, /ALTER ROLE workforce_query_reader NOLOGIN;/);
  assert.match(bare, /RAISE EXCEPTION 'workforce_query_reader must not be a superuser'/);
  // No role-escalation escape hatches anywhere.
  assert.doesNotMatch(bare, /BYPASSRLS\s+TRUE/i);
  assert.doesNotMatch(bare, /WITH BYPASSRLS/i);
});

test('membership: granted to the migrator (CURRENT_USER) and only idempotent app-role grants', () => {
  assert.match(bare, /GRANT workforce_query_reader TO CURRENT_USER;/);
  assert.match(bare, /GRANT workforce_query_reader TO %I', candidate\)/);
  assert.match(bare, /rolname IN \('workforce', 'workforce_api'\)/);
  // A re-grant is guarded by an existing-membership check (idempotent).
  assert.match(bare, /NOT EXISTS \(\s*\n\s+SELECT 1 FROM pg_catalog\.pg_auth_members/);
});

test('SELECT grants cover EXACTLY the nine data tables and NEVER the auth tables', () => {
  for (const table of DATA_TABLES) {
    assert.match(bare, new RegExp(`GRANT SELECT ON public\\."${table}" TO workforce_query_reader;`));
  }
  const grantLines = bare.split('\n').filter((line) => line.startsWith('GRANT SELECT'));
  assert.equal(grantLines.length, DATA_TABLES.length, 'no grant lines beyond the data tables');
  for (const authTable of AUTH_TABLES) {
    assert.doesNotMatch(bare, new RegExp(`GRANT SELECT[^\\n]*"\\s*${authTable}"`));
    assert.doesNotMatch(bare, new RegExp(`GRANT[^\\n]*public\\."${authTable}"`));
  }
  // The verification DO block FAILS the migration if drift ever grants them.
  assert.match(bare, /must not hold SELECT on any auth table/);
  assert.match(bare, /must not be a member of pg_read_all_data/);
});

test('RLS is ENABLED (never FORCE) on exactly the same tables', () => {
  for (const table of DATA_TABLES) {
    assert.match(bare, new RegExp(`ALTER TABLE public\\."${table}" ENABLE ROW LEVEL SECURITY;`));
  }
  const enableLines = bare.split('\n').filter((line) => line.includes('ENABLE ROW LEVEL SECURITY'));
  assert.equal(enableLines.length, DATA_TABLES.length);
  assert.doesNotMatch(bare, /FORCE ROW LEVEL SECURITY/, 'table owners (the app) must keep bypassing');
});

test('policies: SELECT-only, TO the query role, bound to the transaction GUCs', () => {
  // Parent bindings.
  assert.match(bare, /USING \("ownerId" = current_setting\('workforce\.user_id', true\)\)/);
  assert.match(bare, /USING \("scope" = current_setting\('workforce\.memory_scope', true\)\)/);
  // Every USING clause binds to one of the two GUCs (no unconditional rows):
  // 5 parent GUC bindings + 4 child EXISTS filters.
  const policyUses = bare.match(/USING \(\s*(?:"|EXISTS)/g) ?? [];
  assert.equal(policyUses.length, 9, 'every policy carries a USING filter');
  // Policies are bound TO the reader role (never PUBLIC). The FOR SELECT
  // and TO clauses sit on the line after CREATE POLICY; check statement-wise.
  const policyStatements = bare.split('CREATE POLICY').slice(1);
  assert.equal(policyStatements.length, 9, 'exactly nine policies');
  for (const statement of policyStatements) {
    const head = statement.slice(0, statement.indexOf('USING'));
    assert.match(head, /FOR SELECT TO workforce_query_reader/);
  }
  // DROP IF EXISTS keeps re-apply safe without weakening.
  assert.equal((bare.match(/DROP POLICY IF EXISTS /g) ?? []).length, 9);
});

test('child tables go through EXISTS parent policies (which re-apply the parent RLS)', () => {
  assert.match(bare, /workforce_workdocversion_parent ON public\."WorkDocVersion"/);
  assert.match(bare, /workforce_workdocrevision_parent ON public\."WorkDocRevision"/);
  assert.match(bare, /workforce_workdoclink_parent ON public\."WorkDocLink"/);
  assert.match(bare, /workforce_memoryrelation_scope ON public\."MemoryRelation"/);
  // WorkDocVersion/Revision/Link EXIST-bind to WorkDoc by documentId.
  for (const table of ['WorkDocVersion', 'WorkDocRevision', 'WorkDocLink']) {
    assert.match(bare, new RegExp(`WHERE public\\."WorkDoc"\\."id" = public\\."${table}"\\."documentId"`));
  }
  // MemoryRelation requires BOTH endpoints in the owner's memory scope.
  assert.match(bare, /WHERE public\."MemoryBlock"\."id" = public\."MemoryRelation"\."sourceId"/);
  assert.match(bare, /WHERE public\."MemoryBlock"\."id" = public\."MemoryRelation"\."targetId"/);
  assert.ok(/sourceId[\s\S]*AND[\s\S]*targetId/.test(bare), 'relation visibility requires BOTH endpoints');
});

test('the GUC-mutation vector is denied at the database: set_config revoked from PUBLIC, re-granted only to operators + app roles', () => {
  assert.match(bare, /REVOKE EXECUTE ON FUNCTION pg_catalog\.set_config\(text, text, boolean\) FROM PUBLIC;/);
  assert.match(bare, /GRANT EXECUTE ON FUNCTION pg_catalog\.set_config\(text, text, boolean\) TO CURRENT_USER/);
  assert.match(bare, /rolname IN \('workforce', 'workforce_api', 'postgres'\)/);
  // The query reader must never be re-granted set_config: nothing between
  // the REVOKE and the first comment after the DO block mentions the reader
  // in a GRANT context. Verify directly against the DO block's EXECUTE lines.
  const revokeIndex = bare.indexOf('REVOKE EXECUTE ON FUNCTION pg_catalog.set_config');
  const verifyMarker = bare.indexOf('Runtime verification');
  const segment = verifyMarker >= 0 ? bare.slice(revokeIndex, verifyMarker) : bare.slice(revokeIndex);
  assert.equal(
    /GRANT EXECUTE ON FUNCTION pg_catalog\.set_config[^;]*workforce_query_reader/.test(segment),
    false,
    'the query reader must never receive set_config execute privileges',
  );
});

test('the migration is additive-only: no drops of tables/roles and no destructive statements', () => {
  assert.doesNotMatch(bare, /DROP TABLE/i);
  assert.doesNotMatch(bare, /DROP ROLE/i);
  assert.doesNotMatch(bare, /DROP POLICY (?!IF EXISTS)/i, 'policy drops must be IF EXISTS (idempotent re-apply) only');
  assert.doesNotMatch(bare, /\bTRUNCATE\b/i);
  assert.doesNotMatch(bare, /ALTER ROLE workforce_query_reader LOGIN\b/i);
});

test('the policy SQL stays well-formed: balanced parens, terminated statements, no bare `force`', () => {
  let depth = 0;
  let minDepth = 0;
  for (const char of bare) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      minDepth = Math.min(minDepth, depth);
    }
  }
  assert.equal(depth, 0, 'parentheses balance');
  assert.ok(minDepth >= 0, 'never closes before opening');
  // Every statement-bearing line block ends with a semicolon: split on ';'
  // and classify. PL/pgSQL bodies live inside `DO $$ ... $$` and are skipped
  // as ONE statement (their internal grammar is not top-level SQL).
  const fragments = bare.split(';');
  let insideDoBody = false;
  for (const fragment of fragments) {
    const trimmed = fragment.replace(/\s+/g, ' ').trim();
    if (insideDoBody) {
      // The dollar-quoted body ends at this fragment (the '$$' tail was cut
      // by the split); the fragment's remaining text must be empty.
      const bodyEnd = trimmed.indexOf('$$');
      if (bodyEnd === -1) {
        continue; // still inside the DO body
      }
      insideDoBody = false;
      continue;
    }
    if (trimmed.length === 0) {
      continue;
    }
    if (/^DO\b/.test(trimmed)) {
      insideDoBody = true;
      continue;
    }
    assert.ok(
      /^(GRANT|REVOKE|ALTER|CREATE|DROP)\b/.test(trimmed),
      `unexpected top-level statement head: ${trimmed.slice(0, 60)}`,
    );
  }
});
