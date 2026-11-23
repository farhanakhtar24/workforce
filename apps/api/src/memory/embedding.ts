/**
 * Local embedding provider (`Xenova/all-MiniLM-L6-v2`, 384 dims) via
 * Transformers.js, satisfying the core `EmbeddingProvider` contract.
 *
 * HARD RULES:
 * - The `@huggingface/transformers` package is loaded with a DYNAMIC import on
 *   the FIRST `embed()`/`preload()` call only. Importing this module (as the
 *   offline test suite does) never loads the library, ONNX runtime, or model.
 * - No network/download happens at server startup; the model loads (and
 *   downloads once) on first use, then is cached in `config.embeddingCacheDir`
 *   (a repo-local absolute path, e.g. `.cache/workforce-models`). The cache
 *   directory is forwarded TWICE, because Transformers 4.3.2 ignores the
 *   per-pipeline `env` option: `cache_dir` in the pipeline options AND the
 *   imported module's `env.cacheDir` — so downloads never land in node_modules.
 * - No API key is required; inference runs on CPU with q8 quantized weights.
 * - Output is normalized to a plain `number[]` of exactly 384 finite values.
 *   Core re-validates this, but the provider stays honest on its own.
 * - Both lazy singletons are retry-safe: a failed module import or a failed
 *   pipeline construction resets the cache before rethrowing, so a later
 *   embed call succeeds without a process restart.
 */
import type { EmbeddingProvider } from '@workforce/core/memory';
import { MEMORY_EMBEDDING_MODEL } from '@workforce/core/memory';

/** The exact dims the memory domain pins. */
const DIMENSIONS = 384 as const;

/**
 * Minimal structural types for the parts of Transformers.js we use. The real
 * package types exist, but this module must typecheck (and load) without ever
 * importing the package statically, so the surface is declared locally. It
 * doubles as the test seam (`loadModule` injects fakes).
 */
interface TensorLike {
  /** `[batch][dims]` nested arrays when `tolist()` exists. */
  tolist?: () => unknown;
  /** Flat typed array / number[] when `data` exists. */
  data?: unknown;
  dims?: readonly unknown[];
}

interface ExtractorLike {
  (text: string, options: { pooling: 'mean'; normalize: boolean }): Promise<TensorLike>;
}

export interface TransformersModuleLike {
  /** Model id under the HF hub. */
  pipeline(module: 'feature-extraction', model: string, options: {
    dtype?: 'fp32' | 'q8' | 'fp16' | 'uint8';
    device?: 'cpu' | 'gpu';
    /** Transformers 4.3.2 cache location (per-pipeline option). */
    cache_dir?: string;
    env?: { cacheDir: string | undefined };
  }): Promise<ExtractorLike>;
  /** Module-level cache/env config object (also assigned for safety). */
  env?: { cacheDir?: string };
}

/** Default seam: the real dynamic import. Never executes in offline tests. */
const defaultLoadModule = (): Promise<TransformersModuleLike> =>
  import('@huggingface/transformers') as Promise<TransformersModuleLike>;

export interface LocalEmbeddingProviderOptions {
  /** Absolute repo-local cache dir (from `config.embeddingCacheDir`). */
  cacheDir: string;
  /** Test seam: replace the dynamic import (default: real Transformers.js). */
  loadModule?: () => Promise<TransformersModuleLike>;
}

export interface LocalEmbeddingProvider extends EmbeddingProvider {
  /** Loads/downloads the model once; safe to call at any time or repeatedly. */
  preload(): Promise<void>;
}

/**
 * Build the provider. Lazy singleton: the pipeline (and therefore the model
 * load/download) happens on first embed/preload and is reused afterwards.
 * A failed load resets the singleton so the next embed can retry.
 */
export function createLocalEmbeddingProvider(
  options: LocalEmbeddingProviderOptions,
): LocalEmbeddingProvider {
  const loadModule = options.loadModule ?? defaultLoadModule;
  let cachedModule: Promise<TransformersModuleLike> | null = null;
  let pipelinePromise: Promise<ExtractorLike> | null = null;

  /** Module singleton; a rejected import resets the cache so a later call retries. */
  const loadModuleOnce = (): Promise<TransformersModuleLike> => {
    if (cachedModule === null) {
      cachedModule = loadModule().catch((error: unknown) => {
        cachedModule = null;
        throw error;
      });
    }
    return cachedModule;
  };

  const load = (): Promise<ExtractorLike> => {
    if (pipelinePromise === null) {
      pipelinePromise = loadModuleOnce()
        .then(async (module) => {
          // Belt AND braces for the cache location: the per-pipeline
          // `cache_dir` option is honored by 4.x, and the module-level env is
          // assigned for the load paths that read env first.
          if (module.env !== undefined && module.env !== null) {
            module.env.cacheDir = options.cacheDir;
          }
          return module.pipeline('feature-extraction', MEMORY_EMBEDDING_MODEL, {
            // Quantized CPU weights: smallest download, fastest local embed.
            dtype: 'q8',
            device: 'cpu',
            cache_dir: options.cacheDir,
            env: { cacheDir: options.cacheDir },
          });
        })
        .catch((error: unknown) => {
          // Failed pipeline construction: retry on the next embed.
          pipelinePromise = null;
          throw error;
        });
    }
    return pipelinePromise;
  };

  /** Flatten the tensor output safely for a single string input. */
  const toVector = (output: TensorLike): number[] => {
    // `tolist()` yields [batch][dims]; a single string is batch 1.
    if (typeof output.tolist === 'function') {
      const nested = output.tolist() as unknown;
      if (Array.isArray(nested) && Array.isArray(nested[0])) {
        return Array.from(nested[0] as ArrayLike<unknown>) as number[];
      }
      if (Array.isArray(nested) && typeof nested[0] === 'number') {
        return Array.from(nested) as number[];
      }
    }
    if (output.data instanceof Float32Array || output.data instanceof Float64Array) {
      return Array.from(output.data) as number[];
    }
    if (typeof output.data === 'object' && output.data !== null) {
      const maybeArrayLike = output.data as { length?: unknown; [index: number]: unknown };
      const length = maybeArrayLike.length;
      if (typeof length === 'number' && Number.isInteger(length)) {
        return Array.from(maybeArrayLike as ArrayLike<number>);
      }
    }
    throw new Error('local embedding returned an unsupported tensor shape');
  };

  const validate = (vector: readonly unknown[]): void => {
    if (vector.length !== DIMENSIONS) {
      throw new Error(`local embedding returned ${vector.length} values; expected exactly ${DIMENSIONS}`);
    }
    for (const value of vector) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('local embedding returned a non-finite value');
      }
    }
  };

  return {
    dimensions: DIMENSIONS,
    model: MEMORY_EMBEDDING_MODEL,

    preload: async (): Promise<void> => {
      await load();
    },

    embed: async (text: string): Promise<readonly number[]> => {
      const extractor = await load();
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      const vector = toVector(output);
      validate(vector);
      return vector;
    },
  };
}
