# Railway deployment runbook (Phase 6, single public web origin)

**Date**: 2026-11-25 · **Decision**: [ADR-009](../decisions/ADR-009-railway-deployment.md) (accepted)
**Status**: Runbook written BEFORE any deploy. **Nothing here has been executed against Railway** — no Railway project exists yet, no image has been pushed, no public URL exists. Phase 6 is NOT validated until Farhan's live gate. The local Docker stack (root `docker-compose.yml`, documented in `docs/phases/phase-6-deploy.md` and the root `.env.example`) is the validated artifact; this page maps it to Railway per ADR-009. Local `docker-compose.yml` is NOT a production orchestrator — Compose's role here stops at being the source-of-truth spec for the service shape.

---

## 1. Topology (exact)

| Railway service | Source | Runs | Exposure |
|---|---|---|---|
| `pgvector` (Railway pgvector template) | Railway's **pgvector** template/image — `+ New → Docker Image` or the template marketplace entry that ships the `vector` extension | Managed Postgres w/ pgvector | Private only (Railway private networking is automatic) |
| `redis` | Railway managed Redis (`+ New → Database → Redis`) | Managed Redis | Private only |
| `migrate` | API image, **`--target migrate`**, default command `node packages/core/scripts/prisma-migrate.mjs` (existing wrapper) | One-shot release step, exits when done | Never started at runtime; run per release, before api/scheduler |
| `api` | API image, **`--target runtime`**, command `node apps/api/dist/server.js` | Express API on **internal port 3001**, SSE + Better Auth + workers | **Private only — NO public domain** |
| `scheduler` | **Same API runtime image as `api`**, command `node apps/api/dist/scheduler-worker.js` | BullMQ worker — reads Redis, calls the API's private REST | Private only, listens on no port |
| `web` | `apps/web/Dockerfile` (from the repo; final stage `runner` = standalone Next server as the non-root `node` user) | Next.js 15 standalone on Railway's `PORT` | **The ONLY service with a public domain** |

Traffic shape (ADR-009): the browser talks ONLY to the `web` origin. Every `/api/*` request — Better Auth mounts (`/api/auth/*`), chat send/hydrate, **SSE resume streams**, memory/work/delegation/scheduler routes — is proxied SERVER-SIDE by the Next.js rewrite (`/api/:path*` → `API_INTERNAL_URL`, baked at `next build` time). The browser never sees the API host, the Railway-private hosts, or any other origin. This is a rewrite (proxy), never a client redirect.

```
Browser ──(public HTTPS: one origin)──► web [Next standalone]
                                         │  rewrite /api/:path*  (server-side)
                                         ▼
                              api:3001 [Express, private]  ──► pgvector, redis (private)
                                         ▲
              scheduler [same API image] ┘ internal REST calls (INTERNAL_API_BASE_URL)
```

`/api/auth/callback/google|github` and the session cookie therefore stay first-party under the web origin (same-site `SameSite` cookies, `trustedOrigins` honored), and **no public API domain is created — do not generate one** (anything publicly hitting the API directly means the topology is wrong).

### Build-vs-runtime baking for the rewrite (web)

`next.config.ts` resolves `API_INTERNAL_URL` **at `next build` time**; Next bakes the resolved rewrite into `.next/routes-manifest.json` and the standalone runtime serves the baked manifest (runtime env changes do NOT change it). Therefore `web`'s build must receive `API_INTERNAL_URL` as a Docker build arg (already declared in `apps/web/Dockerfile`; it is an internal network URL, never a secret — the app validates it is a bounded http(s) origin with no path/query/hash/credentials and fails the build with a fixed, value-free error otherwise). `NEXT_PUBLIC_API_URL` stays the **public web origin** so the client bundle keeps pointing browser requests at the web origin itself.

A rebuild + redeploy of `web` is required whenever the API's private address changes.

---

## 2. Prerequisites

- A Railway account (Hobby/Pro) and a project API token for the CLI (`railway login`, or `RAILWAY_TOKEN` in CI). **Not yet created.**
- Railway CLI installed locally (`npm i -g @railway/cli@latest`).
- The GitHub repo connected if the GitHub deploy path is used (Section 6). **No commit or push has been performed for this task** — nothing has been pushed to any remote.
- Provider OAuth apps able to register production callbacks (Section 7).

---

## 3. Stores first

1. **Postgres with pgvector — deliberately, not the default** Railway template. The stock "PostgreSQL" template does NOT include the `vector` extension and is **not acceptable** (memory embeddings + `query_data` depend on pgvector, ADR-007). Deploy Railway's **pgvector** variant (template marketplace / `+ New → Docker Image` with Railway's pgvector image). After first boot, verify on the instance: `\dx` shows `vector`, and the RLS migration (`20261125000100_query_data_rls`) can run — the managed DB user needs sufficient privileges (RLS policy/role creation); verify BEFORE relying on it (open risk in ADR-009).
2. **Redis** — `+ New → Database → Redis`.
3. Note the Railway **reference variable** names you will use (they follow the service's variable names, e.g. `pgvector.DATABASE_URL`, `redis.REDIS_URL` — check the actual variable names shown on each service and reference them verbatim).

Railway's managed databases persist and back themselves up; no volumes for them.

---

## 4. Model cache volume

Attach one Railway Volume to `api` (Volumes persist across deploys; never available at build time):

- Mount path (must match the image): `/app/.cache/workforce-models`
- Set `api` variable `EMBEDDING_CACHE_DIR=/app/.cache/workforce-models` (the Transformers.js MiniLM model downloads on first embedding and survives restarts/deploys; the API image pre-creates the directory owned by `node`).

Postgres/Redis need no volumes (managed). Transcript/idempotency/stream-marker/budget state lives in the managed stores.

---

## 5. Variables per service (names and purpose only — **never values, never committed**)

Everything below is set in Railway's Variables tab (secrets stay only in Railway). Reference syntax for internal wiring: `${{<service>.<VARIABLE>}}`. The API *validates and fails fast at boot* naming missing variables (no dev fallbacks in deployment — phase spec). **Do not put real values into this file, `.env`, or any repo file — ever.**

### `pgvector` service
Nothing. Its generated `DATABASE_URL`/connection variables are referenced, never copied.

### `redis` service
Nothing. Its generated `REDIS_URL` variable is referenced by `api` and `scheduler`.

### `migrate` service (one-shot release step)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Reference to the pgvector service's URL (`${{pgvector.DATABASE_URL}}`). **Migrate only — API holds it too; nothing else does.** |

Optional passthroughs if the release needs them: none expected.

### `api` service
| Variable | Purpose / wiring |
|---|---|
| `OLLAMA_API_KEY` | Provider key. **API only — the scheduler never holds it** (it calls the API's REST; no provider client). |
| `OLLAMA_BASE_URL` | Optional; provider default lives in `apps/api/.env.example`. |
| `OLLAMA_MODEL` | Optional; default `glm-5.3-flash` from config. |
| `DATABASE_URL` | Reference `${{pgvector.DATABASE_URL}}`. **API only** — workers never construct Prisma clients. |
| `REDIS_URL` | Reference to the Redis service. |
| `BETTER_AUTH_SECRET` | Signing secret (≥16 chars). **API only.** |
| `BETTER_AUTH_URL` | **The public WEB origin** (same value as the web domain, never a private host). API only. |
| `WEB_ORIGIN` | **The public WEB origin** — trusted origin + credentialed CORS. API only. |
| `DELEGATION_CONTEXT_SECRET` | Shared HMAC secret for signed internal contexts. **API AND scheduler must share the same value.** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth pair (at least one complete pair required to boot). API only. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | OAuth pair (second, optional but the gate may exercise it). API only. |
| `AUTH_EMAIL_ALLOWLIST` | Optional comma-separated email allowlist. |
| `INTERNAL_API_BASE_URL` | Optional for the API: its own loopback REST base for tools/delegation (`http://127.0.0.1:3001` is the default when unset — set it only if the private address differs). |
| `PORT` | `3001` — the internal listen port (Section 6). |
| `EMBEDDING_CACHE_DIR` | `/app/.cache/workforce-models` (Section 4). |
| `NODE_OPTIONS` | `--enable-source-maps` (matches the Compose stack). |
| `OLLAMA_MODEL_PRICING_JSON` | Optional model pricing JSON — drives `estimatedCostUsd` only. **Never a secret, but still never committed.** |
| `DELEGATION_TIMEOUT_MS`, `QUERY_STATEMENT_TIMEOUT_MS`, `QUERY_ROW_CAP`, `SCHEDULER_EXECUTION_TIMEOUT_MS`, `WORKFORCE_BLOCKED_MODEL_PREFIXES` | Optional tunables (blank-safe: the API treats blank as absent). |

Scheduler must NOT get: `OLLAMA_API_KEY`, `DATABASE_URL`, auth variables — the same minimal contract as the local stack.

### `scheduler` service (same image as `api`, different command)
| Variable | Purpose / wiring |
|---|---|
| `REDIS_URL` | Reference to the Redis service. |
| `INTERNAL_API_BASE_URL` | **Railway's private API address with its port** — shape `http://api.railway.internal:3001` via reference `${{api.RAILWAY_PRIVATE_DOMAIN}}` + `:3001` (verify the rendered variable on the API service). Scheduler → API only. |
| `DELEGATION_CONTEXT_SECRET` | Same value as the API's (`${{api.DELEGATION_CONTEXT_SECRET}}` reference or the same pasted value — one shared secret). |

Optional: `SCHEDULER_EXECUTION_TIMEOUT_MS`. Everything else (provider key, DATABASE_URL, auth) stays out.

### `web` service
| Variable | Purpose / wiring |
|---|---|
| `NEXT_PUBLIC_API_URL` | **The public WEB origin** (build arg + runtime coherence value). The only client-exposed value. |
| `API_INTERNAL_URL` | **Build arg for the server-only rewrite** — the API's private origin: `${{api.RAILWAY_PRIVATE_DOMAIN}}` with port 3001, i.e. shape `http://api.railway.internal:3001` (declared via `ARG` in `apps/web/Dockerfile`; never a secret). |
| `PORT` / `HOSTNAME` | See Section 6 (PORT behavior). |

Nothing else. No secret ever reaches the web image or bundle.

---

## 6. PORT behavior (explicit)

- **API**: set `PORT=3001` and keep `EXPOSE 3001`. Railway private networking does **no port mapping** — callers must use the port the process actually listens on (`http://…:3001`). Do not give the API a public domain; if one is ever generated accidentally, delete it.
- **web**: Railway detects the listening port for the public domain. The runner image defaults `PORT=3000` / `HOSTNAME=0.0.0.0`, and the standalone server honors whatever `PORT` Railway injects at runtime; `HOSTNAME=0.0.0.0` must stay (do not bind localhost). Set the domain's target port to the actual listen port (Railway auto-detects $PORT; override only if you pin `PORT` yourself).
- **scheduler**: listens on no port — the deploy healthcheck must not expect one (success signal is the `scheduler-worker-started` log line, as in the local stack).
- **migrate**: one-shot; exit code 0 = success (`All migrations have been successfully applied`).

---

## 7. OAuth callbacks (production)

Register in the provider consoles against the **public web origin** exactly:

- Google: authorized JavaScript origin = the web origin; redirect URI = `https://<web-domain>/api/auth/callback/google`
- GitHub: homepage = the web origin; callback = `https://<web-domain>/api/auth/callback/github`

`BETTER_AUTH_URL` (API) and `WEB_ORIGIN` (API) both name the public web origin; the Better Auth client inside `web` points at the same origin's `/api/auth` through the rewrite. `trustedOrigins` and same-site secure cookies therefore work via **one origin** — the cookie is first-party, and the browser never lands on a private hostname. Development keeps the direct `http://localhost:3001` flow, unchanged.

---

## 8. Deploy order + release flow (no orchestration assumption)

Railway has no `depends_on` equivalent per its Compose guide; ordering is YOUR release flow, not platform magic:

1. Stores up: `pgvector`, `redis`.
2. **Migrate release**: trigger the `migrate` deployment with the NEW image tag; wait for exit 0; verify schema (latest migration applied, `_prisma_migrations` clean). Never inside api/worker processes.
3. Deploy `api` (new tag), wait healthy (its `/health` answers on the internal address).
4. Deploy `scheduler` (new tag — same image, same release), confirm `scheduler-worker-started`.
5. Deploy `web` (rebuild happens server-side per Section 1 if sources changed; the build args from Section 5 must be present in the service variables so the ARGs receive them).
6. Rebuild/redeploy `api` and `scheduler` again on the next code change; migrations first, every time.

Single API instance stays the rule: SSE full replay is bound to the same running API process (ADR-005) — **no multi-replica claim is made and none should be configured** (keep `api` replicas at 1 until an explicit cross-process replay decision exists).

---

## 9. Getting the images to Railway — CLI local build vs GitHub deploy

Railway builds a Dockerfile's **last stage only** (it has no `--target` selector today). That is why per-stage images are built by the CLI and deployed as **Docker Image services** for the api side, while `web` works either way (its `runner` stage is last).

**Path A — CLI local build + upload (works today for everything, recommended for the api side):**

```sh
# From the repo root (no secrets in build args anywhere — ever):
# Web (Railway can also build this from GitHub; shown complete):
docker build --file apps/web/Dockerfile --target runner \
  --build-arg NEXT_PUBLIC_API_URL='https://<web-domain>' \
  --build-arg API_INTERNAL_URL='http://api.railway.internal:3001' \
  -t <registry>/workforce-web:<tag> .

# API runtime (api + scheduler share it):
docker build --file apps/api/Dockerfile --target runtime \
  -t <registry>/workforce-api:<tag> .

# One-shot migrate image:
docker build --file apps/api/Dockerfile --target migrate \
  -t <registry>/workforce-migrate:<tag> .

docker push <registry>/workforce-web:<tag>        # etc. for all three tags
```

Then create/update the Railway services as **Docker Image** deploys pointing at those image references; set `scheduler`'s start command to `node apps/api/dist/scheduler-worker.js`; the migrate image's default command is the existing wrapper (`node packages/core/scripts/prisma-migrate.mjs`). `railway up` builds server-side from an uploaded context and is equally stage-targetless — use it for `web` only, not for stage-pinned api images.

**Path B — GitHub-connected deploys:** connect the repo; `web` deploys from `apps/web/Dockerfile` directly (Railway picks the Dockerfile; root-directory/Dockerfile-path stays the repo root so the monorepo build context works; build args must be declared as `ARG` — they are — and set as service variables, Section 5). The api side CANNOT select the `runtime`/`migrate` stages from GitHub today: until per-stage Dockerfiles exist (a separate task — not owned here, not performed), keep api/scheduler/migrate on Path A image deploys. This is an honest gap, not a claim that GitHub deploys cover all six services.

**Account/token**: creating the project, pushing images, and running deploys needs a Railway account + CLI token — still required; nothing here has authenticated with Railway yet.

---

## 10. Public smoke checklist (run AFTER the deployed gate; nothing below is claimed done)

All via the public web origin; watch logs for the whole pass:

1. **Proxy + private API**: `https://<web-domain>/api/auth/providers` serves `{google:…, github:…}` through the rewrite; no request ever exposes an internal hostname in the browser (devtools network panel).
2. **OAuth sign-in return**: real Google (+ GitHub) sign-in; browser returns to the web origin, session cookie is first-party (same-site, secure), stays signed in across reloads.
3. **Chat SSE + refresh resume**: send a chat; mid-stream refresh; the resume route replays the in-flight assistant turn (same-process replay only). Streaming is byte-live — confirm no proxy buffering.
4. **Model + usage**: model catalog loads through the proxy; per-chat model switch; usage tokens/estimated-cost behavior as configured.
5. **Schedule + run**: create a schedule (ONCE), Run now → execution PENDING → RUNNING → settles; scheduler worker → private API path visible in logs; DEAD_LETTER retry works.
6. **RLS / owner isolation**: second account cannot read the first account's chats/memory/schedules/work docs (404s, not errors); `query_data` under the managed instance stays owner-scoped.
7. **Structured request IDs**: API/scheduler logs carry pino request ids end-to-end (delegation + scheduled runs traceable).
8. **No secrets in logs**: grep deploy logs — key names only ever, never values; env dumps absent.
9. **Honesty note in the record**: replay is same-process; no failover claim; anything not listed as verified stays unclaimed. Phase 6 stays not-validated until Farhan's gate.

---

## 11. Statically tested vs not deployed (honest ledger, 2026-11-25)

**Statically verified this task (real runs):**
- `apps/web` tests **240/240 pass** (233 existing + 7 new `test/api-proxy.test.ts` covering rewrite source/destination shape, bounded-origin validation, default + trailing-slash handling, fixed value-free config error).
- `npm run typecheck` in `apps/web`: clean.
- Production `next build` in `apps/web`: exit 0; `.next/routes-manifest.json` bakes the rewrite — default (`http://localhost:3001/api/:path*`), env-set (`http://api.railway.internal:3001/api/:path*`), and an invalid value fails the build with the fixed error, echoing no value.
- `apps/web/Dockerfile` gains the additive `ARG API_INTERNAL_URL` build arg (same pattern/audit as `NEXT_PUBLIC_API_URL`); standalone + non-root runner untouched.
- Local Docker stack untouched; no live stack change; no commit/push.

**NOT deployed / not validated (still true):**
- No Railway project, no deploy, no public URL, no real OAuth on the web domain (Sections 2–9 are the plan).
- SSE-through-Next-rewrite streaming byte-behavior on Railway: 2026-11-25 wording "unproven until the deployed URL is exercised"; since then **proven locally** in the Docker mock stack through the exact same rewrite shape (see the 2026-11-27 update below) — the deployed-Railway behavior itself remains unproven. (ADR-009 risk narrowed, not closed.)
- pgvector template instance (extension + RLS privileges) unprobed.
- Railway private-DNS variable references (`RAILWAY_PRIVATE_DOMAIN`, service references) unexercised at runtime.
- Local compose parity for the rewrite (aligned 2026-11-27 in root `docker-compose.yml`; corrected same day after orchestrator review): `web.build.args` passes `API_INTERNAL_URL` from the dedicated `WORKFORCE_WEB_INTERNAL_API_URL` (compose default `http://api:3001`; build-time authority, runtime values don't change the baked rewrite). That variable is DISTINCT from `WORKFORCE_INTERNAL_API_URL` — the API/scheduler RUNTIME same-REST base (API default loopback, scheduler default `http://api:3001`); never bind both to one variable (a web-side value would point the scheduler at itself). Local stacks support BOTH documented modes — direct-API (default `NEXT_PUBLIC_API_URL=http://localhost:3001`, rewrite unused, so the baked internal default is inert; NO proxy override needed) and single-origin proxy (`NEXT_PUBLIC_API_URL`/`BETTER_AUTH_URL`/callbacks on the public web URL + `WORKFORCE_WEB_INTERNAL_API_URL=http://api:3001`, API stays private). Switching the web target requires `docker compose up --build`. Nothing runtime-validated by the compose/doc alignment (no containers started; `docker compose config` checked against a synthetic env only).
- Phase 6 remains **NOT validated** until Farhan approves the gate.

**Update 2026-11-27 — runtime single-origin validation, local Docker mock stack (LOCAL ONLY; Farhan chose local-only):**

Proven at runtime locally with dummy secrets, local mock OpenAI/Ollama, unique Compose project/fresh volumes/alternate loopback ports:

- **SSE through the rewrite**: same-origin chat streams through the public web origin's `/api/:path*` rewrite to private `api:3001` — byte-live streaming, duplicate send → 409 with no extra model call, disconnect → **full same-origin replay exactly once**, post-complete resume → 204. Same-process replay only; replay completed **before** any restart — **no cross-process replay claim**.
- **Runtime SSR**: the standalone web container hydrates server-side via runtime `API_INTERNAL_URL` (`resolveServerApiBaseUrl` + Compose `environment.API_INTERNAL_URL`); the earlier SSR failure (`Chat history is temporarily unavailable`) is fixed — rebuilt SSR HTML includes the transcript, no error; unauthenticated/foreign-owner requests see no transcript.
- **OAuth proxy (local checks only)**: dummy providers report true/false; unauth get-session → null, chat → 401; social sign-in init builds the **public web callback** URL without contacting Google/GitHub; a real signed local fixture get-session works. **Real external OAuth return remains unproven.**
- **Scheduler container**: MANUAL run `COMPLETED` attempt 1 with isolated chat + usage; deterministic `schedulerRequestId(execution-<executionId>)` is **identical** in the scheduler's completion log and the API's scheduler-run/chat/hydration logs; safe supplied request IDs echoed/correlated; healthcheck healthy → API stopped → unhealthy after retries (no crash) → API restart → healthy; `LOG_LEVEL=debug` enabled 2xx request logs in API and scheduler; **secret log scan: 0**.
- **Lifecycle/persistence**: 8/8 migrations on fresh volumes; api/web/scheduler uid 1000; graceful stop — all exit 0; restart healthy with Redis/Postgres transcripts, tasks, executions, users, sessions persisted.
- **Still unproven (unchanged)**: no Railway project, no private-DNS variable references, no managed pgvector/RLS-privilege probe, no real public OAuth, no deployed URL. **Nothing is deployed.** Phase 6 stays ACTIVE / NOT validated.
