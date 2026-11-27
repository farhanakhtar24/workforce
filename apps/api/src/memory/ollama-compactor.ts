/**
 * Ollama-backed `MemoryCompactor` (Phase 3).
 *
 * Contract with the core service:
 * - Input is the OLDEST active blocks of one exact (scope, path) plus a
 *   trigger block id. Output must be a PLAIN TEXT factual summary; the core
 *   service trims it and enforces 1..1000 characters. This module also
 *   classifies its own output defects (empty / overlong) with safe fixed
 *   codes before returning, so the failure cause is visible without any
 *   summary text in logs. An overlong first draft gets exactly ONE bounded
 *   shortening retry that sees the draft only; both provider calls share one
 *   abort signal so total compaction work stays inside the timeout.
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

/**
 * Upper bound for the WHOLE compaction provider interaction (the store lock
 * waits for it): the first summary call and the optional repair call share
 * ONE abort signal created before the first call.
 */
export const COMPACTION_TIMEOUT_MS = 120_000;

/**
 * Output token budget for one plain summary. glm-5.3-flash reasoning is always
 * ON and reasoning tokens share the same output budget as the answer: with a
 * too-small cap the model can spend the whole budget thinking and finish with
 * `finishReason: 'length'` before emitting any summary text. The final answer
 * is capped at ${MAX_SUMMARY_CHARS} characters, so the generous headroom keeps
 * reasoning plus the plain summary inside one bounded provider interaction.
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

/** Dollar-only budget reservation hook (pre-Phase 6 hourly budget). */
export interface CompactionBudgetHook {
  /**
   * Reserves DOLLARS (never a request count) under the owner's rolling
   * window before any provider work. Denial/unpriced MUST throw a typed
   * fixed error (BullMQ owns the retry backoff): the compact call must NEVER
   * continue to the provider after a denied reservation. Transient failures
   * also rethrow (fail closed, safe retry).
   */
  reserve(input: { scope: string; path: string; triggerBlockId: string; sourceCharCount: number; blockCount: number }): Promise<void>;
}

export interface OllamaCompactorOptions {
  model: LanguageModel;
  /** DOLLAR-only hourly-budget hook; absent = legacy unreserved behavior. */
  budget?: CompactionBudgetHook;
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
    '- Synthesize the CURRENT conclusions, corrections, decisions, preferences, and stated uncertainty from the blocks.',
    '- Omit redundancy and any detail already captured by the conclusions; drop superseded or outdated details resolved by newer blocks.',
    '- Target 500-700 characters so the response stays below the hard limit.',
    '- At most ' + String(MAX_SUMMARY_CHARS) + ' characters.',
    '- Plain text only: no JSON, no markdown headings, no code fences, no lists, no tool calls.',
    '- Output only the summary text.',
  ].join('\n');
}

/**
 * Prompt for the single overlong-output repair pass: it receives ONLY the
 * overlong draft (never the source blocks) and asks for a shorter plain-text
 * rewrite with the same hard limit. Pure helper kept separately so the
 * first-call prompt builder stays untouched.
 */
export function buildCompactionRepairPrompt(draft: string): string {
  return [
    'You are shortening one overlong memory summary draft into its final form.',
    '',
    'Overlong draft:',
    draft,
    '',
    'Rewrite the draft as ONE shorter plain-text summary:',
    '- Preserve the current conclusions, corrections, decisions, preferences, and stated uncertainty.',
    '- Remove redundancy and merge repeated details.',
    '- Target 500-700 characters so the response stays below the hard limit.',
    '- At most ' + String(MAX_SUMMARY_CHARS) + ' characters.',
    '- Plain text only: no JSON, no markdown headings, no code fences, no lists, no tool calls.',
    '- Output only the summary text.',
  ].join('\n');
}

/**
 * Deterministic empty-output classification: budget exhaustion (`length`)
 * points at the reasoning headroom problem; any other finish reason (stop,
 * error, content-filter, other) is a separate fixed code.
 */
function classifyEmptyOutput(finishReason: string): CompactionOutputErrorCode {
  return finishReason === 'length'
    ? 'COMPACTION_EMPTY_OUTPUT_LENGTH'
    : 'COMPACTION_EMPTY_OUTPUT_STOP';
}

/** Builds a `MemoryCompactor` that asks the model for a plain summary. */
export function createOllamaCompactor(options: OllamaCompactorOptions): OllamaCompactor {
  const { model, budget } = options;
  return {
    compact: async (request: MemoryCompactionRequest): Promise<string> => {
      // DOLLAR-ONLY budget reservation (pre-Phase 6 hourly budget): before
      // any provider work, attribute the compaction's conservative cost to
      // the owning user (never a request count). Best-effort: failures log
      // and never break the compaction job. Unknown/unlinked scopes (legacy
      // anonymous memory) are simply not budget-attributable.
      if (budget !== undefined) {
        // FAIL CLOSED: a denied/unpriced/failed reservation propagates as a
        // typed, fixed-safe error so BullMQ retries the JOB — the provider is
        // never called without a reservation. The dedupe key (scope/path/
        // triggerBlockId) makes BullMQ retries idempotent.
        const sourceCharCount = request.blocks.reduce<number>((sum, block) => sum + block.content.length, 0);
        await budget.reserve({
          scope: request.scope,
          path: request.path,
          triggerBlockId: request.triggerBlockId,
          sourceCharCount,
          blockCount: request.blocks.length,
        });
      }
      // Both provider calls (first summary + optional repair) share ONE abort
      // signal created before the first call: total compaction provider work
      // stays bounded at COMPACTION_TIMEOUT_MS instead of the timeout per
      // call. Bounded: the compaction runs under the store's path lock, so a
      // hung provider must not hold it forever. Plain text only — no
      // structured output, no tools.
      const abortSignal = AbortSignal.timeout(COMPACTION_TIMEOUT_MS);
      const generationOptions = () => ({
        model,
        maxRetries: 0,
        // Reasoning tokens share the output budget; see
        // COMPACTION_MAX_OUTPUT_TOKENS above.
        maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
        temperature: 0.2,
        abortSignal,
        // glm-5.3-flash reasoning is ALWAYS ON; only low/high/max efforts are
        // documented. `low` keeps the compactor fast and deterministic.
        providerOptions: { ollama: { reasoningEffort: 'low' as const } },
      });
      // Validate the model's text before returning: the core service enforces
      // 1..1000 chars after trimming, and failing there loses which side of
      // the contract broke. Classify deterministically here instead.
      // `result.reasoningText` is never a substitute for the summary.
      const first = await generateText({
        ...generationOptions(),
        prompt: buildCompactionPrompt(request),
      });
      const firstSummary = first.text.trim();
      if (firstSummary.length >= 1 && firstSummary.length <= MAX_SUMMARY_CHARS) {
        // Valid first draft: done after one provider call, no repair pass.
        return firstSummary;
      }
      if (firstSummary.length === 0) {
        throw new CompactionOutputError(classifyEmptyOutput(first.finishReason));
      }
      // Overlong first draft: exactly ONE additional shortening call that sees
      // the draft only (never the source blocks), then classify its output the
      // same way. Never silently truncated, never a third call.
      const second = await generateText({
        ...generationOptions(),
        prompt: buildCompactionRepairPrompt(firstSummary),
      });
      const summary = second.text.trim();
      if (summary.length >= 1 && summary.length <= MAX_SUMMARY_CHARS) {
        return summary;
      }
      if (summary.length === 0) {
        throw new CompactionOutputError(classifyEmptyOutput(second.finishReason));
      }
      // Still overlong after the repair pass: never silently truncated (core
      // would otherwise catch it, but with the same code as every other
      // contract failure).
      throw new CompactionOutputError('COMPACTION_OUTPUT_TOO_LONG');
    },
  };
}
