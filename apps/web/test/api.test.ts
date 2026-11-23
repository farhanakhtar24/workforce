import test from 'node:test';
import assert from 'node:assert/strict';
import type { UIMessage } from 'ai';
import {
  API_BASE_URL_DEFAULT,
  CHAT_ERROR_FALLBACK,
  buildReconnectRequest,
  buildSendRequest,
  describeChatError,
  fetchChatHydration,
  hydrationEndpoint,
  idempotencyKey,
  isSafeChatId,
  mapHydration,
  newestUserMessage,
  resolveApiBaseUrl,
  resumeStreamEndpoint,
  sendMessagesEndpoint,
  type FetchLike,
} from '../src/lib/api.js';

/**
 * Pure wire-contract tests for @workforce/web (no live API, no network).
 * The POST contract is pinned in apps/api/src/http/routes.ts + validation.ts:
 * body exactly `{ id, message }` with the newest user UIMessage, and
 * `Idempotency-Key` exactly `${chatId}:${message.id}` (400 on mismatch).
 */

function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

test('buildSendRequest: body is exactly { id, message } with only the newest user message', () => {
  const transcript = [
    userMessage('m-1', 'first'),
    assistantMessage('m-2', 'answer'),
    userMessage('m-3', 'newest'),
  ];
  const prepared = buildSendRequest({
    apiBaseUrl: 'http://localhost:3001',
    chatId: 'chat-abc',
    messages: transcript,
  });
  assert.deepEqual(prepared.body, {
    id: 'chat-abc',
    message: transcript[2], // newest user message only — no transcript
  });
  assert.deepEqual(Object.keys(prepared.body).sort(), ['id', 'message']);
  assert.equal(prepared.body.message.id, 'm-3');
});

test('buildSendRequest: Idempotency-Key header is exactly "{chatId}:{messageId}"', () => {
  const prepared = buildSendRequest({
    apiBaseUrl: 'http://localhost:3001',
    chatId: 'chat-abc',
    messages: [userMessage('m-7', 'hello')],
  });
  assert.equal(prepared.headers['Idempotency-Key'], 'chat-abc:m-7');
  assert.equal(prepared.headers['Idempotency-Key'], idempotencyKey('chat-abc', 'm-7'));
  assert.deepEqual(Object.keys(prepared.headers), ['Idempotency-Key']);
});

test('buildSendRequest: URL is the Express POST endpoint', () => {
  const prepared = buildSendRequest({
    apiBaseUrl: 'http://localhost:3001',
    chatId: 'chat-abc',
    messages: [userMessage('m-1', 'hi')],
  });
  assert.equal(prepared.url, 'http://localhost:3001/api/agents/general/chat');
});

test('buildSendRequest: throws a fixed error when no user message exists', () => {
  assert.throws(
    () =>
      buildSendRequest({
        apiBaseUrl: 'http://localhost:3001',
        chatId: 'chat-abc',
        messages: [assistantMessage('m-2', 'answer')],
      }),
    /A user message is required/,
  );
});

test('newestUserMessage: scans backwards past trailing assistant messages', () => {
  const transcript = [userMessage('m-1', 'a'), assistantMessage('m-2', 'b'), userMessage('m-3', 'c')];
  assert.equal(newestUserMessage(transcript)?.id, 'm-3');
  assert.equal(newestUserMessage([assistantMessage('m-2', 'b')]), null);
  assert.equal(newestUserMessage([]), null);
});

test('buildReconnectRequest: URL is the Express resume GET endpoint', () => {
  const prepared = buildReconnectRequest({
    apiBaseUrl: 'http://localhost:3001',
    chatId: 'chat-abc',
  });
  assert.deepEqual(prepared, {
    url: 'http://localhost:3001/api/agents/general/chat/chat-abc/stream',
  });
});

test('endpoint builders: use only the public base URL and a single general slug', () => {
  assert.equal(API_BASE_URL_DEFAULT, 'http://localhost:3001');
  assert.equal(sendMessagesEndpoint(API_BASE_URL_DEFAULT), 'http://localhost:3001/api/agents/general/chat');
  assert.equal(
    hydrationEndpoint(API_BASE_URL_DEFAULT, 'c_1'),
    'http://localhost:3001/api/agents/general/chat/c_1',
  );
  assert.equal(
    resumeStreamEndpoint(API_BASE_URL_DEFAULT, 'c_1'),
    'http://localhost:3001/api/agents/general/chat/c_1/stream',
  );
});

test('resolveApiBaseUrl: env value wins, default applies, trailing slashes trimmed', () => {
  assert.equal(resolveApiBaseUrl(undefined), API_BASE_URL_DEFAULT);
  assert.equal(resolveApiBaseUrl(''), API_BASE_URL_DEFAULT);
  assert.equal(resolveApiBaseUrl('  '), API_BASE_URL_DEFAULT);
  assert.equal(resolveApiBaseUrl('https://api.example.com/'), 'https://api.example.com');
  assert.equal(resolveApiBaseUrl('https://api.example.com///'), 'https://api.example.com');
});

test('isSafeChatId: mirrors the API id schema (1-64 chars of A-Za-z0-9_-)', () => {
  assert.equal(isSafeChatId('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true);
  assert.equal(isSafeChatId('chat_1'), true);
  assert.equal(isSafeChatId('a'.repeat(64)), true);
  assert.equal(isSafeChatId('a'.repeat(65)), false);
  assert.equal(isSafeChatId(''), false);
  assert.equal(isSafeChatId('bad/id'), false);
  assert.equal(isSafeChatId('bad id'), false);
  assert.equal(isSafeChatId('../../etc'), false);
});

const validHydrationBody = {
  messages: [{ id: 'm-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  hasActiveStream: false,
};

test('mapHydration: keeps valid { messages, hasActiveStream }', () => {
  const result = mapHydration(validHydrationBody);
  assert.deepEqual(result, {
    ok: true,
    hydration: { messages: validHydrationBody.messages as UIMessage[], hasActiveStream: false },
  });
  const active = mapHydration({ ...validHydrationBody, hasActiveStream: true });
  assert.equal(active.ok, true);
  if (active.ok) {
    assert.equal(active.hydration.hasActiveStream, true);
  }
  // A missing flag defaults to false, never truthy.
  const absent = mapHydration({ messages: validHydrationBody.messages });
  assert.equal(absent.ok, true);
  if (absent.ok) {
    assert.equal(absent.hydration.hasActiveStream, false);
  }
});

test('mapHydration: fixed safe error for malformed payloads (no internals leak)', () => {
  for (const raw of [null, undefined, 'x', 42, { messages: 'nope' }, { messages: [{}] }]) {
    const result = mapHydration(raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(typeof result.error, 'string');
      // Safe fixed message never echoes the payload back.
      assert.equal(result.error.includes(JSON.stringify(raw)), false);
    }
  }
  // An empty history is a valid hydration, not an error.
  assert.equal(mapHydration({ messages: [] }).ok, true);
});

test('fetchChatHydration: no-store GET, maps 200 bodies, safe error on non-OK', async () => {
  const seen: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    seen.push({ url: input, init });
    return { ok: true, json: async () => validHydrationBody };
  };

  const ok = await fetchChatHydration({
    apiBaseUrl: 'http://localhost:3001',
    chatId: 'chat-abc',
    fetchImpl,
  });
  assert.equal(seen[0]?.url, 'http://localhost:3001/api/agents/general/chat/chat-abc');
  assert.equal(seen[0]?.init?.cache, 'no-store');
  assert.equal(seen[0]?.init?.method, 'GET');
  assert.equal(ok.ok, true);

  const refused: FetchLike = async () => ({ ok: false, json: async () => 'SECRET_INTERNAL_TRACE' });
  const bad = await fetchChatHydration({
    apiBaseUrl: 'http://localhost:3001',
    chatId: 'chat-abc',
    fetchImpl: refused,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.error.includes('SECRET_INTERNAL_TRACE'), false);
});

test('fetchChatHydration: network failure and malformed JSON become safe fixed errors', async () => {
  const throwing: FetchLike = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const net = await fetchChatHydration({
    apiBaseUrl: 'http://localhost:3001',
    chatId: 'chat-abc',
    fetchImpl: throwing,
  });
  assert.equal(net.ok, false);
  assert.equal(net.ok === false && net.error.includes('ECONNREFUSED'), false);

  const garbage: FetchLike = async () => ({ ok: true, json: async () => Promise.reject(new Error('<html>oops</html>')) });
  const junk = await fetchChatHydration({
    apiBaseUrl: 'http://localhost:3001',
    chatId: 'chat-abc',
    fetchImpl: garbage,
  });
  assert.equal(junk.ok, false);
  assert.equal(junk.ok === false && junk.error.includes('<html>'), false);
});

test('describeChatError: API JSON error message is surfaced, everything else collapses', () => {
  assert.equal(
    describeChatError(new Error('{"error":"Chat state is temporarily unavailable."}')),
    'Chat state is temporarily unavailable.',
  );
  // Non-JSON transport/network failure → fixed fallback, no internals.
  assert.equal(describeChatError(new Error('Failed to fetch')), CHAT_ERROR_FALLBACK);
  assert.equal(describeChatError(new Error('<html>500</html>')), CHAT_ERROR_FALLBACK);
  assert.equal(describeChatError(undefined), CHAT_ERROR_FALLBACK);
  assert.equal(describeChatError(new Error('')), CHAT_ERROR_FALLBACK);
  // Empty or non-string error field → fallback.
  assert.equal(describeChatError(new Error('{"error":""}')), CHAT_ERROR_FALLBACK);
  assert.equal(describeChatError(new Error('{"error":42}')), CHAT_ERROR_FALLBACK);
});
