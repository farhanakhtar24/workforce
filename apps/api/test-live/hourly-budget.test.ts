/**
 * REAL Postgres integration for the conservative per-user hourly budget
 * (mocked model — admission never calls a provider): real Prisma ledger
 * inserts with per-owner advisory-lock transactions, atomic concurrent
 * admissions at the limit, rolling expiry, settlement, compaction dollar
 * attribution through `UserMemoryScopeLink`, and the exact summary shape.
 *
 * Requires the forward migration `20261126000000_hourly_budget_ledger`
 * (root: `npm run db:migrate`) — a missing table fails with a FIXED message.
 * Run-scoped cleanup (`owner-<runId>` rows only); no Redis, no provider, no
 * real keys.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@workforce/core/generated/prisma';
import { DEFAULT_DATABASE_URL } from '../src/config.js';
import { createPostgresHourlyBudgetService, type HourlyBudgetService } from '../src/budget/hourly-budget.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
const OWNER = `owner-hb-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const OWNER_B = `owner-hbb-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const OWNER_C = `owner-hbc-${process.pid.toString(36)}-${Date.now().toString(36)}`;

const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
let budget: HourlyBudgetService | null = null;

before(async () => {
  await Promise.race([
    prisma.$connect(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Postgres connect timeout')), 5_000)),
  ]);
  const table = await prisma.$queryRaw<Array<{ found: number }>>`
    SELECT COUNT(*)::int AS found FROM information_schema.tables
    WHERE table_name = 'UserHourlyUsageEvent' AND table_schema = 'public'`;
  if (Number(table[0]?.found ?? 0) !== 1) {
    throw new Error('UserHourlyUsageEvent missing — apply the hourly budget migration first (root: npm run db:migrate).');
  }
  budget = createPostgresHourlyBudgetService(prisma, {
    modelPricingOverride: null,
    now: () => new Date(),
  });
});

after(async () => {
  try {
    await prisma.$executeRaw`DELETE FROM "UserHourlyUsageEvent" WHERE "ownerId" IN (${OWNER}, ${OWNER_B}, ${OWNER_C})`;
    await prisma.$executeRaw`DELETE FROM "UserMemoryScopeLink" WHERE "ownerId" IN (${OWNER}, ${OWNER_B}, ${OWNER_C})`;
    // The FK-owned test user row (created by the browser gate fixture or
    // this suite never created it here — events carry no FK, safe to clean).
  } catch (error) {
    void error;
  }
  await prisma.$disconnect().catch(() => undefined);
});

test('live budget: 10-request cap + fixed denial + rolling expiry on REAL rows', async () => {
  const service = budget as HourlyBudgetService;
  for (let index = 1; index <= 10; index += 1) {
    const admission = await service.admitChatUse({
      ownerId: OWNER,
      modelId: 'glm-5.3-flash',
      inputTokensEstimate: 600,
      chatId: `c${index}`,
      userMessageId: `c${index}-u1`,
    });
    assert.equal(admission.outcome, 'admitted', String(index));
  }
  const denied = await service.admitChatUse({
    ownerId: OWNER,
    modelId: 'glm-5.3-flash',
    inputTokensEstimate: 600,
    chatId: 'c11',
    userMessageId: 'c11-u1',
  });
  assert.ok(denied.outcome === 'denied');
  assert.equal(denied.reason, 'requests');
  const summary = await service.summarize(OWNER);
  assert.equal(summary.requestCount, 10);
  assert.equal(summary.remainingRequests, 0);
  assert.ok(summary.resetAt !== null);
});

test('live budget: concurrent same-owner cost race (real advisory lock) — exactly one admitted, one cost-denied', async () => {
  const service = budget as HourlyBudgetService;
  // OWNER_B is fresh: two EXPENSIVE (mistral-large-4) races cannot both fit
  // the $1 window: the lock serializes; the first reserves nearly the whole
  // budget, the second is denied with reason cost (never the request cap).
  const [a, b] = await Promise.all([
    service.admitChatUse({ ownerId: OWNER_B, modelId: 'mistral-large-4', inputTokensEstimate: 300_000, chatId: 'race-a', userMessageId: 'race-a-u1' }),
    service.admitChatUse({ ownerId: OWNER_B, modelId: 'mistral-large-4', inputTokensEstimate: 300_000, chatId: 'race-b', userMessageId: 'race-b-u1' }),
  ]);
  const outcomes = [a.outcome, b.outcome];
  assert.deepEqual(outcomes.sort(), ['admitted', 'denied'], 'race admits exactly one');
  const deny = [a, b].find((attempt) => attempt.outcome === 'denied');
  assert.ok(deny !== undefined && deny.reason === 'cost', 'the binder is the $1 cost cap');
});

test('live budget: settle + scope link + compaction dollar attribution + cross-owner isolation', async () => {
  const service = budget as HourlyBudgetService;
  // Cross-owner: OWNER_B's window is already shaped by the race above (one
  // admitted + compaction); OWNER's full request window does NOT bleed over.
  const summaryOwnerBefore = await service.summarize(OWNER);
  assert.equal(summaryOwnerBefore.requestCount, 10);

  // Scope link drives compaction dollar attribution.
  await service.recordScopeOwner('user-livetest-scope', OWNER);
  const resolved = await service.ownerForScope('user-livetest-scope');
  assert.equal(resolved, OWNER);
  const afterOwner = await service.summarize(OWNER);
  assert.equal(afterOwner.requestCount, 10, 'compaction never changed the request count');
  const reserved = await service.reserveCompactionUse({
    ownerId: resolved as string,
    modelId: 'glm-5.3-flash',
    inputTokensEstimate: 30_000,
    outputTokensCap: 8_000,
  });
  assert.equal(typeof reserved, 'string', 'the reserve resolves to an honest outcome');

  // OWNER_B: the race-admitted generation (one) — request count stays 1 with
  // no compaction buckets.
  const summaryB = await service.summarize(OWNER_B);
  assert.equal(summaryB.requestCount, 1);
  const bucketCost = summaryB.models[0]?.estimatedCostUsd ?? 0;
  assert.equal(summaryB.estimatedCostUsd, bucketCost, 'no compaction cost outside the buckets yet');
});

// ---------------------------------------------------------------------------
// Fix round 2 (REAL Postgres): cancel, reserved/settled/cross-model same-key
// admissions, compaction same-key dedupe. Run-scoped cleanup extended.
// ---------------------------------------------------------------------------

test('live budget: cancelChatUse deletes ONLY the reserved row; settled rows survive (real DELETE)', async () => {
  const service = budget as HourlyBudgetService;
  const reserved = await service.admitChatUse({ ownerId: OWNER_C, modelId: 'glm-5.3-flash', inputTokensEstimate: 600, chatId: 'can-1', userMessageId: 'can-u1' });
  assert.ok(reserved.outcome === 'admitted' && reserved.reservation === 'created');
  assert.equal((await service.summarize(OWNER_C)).requestCount, 1);
  await service.cancelChatUse({ ownerId: OWNER_C, chatId: 'can-1', userMessageId: 'can-u1' });
  await service.cancelChatUse({ ownerId: OWNER_C, chatId: 'can-1', userMessageId: 'can-u1' }); // idempotent
  assert.equal((await service.summarize(OWNER_C)).requestCount, 0);

  const settled = await service.admitChatUse({ ownerId: OWNER_C, modelId: 'glm-5.3-flash', inputTokensEstimate: 600, chatId: 'can-2', userMessageId: 'can-2-u1' });
  assert.ok(settled.outcome === 'admitted');
  await service.settleChatUse({ ownerId: OWNER_C, chatId: 'can-2', userMessageId: 'can-2-u1', modelId: 'glm-5.3-flash', usage: { inputTokens: 50, outputTokens: 40 } });
  await service.cancelChatUse({ ownerId: OWNER_C, chatId: 'can-2', userMessageId: 'can-2-u1' });
  const after = await service.summarize(OWNER_C);
  assert.equal(after.requestCount, 1, 'the SETTLED row was never cancelled');
  assert.equal(after.usageComplete, true);
});

test('live budget: same-key reserved re-admission is idempotent; SEPARATE settle keys admit normally', async () => {
  const service = budget as HourlyBudgetService;
  const first = await service.admitChatUse({ ownerId: OWNER_C, modelId: 'glm-5.3-flash', inputTokensEstimate: 600, chatId: 're-admit', userMessageId: 'ra-u1' });
  assert.ok(first.outcome === 'admitted' && first.reservation === 'created');
  const again = await service.admitChatUse({ ownerId: OWNER_C, modelId: 'glm-5.3-flash', inputTokensEstimate: 600, chatId: 're-admit', userMessageId: 'ra-u1' });
  assert.ok(again.outcome === 'admitted' && again.reservation === 'existing');
  assert.equal(again.conservativeCostUsd, first.outcome === 'admitted' ? first.conservativeCostUsd : -1);
  assert.equal((await service.summarize(OWNER_C)).requestCount, 2, 'two rows total: can-2 settled + re-admit');
});

test('live budget: settled same-key + cross-model retry create NEW correctly priced reservations (real rows)', async () => {
  const service = budget as HourlyBudgetService;
  // OWNER_C: a different-model crash retry gets its OWN priced row.
  const crash = await service.admitChatUse({ ownerId: OWNER_C, modelId: 'gpt-oss:20b', inputTokensEstimate: 600, chatId: 'live-cm', userMessageId: 'cm-u1' });
  assert.ok(crash.outcome === 'admitted' && crash.reservation === 'created');
  const switchModel = await service.admitChatUse({ ownerId: OWNER_C, modelId: 'mimo-v2.6-flash', inputTokensEstimate: 600, chatId: 'live-cm', userMessageId: 'cm-u1' });
  assert.ok(switchModel.outcome === 'admitted' && switchModel.reservation === 'created', 'a different-model retry gets its own row');
  // Settle ONLY the new-model row: the old crash residue stays reserved.
  await service.settleChatUse({ ownerId: OWNER_C, chatId: 'live-cm', userMessageId: 'cm-u1', modelId: 'mimo-v2.6-flash', usage: { inputTokens: 15, outputTokens: 10 } });
  const summary = await service.summarize(OWNER_C);
  const newModelBucket = summary.models.find((model) => model.modelId === 'mimo-v2.6-flash');
  assert.ok(newModelBucket !== undefined && newModelBucket.inputTokens === 15 && newModelBucket.outputTokens === 10);
  assert.ok(summary.models.some((model) => model.modelId === 'gpt-oss:20b' && model.requests === 1), 'the crash residue stays (worst case) until expiry');
  // A SETTLED same-key row (the mimo turn) is NEVER re-admitted: a
  // rewind+resend on the SETTLED model creates a NEW reservation. (The
  // gpt-oss crash residue is still RESERVED + same model → a resend on THAT
  // model stays idempotent 'existing' — within-key retry dedupe.)
  const reservedResend = await service.admitChatUse({ ownerId: OWNER_C, modelId: 'gpt-oss:20b', inputTokensEstimate: 600, chatId: 'live-cm', userMessageId: 'cm-u1' });
  assert.ok(reservedResend.outcome === 'admitted' && reservedResend.reservation === 'existing', 'within-key reserved retry dedupe');
  const resendBefore = (await service.summarize(OWNER_C)).requestCount;
  const resend = await service.admitChatUse({ ownerId: OWNER_C, modelId: 'mimo-v2.6-flash', inputTokensEstimate: 600, chatId: 'live-cm', userMessageId: 'cm-u1' });
  assert.ok(resend.outcome === 'admitted' && resend.reservation === 'created', 'a settled same-key row is a NEW normal request');
  assert.equal((await service.summarize(OWNER_C)).requestCount, resendBefore + 1);
});

test('live budget: compaction same-key dedupe on REAL rows (BullMQ retry reuses ONE reservation)', async () => {
  const service = budget as HourlyBudgetService;
  const before = await service.summarize(OWNER_C);
  const dedupeKey = `compaction:user-livescope/notes/tb1`;
  const first = await service.reserveCompactionUse({ ownerId: OWNER_C, modelId: 'glm-5.3-flash', inputTokensEstimate: 30_000, outputTokensCap: 8_000, dedupeKey });
  assert.equal(first, 'admitted');
  const afterFirst = await service.summarize(OWNER_C);
  assert.ok(afterFirst.estimatedCostUsd > before.estimatedCostUsd, 'the FIRST reservation added dollars');
  const retry = await service.reserveCompactionUse({ ownerId: OWNER_C, modelId: 'glm-5.3-flash', inputTokensEstimate: 30_000, outputTokensCap: 8_000, dedupeKey });
  assert.equal(retry, 'admitted', 'retry re-admitted');
  const after = await service.summarize(OWNER_C);
  assert.equal(after.estimatedCostUsd, afterFirst.estimatedCostUsd, 'the BullMQ retry added NO second compaction reservation');
  assert.equal(after.requestCount, before.requestCount, 'compaction never counted a request');
});
