/**
 * Typed errors for the memory domain. Every error carries a stable machine
 * `code` so routes (API/web agents) can map them onto HTTP statuses without
 * string matching:
 *
 * - `memory_validation_error` -> 400 (bad input, malformed paths, invalid
 *   compactor summaries)
 * - `memory_not_found`        -> 404
 * - `memory_conflict`         -> 409 (cross-scope supersede, target already
 *   superseded, concurrent compaction conflicts)
 * - `memory_queue_error`      -> 502/500 (BullMQ enqueue failures; the caller
 *   should treat the operation as not scheduled and retry)
 * - `memory_compaction_error` -> 500 (compactor contract violations)
 * - `memory_embedding_error`  -> 500 (provider/model contract violations)
 *
 * Error messages never echo block content, embeddings, or provider request
 * bodies — only identifiers and shapes.
 */

export type MemoryErrorCode =
  | 'memory_validation_error'
  | 'memory_not_found'
  | 'memory_conflict'
  | 'memory_queue_error'
  | 'memory_compaction_error'
  | 'memory_embedding_error'
  | 'memory_configuration_error';

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MemoryError';
    this.code = code;
  }
}

export class MemoryValidationError extends MemoryError {
  readonly issues: readonly string[];

  constructor(message: string, options?: { cause?: unknown; issues?: readonly string[] }) {
    super('memory_validation_error', message, options);
    this.name = 'MemoryValidationError';
    this.issues = options?.issues ?? [];
  }
}

export class MemoryNotFoundError extends MemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('memory_not_found', message, options);
    this.name = 'MemoryNotFoundError';
  }
}

export class MemoryConflictError extends MemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('memory_conflict', message, options);
    this.name = 'MemoryConflictError';
  }
}

/** Raised when enqueueing an async job fails. Never claims the job was queued. */
export class MemoryQueueError extends MemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('memory_queue_error', message, options);
    this.name = 'MemoryQueueError';
  }
}

/** Raised when a compactor violates its contract (not-a-string, empty, >1000 chars). */
export class MemoryCompactionError extends MemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('memory_compaction_error', message, options);
    this.name = 'MemoryCompactionError';
  }
}

/** Raised when an embedding provider violates its contract (dims, model, non-finite values). */
export class MemoryEmbeddingError extends MemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('memory_embedding_error', message, options);
    this.name = 'MemoryEmbeddingError';
  }
}

/**
 * Raised when the store is misconfigured (e.g. the Postgres store needs
 * `options.databaseUrl` for its lock session). Messages never echo the
 * database URL.
 */
export class MemoryConfigurationError extends MemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('memory_configuration_error', message, options);
    this.name = 'MemoryConfigurationError';
  }
}
