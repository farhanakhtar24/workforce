import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaClient } from './llm.js';
import type { Config } from './config.js';
import type {
  ChatMessage,
  ToolMessage,
  FunctionToolCall,
} from './types.js';

const config: Config = Object.freeze({
  apiKey: 'dummy-key-123',
  baseUrl: 'https://ollama.example/v1',
  model: 'test-model',
  timeoutMs: 1000,
});

const weatherTool = {
  name: 'get_weather',
  description: 'Get current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
} as const;

const baseMessages: readonly ChatMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Weather in Lisbon?' },
];

/** Build a Response carrying a JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function plainResponse(status: number, bodyText: string): Response {
  return new Response(bodyText, { status });
}

/** A complete, well-formed provider response. */
function okBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [
      {
        message: { role: 'assistant', content: 'Sunny, 24°C.' },
      },
    ],
    ...overrides,
  };
}

/** Fetch mock that records its inputs and returns `response`. */
function recordingFetch(
  response: Response,
  calls: Array<{ url: string; init: RequestInit }> = [],
): typeof fetch {
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response;
  };
  return impl;
}

test('sends correct url, method, auth, model, stream:false, wrapped tools and exact messages', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createOllamaClient(config, recordingFetch(jsonResponse(okBody()), calls));

  const history: readonly ChatMessage[] = [
    ...baseMessages,
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Lisbon"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'Sunny, 24°C.' } satisfies ToolMessage,
  ];

  await client.complete(history, [weatherTool]);

  assert.equal(calls.length, 1);
  const call = calls[0]!;

  assert.equal(call.url, 'https://ollama.example/v1/chat/completions');
  assert.equal(call.init.method, 'POST');

  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.Authorization, 'Bearer dummy-key-123');

  const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, history, 'messages must be passed through exactly');
  assert.deepEqual(body.tools, [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a city.',
        parameters: weatherTool.parameters,
      },
    },
  ]);
  // Ollama Cloud compatibility endpoint: neither field is supported.
  assert.ok(!('response_format' in body), 'must not send response_format');
  assert.ok(!('tool_choice' in body), 'must not send tool_choice');
});

test('maps assistant text and usage tokens to TokenUsage', async () => {
  const client = createOllamaClient(
    config,
    recordingFetch(
      jsonResponse(
        okBody({
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        }),
      ),
    ),
  );

  const result = await client.complete(baseMessages, []);

  assert.deepEqual(result.message, { role: 'assistant', content: 'Sunny, 24°C.' });
  assert.equal(result.usage?.promptTokens, 12);
  assert.equal(result.usage?.completionTokens, 7);
  assert.equal(result.usage?.totalTokens, 19);
});

test('returns usage undefined when provider omits it', async () => {
  const client = createOllamaClient(config, recordingFetch(jsonResponse(okBody())));
  const result = await client.complete(baseMessages, []);
  assert.equal(result.usage, undefined);
});

test('preserves multiple tool calls and raw argument strings exactly', async () => {
  const toolCalls = [
    {
      id: 'call_a',
      type: 'function',
      function: {
        name: 'get_weather',
        arguments: '{ "city": "Lisbon", "extra": [1, 2, 3] }',
      },
    },
    {
      id: 'call_b',
      type: 'function',
      function: {
        name: 'save_note',
        arguments: '{"note":"line1\\nline2","ok":true}',
      },
    },
  ] satisfies FunctionToolCall[];

  const client = createOllamaClient(
    config,
    recordingFetch(
      jsonResponse(
        okBody({
          choices: [{ message: { role: 'assistant', content: null, tool_calls: toolCalls } }],
        }),
      ),
    ),
  );

  const result = await client.complete(baseMessages, [weatherTool]);

  assert.equal(result.message.content, null);
  assert.ok(result.message.tool_calls, 'tool_calls must be present');
  assert.equal(result.message.tool_calls.length, 2);
  assert.deepEqual(result.message.tool_calls, toolCalls, 'tool calls must round-trip exactly');
  // Spacing and escapes inside the raw JSON argument strings survive.
  assert.equal(result.message.tool_calls[0]?.function.arguments, '{ "city": "Lisbon", "extra": [1, 2, 3] }');
  assert.equal(result.message.tool_calls[1]?.function.arguments, '{"note":"line1\\nline2","ok":true}');
});

test('non-2xx error includes status but never the API key', async () => {
  const client = createOllamaClient(
    config,
    recordingFetch(plainResponse(500, '{"error":{"message":"boom"}}')),
  );

  await assert.rejects(client.complete(baseMessages, []), (error: Error) => {
    assert.match(error.message, /HTTP 500/);
    assert.match(error.message, /boom/);
    assert.ok(!error.message.includes('dummy-key-123'), 'must never leak the API key');
    return true;
  });
});

test('non-2xx error truncates very long bodies to ~500 chars', async () => {
  const filler = 'x'.repeat(5000);
  const client = createOllamaClient(
    config,
    recordingFetch(plainResponse(429, filler)),
  );

  await assert.rejects(client.complete(baseMessages, []), (error: Error) => {
    assert.match(error.message, /HTTP 429/);
    const snippet = error.message.slice(error.message.indexOf(': ') + 2);
    assert.ok(snippet.length <= 510, `body snippet too long: ${snippet.length}`);
    return true;
  });
});

test('non-2xx error redacts a provider body that echoes the API key', async () => {
  const echoingBody = '{"error":{"message":"auth failed for key dummy-key-123 (bad credentials)"}}';
  const client = createOllamaClient(
    config,
    recordingFetch(plainResponse(401, echoingBody)),
  );

  await assert.rejects(client.complete(baseMessages, []), (error: Error) => {
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes('dummy-key-123'), 'echoed key must be redacted');
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test('HTTP-200 invalid-JSON error redacts a body that echoes the API key', async () => {
  const echoingBody = 'not json: request used key dummy-key-123';
  const client = createOllamaClient(
    config,
    recordingFetch(plainResponse(200, echoingBody)),
  );

  await assert.rejects(client.complete(baseMessages, []), (error: Error) => {
    assert.match(error.message, /invalid JSON/);
    assert.ok(!error.message.includes('dummy-key-123'), 'echoed key must be redacted');
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test('rejects malformed provider responses clearly', async () => {
  const cases: unknown[] = [
    // No choices at all.
    { choices: [] },
    // Not an assistant message.
    { choices: [{ message: { role: 'user', content: 'hi' } }] },
    // Missing content key entirely.
    { choices: [{ message: { role: 'assistant' } }] },
    // Tool call missing arguments string.
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x' } }],
          },
        },
      ],
    },
    // Usage present but malformed.
    {
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 'many' },
    },
  ];

  for (const body of cases) {
    const client = createOllamaClient(config, recordingFetch(jsonResponse(body)));
    await assert.rejects(
      client.complete(baseMessages, []),
      (error: Error) => /failed validation|no content and no tool calls/.test(error.message),
      `body should have been rejected: ${JSON.stringify(body)}`,
    );
  }

  // Invalid JSON at HTTP 200.
  const badJson = createOllamaClient(config, recordingFetch(plainResponse(200, 'not json')));
  await assert.rejects(badJson.complete(baseMessages, []), /invalid JSON/);
});

test('aborts after timeoutMs and throws a key-safe timeout error', async () => {
  const cfg: Config = { ...config, timeoutMs: 30 };
  let aborted = false;

  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('This operation was aborted', 'AbortError'));
      });
    });

  const client = createOllamaClient(cfg, fetchImpl);

  await assert.rejects(client.complete(baseMessages, []), (error: Error) => {
    assert.match(error.message, /timed out after 30ms/);
    assert.ok(!error.message.includes('dummy-key-123'), 'must never leak the API key');
    return true;
  });
  assert.ok(aborted, 'abort signal must have fired');
});

test('maps a stalled body read aborted after headers to the key-safe timeout error', async () => {
  const cfg: Config = { ...config, timeoutMs: 30 };

  // Deterministic: fetch resolves (headers arrived), but text() stays pending
  // until the request controller's abort signal fires, then rejects with an
  // AbortError — no server, no network, no timers beyond the client's own.
  const fetchImpl: typeof fetch = (_input, init) => {
    const signal = init?.signal;
    const stalled = {
      ok: true,
      status: 200,
      text: () =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        }),
    };
    return Promise.resolve(stalled as unknown as Response);
  };

  const client = createOllamaClient(cfg, fetchImpl);

  await assert.rejects(client.complete(baseMessages, []), (error: Error) => {
    assert.match(error.message, /timed out after 30ms/);
    assert.ok(!error.message.includes('dummy-key-123'), 'must never leak the API key');
    return true;
  });
});

test('non-abort fetch rejections propagate without leaking the key', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error('socket hang up');
  };
  const client = createOllamaClient(config, fetchImpl);

  await assert.rejects(client.complete(baseMessages, []), (error: Error) => {
    assert.match(error.message, /socket hang up/);
    assert.ok(!error.message.includes('dummy-key-123'), 'must never leak the API key');
    return true;
  });
});
