/**
 * Offline forward-only invariants for the pre-Phase 6 auth schema work:
 * the Better Auth models in `prisma/schema.prisma` keep the EXACT official
 * generated shape (TEXT ids, no UUIDs — asserted, not assumed), the
 * ownership `ownerId` columns stay deliberately nullable on the four legacy
 * models with proper indexes, UserSettings defaults to opt-OUT, and the new
 * handwritten migration folder is strictly forward-only. File reads only —
 * no DB, no server, no mutation.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// packageRoot/prisma — same relative depth from src/ (tsx) and dist/ (built).
const PRISMA_DIR = fileURLToPath(new URL('../../prisma', import.meta.url));
const SCHEMA_PATH = `${PRISMA_DIR}/schema.prisma`;
const MIGRATIONS_DIR = `${PRISMA_DIR}/migrations`;
const AUTH_MIGRATION_DIR = '20261125000000_pre_phase6_auth';

const schema = readFileSync(SCHEMA_PATH, 'utf8');

/** Extracts one `model <Name> { ... }` block (top-level braces only). */
function modelBlock(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  assert.ok(start >= 0, `schema.prisma must declare model ${name}`);
  const next = schema.indexOf('\n}', start);
  assert.ok(next >= 0, `model ${name} block must be closed`);
  return schema.slice(start, next + 2);
}

test('schema declares the four Better Auth models with the generated TEXT-id shape', () => {
  for (const name of ['User', 'Session', 'Account', 'Verification']) {
    const block = modelBlock(name);
    // Official Better Auth generation: `id String @id` — never @db.Uuid, no
    // dbgenerated id default (Better Auth mints ids itself).
    assert.match(block, /id\s+String\s+@id/);
    assert.doesNotMatch(block, /@db\.Uuid/);
    assert.doesNotMatch(block, /dbgenerated\("gen_random_uuid\(\)"\)/);
  }
  // Faithful core column surface of the generated models.
  modelBlock('User');
  assert.match(modelBlock('User'), /email\s+String/);
  assert.match(modelBlock('User'), /emailVerified\s+Boolean\s+@default\(false\)/);
  assert.match(modelBlock('Session'), /token\s+String/);
  assert.match(modelBlock('Session'), /expiresAt\s+DateTime/);
  assert.match(modelBlock('Account'), /providerId\s+String/);
  assert.match(modelBlock('Account'), /accountId\s+String/);
  assert.match(modelBlock('Verification'), /identifier\s+String/);
  assert.match(modelBlock('Verification'), /value\s+String/);
  // Repository convention: the CLI's lowercase @@map renames stay omitted.
  for (const name of ['User', 'Session', 'Account', 'Verification', 'UserSettings']) {
    assert.doesNotMatch(modelBlock(name), /@@map\(/, `${name} must keep Prisma-default identifiers`);
  }
});

test('Better Auth relations are declared for adapter joins and cascade deletion', () => {
  const user = modelBlock('User');
  assert.match(user, /settings\s+UserSettings\?/);
  assert.match(user, /workDocs\s+WorkDoc\[\]/);
  assert.match(user, /delegations\s+Delegation\[\]/);
  assert.match(user, /agentTasks\s+AgentTask\[\]/);
  assert.match(user, /agentTaskExecutions\s+AgentTaskExecution\[\]/);
  const session = modelBlock('Session');
  assert.match(session, /onDelete: Cascade/);
  const account = modelBlock('Account');
  assert.match(account, /onDelete: Cascade/);
});

test('UserSettings: single row per user, personal memory is explicit opt-in', () => {
  const block = modelBlock('UserSettings');
  assert.match(block, /userId\s+String\s+@unique/);
  assert.match(block, /personalMemoryEnabled\s+Boolean\s+@default\(false\)/);
  assert.match(block, /onDelete: Cascade/);
});

test('ownerId is deliberately NULLABLE with owner relations and indexes on the four legacy models', () => {
  for (const name of ['WorkDoc', 'Delegation', 'AgentTask', 'AgentTaskExecution']) {
    const block = modelBlock(name);
    assert.match(block, /ownerId\s+String\?/, `${name}.ownerId must stay nullable`);
    assert.match(block, /references: \[id\], onDelete: SetNull/);
    assert.match(block, /@@index\(\[ownerId\]\)/);
  }
});

test('migration folders are strictly ascending (forward-only ordering) and the auth folder is present', () => {
  const folders = readdirSync(MIGRATIONS_DIR)
    .filter((entry) => statSync(`${MIGRATIONS_DIR}/${entry}`).isDirectory())
    .sort();
  const byTime = [...folders].sort((a, b) => Number(a.slice(0, '20261125000000'.length)) - Number(b.slice(0, '20261125000000'.length)));
  assert.deepEqual(byTime, folders, 'migration timestamps must be unique and ascending');
  assert.ok(folders.includes(AUTH_MIGRATION_DIR));
});

test('auth migration is additive only: creates the Better Auth tables, UserSettings, and ownership columns', () => {
  const sql = readFileSync(`${MIGRATIONS_DIR}/${AUTH_MIGRATION_DIR}/migration.sql`, 'utf8');
  for (const table of ['"User"', '"Session"', '"Account"', '"Verification"', '"UserSettings"']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(`));
  }
  assert.doesNotMatch(sql, /\bDROP\b/, 'forward-only: the migration must never drop anything');
  assert.match(sql, /"personalMemoryEnabled" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"\("userId"\)/);
  // Ownership columns: nullable TEXT with SET NULL FKs and indexes.
  for (const table of ['WorkDoc', 'Delegation', 'AgentTask', 'AgentTaskExecution']) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ADD COLUMN "ownerId" TEXT;`));
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_ownerId_fkey" FOREIGN KEY \\("ownerId"\\) REFERENCES "User"\\("id"\\) ON DELETE SET NULL ON UPDATE CASCADE;`));
    assert.match(sql, new RegExp(`CREATE INDEX "${table}_ownerId_idx" ON "${table}"\\("ownerId"\\);`));
  }
  // Better Auth FKs cascade with the user (core schema semantics).
  for (const table of ['Session', 'Account']) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_userId_fkey" FOREIGN KEY \\("userId"\\) REFERENCES "User"\\("id"\\) ON DELETE CASCADE ON UPDATE CASCADE;`));
  }
  // Better Auth ids are TEXT: the generated shape, asserted (NOT UUID).
  assert.match(sql, new RegExp(`CREATE TABLE "User" \\(\n    "id" TEXT NOT NULL,`));
});

test('UserSettings ids stay repo-UUID style (table is NOT Better Auth-owned)', () => {
  const sql = readFileSync(`${MIGRATIONS_DIR}/${AUTH_MIGRATION_DIR}/migration.sql`, 'utf8');
  assert.match(sql, /CREATE TABLE "UserSettings" \(\n    "id" UUID NOT NULL DEFAULT gen_random_uuid\(\)/);
});
