-- 20261126000000_hourly_budget_ledger
--
-- Pre-Phase 6 CONSERVATIVE per-user hourly budget (durable ledger, additive):
-- one row per admitted top-level chat generation (`kind='request'`) or memory
-- compaction run (`kind='compaction'`). Rows are the accounting truth for the
-- rolling 60-minute window — independent of any transcript. Admission
-- reserves conservative estimates BEFORE provider work; settlement stores the
-- actual usage when the provider reported valid numbers; an unsettled row
-- keeps its conservative cost until the row rolls out of the window. No
-- negative remaining values; no account-wide/shared-key data.
--
-- Handwritten forward migration paired with packages/core/prisma/schema.prisma
-- (Prisma-default quoted PascalCase naming, consistent with every applied
-- migration). Forward-only; never edit already-applied migrations.
--
-- `UserMemoryScopeLink` attributes user-scoped memory compaction runs (the
-- worker only receives scope+path) to their owner; rows are created by the
-- memory routes on user-scoped writes. Legacy anonymous scopes are absent by
-- design and their compaction cost stays out of per-user budgets.

CREATE TABLE "UserHourlyUsageEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "model" TEXT NOT NULL,
    "chatId" TEXT,
    "userMessageId" TEXT,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL,
    "actualInputTokens" INTEGER,
    "actualOutputTokens" INTEGER,
    "actualCostUsd" DOUBLE PRECISION,
    "usageSettledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserHourlyUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserHourlyUsageEvent_ownerId_createdAt_idx"
    ON "UserHourlyUsageEvent"("ownerId", "createdAt" DESC);

CREATE INDEX "UserHourlyUsageEvent_ownerId_chatId_userMessageId_idx"
    ON "UserHourlyUsageEvent"("ownerId", "chatId", "userMessageId");

CREATE TABLE "UserMemoryScopeLink" (
    "scope" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMemoryScopeLink_pkey" PRIMARY KEY ("scope")
);
