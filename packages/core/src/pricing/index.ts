/**
 * Official Ollama pricing table (verified 2026-11-25 against
 * https://ollama.com/pricing) plus the enforcement helpers for the
 * CONSERVATIVE per-user hourly budget.
 *
 * Rules (deliberately narrow):
 * - EXACT id matching only — never fuzzy/semantic version matching. The two
 *   aliases in the table are exact literals (`deepseek-v4.1-flash:1017`,
 *   `deepseek-v4-pro:0813`).
 * - Enforcement uses the STANDARD input/output rates; cached-input and
 *   off-peak discounts are surfaced (when officially known) but NEVER used
 *   for enforcement math, so no optimistic discount can widen the budget.
 * - An explicit `0` rate is a legitimate configured value, not "unpriced".
 * - Unknown / unpriced ids resolve to `null` and are BLOCKED at model
 *   selection and generation (fail-closed, never $0 default).
 * - `OLLAMA_MODEL_PRICING_JSON` may override one exact id with
 *   `{input, output}` per-million USD; a cached-input rate is then UNKNOWN
 *   (never invented).
 *
 * Kimi models are priced here for the budget table, but the SEPARATE blocked-
 * prefix policy (`WORKFORCE_BLOCKED_MODEL_PREFIXES`, default `kimi`) still
 * keeps Kimi ids unselectable end to end — pricing availability alone never
 * lifts a policy lock.
 */

/** Official per-million USD rates for one model id (standard tier). */
export interface OfficialModelRates {
  /** Standard input USD per 1M tokens (enforcement input side). */
  readonly input: number;
  /** Cached input USD per 1M tokens when officially listed; never invented. */
  readonly cachedInput: number | null;
  /** Standard output USD per 1M tokens (enforcement output side). */
  readonly output: number;
}

/** The official table, keyed by EXACT model id. */
export const OFFICIAL_MODEL_RATES: Readonly<Record<string, OfficialModelRates>> = Object.freeze({
  'deepseek-v4-flash': { input: 0.14, cachedInput: 0.028, output: 0.28 },
  'deepseek-v4.1-flash': { input: 0.14, cachedInput: 0.028, output: 0.28 },
  'deepseek-v4.1-flash:1017': { input: 0.14, cachedInput: 0.028, output: 0.28 },
  'glm-5.3-flash': { input: 0.15, cachedInput: 0.03, output: 0.5 },
  'minimax-m3': { input: 0.3, cachedInput: 0.06, output: 1.2 },
  'minimax-m3.1-flash': { input: 0.3, cachedInput: 0.06, output: 1.2 },
  'glm-5.3': { input: 1.4, cachedInput: 0.26, output: 4.4 },
  'deepseek-v4-pro': { input: 1.74, cachedInput: 0.29, output: 3.48 },
  'deepseek-v4.1-pro': { input: 1.74, cachedInput: 0.29, output: 3.48 },
  'deepseek-v4-pro:0813': { input: 1.74, cachedInput: 0.29, output: 3.48 },
  'gpt-oss:20b': { input: 0.1, cachedInput: 0.025, output: 0.5 },
  'gpt-oss:120b': { input: 0.25, cachedInput: 0.05, output: 1.0 },
  'minimax-m3.1-pro': { input: 0.6, cachedInput: 0.06, output: 2.4 },
  'muse-spark': { input: 0.8, cachedInput: 0.08, output: 2.4 },
  'kimi-k2.7-code': { input: 0.95, cachedInput: 0.19, output: 4.0 },
  'kimi-k3.1-pro': { input: 1.5, cachedInput: 0.15, output: 6.0 },
  'kimi-k3': { input: 1.5, cachedInput: 0.15, output: 6.0 },
  'nemotron-3-ultra': { input: 1.0, cachedInput: 0.1, output: 4.0 },
  'qwen3.8-max': { input: 2.0, cachedInput: 0.4, output: 6.0 },
  'mimo-v2.6-pro': { input: 2.0, cachedInput: 0.2, output: 6.0 },
  'mimo-v2.6-flash': { input: 0.5, cachedInput: 0.05, output: 1.5 },
  'kimi-k2.6': { input: 0.95, cachedInput: 0.19, output: 4.75 },
  'mistral-large-4': { input: 2.0, cachedInput: 0.2, output: 8.0 },
  'nemotron-3-super': { input: 2.0, cachedInput: 0.4, output: 8.0 },
  'glm-5.2': { input: 2.0, cachedInput: 0.4, output: 8.0 },
  'qwen3.5': { input: 0.6, cachedInput: 0.12, output: 3.6 },
  'qwen3.7-max': { input: 2.5, cachedInput: 0.5, output: 7.5 },
  'gemma4:31b': { input: 0.5, cachedInput: 0.1, output: 2.0 },
  'gemma4:26b': { input: 0.5, cachedInput: 0.1, output: 2.0 },
});

/** Shape of one `OLLAMA_MODEL_PRICING_JSON` entry (existing contract). */
export interface PricingOverrideEntry {
  readonly input: number;
  readonly output: number;
}

/**
 * Conservative enforcement + picker pricing for one exact model id:
 * override first (cached input unknown → `null`), else the official table,
 * else `null` (unpriced → blocked).
 */
export function effectiveModelPricing(
  modelPricingOverride: Readonly<Record<string, PricingOverrideEntry>> | null,
  modelId: string,
): OfficialModelRates | null {
  if (modelPricingOverride !== null) {
    const entry = modelPricingOverride[modelId];
    if (entry !== undefined) {
      if (typeof entry.input !== 'number' || !Number.isFinite(entry.input) || entry.input < 0) {
        return null;
      }
      if (typeof entry.output !== 'number' || !Number.isFinite(entry.output) || entry.output < 0) {
        return null;
      }
      return { input: entry.input, cachedInput: null, output: entry.output };
    }
  }
  return OFFICIAL_MODEL_RATES[modelId] ?? null;
}

/**
 * True when the id is explicitly priced (default table or override) — the
 * fail-closed gate used at model selection AND generation.
 */
export function isModelExplicitlyPriced(
  modelPricingOverride: Readonly<Record<string, PricingOverrideEntry>> | null,
  modelId: string,
): boolean {
  return effectiveModelPricing(modelPricingOverride, modelId) !== null;
}

/** Conservative enforcement cost in USD from STANDARD input/output rates. */
export function conservativeCostUsd(rates: OfficialModelRates, inputTokens: number, outputTokens: number): number {
  const input = Math.max(0, Math.ceil(inputTokens));
  const output = Math.max(0, Math.ceil(outputTokens));
  return (input / 1_000_000) * rates.input + (output / 1_000_000) * rates.output;
}

/** Rounds a USD amount to 6 decimals (the budget ledger's storage precision). */
export function round6Usd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
