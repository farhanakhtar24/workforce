/**
 * Typed errors for the work-docs domain. Every error carries a stable machine
 * `code` so routes can map them onto HTTP statuses without string matching:
 *
 * - `work_doc_validation_error` -> 400 (bad input, bad bounds, malformed scope)
 * - `work_doc_not_found`        -> 404 (missing document, link target document,
 *                                  or historical version)
 * - `work_doc_conflict`         -> 409 (stale `expectedVersion` CAS mismatch)
 *
 * Error messages never echo document content — only identifiers, versions, and
 * shapes.
 */

export type WorkDocErrorCode =
  | 'work_doc_validation_error'
  | 'work_doc_not_found'
  | 'work_doc_conflict';

export class WorkDocError extends Error {
  readonly code: WorkDocErrorCode;

  constructor(code: WorkDocErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkDocError';
    this.code = code;
  }
}

export class WorkDocValidationError extends WorkDocError {
  readonly issues: readonly string[];

  constructor(message: string, options?: { cause?: unknown; issues?: readonly string[] }) {
    super('work_doc_validation_error', message, options);
    this.name = 'WorkDocValidationError';
    this.issues = options?.issues ?? [];
  }
}

export class WorkDocNotFoundError extends WorkDocError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('work_doc_not_found', message, options);
    this.name = 'WorkDocNotFoundError';
  }
}

/**
 * Raised when a write arrives with an `expectedVersion` that no longer matches
 * the document's current version (classic CAS), or when a uniqueness guard is
 * violated. One concurrent writer succeeds; stale writers get this error.
 */
export class WorkDocConflictError extends WorkDocError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('work_doc_conflict', message, options);
    this.name = 'WorkDocConflictError';
  }
}
