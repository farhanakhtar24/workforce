/**
 * The scheduler run service (Phase 5): executes one occurrence or one
 * MANUAL/RETRY execution THROUGH the API's own REST surface (ADR-002) —
 * never by generating directly, never with a shadow runner.
 *
 * ## Isolated chats
 * Every execution owns the chat `chatId = execution.id`. Claimed attempt 1
 * POSTs the EXISTING `POST /api/agents/:slug/chat` with a deterministic
 * message id `execution.id` and `Idempotency-Key: ${chatId}:${execution.id}`;
 * retries (attempt >= 2) post `${execution.id}-a<attempt>` — attempt 1's key
 * stays permanently consumed by the chat route after any failed turn
 * (ADR-005 resume semantics), so a retry re-asks with its own deterministic
 * id while duplicates of the SAME attempt share its exact key and can only
 * 409 into durable recovery. A durable PRE-CHECK before every POST promotes
 * an earlier attempt's finished-but-unrecorded answer (no regeneration in
 * recovery), consumes an earlier attempt's still-live stream via /stream
 * resume, and only then lets the new attempt post.
 *
 * ## Claim contract
 * `PENDING|RETRYING -> RUNNING` is an atomic CAS with
 * `attempt = attemptsMade + 1` (the ROW is authoritative, never the BullMQ
 * input attempt). Concurrent losers never generate: they recover through
 * durable chat hydration, terminal rows answer themselves.
 *
 * ## Outcome contract (HTTP responses the run routes return verbatim)
 * - 200 `{ ok: true, execution }` — COMPLETED / SKIPPED / nonretryable
 *   FAILED / already-terminal / missing task: benign, BullMQ completes.
 * - 200 `{ ok: false, reason }` — transient/retryable; the row was landed
 *   RETRYING (attempts remain) or DEAD_LETTER (exhausted) first.
 * - 409 — fresh RUNNING duplicate with nothing recoverable (the live runner
 *   owns it); transient, never a second generation.
 * - 404/400/503 — fixed safe errors; the REST run client maps every non-2xx
 *   to `{ ok: false }` so BullMQ owns the retry.
 *
 * ## Failure taxonomy
 * - Retrying: provider/stream/network errors, invalid/empty responses.
 *   RUNNING -> RETRYING while attempt < 3; DEAD_LETTER at attempt 3
 *   (BullMQ retains the failed job as DLQ evidence, `removeOnFail: false`).
 * - Nonretryable FAILED (ok:true — no retry): the chat route rejected the
 *   request before generation (validation) and a pending `ask_user` question
 *   in an autonomous scheduled chat (a human must answer; the question stays
 *   linked in the isolated chat).
 * - Stale RUNNING rows (>= stale budget) never regenerate: recovery promotes
 *   completed transcripts, consumes live resumes, else RETRYING or
 *   DEAD_LETTER — a RETRYING row only ever re-runs through a new claim.
 */

import { parseJsonEventStream, uiMessageChunkSchema, type UIMessageChunk } from 'ai';
import {
  MAX_TASK_ATTEMPTS,
  SchedulerConflictError,
  SchedulerNotFoundError,
  SchedulerValidationError,
  computeNextRunAt,
  utcDateKey,
  type AgentTask,
  type AgentTaskExecution,
  type AgentTaskExecutionTokenUsage,
  type SchedulerService,
} from '@workforce/core/scheduler';

import {
  SCHEDULER_RUN_STREAM_MARGIN_MS,
  OWNERLESS_TASK_MESSAGE,
  type SchedulerRunBudgets,
} from './types.js';
import { internalOwnerHeader, type DelegationContextSigner } from '../agents/delegation-context.js';

/** Machine-safe `reason` codes carried by `{ ok: false }` run responses. */
export const RUN_REASON_RETRYING = 'retrying' as const;
export const RUN_REASON_DEAD_LETTER = 'dead-letter' as const;

/** Fixed safe texts stored on FAILED/DEAD_LETTER rows (bounded <= 1000). */
export const RUN_FAILED_TEXT_REQUEST_INVALID = 'The scheduled task request was invalid and cannot be retried.';
export const RUN_FAILED_TEXT_PENDING_QUESTION = 'The scheduled task stopped because the agent asked a question.';
export const RUN_FAILED_TEXT_DEAD_LETTER = 'The scheduled task failed all attempts and moved to the dead letter queue.';

/** One HTTP-shaped run outcome a route writes verbatim (fixed safe bodies). */
export type SchedulerRunOkBody = {
  readonly ok: true;
  /** Present whenever an execution row exists for this run. */
  readonly execution?: AgentTaskExecution;
  /** Whether THIS call executed/chat-posted (recovery/idempotent calls: false). */
  readonly executed: boolean;
  /** True for paused/skip-date occurrences recorded SKIPPED without a run. */
  readonly skipped?: boolean;
  /** True when the taskId referenced no task (nothing to run, nothing to retry). */
  readonly taskMissing?: boolean;
  /**
   * True when the row was OWNERLESS (pre-auth legacy): it is skipped without
   * a run, never generated, and never retried ( BullMQ completes the job).
   */
  readonly ownerless?: boolean;
};

export type SchedulerRunOutcome =
  | { readonly status: 200; readonly body: SchedulerRunOkBody }
  | { readonly status: 200; readonly body: { readonly ok: false; readonly reason: string } }
  | { readonly status: 404; readonly body: { readonly error: string } }
  | { readonly status: 400; readonly body: { readonly error: string } }
  | { readonly status: 409; readonly body: { readonly error: string } }
  | { readonly status: 503; readonly body: { readonly error: string } };

export interface SchedulerRunServiceOptions {
  readonly service: SchedulerService;
  readonly budgets: SchedulerRunBudgets;
}

export interface SchedulerRunService {
  /** One BullMQ occurrence: materialize (unique) + skip or run. */
  runScheduled(input: {
    taskId: string;
    scheduledFor: string;
    attempt: number;
    queueJobId?: string;
    repeatJobKey?: string;
  }): Promise<SchedulerRunOutcome>;
  /** One MANUAL/RETRY execution run (or recovery of an in-flight one). */
  runExecution(input: { executionId: string; attempt: number; queueJobId?: string }): Promise<SchedulerRunOutcome>;
}

const SCHEDULER_STORE_UNAVAILABLE_503 = 'Scheduler service is temporarily unavailable.';
const SCHEDULER_CONFLICT_409 = 'Scheduler conflict.';

/**
 * Exact-instant equality for the {@link nextRunAt} advancement guard: both
 * values are ISO 'Z' instants and must denote the same millisecond (BullMQ
 * occurrence metadata and the store's croner computation agree to the ms for
 * UTC-minute-aligned patterns). String equality alone would reject
 * `.000Z`/`.0Z` spellings of the same instant.
 */
function sameInstant(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

/** Bounded usage numbers: the durationMs/usage ceiling from the domain. */
const MAX_DURATION_OR_TOKEN = 2_147_483_647 as const;

export function createSchedulerRunService(options: SchedulerRunServiceOptions): SchedulerRunService {
  const { service } = options;
  const budgets = options.budgets;
  const { fetchFn, baseUrl, logger } = budgets;

  const chatBudgetMs = budgets.executionTimeoutMs + SCHEDULER_RUN_STREAM_MARGIN_MS;
  const metadataBudgetMs = budgets.metadataTimeoutMs;
  const runSigner: DelegationContextSigner | undefined = budgets.signer;

  /**
   * Signed internal-owner headers for the loopback chat/hydration/resume
   * calls: the routes resolve the row-derived owner from them. When no
   * signer was wired (tests that stub the HTTP layer), calls carry no header
   * and the chat routes honestly 401 them — never an ownerless fallback.
   */
  function internalHeaders(ownerId: string): Record<string, string> {
    if (runSigner === undefined) {
      return {};
    }
    return internalOwnerHeader(runSigner, ownerId);
  }

  // ------------------------------------------------------------ primitives

  /** Bounded fetch that never throws; `timedOut` mirrors the abort signal. */
  async function boundedFetch(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<{ ok: true; response: Response } | { ok: false }> {
    try {
      const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      return { ok: true, response };
    } catch {
      return { ok: false };
    }
  }

  function storeOutage(): SchedulerRunOutcome {
    return { status: 503, body: { error: SCHEDULER_STORE_UNAVAILABLE_503 } };
  }

  function conflict409(): SchedulerRunOutcome {
    return { status: 409, body: { error: SCHEDULER_CONFLICT_409 } };
  }

  /** Maps a thrown store/service error to the route taxonomy; null = other. */
  function mapServiceError(error: unknown): SchedulerRunOutcome | null {
    if (error instanceof SchedulerValidationError) {
      return { status: 400, body: { error: 'Invalid scheduler request.' } };
    }
    if (error instanceof SchedulerNotFoundError) {
      return { status: 404, body: { error: 'Scheduler row not found.' } };
    }
    if (error instanceof SchedulerConflictError) {
      return conflict409();
    }
    return null;
  }

  function boundedDuration(startedAtMs: number): number {
    return Math.max(0, Math.min(MAX_DURATION_OR_TOKEN, Date.now() - startedAtMs));
  }

  /** Bounded usage from persisted/stream metadata; null when absent/invalid. */
  function tokenUsageOf(metadata: unknown): AgentTaskExecutionTokenUsage | null {
    if (metadata === null || typeof metadata !== 'object') {
      return null;
    }
    const usage = (metadata as { usage?: unknown }).usage;
    if (usage === null || typeof usage !== 'object') {
      return null;
    }
    const bounded = (value: unknown): number | undefined => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_DURATION_OR_TOKEN) {
        return undefined;
      }
      return value;
    };
    const inputTokens = bounded((usage as { inputTokens?: unknown }).inputTokens);
    const outputTokens = bounded((usage as { outputTokens?: unknown }).outputTokens);
    const totalTokens = bounded((usage as { totalTokens?: unknown }).totalTokens);
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
      return null;
    }
    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    };
  }

  interface StoredMessageShape {
    readonly role?: unknown;
    readonly parts?: unknown;
    readonly metadata?: unknown;
  }

  interface CompletedAssistant {
    readonly usage: AgentTaskExecutionTokenUsage | null;
  }

  function isAssistantMessage(entry: unknown): entry is StoredMessageShape {
    return (
      entry !== null && typeof entry === 'object' &&
      (entry as StoredMessageShape).role === 'assistant' &&
      Array.isArray((entry as StoredMessageShape).parts)
    );
  }

  /** Whether a stored assistant message still holds a pending question. */
  function messageHasPendingAskUser(parts: readonly unknown[]): boolean {
    return parts.some(
      (part) =>
        part !== null && typeof part === 'object' &&
        (part as { type?: unknown }).type === 'tool-ask_user' &&
        (part as { state?: unknown }).state === 'input-available',
    );
  }

  /**
   * Newest assistant message that carries a finished, answerable response:
   * at least one non-`step-start` part and NO pending (input-available)
   * ask_user question inside it. Null otherwise.
   */
  function completedAssistantOf(messages: readonly unknown[]): CompletedAssistant | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index];
      if (!isAssistantMessage(entry)) {
        continue;
      }
      const parts = entry.parts as readonly unknown[];
      const hasContent = parts.some(
        (part) => !(part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'step-start'),
      );
      if (hasContent && !messageHasPendingAskUser(parts)) {
        return { usage: tokenUsageOf(entry.metadata) };
      }
    }
    return null;
  }

  function hasPendingAskUser(messages: readonly unknown[]): boolean {
    return messages.some(
      (entry) => isAssistantMessage(entry) && messageHasPendingAskUser(entry.parts as readonly unknown[]),
    );
  }

  interface ChatHydration {
    readonly messages: readonly unknown[];
    readonly hasActiveStream: boolean;
  }

  /** Durable hydration of one execution chat (bounded metadata call). */
  async function hydrateChat(ownerId: string, slug: string, chatId: string): Promise<ChatHydration | null> {
    const outcome = await boundedFetch(
      `${baseUrl}/api/agents/${encodeURIComponent(slug)}/chat/${encodeURIComponent(chatId)}`,
      { method: 'GET', headers: internalHeaders(ownerId) },
      metadataBudgetMs,
    );
    if (!outcome.ok || !outcome.response.ok) {
      return null;
    }
    try {
      const body = (await outcome.response.json()) as { messages?: unknown; hasActiveStream?: unknown };
      return {
        messages: Array.isArray(body.messages) ? body.messages : [],
        hasActiveStream: body.hasActiveStream === true,
      };
    } catch {
      return null;
    }
  }

  /** Consumes one SSE UI-message stream: usage metadata + error detection. */
  async function consumeChatStream(
    responseBody: ReadableStream<Uint8Array>,
  ): Promise<{ usage: AgentTaskExecutionTokenUsage | null; sawError: boolean }> {
    const parsedStream = parseJsonEventStream({
      stream: responseBody,
      schema: uiMessageChunkSchema(),
    });
    const reader = parsedStream.getReader();
    let usage: AgentTaskExecutionTokenUsage | null = null;
    let sawError = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value.success) {
        throw new Error('scheduler stream parse failure');
      }
      const chunk = value.value as UIMessageChunk;
      const chunkUsage = tokenUsageOf((chunk as { messageMetadata?: unknown }).messageMetadata);
      if (chunkUsage !== null) {
        usage = chunkUsage;
      }
      if (chunk.type === 'error') {
        sawError = true;
      }
    }
    return { usage, sawError };
  }

  /** Consumes the existing /stream resume; bounded; failures are nonfatal. */
  async function consumeResumeStream(ownerId: string, slug: string, chatId: string): Promise<void> {
    const outcome = await boundedFetch(
      `${baseUrl}/api/agents/${encodeURIComponent(slug)}/chat/${encodeURIComponent(chatId)}/stream`,
      { method: 'GET', headers: internalHeaders(ownerId) },
      metadataBudgetMs,
    );
    if (
      !outcome.ok ||
      outcome.response.status === 204 ||
      !outcome.response.ok ||
      outcome.response.body === null
    ) {
      return; // No live/repairable stream: hydration decides what is durable.
    }
    try {
      await consumeChatStream(outcome.response.body);
    } catch {
      // A broken resume is not terminal: hydration still decides.
      logger.warn('scheduler-run-resume-consume-failed');
    }
  }

  function isTerminal(status: AgentTaskExecution['status']): boolean {
    return status === 'COMPLETED' || status === 'FAILED' || status === 'DEAD_LETTER' || status === 'SKIPPED';
  }

  // ------------------------------------------------------------- entry points

  return {
    async runScheduled(input): Promise<SchedulerRunOutcome> {
      let task: AgentTask | null;
      try {
        task = await service.getTask(input.taskId);
      } catch (error) {
        const mapped = mapServiceError(error);
        return mapped ?? storeOutage();
      }
      if (task === null) {
        // Unknown task: nothing to run; a BullMQ retry could never fix it.
        logger.warn('scheduler-run-scheduled-task-missing');
        return {
          status: 200,
          body: { ok: true, executed: false, skipped: true, taskMissing: true },
        };
      }
      if (task.ownerId === null || task.ownerId.length === 0) {
        // Ownerless (pre-auth legacy) task: it can NEVER run — no owner
        // exists to bind the isolated chat to. Skipped without generation,
        // never retried (a BullMQ retry would only repeat this refusal).
        logger.warn('scheduler-run-scheduled-task-ownerless');
        return {
          status: 200,
          body: { ok: true, executed: false, skipped: true, ownerless: true },
        };
      }
      const ownerId: string = task.ownerId;

      const skipDate = task.skipDates.includes(utcDateKey(new Date(input.scheduledFor)));
      const skip = !task.isActive || skipDate;

      let execution: AgentTaskExecution;
      try {
        // Unique SCHEDULED row per (task, scheduledFor): every duplicate
        // delivery returns the EXISTING row — never a second chat id.
        const created = await service.createExecution(task, {
          scheduledFor: input.scheduledFor,
          trigger: 'SCHEDULED',
          ...(input.queueJobId !== undefined ? { queueJobId: input.queueJobId } : {}),
          ...(input.repeatJobKey !== undefined ? { repeatJobKey: input.repeatJobKey } : {}),
        });
        execution = created.execution;
      } catch (error) {
        if (error instanceof SchedulerConflictError && (input.queueJobId !== undefined || input.repeatJobKey !== undefined)) {
          // Redelivery of the same occurrence with the same BullMQ identity:
          // some stores check queue-identity uniqueness BEFORE the scheduled
          // dedupe. Retry WITHOUT the identity fields so the authoritative
          // (task, scheduledFor) dedupe returns the existing row untouched.
          try {
            const created = await service.createExecution(task, {
              scheduledFor: input.scheduledFor,
              trigger: 'SCHEDULED',
            });
            execution = created.execution;
          } catch (fallbackError) {
            const mapped = mapServiceError(fallbackError);
            return mapped ?? storeOutage();
          }
        } else {
          const mapped = mapServiceError(error);
          return mapped ?? storeOutage();
        }
      }

      // -- nextRunAt metadata advancement (UI "Next run" + reconcile only) ---
      // Guard: metadata advances ONLY while the row's nextRunAt is EXACTLY
      // this occurrence instant. Invariants:
      // - A redelivered/older occurrence arriving after the first delivery
      //   advanced the metadata reads the NEW nextRunAt (or null for ONCE)
      //   and fails the guard -> it never overwrites and never re-advances.
      // - A concurrent human PATCH that moved nextRunAt away also fails the
      //   guard. Advancement itself is deterministic (croner from the same
      //   task row), so racing deliveries that both pass the guard write the
      //   IDENTICAL value — idempotent.
      // - Queues are NEVER synced here: BullMQ owns recurring schedules;
      //   upserting/resetting the scheduler must not happen on deliveries.
      //   This field feeds the UI and the startup reconcile only, and there
      //   is still NO catch-up/backfill (advanced past instants are missed by
      //   design, per ADR-006).
      if (task.nextRunAt !== null && sameInstant(task.nextRunAt, input.scheduledFor)) {
        const nextValue: string | null =
          task.recurrenceType === 'ONCE'
            ? null
            : (computeNextRunAt({
                recurrenceType: task.recurrenceType,
                recurrenceConfig: task.recurrenceConfig,
                after: new Date(input.scheduledFor),
                skipDates: task.skipDates,
              })?.toISOString() ?? null);
        try {
          // Explicit-only patch: no recurrence fields are supplied, so the
          // store honors nextRunAt verbatim (null clears, e.g. ONCE); the
          // owner CAS binds the patch to the row's owner (never matches
          // foreign/ownerless rows).
          await service.updateTask({ id: task.id, nextRunAt: nextValue, expectedOwnerId: ownerId });
        } catch (error) {
          // Honest failure: stop this delivery; BullMQ's retry dedupes the
          // execution (unique row) and re-attempts advancement before
          // running — the occurrence can never generate twice.
          const mapped = mapServiceError(error);
          return mapped ?? storeOutage();
        }
      }

      if (skip && execution.status === 'PENDING') {
        // Paused task or skip-date occurrence: SKIPPED, no provider call.
        try {
          const skipped = await service.markSkipped({ id: execution.id, expectedOwnerId: ownerId });
          return {
            status: 200,
            body: { ok: true, execution: skipped, executed: false, skipped: true },
          };
        } catch (error) {
          if (error instanceof SchedulerConflictError) {
            // Raced a real claim (claimed between materialize and skip): the
            // claim predates this delivery — let the bounded flow finish it.
            logger.warn('scheduler-run-skip-raced-claim');
          } else {
            const mapped = mapServiceError(error);
            return mapped ?? storeOutage();
          }
        }
      } else if (skip && isTerminal(execution.status)) {
        return {
          status: 200,
          body: { ok: true, execution, executed: false, skipped: true },
        };
      }
      // Non-skip occurrences AND in-flight (RUNNING/RETRYING) rows of a
      // paused task go through the standard bounded flow: in-flight rows
      // already hold a claim that predates the pause, and leaving them
      // RUNNING/RETRYING forever would be worse than finishing them.
      return await runExecutionRow(execution.id, execution, ownerId);
    },

    async runExecution(input): Promise<SchedulerRunOutcome> {
      let execution: AgentTaskExecution | null;
      try {
        execution = await service.getExecution(input.executionId);
      } catch {
        return storeOutage();
      }
      if (execution === null) {
        return { status: 404, body: { error: 'Execution not found.' } };
      }
      if (execution.ownerId === null || execution.ownerId.length === 0) {
        // Ownerless (pre-auth legacy) execution: it can NEVER run — the
        // isolated chat would have no owner. Idempotently skipped.
        logger.warn('scheduler-run-execution-ownerless');
        return {
          status: 200,
          body: { ok: true, executed: false, ownerless: true },
        };
      }
      return await runExecutionRow(execution.id, execution, execution.ownerId);
    },
  };

  // ------------------------------------------------------------- core flow

  /** Drives one execution row by its current status. */
  async function runExecutionRow(
    executionId: string,
    loaded: AgentTaskExecution,
    ownerId: string,
  ): Promise<SchedulerRunOutcome> {
    if (isTerminal(loaded.status)) {
      // Terminal rows are immutable: idempotent re-runs are benign, never a
      // new chat (BullMQ retries / duplicate deliveries land here).
      return { status: 200, body: { ok: true, execution: loaded, executed: false } };
    }

    if (loaded.status === 'RUNNING') {
      return await recoverRunning(loaded, ownerId);
    }

    // PENDING/RETRYING: atomic claim, attempt exactly attemptsMade + 1, with
    // the owner CAS (a foreign-claiming writer loses the typed conflict).
    const claimAttempt = loaded.attempt + 1;
    if (claimAttempt > MAX_TASK_ATTEMPTS) {
      // Unreachable for well-formed rows (attempt-3 rows are terminal);
      // refuse honestly instead of fabricating a claim.
      logger.error('scheduler-run-claim-attempt-exhausted', new Error('claim attempt exceeds max'));
      return conflict409();
    }
    try {
      const claimed = await service.claimExecution({
        id: executionId,
        attempt: claimAttempt,
        allowedFrom: loaded.status === 'PENDING' ? 'PENDING' : 'RETRYING',
        expectedOwnerId: ownerId,
      });
      return await runClaimed(claimed, ownerId);
    } catch (error) {
      if (!(error instanceof SchedulerConflictError)) {
        const mapped = mapServiceError(error);
        return mapped ?? storeOutage();
      }
      // Loser of the claim: the winner owns the only generation. Recover
      // from durable state — never generate a second chat.
      const fresh: AgentTaskExecution | null = await service
        .getExecution(executionId, { expectedOwnerId: ownerId })
        .catch(() => null);
      if (fresh === null) {
        return conflict409();
      }
      if (isTerminal(fresh.status)) {
        return { status: 200, body: { ok: true, execution: fresh, executed: false } };
      }
      if (fresh.status === 'RUNNING') {
        return await recoverRunning(fresh, ownerId);
      }
      // Row bounced back between read and claim: transient; the next BullMQ
      // attempt claims it.
      return conflict409();
    }
  }

  /**
   * Deterministic PER-ATTEMPT user-message id: attempt 1 owns the plain
   * execution id; retries (attempt >= 2) append `-a<attempt>` so their
   * Idempotency-Key cannot collide with the chat route's never-released key
   * from an earlier failed turn (ADR-005: keys are intentionally kept after
   * the stream started). Duplicates of the same attempt still share the exact
   * same key -> 409 -> durable recovery, never a second message.
   */
  function attemptMessageId(execution: AgentTaskExecution, attempt: number): string {
    return attempt <= 1 ? execution.id : `${execution.id}-a${String(attempt)}`;
  }

  /** Builds the isolated-chat POST for one claimed execution. */
  function chatRequestPlan(task: AgentTask, execution: AgentTaskExecution, attempt: number, ownerId: string): { url: string; init: RequestInit } {
    const messageId = attemptMessageId(execution, attempt);
    return {
      url: `${baseUrl}/api/agents/${encodeURIComponent(task.agentSlug)}/chat`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Deterministic per-attempt key `${chatId}:${messageId}`: duplicate
          // POSTs of the SAME attempt can only ever 409 -> durable recovery,
          // never a second message for that attempt.
          'Idempotency-Key': `${execution.chatId}:${messageId}`,
          // SIGNED internal owner: the chat route resolves the row-derived
          // owner (the execution/chat belongs to exactly this user).
          ...internalHeaders(ownerId),
        },
        body: JSON.stringify({
          id: execution.chatId,
          message: {
            id: messageId,
            role: 'user',
            parts: [{ type: 'text', text: task.prompt }],
          },
          mode: task.mode,
        }),
      },
    };
  }

  /**
   * We WON the claim: the only chat generation for this execution starts
   * here. Every failure below maps to RETRYING (attempts remain) or
   * DEAD_LETTER (attempt 3) via valid transitions — the row can never sit
   * invisible-PENDING again once claimed.
   */
  async function runClaimed(claimed: AgentTaskExecution, ownerId: string): Promise<SchedulerRunOutcome> {
    const executionId = claimed.id;
    const claimedAtMs = Date.now();
    const attempt = claimed.attempt;

    const task: AgentTask | null = await service
      .getTask(claimed.taskId, { expectedOwnerId: ownerId })
      .catch(() => null);
    if (task === null) {
      // The task row vanished mid-run: land the row terminal and be honest.
      return await landFailed(executionId, RUN_FAILED_TEXT_REQUEST_INVALID, ownerId);
    }
    const plan = chatRequestPlan(task, claimed, attempt, ownerId);
    const recoverExisting = async (): Promise<SchedulerRunOutcome> => {
      // Durable recovery of THIS attempt's already-running/done generation
      // (a duplicate POST answer 409 here). It never regenerates: duplicate
      // POSTs of the same attempt share the deterministic key.
      const after = await hydrateChat(ownerId, task.agentSlug, claimed.chatId);
      if (after === null) {
        return await handBackForRetry(executionId, attempt, ownerId);
      }
      if (after.hasActiveStream) {
        await consumeResumeStream(ownerId, task.agentSlug, claimed.chatId);
        const settled = await hydrateChat(ownerId, task.agentSlug, claimed.chatId);
        if (settled === null) {
          return await handBackForRetry(executionId, attempt, ownerId);
        }
        const completed = completedAssistantOf(settled.messages);
        if (completed !== null) {
          return await markCompletedFromRecovery(executionId, claimedAtMs, completed.usage, ownerId);
        }
        return await handBackForRetry(executionId, attempt, ownerId);
      }
      const completed = completedAssistantOf(after.messages);
      if (completed !== null) {
        return await markCompletedFromRecovery(executionId, claimedAtMs, completed.usage, ownerId);
      }
      return await handBackForRetry(executionId, attempt, ownerId);
    };

    // Durable PRE-CHECK before posting the attempt's user turn:
    // - an EARLIER attempt's finished-but-unrecorded answer is promoted;
    // - an EARLIER attempt's still-live stream is consumed via resume, then
    //   settled from the transcript;
    // - only when nothing durable remains does THIS attempt post its own
    //   (attempt-scoped) turn. A previous attempt's failed turn (error chunk,
    //   consumer timeout) leaves the idempotency key permanently consumed on
    //   ITS message id — this attempt's key is different by construction.
    const pre = await hydrateChat(ownerId, task.agentSlug, claimed.chatId);
    if (pre === null) {
      // Metadata read failed before any POST: transient hand-back, the row
      // stays claimable.
      return await handBackForRetry(executionId, attempt, ownerId);
    }
    const preCompleted = completedAssistantOf(pre.messages);
    if (preCompleted !== null) {
      // An earlier attempt finished the answer durably but never recorded it
      // (its runner died between stream finish and the COMPLETED mark).
      return await markCompletedFromRecovery(executionId, claimedAtMs, preCompleted.usage, ownerId);
    }
    if (pre.hasActiveStream) {
      await consumeResumeStream(ownerId, task.agentSlug, claimed.chatId);
      const settled = await hydrateChat(ownerId, task.agentSlug, claimed.chatId);
      if (settled !== null) {
        const completed = completedAssistantOf(settled.messages);
        if (completed !== null) {
          return await markCompletedFromRecovery(executionId, claimedAtMs, completed.usage, ownerId);
        }
      }
      // The stream drained without a durable answer: retry later.
      return await handBackForRetry(executionId, attempt, ownerId);
    }

    // The ONE chat POST this claimed attempt gets. A concurrent duplicate of
    // THE SAME attempt answers 409 and is recovered — never re-posted.
    const postOutcome = await boundedFetch(plan.url, plan.init, chatBudgetMs);
    if (!postOutcome.ok) {
      // Network/timeout: the server-side generation keeps running (never
      // aborted); a later attempt recovers it via 409/hydration/resume.
      return await handBackForRetry(executionId, attempt, ownerId);
    }
    const response = postOutcome.response;

    if (response.status === 409) {
      // Duplicate POST of THIS attempt (same deterministic key) or a previous
      // attempt's still-live stream: recover from durable state.
      return await recoverExisting();
    }
    if (response.status === 401) {
      // The owner gate rejected the internal POST (missing/misbound signed
      // context): a configuration defect, not a retryable run. Land the row
      // FAILED without regeneration.
      logger.error('scheduler-run-chat-unauthorized', new Error('internal chat POST rejected by the owner gate'));
      return await landFailed(executionId, RUN_FAILED_TEXT_REQUEST_INVALID, ownerId);
    }
    if (response.status === 400) {
      // Rejected before generation (validation): nonretryable FAILED.
      return await landFailed(executionId, RUN_FAILED_TEXT_REQUEST_INVALID, ownerId);
    }
    if (!response.ok || response.body === null) {
      return await handBackForRetry(executionId, attempt, ownerId);
    }

    // Consume the SSE UI-message stream. The bounded consumer never aborts
    // the server-side generation; recovery stays possible at any point.
    let consumed: { usage: AgentTaskExecutionTokenUsage | null; sawError: boolean };
    try {
      consumed = await consumeChatStream(response.body);
    } catch {
      return await handBackForRetry(executionId, attempt, ownerId);
    }

    const after = await hydrateChat(ownerId, task.agentSlug, claimed.chatId);
    if (after === null) {
      return await handBackForRetry(executionId, attempt, ownerId);
    }
    if (consumed.sawError) {
      // The provider/stream failure surfaced as the safe error part.
      return await handBackForRetry(executionId, attempt, ownerId);
    }
    if (hasPendingAskUser(after.messages)) {
      // Autonomous scheduled chat asked a question: FAILED, ok:true — no
      // retry; the pending question remains linked for human inspection.
      return await landFailed(executionId, RUN_FAILED_TEXT_PENDING_QUESTION, ownerId);
    }
    const completed = completedAssistantOf(after.messages);
    if (completed === null) {
      // Stream finished without a durable answer: invalid response, retryable.
      return await handBackForRetry(executionId, attempt, ownerId);
    }
    const usage = consumed.usage ?? completed.usage;
    return await markCompletedAfterRun(executionId, boundedDuration(claimedAtMs), usage, true, ownerId);
  }

  /**
   * RUNNING recovery: durable state decides, and nothing here regenerates. A
   * completed transcript is promoted COMPLETED; an active stream is consumed
   * then re-hydrated; a FRESH running row with nothing recoverable is a 409;
   * a STALE one lands RETRYING (attempts remain) or DEAD_LETTER (final).
   */
  async function recoverRunning(loaded: AgentTaskExecution, ownerId: string): Promise<SchedulerRunOutcome> {
    const stale =
      Number.isFinite(Date.parse(loaded.updatedAt)) &&
      Date.now() - Date.parse(loaded.updatedAt) >= budgets.staleRunningMs;

    const task: AgentTask | null = await service
      .getTask(loaded.taskId, { expectedOwnerId: ownerId })
      .catch(() => null);
    if (task === null) {
      return conflict409();
    }

    const hydrated = await hydrateChat(ownerId, task.agentSlug, loaded.chatId);
    if (hydrated === null) {
      // Metadata call failed: transient — never recover on bad reads (a live
      // runner stays untouched and BullMQ retries later).
      return storeOutage();
    }

    if (hydrated.hasActiveStream) {
      await consumeResumeStream(ownerId, task.agentSlug, loaded.chatId);
      const settled = await hydrateChat(ownerId, task.agentSlug, loaded.chatId);
      if (settled !== null) {
        const completed = completedAssistantOf(settled.messages);
        if (completed !== null) {
          return await markCompletedFromRecovery(
            loaded.id,
            Date.parse(loaded.updatedAt) || 0,
            completed.usage,
            ownerId,
          );
        }
      }
      if (!stale) {
        return conflict409();
      }
      return await staleRunningOutcome(loaded.id, loaded.attempt, ownerId);
    }

    const completed = completedAssistantOf(hydrated.messages);
    if (completed !== null) {
      return await markCompletedFromRecovery(
        loaded.id,
        Date.parse(loaded.updatedAt) || 0,
        completed.usage,
        ownerId,
      );
    }
    if (!stale) {
      // Fresh RUNNING row: its claimer is (or was just now) alive; transient.
      return conflict409();
    }
    return await staleRunningOutcome(loaded.id, loaded.attempt, ownerId);
  }

  /** Stale RUNNING with no recoverable answer: RETRYING or DEAD_LETTER. */
  async function staleRunningOutcome(executionId: string, attempt: number, ownerId: string): Promise<SchedulerRunOutcome> {
    if (attempt < MAX_TASK_ATTEMPTS) {
      try {
        await service.markRetrying({ id: executionId, expectedOwnerId: ownerId });
        return { status: 200, body: { ok: false, reason: RUN_REASON_RETRYING } };
      } catch (error) {
        if (error instanceof SchedulerConflictError) {
          const fresh = await service.getExecution(executionId, { expectedOwnerId: ownerId }).catch(() => null);
          if (fresh !== null && fresh.status === 'RETRYING') {
            return { status: 200, body: { ok: false, reason: RUN_REASON_RETRYING } };
          }
          if (fresh !== null && isTerminal(fresh.status)) {
            return { status: 200, body: { ok: true, execution: fresh, executed: false } };
          }
        }
        return storeOutage();
      }
    }
    return await deadLetter(executionId, ownerId);
  }

  /** HAND-BACK path: RETRYING while attempts remain, DEAD_LETTER at 3. */
  async function handBackForRetry(executionId: string, attempt: number, ownerId: string): Promise<SchedulerRunOutcome> {
    if (attempt < MAX_TASK_ATTEMPTS) {
      try {
        await service.markRetrying({ id: executionId, expectedOwnerId: ownerId });
        return { status: 200, body: { ok: false, reason: RUN_REASON_RETRYING } };
      } catch (error) {
        if (error instanceof SchedulerConflictError) {
          const fresh = await service.getExecution(executionId, { expectedOwnerId: ownerId }).catch(() => null);
          if (fresh !== null && fresh.status === 'RETRYING') {
            return { status: 200, body: { ok: false, reason: RUN_REASON_RETRYING } };
          }
          if (fresh !== null && isTerminal(fresh.status)) {
            return { status: 200, body: { ok: true, execution: fresh, executed: false } };
          }
        }
        return storeOutage();
      }
    }
    return await deadLetter(executionId, ownerId);
  }

  /** RUNNING -> DEAD_LETTER (terminal); BullMQ retains the failed job. */
  async function deadLetter(executionId: string, ownerId: string): Promise<SchedulerRunOutcome> {
    try {
      await service.markDeadLetter({ id: executionId, error: RUN_FAILED_TEXT_DEAD_LETTER, expectedOwnerId: ownerId });
      return { status: 200, body: { ok: false, reason: RUN_REASON_DEAD_LETTER } };
    } catch (error) {
      if (error instanceof SchedulerConflictError) {
        const fresh = await service.getExecution(executionId, { expectedOwnerId: ownerId }).catch(() => null);
        if (fresh !== null && fresh.status === 'DEAD_LETTER') {
          return { status: 200, body: { ok: false, reason: RUN_REASON_DEAD_LETTER } };
        }
        if (fresh !== null && isTerminal(fresh.status)) {
          // Another writer finished it first: report the durable state.
          return { status: 200, body: { ok: true, execution: fresh, executed: false } };
        }
        if (fresh !== null && fresh.status === 'RETRYING') {
          return { status: 200, body: { ok: false, reason: RUN_REASON_RETRYING } };
        }
      }
      return storeOutage();
    }
  }

  /** RUNNING -> COMPLETED after a full fresh run. */
  async function markCompletedAfterRun(
    executionId: string,
    durationMs: number,
    usage: AgentTaskExecutionTokenUsage | null,
    executed: boolean,
    ownerId: string,
  ): Promise<SchedulerRunOutcome> {
    try {
      const completed = await service.markCompleted({
        id: executionId,
        durationMs,
        ...(usage !== null ? { tokenUsage: usage } : {}),
        expectedOwnerId: ownerId,
      });
      return { status: 200, body: { ok: true, execution: completed, executed } };
    } catch (error) {
      if (error instanceof SchedulerConflictError) {
        const fresh = await service.getExecution(executionId, { expectedOwnerId: ownerId }).catch(() => null);
        if (fresh !== null && fresh.status === 'COMPLETED') {
          return { status: 200, body: { ok: true, execution: fresh, executed: false } };
        }
      }
      return storeOutage();
    }
  }

  /** Recovery-path COMPLETED: duration derives from the running claim time. */
  async function markCompletedFromRecovery(
    executionId: string,
    claimStartedAtMs: number,
    usage: AgentTaskExecutionTokenUsage | null,
    ownerId: string,
  ): Promise<SchedulerRunOutcome> {
    const startedAtMs = Number.isFinite(claimStartedAtMs) && claimStartedAtMs > 0 ? claimStartedAtMs : Date.now();
    return await markCompletedAfterRun(executionId, boundedDuration(startedAtMs), usage, false, ownerId);
  }

  /** RUNNING -> FAILED for a nonretryable outcome (ok:true — no retry). */
  async function landFailed(executionId: string, errorText: string, ownerId: string): Promise<SchedulerRunOutcome> {
    try {
      const failed = await service.markFailed({ id: executionId, error: errorText, expectedOwnerId: ownerId });
      return { status: 200, body: { ok: true, execution: failed, executed: true } };
    } catch (error) {
      if (error instanceof SchedulerConflictError) {
        const fresh = await service.getExecution(executionId, { expectedOwnerId: ownerId }).catch(() => null);
        if (fresh !== null && fresh.status === 'FAILED') {
          return { status: 200, body: { ok: true, execution: fresh, executed: false } };
        }
      }
      const mapped = mapServiceError(error);
      return mapped ?? storeOutage();
    }
  }
}
