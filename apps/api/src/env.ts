/**
 * Gitignored env-file hydration for the real API startup: called ONLY inside
 * `startServer` (before `loadApiConfig()`), never on a bare module import —
 * tests import this module freely, and the server module's entry point is
 * guarded by `WORKFORCE_API_SKIP_LISTEN`.
 *
 * Default files, loaded in this order; the FIRST file that sets a key wins
 * (highest precedence first, see `envFilePaths`):
 *
 * 1. `apps/api/.env.local`   (highest precedence)
 * 2. `.env.local`            (repo root)
 * 3. `apps/api/.env`
 * 4. `.env`                  (repo root, lowest precedence)
 *
 * `process.loadEnvFile` (Node 24 built-in) has NO-OVERRIDE semantics: any
 * value already in `process.env` wins over the file — whether it was
 * exported in the shell (always beats every file) or came from a
 * higher-precedence file loaded earlier in this loop. An existing empty
 * string also wins (Node's documented behavior — verified for Node 24.20).
 * To let an env file fill a key, unset it in the shell.
 *
 * Directories resolve from `import.meta.url` (both `src/` and `dist/` are
 * exactly one level under `apps/api`), never `process.cwd()`, so hydration
 * behaves the same under `tsx src/server.ts` and `node dist/server.js`.
 *
 * A present-but-unreadable file (permission, or a directory in its place)
 * fails startup with the single fixed literal `ENV_FILE_FAILURE_MESSAGE`,
 * which `startupFailureReason` maps verbatim. Nothing else is ever thrown,
 * logged, or echoed: no parser/system errors, no paths, no contents. The
 * Node parser itself is lenient with unusual lines, so unreadable — not
 * "malformed syntax" — is the failure case in practice.
 *
 * Zero logging anywhere in this module: env-file paths and contents are
 * sensitive.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Safe startup-failure text; mapped verbatim in `startupFailureReason`. */
export const ENV_FILE_FAILURE_MESSAGE = 'Environment file could not be loaded.';

/**
 * Loads the given env files in order; the FIRST one that sets a key wins.
 * The explicit list keeps tests hermetic: they pass temp files only, so the
 * real repo env files are touched exclusively by `loadProjectEnvFiles()`.
 */
export function loadEnvFiles(files: readonly string[]): void {
  for (const file of files) {
    if (!existsSync(file)) {
      continue; // Missing file: a no-op.
    }
    try {
      // Node's documented no-override: existing process.env values win.
      process.loadEnvFile(file);
    } catch {
      // Fixed literal only; never a system/parser error, path, or content.
      throw new Error(ENV_FILE_FAILURE_MESSAGE);
    }
  }
}

/** Exact default file list, highest precedence first. Pure — no fs access. */
export function envFilePaths(rootDir: string, apiDir: string): string[] {
  return [
    join(apiDir, '.env.local'),
    join(rootDir, '.env.local'),
    join(apiDir, '.env'),
    join(rootDir, '.env'),
  ];
}

/** Loads the default four env files for this checkout, relative paths-free. */
export function loadProjectEnvFiles(): void {
  // env.ts lives at apps/api/src/ or apps/api/dist/ — exactly one level under
  // apps/api, and apps is exactly one level under the repo root.
  const moduleDir = dirname(fileURLToPath(import.meta.url)); // .../apps/api/{src,dist}
  const apiDir = dirname(moduleDir); // .../apps/api
  const rootDir = dirname(dirname(apiDir)); // .../ (apps/api → apps → repo root)
  loadEnvFiles(envFilePaths(rootDir, apiDir));
}
