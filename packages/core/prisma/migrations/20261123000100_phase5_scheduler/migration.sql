-- Phase 5: agent task scheduler (AgentTask + AgentTaskExecution).
--
-- Handwritten forward migration paired with packages/core/prisma/schema.prisma.
-- Identifiers match Prisma defaults (quoted PascalCase tables, camelCase
-- columns) so future `prisma migrate diff` output stays consistent.
--
-- Bounds here mirror the Zod schemas in packages/core/src/scheduler/schemas.ts
-- (defense in depth). CHECK constraints and the partial unique index are
-- SQL-only by design (Prisma cannot express them); they must never be dropped
-- by a diff-generated migration (see prisma/README.md).
--
-- Notable SQL-only pieces (documented exceptions to the schema/migration
-- parity used elsewhere in this repo):
-- - `AgentTaskExecution_taskId_scheduledFor_scheduled_key` is a PARTIAL unique
--   index WHERE "trigger"='scheduled': one SCHEDULED execution per
--   (taskId, scheduledFor), while MANUAL and RETRY keep unlimited rows.
-- - CHECKs for name/prompt/scope/timezone/JSONB containers, attempt bounds,
--   the fixed maxAttempts, nonnegative duration, bounded error text, and
--   bounded chat/queue identifiers.
--
-- Forward-only; never edit already-applied migrations.

CREATE TYPE "AgentTaskRecurrenceType" AS ENUM ('once', 'daily', 'weekly', 'monthly', 'custom_cron');

CREATE TYPE "AgentTaskAgentSlug" AS ENUM ('general', 'orchestrator', 'analyst', 'researcher');

CREATE TYPE "AgentTaskMode" AS ENUM ('plan', 'action');

CREATE TYPE "AgentTaskTrigger" AS ENUM ('scheduled', 'manual', 'retry');

CREATE TYPE "AgentTaskExecutionStatus" AS ENUM ('pending', 'running', 'retrying', 'completed', 'failed', 'dead_letter', 'skipped');

CREATE TABLE "AgentTask" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "agentSlug" "AgentTaskAgentSlug" NOT NULL,
    "mode" "AgentTaskMode" NOT NULL,
    "prompt" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'default',
    "recurrenceType" "AgentTaskRecurrenceType" NOT NULL,
    "recurrenceConfig" JSONB NOT NULL DEFAULT '{}',
    "skipDates" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id"),

    -- Domain invariants mirrored from @workforce/core/scheduler validation.
    CONSTRAINT "AgentTask_name_length_check" CHECK (char_length("name") >= 1 AND char_length("name") <= 200),
    CONSTRAINT "AgentTask_prompt_length_check" CHECK (char_length("prompt") >= 1 AND char_length("prompt") <= 10000),
    CONSTRAINT "AgentTask_scope_shape_check" CHECK ("scope" ~ '^[a-z0-9_-]+$' AND char_length("scope") >= 1 AND char_length("scope") <= 64),
    -- The whole domain computes in UTC: the literal is fixed, DST-free.
    CONSTRAINT "AgentTask_timezone_utc_check" CHECK ("timezone" = 'UTC'),
    -- JSONB containers: skipDates is an array of at most 366 entries whose
    -- element shape (YYYY-MM-DD) is enforced by the domain schema.
    CONSTRAINT "AgentTask_skip_dates_check" CHECK (jsonb_typeof("skipDates") = 'array' AND jsonb_array_length("skipDates") <= 366),
    CONSTRAINT "AgentTask_recurrence_config_check" CHECK (jsonb_typeof("recurrenceConfig") = 'object')
);

CREATE TABLE "AgentTaskExecution" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "taskId" UUID NOT NULL,
    "retryOfExecutionId" UUID,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "trigger" "AgentTaskTrigger" NOT NULL,
    "status" "AgentTaskExecutionStatus" NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "durationMs" INTEGER,
    "tokenUsage" JSONB,
    "error" TEXT,
    "chatId" TEXT NOT NULL,
    "queueJobId" TEXT,
    "repeatJobKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentTaskExecution_pkey" PRIMARY KEY ("id"),

    -- Domain invariants mirrored from @workforce/core/scheduler validation.
    CONSTRAINT "AgentTaskExecution_max_attempts_check" CHECK ("maxAttempts" = 3),
    CONSTRAINT "AgentTaskExecution_attempt_check" CHECK ("attempt" >= 0 AND "attempt" <= "maxAttempts"),
    CONSTRAINT "AgentTaskExecution_duration_ms_check" CHECK ("durationMs" IS NULL OR "durationMs" >= 0),
    CONSTRAINT "AgentTaskExecution_error_length_check" CHECK ("error" IS NULL OR (char_length("error") >= 1 AND char_length("error") <= 1000)),
    -- chatId IS the execution id (one execution -> one isolated chat).
    CONSTRAINT "AgentTaskExecution_chat_id_shape_check" CHECK (char_length("chatId") >= 1 AND char_length("chatId") <= 128),
    CONSTRAINT "AgentTaskExecution_queue_job_id_shape_check" CHECK ("queueJobId" IS NULL OR (char_length("queueJobId") >= 1 AND char_length("queueJobId") <= 128)),
    CONSTRAINT "AgentTaskExecution_repeat_job_key_shape_check" CHECK ("repeatJobKey" IS NULL OR (char_length("repeatJobKey") >= 1 AND char_length("repeatJobKey") <= 128)),
    CONSTRAINT "AgentTaskExecution_token_usage_check" CHECK ("tokenUsage" IS NULL OR jsonb_typeof("tokenUsage") = 'object')
);

-- Uniqueness: one execution -> one isolated chat (chatId == id).
ALTER TABLE "AgentTaskExecution" ADD CONSTRAINT "AgentTaskExecution_chatId_key" UNIQUE ("chatId");

-- Uniqueness: one BullMQ job id / repeat key per execution (nullable, so
-- MANUAL/RETRY rows without queue identities keep unlimited NULLs).
ALTER TABLE "AgentTaskExecution" ADD CONSTRAINT "AgentTaskExecution_queueJobId_key" UNIQUE ("queueJobId");

ALTER TABLE "AgentTaskExecution" ADD CONSTRAINT "AgentTaskExecution_repeatJobKey_key" UNIQUE ("repeatJobKey");

-- SQL-ONLY partial unique index: at most ONE SCHEDULED execution per
-- (taskId, scheduledFor) instant. MANUAL and RETRY rows are excluded from the
-- index, so they keep unlimited rows per instant. Prisma cannot express
-- partial indexes; never let a diff-generated migration drop this.
CREATE UNIQUE INDEX "AgentTaskExecution_taskId_scheduledFor_scheduled_key" ON "AgentTaskExecution"("taskId" ASC, "scheduledFor" ASC) WHERE "trigger" = 'scheduled';

CREATE INDEX "AgentTaskExecution_taskId_scheduledFor_idx" ON "AgentTaskExecution"("taskId" ASC, "scheduledFor" ASC);

CREATE INDEX "AgentTaskExecution_status_idx" ON "AgentTaskExecution"("status");

CREATE INDEX "AgentTaskExecution_scheduledFor_idx" ON "AgentTaskExecution"("scheduledFor");

CREATE INDEX "AgentTask_isActive_nextRunAt_idx" ON "AgentTask"("isActive" ASC, "nextRunAt" DESC);

CREATE INDEX "AgentTask_createdAt_idx" ON "AgentTask"("createdAt" DESC);

CREATE INDEX "AgentTask_agentSlug_idx" ON "AgentTask"("agentSlug");

ALTER TABLE "AgentTaskExecution" ADD CONSTRAINT "AgentTaskExecution_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Self-FK: a RETRY execution points at the DEAD_LETTER execution it retries.
-- SET NULL (not cascade): deleting a source execution never collapses retry
-- chains; NULL retryOfExecutionId keeps the row intact.
ALTER TABLE "AgentTaskExecution" ADD CONSTRAINT "AgentTaskExecution_retryOfExecutionId_fkey" FOREIGN KEY ("retryOfExecutionId") REFERENCES "AgentTaskExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
