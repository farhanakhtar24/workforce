/**
 * Offline tests for the server-proxied Ollama model catalog + the runtime
 * model factory: bounded parsing (id/name/modifiedAt/capabilities/
 * parameterSize; locked + fixed reason), the model-id pattern, blocked
 * prefix matching, the 60s list / 6h details caches (single-flight,
 * TTL-driven), fixed failures (503 mapping), and details extraction with
 * `contextLength` ONLY from actual `model_info` context-length fields
 * (unknown stats `null`, never guessed). Fake fetch only — no live provider,
 * no key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createModelCatalog,
  isBlockedModelId,
  isModelId,
  MODEL_ID_PATTERN,
  MODEL_LOCK_REASON,
} from '../src/models/catalog.js';
import { createRuntimeModelFactory } from '../src/models/runtime.js';

const TAGS_BODY = {
  models: [
    {
      model: 'glm-5.3-flash',
      name: 'GLM 5.3 Flash',
      modified_at: '2026-11-01T00:00:00Z',
      capabilities: ['completion', 'tools'],
      details: { parameter_size: '5.3B' },
    },
    {
      name: 'kimi-k2:free',
      parameter_size: '1T',
      capabilities: ['completion'],
    },
    {
      model: 'kimi-k2-thinking',
      name: 'kimi-k2-thinking',
      modified_at: '2026-10-01T00:00:00Z',
    },
    { model: 'bad id with spaces', name: 'skipped' },
    'not-an-object',
  ],
};

const SHOW_BODY = {
  details: { parameter_size: '5.3B' },
  capabilities: ['completion', 'tools', 'insert'],
  model_info: {
    'general.architecture': 'glm',
    'glm.context_length': 131072,
    'tokenizer.ggml.eos_token_id': 1,
  },
  thinking: true,
};

interface FakeFetchCall {
  readonly input: string;
  readonly init: RequestInit | undefined;
}

/** One fake fetch + counters; no live provider, no key, no env. */
function fakeCatalogFetch(responder: (call: FakeFetchCall) => Response, clockNow: number = 1_000_000): FetchLike & { calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  void clockNow;
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const call: FakeFetchCall = { input: String(input), init };
    calls.push(call);
    return responder(call);
  }) as FetchLike & { calls: FakeFetchCall[] };
  fetchFn.calls = calls as never;
  return fetchFn as FetchLike & { calls: FakeFetchCall[] };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BLOCKED = ['kimi'];

type FetchWithCalls = FetchLike & { calls: FakeFetchCall[] };

function catalogWith(
  responder: (call: FakeFetchCall) => Response,
  options: { now?: () => number; fetch?: FetchLike; baseUrl?: string } = {},
) {
  const fetch = (options.fetch ??
    fakeCatalogFetch(responder)) as FetchWithCalls;
  const now = options.now ?? (() => 1_000_000);
  return {
    fetch,
    catalog: createModelCatalog({
      baseUrl: options.baseUrl ?? 'https://ollama.example/v1',
      apiKey: 'test-only-not-a-real-key',
      blockedPrefixes: BLOCKED,
      fetchFn: fetch,
      now,
    }),
  };
}

test('model id pattern: bounded ids pass, quotes/slashes/whitespace fail', () => {
  assert.equal(isModelId('glm-5.3-flash'), true);
  assert.equal(isModelId('gpt-oss:20b'), true);
  assert.equal(isModelId('a'.repeat(80)), true);
  assert.equal(isModelId(''), false);
  assert.equal(isModelId('a'.repeat(81)), false);
  assert.equal(isModelId('bad/slash'), false);
  assert.equal(isModelId('has space'), false);
  assert.equal(isModelId('x'), true, 'single characters are valid bounded ids');
  for (const bad of ['a/b', 'a b', '#tag', 'ünï']) {
    assert.equal(MODEL_ID_PATTERN.test(bad), false, bad);
  }
});

test('catalog list: bounded rows, blocked flags with the FIXED reason, capped capabilities', async () => {
  const { catalog, fetch } = catalogWith(() => jsonResponse(200, TAGS_BODY));
  const { models } = await catalog.list();
  assert.deepEqual(
    models.map((model) => model.id),
    ['glm-5.3-flash', 'kimi-k2:free', 'kimi-k2-thinking'],
    'unusable rows are skipped',
  );
  const kimiFree = models.find((model) => model.id === 'kimi-k2:free');
  assert.ok(kimiFree !== undefined);
  assert.equal(kimiFree.parameterSize, '1T', 'top-level parameter_size wins when details are absent');
  assert.equal(kimiFree.modifiedAt, null);
  assert.deepEqual(kimiFree.locked, true);
  assert.equal(kimiFree.lockReason, MODEL_LOCK_REASON);
  const kimiThinking = models.find((model) => model.id === 'kimi-k2-thinking');
  assert.ok(kimiThinking !== undefined && kimiThinking.locked === true);
  const ok = models.find((model) => model.id === 'glm-5.3-flash');
  assert.ok(ok !== undefined);
  assert.equal(ok.locked, false);
  assert.equal(ok.lockReason, null);
  assert.equal(ok.name, 'GLM 5.3 Flash');
  assert.deepEqual([...ok.capabilities], ['completion', 'tools']);
  assert.equal(ok.parameterSize, '5.3B');
  assert.equal(ok.modifiedAt, '2026-11-01T00:00:00Z');
  // Single upstream call with the derived origin + NO key in the URL.
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0]?.input, 'https://ollama.example/api/tags');
  assert.equal(String((fetch.calls[0]?.init?.headers as Record<string, unknown>)?.['authorization']).startsWith('Bearer test-only'), true);
});

test('catalog list blocked prefix matching is CASE-INSENSITIVE', () => {
  assert.equal(isBlockedModelId('Kimi-K2:Free', BLOCKED), true);
  assert.equal(isBlockedModelId('KIMI-mini', BLOCKED), true);
  assert.equal(isBlockedModelId('glm-5.3-flash', BLOCKED), false);
  assert.equal(isBlockedModelId('mik-test', BLOCKED), false, 'only a PREFIX matches');
});

test('catalog list: fixed 503 mapping on upstream/network failures', async () => {
  const { catalog: unavailable } = catalogWith(() => jsonResponse(500, {}));
  await assert.rejects(() => unavailable.list(), (error: { name: string }) => error.name === 'ModelCatalogUnavailableError');
  const { catalog: broken } = catalogWith(() => {
    throw new Error('boom');
  });
  await assert.rejects(() => broken.list(), (error: { name: string }) => error.name === 'ModelCatalogUnavailableError');
  // A non-object body parses to zero models — not a failure.
  const { catalog: empty } = catalogWith(() => jsonResponse(200, { unexpected: true }));
  const emptyList = await empty.list();
  assert.deepEqual(emptyList.models, []);
});

test('catalog list cache: TTL 60s, single-flight, refresh after expiry', async () => {
  let clock = 1_000_000;
  const counter = { calls: 0 };
  const fetch: FetchWithCalls = Object.assign(
    async (_input: string, _init?: RequestInit): Promise<Response> => {
      counter.calls += 1;
      return jsonResponse(200, TAGS_BODY);
    },
    { calls: [] as FakeFetchCall[] },
  );
  const { catalog } = catalogWith(() => jsonResponse(200, TAGS_BODY), {
    fetch,
    now: () => clock,
  });
  const first = await catalog.list();
  assert.equal(counter.calls, 1);
  // Cached within TTL: no upstream call, single identity.
  const second = await catalog.list();
  assert.deepEqual(second, first);
  assert.equal(counter.calls, 1);
  // TTL expiry (60s): exactly one more upstream call.
  clock += 61_000;
  await catalog.list();
  assert.equal(counter.calls, 2);
  // Simultaneous calls after ANOTHER expiry share ONE flight.
  clock += 61_000;
  const [a, b] = await Promise.all([catalog.list(), catalog.list()]);
  assert.equal(counter.calls, 3);
  assert.deepEqual(a, b);
});

test('catalog details: contextLength ONLY from actual model_info context-length fields; unknown stats null', async () => {
  const { catalog, fetch } = catalogWith((call) => {
    if (call.input.endsWith('/api/show')) {
      return jsonResponse(200, SHOW_BODY);
    }
    return jsonResponse(200, TAGS_BODY);
  });
  const result = await catalog.details('glm-5.3-flash');
  assert.equal(result.status, 'ok');
  const details = result.details;
  assert.ok(details !== undefined);
  assert.equal(details?.contextLength, 131072, 'from the real glm.context_length field only');
  assert.deepEqual([...(details?.capabilities ?? [])], ['completion', 'tools', 'insert']);
  assert.equal(details?.parameterSize, '5.3B');
  assert.equal(details?.thinking, true);
  // show POST carries ONLY the model id (never a key in the body/URL).
  const showCall = fetch.calls.find((call) => call.input.endsWith('/api/show'));
  assert.ok(showCall !== undefined);
  assert.equal(showCall.input, 'https://ollama.example/api/show');
  assert.equal(String(showCall.init?.body), JSON.stringify({ model: 'glm-5.3-flash' }));
});

test('catalog details: absent fields stay null (never guessed from architecture names)', async () => {
  const { catalog, fetch: _f } = catalogWith((call) => {
    if (call.input.endsWith('/api/show')) {
      return jsonResponse(200, {
        details: {},
        model_info: {
          'general.architecture': 'gemma3',
          'gemma3.block_count': 34,
        },
      });
    }
    return jsonResponse(200, TAGS_BODY);
  });
  const result = await catalog.details('unknown-ish:1b');
  assert.deepEqual(result.details, {
    contextLength: null,
    capabilities: null,
    parameterSize: null,
    thinking: null,
  });
  // A model_info WITHOUT a context-length suffix must not leak other numbers.
  assert.equal(result.details?.contextLength, null);
});

test('catalog details: upstream miss maps to not-found; failures to unavailable', async () => {
  const { catalog: missing } = catalogWith((call) => {
    if (call.input.endsWith('/api/show')) {
      return jsonResponse(404, { error: 'not found' });
    }
    return jsonResponse(200, TAGS_BODY);
  });
  assert.deepEqual(await missing.details('nope:1'), { status: 'not-found' });
  const { catalog: failing } = catalogWith((call) => {
    if (call.input.endsWith('/api/show')) {
      throw new Error('boom');
    }
    return jsonResponse(200, TAGS_BODY);
  });
  await assert.rejects(() => failing.details('nope:1'), (error: { name: string }) => error.name === 'ModelCatalogUnavailableError');
});

test('catalog details cache: 6-hours TTL per model id + single-flight per id; other ids fetch independently', async () => {
  let clock = 1_000_000;
  let showCalls = 0;
  const fetch: FetchLike = async (input) => {
    if (String(input).endsWith('/api/show')) {
      showCalls += 1;
    }
    return jsonResponse(200, SHOW_BODY);
  };
  const { catalog } = catalogWith(() => jsonResponse(200, TAGS_BODY), { fetch, now: () => clock });
  const [first, second] = await Promise.all([catalog.details('glm-5.3-flash'), catalog.details('glm-5.3-flash')]);
  assert.equal(showCalls, 1, 'single-flight per id');
  assert.equal(first, second, 'same cached object');
  clock += 6 * 60 * 60 * 1000 + 1;
  await catalog.details('glm-5.3-flash');
  assert.equal(showCalls, 2, 'TTL expiry refetches');
  await catalog.details('other:1');
  assert.equal(showCalls, 3, 'other ids fetch independently');
});

test('catalog details bounded concurrency: at most 4 upstream show calls in flight', async () => {
  const inFlight: { current: number; max: number } = { current: 0, max: 0 };
  const fetch: FetchLike = async (_input, _init) => {
    inFlight.current += 1;
    inFlight.max = Math.max(inFlight.max, inFlight.current);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight.current -= 1;
    return jsonResponse(200, SHOW_BODY);
  };
  const { catalog } = catalogWith(() => jsonResponse(200, TAGS_BODY), { fetch });
  await Promise.all([
    catalog.details('a:1'),
    catalog.details('b:1'),
    catalog.details('c:1'),
    catalog.details('d:1'),
    catalog.details('e:1'),
    catalog.details('f:1'),
    catalog.details('g:1'),
  ]);
  assert.equal(inFlight.max, 4, 'the semaphore bounds concurrent upstream calls');
});

test('runtime factory: per-model creation with includeUsage, cached instances, bounded cache', () => {
  const factory = createRuntimeModelFactory({
    baseUrl: 'https://ollama.example/v1',
    apiKey: 'test-only-not-a-real-key',
  });
  const a1 = factory.modelFor('model-a');
  const a2 = factory.modelFor('model-a');
  const b = factory.modelFor('model-b');
  assert.equal(a1, a2, 'same model id reuses the client');
  assert.notEqual(a1, b, 'different ids create distinct clients');
  assert.equal((a1 as { provider?: string }).provider, 'ollama.chat', 'the compatible provider surfaces in the model metadata');
  // Bounded cache: 64 entries, FIFO eviction of the oldest.
  for (let index = 0; index < 70; index += 1) {
    factory.modelFor(`model-${String(index)}`);
  }
  const evicted = factory.modelFor('model-a');
  assert.notEqual(evicted, a1, 'evicted ids are recreated');
  assert.throws(() => factory.modelFor('bad/id'), /Invalid model id/);
});
