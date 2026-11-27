/**
 * CONSERVATIVE per-user hourly budget (pre-Phase 6, additive):
 *
 * - Rolling 60 minutes across ALL chats of ONE authenticated user: at most
 *   10 ACCEPTED top-level chat generations (`kind='request'`) OR a
 *   conservative estimated $1.00 — whichever is hit first.
 * - Delegated and scheduled child chats go through the SAME generation
 *   handler, so they consume the SAME owner budget. Tool steps inside one
 *   generation are part of that turn's event (never extra requests).
 * - ADMISSION reserves request + cost BEFORE provider work, atomically per
 *   owner (Postgres: transaction + `pg_advisory_xact_lock`; the in-memory
 *   implementation serializes per owner with a promise chain — the same
 *   contract as the memory store's critical sections).
 * - SETTLEMENT replaces a reservation's conservative cost with the ACTUAL
 *   provider usage when valid numbers arrive; MISSING/INVALID usage never
 *   becomes $0 — the conservative reservation stands until the rolling
 *   window expires.
 * - Compaction contributes DOLLAR usage only (`kind='compaction'`, never a
 *   request count), attributed through `UserMemoryScopeLink` when the
 *   compaction targets a user-derived scope.
 * - Remaining values are clamped at 0 (never negative). The ledger is
 *   independent of transcripts: branch/rewind/delete/resume/duplicate
 *   handling never increments or resets it, and new chats never reset it.
 *
 * Pricing: exact-id effective rates (official defaults, or the explicit
 * `OLLAMA_MODEL_PRICING_JSON` override) — unpriced ids fail closed and are
 * never admitted at any cost.
 */
import { Prisma } from '@workforce/core/generated/prisma';
import type { PrismaClient } from '@workforce/core/generated/prisma';
import {
  conservativeCostUsd,
  effectiveModelPricing,
  round6Usd,
  type PricingOverrideEntry,
} from '@workforce/core/pricing';

/** Rolling window length (seconds); one hour per spec. */
export const HOURLY_WINDOW_SECONDS = 3_600;
/** Per-user rolling cap on ACCEPTED top-level chat generations. */
export const HOURLY_REQUEST_LIMIT = 10;
/** Per-user rolling cap on conservative estimated spend (USD). */
export const HOURLY_COST_LIMIT_USD = 1;
/**
 * Provider-side upper bound of the CONSERVATIVE output-token reservation for
 * one generation. The cap actually reserved is derived from the remaining
 * budget first (see the admission math) and never exceeds this bound.
 */
export const MAX_OUTPUT_TOKEN_CAP = 100_000;
/** Upper bound of the conservative output-token cap for one compaction run. */
export const COMPACTION_OUTPUT_TOKEN_CAP = 8_000;
/** Bounded input estimate (tokens) for one compaction run. */
export const COMPACTION_MAX_INPUT_TOKENS = 200_000;
/** Bounded input estimate (tokens) for one chat generation. */
export const MAX_INPUT_TOKEN_ESTIMATE = 200_000;
/** Ledger precision (6 decimals) for every USD amount. */
const LEDGER_PRECISION = 1_000_000;

// ---------------------------------------------------------------------------
// Types the consumers (routes / worker / tests) interact with
// ---------------------------------------------------------------------------

/** The two ledger event kinds. */
export type HourlyBudgetEventKind = 'request' | 'compaction';

/** Reasons a request could NOT be admitted. */
export type HourlyBudgetDenyReason = 'requests' | 'cost';

/** Shape served by `GET /api/usage/hourly` (exact, additive-safe). */
export interface HourlyUsageSummary {
  readonly windowSeconds: number;
  readonly requestLimit: number;
  readonly costLimitUsd: number;
  readonly requestCount: number;
  readonly remainingRequests: number;
  readonly estimatedCostUsd: number;
  readonly remainingCostUsd: number;
  readonly resetAt: string | null;
  readonly usageComplete: boolean;
  readonly models: ReadonlyArray<{
    readonly modelId: string;
    readonly requests: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCostUsd: number;
  }>;
}

/** Outcome of one admission attempt. */
export type HourlyAdmission =
  | {
      readonly outcome: 'admitted';
      /**
       * 'created' — a NEW reservation was inserted; 'existing' — an in-window
       * reservation for the SAME settle key already exists (idempotent
       * re-admission after a released key). Both admit the caller.
       */
      readonly reservation: 'created' | 'existing';
      readonly conservativeInputTokens: number;
      readonly conservativeOutputTokens: number;
      readonly conservativeCostUsd: number;
      readonly admittedAt: string;
    }
  | {
      readonly outcome: 'unpriced';
    }
  | {
      readonly outcome: 'denied';
      readonly reason: HourlyBudgetDenyReason;
      /** Next relevant rolling expiry (the earliest in-window event + 60 min). */
      readonly retryAt: string;
    };

export interface HourlyBudgetAdmitInput {
  readonly ownerId: string;
  /** The EXACT model id this generation was admitted for. */
  readonly modelId: string;
  readonly inputTokensEstimate: number;
  /** Stable settle key (chat generations): chatId + the newest user message id. */
  readonly chatId: string;
  readonly userMessageId: string;
}

export interface HourlyBudgetSettleInput {
  readonly ownerId: string;
  readonly chatId: string;
  readonly userMessageId: string;
  /** Bind the settlement to the INTENDED reserved row's model. */
  readonly modelId: string;
  /** ACTUAL provider usage; missing/invalid → the reservation is retained. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface HourlyBudgetCancelInput {
  readonly ownerId: string;
  readonly chatId: string;
  readonly userMessageId: string;
}

export interface HourlyBudgetDollarInput {
  readonly ownerId: string;
  /** The model that will actually run the work (pinned compaction model). */
  readonly modelId: string;
  readonly inputTokensEstimate: number;
  readonly outputTokensCap: number;
  /** Stable per-logical-run key (scope/path/triggerBlockId) for dedupe. */
  readonly dedupeKey?: string;
}

export type CompactionReserveInput = HourlyBudgetDollarInput;
export type CompactionReserveOutcome = 'admitted' | 'denied' | 'unpriced';

/** Cheap row cost for idempotent re-admission (settled → max rule). */
function rowUsd(row: HourlyBudgetEventRow): number {
  return effectiveEventCostUsd(row);
}

/** Owner-scoped critical section over one budget transaction. */
export interface HourlyBudgetOwnerTx {
  /** In-window (rolling) events, oldest first. */
  listWindowEvents(): Promise<Array<HourlyBudgetEventRow>>;
  /** Inserts one event and returns its row (id/createdAt included). */
  insertEvent(event: HourlyBudgetEventInsert): Promise<HourlyBudgetEventRow>;
  /** Replaces a matching chat reservation with the actual usage (idempotent). */
  settleChatEvent(input: { chatId: string; userMessageId: string; inputTokens: number; outputTokens: number; costUsd: number }): Promise<boolean>;
}

export interface HourlyBudgetEventInsert {
  readonly kind: HourlyBudgetEventKind;
  readonly model: string;
  readonly chatId: string | null;
  readonly userMessageId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

export interface HourlyBudgetEventRow {
  readonly id: string;
  readonly kind: HourlyBudgetEventKind;
  readonly model: string;
  readonly createdAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly actualInputTokens: number | null;
  readonly actualOutputTokens: number | null;
  readonly actualCostUsd: number | null;
  readonly usageSettledAt: string | null;
}

/** The service contract (Postgres-backed in production; in-memory in tests). */
export interface HourlyBudgetService {
  /**
   * Atomically admits one chat generation under the owner's rolling window.
   * Unpriced ids fail closed with `outcome:'unpriced'` (the route blocks).
   */
  admitChatUse(input: HourlyBudgetAdmitInput): Promise<HourlyAdmission>;

  /** Attaches actual provider usage to the turn's reservation (best effort). */
  settleChatUse(input: HourlyBudgetSettleInput): Promise<void>;

  /**
   * Cancels a still-RESERVED (unsettled) chat reservation — used ONLY after
   * an admission but before any provider streaming began (a released
   * idempotency key must never keep a phantom spend). Idempotent: repeats
   * are no-ops and SETTLED rows are never touched.
   */
  cancelChatUse(input: HourlyBudgetCancelInput): Promise<void>;

  /**
   * Reserves compaction dollars under the owner's window (never a request).
   * Outcome (never a bare boolean): 'admitted' | 'denied' | 'unpriced' —
   * denied/unpriced MUST throw {@link HourlyBudgetDeniedError} at the hook.
   */
  reserveCompactionUse(input: CompactionReserveInput): Promise<CompactionReserveOutcome>;

  /** Resolves the owner behind a derived memory scope (or null). */
  ownerForScope(scope: string): Promise<string | null>;

  /** Links a derived memory scope to its owner (idempotent upsert). */
  recordScopeOwner(scope: string, ownerId: string): Promise<void>;

  /** The exact `GET /api/usage/hourly` shape for the owner's rolling window. */
  summarize(ownerId: string): Promise<HourlyUsageSummary>;
}

export interface HourlyBudgetServiceOptions {
  /** Injectable clock (tests); defaults to `new Date()`. */
  readonly now?: () => Date;
  /** Pricing table override (`OLLAMA_MODEL_PRICING_JSON`, already parsed). */
  readonly modelPricingOverride: Readonly<Record<string, PricingOverrideEntry>> | null;
}

/**
 * Typed, FIXED-message error raised when compaction was rejected by the
 * hourly budget (denied/unpriced/paused-window). Never carries message text,
 * model content, or secrets; BullMQ owns the retry via its own backoff.
 */
export class HourlyBudgetDeniedError extends Error {
  readonly code = 'HOURLY_BUDGET_DENIED';
  constructor() {
    super('Compaction was rejected by the hourly usage budget.');
    this.name = 'HourlyBudgetDeniedError';
  }
}

/** Stable compaction dedupe key (per logical compaction, retries included). */
export function compactionDedupeKey(scope: string, path: string, triggerBlockId: string): string {
  return `compaction:${scope}/${path}/${triggerBlockId}`;
}

// ---------------------------------------------------------------------------
// Shared pure window math (both implementations; unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Effective ENFORCEMENT cost of one row. Conservative hard-cap rule: a
 * settled row costs `max(conservative reservation, actual)` — a cheap
 * actual settle must NEVER release dollars that would let cumulative ACTUAL
 * charges exceed the limit. Exact token REPORTING stays separate (actual
 * tokens surface in the per-model buckets; dollar enforcement here).
 */
export function effectiveEventCostUsd(row: HourlyBudgetEventRow): number {
  if (row.usageSettledAt !== null && row.actualCostUsd !== null) {
    return round6Usd(Math.max(row.estimatedCostUsd, row.actualCostUsd));
  }
  return round6Usd(row.estimatedCostUsd);
}

/** Rolling-window counters over the in-window rows (pure, clamp-at-zero). */
export function summarizeWindow(
  rows: readonly HourlyBudgetEventRow[],
  options: { windowSeconds?: number } = {},
): HourlyUsageSummary {
  const windowSeconds = options.windowSeconds ?? HOURLY_WINDOW_SECONDS;
  const requestRows = rows.filter((row) => row.kind === 'request');
  const requestCount = requestRows.length;
  let estimatedCostUsd = 0;
  for (const row of rows) {
    estimatedCostUsd += effectiveEventCostUsd(row);
  }
  estimatedCostUsd = round6Usd(estimatedCostUsd);

  const usageComplete = requestRows.every((row) => row.usageSettledAt !== null);

  const models = new Map<
    string,
    { modelId: string; requests: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  >();
  for (const row of requestRows) {
    const bucket = models.get(row.model) ?? { modelId: row.model, requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
    bucket.requests += 1;
    bucket.inputTokens += row.usageSettledAt !== null && row.actualInputTokens !== null ? row.actualInputTokens : row.inputTokens;
    bucket.outputTokens += row.usageSettledAt !== null && row.actualOutputTokens !== null ? row.actualOutputTokens : row.outputTokens;
    bucket.estimatedCostUsd = round6Usd(bucket.estimatedCostUsd + effectiveEventCostUsd(row));
    models.set(row.model, bucket);
  }

  // Next relevant rolling expiry: the earliest in-window event leaves at
  // createdAt + window (null when the window holds nothing).
  const earliest = rows.reduce<string | null>((acc, row) => (acc === null || row.createdAt < acc ? row.createdAt : acc), null);
  const resetAt =
    earliest !== null
      ? new Date(Math.min(Date.parse(earliest) + windowSeconds * 1_000, Number.MAX_SAFE_INTEGER)).toISOString()
      : null;

  return {
    windowSeconds,
    requestLimit: HOURLY_REQUEST_LIMIT,
    costLimitUsd: HOURLY_COST_LIMIT_USD,
    requestCount,
    remainingRequests: Math.max(0, HOURLY_REQUEST_LIMIT - requestCount),
    estimatedCostUsd,
    remainingCostUsd: Math.max(0, round6Usd(HOURLY_COST_LIMIT_USD - estimatedCostUsd)),
    resetAt,
    usageComplete,
    models: [...models.values()],
  };
}

/**
 * Reason-aware rolling retryAt: a REQUEST-cap denial frees when the earliest
 * in-window REQUEST event leaves; a COST denial when the earliest BILLABLE
 * (any kind) event leaves.
 */
export function retryAtForReason(
  rows: readonly HourlyBudgetEventRow[],
  reason: HourlyBudgetDenyReason,
  fallbackNowMs: number,
): string {
  const relevant = rows.filter((row) => (reason === 'requests' ? row.kind === 'request' : row.kind === 'request' || row.kind === 'compaction'));
  const earliest = relevant.reduce<string | null>(
    (acc, row) => (acc === null || row.createdAt < acc ? row.createdAt : acc),
    null,
  );
  return earliest !== null
    ? new Date(Date.parse(earliest) + HOURLY_WINDOW_SECONDS * 1_000).toISOString()
    : new Date(fallbackNowMs + HOURLY_WINDOW_SECONDS * 1_000).toISOString();
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests; per-owner promise-chain critical section)
// ---------------------------------------------------------------------------

export function createInMemoryHourlyBudgetService(options: HourlyBudgetServiceOptions): HourlyBudgetService {
  const now = options.now ?? (() => new Date());
  interface StoredEvent {
    id: string;
    ownerId: string;
    kind: HourlyBudgetEventKind;
    status: string;
    model: string;
    chatId: string | null;
    userMessageId: string | null;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    actualInputTokens: number | null;
    actualOutputTokens: number | null;
    actualCostUsd: number | null;
    usageSettledAt: string | null;
    createdAt: string;
  }
  const events: StoredEvent[] = [];
  const scopeOwners = new Map<string, string>();
  const locks = new Map<string, Promise<unknown>>();

  function windowRows(ownerId: string): Array<StoredEvent> {
    const lower = now().getTime() - HOURLY_WINDOW_SECONDS * 1_000;
    return events.filter((row) => row.ownerId === ownerId && Date.parse(row.createdAt) >= lower);
  }

  /** Per-owner promise chain: the same serialization contract as Postgres. */
  async function withLock<T>(ownerId: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(ownerId) ?? Promise.resolve();
    const run = previous.then(work, work);
    locks.set(
      ownerId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await run;
  }

  function clockIso(): string {
    return now().toISOString();
  }

  return {
    async admitChatUse(input: HourlyBudgetAdmitInput): Promise<HourlyAdmission> {
      const rates = effectiveModelPricing(options.modelPricingOverride, input.modelId);
      if (rates === null) {
        return { outcome: 'unpriced' };
      }
      return await withLock(input.ownerId, async () => {
        const rows = windowRows(input.ownerId);
        // IDEMPOTENT admission: an IN-WINDOW, STILL-RESERVED (unsettled)
        // request reservation for the SAME settle key AND THE SAME MODEL is
        // re-returned (within-key pre-stream retry dedupe). A SETTLED row is
        // a completed prior turn: after rewind+resend it is a NEW normal
        // request (subject to the caps); a different-model crash retry gets
        // its own correctly priced reservation — never the wrong model.
        const existing = rows.find(
          (row) =>
            row.kind === 'request' &&
            row.chatId === input.chatId &&
            row.userMessageId === input.userMessageId &&
            row.model === input.modelId &&
            row.usageSettledAt === null,
        );
        if (existing !== undefined) {
          return {
            outcome: 'admitted' as const,
            reservation: 'existing' as const,
            conservativeInputTokens: existing.inputTokens,
            conservativeOutputTokens: existing.outputTokens,
            conservativeCostUsd: rowUsd(existing),
            admittedAt: existing.createdAt,
          };
        }
        const summary = summarizeWindow(rows);
        if (summary.remainingRequests <= 0) {
          return { outcome: 'denied' as const, reason: 'requests' as const, retryAt: retryAtForReason(rows, 'requests', now().getTime()) };
        }
        if (summary.remainingCostUsd <= 0) {
          return { outcome: 'denied' as const, reason: 'cost' as const, retryAt: retryAtForReason(rows, 'cost', now().getTime()) };
        }
        const inputTokens = Math.min(Math.max(0, Math.ceil(input.inputTokensEstimate)), MAX_INPUT_TOKEN_ESTIMATE);
        const inputCost = (inputTokens / 1_000_000) * rates.input;
        if (Math.floor(inputCost * LEDGER_PRECISION) > Math.floor(summary.remainingCostUsd * LEDGER_PRECISION)) {
          return { outcome: 'denied' as const, reason: 'cost' as const, retryAt: retryAtForReason(rows, 'cost', now().getTime()) };
        }
        // Zero/zero-rate guard: no division by zero, no NaN into the ledger.
        const outputTokens =
          rates.output === 0
            ? MAX_OUTPUT_TOKEN_CAP
            : Math.min(MAX_OUTPUT_TOKEN_CAP, Math.max(0, Math.floor((summary.remainingCostUsd * LEDGER_PRECISION - Math.ceil(inputCost * LEDGER_PRECISION)) / rates.output)));
        const conservativeRaw = conservativeCostUsd(rates, inputTokens, outputTokens);
        if (!Number.isFinite(conservativeRaw)) {
          return { outcome: 'denied' as const, reason: 'cost' as const, retryAt: retryAtForReason(rows, 'cost', now().getTime()) };
        }
        const conservative = round6Usd(conservativeRaw);
        if (conservative > summary.remainingCostUsd) {
          return { outcome: 'denied' as const, reason: 'cost' as const, retryAt: retryAtForReason(rows, 'cost', now().getTime()) };
        }
        const createdAt = clockIso();
        const stored = {
          id: `evt-${String(events.length + 1)}-${Math.floor(Math.random() * 1e6)}`,
          ownerId: input.ownerId,
          kind: 'request' as const,
          status: 'reserved',
          model: input.modelId,
          chatId: input.chatId,
          userMessageId: input.userMessageId,
          inputTokens,
          outputTokens,
          estimatedCostUsd: conservative,
          actualInputTokens: null,
          actualOutputTokens: null,
          actualCostUsd: null,
          usageSettledAt: null as string | null,
          createdAt,
        };
        events.push(stored);
        return {
          outcome: 'admitted' as const,
          reservation: 'created' as const,
          conservativeInputTokens: inputTokens,
          conservativeOutputTokens: outputTokens,
          conservativeCostUsd: conservative,
          admittedAt: createdAt,
        };
      });
    },
    async settleChatUse(input: HourlyBudgetSettleInput): Promise<void> {
      await withLock(input.ownerId, async () => {
        const usage = input.usage;
        if (usage === undefined) {
          return; // missing usage → reservation stands until expiry
        }
        const cleanInput =
          typeof usage.inputTokens === 'number' &&
          Number.isInteger(usage.inputTokens) &&
          usage.inputTokens >= 0 &&
          usage.inputTokens <= MAX_USAGE_TOKEN_COUNT
            ? usage.inputTokens
            : null;
        const cleanOutput =
          typeof usage.outputTokens === 'number' &&
          Number.isInteger(usage.outputTokens) &&
          usage.outputTokens >= 0 &&
          usage.outputTokens <= MAX_USAGE_TOKEN_COUNT
            ? usage.outputTokens
            : null;
        if (cleanInput === null || cleanOutput === null) {
          return; // invalid usage → never becomes $0
        }
        const targetModel = input.modelId;
        const row = [...events]
          .reverse()
          .find(
            (candidate) =>
              candidate.ownerId === input.ownerId &&
              candidate.chatId === input.chatId &&
              candidate.userMessageId === input.userMessageId &&
              candidate.model === targetModel &&
              candidate.kind === 'request' &&
              candidate.usageSettledAt === null,
          );
        if (row === undefined) {
          return;
        }
        const rates = effectiveModelPricing(options.modelPricingOverride, row.model);
        if (rates === null) {
          return;
        }
        row.actualInputTokens = cleanInput;
        row.actualOutputTokens = cleanOutput;
        row.actualCostUsd = round6Usd(conservativeCostUsd(rates, cleanInput, cleanOutput));
        row.usageSettledAt = clockIso();
      });
    },

    async cancelChatUse(input: HourlyBudgetCancelInput): Promise<void> {
      await withLock(input.ownerId, async () => {
        const lower = now().getTime() - HOURLY_WINDOW_SECONDS * 1_000;
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const candidate = events[index];
          if (
            candidate !== undefined &&
            candidate.ownerId === input.ownerId &&
            candidate.chatId === input.chatId &&
            candidate.userMessageId === input.userMessageId &&
            candidate.kind === 'request' &&
            candidate.usageSettledAt === null &&
            Date.parse(candidate.createdAt) >= lower
          ) {
            events.splice(index, 1);
          }
        }
      });
    },
    async reserveCompactionUse(input: CompactionReserveInput): Promise<CompactionReserveOutcome> {
      const rates = effectiveModelPricing(options.modelPricingOverride, input.modelId);
      if (rates === null) {
        return 'unpriced';
      }
      return await withLock(input.ownerId, async () => {
        const rows = windowRows(input.ownerId);
        // DEDUPE: an in-window compaction reservation for the SAME logical
        // run (scope/path/triggerBlockId) is idempotently re-admitted —
        // BullMQ retries reuse it and the single internal repair pass stays
        // within that one reservation.
        if (input.dedupeKey !== undefined && rows.some((row) => row.kind === 'compaction' && row.chatId === input.dedupeKey && row.status === 'reserved')) {
          return 'admitted';
        }
        const summary = summarizeWindow(rows);
        if (summary.remainingCostUsd <= 0) {
          return 'denied';
        }
        const inputTokens = Math.min(Math.max(0, Math.ceil(input.inputTokensEstimate)), COMPACTION_MAX_INPUT_TOKENS);
        const inputCost = (inputTokens / 1_000_000) * rates.input;
        if (Math.floor(inputCost * LEDGER_PRECISION) > Math.floor(summary.remainingCostUsd * LEDGER_PRECISION)) {
          return 'denied';
        }
        const outputTokens =
          rates.output === 0
            ? Math.min(input.outputTokensCap, COMPACTION_MAX_INPUT_TOKENS)
            : Math.min(input.outputTokensCap, Math.max(0, Math.floor((summary.remainingCostUsd * LEDGER_PRECISION - Math.ceil(inputCost * LEDGER_PRECISION)) / rates.output)));
        const conservativeRaw = conservativeCostUsd(rates, inputTokens, outputTokens);
        if (!Number.isFinite(conservativeRaw)) {
          return 'denied';
        }
        const conservative = round6Usd(conservativeRaw);
        if (conservative > summary.remainingCostUsd) {
          return 'denied';
        }
        events.push({
          id: `evt-${String(events.length + 1)}-${Math.floor(Math.random() * 1e6)}`,
          ownerId: input.ownerId,
          kind: 'compaction',
          status: 'reserved',
          model: input.modelId,
          chatId: input.dedupeKey ?? null,
          userMessageId: null,
          inputTokens,
          outputTokens,
          estimatedCostUsd: conservative,
          actualInputTokens: null,
          actualOutputTokens: null,
          actualCostUsd: null,
          usageSettledAt: null,
          createdAt: clockIso(),
        });
        return 'admitted';
      });
    },
    async ownerForScope(scope: string): Promise<string | null> {
      return scopeOwners.get(scope) ?? null;
    },
    async recordScopeOwner(scope: string, ownerId: string): Promise<void> {
      scopeOwners.set(scope, ownerId);
    },
    async summarize(ownerId: string): Promise<HourlyUsageSummary> {
      return summarizeWindow(windowRows(ownerId));
    },
  };
}

/** Upper bound for any single usage counter (matches the generation contract). */
const MAX_USAGE_TOKEN_COUNT = 2_147_483_647;

/**
 * CONSERVATIVE input-token estimate from the ACTUAL outgoing content: ~1
 * token per 3 characters (under-approximates per-char for English, so the
 * estimate errs HIGH), computed over the serialized message parts plus the
 * system prompt. Bounded by `MAX_INPUT_TOKEN_ESTIMATE`.
 */
export function estimateInputTokens(messages: readonly unknown[], systemPrompt: string | null): number {
  let chars = 0;
  if (typeof systemPrompt === 'string') {
    chars += systemPrompt.length;
  }
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    const partsOfMessage = (message as { parts?: unknown }).parts;
    const parts = Array.isArray(partsOfMessage) ? partsOfMessage : [];
    for (const part of parts) {
      if (part !== null && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') {
          chars += text.length;
          continue;
        }
        // Tool inputs/outputs count at their serialized length (they ARE
        // outgoing content the provider sees).
        try {
          chars += JSON.stringify(part).length;
        } catch {
          chars += 32;
        }
      }
    }
  }
  return Math.min(MAX_INPUT_TOKEN_ESTIMATE, Math.ceil(chars / 3));
}

// ---------------------------------------------------------------------------
// Postgres implementation (production): transaction + advisory lock per owner
// ---------------------------------------------------------------------------

interface PrismaEventRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly model: string;
  readonly chatId: string | null;
  readonly userMessageId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly actualInputTokens: number | null;
  readonly actualOutputTokens: number | null;
  readonly actualCostUsd: number | null;
  readonly usageSettledAt: Date | null;
  readonly createdAt: Date;
}

function rowOut(row: PrismaEventRow): HourlyBudgetEventRow {
  return {
    id: row.id,
    kind: row.kind === 'compaction' ? 'compaction' : 'request',
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    estimatedCostUsd: round6Usd(row.estimatedCostUsd),
    actualInputTokens: row.actualInputTokens,
    actualOutputTokens: row.actualOutputTokens,
    actualCostUsd: row.actualCostUsd === null ? null : round6Usd(row.actualCostUsd),
    usageSettledAt: row.usageSettledAt === null ? null : row.usageSettledAt.toISOString(),
  };
}

export function createPostgresHourlyBudgetService(
  prisma: PrismaClient,
  options: HourlyBudgetServiceOptions,
): HourlyBudgetService {
  const now = options.now ?? (() => new Date());
  const override = options.modelPricingOverride;

  async function admitChatUse(input: HourlyBudgetAdmitInput): Promise<HourlyAdmission> {
    const rates = effectiveModelPricing(override, input.modelId);
    if (rates === null) {
      return { outcome: 'unpriced' };
    }
    return await prisma.$transaction(async (tx) => {
      // Per-owner serialization: the SAME advisory-lock pattern the memory
      // store uses; the window read + insert is one critical section.
      await tx.$queryRaw<Array<{ lock: boolean }>>`SELECT pg_advisory_xact_lock(hashtext(${input.ownerId})::bigint) IS NULL AS lock`;
      const since = new Date(now().getTime() - HOURLY_WINDOW_SECONDS * 1_000);
      const rows: PrismaEventRow[] = await tx.$queryRaw<PrismaEventRow[]>`
        SELECT "id"::text AS "id", "kind"::text AS "kind", "status"::text AS "status", "model", "chatId", "userMessageId",
               "inputTokens", "outputTokens", "estimatedCostUsd",
               "actualInputTokens", "actualOutputTokens", "actualCostUsd",
               "usageSettledAt", "createdAt"
        FROM "UserHourlyUsageEvent"
        WHERE "ownerId" = ${input.ownerId} AND "createdAt" >= ${since}
        ORDER BY "createdAt" ASC, "id" ASC`;
      // IDEMPOTENT admission: an IN-WINDOW, STILL-RESERVED (unsettled)
      // request reservation for the SAME settle key AND THE SAME MODEL is
      // re-returned (within-key pre-stream retry dedupe). A SETTLED row is a
      // completed prior turn: after rewind+resend it is a new normal request
      // (cap-checked); a different-model crash retry gets its own
      // correctly priced reservation — never the wrong model.
      const existing = rows.find(
        (row) =>
          row.kind === 'request' &&
          row.chatId === input.chatId &&
          row.userMessageId === input.userMessageId &&
          row.model === input.modelId &&
          row.status === 'reserved' &&
          row.usageSettledAt === null,
      );
      if (existing !== undefined) {
        return {
          outcome: 'admitted' as const,
          reservation: 'existing' as const,
          conservativeInputTokens: existing.inputTokens,
          conservativeOutputTokens: existing.outputTokens,
          conservativeCostUsd: rowUsd(rowOut(existing)),
          admittedAt: existing.createdAt.toISOString(),
        };
      }
      const summary = summarizeWindow(rows.map(rowOut));
      const denyReason: HourlyBudgetDenyReason | null =
        summary.remainingRequests <= 0 ? 'requests' : summary.remainingCostUsd <= 0 ? 'cost' : null;
      if (denyReason !== null) {
        return {
          outcome: 'denied' as const,
          reason: denyReason,
          retryAt: retryAtForReason(rows.map(rowOut), denyReason, now().getTime()),
        };
      }
      const inputTokens = Math.min(
        typeof input.inputTokensEstimate === 'number' && Number.isFinite(input.inputTokensEstimate) ? Math.max(0, Math.ceil(input.inputTokensEstimate)) : 0,
        MAX_INPUT_TOKEN_ESTIMATE,
      );
      const inputCost = (inputTokens / 1_000_000) * rates.input;
      if (Math.floor(inputCost * LEDGER_PRECISION) > Math.floor(summary.remainingCostUsd * LEDGER_PRECISION)) {
        return {
          outcome: 'denied' as const,
          reason: 'cost' as const,
          retryAt: retryAtForReason(rows.map(rowOut), 'cost', now().getTime()),
        };
      }
      // Zero/zero-rate guard: no division by zero, no NaN into the ledger.
      const outputTokens =
        rates.output === 0
          ? MAX_OUTPUT_TOKEN_CAP
          : Math.min(MAX_OUTPUT_TOKEN_CAP, Math.max(0, Math.floor((summary.remainingCostUsd * LEDGER_PRECISION - Math.ceil(inputCost * LEDGER_PRECISION)) / rates.output)));
      const conservativeRaw = conservativeCostUsd(rates, inputTokens, outputTokens);
      if (!Number.isFinite(conservativeRaw)) {
        return {
          outcome: 'denied' as const,
          reason: 'cost' as const,
          retryAt: retryAtForReason(rows.map(rowOut), 'cost', now().getTime()),
        };
      }
      const conservative = round6Usd(conservativeRaw);
      if (conservative > summary.remainingCostUsd) {
        return {
          outcome: 'denied' as const,
          reason: 'cost' as const,
          retryAt: retryAtForReason(rows.map(rowOut), 'cost', now().getTime()),
        };
      }
      const nowIso = now();
      await tx.$executeRaw`
        INSERT INTO "UserHourlyUsageEvent"
          ("ownerId", "kind", "status", "model", "chatId", "userMessageId",
           "inputTokens", "outputTokens", "estimatedCostUsd", "createdAt")
        VALUES
          (${input.ownerId}, 'request', 'reserved', ${input.modelId}, ${input.chatId},
           ${input.userMessageId}, ${inputTokens}, ${outputTokens}, ${conservative}, ${nowIso})`;
      return {
        outcome: 'admitted' as const,
        reservation: 'created' as const,
        conservativeInputTokens: inputTokens,
        conservativeOutputTokens: outputTokens,
        conservativeCostUsd: conservative,
        admittedAt: nowIso.toISOString(),
      };
    });
  }

  async function settleChatUse(input: HourlyBudgetSettleInput): Promise<void> {
    const usage = input.usage;
    if (usage === undefined) {
      return;
    }
    const cleanInput =
      typeof usage.inputTokens === 'number' && Number.isInteger(usage.inputTokens) && usage.inputTokens >= 0 && usage.inputTokens <= MAX_USAGE_TOKEN_COUNT
        ? usage.inputTokens
        : null;
    const cleanOutput =
      typeof usage.outputTokens === 'number' && Number.isInteger(usage.outputTokens) && usage.outputTokens >= 0 && usage.outputTokens <= MAX_USAGE_TOKEN_COUNT
        ? usage.outputTokens
        : null;
    if (cleanInput === null || cleanOutput === null) {
      return;
    }
    const rates = effectiveModelPricing(override, input.modelId);
    if (rates === null) {
      return;
    }
    const actualCost = round6Usd(conservativeCostUsd(rates, cleanInput, cleanOutput));
    // Bound to the INTENDED reserved row's model (never another settle key's
    // row, never a compaction row, never an already-settled row).
    await prisma.$executeRaw`
      UPDATE "UserHourlyUsageEvent"
      SET "status" = 'settled',
          "actualInputTokens" = ${cleanInput},
          "actualOutputTokens" = ${cleanOutput},
          "actualCostUsd" = ${actualCost},
          "usageSettledAt" = ${now()}
      WHERE "ownerId" = ${input.ownerId} AND "chatId" = ${input.chatId}
        AND "userMessageId" = ${input.userMessageId} AND "model" = ${input.modelId}
        AND "kind" = 'request' AND "status" = 'reserved'
        AND "usageSettledAt" IS NULL`;
  }

  async function cancelChatUse(input: HourlyBudgetCancelInput): Promise<void> {
    // Idempotent, conservative-cancel: deletes ONLY in-window still-RESERVED
    // (unsettled) request rows of the settle key. Settled rows — potential
    // real spend — are never touched.
    await prisma.$executeRaw`
      DELETE FROM "UserHourlyUsageEvent"
      WHERE "ownerId" = ${input.ownerId} AND "chatId" = ${input.chatId}
        AND "userMessageId" = ${input.userMessageId} AND "kind" = 'request'
        AND "status" = 'reserved' AND "usageSettledAt" IS NULL
        AND "createdAt" >= ${new Date(now().getTime() - HOURLY_WINDOW_SECONDS * 1_000)}`;
  }

  async function reserveCompactionUse(input: CompactionReserveInput): Promise<CompactionReserveOutcome> {
    const rates = effectiveModelPricing(override, input.modelId);
    if (rates === null) {
      return 'unpriced';
    }
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ lock: boolean }>>`SELECT pg_advisory_xact_lock(hashtext(${input.ownerId})::bigint) IS NULL AS lock`;
      const since = new Date(now().getTime() - HOURLY_WINDOW_SECONDS * 1_000);
      const rows: PrismaEventRow[] = await tx.$queryRaw<PrismaEventRow[]>`
        SELECT "id"::text AS "id", "kind"::text AS "kind", "status"::text AS "status", "model", "chatId", "userMessageId",
               "inputTokens", "outputTokens", "estimatedCostUsd",
               "actualInputTokens", "actualOutputTokens", "actualCostUsd",
               "usageSettledAt", "createdAt"
        FROM "UserHourlyUsageEvent"
        WHERE "ownerId" = ${input.ownerId} AND "createdAt" >= ${since}
        ORDER BY "createdAt" ASC, "id" ASC`;
      // DEDUPE: an in-window compaction reservation for the SAME logical
      // run (scope/path/triggerBlockId) is idempotently re-admitted —
      // BullMQ retries reuse it; the internal repair pass stays within it.
      if (input.dedupeKey !== undefined && rows.some((row) => row.kind === 'compaction' && row.chatId === input.dedupeKey && row.status === 'reserved')) {
        return 'admitted';
      }
      const summary = summarizeWindow(rows.map(rowOut));
      if (summary.remainingCostUsd <= 0) {
        return 'denied';
      }
      const inputTokens = Math.min(
        typeof input.inputTokensEstimate === 'number' && Number.isFinite(input.inputTokensEstimate) ? Math.max(0, Math.ceil(input.inputTokensEstimate)) : 0,
        COMPACTION_MAX_INPUT_TOKENS,
      );
      const inputCost = (inputTokens / 1_000_000) * rates.input;
      if (Math.floor(inputCost * LEDGER_PRECISION) > Math.floor(summary.remainingCostUsd * LEDGER_PRECISION)) {
        return 'denied';
      }
      const outputTokens =
        rates.output === 0
          ? Math.min(input.outputTokensCap, COMPACTION_MAX_INPUT_TOKENS)
          : Math.min(input.outputTokensCap, Math.max(0, Math.floor((summary.remainingCostUsd * LEDGER_PRECISION - Math.ceil(inputCost * LEDGER_PRECISION)) / rates.output)));
      const conservativeRaw = conservativeCostUsd(rates, inputTokens, outputTokens);
      if (!Number.isFinite(conservativeRaw)) {
        return 'denied';
      }
      const conservative = round6Usd(conservativeRaw);
      if (conservative > summary.remainingCostUsd) {
        return 'denied';
      }
      await tx.$executeRaw`
        INSERT INTO "UserHourlyUsageEvent"
          ("ownerId", "kind", "status", "model", "chatId", "userMessageId",
           "inputTokens", "outputTokens", "estimatedCostUsd", "createdAt")
        VALUES
          (${input.ownerId}, 'compaction', 'reserved', ${input.modelId}, ${input.dedupeKey ?? null},
           NULL, ${inputTokens}, ${outputTokens}, ${conservative}, ${now()})`;
      return 'admitted';
    });
  }

  async function ownerForScope(scope: string): Promise<string | null> {
    const rows = await prisma.$queryRaw<Array<{ ownerId: string }>>`
      SELECT "ownerId" FROM "UserMemoryScopeLink" WHERE "scope" = ${scope} LIMIT 1`;
    return rows[0]?.ownerId ?? null;
  }

  async function recordScopeOwner(scope: string, ownerId: string): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO "UserMemoryScopeLink" ("scope", "ownerId")
      VALUES (${scope}, ${ownerId})
      ON CONFLICT ("scope") DO NOTHING`;
  }

  async function summarize(ownerId: string): Promise<HourlyUsageSummary> {
    const since = new Date(now().getTime() - HOURLY_WINDOW_SECONDS * 1_000);
    const rows: PrismaEventRow[] = await prisma.$queryRaw<PrismaEventRow[]>`
      SELECT "id"::text AS "id", "kind"::text AS "kind", "model", "chatId", "userMessageId",
             "inputTokens", "outputTokens", "estimatedCostUsd",
             "actualInputTokens", "actualOutputTokens", "actualCostUsd",
             "usageSettledAt", "createdAt"
      FROM "UserHourlyUsageEvent"
      WHERE "ownerId" = ${ownerId} AND "createdAt" >= ${since}
      ORDER BY "createdAt" ASC, "id" ASC`;
    return summarizeWindow(rows.map(rowOut));
  }

  return { admitChatUse, settleChatUse, cancelChatUse, reserveCompactionUse, ownerForScope, recordScopeOwner, summarize };
}

void Prisma;
