-- Pre-Phase 6: Better Auth (Google + GitHub OAuth) + per-user ownership.
--
-- Handwritten forward migration paired with packages/core/prisma/schema.prisma.
-- Identifiers match Prisma defaults (quoted PascalCase tables, camelCase
-- columns) so future `prisma migrate diff` output stays consistent.
--
-- The four Better Auth tables below mirror the official Better Auth 1.7
-- Prisma schema generation (`npx auth@<version> generate --adapter prisma
-- --dialect postgresql`): ids are plain TEXT minted by Better Auth itself
-- (NOT @db.Uuid) and only the columns of the core User/Session/Account/
-- Verification schemas exist. No CHECK constraints are added here on
-- purpose: Better Auth owns these rows' shapes end to end, and extra bounds
-- would silently reject adapter writes (see prisma/README.md drift policy).
--
-- `ownerId` columns on WorkDoc/Delegation/AgentTask/AgentTaskExecution are
-- NULLABLE BY DESIGN: legacy rows created before the per-user model keep no
-- owner and become inaccessible through user-scoped queries; nothing
-- back-fills or auto-assigns ownership, so private data never leaks.
--
-- Forward-only; never edit already-applied migrations.

-- ---------------------------------------------------------------------------
-- Better Auth core tables (official generated shape, Prisma-default names)
-- ---------------------------------------------------------------------------

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

CREATE INDEX "Session_userId_idx" ON "Session"("userId");

CREATE INDEX "Account_userId_idx" ON "Account"("userId");

CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- Better Auth Session/Account rows die with their user (core schema deletes
-- sessions and accounts whenever the user row is removed).
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- UserSettings: explicit per-user personal-memory opt-in (default opt-out)
-- ---------------------------------------------------------------------------

CREATE TABLE "UserSettings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL,
    "personalMemoryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- One settings row per user; deleting the user deletes their settings (and
-- with it the personal-memory opt-in state — private data dies with owner).
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Ownership columns on existing tables (nullable ON PURPOSE — see header)
-- ---------------------------------------------------------------------------

ALTER TABLE "WorkDoc" ADD COLUMN "ownerId" TEXT;

ALTER TABLE "Delegation" ADD COLUMN "ownerId" TEXT;

ALTER TABLE "AgentTask" ADD COLUMN "ownerId" TEXT;

ALTER TABLE "AgentTaskExecution" ADD COLUMN "ownerId" TEXT;

-- Deleting the owning user detaches rather than destroys shared domain rows.
ALTER TABLE "WorkDoc" ADD CONSTRAINT "WorkDoc_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Delegation" ADD CONSTRAINT "Delegation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentTaskExecution" ADD CONSTRAINT "AgentTaskExecution_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "WorkDoc_ownerId_idx" ON "WorkDoc"("ownerId");

CREATE INDEX "Delegation_ownerId_idx" ON "Delegation"("ownerId");

CREATE INDEX "AgentTask_ownerId_idx" ON "AgentTask"("ownerId");

CREATE INDEX "AgentTaskExecution_ownerId_idx" ON "AgentTaskExecution"("ownerId");
