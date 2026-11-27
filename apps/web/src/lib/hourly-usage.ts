/**
 * Hourly budget helpers (Farhan's request B) against the authenticated
 * `GET /api/usage/hourly` route: the caller's OWN rolling 60-minute window —
 * request/cost counters with remaining values, per-model buckets, and the
 * honest settlement state. No account-wide/shared-key spend, no invented
 * billing figures; estimates are conservative and clearly labeled.
 */

import { browserApiFetch, requestAuthError } from './api';

export const HOURLY_USAGE_FALLBACK_ERROR = 'Hourly usage is temporarily unavailable.';

export interface HourlyUsageModel {
  modelId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface HourlyUsageSummary {
  windowSeconds: number;
  requestLimit: number;
  costLimitUsd: number;
  requestCount: number;
  remainingRequests: number;
  estimatedCostUsd: number;
  remainingCostUsd: number;
  resetAt: string | null;
  usageComplete: boolean;
  models: ReadonlyArray<HourlyUsageModel>;
}

export type HourlyUsageResult =
  | { ok: true; summary: HourlyUsageSummary }
  | { ok: false; error: string; status: number };

export function hourlyUsageEndpoint(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/usage/hourly`;
}

function boundedInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647
    ? value
    : null;
}

function finiteCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Strict mapping of the documented `GET /api/usage/hourly` shape. */
export function mapHourlyUsage(payload: unknown): HourlyUsageResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: HOURLY_USAGE_FALLBACK_ERROR, status: 502 };
  }
  const record = payload as Record<string, unknown>;
  const windowSeconds = boundedInt(record['windowSeconds']);
  const requestLimit = boundedInt(record['requestLimit']);
  const costLimitUsd = finiteCost(record['costLimitUsd']);
  const requestCount = boundedInt(record['requestCount']);
  const remainingRequests = boundedInt(record['remainingRequests']);
  const estimatedCostUsd = finiteCost(record['estimatedCostUsd']);
  const remainingCostUsd = finiteCost(record['remainingCostUsd']);
  const usageComplete =
    typeof record['usageComplete'] === 'boolean' ? (record['usageComplete'] as boolean) : undefined;
  const resetAt = typeof record['resetAt'] === 'string' ? (record['resetAt'] as string) : undefined;
  if (
    windowSeconds === null ||
    requestLimit === null ||
    costLimitUsd === null ||
    requestCount === null ||
    remainingRequests === null ||
    estimatedCostUsd === null ||
    remainingCostUsd === null ||
    usageComplete === undefined
  ) {
    return { ok: false, error: HOURLY_USAGE_FALLBACK_ERROR, status: 502 };
  }
  if (!Array.isArray(record['models'])) {
    return { ok: false, error: HOURLY_USAGE_FALLBACK_ERROR, status: 502 };
  }
  const models: HourlyUsageModel[] = [];
  for (const row of record['models']) {
    if (row === null || typeof row !== 'object') {
      return { ok: false, error: HOURLY_USAGE_FALLBACK_ERROR, status: 502 };
    }
    const entry = row as Record<string, unknown>;
    const modelId = typeof entry['modelId'] === 'string' && entry['modelId'].trim() !== '' ? (entry['modelId'] as string).trim() : null;
    const requests = boundedInt(entry['requests']);
    const inputTokens = boundedInt(entry['inputTokens']);
    const outputTokens = boundedInt(entry['outputTokens']);
    const cost = finiteCost(entry['estimatedCostUsd']);
    if (modelId === null || requests === null || inputTokens === null || outputTokens === null || cost === null) {
      return { ok: false, error: HOURLY_USAGE_FALLBACK_ERROR, status: 502 };
    }
    models.push({ modelId, requests, inputTokens, outputTokens, estimatedCostUsd: cost });
  }
  if (resetAt !== undefined) {
    const parsed = new Date(resetAt);
    // `null` resetAt means no rolling expiry yet (honest); a present-but-bad
    // value is malformed and fails.
    if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) {
      return { ok: false, error: HOURLY_USAGE_FALLBACK_ERROR, status: 502 };
    }
  }
  return {
    ok: true,
    summary: {
      windowSeconds,
      requestLimit,
      costLimitUsd,
      requestCount,
      remainingRequests,
      estimatedCostUsd,
      remainingCostUsd,
      resetAt: resetAt ?? null,
      usageComplete: usageComplete === true,
      models,
    },
  };
}

export async function fetchHourlyUsage(options: {
  apiBaseUrl: string;
  fetchImpl?: typeof browserApiFetch;
  signal?: AbortSignal;
}): Promise<HourlyUsageResult> {
  try {
    const response = await (options.fetchImpl ?? browserApiFetch)(hourlyUsageEndpoint(options.apiBaseUrl), {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: options.signal,
    });
    if (!response.ok) {
      const authError = requestAuthError(response.status ?? 0);
      if (authError !== null) return { ok: false, error: authError, status: response.status ?? 0 };
      return { ok: false, error: HOURLY_USAGE_FALLBACK_ERROR, status: response.status ?? 0 };
    }
    return mapHourlyUsage(await response.json());
  } catch {
    return { ok: false, error: HOURLY_USAGE_FALLBACK_ERROR, status: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* Pure display helpers                                                */
/* ------------------------------------------------------------------ */

/** Local readable stamp plus the UTC stamp for the accessible title. */
export function formatHourlyReset(resetAt: string | null): { local: string; utc: string } | null {
  if (resetAt === null) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  const local = date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const utcIso = date.toISOString();
  return { local, utc: `${utcIso.slice(0, 10)} ${utcIso.slice(11, 16)} UTC` };
}

/** Conservative estimate line; never claims to be a real bill. */
export function formatHourlyCost(summary: HourlyUsageSummary): string {
  return `$${summary.estimatedCostUsd.toFixed(4)} of $${summary.costLimitUsd.toFixed(2)} (conservative estimate)`;
}
