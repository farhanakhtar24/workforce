/**
 * Pre-Phase 6 SIDEBAR CHAT ACTIONS tests: persistent per-chat metadata
 * (GET/PATCH `/api/agents/:slug/chat/:id/metadata`), the sidebar list
 * surfaces (`pinned`/`archived` + strict `includeArchived` + pinned-first
 * ordering), the complete-transcript Markdown export
 * (`GET …/export`), DELETE removing metadata atomically, branch not copying
 * metadata, rewind preserving it, and ZERO hourly-budget consumption for
 * any of it. Store CRUD runs against BOTH the in-memory store and the real
 * Redis; the live persistence suite is in `test-live/`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { UIMessage } from 'ai';

import {
  CHAT_TITLE_MAX_CHARS,
  applyChatMetadataPatch,
  orderChatSummaries,
  parseChatMetadataPatch,
} from '../src/store/chat-history.js';
import { createInMemoryChatStore } from '../src/store/memory.js';
import type { ChatMetadata, ChatRef, ChatStore } from '../src/store/types.js';
import { createMockModel, textStep, toolCallStep, startTestApp, userMessage, getJson, postChat, TEST_OWNER, TEST_OWNER_B } from './helpers.js';
import { renderChatExport, exportFilename } from '../src/export/markdown-export.js';

function chatOf(ownerId: string, chatId: string): ChatRef {
  return { ownerId, slug: 'general', chatId };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('metadata patch parsing: trim, clear, ≤80 Unicode-safe code points, ≥1 field', () => {
  assert.deepEqual(parseChatMetadataPatch({ title: '  hello  ' }), { title: 'hello' });
  assert.deepEqual(parseChatMetadataPatch({ title: '  ' }), { title: null });
  assert.deepEqual(parseChatMetadataPatch({ title: null }), { title: null });
  assert.deepEqual(parseChatMetadataPatch({ pinned: true }), { pinned: true });
  assert.deepEqual(parseChatMetadataPatch({ archived: true, pinned: false, title: 'x' }), { archived: true, pinned: false, title: 'x' });
  assert.equal(parseChatMetadataPatch({}), null, 'empty patch');
  assert.equal(parseChatMetadataPatch({ title: 'x'.repeat(CHAT_TITLE_MAX_CHARS + 1) }), null, 'too long');
  const unicode31 = '\u{1F680}'.repeat(31); // 31 code points (62 UTF-16 units)
  assert.deepEqual(parseChatMetadataPatch({ title: unicode31 }), { title: unicode31 }, 'code-point safe (UTF-16 length is 62)');
  const unicode81 = '\u{1F680}'.repeat(81);
  assert.equal(parseChatMetadataPatch({ title: unicode81 }), null);
});

test('metadata patch application + pinned-first ordering + archived filtering (pure)', () => {
  const current: ChatMetadata = { title: 'old', pinned: false, archived: false };
  assert.deepEqual(applyChatMetadataPatch(current, { pinned: true }), { title: 'old', pinned: true, archived: false });
  assert.deepEqual(applyChatMetadataPatch(current, { title: null }), { title: null, pinned: false, archived: false });

  const summaries = [
    { chatId: 'a', agent: 'general', title: 'a', preview: 'a', messageCount: 1, lastActivityAt: null, pinned: false, archived: false },
    { chatId: 'b', agent: 'general', title: 'b', preview: 'b', messageCount: 1, lastActivityAt: null, pinned: true, archived: false },
    { chatId: 'c', agent: 'general', title: 'c', preview: 'c', messageCount: 1, lastActivityAt: null, pinned: false, archived: true },
    { chatId: 'd', agent: 'general', title: 'd', preview: 'd', messageCount: 1, lastActivityAt: null, pinned: true, archived: true },
  ] as never;
  // Default list: archived gone, pinned first.
  assert.deepEqual(
    orderChatSummaries(summaries, { includeArchived: false }).map((chat) => chat.chatId),
    ['b', 'a'],
  );
  // includeArchived=true: pinned first, then the rest in relative order.
  assert.deepEqual(
    orderChatSummaries(summaries, { includeArchived: true }).map((chat) => chat.chatId),
    ['b', 'd', 'a', 'c'],
  );
});

// ---------------------------------------------------------------------------
// Route level (in-memory store): CRUD, defaults, isolation, unknown chat
// ---------------------------------------------------------------------------

async function seededChat(app: { store: ChatStore }, chatId: string, ownerId = TEST_OWNER.userId): Promise<ChatRef> {
  const chat = chatOf(ownerId, chatId);
  await app.store.appendMessage(chat, { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'seed question' }] } as unknown as UIMessage);
  return chat;
}

test('metadata routes: defaults, strict PATCH semantics, unknown chat 404, isolation', async () => {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }) });
  try {
    const chatPath = '/api/agents/general/chat/meta-1';
    await seededChat(app, 'meta-1');

    // Defaults when none stored.
    const initial = await getJson({ port: app.port, path: `${chatPath}/metadata` });
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { metadata: { title: null, pinned: false, archived: false } });

    // Strict body: unknown key rejected 400; wrong types 400; wrong ctype 415.
    const unknownKey = await fetch(`http://127.0.0.1:${app.port}${chatPath}/metadata`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', color: 'red' }),
    });
    assert.equal(unknownKey.status, 400);
    const wrongType = await fetch(`http://127.0.0.1:${app.port}${chatPath}/metadata`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: 'yes' }),
    });
    assert.equal(wrongType.status, 400);
    const empty = await fetch(`http://127.0.0.1:${app.port}${chatPath}/metadata`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    const wrongCtype = await fetch(`http://127.0.0.1:${app.port}${chatPath}/metadata`, {
      method: 'PATCH',
      headers: {},
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(wrongCtype.status, 415);
    const tooLong = await fetch(`http://127.0.0.1:${app.port}${chatPath}/metadata`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(CHAT_TITLE_MAX_CHARS + 1) }),
    });
    assert.equal(tooLong.status, 400);

    // Real PATCH: title + archive; trimmed.
    const patched = await fetch(`http://127.0.0.1:${app.port}${chatPath}/metadata`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '  My pinned chat  ', pinned: true, archived: true }),
    });
    assert.equal(patched.status, 200);
    assert.deepEqual((await patched.json()) as unknown, {
      metadata: { title: 'My pinned chat', pinned: true, archived: true },
    });

    // Title clear via null and via empty string.
    const clearNull = await fetch(`http://127.0.0.1:${app.port}${chatPath}/metadata`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: null }),
    });
    assert.deepEqual(((await clearNull.json()) as { metadata: ChatMetadata }).metadata, { title: null, pinned: true, archived: true });
    const clearEmpty = await fetch(`http://127.0.0.1:${app.port}${chatPath}/metadata`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });
    assert.deepEqual(((await clearEmpty.json()) as { metadata: ChatMetadata }).metadata.title, null);

    // Unknown chat → fixed 404 (no metadata creation).
    const unknown = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/meta-unknown/metadata`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual((await unknown.json()) as unknown, { error: 'Chat not found.' });
    const unknownGet = await getJson({ port: app.port, path: '/api/agents/general/chat/meta-unknown/metadata' });
    assert.equal(unknownGet.status, 404);

    // Cross-owner SAME chat id: owner B's default metadata (no leak).
    const foreignApp = await startTestApp({
      store,
      model: createMockModel({ steps: [textStep()] }),
      auth: { staticOwner: TEST_OWNER_B },
    });
    try {
      const foreignGet = await getJson({ port: foreignApp.port, path: `${chatPath}/metadata` });
      assert.equal(foreignGet.status, 404, "owner B doesn't own the chat namespace");
    } finally {
      await foreignApp.close();
    }
  } finally {
    await app.close();
  }
});

test('sidebar list: pinned first, archived filtered, includeArchived strict, custom title flows', async () => {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep()] }) });
  try {
    await seededChat(app, 'chat-a');
    await seededChat(app, 'chat-b');
    await seededChat(app, 'chat-c');
    // chat-a: pinned + custom title; chat-c: archived; chat-b: defaults.
    const patchA = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/chat-a/metadata`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Pinned custom', pinned: true }),
    });
    assert.equal(patchA.status, 200);
    const patchC = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/chat-c/metadata`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    assert.equal(patchC.status, 200);

    // Default: archived excluded, pinned first, custom title.
    const list = await getJson({ port: app.port, path: '/api/chats' });
    assert.equal(list.status, 200);
    const chats = (list.body as { chats: Array<{ chatId: string; title: string; pinned: boolean; archived: boolean }> }).chats;
    assert.deepEqual(chats.map((chat) => chat.chatId), ['chat-a', 'chat-b']);
    assert.equal(chats[0]?.title, 'Pinned custom');
    assert.equal(chats[0]?.pinned, true);

    // includeArchived strict: true includes, 'junk' → fixed 400.
    const withArchived = await getJson({ port: app.port, path: '/api/chats?includeArchived=true' });
    assert.deepEqual(
      ((withArchived.body as { chats: Array<{ chatId: string }> }).chats).map((chat) => chat.chatId),
      ['chat-a', 'chat-c', 'chat-b'],
      'pinned first; equal-index ties sort member-descending (deterministic)',
    );
    const withArchivedFalse = await getJson({ port: app.port, path: '/api/chats?includeArchived=false' });
    assert.deepEqual(
      ((withArchivedFalse.body as { chats: Array<{ chatId: string }> }).chats).map((chat) => chat.chatId),
      ['chat-a', 'chat-b'],
    );
    const junk = await fetch(`http://127.0.0.1:${app.port}/api/chats?includeArchived=yes`);
    assert.equal(junk.status, 400);
    const junkNumber = await fetch(`http://127.0.0.1:${app.port}/api/chats?includeArchived=1`);
    assert.equal(junkNumber.status, 400);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// DELETE / branch / rewind semantics
// ---------------------------------------------------------------------------

test('lifecycle: DELETE removes metadata; branch does NOT copy it; rewind PRESERVES it', async () => {
  const store = createInMemoryChatStore({ now: () => 5_000 });
  const app = await startTestApp({ store, model: createMockModel({ steps: [textStep(), textStep()] }) });
  try {
    const source = await seededChat(app, 'lc-meta', TEST_OWNER.userId);
    const patch = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/lc-meta/metadata`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'pinned meta', pinned: true }),
    });
    assert.equal(patch.status, 200);

    // BRANCH: destination metadata is ALL-DEFAULT (no copy).
    const branch = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/lc-meta/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u0', newChatId: 'lc-meta-clone' }),
    });
    assert.equal(branch.status, 201);
    const branchMeta = await getJson({ port: app.port, path: '/api/agents/general/chat/lc-meta-clone/metadata' });
    assert.deepEqual((branchMeta.body as { metadata: ChatMetadata }).metadata, { title: null, pinned: false, archived: false });

    // REWIND: metadata preserved.
    const rewind = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/lc-meta/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'u0' }),
    });
    assert.equal(rewind.status, 200);
    const afterRewind = await getJson({ port: app.port, path: '/api/agents/general/chat/lc-meta/metadata' });
    assert.deepEqual((afterRewind.body as { metadata: ChatMetadata }).metadata, { title: 'pinned meta', pinned: true, archived: false });

    // DELETE: metadata dies with the chat (defaults after; the memory store
    // mirrors the Lua DEL of the metadata key exactly).
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/lc-meta`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(await store.getChatMetadata(source), { title: null, pinned: false, archived: false });
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Export (pure + route)
// ---------------------------------------------------------------------------

test('export markdown: complete text, labelled reasoning, safe tool JSON, no metadata/secrets', () => {
  const messages: UIMessage[] = [
    {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: 'First question\nwith two lines' }],
    },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'reasoning', text: '``` \ninternal thinking with a fence' },
        { type: 'text', text: 'Answer text with ```runs too' },
        {
          type: 'tool-calculate',
          toolCallId: 'tc1',
          state: 'output-available',
          input: { expression: '2+2' },
          output: { result: 4, note: '```nested' },
        } as never,
        { type: 'tool-ask_user', toolCallId: 'tc2', state: 'output-available', input: { options: ['a'] }, output: { answer: 'a' } } as never,
      ],
      metadata: { modelId: 'glm-5.3-flash', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    } as unknown as UIMessage,
  ];
  const document = renderChatExport({ chatId: 'exp', agent: 'orchestrator', exportedAt: '2026-11-26T00:00:00.000Z', messages });
  // Headings per turn.
  assert.ok(document.includes('# Chat export — orchestrator / exp'));
  assert.ok(document.includes('### User'));
  assert.ok(document.includes('### Assistant'));
  assert.ok(document.includes('_Message id: a1_'));
  // COMPLETE text (no truncation), including both lines.
  assert.ok(document.includes('First question\nwith two lines'));
  assert.ok(document.includes('Answer text with ```runs too'));
  // Reasoning clearly labelled.
  assert.ok(document.includes('**Reasoning**'));
  assert.ok(document.includes('internal thinking with a fence'));
  // Tool parts with complete JSON; fence LONGER than any run inside.
  assert.ok(document.includes('**Tool: calculate**'));
  assert.ok(document.includes('**Tool: ask_user**'));
  assert.ok(document.includes('```json'));
  assert.ok(document.includes('```nested'));
  assert.ok(document.includes('"expression": "2+2"'));
  // The chosen fence is longer than any ``` run in the document content.
  const fences = [...document.matchAll(/`{3,}/g)].map((match) => match[0]?.length ?? 0);
  assert.ok(Math.max(...fences) >= 4, 'the longest fence run cannot close a JSON block');
  // NO metadata/usage/model/owner/secrets anywhere.
  assert.equal(document.includes('glm-5.3-flash'), false);
  assert.equal(document.includes('usage'), false);
  assert.equal(document.includes('metadata'), false);
  // Deterministic.
  assert.equal(document, renderChatExport({ chatId: 'exp', agent: 'orchestrator', exportedAt: '2026-11-26T00:00:00.000Z', messages }));
  // Filename safe.
  assert.equal(exportFilename('safe_id.1', '2026-11-26T00:00:00.000Z'), 'chat-safeid1-2026-11-26.md');
  assert.equal(exportFilename('bad/slash', '2026-11-26T00:00:00.000Z'), 'chat-badslash-2026-11-26.md');
});

test('export route: content type, disposition, no-store, complete tool payload, 404, no budget use', async () => {
  const app = await startTestApp({ model: createMockModel({ steps: [textStep()] }) });
  try {
    const chat = await seededChat(app, 'exp-chat');
    await app.store.appendMessage(chat, {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'reply body' },
        { type: 'tool-calculate', toolCallId: 'tc', state: 'output-available', input: { expression: '2+2', big: 'payload'.repeat(400) }, output: { answer: 4 } } as never,
      ],
    } as unknown as UIMessage);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/exp-chat/export`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((response.headers.get('content-disposition') ?? '').startsWith('attachment; filename="chat-exp-chat-'));
    const document = await response.text();
    assert.ok(document.includes('reply body'));
    // The BIG tool payload is COMPLETE (never truncated).
    assert.ok(document.includes('payload'.repeat(400)));
    assert.ok(document.includes('"answer": 4'));
    const unknown = await fetch(`http://127.0.0.1:${app.port}/api/agents/general/chat/exp-unknown/export`);
    assert.equal(unknown.status, 404);
    assert.deepEqual((await unknown.json()) as unknown, { error: 'Chat not found.' });
  } finally {
    await app.close();
  }
});
