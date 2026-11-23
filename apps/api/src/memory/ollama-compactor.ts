/**
 * Ollama-backed `MemoryCompactor` (Phase 3).
 *
 * Contract with the core service:
 * - Input is the OLDEST active blocks of one exact (scope, path) plus a
 *   trigger block id. Output must be a PLAIN TEXT factual summary; the core
 *   service trims it and enforces 1..1000 characters. This module also
 *   classifies its own output defects (empty / overlong) with safe fixed
 *   codes before returning, so the failure cause is visible without any
 *   summary text in logs.
 * - `generateText` only: no structured output, no tool calls, no JSON. The
 *   prompt demands plain prose.
 * - Never logs request contents or provider response bodies: the only
 *   logging-adjacent behavior is throwing the original error, which callers
 *   log by safe type/code only.
 */
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { MemoryCompactionRequest, MemoryCompactor } from '@workforce/core/memory';

/** Hard char budget the core service also enforces after trimming. */
const MAX_SUMMARY_CHARS = 1000;

/** Upper bound for one compaction LLM call (the store lock waits for it). */
export const COMPACTION_TIMEOUT_MS = 120_000;

/**
 * Output token budget for one plain summary. glm-5.3-flash reasoning is always
 * ON and reasoning tokens share the same output budget as the answer: with a
 * too-small cap the model can spend the whole budget thinking and finish with
 * `finishReason: 'length'` before emitting any summary text. The final answer
 * is capped at ${MAX_SUMMARY_CHARS} characters, so the generous headroom keeps
 * reasoning plus the plain summary inside one bounded call.
 */
export const COMPACTION_MAX_OUTPUT_TOKENS = 8_000;

/**
 * Fixed-vocabulary codes for deterministic compaction output failures. They
 * match core's safe cause classifier pattern so BullMQ `failedReason` shows
 * the uppercase code; the raw summary text is never attached to the error.
 */
export type CompactionOutputErrorCode =
  | 'COMPACTION_EMPTY_OUTPUT_LENGTH'
  | 'COMPACTION_EMPTY_OUTPUT_STOP'
  | 'COMPACTION_OUTPUT_TOO_LONG';

/**
 * Dedicated validation failure for the compactor's own output contract.
 * Message and name are FIXED and safe for logs/BullMQ `failedReason`: never
 * the raw summary text, prompt, source blocks, provider response bodies,
 * URLs, headers, or stacks. The deterministic `code` is the only variable.
 */
export class CompactionOutputError extends Error {
  /** Fixed safe code, surfaced by core's `classifyProviderCause`. */
  readonly code: CompactionOutputErrorCode;

  constructor(code: CompactionOutputErrorCode) {
    super(
      'memory compaction output failed validation: plain text summary of 1..1000 characters after trimming required',
    );
    this.name = 'CompactionOutputError';
    this.code = code;
  }
}

export interface OllamaCompactorOptions {
  model: LanguageModel;
}

export interface OllamaCompactor extends MemoryCompactor {}

/**
 * Plain-text summary prompt. Block contents are quoted verbatim; the
 * instructions demand a factual summary that preserves current facts, latest
 * corrections, decisions, and stated uncertainty.
 */
export function buildCompactionPrompt(request: MemoryCompactionRequest): string {
  const contents = request.blocks
    .map((block, index) => `${index + 1}. ${block.content}`)
    .join('\n');
  return [
    'You are compacting a project memory path into a single factual summary.',
    '',
    `Scope: ${request.scope}`,
    `Path: ${request.path}`,
    `Source blocks: ${request.blocks.length} (listed oldest first below)`,
    '',
    'Source block contents:',
    contents,
    '',
    'Write ONE plain-text summary of the source blocks:',
    '- Keep every fact, correction, decision, preference, and stated uncertainty that is currently true.',
    '- Drop superseded or outdated details resolved by newer blocks.',
    '- Target 700-900 characters so the response stays below the hard limit.',
    '- At most ' + String(MAX_SUMMARY_CHARS) + ' characters.',
    '- Plain text only: no JSON, no markdown headings, no code fences, no lists, no tool calls.',
    '- Output only the summary text.',
  ].join('\n');
}

/** Builds a `MemoryCompactor` that asks the model for a plain summary. */
export function createOllamaCompactor(options: OllamaCompactorOptions): OllamaCompactor {
  const { model } = options;
  return {
    compact: async (request: MemoryCompactionRequest): Promise<string> => {
      const result = await generateText({
        model,
        prompt: buildCompactionPrompt(request),
        maxRetries: 0,
        // Reasoning tokens share the output budget; see
        // COMPACTION_MAX_OUTPUT_TOKENS above.
        maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
        temperature: 0.2,
        // Bounded call: the compaction runs under the store's path lock, so a
        // hung provider must not hold it forever. Plain text only — no
        // structured output, no tools.
        abortSignal: AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
        // glm-5.3-flash reasoning is ALWAYS ON; only low/high/max efforts are
        // documented. `low` keeps the compactor fast and deterministic.
        providerOptions: { ollama: { reasoningEffort: 'low' } },
      });
      // Validate the model's text before returning: the core service enforces
      // 1..1000 chars after trimming, and failing there loses which side of
      // the contract broke. Classify deterministically here instead.
      // `result.reasoningText` is never a substitute for the summary.
      const summary = result.text.trim();
      if (summary.length >= 1 && summary.length <= MAX_SUMMARY_CHARS) {
        return summary;
      }
      if (summary.length === 0) {
        // Empty output: budget exhaustion (`length`) points at the reasoning
        // headroom problem; any other finish reason (stop, error,
        // content-filter, other) is a separate fixed code.
        throw new CompactionOutputError(
          result.finishReason === 'length'
            ? 'COMPACTION_EMPTY_OUTPUT_LENGTH'
            : 'COMPACTION_EMPTY_OUTPUT_STOP',
        );
      }
      // Overlong output: never silently truncated (core would otherwise catch
      // it, but with the same code as every other contract failure).
      throw new CompactionOutputError('COMPACTION_OUTPUT_TOO_LONG');
    },
  };
}
