/**
 * The worker-only run-route contract (Phase 5, by CONVENTION — NOT
 * authentication): the two internal run routes
 * (`POST /tasks/:id/run-scheduled`, `POST /executions/:id/run`) require the
 * fixed {@link SCHEDULER_WORKER_HEADER} header exactly
 * `{@link SCHEDULER_WORKER_HEADER_VALUE}`.
 *
 * What this header IS: a tripwire against accidental browser calls so no web
 * client can mint occurrence metadata (`scheduledFor`, `queueJobId`,
 * `repeatJobKey`, `attempt`) by hitting the routes directly, and a marker
 * that the caller speaks the BullMQ-occurrence contract.
 *
 * What this header is NOT: authentication or an authorization scope. Anyone
 * who constructs the literal header value can call the routes. The routes are
 * safe because their effects are idempotent (unique scheduled execution rows,
 * atomic claims, terminal immutability) — never because the header protects
 * them. No new secret/env is required.
 */

export const SCHEDULER_WORKER_HEADER = 'X-Workforce-Scheduler-Worker' as const;

/** The single fixed value the run routes accept (a convention marker only). */
export const SCHEDULER_WORKER_HEADER_VALUE = '1' as const;

/** Reads the header from an Express-style get() — '1' exactly, or undefined. */
export function schedulerWorkerHeaderValue(get: (name: string) => string | undefined): string | undefined {
  const value = get(SCHEDULER_WORKER_HEADER);
  return typeof value === 'string' && value === SCHEDULER_WORKER_HEADER_VALUE ? value : undefined;
}
