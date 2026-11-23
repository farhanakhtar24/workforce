-- Restores the relation-tuple uniqueness declared by the Prisma schema
-- (@@unique([sourceId, targetId, type]) => constraint
-- "MemoryRelation_sourceId_targetId_type_key"), which is absent from the
-- bootstrap migration as applied on some environments and therefore from the
-- live database. Relation rows must stay unique per (source, target, type);
-- this guards against duplicate supersedes edges from buggy rewrites.
--
-- Idempotent on purpose: ADD CONSTRAINT has no IF EXISTS, so the guard makes
-- the migration safe on databases whose bootstrap already created it.
--
-- Forward-only; never edit already-applied migrations (see
-- packages/core/prisma/README.md). Applied with `prisma migrate deploy`.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'MemoryRelation_sourceId_targetId_type_key'
          AND conrelid = 'public."MemoryRelation"'::regclass
    ) THEN
        ALTER TABLE "MemoryRelation"
            ADD CONSTRAINT "MemoryRelation_sourceId_targetId_type_key"
            UNIQUE ("sourceId", "targetId", "type");
    END IF;
END
$$;
