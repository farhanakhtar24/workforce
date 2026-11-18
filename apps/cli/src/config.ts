import { z } from 'zod';

/**
 * Immutable runtime configuration for the Workforce CLI.
 *
 * `apiKey` is intentionally part of the config object (transport needs it),
 * but it must never be logged or included in error messages.
 */
export interface Config {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
}

const envSchema = z.object({
  OLLAMA_API_KEY: z
    .string({ message: 'OLLAMA_API_KEY is missing' })
    .min(1, 'OLLAMA_API_KEY must be a non-empty string'),
  OLLAMA_BASE_URL: z
    .string()
    .default('https://ollama.com/v1')
    .transform((value) => value.replace(/\/+$/, '')),
  OLLAMA_MODEL: z.string().default('glm-5.3-flash'),
  OLLAMA_TIMEOUT_MS: z.coerce
    .number()
    .int('OLLAMA_TIMEOUT_MS must be an integer')
    .positive('OLLAMA_TIMEOUT_MS must be a positive integer')
    .default(60000),
});

/**
 * Validates `process.env` (or an explicit environment, for tests) and returns
 * a frozen {@link Config}.
 *
 * Error messages contain only variable names and reasons, never values, so
 * the API key can never leak through a thrown error.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid CLI configuration (values are never included): ${details}`);
  }
  const data = parsed.data;
  return Object.freeze({
    apiKey: data.OLLAMA_API_KEY,
    baseUrl: data.OLLAMA_BASE_URL,
    model: data.OLLAMA_MODEL,
    timeoutMs: data.OLLAMA_TIMEOUT_MS,
  });
}
