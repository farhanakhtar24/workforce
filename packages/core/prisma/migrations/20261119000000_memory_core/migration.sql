-- Phase 3 memory domain: path-addressed memory blocks, typed relations, and
-- pgvector embeddings (384 dimensions, all-MiniLM-L6-v2).
--
-- Handwritten migration paired with packages/core/prisma/schema.prisma.
-- Identifiers match Prisma defaults (quoted PascalCase tables, camelCase
-- columns) so future `prisma migrate diff` output stays consistent.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "MemoryKind" AS ENUM ('learning', 'correction', 'changelog', 'observation', 'decision', 'preference');

CREATE TYPE "EmbeddingStatus" AS ENUM ('pending', 'ready', 'failed');

CREATE TYPE "MemoryRelationType" AS ENUM ('supports', 'supersedes', 'contradicts');

CREATE TABLE "MemoryBlock" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "kind" "MemoryKind" NOT NULL,
    "content" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "embeddingStatus" "EmbeddingStatus" NOT NULL DEFAULT 'pending',
    "embedding" vector(384),
    "embeddingModel" TEXT,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "supersededById" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embeddedAt" TIMESTAMP(3),
    "lastAccessedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryBlock_pkey" PRIMARY KEY ("id"),

    -- Domain invariants mirrored from @workforce/core/memory validation.
    CONSTRAINT "MemoryBlock_confidence_range_check" CHECK ("confidence" >= 0 AND "confidence" <= 1),
    CONSTRAINT "MemoryBlock_content_length_check" CHECK (char_length("content") >= 1 AND char_length("content") <= 1000),
    CONSTRAINT "MemoryBlock_access_count_check" CHECK ("accessCount" >= 0),
    CONSTRAINT "MemoryBlock_scope_shape_check" CHECK ("scope" ~ '^[a-z0-9_-]+$' AND char_length("scope") >= 1 AND char_length("scope") <= 64),
    CONSTRAINT "MemoryBlock_path_shape_check" CHECK (
        "path" ~ '^[a-z0-9_/-]+$'
        AND char_length("path") <= 800
        AND position('//' in "path") = 0
        AND "path" NOT LIKE '/%'
        AND "path" NOT LIKE '%/'
    )
);

CREATE TABLE "MemoryRelation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sourceId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "type" "MemoryRelationType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryRelation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MemoryBlock" ADD CONSTRAINT "MemoryBlock_supersededById_key" UNIQUE ("supersededById");

CREATE INDEX "MemoryBlock_scope_path_createdAt_idx" ON "MemoryBlock"("scope" ASC, "path" ASC, "createdAt" DESC);

CREATE INDEX "MemoryBlock_embeddingStatus_idx" ON "MemoryBlock"("embeddingStatus");

CREATE INDEX "MemoryRelation_sourceId_idx" ON "MemoryRelation"("sourceId");

CREATE INDEX "MemoryRelation_targetId_idx" ON "MemoryRelation"("targetId");

-- HNSW cosine-distance index for the semantic search candidate fetch
-- (`ORDER BY embedding <=> $query_vector`). Requires pgvector 0.5.0+.
CREATE INDEX "MemoryBlock_embedding_hnsw_idx" ON "MemoryBlock" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);

ALTER TABLE "MemoryRelation" ADD CONSTRAINT "MemoryRelation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "MemoryBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryRelation" ADD CONSTRAINT "MemoryRelation_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MemoryBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryBlock" ADD CONSTRAINT "MemoryBlock_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "MemoryBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE;
