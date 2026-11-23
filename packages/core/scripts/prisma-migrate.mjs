/**
 * Runs `migrate deploy` (the handwritten memory migrations in
 * `packages/core/prisma/migrations`) for @workforce/core.
 *
 * Why a wrapper script instead of a raw `npx prisma migrate deploy`:
 * the Prisma CLI auto-loads the repository `.env`, which ships `DATABASE_URL=`
 * empty on purpose, and an empty datasource URL fails schema load with P1012
 * even though the API layer carries its own default. The wrapper injects the
 * local dev default (the docker-compose `postgres` service; see
 * `apps/api/src/config.ts` `DEFAULT_DATABASE_URL` for the same value) exactly
 * when the variable is unset or blank, and preserves any nonempty URL the
 * caller exports — a value already present in the process environment also
 * takes precedence over the `.env` file inside the CLI, so an exported
 * `DATABASE_URL` survives the auto-load. The URL is never printed by this
 * wrapper.
 *
 * Keeping the wrapper in `scripts/` (run with plain `node`) also avoids
 * POSIX-only shell syntax, mirroring `prisma-generate.mjs`.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(
    'Usage: node packages/core/scripts/prisma-migrate.mjs [-h/--help] [extra prisma migrate deploy args]\n' +
      '\n' +
      'Applies the handwritten memory migrations of @workforce/core with\n' +
      '"prisma migrate deploy --schema prisma/schema.prisma" (run from the package root).\n' +
      '\n' +
      'DATABASE_URL handling: the process environment is used as-is when the variable\n' +
      'is set and nonempty. When it is unset or blank, the local dev default (the\n' +
      'docker-compose "postgres" service) is injected for the deploy. The value is\n' +
      'never printed. A reachable Postgres with pgvector must already be up — the\n' +
      'wrapper never starts containers.',
  );
  process.exit(0);
}

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
  process.env.DATABASE_URL =
    'postgresql://workforce:workforce@127.0.0.1:55432/workforce';
}

const prismaCliEntry = require.resolve('prisma/build/index.js');
const result = spawnSync(
  process.execPath,
  [prismaCliEntry, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma', ...args],
  {
    cwd: packageRoot,
    stdio: 'inherit',
    env: process.env,
  },
);

if (result.error) {
  throw result.error;
}

if (result.signal) {
  const signalNumber = os.constants.signals[result.signal] ?? 0;
  console.error(`prisma migrate deploy was terminated by ${result.signal}`);
  process.exit(128 + signalNumber);
}

process.exitCode = result.status ?? 1;
