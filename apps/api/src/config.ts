import path from 'node:path';
import { z } from 'zod';
import { parseOptionalAuthEnvironment, type ParsedAuthEnvironment } from './auth/env-config.js';

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
  /** Phase 4: loopback base the tools/delegation runner call (default `http://127.0.0.1:<PORT>`). */
  readonly internalApiBaseUrl: string;
  /** Phase 4: HMAC secret for the internal delegation context; null → per-boot random. */
  readonly delegationContextSecret: string | null;
  /** Phase 4: bounded child-delegation timeout in ms (default 120000). */
  readonly delegationTimeoutMs: number;
  /** Phase 4: statement_timeout for `query_data` (default 2000). */
  readonly queryStatementTimeoutMs: number;
  /** Phase 4: row cap for `query_data`, enforced as LIMIT cap+1 (default 200). */
  readonly queryRowCap: number;
  /**
   * Phase 5: scheduler execution budget (ms) for one internal chat POST
   * (default 180000); the runner adds a bounded margin on top for streaming.
   */
  readonly schedulerExecutionTimeoutMs: number;
  /**
   * Pre-Phase 6 Better Auth environment (secret/baseURL/OAuth pairs/
   * allowlist), parsed with the safe auth helpers, or `null` when NO auth
   * variable is set (tests/CLI). The real server REFUSES `null` and refuses
   * zero-configured-providers — production never falls back to
   * unauthenticated access.
   */
  readonly auth: ParsedAuthEnvironment | null;
  /** Pre-Phase 6 model policy: blocked model-id prefixes (lowercase, fixed
   * order, from `WORKFORCE_BLOCKED_MODEL_PREFIXES`, default `kimi`).
   */
  readonly blockedModelPrefixes: readonly string[];
  /**
   * Per-million model pricing from `OLLAMA_MODEL_PRICING_JSON`
   * (`{ "<modelId>": { "input": <usd/Mtok>, "output": <usd/Mtok> }, … }`), or
   * `null` when absent/invalid — usage cost stays `null` (never invented).
   */
  readonly modelPricing: Readonly<Record<string, { input: number; output: number }>> | null;
  /** Optional structured-log level (allowlisted; default info). */
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
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

/**
 * Blank-to-undefined preprocessing for environment input: a string value that
 * is empty or whitespace-only becomes `undefined`, so it is treated exactly
 * as absent and every existing default / optional transform applies. This
 * keeps older local env files (whose tracked template shipped blank lines for
 * the optional variables) compatible with startup. Any other value passes
 * through unchanged — nonempty strings (even with inner whitespace) and
 * non-string values — and is validated by the schema exactly as before, so
 * malformed nonempty values are still rejected with the safe variable-name
 * errors and no value is ever echoed.
 */
function blankToUndefined(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
}

/**
 * The environment variables whose blank values count as absent (see
 * {@link blankToUndefined}). Applied before schema validation in
 * {@link loadApiConfig}.
 */
const BLANK_AS_ABSENT_ENV_KEYS = [
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
  'REDIS_URL',
  'PORT',
  'WEB_ORIGIN',
  'DATABASE_URL',
  'EMBEDDING_CACHE_DIR',
  'INTERNAL_API_BASE_URL',
  'DELEGATION_CONTEXT_SECRET',
  'DELEGATION_TIMEOUT_MS',
  'QUERY_STATEMENT_TIMEOUT_MS',
  'QUERY_ROW_CAP',
  'SCHEDULER_EXECUTION_TIMEOUT_MS',
  'WORKFORCE_BLOCKED_MODEL_PREFIXES',
  'OLLAMA_MODEL_PRICING_JSON',
  // Compose passes LOG_LEVEL: ${LOG_LEVEL:-}, so an UNSET level arrives as
  // an empty string — blank = absent = the schema default ('info'). A
  // nonempty value still goes through the enum validation unchanged.
  'LOG_LEVEL',
] as const;

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
  // Phase 4: loopback base URL the capability tools/delegation runner call.
  // Parsed only for shape; a per-request URL is composed from it. Never echoed.
  INTERNAL_API_BASE_URL: z
    .string({ message: 'INTERNAL_API_BASE_URL must be a string' })
    .regex(/^https?:\/\/[a-zA-Z0-9._-]+(:\d+)?$/, 'INTERNAL_API_BASE_URL must be an http(s) origin without a path')
    .optional()
    .transform((value) => (value === undefined ? null : value.replace(/\/+$/, ''))),
  // Phase 4: HMAC secret for the internal delegation context. Optional: when
  // absent the server generates a throwaway randomBytes(32) secret per boot.
  // Never logged; never echoed in errors.
  DELEGATION_CONTEXT_SECRET: z
    .string({ message: 'DELEGATION_CONTEXT_SECRET must be a string' })
    .min(16, 'DELEGATION_CONTEXT_SECRET must be at least 16 characters')
    .optional()
    .transform((value) => (value === undefined ? null : value)),
  DELEGATION_TIMEOUT_MS: z.coerce
    .number({ message: 'DELEGATION_TIMEOUT_MS must be an integer between 1000 and 600000 (default: 120000)' })
    .int('DELEGATION_TIMEOUT_MS must be an integer (default: 120000)')
    .min(1000, 'DELEGATION_TIMEOUT_MS must be between 1000 and 600000 (default: 120000)')
    .max(600_000, 'DELEGATION_TIMEOUT_MS must be between 1000 and 600000 (default: 120000)')
    .default(120_000),
  QUERY_STATEMENT_TIMEOUT_MS: z.coerce
    .number({ message: 'QUERY_STATEMENT_TIMEOUT_MS must be an integer between 100 and 300000 (default: 2000)' })
    .int('QUERY_STATEMENT_TIMEOUT_MS must be an integer (default: 2000)')
    .min(100, 'QUERY_STATEMENT_TIMEOUT_MS must be between 100 and 300000 (default: 2000)')
    .max(300_000, 'QUERY_STATEMENT_TIMEOUT_MS must be between 100 and 300000 (default: 2000)')
    .default(2_000),
  QUERY_ROW_CAP: z.coerce
    .number({ message: 'QUERY_ROW_CAP must be an integer between 1 and 10000 (default: 200)' })
    .int('QUERY_ROW_CAP must be an integer (default: 200)')
    .min(1, 'QUERY_ROW_CAP must be between 1 and 10000 (default: 200)')
    .max(10_000, 'QUERY_ROW_CAP must be between 1 and 10000 (default: 200)')
    .default(200),
  // Phase 5: budget (ms) for one scheduler-run internal chat POST. Shared by
  // the API runner (adds a bounded stream margin) and the scheduler worker
  // (its fetch budget for the same call).
  SCHEDULER_EXECUTION_TIMEOUT_MS: z.coerce
    .number({
      message: 'SCHEDULER_EXECUTION_TIMEOUT_MS must be an integer between 1000 and 600000 (default: 180000)',
    })
    .int('SCHEDULER_EXECUTION_TIMEOUT_MS must be an integer (default: 180000)')
    .min(1000, 'SCHEDULER_EXECUTION_TIMEOUT_MS must be between 1000 and 600000 (default: 180000)')
    .max(600_000, 'SCHEDULER_EXECUTION_TIMEOUT_MS must be between 1000 and 600000 (default: 180000)')
    .default(180_000),
  // Pre-Phase 6 model policy: CSV of case-insensitive BLOCKED model-id
  // prefixes (parsed with the safe error contract in loadApiConfig).
  WORKFORCE_BLOCKED_MODEL_PREFIXES: z
    .string({ message: 'WORKFORCE_BLOCKED_MODEL_PREFIXES must be a string' })
    .max(4096, 'WORKFORCE_BLOCKED_MODEL_PREFIXES must be at most 4096 characters (default: kimi)')
    .default('kimi'),
  // Per-million model pricing JSON for usage cost estimates (optional; parsed
  // with the safe error contract in loadApiConfig; values never echoed).
  OLLAMA_MODEL_PRICING_JSON: z
    .string({ message: 'OLLAMA_MODEL_PRICING_JSON must be a string' })
    .max(65_536, 'OLLAMA_MODEL_PRICING_JSON must be at most 65536 characters')
    .optional(),
  // Optional structured-log level; allowlisted, malformed → fixed config
  // error (default: info). The VALUE is never logged/echoed.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'], {
      message: 'LOG_LEVEL must be one of the allowlisted pino levels',
    })
    .default('info'),
});

/**
 * Parses the CSV blocked-model-prefix list defensively: lowercased, trimmed,
 * de-duplicated, sorted; each prefix 1..64 chars of `a-z0-9._:-`; at most 16
 * entries. Throws the safe config-error contract (variable name only).
 */
function parseBlockedModelPrefixes(raw: string): readonly string[] {
  const prefixes = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .sort();
  for (const prefix of prefixes) {
    if (!/^[a-z0-9._:-]{1,64}$/.test(prefix)) {
      throw new Error('WORKFORCE_BLOCKED_MODEL_PREFIXES entries must be 1..64 characters of a-z 0-9 . _ : - (values are never included)');
    }
  }
  if (prefixes.length > 16) {
    throw new Error('WORKFORCE_BLOCKED_MODEL_PREFIXES must list at most 16 entries');
  }
  return prefixes;
}

/**
 * Parses the optional per-million model pricing JSON. Absent/blank → `null`
 * (usage cost stays `null`, never invented). Bounded: ≤ 200 models; keys are
 * model ids; entries exactly `{input, output}` finite ≥ 0. Throws the safe
 * config-error contract (variable name only, values never echoed).
 */
function parseModelPricingJson(raw: string | undefined): Readonly<Record<string, { input: number; output: number }>> | null {
  if (raw === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('OLLAMA_MODEL_PRICING_JSON must be a JSON object of { "<modelId>": { "input", "output" } } (values are never included)');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OLLAMA_MODEL_PRICING_JSON must be a JSON object of { "<modelId>": { "input", "output" } } (values are never included)');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 200) {
    throw new Error('OLLAMA_MODEL_PRICING_JSON must price at most 200 models (values are never included)');
  }
  const pricing: Record<string, { input: number; output: number }> = {};
  for (const [key, rate] of entries) {
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(key)) {
      throw new Error('OLLAMA_MODEL_PRICING_JSON keys must be 1..80 characters of A-Za-z0-9 . _ : - (values are never included)');
    }
    if (rate === null || typeof rate !== 'object' || Array.isArray(rate)) {
      throw new Error('OLLAMA_MODEL_PRICING_JSON model entries must be { "input": <number>, "output": <number> } (values are never included)');
    }
    const record = rate as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || !('input' in record) || !('output' in record)) {
      throw new Error('OLLAMA_MODEL_PRICING_JSON model entries must have exactly "input" and "output" (values are never included)');
    }
    const input = record['input'];
    const output = record['output'];
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
      throw new Error('OLLAMA_MODEL_PRICING_JSON rates must be finite nonnegative numbers (values are never included)');
    }
    pricing[key] = { input, output };
  }
  return pricing;
}

/**
 * Validates `process.env` (or an explicit environment, for tests) and returns
 * a frozen {@link ApiConfig}. Does not load dotenv files. Blank (empty or
 * whitespace-only) values for the supported variables are normalized to
 * absent first, so defaults/optional transforms apply instead of a rejection.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const normalized: Record<string, unknown> = { ...env };
  for (const key of BLANK_AS_ABSENT_ENV_KEYS) {
    normalized[key] = blankToUndefined(normalized[key]);
  }
  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(env)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid API configuration (values are never included): ${details}`);
  }
  const data = parsed.data;
  const blockedModelPrefixes = parseBlockedModelPrefixes(data.WORKFORCE_BLOCKED_MODEL_PREFIXES);
  const modelPricing = parseModelPricingJson(data.OLLAMA_MODEL_PRICING_JSON);
  return Object.freeze({
    apiKey: data.OLLAMA_API_KEY,
    baseUrl: data.OLLAMA_BASE_URL,
    model: data.OLLAMA_MODEL,
    redisUrl: data.REDIS_URL,
    port: data.PORT,
    webOrigin: data.WEB_ORIGIN,
    databaseUrl: data.DATABASE_URL,
    embeddingCacheDir: data.EMBEDDING_CACHE_DIR,
    internalApiBaseUrl: data.INTERNAL_API_BASE_URL ?? `http://127.0.0.1:${data.PORT}`,
    delegationContextSecret: data.DELEGATION_CONTEXT_SECRET,
    delegationTimeoutMs: data.DELEGATION_TIMEOUT_MS,
    queryStatementTimeoutMs: data.QUERY_STATEMENT_TIMEOUT_MS,
    queryRowCap: data.QUERY_ROW_CAP,
    schedulerExecutionTimeoutMs: data.SCHEDULER_EXECUTION_TIMEOUT_MS,
    auth: parseOptionalAuthEnvironment(env),
    blockedModelPrefixes,
    modelPricing,
    logLevel: data.LOG_LEVEL,
  });
  void data.LOG_LEVEL;
}
