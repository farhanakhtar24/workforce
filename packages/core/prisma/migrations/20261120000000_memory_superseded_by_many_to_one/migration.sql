-- Superseded-by links are many-to-one by design: ONE compaction summary (or
-- correction) block supersedes up to 30 sources, and every superseded source
-- points back at that same summary id via MemoryBlock.supersededById. The
-- 20261119000000_memory_core migration created a UNIQUE constraint
-- ("MemoryBlock_supersededById_key") on that column, so the first compaction
-- batch failed live with 23505 (duplicate key) the moment it marked the 30
-- source rows. This forward migration removes the unique constraint and
-- replaces it with a plain non-unique index for superseded/active lookups.
--
-- One-successor integrity PER SOURCE row remains in the adapter: every
-- supersede write runs in one transaction with SELECT ... FOR UPDATE on the
-- target rows plus a guarded UPDATE ... WHERE "supersededById" IS NULL whose
-- affected-row count must match the target count, so a source can never gain
-- two successors even without DB-level uniqueness.
--
-- Forward-only: do not edit the already-applied 20261119000000_memory_core
-- migration. Applied with `prisma migrate deploy` (see
-- packages/core/prisma/README.md for the destructive-command policy).

ALTER TABLE "MemoryBlock" DROP CONSTRAINT IF EXISTS "MemoryBlock_supersededById_key";

CREATE INDEX IF NOT EXISTS "MemoryBlock_supersededById_idx" ON "MemoryBlock"("supersededById");
