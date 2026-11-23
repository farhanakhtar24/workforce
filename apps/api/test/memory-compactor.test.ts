/**
 * Unit tests for the Ollama compactor — `generateText` against mock models.
 * No network, no real Ollama, no provider bodies logged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type { MemoryCompactionRequest } from '@workforce/core/memory';
import {
  COMPACTION_MAX_OUTPUT_TOKENS,
  COMPACTION_TIMEOUT_MS,
  CompactionOutputError,
  buildCompactionPrompt,
  createOllamaCompactor,
} from '../src/memory/ollama-compactor.js';
import { mockUsage } from './helpers.js';

function compactionRequest(): MemoryCompactionRequest {
  return {
    scope: 'default',
    path: 'projects/atlas',
    triggerBlockId: '00000000-0000-4000-8000-000000000001',
    blocks: [
      { id: 'b1', content: 'Atlas runs Postgres 16.', confidence: 0.9 } as never,
      { id: 'b2', content: 'Atlas runs Postgres 18.', confidence: 1.0 } as never,
    ],
  };
}

/** Returns the fixed summary text from doGenerate with a unified finish reason. */
function textModel(
  text: string,
  finishReason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' = 'stop',
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-compactor',
    doGenerate: async () => ({
      finishReason: { unified: finishReason, raw: undefined },
      content: [{ type: 'text', text }],
      usage: mockUsage(),
      warnings: [],
    }),
  });
}

test('compactor returns the model text trimmed', async () => {
  const compactor = createOllamaCompactor({ model: textModel('  Atlas has run Postgres 18 since sprint 4.  ') });
  const summary = await compactor.compact(compactionRequest());
  assert.equal(summary, 'Atlas has run Postgres 18 since sprint 4.');
});

test('compactor returns valid output at the 1000-char boundary', async () => {
  const atLimit = 'a'.repeat(1000);
  const compactor = createOllamaCompactor({ model: textModel(`  ${atLimit} `) });
  const summary = await compactor.compact(compactionRequest());
  assert.equal(summary, atLimit);
});

test('compactor never falls back to reasoningText and validates whitespace output (stop)', async () => {
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-compactor',
    doGenerate: async () => {
      // Whitespace-only text with a plain stop finish: the model answered,
      // the answer is just empty after trimming.
      return {
        finishReason: { unified: 'stop', raw: undefined },
        content: [{ type: 'reasoning', text: '   ' }, { type: 'text', text: ' \n\t ' }],
        usage: { ...mockUsage(), outputTokens: { total: 3, text: 0, reasoning: 3 } },
        warnings: [],
      } as never;
    },
  });
  const compactor = createOllamaCompactor({ model });
  let thrownError: unknown;
  await assert.rejects(
    () => compactor.compact(compactionRequest()),
    (thrown: unknown) => {
      thrownError = thrown;
      assert.ok(thrown instanceof CompactionOutputError);
      assert.equal(thrown.code, 'COMPACTION_EMPTY_OUTPUT_STOP');
      return true;
    },
  );
  const error = thrownError as unknown as CompactionOutputError;
  assert.match(error.message, /1\.\.1000 characters/);
  // Fixed safe surface only.
  assert.equal(error.name, 'CompactionOutputError');
});

test('compactor maps empty output with finishReason length to COMPACTION_EMPTY_OUTPUT_LENGTH', async () => {
  const compactor = createOllamaCompactor({ model: textModel('', 'length') });
  await assert.rejects(
    () => compactor.compact(compactionRequest()),
    (thrown: unknown) => {
      assert.ok(thrown instanceof CompactionOutputError);
      assert.equal(thrown.code, 'COMPACTION_EMPTY_OUTPUT_LENGTH');
      return true;
    },
  );
});

test('compactor maps whitespace output with finishReason stop to COMPACTION_EMPTY_OUTPUT_STOP', async () => {
  const compactor = createOllamaCompactor({ model: textModel('   \n ', 'stop') });
  await assert.rejects(
    () => compactor.compact(compactionRequest()),
    (thrown: unknown) => {
      assert.ok(thrown instanceof CompactionOutputError);
      assert.equal(thrown.code, 'COMPACTION_EMPTY_OUTPUT_STOP');
      return true;
    },
  );
});

test('compactor maps 1001-char output to COMPACTION_OUTPUT_TOO_LONG and exposes no output content', async () => {
  const sentinel = 'LOREM-IPSUM-MARKER';
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-compactor',
    doGenerate: async () => ({
      finishReason: { unified: 'length', raw: undefined },
      content: [{ type: 'text', text: `${sentinel}${'x'.repeat(995)}` }],
      usage: mockUsage(),
      warnings: [],
    }),
  });
  const compactor = createOllamaCompactor({ model });
  await assert.rejects(
    () => compactor.compact(compactionRequest()),
    (thrown: unknown) => {
      assert.ok(thrown instanceof CompactionOutputError);
      assert.equal(thrown.code, 'COMPACTION_OUTPUT_TOO_LONG');
      // Fixed message, fixed name: no output text, no source text, no URLs.
      assert.equal(thrown.name, 'CompactionOutputError');
      assert.ok(!thrown.message.includes('LOREM-IPSUM-MARKER'));
      assert.ok(!thrown.message.includes('xxxxx'));
      assert.ok(!thrown.message.includes('Atlas runs Postgres'));
      assert.ok(!thrown.message.includes('http'));
      assert.ok(!('cause' in thrown));
      return true;
    },
  );
});

/** Shared prompt-text extraction used by multi-call capture tests. */
function capturedPromptText(options: { prompt: unknown }): string {
  const messages = options.prompt as ReadonlyArray<{
    content: string | ReadonlyArray<{ type: string; text?: string }>;
  }>;
  const firstMessage = messages.at(0);
  const firstPart = typeof firstMessage?.content === 'string'
    ? undefined
    : Array.isArray(firstMessage?.content)
      ? firstMessage.content[0]
      : undefined;
  return firstPart?.type === 'text' ? (firstPart.text ?? '') : JSON.stringify(options.prompt);
}

test('compactor prompt carries oldest block contents, scope/path, and plain-text rules', async () => {
  let capturedPrompt = '';
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-compactor',
    doGenerate: async (options) => {
      // generateText (no system tooling) sends one plain prompt.
      const firstMessage = options.prompt.at(0);
      const firstPart = typeof firstMessage?.content === 'string'
        ? undefined
        : Array.isArray(firstMessage?.content)
          ? firstMessage.content[0]
          : undefined;
      capturedPrompt = firstPart?.type === 'text' ? firstPart.text : JSON.stringify(options.prompt);
      return {
        finishReason: { unified: 'stop', raw: undefined },
        content: [{ type: 'text', text: 'summary' }],
        usage: mockUsage(),
        warnings: [],
      };
    },
  });
  const compactor = createOllamaCompactor({ model });
  const summary = await compactor.compact(compactionRequest());
  assert.equal(summary, 'summary');
  assert.ok(capturedPrompt.includes('Atlas runs Postgres 16.'));
  assert.ok(capturedPrompt.includes('Atlas runs Postgres 18.'));
  assert.ok(capturedPrompt.includes('projects/atlas'));
  assert.ok(capturedPrompt.includes('default'));
  assert.ok(capturedPrompt.includes('no JSON'));
  assert.ok(capturedPrompt.includes('1000'));
  assert.ok(capturedPrompt.includes('500-700'));
  // Prompt asks for plain text, never JSON/structured output/tools.
  assert.ok(!capturedPrompt.includes('tool_choice'));
  // Synthesis framing, not the overlong "keep every fact" framing.
  assert.ok(capturedPrompt.includes('Synthesize'));
  assert.ok(!capturedPrompt.includes('Keep every fact'));
});

test('valid first draft returns after exactly one provider call', async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-compactor',
    doGenerate: async () => {
      calls += 1;
      return {
        finishReason: { unified: 'stop', raw: undefined },
        content: [{ type: 'text', text: 'summary' }],
        usage: mockUsage(),
        warnings: [],
      };
    },
  });
  const compactor = createOllamaCompactor({ model });
  const summary = await compactor.compact(compactionRequest());
  assert.equal(summary, 'summary');
  assert.equal(calls, 1);
});

test('overlong first draft triggers exactly one repair call with the draft only', async () => {
  const draft = 'DRAFT-MARKER' + 'x'.repeat(1200);
  const calls: Array<{ prompt: string; abortSignal?: AbortSignal; options: unknown }> = [];
  let call = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-compactor',
    doGenerate: async (options) => {
      call += 1;
      calls.push({
        prompt: capturedPromptText(options),
        abortSignal: options.abortSignal,
        options: {
          providerOptions: options.providerOptions,
          maxOutputTokens: options.maxOutputTokens,
          temperature: options.temperature,
          tools: options.tools,
          toolChoice: options.toolChoice,
        },
      });
      return {
        finishReason: { unified: 'stop', raw: undefined },
        content: [{ type: 'text', text: call === 1 ? draft : 'tight synthesis' }],
        usage: mockUsage(),
        warnings: [],
      };
    },
  });
  const compactor = createOllamaCompactor({ model });
  const summary = await compactor.compact(compactionRequest());
  assert.equal(summary, 'tight synthesis');
  // Exactly one extra call: never a third call, never a resend of sources.
  assert.equal(calls.length, 2);
  // Repair prompt: carries the overlong draft, the 500-700 target and the
  // hard 1000 limit, and none of the source-block text (the draft does not
  // contain it either, so any source leak would be detectable).
  const repairPrompt = calls[1]!.prompt;
  assert.ok(repairPrompt.includes('DRAFT-MARKER'));
  assert.ok(repairPrompt.includes('500-700'));
  assert.ok(repairPrompt.includes(String(1000)));
  assert.ok(!repairPrompt.includes('Atlas runs Postgres 16.'));
  assert.ok(!repairPrompt.includes('Atlas runs Postgres 18.'));
  // Both calls share the SAME abort signal object and identical generation
  // options.
  assert.ok(calls[0]!.abortSignal instanceof AbortSignal);
  assert.equal(calls[1]!.abortSignal, calls[0]!.abortSignal);
  assert.deepEqual(calls[1]!.options, calls[0]!.options);
});

test('draft overlong twice fails COMPACTION_OUTPUT_TOO_LONG after exactly two calls', async () => {
  const firstSentinel = 'FIRST-LOREM-MARKER';
  const repairSentinel = 'REPAIR-LOREM-MARKER';
  let call = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-compactor',
    doGenerate: async () => {
      call += 1;
      return {
        finishReason: { unified: 'length', raw: undefined },
        content: [{ type: 'text', text: `${call === 1 ? firstSentinel : repairSentinel}${'x'.repeat(1100)}` }],
        usage: mockUsage(),
        warnings: [],
      };
    },
  });
  const compactor = createOllamaCompactor({ model });
  await assert.rejects(
    () => compactor.compact(compactionRequest()),
    (thrown: unknown) => {
      assert.ok(thrown instanceof CompactionOutputError);
      assert.equal(thrown.code, 'COMPACTION_OUTPUT_TOO_LONG');
      assert.equal(thrown.name, 'CompactionOutputError');
      // Fixed safe surface only: draft, source text, URLs, cause absent.
      assert.ok(!thrown.message.includes('FIRST-LOREM-MARKER'));
      assert.ok(!thrown.message.includes('REPAIR-LOREM-MARKER'));
      assert.ok(!thrown.message.includes('xxxxx'));
      assert.ok(!thrown.message.includes('Atlas runs Postgres'));
      assert.ok(!thrown.message.includes('http'));
      assert.ok(!('cause' in thrown));
      return true;
    },
  );
  assert.equal(call, 2);
});

test('overlong first then empty second keeps deterministic empty codes (2 calls)', async () => {
  const draft = 'y'.repeat(1100);
  for (const finishReason of ['length', 'stop'] as const) {
    let call = 0;
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-compactor',
      doGenerate: async () => {
        call += 1;
        return {
          finishReason: { unified: call === 1 ? 'stop' : finishReason, raw: undefined },
          content: [{ type: 'text', text: call === 1 ? draft : '   ' }],
          usage: { ...mockUsage(), outputTokens: { total: 3, text: 0, reasoning: 3 } },
          warnings: [],
        };
      },
    });
    const compactor = createOllamaCompactor({ model });
    await assert.rejects(
      () => compactor.compact(compactionRequest()),
      (thrown: unknown) => {
        assert.ok(thrown instanceof CompactionOutputError);
        assert.equal(
          thrown.code,
          finishReason === 'length'
            ? 'COMPACTION_EMPTY_OUTPUT_LENGTH'
            : 'COMPACTION_EMPTY_OUTPUT_STOP',
        );
        return true;
      },
    );
    assert.equal(call, 2);
  }
});

test('compactor passes a bounded abort signal (120s) and no tool options', async () => {
  let capturedAbortSignal: AbortSignal | undefined;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-compactor',
    doGenerate: async (options) => {
      capturedAbortSignal = options.abortSignal;
      return {
        finishReason: { unified: 'stop', raw: undefined },
        content: [{ type: 'text', text: 'summary' }],
        usage: mockUsage(),
        warnings: [],
      };
    },
  });
  const compactor = createOllamaCompactor({ model });
  const summary = await compactor.compact(compactionRequest());
  assert.equal(summary, 'summary');
  // AbortSignal.timeout's timer does not keep the event loop alive: no fake
  // timers, no hang.
  assert.ok(capturedAbortSignal instanceof AbortSignal);
  assert.equal(capturedAbortSignal?.aborted, false);
  assert.equal(COMPACTION_TIMEOUT_MS, 120_000);
});

test('compactor generation contract: low reasoning effort, token cap, low temperature, no tools', async () => {
  let captured: {
    providerOptions?: unknown;
    maxOutputTokens?: number | null;
    temperature?: number | undefined;
    tools?: unknown;
    toolChoice?: unknown;
  } = {};
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-compactor',
    doGenerate: async (options) => {
      captured = {
        providerOptions: options.providerOptions,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        tools: options.tools,
        toolChoice: options.toolChoice,
      };
      return {
        finishReason: { unified: 'stop', raw: undefined },
        content: [{ type: 'text', text: 'summary' }],
        usage: mockUsage(),
        warnings: [],
      };
    },
  });
  const compactor = createOllamaCompactor({ model });
  await compactor.compact(compactionRequest());
  // glm-5.3-flash: reasoning always on, documented efforts low/high/max.
  // `low` is the deterministic/fast choice for short memory summaries.
  assert.deepEqual(captured.providerOptions, { ollama: { reasoningEffort: 'low' } });
  assert.equal(captured.maxOutputTokens, COMPACTION_MAX_OUTPUT_TOKENS);
  // Reasoning tokens share the output budget; the 1000-char answer needs headroom.
  assert.equal(captured.maxOutputTokens, 8_000);
  assert.equal(captured.temperature, 0.2);
  // No tool calling, no structured output on the compaction path.
  assert.equal(captured.tools === undefined, true);
  assert.equal(captured.toolChoice === undefined, true);
});

test('compactor propagates provider failures as thrown errors (never logs bodies)', async () => {
  const failing: LanguageModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-compactor-failing',
    doGenerate: async () => {
      throw new Error('provider unavailable');
    },
  }) as unknown as LanguageModel;
  const compactor = createOllamaCompactor({ model: failing });
  await assert.rejects(() => compactor.compact(compactionRequest()), /provider unavailable/);
});
