/**
 * Production-safe structured logging (pre-Phase 6): pino JSON under the
 * EXISTING SafeLogger allowlist contract.
 *
 * Hard rules (unchanged):
 * - Error logs carry ONLY `{ level, context, errorType }` — never
 *   `error.message`/stacks (provider bodies, URLs, credentials live there).
 * - Warn/debug carry the fixed context string only.
 * - Chat/memory/tool content, provider payloads, and any secret never reach
 *   a logger argument at all.
 *
 * Request correlation: a per-request `requestId` is bound through
 * `AsyncLocalStorage`, so EVERY SafeLogger call made inside a tracked
 * request emits `requestId` without any call-site refactor. Ids satisfy
 * `1..128` of `[A-Za-z0-9._-]`; anything else is replaced with
 * `randomUUID()`. Correlation is observability only — never auth/ownership.
 *
 * `consoleLogger` remains the exported instance (all existing wiring keeps
 * compiling and behaving identically; the transport underneath is pino).
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';

export type SafeLogger = {
  error(context: string, error?: unknown): void;
  warn(context: string): void;
  /** Optional: budget/capture debug contexts (fixed strings, bounded ids). */
  debug?(message: string): void;
};

/** Allowlisted pino levels for the optional LOG_LEVEL. */
const ALLOWED_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type SafeLogLevel = (typeof ALLOWED_LOG_LEVELS)[number];

const REQUEST_ID_HEADER = 'x-request-id';
/** 1..128 chars of `A-Za-z0-9._-` (never trusted for auth/idempotency). */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Per-request correlation context (requestId only; bounded value). */
const requestLogContext = new AsyncLocalStorage<{ requestId: string }>();

function errorType(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'Error' ? 'Error' : error.name;
  }
  return typeof error;
}

/**
 * Accepts an incoming request id ONLY when it passes the bounded safe
 * pattern; otherwise (missing, empty, oversized, hostile characters) a
 * `randomUUID()` is minted. Never trusted for auth/ownership/idempotency.
 */
export function safeRequestId(rawHeaderValue: unknown): string {
  if (typeof rawHeaderValue === 'string') {
    // Repeated headers surface as an array — only single bounded values pass.
    if (REQUEST_ID_PATTERN.test(rawHeaderValue)) {
      return rawHeaderValue;
    }
  }
  return randomUUID();
}

/** The correlation id for the CURRENT async context (loopback propagation). */
export function currentRequestId(): string | undefined {
  return requestLogContext.getStore()?.requestId;
}

/**
 * The header (name + value) to attach to INTERNAL same-REST loopback calls
 * made inside the current request context — the API's own correlation id
 * round-trips through its own routes. NEVER used for auth/ownership.
 */
export function requestContextHeader(): Record<string, string> {
  const requestId = requestLogContext.getStore()?.requestId;
  return requestId === undefined ? {} : { 'x-request-id': requestId };
}

/**
 * Builds the configured root pino logger. `level` MUST already be
 * allowlisted (config validation rejects malformed values before this).
 * The optional sink receives every serialized JSON line (production uses
 * stdout; tests capture); pino's own fields are the transport's, the
 * application fields stay the safe allowlist contract.
 */
export function createSafeLogger(level: SafeLogLevel = 'info', sink?: (line: string) => void): SafeLogger {
  if (sink !== undefined) {
    const testLogger = pino(
      { level, base: undefined, formatters: { level: (label) => ({ level: label }) } },
      { write(line: string): void { sink(line); } } as never,
    );
    return adaptPino(testLogger);
  }
  // Production sink: dynamic process.stdout.write (keeps fd semantics in the
  // container while remaining test-swappable).
  const stdoutSink = { write(line: string): boolean { return process.stdout.write(line); } };
  const adapted = pino({ level, base: undefined, formatters: { level: (label) => ({ level: label }) } }, stdoutSink as never);
  return adaptPino(adapted);
}

function adaptPino(root: pino.Logger): SafeLogger {
  const emit = (levelName: 'error' | 'warn' | 'debug', context: string, error?: unknown): void => {
    const requestId = requestLogContext.getStore()?.requestId;
    const errorShape = levelName === 'error' && error !== undefined ? { errorType: errorType(error) } : {};
    const bindings = {
      ...(requestId !== undefined ? { requestId } : {}),
      ...errorShape,
    };
    // context = pino `msg` (the FIXED safe string); error.message never emitted.
    root[levelName](bindings, context);
  };
  return {
    error(context: string, error?: unknown): void {
      emit('error', context, error);
    },
    warn(context: string): void {
      emit('warn', context);
    },
    debug(message: string): void {
      emit('debug', message);
    },
  };
}

/** The default instance (info level) used by every existing call site. */
export const consoleLogger: SafeLogger = createSafeLogger('info');

/** Request wrapper: runs `next` inside the request correlation context.
 *  Generic: the callback's return value (including promises) passes through
 *  while the context propagates across awaits. */
export function withRequestLogContext<T>(requestId: string, next: () => T): T {
  return requestLogContext.run({ requestId }, next);
}
