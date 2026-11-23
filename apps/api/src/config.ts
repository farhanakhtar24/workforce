import path from 'node:path';
import { z } from 'zod';

/**
 * Immutable runtime configuration for the Workforce API.
 *
 * Invariants:
 * - `apiKey` exists only on this object; the provider factory consumes it.
 *   It must never be logged or appear in any response or error message.
 * - Error messages describe the variable name and reason only, never values,
 *   so secrets can never leak through a thrown error. This includes the
 *   `databaseUrl`, whose value is never echoed anywhere (it may embed a
 *   password).
 * - `apiKey` is optional here: tests inject a mock model / an in-memory store
 *   and need none. `src/server.ts` refuses to start without it.
 * - `databaseUrl` carries a LOCAL DEV DEFAULT ONLY
 *   (`postgresql://workforce:workforce@127.0.0.1:55432/workforce`, matching the
 *   docker-compose `postgres` service), overridable via `DATABASE_URL`. It
 *   never carries a real deployment credential: Phase 6 deployment must set an
 *   explicit secret URL. Tests inject a store; buildApp callers may pass null.
 * - `embeddingCacheDir` is resolved to an ABSOLUTE path inside the app cwd so
 *   the Transformers.js model cache is always repo-local.
 */
export interface ApiConfig {
  readonly apiKey: string | null;
  readonly baseUrl: string;
  readonly model: string;
  readonly redisUrl: string;
  readonly port: number;
  readonly webOrigin: string;
  /**
   * Postgres/postgresql connection URL; consumed only by `src/server.ts`.
   * Defaults to the local dev stack; nullable because injected callers may
   * deliberately pass null (server.ts still refuses a null at startup).
   */
  readonly databaseUrl: string | null;
  /** Absolute repo-local directory for the local embedding model cache. */
  readonly embeddingCacheDir: string;
}

/** Default model cache directory, resolved relative to the process cwd. */
export const DEFAULT_EMBEDDING_CACHE_DIR = '.cache/workforce-models';

/**
 * Local dev default Postgres URL, matching the docker-compose `postgres`
 * service (pgvector/pgvector:pg16, db/user/password all `workforce`). LOCAL
 * DEVELOPMENT ONLY: Phase 6 deployment must set an explicit secret URL via
 * `DATABASE_URL`. The value is never logged or echoed in an error.
 */
export const DEFAULT_DATABASE_URL = 'postgresql://workforce:workforce@127.0.0.1:55432/workforce';

/** Resolves the cache dir to an absolute path inside the app cwd. */
export function resolveEmbeddingCacheDir(raw: string): string {
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

const envSchema = z.object({
  OLLAMA_API_KEY: z
    .string({ message: 'OLLAMA_API_KEY must be a string' })
    .trim()
    .min(1, 'OLLAMA_API_KEY must not be empty')
    .optional()
    .transform((value) => (value === undefined ? null : value)),
  OLLAMA_BASE_URL: z
    .string({ message: 'OLLAMA_BASE_URL must be a string' })
    .regex(/^https?:\/\/\S+$/, 'OLLAMA_BASE_URL must be an http(s) URL')
    .default('https://ollama.com/v1')
    .transform((value) => value.replace(/\/+$/, '')),
  OLLAMA_MODEL: z
    .string({ message: 'OLLAMA_MODEL must be a string' })
    .min(1, 'OLLAMA_MODEL must not be empty')
    .default('glm-5.3-flash'),
  REDIS_URL: z
    .string({ message: 'REDIS_URL must be a string' })
    .regex(/^rediss?:\/\/\S+$/, 'REDIS_URL must be a redis:// or rediss:// URL (default: redis://127.0.0.1:6379)')
    .default('redis://127.0.0.1:6379'),
  PORT: z.coerce
    .number({ message: 'PORT must be an integer between 1 and 65535 (default: 3001)' })
    .int('PORT must be an integer (default: 3001)')
    .min(1, 'PORT must be between 1 and 65535 (default: 3001)')
    .max(65535, 'PORT must be between 1 and 65535 (default: 3001)')
    .default(3001),
  WEB_ORIGIN: z
    .string({ message: 'WEB_ORIGIN must be an http(s) origin (default: http://localhost:3000)' })
    .regex(/^https?:\/\/[a-zA-Z0-9._-]+(:\d+)?$/, 'WEB_ORIGIN must be an http(s) origin without a path (default: http://localhost:3000)')
    .default('http://localhost:3000'),
  DATABASE_URL: z
    .string({ message: 'DATABASE_URL must be a postgres:// or postgresql:// URL' })
    .regex(/^postgres(ql)?:\/\/\S+$/, 'DATABASE_URL must be a postgres:// or postgresql:// URL')
    .default(DEFAULT_DATABASE_URL),
  EMBEDDING_CACHE_DIR: z
    .string({ message: 'EMBEDDING_CACHE_DIR must be a string (absolute path, or relative to the app cwd)' })
    .min(1, 'EMBEDDING_CACHE_DIR must not be empty')
    .default(DEFAULT_EMBEDDING_CACHE_DIR)
    .transform((value) => resolveEmbeddingCacheDir(value)),
});

/**
 * Validates `process.env` (or an explicit environment, for tests) and returns
 * a frozen {@link ApiConfig}. Does not load dotenv files.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(env)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid API configuration (values are never included): ${details}`);
  }
  const data = parsed.data;
  return Object.freeze({
    apiKey: data.OLLAMA_API_KEY,
    baseUrl: data.OLLAMA_BASE_URL,
    model: data.OLLAMA_MODEL,
    redisUrl: data.REDIS_URL,
    port: data.PORT,
    webOrigin: data.WEB_ORIGIN,
    databaseUrl: data.DATABASE_URL,
    embeddingCacheDir: data.EMBEDDING_CACHE_DIR,
  });
}
