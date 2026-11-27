/**
 * Observability (pre-Phase 6) tests: pino-backed structured logging,
 * request correlation ids, and hostile-input safety.
 *
 * - Every SafeLogger line is parseable JSON with the fixed allowlist shape
 *   (`{ level, msg:<context>, errorType? }` + optional `requestId`).
 * - Correlation: incoming `x-request-id` accepted ONLY when bounded
 *   (`1..128` of `[A-Za-z0-9._-]`); malformed/missing → generated UUID; the
 *   SAME id is echoed in the response header and the request-completion log.
 *   Observability only (never auth/ownership/idempotency).
 * - Hostile sentinels in headers/query/body never reach output; the
 *   completion line carries method + bounded route template + status +
 *   durationMs + requestId, never raw URLs/query strings.
 * - Malformed LOG_LEVEL fails config validation with a safe fixed message
 *   (value never echoed); default documented: info.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockModel, textStep, startTestApp, postChat, userMessage } from './helpers.js';
import { safeRequestId, consoleLogger, createSafeLogger, withRequestLogContext, type SafeLogger } from '../src/logging.js';
import { loadApiConfig } from '../src/config.js';

type JsonLine = Record<string, unknown>;

/** Parses log lines; tolerates multiline noise by keeping only `{`-lines. */
function readJsonLines(lines: ReadonlyArray<string>): JsonLine[] {
  return lines
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as JsonLine);
}

function memoryLogger(): { logger: SafeLogger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    // debug level so ALL allowlisted levels are exercised.
    logger: createSafeLogger('debug', (line) => lines.push(line)),
  };
}

/** Strips non-contract fields (pino `time`) for shape assertions. */
function stripTime(lines: ReadonlyArray<JsonLine>): Array<Record<string, unknown>> {
  return lines.map((line) => {
    const { time: _time, ...rest } = line;
    return rest;
  });
}

test('logging: every line is JSON with the fixed safe shape; hostile error text NEVER emitted', async () => {
  const { logger, lines } = memoryLogger();
  logger.error('chat-stream-broke', new TypeError('hostile stack fake-SECRET http://user:pass@host/db'));
  logger.warn('delegation-context-secret-ephemeral');
  logger.error('plain-context-no-error');
  logger.debug?.('personal-capture done');
  const parsed = stripTime(readJsonLines(lines));
  assert.deepEqual(
    parsed,
    [
      { level: 'error', msg: 'chat-stream-broke', errorType: 'TypeError' },
      { level: 'warn', msg: 'delegation-context-secret-ephemeral' },
      { level: 'error', msg: 'plain-context-no-error' },
      { level: 'debug', msg: 'personal-capture done' },
    ],
    'messages/stacks/hosts never reach output; `msg` carries the fixed context',
  );
  // JSON parseability of the literal production format too (consoleLogger).
  const productionLines: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    productionLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    consoleLogger.error('provider-failure', new Error('{"apiKey":"SHOULD_NOT_LEAK"}'));
  } finally {
    process.stdout.write = original;
  }
  const combined = productionLines.join('');
  assert.equal(combined.includes('SHOULD_NOT_LEAK'), false);
  const line = productionLines.filter((entry) => entry.includes('provider-failure')).pop() ?? '';
  if (line.trim().length === 0) {
    assert.fail('the production logger line was never emitted');
  }
  const parsedLine = JSON.parse(line) as { level?: unknown; msg?: unknown; errorType?: unknown };
  assert.equal(parsedLine['level'], 'error');
  assert.equal(parsedLine['msg'], 'provider-failure');
  assert.equal(parsedLine['errorType'], 'Error');
  assert.equal('apiKey' in parsedLine, false);
});

test('correlation: safeRequestId accepts bounded ids; hostile/missing replaced with UUID', () => {
  assert.equal(safeRequestId('abc-123.4_X'), 'abc-123.4_X');
  assert.equal(safeRequestId('a'.repeat(128)), 'a'.repeat(128));
  const generated = safeRequestId('bad/slash');
  assert.match(generated, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(safeRequestId(''), generated);
  assert.notEqual(safeRequestId('x'.repeat(129)), 'x'.repeat(129));
  assert.match(safeRequestId(['a', 'b']), /^[0-9a-f-]{36}$/, 'arrays (repeated headers) replaced safely');
  assert.notEqual(safeRequestId(['a', 'b']), safeRequestId(['a', 'b']));
});

test('request boundary: accepted id echoed as response header; hostile/missing replaced', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const accepted = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/given-id`, {
      headers: { 'x-request-id': 'trace-me-4.correlation_ok' },
    });
    assert.equal(accepted.headers.get('x-request-id'), 'trace-me-4.correlation_ok');
    for (const hostile of ['bad/slash', 'x'.repeat(129), '']) {
      const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/x-id`, {
        headers: { 'x-request-id': hostile },
      });
      const echoed = response.headers.get('x-request-id');
      assert.ok(echoed !== null && echoed !== hostile);
      assert.match(echoed ?? '', /^[A-Za-z0-9._-]+$/);
    }
    const without = await fetch(`http://127.0.0.1:${app.port}/api/chats`);
    assert.match(without.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  } finally {
    await app.close();
  }
});

test('request completion log: JSON line with method + route template + status + durationMs + requestId; NO query/body', async () => {
  const appLogLines: string[] = [];
  const boundLogger: SafeLogger = createSafeLogger('debug', (line) => appLogLines.push(line));
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }), logger: boundLogger });
  try {
    const response = await fetch(
      `http://127.0.0.1:${app.port}/api/chats?limit=2&hostile=SECRET_Q`,
      { headers: { 'x-request-id': 'req-boundary-2' } },
    );
    assert.equal(response.status, 200);
  } finally {
    await app.close();
  }
  const all = appLogLines.join('\n');
  assert.equal(all.includes('SECRET_Q'), false, 'query string never logged');
  const parsed = readJsonLines(appLogLines);
  const completion = parsed.find(
    (line) => typeof line['msg'] === 'string' && String(line['msg']).startsWith('http-request GET /api/chats'),
  ) as JsonLine | undefined;
  assert.ok(completion !== undefined);
  assert.equal(completion['level'], 'debug');
  assert.match(String(completion['msg']), /^http-request GET \/api\/chats 200 \d+ms req-boundary-2$/);
  assert.equal(completion['requestId'], 'req-boundary-2');
});

test('POST completion: bounded route template; message body never logged', async () => {
  const capture = memoryLogger();
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }), logger: capture.logger });
  try {
    const response = await postChat({
      port: app.port,
      body: { id: 'cor-1', message: userMessage('hostile SENTINEL_BODY text', 'm1') },
    });
    assert.equal(response.status, 200);
    await app.background.waitForAll(2_000);
  } finally {
    await app.close();
  }
  const all = capture.lines.join('\n');
  assert.equal(all.includes('SENTINEL_BODY'), false, 'message body never logged');
  const parsed = stripTime(readJsonLines(capture.lines));
  const completion = parsed.find(
    (line) => typeof line['msg'] === 'string' && String(line['msg']).startsWith('http-request POST /api/agents/:slug/chat'),
  ) as JsonLine | undefined;
  assert.ok(completion !== undefined, JSON.stringify(parsed.map((line) => line['msg'])));
  assert.equal(completion['level'], 'debug');
});

test('config: malformed LOG_LEVEL → safe config error (value never echoed); default info', () => {
  try {
    loadApiConfig({ ...baseConfigValues(), LOG_LEVEL: 'LOUD;' });
    assert.fail('expected throw');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /LOG_LEVEL/);
    assert.equal(error.message.includes('LOUD;'), false);
  }
  assert.equal(loadApiConfig({ ...baseConfigValues(), LOG_LEVEL: 'debug' }).logLevel, 'debug');
  assert.equal(loadApiConfig(baseConfigValues()).logLevel, 'info');
  // Compose passes LOG_LEVEL: ${LOG_LEVEL:-} → an UNSET level arrives as an
  // empty string; blank = absent = the default (info). A nonzero value is
  // still validated by the enum (malformed case asserted above).
  assert.equal(loadApiConfig({ ...baseConfigValues(), LOG_LEVEL: '' }).logLevel, 'info');
});

test('withRequestLogContext is generic: return values pass through, context spans awaits', async () => {
  const lines: string[] = [];
  const logger = createSafeLogger('info', (line) => lines.push(line));
  const value = await withRequestLogContext('correlation-generic-1', async () => {
    logger.warn('inside-async-step');
    return 42;
  });
  assert.equal(value, 42);
  const parsed = readJsonLines(lines);
  assert.ok(parsed.length >= 1);
  assert.ok(parsed.every((entry) => entry['requestId'] === 'correlation-generic-1'));

  // Outside any context: NO requestId field at all (unchanged behavior).
  const outside: string[] = [];
  createSafeLogger('info', (line) => outside.push(line)).warn('outside-context');
  const outsideParsed = readJsonLines(outside);
  assert.equal(outsideParsed.length, 1);
  assert.equal('requestId' in outsideParsed[0]!, false);
});

function baseConfigValues(): Record<string, string> {
  return {
    OLLAMA_API_KEY: 'test-key-not-real',
    OLLAMA_BASE_URL: 'https://ollama.invalid/v1',
    OLLAMA_MODEL: 'glm-5.3-flash',
    REDIS_URL: 'redis://127.0.0.1:6379',
    PORT: '3001',
    WEB_ORIGIN: 'http://localhost:3000',
  };
}
