-- Phase 4: work documents (immutable version history + revisions + typed
-- links) and delegation records (parent->child hand-offs).
--
-- Handwritten forward migration paired with packages/core/prisma/schema.prisma.
-- Identifiers match Prisma defaults (quoted PascalCase tables, camelCase
-- columns) so future `prisma migrate diff` output stays consistent.
--
-- Bounds here mirror the Zod schemas in packages/core/src/work-docs/schemas.ts
-- and packages/core/src/delegation/schemas.ts (defense in depth). CHECK
-- constraints are SQL-only by design (Prisma cannot express them); they must
-- never be dropped by a diff-generated migration (see prisma/README.md).
--
-- Forward-only; never edit already-applied migrations.

CREATE TYPE "WorkDocType" AS ENUM ('report', 'plan', 'analysis');

CREATE TYPE "WorkDocStatus" AS ENUM ('draft', 'active', 'archived');

CREATE TYPE "WorkDocRevisionSource" AS ENUM ('agent', 'user');

CREATE TYPE "WorkDocLinkTargetType" AS ENUM ('memory_block', 'chat', 'delegation');

CREATE TYPE "DelegationTargetAgent" AS ENUM ('analyst', 'researcher');

CREATE TYPE "DelegationMode" AS ENUM ('sync', 'async');

CREATE TYPE "DelegationStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'timeout');

CREATE TABLE "WorkDoc" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "type" "WorkDocType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "WorkDocStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkDoc_pkey" PRIMARY KEY ("id"),

    -- Domain invariants mirrored from @workforce/core/work-docs validation.
    CONSTRAINT "WorkDoc_version_check" CHECK ("version" >= 1),
    CONSTRAINT "WorkDoc_title_length_check" CHECK (char_length("title") >= 1 AND char_length("title") <= 200),
    CONSTRAINT "WorkDoc_content_length_check" CHECK (char_length("content") >= 1 AND char_length("content") <= 100000),
    CONSTRAINT "WorkDoc_scope_shape_check" CHECK ("scope" ~ '^[a-z0-9_-]+$' AND char_length("scope") >= 1 AND char_length("scope") <= 64),
    CONSTRAINT "WorkDoc_chat_id_shape_check" CHECK (char_length("chatId") >= 1 AND char_length("chatId") <= 128)
);

CREATE TABLE "WorkDocVersion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "documentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "WorkDocStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkDocVersion_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "WorkDocVersion_version_check" CHECK ("version" >= 1),
    CONSTRAINT "WorkDocVersion_title_length_check" CHECK (char_length("title") >= 1 AND char_length("title") <= 200),
    CONSTRAINT "WorkDocVersion_content_length_check" CHECK (char_length("content") >= 1 AND char_length("content") <= 100000)
);

CREATE TABLE "WorkDocRevision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "documentId" UUID NOT NULL,
    "source" "WorkDocRevisionSource" NOT NULL,
    "actorId" TEXT,
    "fromVersion" INTEGER,
    "toVersion" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkDocRevision_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "WorkDocRevision_actor_id_shape_check" CHECK ("actorId" IS NULL OR (char_length("actorId") >= 1 AND char_length("actorId") <= 128)),
    CONSTRAINT "WorkDocRevision_from_version_check" CHECK ("fromVersion" IS NULL OR "fromVersion" >= 1),
    CONSTRAINT "WorkDocRevision_to_version_check" CHECK ("toVersion" >= 1),
    CONSTRAINT "WorkDocRevision_summary_length_check" CHECK (char_length("summary") >= 1 AND char_length("summary") <= 500)
);

CREATE TABLE "WorkDocLink" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "documentId" UUID NOT NULL,
    "targetType" "WorkDocLinkTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkDocLink_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "WorkDocLink_target_id_shape_check" CHECK (char_length("targetId") >= 1 AND char_length("targetId") <= 128),
    CONSTRAINT "WorkDocLink_label_shape_check" CHECK ("label" IS NULL OR (char_length("label") >= 1 AND char_length("label") <= 128))
);

CREATE TABLE "Delegation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" TEXT NOT NULL,
    "parentChatId" TEXT NOT NULL,
    "childChatId" TEXT NOT NULL,
    "parentMessageId" TEXT NOT NULL,
    "targetAgent" "DelegationTargetAgent" NOT NULL,
    "mode" "DelegationMode" NOT NULL,
    "status" "DelegationStatus" NOT NULL DEFAULT 'pending',
    "task" TEXT NOT NULL,
    "result" TEXT,
    "error" TEXT,
    "depth" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Delegation_pkey" PRIMARY KEY ("id"),

    -- Domain invariants mirrored from @workforce/core/delegation validation.
    CONSTRAINT "Delegation_depth_check" CHECK ("depth" >= 1 AND "depth" <= 2),
    CONSTRAINT "Delegation_task_length_check" CHECK (char_length("task") >= 1 AND char_length("task") <= 10000),
    CONSTRAINT "Delegation_result_length_check" CHECK ("result" IS NULL OR (char_length("result") >= 1 AND char_length("result") <= 100000)),
    CONSTRAINT "Delegation_error_length_check" CHECK ("error" IS NULL OR (char_length("error") >= 1 AND char_length("error") <= 1000)),
    CONSTRAINT "Delegation_scope_shape_check" CHECK ("scope" ~ '^[a-z0-9_-]+$' AND char_length("scope") >= 1 AND char_length("scope") <= 64),
    CONSTRAINT "Delegation_chat_id_shape_check" CHECK (char_length("parentChatId") >= 1 AND char_length("parentChatId") <= 128 AND char_length("childChatId") >= 1 AND char_length("childChatId") <= 128),
    CONSTRAINT "Delegation_message_id_shape_check" CHECK (char_length("parentMessageId") >= 1 AND char_length("parentMessageId") <= 128)
);

-- Uniqueness: a child chat belongs to exactly one delegation record.
ALTER TABLE "Delegation" ADD CONSTRAINT "Delegation_childChatId_key" UNIQUE ("childChatId");

-- A version number names exactly one snapshot per document; every write
-- appends the next version, so this doubles as the history lookup index.
ALTER TABLE "WorkDocVersion" ADD CONSTRAINT "WorkDocVersion_documentId_version_key" UNIQUE ("documentId", "version");

-- Link idempotency per (document, targetType, target) tuple.
ALTER TABLE "WorkDocLink" ADD CONSTRAINT "WorkDocLink_documentId_targetType_targetId_key" UNIQUE ("documentId", "targetType", "targetId");

CREATE INDEX "WorkDoc_scope_chatId_updatedAt_idx" ON "WorkDoc"("scope" ASC, "chatId" ASC, "updatedAt" DESC);

CREATE INDEX "WorkDoc_type_idx" ON "WorkDoc"("type");

CREATE INDEX "WorkDoc_status_idx" ON "WorkDoc"("status");

CREATE INDEX "WorkDocRevision_documentId_toVersion_idx" ON "WorkDocRevision"("documentId" ASC, "toVersion" ASC);

CREATE INDEX "WorkDocLink_documentId_idx" ON "WorkDocLink"("documentId");

CREATE INDEX "Delegation_parentChatId_createdAt_idx" ON "Delegation"("parentChatId" ASC, "createdAt" DESC);

CREATE INDEX "Delegation_status_idx" ON "Delegation"("status");

ALTER TABLE "WorkDocVersion" ADD CONSTRAINT "WorkDocVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "WorkDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkDocRevision" ADD CONSTRAINT "WorkDocRevision_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "WorkDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkDocLink" ADD CONSTRAINT "WorkDocLink_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "WorkDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;
