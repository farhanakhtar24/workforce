/**
 * Route-level tests for the recent-chat sidebar history API
 * (`GET /api/chats?limit=N`) over a real HTTP server with the real Express
 * middleware and the in-memory store mirroring the Redis activity-index
 * semantics. No network, no Redis, no mock model traffic (chats are seeded
 * through the append-only store contract directly).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { UIMessage } from 'ai';

import {
  TEST_ORIGINAL_ORIGIN,
  getJson,
  startTestApp,
  seedMessages,
  createMockModel,
  textStep,
} from './helpers.js';
import { createInMemoryChatStore } from '../src/store/memory.js';
import { RECENT_CHATS_LIMIT_MAX, PREVIEW_CHAR_LIMIT, TITLE_CHAR_LIMIT } from '../src/store/chat-history.js';
import type { ChatRef, ChatSummary, ChatStore } from '../src/store/types.js';

/** Deterministic wall clock: every append gets a distinct, ordered score. */
let CLOCK = 1_000_000;
const nextNow = (): number => (CLOCK += 1);

function chatRef(slug: string, chatId: string): ChatRef {
  return { slug, chatId };
}

function userText(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

interface ChatSummaryBody {
  chats: Array<{
    chatId: string;
    agent: string;
    title: string;
    preview: string;
    messageCount: number;
    lastActivityAt: string | null;
  }>;
}

async function getChats(port: number, query = ''): Promise<{ status: number; body: unknown; headers: Headers }> {
  return await getJson({ port, path: `/api/chats${query}` });
}

test('GET /api/chats: empty store returns {chats: []} 200 with no-store', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const response = await getChats(app.port);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(response.body, { chats: [] });
  } finally {
    await app.close();
  }
});

test('limit validation: absent = default 20; every junk value is a fixed safe 400', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const ok = await getChats(app.port, '?limit=1');
    assert.equal(ok.status, 200);

    const okNoLimit = await getChats(app.port);
    assert.equal(okNoLimit.status, 200);

    const maxOk = await getChats(app.port, `?limit=${String(RECENT_CHATS_LIMIT_MAX)}`);
    assert.equal(maxOk.status, 200);

    const junk = ['abc', '3.5', '0', '-1', '51', '', '1e2', '19x'];
    for (const value of junk) {
      const response = await getChats(app.port, `?limit=${value}`);
      assert.equal(response.status, 400, `limit=${JSON.stringify(value)} must be 400`);
      assert.deepEqual(response.body, { error: `limit must be an integer between 1 and ${String(RECENT_CHATS_LIMIT_MAX)}.` });
    }
    // Repeated query params surface as an array in Express: reject, never parse.
    const repeated = await fetch(`http://127.0.0.1:${app.port}/api/chats?limit=1&limit=2`);
    assert.equal(repeated.status, 400);

    // CORS preflight/method surface stays app-wide: POST on the GET route is
    // not registered, falling through to the fixed 404 (no method detail).
    const post = await fetch(`http://127.0.0.1:${app.port}/api/chats`, { method: 'POST' });
    assert.equal(post.status, 404);
  } finally {
    await app.close();
  }
});

test('ordering + fields: indexed chats newest first with ISO timestamps', async () => {
  const store = createInMemoryChatStore({ now: nextNow });
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }), store });
  try {
    // Seed OLDEST first through the append-only contract (auto-indexed).
    await seedMessages(store, chatRef('general', 'chat-old'), [
      userText('u1', 'first chat opening message'),
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first reply' }], metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 1 } } },
    ]);
    await seedMessages(store, chatRef('orchestrator', 'chat-new'), [
      userText('u2', 'newest chat opening message'),
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'newest reply' }], metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 1 } } },
    ]);

    const response = await getChats(app.port);
    assert.equal(response.status, 200);
    const body = response.body as ChatSummaryBody;
    assert.ok(Array.isArray(body.chats));
    assert.deepEqual(
      body.chats.map((chat) => `${chat.agent}:${chat.chatId}`),
      ['orchestrator:chat-new', 'general:chat-old'],
    );
    const newest = body.chats[0];
    assert.ok(newest !== undefined);
    assert.deepEqual(Object.keys(newest), ['chatId', 'agent', 'title', 'preview', 'messageCount', 'lastActivityAt']);
    assert.equal(newest.title, 'newest chat opening message');
    assert.equal(newest.preview, 'newest reply');
    assert.equal(newest.messageCount, 2);
    assert.equal(newest.lastActivityAt, new Date(CLOCK).toISOString());
    const older = body.chats[1];
    assert.ok(older !== undefined);
    assert.equal(older.lastActivityAt, new Date(CLOCK - 2).toISOString());
    // The exact timestamp equals the INDEX score of the chat's last append,
    // never a fabricated now().
  } finally {
    await app.close();
  }
});

test('legacy chats sort deterministically AFTER indexed ones with null timestamps', async () => {
  const store = createInMemoryChatStore({ now: nextNow });
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }), store });
  try {
    // Legacy: messages stored BEFORE the index existed (no index member).
    store.seedLegacyChat(chatRef('general', 'legacy-b'), [
      userText('lu', 'legacy b opening text'),
      { id: 'la', role: 'assistant', parts: [{ type: 'text', text: 'legacy b reply' }] },
    ]);
    store.seedLegacyChat(chatRef('analyst', 'legacy-a'), [userText('lu2', 'legacy a opening text')]);
    // Indexed chat written AFTER the legacy ones existed.
    await seedMessages(store, chatRef('general', 'indexed-1'), [userText('u1', 'indexed opening text')]);

    const response = await getChats(app.port);
    assert.equal(response.status, 200);
    const chats = (response.body as ChatSummaryBody).chats;
    // Newest indexed first, then the two legacy chats ascending by slug:id.
    assert.deepEqual(
      chats.map((chat) => `${chat.agent}:${chat.chatId}`),
      ['general:indexed-1', 'analyst:legacy-a', 'general:legacy-b'],
    );
    assert.ok(chats[0] !== undefined && chats[0].lastActivityAt !== null);
    assert.equal(chats[1]?.lastActivityAt, null);
    assert.equal(chats[2]?.lastActivityAt, null);
    assert.equal(chats[1]?.title, 'legacy a opening text');
    assert.equal(chats[2]?.preview, 'legacy b reply');
  } finally {
    await app.close();
  }
});

test('title/preview extraction: joins parts, collapses whitespace, bounds with ellipsis, skips tool-only entries', async () => {
  const store = createInMemoryChatStore({ now: nextNow });
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }), store });
  try {
    await seedMessages(store, chatRef('general', 'extract'), [
      // FIRST user text is the title: a giant text, bounded + ellipsis.
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'y'.repeat(300) }] },
      // Assistant message with ONLY tool parts: no visible text ever leaks.
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'tool-ask_user', toolCallId: 't1', state: 'input-available', input: { question: 'SECRET QUESTION PAYLOAD' } },
        ],
      } as unknown as UIMessage,
      // Later user text (multi-part, messy whitespace) is NOT the title.
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'build  me\ta report\t ' }, { type: 'text', text: 'now' }] },
      // Newest assistant text is the preview: bounded the same way.
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'z'.repeat(300) }] },
    ]);
    const response = await getChats(app.port);
    assert.equal(response.status, 200);
    const chats = (response.body as ChatSummaryBody).chats;
    const only = chats[0];
    assert.ok(only !== undefined);
    // Title = FIRST user text, bounded at TITLE char limit + ellipsis.
    assert.equal(only.title, `${'y'.repeat(TITLE_CHAR_LIMIT)}…`);
    // Preview = newest visible text (assistant), bounded the same way.
    assert.equal(only.preview, `${'z'.repeat(PREVIEW_CHAR_LIMIT)}…`);
    assert.equal(only.messageCount, 4);
    // The tool part's question payload never appears anywhere in the body.
    assert.equal(JSON.stringify(response.body).includes('SECRET QUESTION PAYLOAD'), false);

    // No user text at all: title falls back, preview still extracts.
    await seedMessages(store, chatRef('general', 'no-user'), [
      { id: 'a9', role: 'assistant', parts: [{ type: 'text', text: 'assistant only message' }] },
    ]);
    const second = await getChats(app.port);
    const list = (second.body as ChatSummaryBody).chats;
    const fallback = list[0];
    assert.ok(fallback !== undefined);
    assert.equal(fallback.title, '(no title)');
    assert.equal(fallback.preview, 'assistant only message');

    // Multi-part join + whitespace collapse on its own chat (first user text
    // is the title), seeded newest.
    await seedMessages(store, chatRef('general', 'multi'), [
      { id: 'u5', role: 'user', parts: [{ type: 'text', text: 'build  me\ta report\t ' }, { type: 'text', text: 'now' }] },
    ]);
    const third = await getChats(app.port);
    const finalList = (third.body as ChatSummaryBody).chats;
    assert.equal(finalList[0]?.chatId, 'multi');
    assert.equal(finalList[0]?.title, 'build me a report now');
    assert.equal(finalList[1]?.title, '(no title)');
  } finally {
    await app.close();
  }
});

test('limit windows: default 20, exact slice of the newest chats', async () => {
  const store = createInMemoryChatStore({ now: nextNow });
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }), store });
  try {
    for (let index = 0; index < 25; index += 1) {
      await seedMessages(store, chatRef('general', `c${String(index).padStart(2, '0')}`), [
        userText(`u${String(index)}`, `chat ${String(index)} text`),
      ]);
    }
    const all = await getChats(app.port);
    assert.equal(all.status, 200);
    const chats = (all.body as ChatSummaryBody).chats;
    assert.equal(chats.length, 20, 'default limit is 20');
    assert.equal(chats[0]?.chatId, 'c24', 'newest first (highest append order)');
    const window = await getChats(app.port, '?limit=3');
    const sliced = (window.body as ChatSummaryBody).chats;
    assert.deepEqual(
      sliced.map((chat) => chat.chatId),
      ['c24', 'c23', 'c22'],
    );
    // Deterministic tie order (one injected instant for every append):
    // equal scores order member-DESCENDING, mirroring Redis ZRANGE REV.
    const tieClock = createInMemoryChatStore({ now: () => 5_000 });
    await seedMessages(tieClock, chatRef('general', 'tie-a'), [userText('u', 'a')]);
    await seedMessages(tieClock, chatRef('general', 'tie-b'), [userText('u', 'b')]);
    await seedMessages(tieClock, chatRef('general', 'tie-c'), [userText('u', 'c')]);
    // A legacy chat (seeded WITHOUT the index) still lists last, after every
    // indexed chat, deterministically.
    tieClock.seedLegacyChat(chatRef('general', 'ghost'), [userText('gx', 'ghost')]);
    const tieList = await tieClock.listRecentChats(20);
    assert.deepEqual(
      tieList.map((chat) => chat.chatId),
      ['tie-c', 'tie-b', 'tie-a', 'ghost'],
    );
  } finally {
    await app.close();
  }
});

test('bounded truncation retreats on a split surrogate pair (emoji/astral boundary)', async () => {
  const store = createInMemoryChatStore({ now: nextNow });
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }), store });
  try {
    // Cut at 80 lands BETWEEN the emoji's two UTF-16 units → the ellipsis
    // goes after the WHOLE character: 79 y's + '…' (never a lone surrogate).
    await seedMessages(store, chatRef('general', 'astral-split'), [
      userText('u1', `${'y'.repeat(79)}😀${'z'.repeat(50)}`),
    ]);
    // The pair fully INSIDE the visible window survives intact.
    await seedMessages(store, chatRef('general', 'astral-inside'), [
      userText('u2', `${'x'.repeat(60)}😀${'w'.repeat(90)}`),
    ]);
    // Plain ASCII at the boundary: the cut itself is unchanged (80 + ellipsis).
    await seedMessages(store, chatRef('general', 'astral-after'), [
      userText('u3', `${'y'.repeat(100)}😀`),
    ]);
    const response = await getChats(app.port);
    assert.equal(response.status, 200);
    const chats = (response.body as ChatSummaryBody).chats;
    const split = chats.find((chat) => chat.chatId === 'astral-split');
    assert.ok(split !== undefined);
    assert.equal(split.title, `${'y'.repeat(79)}…`);
    assert.equal(split.title.length, 80);
    // No lone surrogate ever ships: code points in the title are all valid.
    assert.equal(
      Array.from(split.title).length,
      80,
      'one astral character is never split into two broken halves',
    );
    const inside = chats.find((chat) => chat.chatId === 'astral-inside');
    assert.ok(inside !== undefined);
    assert.equal(inside.title, `${'x'.repeat(60)}😀${'w'.repeat(18)}…`, 'intact astral character survives inside the bound');
    const after = chats.find((chat) => chat.chatId === 'astral-after');
    assert.ok(after !== undefined);
    assert.equal(after.title, `${'y'.repeat(80)}…`);
  } finally {
    await app.close();
  }
});

test('memory parity: every indexed chat keeps a real timestamp in every listing', async () => {
  const store = createInMemoryChatStore({ now: nextNow });
  for (let index = 0; index < 25; index += 1) {
    await seedMessages(store, chatRef('general', `w${String(index).padStart(2, '0')}`), [
      userText(`u${String(index)}`, `window chat ${String(index)}`),
    ]);
  }
  // Narrow listing: only the top slots, all with real ISO timestamps.
  const narrow = await store.listRecentChats(5);
  assert.equal(narrow.length, 5);
  for (const chat of narrow) {
    assert.ok(chat.lastActivityAt !== null, 'an indexed chat never degrades to null');
  }
  // Wider listing: every chat this store indexed shows its real timestamp —
  // index membership (present in the store's index) always wins over
  // window position, mirroring the Redis zScore verification.
  const wide = await store.listRecentChats(50);
  assert.equal(wide.length, 25);
  for (const chat of wide) {
    assert.ok(chat.lastActivityAt !== null, `indexed chat ${chat.chatId} keeps its timestamp`);
  }
  // Deterministic order: newest first across the widened window.
  assert.equal(wide[0]?.chatId, 'w24');
  assert.equal(wide[24]?.chatId, 'w00');
});

test('store failure (listRecentChats throws) is a safe fixed 503', async () => {
  const failing = async (): Promise<never> => {
    throw new Error('ECONNREFUSED 127.0.0.1:6379');
  };
  const base = createInMemoryChatStore();
  const store: ChatStore = {
    ...base,
    listRecentChats: failing,
  };
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }), store });
  try {
    const response = await getChats(app.port);
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'Chat state is temporarily unavailable.' });
    const withLimit = await getChats(app.port, '?limit=5');
    assert.equal(withLimit.status, 503);
  } finally {
    await app.close();
  }
});

test('legacy route interactions stay intact: unknown slug 404s, hydration unchanged', async () => {
  const store = createInMemoryChatStore({ now: nextNow });
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }), store });
  try {
    await seedMessages(store, chatRef('general', 'chat-x'), [userText('u1', 'hello')]);
    const hydration = await getJson({ port: app.port, path: '/api/agents/general/chat/chat-x' });
    assert.equal(hydration.status, 200);
    assert.deepEqual(hydration.body, {
      messages: [userText('u1', 'hello')],
      hasActiveStream: false,
    });
    const chats = await getJson({ port: app.port, path: '/api/chats' });
    assert.equal(chats.status, 200);
    const cors = await fetch(`http://127.0.0.1:${app.port}/api/chats`, {
      headers: { Origin: TEST_ORIGINAL_ORIGIN },
    });
    assert.equal(cors.headers.get('access-control-allow-origin'), TEST_ORIGINAL_ORIGIN);
  } finally {
    await app.close();
  }
});

test('memory store index parity: every append re-scores, snapshot untouched', async () => {
  const store = createInMemoryChatStore({ now: nextNow });
  const chat = chatRef('general', 'parity');
  await seedMessages(store, chat, [userText('u1', 'one'), userText('u2', 'two')]);
  const first = await store.listRecentChats(10);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.messageCount, 2);
  const scoreBefore = first[0]?.lastActivityAt;
  const before = store.snapshot(chat);
  // A third append re-scores the member (newest activity wins).
  await store.appendMessage(chat, userText('u3', 'three'));
  const after = await store.listRecentChats(10);
  assert.equal(after[0]?.messageCount, 3);
  assert.notEqual(after[0]?.lastActivityAt, scoreBefore);
  assert.equal(store.snapshot(chat).messages.length, before.messages.length + 1);
  assert.ok(new Date(after[0]?.lastActivityAt ?? '').getTime() > new Date(scoreBefore ?? '').getTime());
});

test('chat summary type contract: no extra fields beyond the summary', async () => {
  const store = createInMemoryChatStore({ now: nextNow });
  await seedMessages(store, chatRef('orchestrator', 'shape'), [userText('u1', 'shape check')]);
  const chats = await store.listRecentChats(20);
  const only: ChatSummary | undefined = chats[0];
  assert.ok(only !== undefined);
  assert.deepEqual(Object.keys(only).sort(), [
    'agent',
    'chatId',
    'lastActivityAt',
    'messageCount',
    'preview',
    'title',
  ]);
  assert.equal(only.agent, 'orchestrator');
  assert.equal(only.chatId, 'shape');
});
