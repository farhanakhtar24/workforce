/**
 * Safe startup diagnostics: `startupFailureReason` (imported from the
 * side-effectful `server.ts` under its test env guard) and — where cheap —
 * the logging surfaces. Mocks only; no Redis, no Postgres, no provider, no
 * listen. Hostile inputs (dummy keys, URLs, bodies in messages) must never
 * leak into a reason.
 */
process.env['WORKFORCE_API_SKIP_LISTEN'] = '1';
const { startupFailureReason } = await import('../src/server.js');

import test from 'node:test';
import assert from 'node:assert/strict';

/** Error factory with settable code/name (Node system errors copy `code`). */
function errorLike(options: { message?: string; code?: string; name?: string }): Error {
  const error = new Error(options.message ?? 'hostile dummy-OLLAMA_KEY http://user:pass@host/db {"body":"x"} stack-ish');
  if (options.code !== undefined) {
    Object.defineProperty(error, 'code', { value: options.code, enumerable: true });
  }
  if (options.name !== undefined) {
    error.name = options.name;
  }
  return error;
}

test('missing OLLAMA_API_KEY maps to the exact fixed reason', () => {
  const reason = startupFailureReason(new Error('OLLAMA_API_KEY is required to start the API server.'));
  assert.equal(reason, 'OLLAMA_API_KEY is missing');
});

test('missing DATABASE_URL maps to the exact fixed reason', () => {
  const reason = startupFailureReason(new Error('DATABASE_URL is required to start the API server.'));
  assert.equal(reason, 'DATABASE_URL is missing');
});

test('Redis/Postgres connect timeouts map to fixed reasons', () => {
  assert.equal(startupFailureReason(new Error('Redis connect timeout')), 'Redis connection timed out');
  assert.equal(startupFailureReason(new Error('Redis publisher connect timeout')), 'Redis connection timed out');
  assert.equal(startupFailureReason(new Error('Redis subscriber connect timeout')), 'Redis connection timed out');
  assert.equal(startupFailureReason(new Error('Postgres connect timeout')), 'Postgres connection timed out');
});

test('allowlisted system codes surface exactly (code wins, message never leaks)', () => {
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'EADDRINUSE', 'ENOTFOUND', 'ECONNRESET']) {
    const error = errorLike({ code, message: `listen ${code} 127.0.0.1:3001 with dummy-key http://u:p@h` });
    assert.equal(startupFailureReason(error), code);
  }
});

test('allowlisted Prisma codes surface exactly with no message', () => {
  for (const code of ['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1009', 'P1010', 'P1011', 'P1012', 'P1017']) {
    const error = errorLike({ code, name: 'PrismaClientInitializationError', message: `P-code ${code} user:pass@127.0.0.1:55432` });
    assert.equal(startupFailureReason(error), code);
  }
  // Non-allowlisted Prisma-ish code falls to the safe name, not the message.
  const p1004 = errorLike({ code: 'P1004', name: 'PrismaClientInitializationError', message: 'secret body' });
  assert.equal(startupFailureReason(p1004), 'PrismaClientInitializationError');
});

test('hostile messages never appear in the reason: safe name only', () => {
  const secret = 'sk-not-a-real-key-123456';
  const error = errorLike({
    name: 'Error',
    message: `invalid apiKey ${secret} POST http://user:pass@host/chat {"messages":"body"}`,
  });
  const reason = startupFailureReason(error);
  assert.equal(reason, 'Error');
  assert.ok(!reason.includes(secret));
  assert.ok(!reason.includes('http'));
  assert.ok(!reason.includes('messages'));
  assert.ok(!reason.includes('user:pass'));
});

test('non-identifier error names map to unknown startup failure', () => {
  const error = errorLike({ name: 'Evil<script>alert(1)', message: 'hostile' });
  assert.equal(startupFailureReason(error), 'unknown startup failure');
  assert.equal(startupFailureReason('plain thrown string with dummy-key'), 'unknown startup failure');
  assert.equal(startupFailureReason(null), 'unknown startup failure');
});

test('invalid API configuration maps to generic fixed config text without echoing the message', () => {
  const reason = startupFailureReason(
    errorLike({
      name: 'Error',
      message: 'Invalid API configuration (values are never included): REDIS_URL: REDIS_URL must be a redis:// or rediss:// URL (default: redis://127.0.0.1:6379)',
    }),
  );
  assert.equal(reason, 'API configuration is invalid (check OLLAMA/REDIS/DATABASE settings)');
  assert.ok(!reason.includes('127.0.0.1'));
  assert.ok(!reason.includes('REDIS_URL:'));
});
