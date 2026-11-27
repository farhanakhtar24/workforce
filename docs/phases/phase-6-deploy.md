# Phase 6 — Docker, Deploy, Observability

**Duration**: 1 week
**Goal**: Live URL. Not localhost.

> Goal amendment (2026-11-27): Farhan chose **LOCAL ONLY** for now. The original public-URL goal stands **deferred by user decision**, not achieved — everything below keeps that distinction explicit.

> Status (2026-11-27): **Active — in progress (LOCAL ONLY).** The local Docker/Compose artifact exists (2026-11-25 record below, 2026-11-27 Compose single-origin wiring alignment, and the **2026-11-27 LOCAL production validation — PASSED**, record below). No deploy, no public URL, no target decision executed; Railway/Render/Fly remain options. **Phase 6 is NOT validated until Farhan explicitly approves the live gate.** Sprint evidence and its honest gaps (the final post-fix real OAuth return and the authenticated browser gate for the last hourly/menu features were not re-validated; the legacy chat purge was not run) are recorded in [`design-plans/pre-phase-6-product-features.md`](../../design-plans/pre-phase-6-product-features.md).

---

## What gets built in this phase

- `docker-compose.yml` that brings up `api + postgres + redis + web` with one command
- Structured logging via `pino` (JSON logs, correlation IDs)
- (Stretch) OpenTelemetry tracing on the agent loop
- Deployment to Railway / Render / Fly.io with managed Postgres (Neon) + Redis (Upstash)
- Public URL where anyone can chat with an agent and schedule a task

---

## Topics to self-assess

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 6.1 | Docker Compose (services, volumes, networks) | _ | |
| 6.2 | Structured logging (pino, JSON logs, correlation IDs) | _ | |
| 6.3 | OpenTelemetry concepts (spans, traces) | _ | |
| 6.4 | Deployment targets (Railway / Render / Fly / Neon / Upstash) | _ | |
| 6.5 | 12-factor app principles (env config, secrets) | _ | |

---

## Build artifact spec

Spec written 2026-11-25 at phase opening. *Historical pre-build framing (2026-11-25):* "Nothing here exists yet — no image built, no Compose file written, no deploy attempted." **Superseded by the dated records below**: the Docker/Compose artifact was built and validated locally 2026-11-25, the single-origin wiring was aligned 2026-11-27, and the local production validation gate PASSED 2026-11-27. No public deploy exists; Railway/Render/Fly remain options.

> Supersession note (2026-11-27): the 2026-11-27 wiring record's statement "no redundant runtime `API_INTERNAL_URL` was added" was later itself superseded — the web container now also receives a **runtime** `API_INTERNAL_URL` (via Compose `environment`) for server-side SSR chat hydration, in addition to the build-time rewrite target. See the 2026-11-27 local validation record.

- **Production Dockerfiles** — one per deployable: `api` (Express), `web` (Next.js), and the `scheduler` worker process. Multi-stage builds on Node 24 (build stage with dev deps → thin runtime stage with production deps only), non-root user, unprivileged listen ports.
- **One-command Compose** — a deployment-targeted compose file bringing up `api + web + scheduler + postgres (pgvector) + redis` with one command. *(2026-11-25 update: the root `docker-compose.yml` WAS extended into the full app stack; the separate dev-infra services and `dev:infra` behavior are preserved and unchanged.)*
- **Migrations as an explicit release step** — `prisma migrate deploy` (schema in `packages/core`) runs as a dedicated release step: apply, verify schema, then start the app processes and take traffic. Migrations never run inside the API or worker processes, never race container boot.
- **Healthchecks** — per-service Compose healthchecks with `depends_on` ordering: API HTTP health endpoint, Postgres `pg_isready`, Redis `PING`, scheduler process/API reachability check, web HTTP check. Unhealthy containers are restarted, not retried silently forever.
- **Graceful shutdown** — SIGTERM → stop accepting new requests, drain in-flight SSE generations and queue jobs, close BullMQ workers, Redis and Postgres. Existing recovery paths (durable transcripts, execution-table idempotency, stale-`running` promotion) remain the correctness backstop; shutdown makes them rare, not load-bearing.
- **Non-root images** — containers run as an unprivileged user; no writes to image layers; secrets only via env.
- **Env validation** — boot fails fast naming every missing/invalid variable (secrets, provider key, at least one complete OAuth pair, `DATABASE_URL`/Redis URLs, `BETTER_AUTH_URL`/`WEB_ORIGIN`). No fallback to development defaults in a deployment.
- **pino JSON + request correlation IDs** — structured `pino` JSON logs to stdout across API and scheduler worker; a correlation/request id per API request and per queue job, propagated through delegation/scheduler child calls so one user action can be traced end to end.
- **(Stretch) OpenTelemetry** — optional tracing of the agent loop, tool calls and the delegation chain (spans, context propagation). Stretch only: not required for the gate, built after the core artifact if time allows.
- **Managed/deploy topology** — two supported shapes: (a) single-host Compose with the Postgres and Redis containers, or (b) `api + web + scheduler` containers only against managed Postgres (e.g., Neon) and managed Redis (e.g., Upstash). The scheduler stays its own worker process/workload in both. Any target (Railway / Render / Fly) must support this topology.
- **Same-site auth requirement** — web and API are served from the same registrable domain (e.g., `app.<domain>` + `api.<domain>`) so the Better Auth session cookie (`secure`, same-site) flows between them; `BETTER_AUTH_URL`, `WEB_ORIGIN` and both OAuth callback URLs point at the public origins. Public exposure without satisfying this breaks sign-in.
- **Public deployment must preserve** (regression list for the gate): owner-scoped data on every surface; server-signed internal worker contexts (browsers never mint one); `query_data` RLS under the `workforce_query_reader` role; the per-user hourly budget ledger; SSE/replay/resume semantics (replay stays per API process — no new cross-process claims); persistent volumes or managed stores for Postgres/Redis (transcripts, idempotency keys, stream markers, usage/budget state live there).

**Spec vs reality (updated 2026-11-27):** the Docker/Docker-claims statement made at spec time ("no deploy or Docker claims are made by this spec") is **superseded** — Docker/Compose build and LOCAL runtime claims are recorded below (2026-11-25 artifact record; 2026-11-27 wiring + local validation record). No deploy/public-URL claim exists anywhere in this document.

---

## Record — 2026-11-25: local Docker/Compose artifact (subagent build)

Built and validated (local only; isolated compose project, alternate ports, dummy secrets — no real provider, OAuth, or Railway involvement):

- **Files** (only the files this subtask owns): `apps/api/Dockerfile` (multi-stage, targets `deps → build → prod-deps → runtime`, one-shot `migrate` target; Node 24 bookworm-slim; non-root uid 1000), `apps/web/Dockerfile` (standalone runner image), `apps/web/next.config.ts` (`output: 'standalone'`), root `docker-compose.yml` (full app stack; `dev:infra` behavior preserved), root `.dockerignore`, root `package.json` scripts (`docker:build/up/down/logs`), `.env.example` Docker notes, README section.
- **Deterministic images**: single root `package-lock.json` + workspaces; `npm ci` in build and prod stages; build order `core → queue → api` in image (CLI never built/shipped); generated Prisma client + query engine shipped at `packages/core/generated/prisma`; production native deps present (pg, `onnxruntime-node` arm64/x64, `@huggingface/tokenizers`, `@huggingface/transformers`). alpine avoided in favor of bookworm-slim for native compatibility.
- **Validation evidence 2026-11-25** (compose projects `workforce-phase6-*`, dummy values only):
  - `docker compose config` passes (default ports and with isolated overrides).
  - Images built: `workforce-api` 1.94 GB, `workforce-web` 437 MB, `workforce-migrate` 2.68 GB.
  - `migrate` exit 0: "All migrations have been successfully applied" (8/8 recorded in `_prisma_migrations`; `User` table present) on a FRESH isolated volume.
  - API `/health` 200; `api-listening` log; zero `api-startup-failed`.
  - `/api/auth/providers` → `{"google":true,"github":false}` from the dummy Google pair (no network provider calls made or possible with dummy values).
  - Web `/sign-in` 200 and `/_next/static/chunks/...` asset 200 through the published loopback port.
  - Scheduler `scheduler-worker-started` on the SAME api image with the minimal env exactly `["DELEGATION_CONTEXT_SECRET","INTERNAL_API_BASE_URL","REDIS_URL","SCHEDULER_EXECUTION_TIMEOUT_MS"]` (verified by key NAMES only, never values).
  - Non-root: api and web containers report uid 1000; model-cache volume writable.
  - Graceful stop: SIGTERM → api/web/scheduler all exit 0; restart-after-stop healthy.
  - Teardown: `down -v` removed ONLY the isolated project's containers/networks/volumes; the dev project's `workforce_postgres-data`/`workforce_redis-data` volumes remain untouched and running dev infra was never stopped.
- **Scope note**: one transient build failure observed (TS2722 `src/app.ts(191,9)`, `logger.debug` optional-typing while the pre-Phase-6 pino/logging transition was mid-flight in `apps/api` source, which this subtask does not own) cleared itself once that landed; the final validated image is built from the landed source. Runtime-layer correctness was additionally verified during the window with a throwaway image that reused the last-good `apps/api/dist`.

**Phase 6 remains ACTIVE and NOT validated.** Not done: no Railway (or any) deploy, no public URL, no real-OAuth sign-in gate, no real scheduled-task execution through the deployed stack, no real embedding/model download through the api image (volume pre-provisioned + write-checked only), no pino/OTel runtime coverage beyond what the landed logging change already provides. The validation gate below still requires Farhan's real OAuth + chat + schedule run on a public URL.

## Record — 2026-11-27: Compose single-origin build wiring aligned (local only; corrected same day)

Static alignment, local only — nothing deployed, no container started, no runtime validation claimed.

- **Files**: root `docker-compose.yml`, root `.env.example`, root `README.md`, this file, [`docs/deployment/railway.md`](../deployment/railway.md).
- **Compose change (as first landed)**: `web.build.args` gained `API_INTERNAL_URL: ${WORKFORCE_INTERNAL_API_URL:-http://api:3001}` — the already-declared build arg in `apps/web/Dockerfile` that `next.config.ts` resolves at `next build` into the baked `/api/:path*` rewrite. AUTHORITY IS BUILD-TIME: runtime values do not change the baked manifest; no redundant runtime `API_INTERNAL_URL` was added. `NEXT_PUBLIC_API_URL` default stays `http://localhost:3001` (direct-API mode).
- **CORRECTION found in orchestrator review, applied the same day (NOT a runtime pass)**: the first version bound the web build arg to the SAME `WORKFORCE_INTERNAL_API_URL` the API (runtime loopback) and scheduler (runtime → API) already consume. The direct-API doc told users to set it to `http://localhost:3001`; inside the scheduler container that is THE SCHEDULER ITSELF, not the API — the scheduler's internal REST calls would break. Web's build-time rewrite target and API/scheduler's runtime call target are DISTINCT settings. Fix: the web build arg now reads the dedicated `WORKFORCE_WEB_INTERNAL_API_URL` (compose default `http://api:3001`); API and scheduler stay on the existing `WORKFORCE_INTERNAL_API_URL` unchanged (API default loopback `http://127.0.0.1:3001`, scheduler default `http://api:3001`); direct-API local mode needs NO proxy override at all (the baked web target is inert when the client talks to the API directly), and the incorrect `localhost:3001` recommendation is deleted. Single-origin mode = `WORKFORCE_WEB_INTERNAL_API_URL=http://api:3001` (compose default) with all browser-facing URLs on the web origin; rebuild after changing the web target.
- **Validation (`docker compose config`, synthetic `--env-file` only — no real `.env` read, no containers)**: defaults → web arg `API_INTERNAL_URL: http://api:3001`, api `INTERNAL_API_BASE_URL: http://127.0.0.1:3001`, scheduler `http://api:3001`, `NEXT_PUBLIC_API_URL: http://localhost:3001`. `WORKFORCE_WEB_INTERNAL_API_URL=http://example.internal:3001` → ONLY the web arg changes; api/scheduler stay on their `WORKFORCE_INTERNAL_API_URL` defaults. Exit 0 both runs.
- **Docs**: README documents two coherent LOCAL modes with the distinct-variable explanation (direct-API needs no proxy override; single-origin uses `WORKFORCE_WEB_INTERNAL_API_URL=http://api:3001`); `.env.example` carries the same split. Railway runbook aligned in intent (deployed topology = single-origin with the API private) but unchanged operationally.
- **Honest limits**: this is configuration wiring + docs only. NOTHING about runtime OAuth/SSE replay/scheduler execution through the single-origin rewrite is validated here; orchestrator runtime checks follow. Phase 6 stays ACTIVE/NOT validated (local-only decision unchanged).

---

## Record — 2026-11-27: LOCAL production validation PASSED (local-ONLY decision; Phase 6 still NOT validated)

Farhan chose **LOCAL ONLY**. The following local production gate PASSED. **Not done, deferred by the user**: public live URL, real Google/GitHub OAuth return, real Ollama provider traffic, cross-process replay. Nothing is deployed; Railway/Render/Fly remain options.

**Root orchestrator gate — ALL PASS** (`npm run typecheck && npm test && npm run test:integration && npm run build`):

- **Offline 1095/1095**, zero fail/skip (core 321, `@workforce/queue` 51, CLI 30, API 448, web 245).
- **Real integration 62/62**, zero skip (RLS, budgets, personal memory, SSE/resume, WorkDocs/delegation, scheduler retries/DLQ and SIGKILL recovery; the memory-suite race fix was **test-only**).
- Full production build passed. No dev server active.

**Docker isolated single-origin production gate — PASSED** (unique Compose project, fresh volumes, alternate loopback ports, synthetic env/dummy secrets, **local mock OpenAI/Ollama only**):

- Identity: real Better Auth `User`/`Session` fixtures with valid signed cookies; **real external OAuth was NOT completed**.
- Fresh images: 8/8 migrations on fresh volumes; api/web/scheduler run as uid 1000, all healthy; model cache volume writable.
- **Single-origin runtime**: Next `/api/:path*` rewrite baked to `http://api:3001`; the browser uses only the public web origin. The web runtime `API_INTERNAL_URL` now ALSO drives server-side SSR hydration (`resolveServerApiBaseUrl` + Compose runtime env). The original SSR bug (`Chat history is temporarily unavailable`) is fixed: rebuilt SSR HTML includes the transcript (no error), and unauthenticated/foreign-owner requests see no transcript.
- **OAuth proxy, local checks only**: dummy providers report true/false; unauth get-session → null, chat → 401; social sign-in init builds the public web callback URL without contacting Google/GitHub; a real signed local fixture get-session works. **Real OAuth return is NOT claimed.**
- **Chat through the web origin**: streamed `calculate (18*2)+6` → **42** with exact mock usage 28/18/46; hydration/SSR/export/usage all correct; duplicate send → 409 with **no extra model call**; disconnect → **full same-origin replay of "42" exactly once** → post-complete resume → 204. Replay completed **before** any restart — **no cross-process replay claim** (same-process replay only, ADR-005).
- **Scheduler as a separate container**: MANUAL run `COMPLETED` attempt 1 with an isolated chat + usage; task paused after. The scheduler healthcheck is genuinely healthy; stopping the API turned it unhealthy after retries **without crashing**, and the API restart restored healthy.
- **Observability at runtime**: `LOG_LEVEL=debug` reached API AND scheduler and enabled the 2xx request-completion logs. Correlation proven end-to-end: the deterministic `schedulerRequestId(execution-<executionId>)` is **identical** in the scheduler's completion log and the API's scheduler-run/chat/hydration request logs; safe supplied request IDs are echoed/correlated. **Secret log scan: 0 hits.**
- **Lifecycle**: graceful stop — scheduler/api/web all exit 0; restart healthy; Redis/Postgres persisted transcripts, tasks, executions, users, sessions; SSR still served after restart. Cleanup removed only the isolated project's volumes/network/mock/ports; the pre-existing workforce Redis/Postgres and the `ermis` stack were untouched.
- **Compose variables stay DISTINCT** (also corrected in root `.env.example`, which previously overstated build-only): `WORKFORCE_WEB_INTERNAL_API_URL` (default `http://api:3001`) supplies the web **build-time** rewrite target **and** the runtime SSR hydration base — changing the rewrite needs `docker compose up --build`; `WORKFORCE_INTERNAL_API_URL` is the **runtime** same-REST base for the API (loopback default) and the scheduler (`http://api:3001` — **never** `localhost:3001` inside its container). Direct-API mode needs no web proxy override.

**Status unchanged: Phase 6 is ACTIVE and NOT validated.** The public gate below (real OAuth sign-in, chat, schedule, run on a public URL) remains the requirement and is **deferred by Farhan's local-only decision**, not satisfied.

---

## Validation gate for Phase 6

I sign in through a real OAuth flow on the public URL. I chat with an agent. I schedule a task. It runs. If any of those fail, we fix until they don't. **Phase 6 is NOT validated until Farhan explicitly approves this gate.**

> 2026-11-27: Farhan chose LOCAL ONLY. **The public-URL gate is deferred by user decision — not achieved, not waived forever.** The local gate above passed; it is NOT the phase gate.

---

## Final deliverables

- ☐ Live URL — **deferred by Farhan (2026-11-27, local-only); not achieved**
- ☐ 3-minute demo video (recorded) — **not recorded**
- ✅ 8 ADRs complete
- ✅ Clean README with architecture diagram
- ☐ Talking points doc (for interviews) — **not extracted**

---

## After Phase 6

You'll have a portfolio-grade multi-agent platform, and the story to defend it in any system-design interview.

→ Extract interview talking points into `docs/interview/talking-points.md` (separate session).
