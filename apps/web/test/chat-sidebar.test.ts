import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_EXPORT_ERROR,
  CHAT_METADATA_BUSY,
  CHAT_METADATA_CONFLICT,
  CHAT_METADATA_ERROR,
  CHAT_TITLE_MAX_CODEPOINTS,
  buildChatMetadataPatch,
  chatExportEndpoint,
  chatMetadataEndpoint,
  exportFilenameFor,
  fetchChatExport,
  mapChatMetadata,
  patchChatMetadata,
  sanitizeChatTitle,
  titleCodepointLength,
} from '../src/lib/chat-sidebar.js';
import {
  HOURLY_USAGE_FALLBACK_ERROR,
  fetchHourlyUsage,
  formatHourlyCost,
  formatHourlyReset,
  hourlyUsageEndpoint,
  mapHourlyUsage,
} from '../src/lib/hourly-usage.js';
import { recentChatsEndpoint } from '../src/lib/recent-chats.js';

const BASE = 'http://localhost:3001';
const CHAT = '52790846-b7b8-4520-8def-23aacf5a96f8';
const VALID_METADATA = { title: 'Renamed', pinned: true, archived: false };

test('sanitizeChatTitle: trim, code-point bound, blank clears', () => {
  assert.deepEqual(sanitizeChatTitle('  Research plan  '), { ok: true, value: 'Research plan' });
  assert.deepEqual(sanitizeChatTitle('   '), { ok: true, value: null });
  assert.deepEqual(sanitizeChatTitle(''), { ok: true, value: null });
  assert.deepEqual(sanitizeChatTitle(null), { ok: true, value: null });
  // Non-string garbage (number, object) is an error.
  assert.equal(sanitizeChatTitle(5 as never).ok, false);
  // A trimmed emoji pair is ONE code point: 79 × 'a' + '😀' fits inside 80.
  const emojiTitle = 'a'.repeat(79) + '\u{1F600}';
  const emojiFit = sanitizeChatTitle(emojiTitle);
  assert.ok(emojiFit.ok);
  assert.equal(titleCodepointLength(String(emojiFit.ok === true ? emojiFit.value : '')), 80);
  // 80 code points + one more character is rejected.
  const tooLong = 'b'.repeat(80) + '\u{1F600}';
  assert.equal(sanitizeChatTitle(tooLong).ok, false);
  assert.equal(CHAT_TITLE_MAX_CODEPOINTS, 80);
});

test('buildChatMetadataPatch: strict >=1 field with sanitized values', () => {
  assert.deepEqual(buildChatMetadataPatch({ title: '  Plan it  ' }), {
    ok: true,
    body: JSON.stringify({ title: 'Plan it' }),
  });
  // A blank title is an intentional CLEAR (null goes over the wire).
  assert.deepEqual(buildChatMetadataPatch({ title: '   ' }), {
    ok: true,
    body: JSON.stringify({ title: null }),
  });
  assert.equal(buildChatMetadataPatch({}).ok, false);
  assert.equal(buildChatMetadataPatch({ title: 5 as never }).ok, false);
  assert.equal(buildChatMetadataPatch({ pinned: 'true' as never }).ok, false);
  const both = buildChatMetadataPatch({ pinned: true, archived: false });
  assert.ok(both.ok);
  assert.deepEqual(JSON.parse(both.ok === true ? both.body : ''), { pinned: true, archived: false });
});

test('metadata endpoint: canonical URL with encoding', () => {
  assert.equal(
    chatMetadataEndpoint(BASE, 'orchestrator', CHAT),
    `${BASE}/api/agents/orchestrator/chat/${CHAT}/metadata`,
  );
  assert.equal(chatMetadataEndpoint(BASE, 'bad slug', CHAT), null);
  assert.equal(chatMetadataEndpoint(BASE, 'general', 'nope/'), null);
});

test('metadata response mapping: nested shape, malformed rejected', () => {
  const mapped = mapChatMetadata({ metadata: VALID_METADATA });
  assert.deepEqual(mapped, { ok: true, metadata: VALID_METADATA });
  // Title is null-safe when cleared.
  assert.deepEqual(mapChatMetadata({ metadata: { title: null, pinned: false, archived: false } }), {
    ok: true,
    metadata: { title: null, pinned: false, archived: false },
  });
  // Flat shape and malformed values fail with the fixed error.
  for (const payload of [
    null,
    'x',
    {},
    { personalMemoryEnabled: true },
    { metadata: { title: 5, pinned: true, archived: false } },
    { metadata: { title: null, pinned: 'yes', archived: false } },
    { metadata: { title: null, archived: true } },
  ]) {
    const result = mapChatMetadata(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    if (!result.ok) assert.equal(result.error, CHAT_METADATA_ERROR);
  }
});

type MetadataFetch = NonNullable<Parameters<typeof patchChatMetadata>[0]['fetchImpl']>;

function jsonFetch(status: number, body: unknown): { impl: MetadataFetch } {
  const impl = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as MetadataFetch;
  return { impl };
}

test('PATCH errors: 404 conflict, 409 busy, auth passthrough', async () => {
  const { impl } = jsonFetch(404, {});
  const notFound = await patchChatMetadata({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, patch: { pinned: true }, fetchImpl: impl });
  if (notFound.ok) assert.fail('expected failure');
  assert.equal(notFound.error, CHAT_METADATA_CONFLICT);

  const { impl: busy } = jsonFetch(409, {});
  const busyResult = await patchChatMetadata({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, patch: { pinned: true }, fetchImpl: busy });
  if (busyResult.ok) assert.fail('expected failure');
  assert.equal(busyResult.error, CHAT_METADATA_BUSY);

  const { impl: auth } = jsonFetch(401, {});
  const authResult = await patchChatMetadata({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, patch: { pinned: true }, fetchImpl: auth });
  if (authResult.ok) assert.fail('expected failure');
  // 401 maps to the web session-expired copy + client redirect to /sign-in.
  assert.equal(authResult.error, 'Your session expired. Redirecting to sign-in…');
});

// ---- hourly budget usage (B) ------------------------------------------

const VALID_HOURLY = {
  windowSeconds: 3600,
  requestLimit: 10,
  costLimitUsd: 1,
  requestCount: 3,
  remainingRequests: 7,
  estimatedCostUsd: 0.25,
  remainingCostUsd: 0.75,
  resetAt: '2026-11-25T12:00:00.000Z',
  usageComplete: false,
  models: [{ modelId: 'glm-5.3-flash', requests: 3, inputTokens: 620, outputTokens: 60, estimatedCostUsd: 0.25 }],
};

test('hourly usage endpoint + mapping: totals, buckets, honest settlement', () => {
  assert.equal(hourlyUsageEndpoint(BASE), `${BASE}/api/usage/hourly`);
  const mapped = mapHourlyUsage(VALID_HOURLY);
  assert.ok(mapped.ok);
  if (mapped.ok) {
    assert.equal(mapped.summary.remainingRequests, 7);
    assert.equal(mapped.summary.estimatedCostUsd, 0.25);
    assert.equal(mapped.summary.usageComplete, false);
    assert.equal(mapped.summary.models.length, 1);
  }
  // Budget shape is exact: per-model cost requires pricing config upstream.
  const budgetText = formatHourlyCost(mapped.ok ? mapped.summary : (undefined as never));
  if (mapped.ok) assert.equal(budgetText, '$0.2500 of $1.00 (conservative estimate)');
  const reset = formatHourlyReset(mapped.ok ? mapped.summary.resetAt : null);
  assert.ok(reset !== null);
  if (reset !== null) {
    assert.ok(reset.utc.includes('UTC'));
    assert.ok(reset.local.length > 0);
  }
  assert.equal(formatHourlyReset(null), null);
});

test('hourly usage mapping: malformed payloads rejected; zero/NaN never accepted', () => {
  const cases: unknown[] = [
    null,
    'x',
    {},
    { ...VALID_HOURLY, requestLimit: '10' },
    { ...VALID_HOURLY, requestCount: -1 },
    { ...VALID_HOURLY, estimatedCostUsd: Number.NaN },
    { ...VALID_HOURLY, resetAt: 'not-a-date' },
    { ...VALID_HOURLY, models: 'all' },
    { ...VALID_HOURLY, models: [{ modelId: '', requests: 1, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }] },
    { ...VALID_HOURLY, models: [{ modelId: 'm', requests: 0.5, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }] },
  ];
  for (const payload of cases) {
    const result = mapHourlyUsage(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    if (!result.ok) assert.equal(result.error, HOURLY_USAGE_FALLBACK_ERROR);
  }
  // resetAt null is legal (no rolling expiry yet).
  assert.ok(mapHourlyUsage({ ...VALID_HOURLY, resetAt: null, usageComplete: true }).ok);
});

test('hourly usage fetch: 503 and network failures collapse to the fixed copy', async () => {
  const { impl: down } = jsonFetch(503, { error: HOURLY_USAGE_FALLBACK_ERROR });
  const result = await fetchHourlyUsage({ apiBaseUrl: BASE, fetchImpl: down as never });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, HOURLY_USAGE_FALLBACK_ERROR);
    assert.equal(result.status, 503);
  }
  const { impl: offline } = jsonFetch(-1, null);
  const offlineResult = await fetchHourlyUsage({ apiBaseUrl: BASE, fetchImpl: offline as never });
  assert.equal(offlineResult.ok, false);
});

test('exportFilenameFor: ISO colons sanitized; server filename overrides', () => {
  assert.equal(
    exportFilenameFor('52790846-b7b8-4520-8def-23aacf5a96f8', '2026-11-24T12:30:45.000Z'),
    'chat-52790846-b7b8-4520-8def-23aacf5a96f8-export-2026-11-24T12-30-45.md',
  );
  assert.equal(exportFilenameFor('bad/id', 'garbage'), 'chat-chat-export-export.md');
});

test('chat export fetch: accepts text/markdown with the server filename', async () => {
  type ExportFetch = NonNullable<Parameters<typeof fetchChatExport>[0]['fetchImpl']>;
  const markdown = '# Transcript\n\n42';
  const impl = (async () => ({
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-disposition' ? 'attachment; filename="chat-abc.md"' : 'text/markdown; charset=utf-8') },
    text: async () => markdown,
  })) as unknown as ExportFetch;
  const result = await fetchChatExport({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, fetchImpl: impl });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.markdown, markdown);
    assert.ok(result.filename.startsWith('chat-abc.md'));
  }
});

test('chat export fetch: wrong content type rejected with the fixed copy', async () => {
  type ExportFetch = NonNullable<Parameters<typeof fetchChatExport>[0]['fetchImpl']>;
  const impl = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => '{"x":1}',
  })) as unknown as ExportFetch;
  const result = await fetchChatExport({ apiBaseUrl: BASE, slug: 'general', chatId: CHAT, fetchImpl: impl });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, CHAT_EXPORT_ERROR);
});
