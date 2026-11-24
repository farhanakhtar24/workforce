/**
 * Package-local safe logger contract (shape-compatible with the API layer's
 * `SafeLogger` — `{ error(context, error), warn(context) }` — so hosts can
 * pass their existing logger structurally).
 *
 * Implementations MUST only ever print the hand-written `context` string and
 * the error's TYPE (`error.constructor.name`): queue this package talks to may
 * carry provider payloads, task prompts, and Redis URLs, none of which may
 * reach a log line. Callers in this package keep messages to fixed words plus
 * at most a BullMQ job id.
 */
export interface SchedulerLogger {
  error(context: string, error: unknown): void;
  warn(context: string): void;
}
