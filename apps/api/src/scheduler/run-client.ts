/**
 * The standalone scheduler worker's REST run client (Phase 5 + pre-Phase 6
 * internal trust): maps the two worker-only run routes onto the
 * `@workforce/queue` {@link SchedulerRunClient} contract — one BullMQ job
 * gets exactly one HTTP run call, and ONLY its result decides `ok`.
 *
 * Pre-Phase 6 trust contract: every run POST carries —
 * - the worker CONVENTION header (`X-Workforce-Scheduler-Worker: 1`), and
 * - a SIGNED `internal-scheduler-run` HMAC context (kind
 *   `internal-scheduler-run`) bound to THIS taskId/executionId with a short
 *   TTL, signed with the shared `DELEGATION_CONTEXT_SECRET`. The literal
 *   header alone is no longer sufficient; a forged context (wrong binding,
 *   expired, unsigned) reads as a fixed 400. The platform owner itself is
 *   NOT carried: the run route derives it from the DATABASE ROW (the row is
 *   the authority) and ownerless legacy rows are refused — the worker never
 *   needs the owner id.
 *
 * Mapping rules (identical for scheduled and execution runs):
 * - 2xx with `{ ok: true }` → `{ ok: true }` (COMPLETED / SKIPPED / FAILED
 *   nonretryable / already terminal / missing or ownerless task).
 * - 2xx with `{ ok: false, reason }` → `{ ok: false, reason }` (the API
 *   already landed RETRYING or DEAD_LETTER; BullMQ owns the retry/backoff).
 * - 2xx with a malformed body → `{ ok: false, reason: 'run-malformed' }`.
 * - any non-2xx → `{ ok: false, reason: 'run-http-<status>' }`.
 * - fetch/timeout failure → `{ ok: false, reason: 'run-unavailable' }` —
 *   the client NEVER throws, so BullMQ's attempts/backoff always decides.
 *
 * Budgets: the run POST gets `executionTimeoutMs + SCHEDULER_RUN_MARGIN_MS`
 * (streams complete server-side even when this consumer gives up); every
 * other call is a plain POST with the same shape — there are no metadata
 * GETs here because the routes return everything in the run response.
 *
 * Secrets: no provider key, no Prisma, no database — Redis URL, the API
 * base URL, and the shared signing secret are the only inputs. Reasons are
 * fixed machine codes; no bodies, URLs, headers, or secret values are ever
 * logged.
 */

import type { SchedulerRunClient, SchedulerRunResult } from '@workforce/queue/scheduler';

import type { FetchLike } from '../agents/host-capabilities.js';
import {
  INTERNAL_SCHEDULER_HEADER,
  contextWindow,
  type DelegationContextSigner,
} from '../agents/delegation-context.js';
import { SCHEDULER_RUN_STREAM_MARGIN_MS } from './types.js';
import { SCHEDULER_WORKER_HEADER, SCHEDULER_WORKER_HEADER_VALUE } from './worker-contract.js';

/** Machine-safe reason codes (bounded to `[a-z0-9-]`, never echo anything). */
export const RUN_CLIENT_REASON_UNAVAILABLE = 'run-unavailable' as const;
export const RUN_CLIENT_REASON_MALFORMED = 'run-malformed' as const;

const RUN_REASON_PATTERN = /^[a-z0-9-]{1,64}$/;

function okTrue(): SchedulerRunResult {
  return { ok: true };
}

function okFalse(reason: string): SchedulerRunResult {
  return { ok: false, reason };
}

export interface SchedulerRestRunClientOptions {
  readonly fetchFn: FetchLike;
  /** Base URL of the API process (e.g. `http://127.0.0.1:3001`). */
  readonly baseUrl: string;
  /**
   * Budget (ms) for ONE run call (a full isolated chat run). The margin on
   * top lets a healthy fast stream finish while the worker still holds a
   * bound; the API keeps generating server-side either way.
   */
  readonly executionTimeoutMs: number;
  /**
   * Signs the mandatory `internal-scheduler-run` context (shared
   * `DELEGATION_CONTEXT_SECRET`). The scheduler worker REQUIRES it: without
   * a configured secret the worker cannot mint valid contexts and must not
   * start (see `src/scheduler-worker.ts`).
   */
  readonly signer: DelegationContextSigner;
}

export function createSchedulerRestRunClient(options: SchedulerRestRunClientOptions): SchedulerRunClient {
  const { fetchFn, baseUrl, signer } = options;
  const runBudgetMs = options.executionTimeoutMs + SCHEDULER_RUN_STREAM_MARGIN_MS;

  async function postRun(
    path: string,
    body: Record<string, unknown>,
    signed: { taskId?: string; executionId?: string },
  ): Promise<SchedulerRunResult> {
    const window = contextWindow(options.executionTimeoutMs);
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Worker convention (tripwire against browser calls AND a marker
          // of the BullMQ-occurrence contract).
          [SCHEDULER_WORKER_HEADER]: SCHEDULER_WORKER_HEADER_VALUE,
          // SIGNED internal run context: bound to THIS task/execution id,
          // short TTL. The run route verifies both before touching a row.
          [INTERNAL_SCHEDULER_HEADER]: signer.sign({
            kind: 'internal-scheduler-run',
            ...(signed.taskId !== undefined ? { taskId: signed.taskId } : {}),
            ...(signed.executionId !== undefined ? { executionId: signed.executionId } : {}),
            expiresAt: window.expiresAt,
          }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(runBudgetMs),
      });
    } catch {
      // Network/timeout: transient — BullMQ's attempts/backoff own the retry.
      return okFalse(RUN_CLIENT_REASON_UNAVAILABLE);
    }
    if (!response.ok) {
      return okFalse(`run-http-${response.status}`);
    }
    try {
      const parsed = (await response.json()) as { ok?: unknown; reason?: unknown };
      if (typeof (parsed as { ok?: unknown } | null)?.ok !== 'boolean') {
        return okFalse(RUN_CLIENT_REASON_MALFORMED);
      }
      if (parsed.ok) {
        return okTrue();
      }
      const reason = typeof parsed.reason === 'string' && RUN_REASON_PATTERN.test(parsed.reason)
        ? parsed.reason
        : 'run-failed';
      return okFalse(reason);
    } catch {
      return okFalse(RUN_CLIENT_REASON_MALFORMED);
    }
  }

  return {
    async runScheduled(input): Promise<SchedulerRunResult> {
      const body: Record<string, unknown> = {
        scheduledFor: input.scheduledFor,
        attempt: input.attempt,
        ...(input.queueJobId !== undefined ? { queueJobId: input.queueJobId } : {}),
        ...(input.repeatJobKey !== undefined ? { repeatJobKey: input.repeatJobKey } : {}),
      };
      return await postRun(
        `/api/scheduler/tasks/${encodeURIComponent(input.taskId)}/run-scheduled`,
        body,
        { taskId: input.taskId },
      );
    },

    async runExecution(input): Promise<SchedulerRunResult> {
      const body: Record<string, unknown> = {
        attempt: input.attempt,
        ...(input.queueJobId !== undefined ? { queueJobId: input.queueJobId } : {}),
      };
      return await postRun(
        `/api/scheduler/executions/${encodeURIComponent(input.executionId)}/run`,
        body,
        { executionId: input.executionId },
      );
    },
  };
}
