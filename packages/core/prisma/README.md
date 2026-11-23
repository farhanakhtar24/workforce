# Memory Prisma schema — usage and drift policy

Schema for the Phase 3 memory domain (`packages/core/prisma/schema.prisma`).
Generated client goes to `packages/core/generated/prisma` (gitignored;
rebuild via `npm run build` in `packages/core`, which runs `prisma generate`).

## Migration policy (read before running any prisma migrate command)

The memory migrations are **handwritten** (`20261119000000_memory_core`
bootstrap, `20261120000000_memory_superseded_by_many_to_one` forward fix-up
that makes `MemoryBlock.supersededById` non-unique with a plain index,
`20261120000100_memory_relation_tuple_unique` that restores the
`MemoryRelation (sourceId, targetId, type)` tuple uniqueness) and intentionally
contain pieces Prisma cannot express:

- CHECK constraints on `MemoryBlock` (confidence range, content length,
  scope/path shape, access count) — SQL-only by design.
- The HNSW pgvector index (`USING hnsw (embedding vector_cosine_ops)`),
  which is SQL-only by design.
- `MemoryBlock.supersededById` is deliberately NON-unique (many-to-one: one
  summary/correction supersedes many sources). The bootstrap migration created
  it unique; `20261120000000_memory_superseded_by_many_to_one` drops that
  constraint and adds a plain index. Already-applied migrations are never
  edited — new forward migrations only.

Because of these additions, `prisma migrate dev` / `prisma migrate diff`

- may propose to DROP the SQL-only CHECK constraints and the HNSW index, and
- run interactively against a database (with shadow-DB/reset behavior).

Therefore:

1. NEVER run destructive migration commands (`migrate dev`,
   `db push`) against deployed data.
2. Apply schema changes with `prisma migrate deploy` of the handwritten
   migrations only, or add a NEW handwritten migration that creates the
   intended objects explicitly.
3. Keep existing indexes and constraints intact; extend, do not remove.
4. If Prisma schema and SQL drift apart, reconcile the `schema.prisma` metadata
   (indexes/enums/columns) with the SQL by hand and re-run `prisma generate`;
   do not let a diff-generated migration delete SQL-only objects.
5. `packages/core/prisma` docs (this folder) are the source of truth for the
   drift policy, per review finding 3.

## pgvector requirements

- Postgres 12+ with the `vector` extension available. The migration runs
  `CREATE EXTENSION IF NOT EXISTS vector`.
- HNSW requires pgvector 0.5.0+.
- `hnsw.iterative_scan` (optional, used by the candidate fetch when present)
  requires pgvector 0.8.0+. The adapter probes the installed `extversion` and
  only enables it when available; otherwise it relies on
  `hnsw.ef_search = 200` alone.

## Environment

`prisma generate` requires `DATABASE_URL` to be set (it validates the schema
only; it never connects). `packages/core/scripts/prisma-generate.mjs` injects a
placeholder when the variable is unset or empty, so builds work without a
database.

Migrations behave differently: `prisma migrate deploy` really connects, and the
Prisma CLI auto-loads the repository `.env` (which ships `DATABASE_URL=` empty
on purpose) — an empty value fails schema load with P1012.
`packages/core/scripts/prisma-migrate.mjs` (root `npm run db:migrate`) injects
the local dev default (the docker-compose `postgres` service) when
`DATABASE_URL` is unset or blank and preserves any nonempty URL the caller
exports (the process environment takes precedence over the `.env` auto-load
inside the CLI). The wrapper never prints the URL, runs from the package root
against `prisma/schema.prisma`, and never starts containers.
