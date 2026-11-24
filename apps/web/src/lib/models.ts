/**
 * Model catalog + per-chat model helpers (Farhan's request A) against the
 * authenticated model routes:
 *
 * - GET  /api/models                      → `{ models: ModelCatalogEntry[],
 *       defaultModelId }` — bounded rows; locked rows surface with a
 *       value-free `lockReason`; `defaultModelId` is the configured default
 *       (glm-5.3-flash in config).
 * - GET  /api/models/:modelId/details     → `{ modelId, contextLength (only
 *       real `.context_length` model_info fields, else null), capabilities
 *       (null when absent), parameterSize (null), thinking (bool|null) }`.
 * - GET  /api/agents/:slug/chat/:chatId/model → `{ modelId }` (effective
 *       next-generation model: stored or configured default).
 * - PUT  /api/agents/:slug/chat/:chatId/model → strict `{ modelId }` →
 *   200 `{ modelId }` (applies to the NEXT generation; never interrupts a
 *   running stream).
 *
 * Unknown details stay `null` on the wire and render as “Not reported” —
 * nothing is invented. Fixed safe errors per documented copy.
 */

import { browserApiFetch, requestAuthError } from './api';

/** Exact model-id contract mirrored from `apps/api` catalog. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

/** Fixed safe copy — mirrors the API's documented strings verbatim. */
export const MODEL_CATALOG_UNAVAILABLE = 'Model catalog is temporarily unavailable.';
export const MODEL_DETAILS_INVALID_ID = 'Invalid model id.';
export const MODEL_DETAILS_NOT_FOUND = 'Model not found.';
export const MODEL_SELECTION_ERROR = 'Model selection could not be applied.';
/** Generic fallback when the API's safe `{ error }` is absent. */
export const MODELS_FALLBACK_ERROR = 'Model catalog is temporarily unavailable.';

export interface ModelInfo {
  id: string;
  name: string;
  modifiedAt: string | null;
  capabilities: ReadonlyArray<string>;
  parameterSize: string | null;
  locked: boolean;
  lockReason: string | null;
}

export type ModelCatalogResult =
  | { ok: true; models: ReadonlyArray<ModelInfo>; defaultModelId: string | null }
  | { ok: false; error: string; status: number };

/** Additive rates contract; null = honest “Not configured” (never $0). */
export interface ModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface ModelDetailsInfo {
  modelId: string;
  contextLength: number | null;
  capabilities: ReadonlyArray<string> | null;
  parameterSize: string | null;
  thinking: boolean | null;
  pricing: ModelPricing | null;
}

export type ModelDetailsResult =
  | { ok: true; details: ModelDetailsInfo }
  | { ok: false; error: string; status: number };

export type ChatModelResult =
  | { ok: true; modelId: string }
  | { ok: false; error: string; status: number };

export function modelsEndpoint(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/models`;
}

export function modelDetailsEndpoint(apiBaseUrl: string, modelId: string): string | null {
  if (!isModelId(modelId)) return null;
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/models/${encodeURIComponent(modelId)}/details`;
}

export function chatModelEndpoint(apiBaseUrl: string, slug: string, chatId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) return null;
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/agents/${encodeURIComponent(slug)}/chat/${encodeURIComponent(chatId)}/model`;
}

type FetchLike = typeof browserApiFetch;

function boundedCapabilities(value: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** Structural row mapping; one unusable row fails the whole payload (safe). */
function parseModelRow(row: unknown): ModelInfo | null {
  if (row === null || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'] : '';
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  const capabilities = boundedCapabilities(record['capabilities']);
  const parameterSize = typeof record['parameterSize'] === 'string' ? record['parameterSize'] : null;
  const locked = record['locked'];
  if (!isModelId(id) || name === '' || capabilities === null || typeof locked !== 'boolean') {
    return null;
  }
  const modifiedAt = typeof record['modifiedAt'] === 'string' ? record['modifiedAt'] : null;
  const lockReason = typeof record['lockReason'] === 'string' ? record['lockReason'] : null;
  return {
    id,
    name,
    modifiedAt,
    capabilities: capabilities.filter((entry) => entry.length > 0),
    parameterSize: parameterSize !== '' ? parameterSize : null,
    locked,
    lockReason: lockReason !== '' ? lockReason : null,
  };
}

export function mapModelCatalog(payload: unknown): ModelCatalogResult {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: MODELS_FALLBACK_ERROR, status: 502 };
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record['models'])) {
    return { ok: false, error: MODELS_FALLBACK_ERROR, status: 502 };
  }
  const models: ModelInfo[] = [];
  for (const row of record['models']) {
    const parsed = parseModelRow(row);
    if (parsed === null) {
      return { ok: false, error: MODELS_FALLBACK_ERROR, status: 502 };
    }
    models.push(parsed);
  }
  const defaultModelId = typeof record['defaultModelId'] === 'string' ? record['defaultModelId'] : null;
  if (defaultModelId !== null && !isModelId(defaultModelId)) {
    return { ok: false, error: MODELS_FALLBACK_ERROR, status: 502 };
  }
  return { ok: true, models, defaultModelId };
}

export function mapModelDetails(payload: unknown, expectedModelId: string): ModelDetailsResult {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: MODELS_FALLBACK_ERROR, status: 502 };
  }
  const record = payload as Record<string, unknown>;
  if (record['modelId'] !== expectedModelId) {
    return { ok: false, error: MODELS_FALLBACK_ERROR, status: 502 };
  }
  const contextLength =
    typeof record['contextLength'] === 'number' && Number.isInteger(record['contextLength']) && record['contextLength'] > 0
      ? (record['contextLength'] as number)
      : null;
  const capabilities = boundedCapabilities(record['capabilities']);
  const parameterSize = typeof record['parameterSize'] === 'string' ? record['parameterSize'] : null;
  const thinking =
    typeof record['thinking'] === 'boolean'
      ? (record['thinking'] as boolean)
      : typeof record['thinking'] === 'object' && record['thinking'] !== null
        ? true
        : null;
  // Additive contract: `pricing` is null OR a complete pair of finite
  // non-negative rates. Missing/partial rates => null (never $0); a non-null
  // value that fails validation rejects the payload (documented strictness).
  const pricingRaw = record['pricing'];
  let pricing: ModelPricing | null = null;
  if (pricingRaw !== null && pricingRaw !== undefined) {
    if (pricingRaw === null || typeof pricingRaw !== 'object' || Array.isArray(pricingRaw)) {
      return { ok: false, error: MODELS_FALLBACK_ERROR, status: 502 };
    }
    const pr = pricingRaw as Record<string, unknown>;
    const inputRate = pr['inputUsdPerMillion'];
    const outputRate = pr['outputUsdPerMillion'];
    const valid = (v: unknown): v is number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (!valid(inputRate) || !valid(outputRate)) {
      return { ok: false, error: MODELS_FALLBACK_ERROR, status: 502 };
    }
    pricing = { inputUsdPerMillion: inputRate, outputUsdPerMillion: outputRate };
  }
  return {
    ok: true,
    details: {
      modelId: expectedModelId,
      contextLength,
      capabilities,
      parameterSize: parameterSize !== '' ? parameterSize : null,
      thinking,
      pricing,
    },
  };
}

async function fetchJson(url: string, method: 'GET' | 'PUT', body?: string, fetchImpl?: FetchLike, signal?: AbortSignal): Promise<{ ok: true; status: number; body: unknown } | { ok: false; error: string; status: number }> {
  try {
    const response = await (fetchImpl ?? browserApiFetch)(url, {
      method,
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal,
    });
    if (!response.ok) {
      const authError = requestAuthError(response.status ?? 0);
      if (authError !== null) return { ok: false, error: authError, status: response.status ?? 0 };
      return { ok: false, error: fallbackForStatus(response.status ?? 0), status: response.status ?? 0 };
    }
    return { ok: true, status: response.status ?? 0, body: await response.json() };
  } catch {
    return { ok: false, error: MODELS_FALLBACK_ERROR, status: 0 };
  }
}

function fallbackForStatus(status: number): string {
  if (status === 503) return MODEL_CATALOG_UNAVAILABLE;
  if (status === 404) return MODEL_DETAILS_NOT_FOUND;
  if (status === 400) return MODEL_SELECTION_ERROR;
  return MODELS_FALLBACK_ERROR;
}

export async function fetchModelCatalog(options: {
  apiBaseUrl: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<ModelCatalogResult> {
  const result = await fetchJson(modelsEndpoint(options.apiBaseUrl), 'GET', undefined, options.fetchImpl, options.signal);
  return result.ok ? mapModelCatalog(result.body) : { ok: false, error: result.error, status: result.status };
}

export async function fetchModelDetails(options: {
  apiBaseUrl: string;
  modelId: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<ModelDetailsResult> {
  const url = modelDetailsEndpoint(options.apiBaseUrl, options.modelId);
  if (url === null) return { ok: false, error: MODEL_DETAILS_INVALID_ID, status: 400 };
  const result = await fetchJson(url, 'GET', undefined, options.fetchImpl, options.signal);
  return result.ok ? mapModelDetails(result.body, options.modelId) : { ok: false, error: result.error, status: result.status };
}

export async function fetchChatModel(options: {
  apiBaseUrl: string;
  slug: string;
  chatId: string;
  fetchImpl?: FetchLike;
}): Promise<ChatModelResult> {
  const url = chatModelEndpoint(options.apiBaseUrl, options.slug, options.chatId);
  if (url === null) return { ok: false, error: MODEL_SELECTION_ERROR, status: 400 };
  const result = await fetchJson(url, 'GET', undefined, options.fetchImpl);
  if (!result.ok) return { ok: false, error: result.error, status: result.status };
  const record =
    result.body !== null && typeof result.body === 'object'
      ? (result.body as Record<string, unknown>)['modelId']
      : undefined;
  if (typeof record !== 'string' || !isModelId(record)) {
    return { ok: false, error: MODELS_FALLBACK_ERROR, status: 502 };
  }
  return { ok: true, modelId: record };
}

export async function putChatModel(options: {
  apiBaseUrl: string;
  slug: string;
  chatId: string;
  modelId: string;
  fetchImpl?: FetchLike;
}): Promise<ChatModelResult> {
  const url = chatModelEndpoint(options.apiBaseUrl, options.slug, options.chatId);
  if (url === null || !isModelId(options.modelId)) {
    return { ok: false, error: MODEL_SELECTION_ERROR, status: 400 };
  }
  const result = await fetchJson(url, 'PUT', JSON.stringify({ modelId: options.modelId }), options.fetchImpl);
  if (!result.ok) return { ok: false, error: result.error, status: result.status };
  const record =
    result.body !== null && typeof result.body === 'object'
      ? (result.body as Record<string, unknown>)['modelId']
      : undefined;
  if (typeof record !== 'string' || !isModelId(record)) {
    return { ok: false, error: MODEL_SELECTION_ERROR, status: 502 };
  }
  return { ok: true, modelId: record };
}

/* ------------------------------------------------------------------ */
/* Pure display helpers                                                */
/* ------------------------------------------------------------------ */

/** Bounded "unknown" label — never a guessed value. */
export const MODEL_FIELD_UNKNOWN = 'Not reported';

export interface ModelDetailLines {
  readonly capabilities: string;
  readonly parameterSize: string;
  readonly contextLength: string;
  readonly modifiedAt: string | null;
  readonly thinkingText: string | null;
  readonly lockReason: string | null;
}

/**
 * Details → accessible display lines. Unknown stats render “Not reported”;
 * `modifiedAt` and the thinking flag only appear when actually present.
 */
export function formatModelDetailLines(input: {
  modelId: string;
  details: ModelDetailsInfo | null;
  locked?: boolean;
  lockReason?: string | null;
  modifiedAt?: string | null;
}): ModelDetailLines {
  const details = input.details;
  return {
    capabilities:
      details === null || details.capabilities === null || details.capabilities.length === 0
        ? `${capLabel('Capabilities')}: ${MODEL_FIELD_UNKNOWN}`
        : `${capLabel('Capabilities')}: ${details.capabilities.join(', ')}`,
    parameterSize:
      details === null || details.parameterSize === null
        ? `${capLabel('Parameter size')}: ${MODEL_FIELD_UNKNOWN}`
        : `${capLabel('Parameter size')}: ${details.parameterSize}`,
    contextLength:
      details === null || details.contextLength === null
        ? `${capLabel('Context length')}: ${MODEL_FIELD_UNKNOWN}`
        : `${capLabel('Context length')}: ${details.contextLength.toLocaleString('en-US')}`,
    modifiedAt: input.modifiedAt ?? null,
    thinkingText: details !== null && details.thinking === true ? 'Thinking: yes' : null,
    lockReason: input.locked === true ? (input.lockReason ?? 'Model is locked by workspace policy') : null,
  };
}

function capLabel(label: string): string {
  return label;
}


/* ------------------------------------------------------------------ */
/* Picker helpers (search + reference-style details card)              */
/* ------------------------------------------------------------------ */

/** Case-insensitive substring filter over name + id (empty query → all). */
export function filterModels(
  models: ReadonlyArray<ModelInfo>,
  query: string,
): ReadonlyArray<ModelInfo> {
  const q = query.trim().toLowerCase();
  if (q === '') return models;
  return models.filter(
    (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
  );
}

/** Input modality: text always; image ONLY with a real `vision` capability. */
export function inputModality(details: ModelDetailsInfo | null): string {
  const vision = details !== null && details.capabilities !== null && details.capabilities.includes('vision');
  return vision ? 'text, image' : 'text';
}

export const MODEL_PROVIDER_LABEL = 'Ollama Cloud';

export interface ModelCardLines {
  readonly provider: string;
  readonly name: string;
  readonly capabilities: string;
  readonly input: string;
  readonly output: string;
  readonly contextLength: string;
  readonly parameterSize: string;
  readonly thinking: string | null;
  readonly modifiedAt: string | null;
  readonly pricing: string;
  readonly lockReason: string | null;
}

/** Reference-style card: real fields only; unknown statistics → Not reported. */
export function formatModelCardLines(input: {
  details: ModelDetailsInfo | null;
  name: string;
  modifiedAt?: string | null;
  locked?: boolean;
  lockReason?: string | null;
}): ModelCardLines {
  const details = input.details;
  const contextReal = details !== null && details.contextLength !== null;
  const parameterReal = details !== null && details.parameterSize !== null;
  const price = details !== null && details.pricing !== null ? details.pricing : null;
  return {
    provider: MODEL_PROVIDER_LABEL,
    name: input.name,
    capabilities:
      details === null || details.capabilities === null || details.capabilities.length === 0
        ? `Capabilities: ${MODEL_FIELD_UNKNOWN}`
        : `Capabilities: ${details.capabilities.join(', ')}`,
    input: `Input: ${inputModality(details)}`,
    output: 'Output: text',
    contextLength: contextReal
      ? `Context length: ${(details?.contextLength ?? 0).toLocaleString('en-US')}`
      : `Context length: ${MODEL_FIELD_UNKNOWN}`,
    parameterSize: parameterReal
      ? `Parameter size: ${details?.parameterSize ?? ''}`
      : `Parameter size: ${MODEL_FIELD_UNKNOWN}`,
    thinking:
      details !== null && details.thinking === true
        ? 'Thinking: yes'
        : details !== null && details.thinking === false
          ? 'Thinking: no'
          : null,
    modifiedAt: input.modifiedAt ?? null,
    pricing:
      price !== null
        ? `Cost ($/1M tokens): $${price.inputUsdPerMillion} input / $${price.outputUsdPerMillion} output`
        : 'Cost ($/1M tokens): Not configured',
    lockReason: input.locked === true ? (input.lockReason ?? 'Model is locked by workspace policy') : null,
  };
}
