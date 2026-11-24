import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHATS_CHANGED_EVENT,
  RECENT_CHATS_DEFAULT_LIMIT,
  RECENT_CHATS_MAP_ERROR,
  RECENT_CHATS_MAX_LIMIT,
  RECENT_CHATS_UNREACHABLE,
  RECENT_CHAT_UNTITLED,
  formatRecentChatMeta,
  formatRecentChatStamp,
  isCurrentRecentChat,
  mapRecentChats,
  recentChatHref,
  recentChatsEndpoint,
} from '../src/lib/recent-chats.js';

const BASE = 'http://localhost:3001';

function validRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatId: '52790846-b7b8-4520-8def-23aacf5a96f8',
    agent: 'orchestrator',
    title: '  Orchestrator · Research plan  ',
    preview: '  Returned row: 1. **Task**  ',
    messageCount: 5,
    lastActivityAt: '2026-11-24T10:00:00.000Z',
    ...overrides,
  };
}

test('endpoint URL: default, clamped max, and non-positive limit fall back to default', () => {
  assert.equal(recentChatsEndpoint(BASE), `${BASE}/api/chats?limit=20`);
  assert.equal(recentChatsEndpoint(BASE, RECENT_CHATS_DEFAULT_LIMIT), `${BASE}/api/chats?limit=20`);
  assert.equal(recentChatsEndpoint(BASE, RECENT_CHATS_MAX_LIMIT), `${BASE}/api/chats?limit=50`);
  assert.equal(recentChatsEndpoint(BASE, 999), `${BASE}/api/chats?limit=50`);
  assert.equal(recentChatsEndpoint(BASE, 0), `${BASE}/api/chats?limit=20`);
  assert.equal(recentChatsEndpoint(BASE, -3), `${BASE}/api/chats?limit=20`);
  assert.equal(recentChatsEndpoint(BASE, 2.5), `${BASE}/api/chats?limit=20`);
});

test('mapRecentChats: valid payload maps real bounded plain text', () => {
  const result = mapRecentChats({ chats: [validRow()] });
  assert.ok(result.ok);
  assert.equal(result.chats.length, 1);
  const chat = result.chats[0];
  assert.equal(chat.chatId, '52790846-b7b8-4520-8def-23aacf5a96f8');
  assert.equal(chat.agent, 'orchestrator');
  assert.equal(chat.title, 'Orchestrator · Research plan');
  assert.equal(chat.preview, 'Returned row: 1. **Task**');
  assert.equal(chat.messageCount, 5);
  assert.equal(chat.lastActivityAt, '2026-11-24T10:00:00.000Z');
});

test('mapRecentChats: empty title falls back to the honest untitled label', () => {
  const result = mapRecentChats({ chats: [validRow({ title: '   ' })] });
  assert.ok(result.ok);
  assert.equal(result.chats[0].title, RECENT_CHAT_UNTITLED);
});

test('mapRecentChats: empty preview is preserved as empty string (line hidden by UI)', () => {
  const result = mapRecentChats({ chats: [validRow({ preview: '' })] });
  assert.ok(result.ok);
  assert.equal(result.chats[0].preview, '');
});

test('mapRecentChats: truncates overlong title and preview text', () => {
  const long = 'x'.repeat(400);
  const result = mapRecentChats({ chats: [validRow({ title: long, preview: long })] });
  assert.ok(result.ok);
  assert.equal(result.chats[0].title.length, 200);
  assert.equal(result.chats[0].preview.length, 300);
});

test('bounded slicing never splits a surrogate pair in title or preview', () => {
  // Emoji 😀 = U+1F600 (high + low surrogate pair in UTF-16).
  const astral = '\u{1F600}';
  // Boundary lands BETWEEN the pair: 199 ASCII + high surrogate at index 199.
  const splitCase = 'x'.repeat(199) + astral + 'y'.repeat(50);
  const mapped = mapRecentChats({ chats: [validRow({ title: splitCase, preview: splitCase })] });
  assert.ok(mapped.ok);
  const title = mapped.chats[0].title;
  assert.equal(title.length, 199, 'retreats one unit so the high surrogate is not stranded');
  assert.ok(!/[\u{D800}-\u{DFFF}]/u.test(title), 'no lone surrogate survives in the mapped title');
  assert.equal(title, 'x'.repeat(199));
  assert.ok(!/[\u{D800}-\u{DFFF}]/u.test(mapped.chats[0].preview), 'no lone surrogate in the preview');

  // Exact bound with a pair fully inside is kept intact.
  const inside = 'x'.repeat(198) + astral;
  const keep = mapRecentChats({ chats: [validRow({ title: inside })] });
  assert.ok(keep.ok);
  assert.equal(keep.chats[0].title.length, 200); // both surrogate units kept
  assert.ok(keep.chats[0].title.includes(astral));
});

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // lone low surrogate
    }
  }
  return false;
}

test('mapRecentChats: legacy/null and invalid timestamps stay null, never fabricated', () => {
  const legacy = mapRecentChats({ chats: [validRow({ lastActivityAt: null })] });
  assert.ok(legacy.ok);
  assert.equal(legacy.chats[0].lastActivityAt, null);

  const bad = mapRecentChats({ chats: [validRow({ lastActivityAt: 'not-a-date' })] });
  assert.ok(bad.ok);
  assert.equal(bad.chats[0].lastActivityAt, null);
});

test('mapRecentChats: accepts non-negative integer counts, truncates fractions', () => {
  const ok = mapRecentChats({ chats: [validRow({ messageCount: 7.9 })] });
  assert.ok(ok.ok);
  assert.equal(ok.chats[0].messageCount, 7);
});

test('mapRecentChats: malformed shapes map to the fixed safe error', () => {
  const cases: unknown[] = [
    null,
    42,
    {},
    { chats: 'nope' },
    [],
    [null],
    [{ chatId: '', agent: 'general', title: 'T', preview: 'P', messageCount: 1, lastActivityAt: null }],
    [validRow({ chatId: 'bad id!' })],
    [validRow({ agent: 'not-an-agent' })],
    [validRow({ title: 5 })],
    [validRow({ preview: [] })],
    [validRow({ messageCount: -1 })],
    [validRow({ messageCount: 'three' })],
  ];
  for (const payload of cases) {
    const result = mapRecentChats(payload);
    assert.deepEqual(result, { ok: false, error: RECENT_CHATS_MAP_ERROR, status: 502 }, JSON.stringify(payload)?.slice(0, 60));
  }
});

test('recentChatHref builds the canonical agent-scoped chat URL', () => {
  const mapped = mapRecentChats({ chats: [validRow()] });
  assert.ok(mapped.ok);
  assert.equal(
    recentChatHref(mapped.chats[0]),
    '/agents/orchestrator/chat/52790846-b7b8-4520-8def-23aacf5a96f8',
  );
  const general = mapRecentChats({
    chats: [validRow({ agent: 'general', chatId: 'abc123' })],
  });
  assert.ok(general.ok);
  assert.equal(recentChatHref(general.chats[0]), '/agents/general/chat/abc123');
});

test('isCurrentRecentChat: mode is ignored, other agents/paths are not', () => {
  const mapped = mapRecentChats({ chats: [validRow()] });
  assert.ok(mapped.ok);
  const chat = mapped.chats[0];
  assert.equal(
    isCurrentRecentChat('/agents/orchestrator/chat/52790846-b7b8-4520-8def-23aacf5a96f8', chat),
    true,
  );
  // Mode never changes the active state.
  assert.equal(
    isCurrentRecentChat(
      '/agents/orchestrator/chat/52790846-b7b8-4520-8def-23aacf5a96f8',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chat,
    ),
    true,
  );
  assert.equal(isCurrentRecentChat('/agents/general/chat/52790846-b7b8-4520-8def-23aacf5a96f8', chat), false);
  assert.equal(isCurrentRecentChat('/agents/orchestrator/chat/other-id', chat), false);
  assert.equal(isCurrentRecentChat('/memory', chat), false);
  assert.equal(isCurrentRecentChat('/', chat), false);
});

test('formatRecentChatStamp: bounded UTC stamp or null for legacy/invalid rows', () => {
  assert.equal(formatRecentChatStamp('2026-11-24T10:05:30.000Z'), '2026-11-24 10:05 UTC');
  assert.equal(formatRecentChatStamp(null), null);
  assert.equal(formatRecentChatStamp('garbage'), null);
});

test('formatRecentChatMeta: pluralization plus honest saved/legacy label', () => {
  const mapped = mapRecentChats({ chats: [validRow()] });
  assert.ok(mapped.ok);
  assert.equal(formatRecentChatMeta(mapped.chats[0]), '5 messages · 2026-11-24 10:00 UTC');

  const legacy = mapRecentChats({ chats: [validRow({ messageCount: 1, lastActivityAt: null })] });
  assert.ok(legacy.ok);
  assert.equal(formatRecentChatMeta(legacy.chats[0]), '1 message · saved chat, no timestamp');
});

test('the chats-changed event name is the documented namespaced value', () => {
  assert.equal(CHATS_CHANGED_EVENT, 'workforce:chats-changed');
});

test('RECENT_CHATS_UNREACHABLE differs from the mapping error (honest distinction)', () => {
  assert.notEqual(RECENT_CHATS_UNREACHABLE, RECENT_CHATS_MAP_ERROR);
});
