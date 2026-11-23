/**
 * Minimal logging with hard rules (Phase 2 contract):
 * - Never log API keys (the key never reaches a logger argument at all).
 * - Never log message contents (chat text is user data).
 * - Never dump provider response bodies or stack traces to the client.
 *
 * Callers pass short, hand-written context strings only, e.g. `logError('chat-stream', error)`
 * and this module prints `{ context, errorType }` — never `error.message`, which may embed
 * provider bodies.
 */
export type SafeLogger = {
  error(context: string, error: unknown): void;
  warn(context: string): void;
};

function errorType(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'Error' ? 'Error' : error.name;
  }
  return typeof error;
}

export const consoleLogger: SafeLogger = {
  error(context, error) {
    console.error(JSON.stringify({ level: 'error', context, errorType: errorType(error) }));
  },
  warn(context) {
    console.warn(JSON.stringify({ level: 'warn', context }));
  },
};
