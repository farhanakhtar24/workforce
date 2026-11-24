/**
 * Runtime chat-model factory: ONE provider client per configured model id
 * instead of a single global model. The provider client is created with the
 * official `includeUsage: true` option (→ `stream_options: {include_usage:
 * true}`), so every assistant finish carries the real token usage that the
 * chat pipeline persists under `metadata.usage`.
 *
 * Instances are cached per model id (bounded), so repeated generations reuse
 * one client and the factory never invents ids: the caller (chat POST/model
 * selection) always passes VALIDATED ids.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

import { MODEL_ID_PATTERN } from './catalog.js';

export type ModelFor = (modelId: string) => LanguageModel;

export interface RuntimeModelFactoryOptions {
  /** OLLAMA_BASE_URL from config (validated http(s)). */
  readonly baseUrl: string;
  /** The configured API key (server guarantees presence at startup). */
  readonly apiKey: string;
}

/** Factory cache bound (older ids evicted FIFO — far above real usage). */
const MAX_CACHED_MODELS = 64;

export function createRuntimeModelFactory(options: RuntimeModelFactoryOptions): {
  modelFor: ModelFor;
} {
  const cache = new Map<string, LanguageModel>();
  return {
    modelFor(modelId: string): LanguageModel {
      if (typeof modelId !== 'string' || !MODEL_ID_PATTERN.test(modelId)) {
        // The caller validates; a malformed id must never silently select the
        // global model. Throwing here surfaces as the fixed safe 500/502 path.
        throw new Error('Invalid model id.');
      }
      const cached = cache.get(modelId);
      if (cached !== undefined) {
        cache.delete(modelId);
        cache.set(modelId, cached); // LRU refresh
        return cached;
      }
      const provider = createOpenAICompatible({
        name: 'ollama',
        baseURL: options.baseUrl,
        apiKey: options.apiKey,
        includeUsage: true,
      });
      const model = provider.chatModel(modelId);
      cache.set(modelId, model);
      while (cache.size > MAX_CACHED_MODELS) {
        const oldest = cache.keys().next();
        if (oldest.done === true) {
          break;
        }
        cache.delete(oldest.value);
      }
      return model;
    },
  };
}
