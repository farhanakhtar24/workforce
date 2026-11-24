/**
 * Typed errors for the scheduler domain. Every error carries a stable machine
 * `code` so routes can map them onto HTTP statuses without string matching:
 *
 * - `scheduler_validation_error` -> 400 (bad input, bad bounds, invalid cron
 *   expression, invalid recurrence config, bad date)
 * - `scheduler_not_found`        -> 404 (missing task/execution)
 * - `scheduler_conflict`         -> 409 (CAS status mismatch, stale claim,
 *   duplicate queue identity, non-equivalent terminal repeat)
 *
 * Error messages never echo prompts/content — only identifiers, statuses, and
 * shapes.
 */

export type SchedulerErrorCode =
  | 'scheduler_validation_error'
  | 'scheduler_not_found'
  | 'scheduler_conflict';

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;

  constructor(code: SchedulerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchedulerError';
    this.code = code;
  }
}

export class SchedulerValidationError extends SchedulerError {
  readonly issues: readonly string[];

  constructor(message: string, options?: { cause?: unknown; issues?: readonly string[] }) {
    super('scheduler_validation_error', message, options);
    this.name = 'SchedulerValidationError';
    this.issues = options?.issues ?? [];
  }
}

export class SchedulerNotFoundError extends SchedulerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('scheduler_not_found', message, options);
    this.name = 'SchedulerNotFoundError';
  }
}

/**
 * Raised when a compare-and-set guard fails (claim against a non-PENDING/
 * RETRYING row, mark against the wrong status, non-equivalent terminal
 * repeat), or when a uniqueness guard is violated. One concurrent candidate
 * succeeds; every loser gets this error.
 */
export class SchedulerConflictError extends SchedulerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('scheduler_conflict', message, options);
    this.name = 'SchedulerConflictError';
  }
}
