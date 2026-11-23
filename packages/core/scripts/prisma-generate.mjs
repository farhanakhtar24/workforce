/**
 * Runs `prisma generate` for @workforce/core.
 *
 * Why a wrapper script instead of a raw `prisma generate` script entry:
 * `prisma generate` refuses to run when the datasource `DATABASE_URL`
 * environment variable is missing or empty, even though generation never
 * touches the database. The repository `.env` ships `DATABASE_URL=` empty on
 * purpose (no local Postgres is required to build the package), so the
 * wrapper only injects a syntactically valid placeholder when the variable is
 * unset or blank. The placeholder is never used to connect; it only satisfies
 * schema validation.
 *
 * Keeping the wrapper in `scripts/` (run with plain `node`) also avoids
 * POSIX-only shell syntax so the build works the same on every platform that
 * runs Node 20+.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
  process.env.DATABASE_URL =
    'postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder?schema=public';
}

const prismaCliEntry = require.resolve('prisma/build/index.js');
const result = spawnSync(process.execPath, [prismaCliEntry, 'generate', ...process.argv.slice(2)], {
  cwd: packageRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 0;
