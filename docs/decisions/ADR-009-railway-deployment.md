# ADR-009: Railway deployment (one public web origin, private API, pgvector template)

**Date**: 2026-11-25
**Status**: Accepted (design decision only — deployment not done; Phase 6 not validated)
**Phase**: 6
**Deciders**: Mohd Farhan Akhtar

---

## Context

Phase 6 (Docker, Deploy, Observability) is active as of 2026-11-25. The validated topology needs a public home: a Next.js 15 web app, a long-running Express API (chat SSE, Better Auth, memory/delegation workers), a **separate** scheduler worker process ([ADR-006](./ADR-006-bullmq-scheduler.md)), Postgres **with pgvector** ([ADR-007](./ADR-007-pgvector.md)), and Redis (BullMQ, resumable streams, idempotency — [ADR-005](./ADR-005-sse-idempotency.md)).

Locally, the browser talks to the API directly (`http://localhost:3001`), the Better Auth session cookie is a `localhost` cookie, and OAuth callbacks are `http://localhost:3001/api/auth/callback/google|github`. The existing compose file is local infrastructure only ([docs/architecture.md](../architecture.md), [phase-6-deploy.md](../phases/phase-6-deploy.md)). Farhan selected **Railway** as the Phase 6 target on 2026-11-25. Any public deployment must preserve owner-scoped data, server-signed worker contexts, `query_data` RLS, the per-user hourly budget ledger, and SSE/resume semantics.

---

## Problem

Choose a hosting topology that puts Workforce on a public URL without breaking the Better Auth same-site cookie flow, SSE streaming, the depth-capped same-REST delegation design, or the scheduler's single-claim execution model — while keeping the API off the public internet.

---

## Options Considered

### Option A — Railway (chosen)

**Description**: Railway services for `web`, `api`, and `scheduler` as three separate long-running processes, plus Railway's **pgvector template/service** and Redis. Private networking connects `scheduler → api` and the stores; **only `web` is public**. The browser reaches the API through Next.js `/api/:path*` rewrites to the API's internal URL, so browser/API/auth/SSE traffic all shares one public web origin.

**Pros**:
- One public origin: the Better Auth session cookie stays first-party same-site — no cross-site `SameSite` cookie failures, and the API is not exposed directly at all.
- Native support for our exact service shape: multiple long-running services from one monorepo (per-service Dockerfiles), private networking, template-marketplace pgvector and Redis, persistent volumes.
- The [docker-compose guide](https://docs.railway.com/guides/docker-compose) is explicit that Compose maps service-by-service to Railway configuration — we treat it as mapping guidance for our spec, not as a Compose orchestrator (`depends_on`, local volumes and `links` do not port).
- Managed Postgres/Redis with persistence and backups instead of hand-rolled container ops.

**Cons**:
- One more moving proxy hop (Next.js rewrite → API) that must pass SSE through byte-correct (streaming responses, no buffering, correct headers).
- Railway's pgvector template is **not** the standard Postgres template — must be chosen deliberately and verified (extensions, migrations, RLS role privileges).
- Private-neighborhood DNS and internal environment variables (e.g., `REDIS_URL`, internal API URL) come from Railway's environment reference syntax — another config surface to get exactly right.
- Fewer knobs than raw IaaS; platform limits (proxy behavior, volume snapshots) are Railway's to change.

### Option B — Render (Blueprint + managed services)

**Description**: A Render Blueprint defining `web`, `api`, `scheduler` workers, managed Postgres, and managed Redis; equivalent private-networking story via Render's internal service addresses.

**Pros**:
- Credible, managed, Blueprint-as-code; previews and cron-style workers exist.
- Managed Postgres plus Redis and log drain are solid.

**Cons**:
- Same one-public-origin pattern must be rebuilt (Next rewrites → private API), so no correctness advantage — only a different platform to configure.
- Render does not offer a one-click pgvector template like Railway's marketplace; getting vector support means verifying extension availability on the managed Postgres plan ourselves.
- Blueprint shape, worker services, and env wiring are more moving pieces than the equivalent Railway service group for this monorepo. Rejected for configuration surface, **not** quality — Render is a fine platform in general.

### Option C — Fly.io (process groups / machines)

**Description**: Fly apps with `web`, `api`, and `scheduler` process groups over Fly Machines, Fly Postgres (or an external pgvector-capable Postgres), Fly Redis (or Upstash), private 6PN networking.

**Pros**:
- Machines give precise process-group control and per-process scaling; private networking via 6PN is mature.
- Region pinning and volume snapshots are strong.

**Cons**:
- Highest configuration surface of the three: multiple `fly.toml`s/process groups, certificates, internal DNS, and a self-managed or hand-picked pgvector Postgres; more places for the same result to go wrong.
- Managed Redis is not first-party the way the other platforms' stores are; adds a vendor decision on top.
- Rejected for more moving pieces and config, not on quality — Fly is excellent infrastructure, it is just heavier to land for this one-week phase.

---

## Decision

We chose **Option A — Railway**. The deployment design:

- **Services**: three separate long-running Railway services from the monorepo — `web` (Next.js), `api` (Express), `scheduler` (BullMQ worker, API-only: it calls the API's own REST and holds no provider key) — plus Railway's **pgvector template/database** (never the standard Postgres template without `vector`) and a Redis instance.
- **One public origin**: `web` is the only service with a public domain. The API stays **private** on Railway's network. Next.js rewrites `https://<web-domain>/api/:path*` to the API's internal URL, so the browser, Better Auth cookies, and SSE chat streams all move over the same public web origin. This removes the cross-site `SameSite` cookie failure mode and avoids exposing the API directly.
- **Env mapping**: `BETTER_AUTH_URL`, `WEB_ORIGIN`, and `NEXT_PUBLIC_API_URL` all point at the **public web origin** (e.g., `https://<web-domain>`); the scheduler's `INTERNAL_API_BASE_URL` points at the **private** API URL. Production OAuth callbacks are `https://<web-domain>/api/auth/callback/google` and `https://<web-domain>/api/auth/callback/github` — **never** a private Railway hostname. The local direct-API callback flow on `localhost:3001` stays unchanged for development.
- **Migrations are an explicit release step**: `prisma migrate deploy` runs before an API/scheduler rollout (apply, verify, then take traffic) — never inside the API or worker processes ([phase-6-deploy.md](../phases/phase-6-deploy.md), build artifact spec).
- **Persistence**: a persistent volume for the embeddings model cache; Postgres/Redis use persistent storage with backups. Transcripts, idempotency keys, stream markers, and budget state must survive restarts.
- **Replay stays same-process**: the SSE full-replay guarantee remains bound to the same running API process ([ADR-005](./ADR-005-sse-idempotency.md)). **No multi-replica claim is made** — the API runs as a single instance at the gate; horizontal scaling is out of scope for this ADR.
- **Railway's Docker-Compose docs are mapping guidance only**: the spec in [phase-6-deploy.md](../phases/phase-6-deploy.md) describes per-service Dockerfiles and services; Railway's Compose mapping is used to translate it, not as a production Compose orchestrator.
- **Secrets only in Railway variables**: provider key, `BETTER_AUTH_SECRET`, `DELEGATION_CONTEXT_SECRET`, OAuth client secrets, `DATABASE_URL` — never in images, bundles, or logs.

---

## Consequences

### Positive

- Public URL with a sane auth model: one public origin, first-party cookies, private API.
- The scheduler keeps its dedicated worker and private-API path — no new delegation topology, [ADR-002](./ADR-002-same-rest-api.md) survives untouched.
- pgvector and Redis are managed with persistence/backups instead of hand-rolled containers.
- Compose-as-mapping keeps our spec platform-agnostic: the same Dockerfiles could land elsewhere later.

### Negative

- The Next rewrite proxy is now on the hot path for every SSE byte; a proxy regression shows up as user-visible streaming breakage.
- Railway's pgvector template must be pinned and verified; a wrong template choice would silently lose vector search.
- Config spread across public origin, private URLs, and Railway env-reference syntax is easy to get subtly wrong.

### Risks / Open questions

- **Proxy SSE validation** — `/api/:path*` rewrites must stream without buffering; must be proven on the deployed URL (resume mid-stream), not assumed from local behavior.
- **pgvector template ≠ standard Postgres** — extension presence, migration behavior, and backup semantics differ; verify on the actual template instance.
- **Private DNS / env wiring** — internal service variables (`DATABASE_URL`, Redis URL, `INTERNAL_API_BASE_URL`) come from Railway's environment reference syntax; a wrong reference fails at runtime, not build time.
- **Auth callback configuration** — production OAuth callbacks must be registered against the public web domain exactly; a private hostname in any callback setting breaks sign-in.
- **RLS migration privileges** — the `query_data` RLS setup (migration `20261125000100_query_data_rls`, NOLOGIN `workforce_query_reader` role) needs superuser/migration privileges on the managed instance that default managed credentials may not grant; verify before relying on it.
- **No public API** — if anything bypasses the web proxy and hits the private API, the deployment is wrong; there is no legitimate direct public API path.
- **No multi-instance replay** — scaling the API horizontally would break the same-process replay guarantee; single-instance API until an explicit cross-process replay decision (none exists).

---

## Validation

Phase 6 is **not validated** until Farhan explicitly approves the gate. The checks that will judge this decision:

1. **Docker gate first** — the production Dockerfiles and one-command Compose bring up `api + web + scheduler + postgres (pgvector) + redis` locally, migrations run as an explicit release step, healthchecks pass, graceful shutdown proven.
2. **Deployed gate on the public URL** — health endpoints green; **real OAuth sign-in** through `https://<web-domain>/api/auth/callback/google|github`; chat streaming with mid-stream disconnect + resume; schedule a task and watch it run through the private scheduler → API path.
3. **Cookie/model checks** — session cookie is same-origin against the public web origin only; browser never sees an API or Railway-internal hostname.
4. **Data and privacy checks** — owner-scoped data everywhere, cross-owner 404s; `query_data` RLS holds on the managed instance (owner-scoped reads, cross-owner rows invisible); per-user hourly budget ledger live; **no secrets in logs, env dumps, or client bundles**.
5. **Honesty check** — no multi-replica/failover claim is recorded; replay stays same-running-process; anything not proven stays unclaimed.

---

## References

- [Railway — Monorepo guide](https://docs.railway.com/guides/monorepo) — multiple services from one repo.
- [Railway — Docker Compose guide](https://docs.railway.com/guides/docker-compose) — Compose as mapping guidance, not an orchestrator.
- [Railway — Next.js guide](https://docs.railway.com/guides/nextjs) — deploying the `web` service.
- [Railway — PostgreSQL database](https://docs.railway.com/databases/postgresql) — managed Postgres; the **pgvector template** variant is chosen at creation (standard Postgres without vector is not acceptable for this app).
- [Railway — Embeddings pipeline guide](https://docs.railway.com/guides/embeddings-pipeline) — vector/embedding workloads and local model-cache patterns.
- [docs/phases/phase-6-deploy.md](../phases/phase-6-deploy.md) — build artifact spec (Dockerfiles, Compose, migrations, healthchecks, graceful shutdown, env validation, pino/correlation IDs, preservation list).
- [ADR-005](./ADR-005-sse-idempotency.md) — SSE + idempotency; same-process replay boundary.
- [ADR-006](./ADR-006-bullmq-scheduler.md) — scheduler as its own worker process.
- [ADR-007](./ADR-007-pgvector.md) — why pgvector is load-bearing.
- [docs/architecture.md](../architecture.md) — module map, RLS and signed-context invariants.
