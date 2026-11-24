/**
 * The worker-only run-route contract (Phase 5, hardened in pre-Phase 6):
 * the two internal run routes (`POST /tasks/:id/run-scheduled`,
 * `POST /executions/:id/run`) require BOTH
 * - the fixed {@link SCHEDULER_WORKER_HEADER} header exactly
 *   `{@link SCHEDULER_WORKER_HEADER_VALUE}`, and
 * - a SIGNED `internal-scheduler-run` HMAC context (see
 *   `agents/delegation-context.ts`, `X-Workforce-Internal-Scheduler`) bound
 *   to THIS taskId/executionId with a short TTL, minted by the scheduler
 *   worker with the shared `DELEGATION_CONTEXT_SECRET`.
 *
 * What the literal header IS: a tripwire against accidental browser calls so
 * no web client can mint occurrence metadata (`scheduledFor`, `queueJobId`,
 * `repeatJobKey`, `attempt`) by hitting the routes directly, and a marker
 * that the caller speaks the BullMQ-occurrence contract.
 *
 * What the SIGNED context adds: real unforgeability. The platform owner is
 * never carried in the payload — the run route derives it from the DATABASE
 * row (the row is the authority), binds every internal run to it, and
 * refuses ownerless pre-auth legacy rows. A forged/expired/misbound context
 * is a fixed 400; the owner can NEVER be supplied by a body or an unsigned
 * header.
 */

export const SCHEDULER_WORKER_HEADER = 'X-Workforce-Scheduler-Worker' as const;

/** The single fixed value the run routes accept (a convention marker only). */
export const SCHEDULER_WORKER_HEADER_VALUE = '1' as const;

/** Reads the header from an Express-style get() — '1' exactly, or undefined. */
export function schedulerWorkerHeaderValue(get: (name: string) => string | undefined): string | undefined {
  const value = get(SCHEDULER_WORKER_HEADER);
  return typeof value === 'string' && value === SCHEDULER_WORKER_HEADER_VALUE ? value : undefined;
}
