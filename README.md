# Workforce

A local-first TypeScript workspace where AI agents research, analyze, write,
remember, delegate, and run scheduled work. You chat with a four-agent roster
over a streaming pipeline backed by Postgres (pgvector), Redis (BullMQ), and
Ollama Cloud. Authentication is built in: every resource is owned by the
signed-in user.

## Features

**Chat workspace**

- Four agents with fixed toolsets: General (calculate only), Orchestrator
  (query data, search memory, write documents, delegate, ask you questions),
  Analyst (query data, search memory), Researcher (search memory).
- Plan and Action modes per reply. Plan drafts without write or delegation
  tools; Action runs an agent's full toolset. New chats start in Plan.
- Streaming SSE responses with idempotency keys, safe retries, and full
  replay on refresh or disconnect within the same running API process.
- Human-in-the-loop: an agent can pause mid-turn with an `ask_user` question
  and the composer becomes the answer channel.
- Chat management: delete a chat (artifacts survive), non-destructive branch
  from any message into a new chat, and confirmed destructive rewind that
  truncates back to a chosen message.
- Three-pane layout: recent chats in the left rail, the conversation in the
  center, and a Session panel on the right with real token usage, a bounded
  context-percentage for the latest request, tool counts, and delegation
  status. A searchable model picker with per-model details sits in the
  composer. Light and dark themes.

**Agents, memory, and work**

- Delegation to Analyst or Researcher as specialist child chats, sync
  (result inline) or async (isolated child chat over BullMQ), depth-capped,
  always through the agent's own REST contract.
- Path-addressed memory in Postgres with pgvector: local MiniLM 384-dim
  embeddings, semantic plus recency ranking, typed relations, supersession,
  and background compaction. Opt-in personal capture/recall, off by default.
- Versioned Work Documents with compare-and-swap updates, an immutable
  revision trail, rollback, and typed links back to their origin.
- A UTC-only scheduler (ONCE, DAILY, WEEKLY, MONTHLY, custom cron) driven by
  BullMQ delayed and repeatable jobs, with isolated execution chats, attempt
  tracking with exponential backoff, and a dead-letter queue with manual
  retry.

**Models**

- Dynamic catalog from Ollama Cloud, default `glm-5.3-flash`, per-chat model
  selection that applies to the next generation. Kimi ids are blocked by
  policy by default. Exact per-message and per-chat token usage; cost estimates
  appear only when you configure explicit rates and are always labeled as
  estimates.

**Auth and tenancy**

- Google and GitHub sign-in through Better Auth with database-backed sessions.
  Resources (chats, documents, delegations, scheduler tasks, memory scopes)
  are resolved per owner; Redis keys and SQL queries are owner-scoped. At
  least one complete OAuth provider pair must be configured; the production
  API has no unauthenticated fallback.

## Architecture

```
Browser (Next.js 15, port 3000)
  |  Better Auth session cookie; AI SDK UI message stream
  v
Express API (port 3001)  <---->  Ollama Cloud (OpenAI-compatible)
  |            |
  |            +--> Redis 6379 (BullMQ queues, streams, idempotency)
  +--> Postgres 55432 (pgvector: memory, documents, auth, scheduler)
       |
       +--> Memory and delegation workers run in the API process; the
            scheduler worker is a separate process. All workers call the
            API's own REST routes; nothing bypasses the validated contracts.
```

## Quick start

Prerequisites: Node.js 24+, Docker, an Ollama Cloud API key, and a Google or
GitHub OAuth app. The OAuth callback URLs must be
`http://localhost:3001/api/auth/callback/google` and
`http://localhost:3001/api/auth/callback/github`; the OAuth app homepage is
`http://localhost:3000`. `BETTER_AUTH_URL` is `http://localhost:3001`, the web
origin is `http://localhost:3000`, and the cookie flow assumes both run on
`localhost` (same-site deployment).

```sh
npm install
cp .env.example .env      # fill in the values below
npm run dev:infra         # starts Redis and Postgres containers
npm run dev               # builds core+queue, applies migrations, starts api + web + scheduler
```

Open `http://localhost:3000`. The API listens on 3001, Redis on 6379, and
Postgres on host port 55432.

Required values in `.env`:

```
OLLAMA_API_KEY=<your Ollama Cloud key>
BETTER_AUTH_SECRET=<random string, at least 16 characters>
BETTER_AUTH_URL=http://localhost:3001
DELEGATION_CONTEXT_SECRET=<random string, at least 16 characters>
WEB_ORIGIN=http://localhost:3000
# At least one complete pair:
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# and/or
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

`DATABASE_URL` defaults to
`postgresql://workforce:workforce@127.0.0.1:55432/workforce`. The `dev:infra`
compose services are for development only; do not expose them publicly. The
production Docker stack is documented in the next section; the Railway plan
([ADR-009](docs/decisions/ADR-009-railway-deployment.md), the
[runbook](docs/deployment/railway.md)) is designed but **not deployed**. Full
configuration, RLS, and env precedence are documented in
[`apps/api/README.md`](apps/api/README.md).

## Docker production stack (Phase 6, local)

One-command local production stack — postgres (pgvector) + redis + a one-shot
`prisma migrate deploy` release container + api + web + scheduler worker:

```sh
cp .env.example .env       # fill in the same required values as `npm run dev`
docker compose up --build  # or: npm run docker:up
```

The api image (built from `apps/api/Dockerfile`, Node 24 bookworm-slim,
multi-stage, non-root `node` user) runs `node apps/api/dist/server.js`; the
scheduler reuses the SAME image with `node apps/api/dist/scheduler-worker.js`
and receives only `REDIS_URL`, `INTERNAL_API_BASE_URL`,
`DELEGATION_CONTEXT_SECRET` and optional queue/timeout values. The web image
(`apps/web/Dockerfile`) ships the Next.js standalone output and binds
`0.0.0.0`; `NEXT_PUBLIC_API_URL` is the one public build-arg (never a
secret). Migrations NEVER run inside the api/scheduler processes; the
`migrate` container applies `prisma migrate deploy` (existing
`packages/core/scripts/prisma-migrate.mjs` wrapper) and the api waits for its
successful completion.

Local modes (pick ONE coherent pair; only the WEB rewrite is baked — switching
the web target requires `docker compose up --build`):

- **Direct API (default, no secrets):** web on 3000, API published on 3001;
  browser-facing URLs
  `NEXT_PUBLIC_API_URL=http://localhost:3001`, `BETTER_AUTH_URL=http://localhost:3001`,
  OAuth callbacks registered on `http://localhost:3001`. NO proxy override is
  needed: the web build's `API_INTERNAL_URL` (compose default
  `http://api:3001`) is used by the server-side `/api/*` rewrite only, and
  the client talks to the API directly, so the baked target stays inert.
  Runtime `WORKFORCE_INTERNAL_API_URL` keeps its default (API loopback,
  scheduler → `http://api:3001`) — it is a DIFFERENT setting from the web
  build arg and must NOT point at the web origin inside Compose (the
  scheduler would call itself).
- **Single-origin proxy (deployed topology, local):** everything
  browser-facing uses the public WEB URL (default `http://localhost:3000`):
  `NEXT_PUBLIC_API_URL=http://localhost:3000`, `BETTER_AUTH_URL=http://localhost:3000`,
  callbacks `http://localhost:3000/api/auth/callback/google|github`, and
  `WORKFORCE_WEB_INTERNAL_API_URL=http://api:3001` (the compose default —
  normally no override needed) so the web build bakes
  `/api/:path* -> http://api:3001/api/:path*`; the API stays private.
  Runtime `WORKFORCE_INTERNAL_API_URL` keeps its defaults unchanged.

Facts about the stack:

- Images never bake secrets: every provider/OAuth/auth value arrives at
  runtime from the environment or the optional root `.env`. Changing them
  never triggers a rebuild. The web rewrite authority is the exception in
  the other direction: the web build arg `API_INTERNAL_URL` comes from
  `WORKFORCE_WEB_INTERNAL_API_URL` (build-time; resolved by `next.config.ts`
  into the baked routes manifest) — changing it REQUIRES
  `docker compose up --build`. Runtime calls use the DISTINCT
  `WORKFORCE_INTERNAL_API_URL`: API defaults to loopback
  (`http://127.0.0.1:3001`) and scheduler to `http://api:3001` — two
  different settings, never bind them to one variable inside Compose.
- Host ports are loopback-only and env-overridable: `WEB_HOST_PORT`
  (default 3000), `API_HOST_PORT` (default 3001), `REDIS_HOST_PORT`
  (default 6379), `POSTGRES_HOST_PORT` (default 55432). If you move api/web
  off 3001/3000, keep the browser-facing URLs coherent:
  `NEXT_PUBLIC_API_URL`, `BETTER_AUTH_URL` (both then
  `http://localhost:<API_HOST_PORT>`) and `WEB_ORIGIN`
  (`http://localhost:<WEB_HOST_PORT>`).
- Inside the compose network, `DATABASE_URL`/`REDIS_URL` always use the
  internal hostnames (`postgres:5432`, `redis:6379` — never the host ports).
  A local-dev URL in `.env` is ignored. Override the topology with
  `WORKFORCE_DATABASE_URL` / `WORKFORCE_REDIS_URL` (external managed stores).
- Volumes: `postgres-data`, `redis-data` (same as `dev:infra`) plus
  `embedding-cache` for the Transformers.js MiniLM model cache.
- Graceful stop: SIGTERM → bounded drain (api/scheduler exit 0);
  `docker compose down` cleans containers/networks; volumes persist until
  `down -v`.
- Scripts: `docker:build`, `docker:up`, `docker:down`, `docker:logs`.
  `dev:infra` (infra-only `compose up -d redis postgres`) is unchanged.

Validated locally 2026-11-25 (isolated compose project on alternate ports
3200/3201, PostgreSQL/Redis on 55433/16379, DUMMY provider/OAuth secrets —
no real provider or OAuth calls): image builds, `migrate deploy` applies all
8 migrations on a fresh DB, `/health` 200, `/api/auth/providers` reflects
the configured (dummy) Google pair, web `/sign-in` 200 + `/_next/static`
asset 200, scheduler starts on the minimal env (verified key list only) and
runs both processes as uid 1000; SIGTERM stop exits 0 for api/web/scheduler;
clean teardown removed only the isolated project's resources. Details and
honest gaps in [`docs/phases/phase-6-deploy.md`](docs/phases/phase-6-deploy.md).

Runtime single-origin validation 2026-11-27 (isolated mock stack — local mock
OpenAI/Ollama, dummy secrets, no real provider/OAuth): same-origin chat
streams through the baked `/api/:path*` rewrite with idempotent 409 and full
same-process replay; SSR chat hydration works in the standalone runtime
(runtime `API_INTERNAL_URL`); the scheduler container completes a MANUAL run
with deterministic request-id correlation across scheduler and API logs; the
scheduler healthcheck goes unhealthy when the API stops and recovers on
restart; graceful stop/restart preserves transcripts, tasks, executions,
users and sessions. Phase 6 remains active and not validated; no Railway
deploy exists.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | API + web + scheduler worker, with migrations via `predev`. |
| `npm run typecheck` | Strict TypeScript across all workspaces. |
| `npm test` | Offline unit tests for every workspace. |
| `npm run build` | Production build of all workspaces. |
| `npm run test:integration` | REAL Redis + Postgres/BullMQ suites; models are mocked, no provider key needed. |
| `npm run test:embedding` | Real Transformers.js MiniLM smoke test; downloads a ~30 MB model once into a gitignored cache. |
| `npm run docker:up` | One-command production stack: postgres + redis + migrate + api + web + scheduler (see Docker production stack). |
| `npm run docker:build` | Build the api/web/migrate images. |
| `npm run docker:down` | Stop and remove the stack containers/network (volumes persist). |
| `npm run docker:logs` | Tail all stack logs (follow). |

## Project structure

```
apps/web          Next.js 15 client (App Router, React 19)
apps/api          Express 4 API: chat streaming, auth, models, memory,
                  delegations, work docs, scheduler, settings routes
apps/cli          Interactive terminal REPL for agent runs
packages/core     Shared contracts, Prisma schema, agent rosters, migration tooling
packages/queue    BullMQ queue and worker primitives
docs/architecture.md          System overview
docs/phases/                  Build records: streaming, memory, delegation,
                              scheduler, deployment plan
docs/decisions/               ADR-001..008 (composition gating, same-REST
                              tools, delegation depth, SSE idempotency, BullMQ
                              schedulers, pgvector, AI SDK UI streams)
```

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 24, strict TypeScript |
| Web | Next.js 15 (App Router), React 19, Tailwind CSS 4, shadcn/ui, Radix |
| AI | AI SDK v6 (`useChat` + `DefaultChatTransport`), Ollama Cloud, local MiniLM embeddings via Transformers.js |
| API | Express 4, Better Auth (Google + GitHub, DB sessions), Zod validation |
| Data | Prisma 6, Postgres 16 with pgvector, Redis with BullMQ |
| Streaming | Server-sent events with idempotency keys and replay |

## Documentation

- [`docs/architecture.md`](docs/architecture.md): system overview.
- [`docs/phases/`](docs/phases/): dated build records per phase, including
  the scheduler gate and the deployment plan.
- [`docs/decisions/`](docs/decisions/): ADR-001 through ADR-008.
- [`apps/api/README.md`](apps/api/README.md): full API reference, configuration
  table, env precedence, RLS details, and integration suite notes.
- [`apps/web/README.md`](apps/web/README.md): web client routes, contracts,
  and UI architecture.

## Status

The local stack and all features above are implemented and locally validated:
the Phase 6 production stack (Docker/Compose, one public web origin with the
API kept private, migrations as a release step, a separate scheduler
container) passed its local gate on 2026-11-27 — root typecheck +
**1,095 offline tests** + **62/62 real-integration tests** + full production
build, with mock providers and no real OAuth. Nothing is deployed: a Railway
deployment is planned (ADR-009, runbook) but the public URL, real
Google/GitHub OAuth return, real Ollama traffic, and cross-process replay are
deliberately deferred — Phase 6 is active and **not validated**.
Cost figures are estimates derived only from explicitly configured rates; the
product never fabricates pricing.
