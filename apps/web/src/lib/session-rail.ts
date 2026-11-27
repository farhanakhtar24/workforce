/**
 * Pure helpers for the Session context rail (Farhan's request 5): real data
 * only — latest assistant metadata for context-/turn-usage, tool counts from
 * actual parts, and the bounded latest-request context percentage. Nothing
 * cumulative is ever invented; unknown values are `null`.
 */

import type { UsageModelBucket } from './chat-usage';

/**
 * True when cached details genuinely belong to the model that served the
 * latest turn (prevents mixing models in the context metric).
 */
export function detailsModelPercentSource<D extends { readonly modelId: string }>(
  details: Readonly<D> | null | undefined,
  expectedModelId: string | null,
): { readonly contextLength: unknown; readonly modelId: string } | null {
  if (details === undefined || details === null) return null;
  if (expectedModelId === null) return null;
  if (details.modelId !== expectedModelId) return null;
  const loose = details as unknown as Record<string, unknown>;
  return {
    contextLength: loose['contextLength'] ?? null,
    modelId: expectedModelId,
  };
}

/**
 * Percent wrapper for the rail: never mixes models — `source` must already
 * be validated to belong to the latest turn's actual model.
 */
export function contextModelPercent(
  usageRail: { readonly inputTokens: number } | null,
  source: { readonly contextLength: unknown } | null,
): number | null {
  if (source === null) return null;
  return contextPercent(usageRail === null ? null : usageRail.inputTokens, source.contextLength);
}

/** Latest-request context percentage; unknown when either side is missing. */
export function contextPercent(
  inputTokens: unknown,
  contextLength: unknown,
): number | null {
  if (
    typeof inputTokens !== 'number' ||
    !Number.isInteger(inputTokens) ||
    inputTokens < 0 ||
    inputTokens > 2_147_483_647
  ) {
    return null;
  }
  if (
    typeof contextLength !== 'number' ||
    !Number.isInteger(contextLength) ||
    contextLength <= 0
  ) {
    return null;
  }
  if (inputTokens === 0) return 0;
  const pct = Math.round((inputTokens / contextLength) * 100);
  if (pct < 0) return 0;
  return Math.min(pct, 100);
}

export interface RailMessageLike {
  readonly role: string;
  readonly parts: ReadonlyArray<unknown>;
}

export interface RailUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number | null;
  readonly modelId: string | null;
}

interface MetadataLike {
  readonly usage?: unknown;
  readonly modelId?: unknown;
}

/** Strict per-message usage read (camelCase only, as the API persists). */
function readUsage(message: unknown): RailUsage | null {
  if (message === null || typeof message !== 'object') return null;
  const meta = (message as { metadata?: unknown }).metadata;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const record = meta as MetadataLike;
  const usage = record.usage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const block = usage as Record<string, unknown>;
  const bounded = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 2_147_483_647 ? v : undefined;
  const input = bounded(block['inputTokens']);
  const output = bounded(block['outputTokens']);
  const total = bounded(block['totalTokens']);
  if (input === undefined && output === undefined && total === undefined) return null;
  const modelId =
    typeof record.modelId === 'string' && record.modelId.trim() !== ''
      ? record.modelId.trim()
      : null;
  const inVal = input ?? 0;
  const outVal = output ?? 0;
  const totalVal = total !== undefined ? total : input !== undefined && output !== undefined ? inVal + outVal : null;
  return { inputTokens: inVal, outputTokens: outVal, totalTokens: totalVal, modelId };
}

/** Latest assistant message usage (latest-turn card); null when none. */
export function latestAssistantUsage(messages: ReadonlyArray<RailMessageLike>): RailUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const usage = readUsage(message);
    return usage;
  }
  return null;
}

/** Real tool-part count from the latest assistant's actual parts (no guess). */
export function countToolParts(parts: ReadonlyArray<unknown>): number {
  let count = 0;
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    const type = (part as { type?: unknown }).type;
    if (typeof type === 'string' && type.startsWith('tool-')) {
      // The pending ask_user is the HITL question card, not tool activity.
      if (type === 'tool-ask_user' && (part as { state?: unknown }).state === 'input-available') {
        continue;
      }
      count += 1;
    }
  }
  return count;
}

/** Compact one-line bucket for the rail (name honest for legacy rows). */
export function railBucketLine(bucket: UsageModelBucket): string {
  const model = bucket.modelId === '(unattributed)' ? 'unattributed' : bucket.modelId;
  return `${model} — ${bucket.inputTokens.toLocaleString('en-US')} in / ${bucket.outputTokens.toLocaleString('en-US')} out`;
}

export const RAIL_PROVIDER_LABEL = 'Ollama Cloud';

/** Rail state for an empty chat: honest zero/unknown — never fabricated. */
export const RAIL_EMPTY_TURN_TEXT = 'No turns yet — per-turn usage and tools appear after your first exchange.';

export { latestAssistantUsage as railUsageLatest };
