import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chatRequestSchema,
  idempotencyKeySchema,
  clientIdSchema,
  isKnownSlug,
} from '../src/validation.js';

/**
 * These are the raw wire schemas (unit level). Route-level behavior is covered
 * by the app tests; here we pin every rejection rule the Phase 2 spec lists.
 */

const validBody = {
  id: 'chat-1',
  message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
};

test('chat body: accepts exactly { id, message }', () => {
  assert.equal(chatRequestSchema.safeParse(validBody).success, true);
});

test('chat body: rejects additional wrapper keys', () => {
  const result = chatRequestSchema.safeParse({ ...validBody, extra: true });
  assert.equal(result.success, false);
});

test('chat body: rejects wrong role', () => {
  const result = chatRequestSchema.safeParse({
    ...validBody,
    message: { ...validBody.message, role: 'assistant' },
  });
  assert.equal(result.success, false);
});

test('chat body: rejects empty parts', () => {
  const result = chatRequestSchema.safeParse({
    ...validBody,
    message: { ...validBody.message, parts: [] },
  });
  assert.equal(result.success, false);
});

test('chat body: rejects missing or wrong-typed ids', () => {
  assert.equal(chatRequestSchema.safeParse({ ...validBody, id: 3 }).success, false);
  assert.equal(
    chatRequestSchema.safeParse({ ...validBody, message: { ...validBody.message, id: '' } }).success,
    false,
  );
});

test('ids: bounded to 64 chars and restricted alphabet', () => {
  assert.equal(clientIdSchema.safeParse('a'.repeat(64)).success, true);
  assert.equal(clientIdSchema.safeParse('a'.repeat(65)).success, false);
  assert.equal(clientIdSchema.safeParse('x/../../etc').success, false);
  assert.equal(clientIdSchema.safeParse('has space').success, false);
  assert.equal(clientIdSchema.safeParse('ok_id-2').success, true);
});

test('idempotency key: requires chatId:messageId shape with bounded length', () => {
  assert.equal(idempotencyKeySchema.safeParse('chat-1:msg-1').success, true);
  assert.equal(idempotencyKeySchema.safeParse('chat.dot-1:msg_2').success, true);
  assert.equal(idempotencyKeySchema.safeParse('nocolon').success, false);
  assert.equal(idempotencyKeySchema.safeParse(':noid').success, false);
  assert.equal(idempotencyKeySchema.safeParse('chat:').success, false);
  // Full string is bounded to 128 chars.
  const atLimit = `${'a'.repeat(64)}:${'b'.repeat(63)}`; // 128 chars
  assert.equal(idempotencyKeySchema.safeParse(atLimit).success, true);
  assert.equal(idempotencyKeySchema.safeParse(`${atLimit}x`).success, false);
});

test('slug gate: only general exists in Phase 2', () => {
  assert.equal(isKnownSlug('general'), true);
  assert.equal(isKnownSlug('admin'), false);
  assert.equal(isKnownSlug(''), false);
});
