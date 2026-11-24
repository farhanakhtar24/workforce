/**
 * `/api/models` REST routes (pre-Phase 6 model composition): the
 * server-proxied catalog and per-model details from the configured Ollama
 * cloud origin. Both are AUTHENTICATED (the app-wide owner gate runs first)
 * and never expose the API key, account spend, or any account-level data.
 *
 * - GET /api/models — bounded rows + per-row `locked` flag/value-free lock
 *   reason (blocked prefixes) + the configured default model id.
 * - GET /api/models/:modelId/details — contextLength ONLY from actual
 *   `model_info` context-length fields; capabilities/parameterSize/thinking;
 *   unknown stats stay `null` (never guessed). `pricing` appears ONLY when
 *   the explicit `OLLAMA_MODEL_PRICING_JSON` carries rates for this exact
 *   model id (absent/partial/invalid → `pricing: null` — never invented,
 *   never a $0 default).
 *
 * Errors are fixed safe strings: `503 Model catalog is temporarily
 * unavailable.` / `400 Invalid model id.` / `404 Model not found.`
 */
import type { Request, RequestHandler, Response } from 'express';

import { isModelId, ModelCatalogUnavailableError, type ModelCatalogLike } from './catalog.js';

/** The configured per-million rates (the exact `ApiConfig.modelPricing`). */
export interface ConfiguredModelRates {
  readonly input: number;
  readonly output: number;
}

export interface ModelsRouteDeps {
  /** The server-proxied catalog (upstream origin + API key stay inside). */
  readonly catalog: ModelCatalogLike;
  readonly defaultModelId: string;
  /** The explicit pricing table (or `null` when unconfigured) for details. */
  readonly modelPricing: Readonly<Record<string, ConfiguredModelRates>> | null;
}

/**
 * The additive details `pricing` value: ONLY explicit configured rates for
 * the exact model id — shaped for the picker, never raw config JSON. A
 * missing/partial/invalid entry (or unconfigured pricing) is `null`; a
 * legitimate `0` rate stays `0` (never a silent default).
 */
export function pricingForModelId(
  modelPricing: Readonly<Record<string, ConfiguredModelRates>> | null,
  modelId: string,
): { inputUsdPerMillion: number; outputUsdPerMillion: number } | null {
  if (modelPricing === null) {
    return null;
  }
  const rates = modelPricing[modelId];
  if (rates === undefined) {
    return null;
  }
  const input = rates.input;
  const output = rates.output;
  if (typeof input !== 'number' || Number.isFinite(input) === false || input < 0) {
    return null;
  }
  if (typeof output !== 'number' || Number.isFinite(output) === false || output < 0) {
    return null;
  }
  return {
    inputUsdPerMillion: input,
    outputUsdPerMillion: output,
  };
}

export interface ModelsRouteHandlers {
  readonly listModels: RequestHandler;
  readonly modelDetails: RequestHandler;
}

function json(res: Response, status: number, body: unknown): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function createModelsRoutes(deps: ModelsRouteDeps): ModelsRouteHandlers {
  const listModels: RequestHandler = async (_req: Request, res: Response) => {
    try {
      const { models } = await deps.catalog.list();
      json(res, 200, { models, defaultModelId: deps.defaultModelId });
    } catch (error) {
      if (error instanceof ModelCatalogUnavailableError) {
        json(res, 503, { error: 'Model catalog is temporarily unavailable.' });
      } else {
        json(res, 503, { error: 'Model catalog is temporarily unavailable.' });
      }
    }
  };

  const modelDetails: RequestHandler = async (req: Request, res: Response) => {
    const modelId = typeof req.params['modelId'] === 'string' ? req.params['modelId'] : '';
    if (!isModelId(modelId)) {
      json(res, 400, { error: 'Invalid model id.' });
      return;
    }
    try {
      const result = await deps.catalog.details(modelId);
      if (result.status === 'not-found') {
        json(res, 404, { error: 'Model not found.' });
        return;
      }
      json(res, 200, {
        modelId,
        contextLength: result.details?.contextLength ?? null,
        capabilities: result.details?.capabilities ?? null,
        parameterSize: result.details?.parameterSize ?? null,
        thinking: result.details?.thinking ?? null,
        pricing: pricingForModelId(deps.modelPricing, modelId),
      });
    } catch (error) {
      if (error instanceof ModelCatalogUnavailableError) {
        json(res, 503, { error: 'Model catalog is temporarily unavailable.' });
      } else {
        json(res, 503, { error: 'Model catalog is temporarily unavailable.' });
      }
    }
  };

  return { listModels, modelDetails };
}
