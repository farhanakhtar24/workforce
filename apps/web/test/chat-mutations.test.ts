import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_BRANCH_CONFLICT,
  CHAT_BRANCH_ERROR,
  CHAT_BRANCH_NOT_FOUND,
  CHAT_DELETE_ACTIVE,
  CHAT_DELETE_ERROR,
  CHAT_DELETE_ERROR as DELETE_ERROR,
  CHAT_DELETE_NOT_FOUND,
  CHAT_DELETE_NOTE,
  CHAT_REWIND_ACTIVE,
  CHAT_REWIND_ERROR,
  CHAT_REWIND_NOT_FOUND,
  branchChat,
  branchChatEndpoint,
  branchDestinationHref,
  buildBranchBody,
  buildRewindBody,
  canTriggerChatMutations,
  deleteChat,
  deleteChatEndpoint,
  mapBranchResponse,
  mapDeleteChatResponse,
  mapRewindResponse,
  messagePreviewText,
  notifyChatsChanged,
  rewindChat,
  rewindChatEndpoint,
  rewindLocalSlice,
} from '../src/lib/chat-mutations.js';
import { SESSION_EXPIRED_ERROR } from '../src/lib/api.js';

const BASE = 'http://localhost:3001';
const CHAT = '52790846-b7b8-4520-8def-23aacf5a96f8';
const MSG = 'm-1';
const NEW_CHAT = 'b71b4125-c0cb-4282-a909-6eba686f0418';

type MutFetch = NonNullable<
  Parameters<typeof deleteChat>[0]['fetchImpl']
>;

interface RecordedCall {
  input: string;
  init?: { method?: 'DELETE' | 'POST'; cache?: 'no-store'; headers?: Record<string, string>; body?: string };
}

function jsonFetch(status: number, body: unknown): {
  calls: Array<RecordedCall>;
  impl: MutFetch;
} {
  const calls: Array<RecordedCall> = [];
  let impl: MutFetch = (async (
    input: string,
    init?: { method?: 'DELETE' | 'POST'; cache?: 'no-store'; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ) => {
    calls.push({ input, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as MutFetch;
  return { calls, impl };
}

test('endpoints: canonical agent-scoped paths with strict suffixes', () => {
  assert.equal(deleteChatEndpoint(BASE, 'orchestrator', CHAT), `${BASE}/api/agents/orchestrator/chat/${CHAT}`);
  assert.equal(branchChatEndpoint(BASE, 'analyst', CHAT), `${BASE}/api/agents/analyst/chat/${CHAT}/branch`);
  assert.equal(rewindChatEndpoint(BASE, 'general', CHAT), `${BASE}/api/agents/general/chat/${CHAT}/rewind`);
  // Unsafe chat ids/slugs never produce URLs.
  assert.equal(deleteChatEndpoint(BASE, 'hacker' as never, CHAT), null);
  assert.equal(deleteChatEndpoint(BASE, 'orchestrator', 'bad id'), null);
  assert.equal(deleteChatEndpoint('http://localhost:3001/', 'general', CHAT), `${BASE}/api/agents/general/chat/${CHAT}`);
});

test('bodies: strict JSON shapes validated before any fetch', () => {
  assert.deepEqual(buildBranchBody(MSG, NEW_CHAT), {
    ok: true,
    body: JSON.stringify({ messageId: MSG, newChatId: NEW_CHAT }),
  });
  assert.equal(buildBranchBody('bad id!', NEW_CHAT).ok, false);
  assert.equal(buildBranchBody('not/safe', NEW_CHAT).ok, false);
  assert.equal(buildBranchBody('', NEW_CHAT).ok, false);
  assert.ok(buildBranchBody('m-1', NEW_CHAT).ok);
  assert.deepEqual(buildRewindBody(MSG), { ok: true, body: JSON.stringify({ messageId: MSG }) });
  assert.equal(buildRewindBody('not/safe/').ok, false);
});

test('deleteChat: 200 {deleted:true} mapped; 404/409/500 map to fixed safe copy', async () => {
  const ok = jsonFetch(200, { deleted: true });
  const result = await deleteChat({ apiBaseUrl: BASE, slug: 'orchestrator', chatId: CHAT, fetchImpl: ok.impl });
  assert.deepEqual(result, { ok: true });
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0]?.init?.method, 'DELETE');
  assert.ok(String(ok.calls[0].input).includes(`/api/agents/orchestrator/chat/${CHAT}`));

  const notFound = jsonFetch(404, {});
  assert.deepEqual(await deleteChat({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, fetchImpl: notFound.impl }), {
    ok: false,
    status: 404,
    error: CHAT_DELETE_NOT_FOUND,
  });

  const active = jsonFetch(409, {});
  assert.deepEqual(await deleteChat({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, fetchImpl: active.impl }), {
    ok: false,
    status: 409,
    error: CHAT_DELETE_ACTIVE,
  });

  const serverError = jsonFetch(500, null);
  assert.deepEqual(await deleteChat({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, fetchImpl: serverError.impl }), {
    ok: false,
    status: 500,
    error: DELETE_ERROR,
  });
});

test('branchChat: strict body POSTed; 201 maps destination/copy count; conflicts fixed', async () => {
  const ok = jsonFetch(201, { branched: true, destinationChatId: NEW_CHAT, copiedMessages: 3 });
  const result = await branchChat({
    apiBaseUrl: BASE,
    slug: 'orchestrator',
    chatId: CHAT,
    messageId: MSG,
    newChatId: NEW_CHAT,
    fetchImpl: ok.impl,
  });
  assert.deepEqual(result, { ok: true, destinationChatId: NEW_CHAT, copiedMessages: 3 });
  assert.equal(ok.calls[0]?.init?.method, 'POST');
  assert.equal(ok.calls[0]?.init?.body, JSON.stringify({ messageId: MSG, newChatId: NEW_CHAT }));
  assert.ok(String(ok.calls[0].input).endsWith('/branch'));

  const conflict = jsonFetch(409, {});
  assert.deepEqual(
    await branchChat({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, messageId: MSG, newChatId: NEW_CHAT, fetchImpl: conflict.impl }),
    { ok: false, status: 409, error: CHAT_BRANCH_CONFLICT },
  );
  const notFound = jsonFetch(404, {});
  assert.deepEqual(
    await branchChat({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, messageId: MSG, newChatId: NEW_CHAT, fetchImpl: notFound.impl }),
    { ok: false, status: 404, error: CHAT_BRANCH_NOT_FOUND },
  );

  // Invalid ids never reach fetch.
  const notCalled = jsonFetch(200, {});
  assert.equal(
    (await branchChat({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, messageId: 'bad/', newChatId: NEW_CHAT, fetchImpl: notCalled.impl }))
      .ok,
    false,
  );
  assert.equal(notCalled.calls.length, 0);
});

test('rewindChat: 200 {rewound,kept,removed}; 409 active/stale + 404 fixed copy', async () => {
  const ok = jsonFetch(200, { rewound: true, kept: 4, removed: 2, hasActiveStream: false });
  const result = await rewindChat({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, messageId: MSG, fetchImpl: ok.impl });
  assert.deepEqual(result, { ok: true, kept: 4, removed: 2 });
  assert.equal(ok.calls[0]?.init?.method, 'POST');
  assert.equal(ok.calls[0].init.body, JSON.stringify({ messageId: MSG }));

  const active = jsonFetch(409, {});
  assert.deepEqual(await rewindChat({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, messageId: MSG, fetchImpl: active.impl }), {
    ok: false,
    status: 409,
    error: CHAT_REWIND_ACTIVE,
  });
  const notFound = jsonFetch(404, {});
  assert.deepEqual(await rewindChat({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, messageId: MSG, fetchImpl: notFound.impl }), {
    ok: false,
    status: 404,
    error: CHAT_REWIND_NOT_FOUND,
  });
});

test('session-authenticated requests: 401 maps to the fixed session-expired copy', async () => {
  const expired = jsonFetch(401, {});
  const result = await rewindChat({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, messageId: MSG, fetchImpl: expired.impl });
  assert.equal(result.ok, false);
  assert.equal(result.error, SESSION_EXPIRED_ERROR);
});

test('mappers reject malformed success payloads without leaking internals', () => {
  for (const payload of [null, 'x', {}, { deleted: 'yes' }, { deleted: 1 }, []]) {
    assert.equal(mapDeleteChatResponse(payload).ok, false);
  }
  assert.equal((mapDeleteChatResponse({ deleted: true }) as { ok: boolean }).ok, true);

  for (const payload of [
    null,
    {},
    { branched: true, destinationChatId: 'bad id', copiedMessages: 1 },
    { branched: true, destinationChatId: NEW_CHAT, copiedMessages: -1 },
    { branched: false, destinationChatId: NEW_CHAT, copiedMessages: 2 },
  ]) {
    assert.equal(mapBranchResponse(payload).ok, false);
  }

  for (const payload of [
    null,
    {},
    { rewound: true, kept: 1 },
    { rewound: true, kept: '2', removed: 1 },
    { rewound: true, kept: 1, removed: -2 },
  ]) {
    assert.equal(mapRewindResponse(payload).ok, false);
  }
});

test('destination href keeps the same agent + mode (plan clean, action explicit)', () => {
  assert.equal(
    branchDestinationHref(NEW_CHAT, 'orchestrator', 'plan'),
    `/agents/orchestrator/chat/${NEW_CHAT}`,
  );
  assert.equal(
    branchDestinationHref(NEW_CHAT, 'general', 'action'),
    `/agents/general/chat/${NEW_CHAT}?mode=action`,
  );
});

test('rewind local slice trims exactly to the server `kept` count', () => {
  const list = [1, 2, 3, 4, 5];
  assert.deepEqual(rewindLocalSlice(list, 4), [1, 2, 3, 4]);
  assert.deepEqual(rewindLocalSlice(list, 0), []);
  assert.deepEqual(rewindLocalSlice(list, 99), [1, 2, 3, 4, 5]);
  assert.deepEqual(rewindLocalSlice(list, -1), []);
  assert.deepEqual(rewindLocalSlice(list, Number.NaN), []);
  // Never mutates the source array (useChat state).
  assert.deepEqual(list, [1, 2, 3, 4, 5]);
});

test('mutation gating: busy or pending HITL disables branch/rewind', () => {
  assert.equal(canTriggerChatMutations({ busy: false, pendingAsk: false }), true);
  assert.equal(canTriggerChatMutations({ busy: true, pendingAsk: false }), false);
  assert.equal(canTriggerChatMutations({ busy: false, pendingAsk: true }), false);
  assert.equal(canTriggerChatMutations({ busy: true, pendingAsk: true }), false);
});

test('message preview: joins text parts, bounded, never stranding a surrogate', () => {
  assert.equal(
    messagePreviewText([null, { type: 'text', text: '  hello  ' }, { junk: 1 }, { type: 'text', text: 'world' }]),
    'hello world',
  );
  assert.equal(messagePreviewText([{ type: 'reasoning', text: 'not text' }]), '');
  const long = 'a'.repeat(205);
  const preview = messagePreviewText([{ type: 'text', text: long }]);
  assert.equal(preview.length, 200);
  assert.ok(preview.startsWith('a'.repeat(199)));
  assert.ok(preview.endsWith('…'));
  // Astral boundary: emoji 😀 (surrogate pair) at the cut retreats safely.
  const astral = 'x'.repeat(198) + '\u{1F600}';
  const astralPreview = messagePreviewText([{ type: 'text', text: astral + 'y'.repeat(20) }]);
  // The safe retreat drops the whole pair rather than stranding a surrogate.
  assert.ok(!/[\u{D800}-\u{DFFF}]/u.test(astralPreview));
  assert.ok(!astralPreview.includes('\u{1F600}'));
  assert.ok(astralPreview.endsWith('x'));
});

test('refresh event wiring: same namespaced value; notify no-ops outside a browser', () => {
  assert.equal(notifyChatsChanged(), undefined);
  // The constant is re-exported transitively via recent-chats usage.
  assert.equal(CHAT_DELETE_NOTE.includes('survive'), true);
  assert.equal(CHAT_DELETE_NOTE.indexOf('Artifacts'), 0);
  assert.notEqual(CHAT_REWIND_ERROR, CHAT_REWIND_ACTIVE);
  assert.notEqual(CHAT_BRANCH_ERROR, CHAT_BRANCH_CONFLICT);
  assert.notEqual(CHAT_BRANCH_CONFLICT, CHAT_BRANCH_NOT_FOUND);
});
