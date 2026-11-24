/**
 * Safe environment parsing for the pre-Phase 6 Better Auth wiring.
 *
 * PARSE-ONLY: nothing here mutates the main API config (`src/config.ts`) or
 * starts anything — Phase 6 wiring will call `parseAuthEnvironment` from
 * `server.ts` and feed the values into `createWorkforceAuth`.
 *
 * Variable names (the ONLY names this module reads):
 *
 * - `BETTER_AUTH_SECRET`        required. Signing secret for Better Auth
 *                               cookies/tokens (>= 16 chars, mirroring
 *                               `DELEGATION_CONTEXT_SECRET`).
 * - `BETTER_AUTH_URL`           required. Absolute http(s) ORIGIN of the API
 *                               (e.g. `http://localhost:3001`); Better Auth
 *                               mounts its endpoints under `<baseURL>/api/auth`.
 * - `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`   optional COMPLETE pair.
 * - `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`   optional COMPLETE pair.
 * - `AUTH_EMAIL_ALLOWLIST`      optional. Comma-separated email addresses; a
 *                               non-empty value enables the signup allowlist
 *                               (absent/blank → null = no allowlist).
 *
 * Same security contract as `src/config.ts`: error messages name variables
 * and reasons only and NEVER echo values, so no credential can leak through
 * a thrown message. Blank values are treated exactly as absent.
 */
import { z } from 'zod';

/** Every auth variable this module may read (exact names). */
export const AUTH_ENV_KEYS = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'AUTH_EMAIL_ALLOWLIST',
] as const;

export type AuthEnvKey = (typeof AUTH_ENV_KEYS)[number];

export type SocialProviderId = 'google' | 'github';

/** A complete OAuth client credential pair (values are never logged). */
export interface AuthSocialCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Which optional social providers have a COMPLETE env credential pair. */
export interface ProviderAvailability {
  readonly google: ProviderAvailabilityEntry;
  readonly github: ProviderAvailabilityEntry;
}

export interface ProviderAvailabilityEntry {
  /** True only when BOTH credential variables are present and valid. */
  readonly available: boolean;
  /** Safe configuration hint (variable names only, never values). */
  readonly issue: string | null;
}

export interface ParseAuthProviderPairsResult {
  readonly google: AuthSocialCredentials | null;
  readonly github: AuthSocialCredentials | null;
  readonly availability: ProviderAvailability;
  /** Safe errors for incomplete/invalid pairs (variable names only). */
  readonly issues: readonly string[];
}

export interface ParsedAuthEnvironment {
  readonly secret: string;
  readonly baseURL: string;
  /** Complete-pair credentials, or null when the provider is not configured. */
  readonly google: AuthSocialCredentials | null;
  readonly github: AuthSocialCredentials | null;
  /** Safe metadata matching the credentials above (never echoes values). */
  readonly providerAvailability: ProviderAvailability;
  /** Parsed and normalized allowlist, or null when absent/blank. */
  readonly emailAllowlist: readonly string[] | null;
}

/** Blank (empty or whitespace-only) means absent, exactly like config.ts. */
function blankToUndefined(env: NodeJS.ProcessEnv, key: AuthEnvKey): string | undefined {
  const raw = env[key];
  if (typeof raw === 'string' && raw.trim() === '') {
    return undefined;
  }
  return typeof raw === 'string' ? raw : undefined;
}

const CLIENT_ID_SCHEMA = z
  .string({ message: 'must be a string' })
  .min(1)
  .max(512, 'must be at most 512 characters');

const CLIENT_SECRET_SCHEMA = z
  .string({ message: 'must be a string' })
  .min(1)
  .max(1024, 'must be at most 1024 characters');

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Parses one already-present credential value with a safe, variable-naming
 * error. Values are never included anywhere.
 */
function parseCredentialValue(env: NodeJS.ProcessEnv, key: AuthEnvKey, schema: z.ZodType<string>): string {
  const raw = blankToUndefined(env, key);
  if (raw === undefined) {
    throw new Error(`${key} must not be empty when set (values are never included)`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${key} ${parsed.error.issues[0]?.message ?? 'is invalid'} (values are never included)`);
  }
  return parsed.data;
}

/**
 * Provider credential pairs WITHOUT throwing (safe availability metadata):
 * a provider is `available` only with a COMPLETE pair; incomplete pairs
 * produce an issue that names the variables — never the values.
 */
export function parseAuthProviderEnv(env: NodeJS.ProcessEnv = process.env): ParseAuthProviderPairsResult {
  const parsePair = (
    clientIdKey: AuthEnvKey,
    clientSecretKey: AuthEnvKey,
  ): { credentials: AuthSocialCredentials | null; entry: ProviderAvailabilityEntry } => {
    let issue: string | null = null;
    let clientId = '';
    let clientSecret = '';
    try {
      const hasClientId = blankToUndefined(env, clientIdKey) !== undefined;
      const hasClientSecret = blankToUndefined(env, clientSecretKey) !== undefined;
      if (hasClientId && !hasClientSecret) {
        issue = `${clientIdKey} is set but ${clientSecretKey} is missing: the provider must be configured as a COMPLETE pair`;
      } else if (!hasClientId && hasClientSecret) {
        issue = `${clientSecretKey} is set but ${clientIdKey} is missing: the provider must be configured as a COMPLETE pair`;
      }
      if (hasClientId) {
        clientId = parseCredentialValue(env, clientIdKey, CLIENT_ID_SCHEMA);
      }
      if (hasClientSecret) {
        clientSecret = parseCredentialValue(env, clientSecretKey, CLIENT_SECRET_SCHEMA);
      }
    } catch (error) {
      issue = safeMessage(error, `${clientIdKey}/${clientSecretKey} are invalid`);
    }
    const available =
      issue === null && clientId.length > 0 && clientSecret.length > 0;
    const entry = { available, issue };
    const credentials = available
      ? Object.freeze({ clientId, clientSecret })
      : null;
    return { credentials, entry };
  };

  const google = parsePair('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
  const github = parsePair('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET');

  const issues = [google.entry.issue, github.entry.issue].filter(
    (entry): entry is string => entry !== null,
  );

  return {
    google: google.credentials,
    github: github.credentials,
    availability: Object.freeze({ google: google.entry, github: github.entry }),
    issues,
  };
}

/**
 * Parses `AUTH_EMAIL_ALLOWLIST` (optional). Absent/blank → null (no
 * allowlist). Entries are trimmed, lowercased, de-duplicated (first wins,
 * order preserved) and shape-checked; the entry bound keeps the parsed list
 * small. Error text names the position and rule — never the value.
 */
export function parseAuthEmailAllowlist(env: NodeJS.ProcessEnv = process.env): readonly string[] | null {
  const raw = blankToUndefined(env, 'AUTH_EMAIL_ALLOWLIST');
  if (raw === undefined) {
    return null;
  }
  const MAX_ENTRIES = 200;
  const MAX_EMAIL_LENGTH = 254;
  const seen = new Set<string>();
  const allowlist: string[] = [];
  for (const candidate of raw.split(',')) {
    const email = candidate.trim().toLowerCase();
    if (email.length === 0) {
      continue; // Trailing/inner commas are tolerated, not errors.
    }
    if (email.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      throw new Error(
        `AUTH_EMAIL_ALLOWLIST entry ${allowlist.length + 1} must be an email address of at most ${MAX_EMAIL_LENGTH} characters without whitespace (values are never included)`,
      );
    }
    if (seen.has(email)) {
      continue;
    }
    if (seen.size >= MAX_ENTRIES) {
      throw new Error(`AUTH_EMAIL_ALLOWLIST must list at most ${MAX_ENTRIES} entries`);
    }
    seen.add(email);
    allowlist.push(email);
  }
  return allowlist;
}

/**
 * The required Better Auth signing secret: validated for length only
 * ([16..512] chars, mirroring `DELEGATION_CONTEXT_SECRET`'s 16-char floor).
 * Undefined/missing is signalled by returning undefined; the caller reports
 * it through the safe aggregate error.
 */
function parseAuthSecret(env: NodeJS.ProcessEnv): string | undefined {
  const raw = blankToUndefined(env, 'BETTER_AUTH_SECRET');
  if (raw === undefined) {
    return undefined;
  }
  if (raw.length < 16) {
    throw new Error('BETTER_AUTH_SECRET must be at least 16 characters (values are never included)');
  }
  if (raw.length > 512) {
    throw new Error('BETTER_AUTH_SECRET must be at most 512 characters (values are never included)');
  }
  return raw;
}

/** Same origin-only shape as `WEB_ORIGIN` in `src/config.ts`. */
const AUTH_BASE_URL_PATTERN = /^https?:\/\/[a-zA-Z0-9._-]+(:\d+)?$/;

function parseAuthBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = blankToUndefined(env, 'BETTER_AUTH_URL');
  if (raw === undefined) {
    return undefined;
  }
  if (!AUTH_BASE_URL_PATTERN.test(raw)) {
    throw new Error(
      'BETTER_AUTH_URL must be an http(s) origin without a path (values are never included)',
    );
  }
  return raw;
}

/**
 * Parses the full auth environment; throws ONE safe error listing every
 * problem when a required piece is missing or a provider pair is
 * incomplete (values are never included). Returns a frozen object ready to
 * feed `createWorkforceAuth`.
 */
export function parseAuthEnvironment(env: NodeJS.ProcessEnv = process.env): ParsedAuthEnvironment {
  const issues: Array<string | null> = [];

  const secret = (() => {
    try {
      return parseAuthSecret(env);
    } catch (error) {
      issues.push(safeMessage(error, 'BETTER_AUTH_SECRET is invalid'));
      return undefined;
    }
  })();

  const baseURL = (() => {
    try {
      return parseAuthBaseUrl(env);
    } catch (error) {
      issues.push(safeMessage(error, 'BETTER_AUTH_URL is invalid'));
      return undefined;
    }
  })();

  const providers = parseAuthProviderEnv(env);

  issues.push(
    secret === undefined
      ? 'BETTER_AUTH_SECRET is required when auth is enabled (at least 16 characters)'
      : null,
    baseURL === undefined
      ? 'BETTER_AUTH_URL is required when auth is enabled (an http(s) origin without a path)'
      : null,
  );

  let emailAllowlist: readonly string[] | null = null;
  try {
    emailAllowlist = parseAuthEmailAllowlist(env);
  } catch (error) {
    issues.push(safeMessage(error, 'AUTH_EMAIL_ALLOWLIST is invalid'));
  }

  const fatalIssues = [
    ...issues.filter((issue): issue is string => issue !== null),
    ...providers.issues,
  ];

  if (fatalIssues.length > 0) {
    throw new Error(
      `Invalid auth configuration (values are never included): ${fatalIssues.join('; ')}`,
    );
  }

  return Object.freeze({
    secret: secret ?? '',
    baseURL: baseURL ?? '',
    google: providers.google,
    github: providers.github,
    providerAvailability: providers.availability,
    emailAllowlist,
  });
}

/**
 * Parses the auth environment ONLY when any auth variable is present
 * (non-blank); a completely absent/blank set returns `null` so `loadApiConfig`
 * callers that do not opt into authentication keep working (tests, CLI).
 * Any presence — even an incomplete setup — runs the FULL safe validation
 * and throws the same aggregate error, so half-set variables can never
 * pass silently.
 */
export function parseOptionalAuthEnvironment(env: NodeJS.ProcessEnv = process.env): ParsedAuthEnvironment | null {
  const anyPresent = AUTH_ENV_KEYS.some((key) => {
    const raw = env[key];
    return typeof raw === 'string' && raw.trim() !== '';
  });
  if (!anyPresent) {
    return null;
  }
  return parseAuthEnvironment(env);
}
