/**
 * Typed errors for the delegation domain. Stable machine `code` per the
 * memory/work-docs pattern:
 *
 * - `delegation_validation_error` -> 400 (bad input, illegal transition input
 *   shape, out-of-bounds text)
 * - `delegation_not_found`        -> 404
 * - `delegation_conflict`         -> 409 (illegal status transition such as
 *   terminal -> running, or a duplicate `childChatId`)
 *
 * Error messages never echo task text, results, or provider errors — only
 * identifiers, statuses, and shapes.
 */

export type DelegationErrorCode =
  | 'delegation_validation_error'
  | 'delegation_not_found'
  | 'delegation_conflict';

export class DelegationError extends Error {
  readonly code: DelegationErrorCode;

  constructor(code: DelegationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DelegationError';
    this.code = code;
  }
}

export class DelegationValidationError extends DelegationError {
  readonly issues: readonly string[];

  constructor(message: string, options?: { cause?: unknown; issues?: readonly string[] }) {
    super('delegation_validation_error', message, options);
    this.name = 'DelegationValidationError';
    this.issues = options?.issues ?? [];
  }
}

export class DelegationNotFoundError extends DelegationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('delegation_not_found', message, options);
    this.name = 'DelegationNotFoundError';
  }
}

/** Illegal transition (e.g. completed -> running) or duplicate child chat. */
export class DelegationConflictError extends DelegationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('delegation_conflict', message, options);
    this.name = 'DelegationConflictError';
  }
}
