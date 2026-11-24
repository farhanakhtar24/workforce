/**
 * Bounded per-chat token accounting for the AUTHENTICATED usage endpoint.
 * Sums ONLY valid assistant `metadata.usage` blocks across that owner's
 * transcript, grouped by `metadata.modelId` (never guessed: unattributed
 * messages land in the documented `MODEL_USAGE_UNATTRIBUTED` bucket), and
 * computes `estimatedCostUsd` ONLY when the explicitly-configured
 * `OLLAMA_MODEL_PRICING_JSON` provides per-million `{input,output}` rates for
 * EVERY used model — prices are NEVER invented.
 */
import { MODEL_ID_PATTERN } from '../models/catalog.js';

/** Upper bound for a single usage counter (matches the generation contract). */
const MAX_USAGE_TOKEN_COUNT = 2_147_483_647;

/** Bucket for stored assistant messages that predate modelId provenance. */
export const MODEL_USAGE_UNATTRIBUTED = '(unattributed)';

export interface UsageModelBucket {
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly messages: number;
}

export interface ChatUsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly models: readonly UsageModelBucket[];
  readonly estimatedCostUsd: number | null;
  readonly costReason: 'priced' | 'pricing_not_configured' | 'partial';
}

export interface ModelPricing {
  readonly input: number;
  readonly output: number;
}

/** Valid per-message usage block (input/output/total, bounded ints). */
function validUsage(usage: unknown): { inputTokens: number; outputTokens: number; totalTokens: number; totalCarried: boolean } | null {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return null;
  }
  const record = usage as Record<string, unknown>;
  let sawField = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let totalCarried = false;
  const bounded = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_USAGE_TOKEN_COUNT) {
      sawField = true;
      return value;
    }
    return undefined;
  };
  const input = bounded(record['inputTokens'] ?? record['input_tokens']);
  if (input !== undefined) {
    inputTokens += input;
  }
  const output = bounded(record['outputTokens'] ?? record['output_tokens']);
  if (output !== undefined) {
    outputTokens += output;
  }
  const total = bounded(record['totalTokens'] ?? record['total_tokens']);
  if (total !== undefined) {
    totalTokens += total;
    totalCarried = true;
  } else {
    totalTokens += inputTokens + outputTokens;
  }
  if (!sawField) {
    return null;
  }
  return { inputTokens, outputTokens, totalTokens, totalCarried };
}

function storedModelId(metadata: Record<string, unknown>): string {
  const candidate = metadata['modelId'];
  if (typeof candidate === 'string' && MODEL_ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return MODEL_USAGE_UNATTRIBUTED;
}

/**
 * Rounds to 6 decimals to avoid float garbage without hiding magnitude.
 */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function summarizeChatUsage(
  stored: readonly unknown[],
  pricing: Readonly<Record<string, ModelPricing>> | null,
): ChatUsageSummary {
  const buckets = new Map<string, { inputTokens: number; outputTokens: number; totalTokens: number; messages: number }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const entry of stored) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const message = entry as Record<string, unknown>;
    if (message['role'] !== 'assistant') {
      continue;
    }
    const metadata = message['metadata'];
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      continue;
    }
    const record = metadata as Record<string, unknown>;
    const usage = validUsage(record['usage']);
    if (usage === null) {
      continue;
    }
    const modelId = storedModelId(record);
    const bucket = buckets.get(modelId) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, messages: 0 };
    buckets.set(modelId, {
      inputTokens: bucket.inputTokens + usage.inputTokens,
      outputTokens: bucket.outputTokens + usage.outputTokens,
      totalTokens: bucket.totalTokens + usage.totalTokens,
      messages: bucket.messages + 1,
    });
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    totalTokens += usage.totalTokens;
  }
  const models = [...buckets.entries()]
    .map(([modelId, bucket]) => ({ modelId, ...bucket }))
    .sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));

  // Cost: ONLY when rates exist for EVERY used model bucket.
  let estimatedCostUsd: number | null = null;
  let costReason: ChatUsageSummary['costReason'] = pricing === null ? 'pricing_not_configured' : 'partial';
  if (pricing !== null) {
    let ok = models.length > 0;
    let cost = 0;
    for (const bucket of models) {
      const rates = pricing[bucket.modelId];
      if (rates === undefined || !Number.isFinite(rates.input) || !Number.isFinite(rates.output)) {
        ok = false;
        break;
      }
      cost += (bucket.inputTokens / 1_000_000) * rates.input + (bucket.outputTokens / 1_000_000) * rates.output;
    }
    if (ok) {
      estimatedCostUsd = round6(cost);
      costReason = 'priced';
    }
  }

  return { inputTokens, outputTokens, totalTokens, models, estimatedCostUsd, costReason };
}
