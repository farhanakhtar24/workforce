/**
 * Safe error response handling. Provider response bodies, stack traces, and
 * secrets never leave this process in an HTTP response.
 *
 * Every client-facing error message is a fixed safe string; the cause is
 * logged once with safe fields (see `logging.ts`), never serialized.
 */

/**
 * Thrown by stores when the backing storage (Redis) is unreachable or fails.
 * Routes map this to 503 per ADR-005: without Redis, exactly-once and resume
 * guarantees would be silently broken, so chat/hydration/resume say so.
 */
export class StoreUnavailableError extends Error {
  readonly status = 503;
  constructor(message = 'Chat storage is temporarily unavailable.') {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}

/** Fixed safe message for any unexpected failure. */
export const INTERNAL_ERROR_MESSAGE = 'Internal server error.';

/**
 * Maps an unknown error thrown in a route to a safe client-facing message and
 * HTTP status. Never inspects provider errors for message content.
 */
export function safeErrorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof StoreUnavailableError) {
    return { status: error.status, message: error.message };
  }
  return { status: 500, message: INTERNAL_ERROR_MESSAGE };
}
