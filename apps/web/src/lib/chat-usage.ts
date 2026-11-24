/**
 * Per-chat usage/cost helpers (Farhan's request B) against the
 * authenticated `GET /api/agents/:slug/chat/:chatId/usage` route.
 *
 * The API sums ONLY valid assistant `metadata.usage` blocks (never
 * fabricated), groups them by `metadata.modelId` (unattributed bucket
 * `(unattributed)` for pre-provenance messages), and reports
 * `estimatedCostUsd` ONLY when per-million pricing is configured for every
 * used model — otherwise `null` with an honest `costReason`. The client maps
 * strictly and never invents a `$0`.
 */

import { browserApiFetch, requestAuthError } from './api';

export const USAGE_FALLBACK_ERROR = 'Usage is temporarily unavailable.';

export interface UsageModelBucket {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messages: number;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  models: ReadonlyArray<UsageModelBucket>;
  estimatedCostUsd: number | null;
  costReason: 'priced' | 'pricing_not_configured' | 'partial';
}

export type UsageResult =
  | { ok: true; summary: UsageSummary }
  | { ok: false; error: string; status: number };

export function chatUsageEndpoint(apiBaseUrl: string, slug: string, chatId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) return null;
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/agents/${encodeURIComponent(slug)}/chat/${encodeURIComponent(chatId)}/usage`;
}

function boundedInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647
    ? value
    : null;
}

export function mapUsageSummary(payload: unknown): UsageResult {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: USAGE_FALLBACK_ERROR, status: 502 };
  }
  const record = payload as Record<string, unknown>;
  const inputTokens = boundedInt(record['inputTokens']);
  const outputTokens = boundedInt(record['outputTokens']);
  const totalTokens = boundedInt(record['totalTokens']);
  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    return { ok: false, error: USAGE_FALLBACK_ERROR, status: 502 };
  }
  if (!Array.isArray(record['models'])) {
    return { ok: false, error: USAGE_FALLBACK_ERROR, status: 502 };
  }
  const models: UsageModelBucket[] = [];
  for (const row of record['models']) {
    if (row === null || typeof row !== 'object') {
      return { ok: false, error: USAGE_FALLBACK_ERROR, status: 502 };
    }
    const entry = row as Record<string, unknown>;
    const modelId = typeof entry['modelId'] === 'string' ? entry['modelId'].trim() : '';
    const bucketInput = boundedInt(entry['inputTokens']);
    const bucketOutput = boundedInt(entry['outputTokens']);
    const bucketTotal = boundedInt(entry['totalTokens']);
    const bucketMessages = boundedInt(entry['messages']);
    if (modelId === '' || bucketInput === null || bucketOutput === null || bucketTotal === null || bucketMessages === null) {
      return { ok: false, error: USAGE_FALLBACK_ERROR, status: 502 };
    }
    models.push({
      modelId,
      inputTokens: bucketInput,
      outputTokens: bucketOutput,
      totalTokens: bucketTotal,
      messages: bucketMessages,
    });
  }
  const cost = record['estimatedCostUsd'];
  const estimatedCostUsd =
    typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
  const reason = record['costReason'];
  const costReason =
    reason === 'priced' || reason === 'pricing_not_configured' || reason === 'partial'
      ? reason
      : null;
  if (estimatedCostUsd !== null && costReason !== 'priced') {
    return { ok: false, error: USAGE_FALLBACK_ERROR, status: 502 };
  }
  return {
    ok: true,
    summary: {
      inputTokens,
      outputTokens,
      totalTokens,
      models,
      estimatedCostUsd,
      costReason: costReason ?? 'pricing_not_configured',
    },
  };
}

export async function fetchChatUsage(options: {
  apiBaseUrl: string;
  slug: string;
  chatId: string;
  signal?: AbortSignal;
}): Promise<UsageResult> {
  const url = chatUsageEndpoint(options.apiBaseUrl, options.slug, options.chatId);
  if (url === null) return { ok: false, error: USAGE_FALLBACK_ERROR, status: 400 };
  try {
    const response = await browserApiFetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: options.signal,
    });
    if (!response.ok) {
      const authError = requestAuthError(response.status ?? 0);
      if (authError !== null) return { ok: false, error: authError, status: response.status ?? 0 };
      return { ok: false, error: USAGE_FALLBACK_ERROR, status: response.status ?? 0 };
    }
    return mapUsageSummary(await response.json());
  } catch {
    return { ok: false, error: USAGE_FALLBACK_ERROR, status: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* Pure display helpers                                                */
/* ------------------------------------------------------------------ */

/** Per-message usage block from assistant `metadata` (strict; never guessed). */
export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number | null;
  modelId: string | null;
}

export function usageFromMetadata(metadata: unknown): MessageUsage | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const usage = record['usage'];
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const block = usage as Record<string, unknown>;
  const input = boundedInt(block['inputTokens'] ?? block['input_tokens']);
  const output = boundedInt(block['outputTokens'] ?? block['output_tokens']);
  const total = boundedInt(block['totalTokens'] ?? block['total_tokens']);
  if (input === null && output === null && total === null) return null;
  const modelIdRaw = typeof record['modelId'] === 'string' ? record['modelId'].trim() : '';
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: total !== null || (input !== null && output !== null)
      ? (total ?? (input ?? 0) + (output ?? 0))
      : null,
    modelId: modelIdRaw !== '' ? modelIdRaw : null,
  };
}

/** Compact totals line: `1,234 in / 567 out · 1,801 total`. */
export function formatUsageTotals(summary: UsageSummary): string {
  return `${summary.inputTokens.toLocaleString('en-US')} in / ${summary.outputTokens.toLocaleString('en-US')} out · ${summary.totalTokens.toLocaleString('en-US')} total`;
}

/** One bucket line, unattributed rows labeled honestly. */
export function formatUsageBucket(bucket: UsageModelBucket): string {
  const model = bucket.modelId === '(unattributed)' ? 'unattributed messages' : bucket.modelId;
  return `${model}: ${bucket.inputTokens.toLocaleString('en-US')} in / ${bucket.outputTokens.toLocaleString('en-US')} out`;
}

export type CostLabel = { kind: 'estimated'; value: string } | { kind: 'reason'; text: 'Pricing not configured' | 'Partial pricing' };

/** Cost display ONLY for real estimates with the explicit Estimated label. */
export function formatUsageCost(summary: UsageSummary): CostLabel {
  if (summary.estimatedCostUsd !== null) {
    return { kind: 'estimated', value: `Estimated cost: $${summary.estimatedCostUsd.toFixed(4)}` };
  }
  if (summary.costReason === 'partial') {
    return { kind: 'reason', text: 'Partial pricing' };
  }
  return { kind: 'reason', text: 'Pricing not configured' };
}
