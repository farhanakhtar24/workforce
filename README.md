# Workforce

> An AI workforce platform: you chat with a small team of AI agents, and they actually *do* work — running tasks on a schedule, remembering things across conversations, and delegating big jobs to each other.

Think less "chatbot", more "team".

---

## Why this exists (portfolio pitch)

A chatbot answers. An agent *works*. Every AI product company in 2025-26 is moving from the first to the second. This project exists to prove — with shippable code — that the author can architect, build, and defend a production-grade multi-agent system.

Inspired by the multi-agent platform pattern at Helium, rebuilt from scratch with mainstream Node.js + TypeScript.

---

## Demo scenario (what v1 will do)

> *"Hey Workforce, every Monday morning analyze our sales data, write a summary, and flag anything unusual. Also — right now, research our top 3 competitors."*

The system:

1. Schedules the Monday job (recurring, no human touch again).
2. Kicks off the competitor research: the Orchestrator agent says "this is too big for me", splits it 3 ways — Analyst handles one competitor, Researcher handles another, Writer compiles.
3. Saves what it learned into a "brain" so next week it knows more.
4. Streams everything live to a dashboard with charts, documents, and a visual graph showing which agent is doing what.

---

## Core principles

1. **Composition-time safety gates** — read vs. write tool permissions are decided when the agent is *assembled*, not when it runs.
2. **Memory that doesn't blow up** — hierarchical, path-addressed, vector-searchable, LLM-compacted.
3. **Delegation as a first-class primitive** — sync, async, and DAG-orchestration, all depth-capped.
4. **Production resilience out of the box** — idempotency keys, resumable SSE streams, error containment.
5. **One AI surface exposes the same backend the UI uses** — no shadow APIs. Tools call the REST API like everyone else.

---

## Repo layout

```
workforce/
├── apps/
│   ├── cli/            # Phase 1 (validated) — terminal agent loop
│   ├── api/            # Phase 2 (validated) — Express, SSE chat, Redis-backed idempotency + resume; Phase 3 memory REST routes + BullMQ memory worker built (validation pending)
│   └── web/            # Phase 2 (validated) — chat UI; Phase 3 /memory page built (validation pending); full dashboard later (Phase 5+)
├── packages/
│   ├── core/           # @workforce/core — shared capability tools (Phase 2: calculate); memory module + Prisma pgvector adapter built (Phase 3, validation pending); runtime/delegation Phase 4
│   ├── db/             # placeholder — the Prisma schema + migrations live in packages/core/prisma (Phase 3)
│   └── queue/          # placeholder — the BullMQ memory queue lives in apps/api/src/memory (Phase 3); scheduler Phase 5+
├── docs/
│   ├── architecture.md        # System design deep-dive
│   ├── decisions/             # ADR-001..ADR-008 — written as we build
│   ├── phases/                # Per-phase learnings + validation results
│   ├── learning/              # Curriculum, self-assessments
│   └── interview/             # (Later) prep notes
├── scripts/
│   └── seed.ts                # Seeded demo data (sales, products)
└── docker-compose.yml         # Local infra: Phase 2 Redis + Phase 3 pgvector Postgres (app containers in Phase 6)
```

---

## Build phases

| Phase | Focus | Artifact | Duration |
|---|---|---|---|
| **0** | Repo scaffolding + dev env | This repo | 1 day |
| **1** | LLM Core (tokens, prompts, tool calling, agent loop) | CLI agent with 1 tool | 1-2 weeks |
| **2** | Streaming, SSE, resumability, idempotency | Chat UI with live stream + refresh-safe resume | 1 week |
| **3** | Embeddings, pgvector, hybrid search, memory tree | Memory service + REST routes + /memory page | 1-2 weeks |
| **4** | Multi-agent, delegation, plan/action mode, HITL | Orchestrator + 2 workers | 1-2 weeks |
| **5** | BullMQ, task scheduler, recurrence | Scheduled agent runs | 1 week |
| **6** | Docker, deploy, observability | Live URL | 1 week |

See [`ROADMAP.md`](./ROADMAP.md) for the detailed phase-by-phase breakdown.

---

## How learning happens here

Every phase follows the same rhythm:

1. **📋 Topic list** — I list the phase's topics.
2. **🎚️ Self-assessment** — You rate each 🟢 / 🟡 / 🔴 (in the phase's own doc).
3. **📚 Targeted learning** — 🟢 is a refresher, 🟡 is an exercise, 🔴 is a full lesson.
4. **🏗️ Build** — The phase's artifact (CLI tool, UI, memory system, etc.).
5. **✅ Validation** — Mixed format (quizzed, explain-back, or demo + probe). Pass → next phase. Fail → fix, re-validate.

Full curriculum: [`docs/learning/CURRICULUM.md`](./docs/learning/CURRICULUM.md).

---

## Quick start

Requires Node.js 24+, Docker (local Redis + Postgres/pgvector), and your own Ollama Cloud API key. Install from the repo root (npm workspaces):

```bash
npm install

# Copy the example env file and put YOUR OWN key in the local copy
# (gitignored, never committed; no per-terminal export needed):
cp .env.example .env
# then edit .env → OLLAMA_API_KEY=replace_with_your_personal_key

# Local infrastructure: Phase 2 Redis + Phase 3 Postgres/pgvector, 127.0.0.1 ports only:
npm run dev:infra                # or: docker compose up -d redis postgres
npm run dev                      # builds @workforce/core, applies the Prisma memory migration, then runs API + web together
```

Exporting `OLLAMA_API_KEY` in the shell still works — a shell-exported value always wins over env files; export is only optional now. Blank values never block startup: an empty or whitespace-only optional value counts as absent, so its documented default applies — a blank `OLLAMA_API_KEY` still stops startup with the reason `OLLAMA_API_KEY is missing`.

| Where | URL |
|---|---|
| Web (chat UI) | http://localhost:3000 |
| Web (memory page) | http://localhost:3000/memory |
| API (Express: chat + memory routes) | http://localhost:3001 |
| Redis | localhost:6379 |
| Postgres (pgvector) | 127.0.0.1:55432 — db/user/password all `workforce` (host port 55432 → container 5432; keeps clear of another local Postgres on 5432) |

Notes on what runs where:

- `npm run dev` starts both processes with `concurrently` (one command, Ctrl+C stops both) and passes your shell environment through unchanged — nothing is copied into files. The API itself auto-loads gitignored env files before config (root `.env.local` / `.env` and `apps/api/.env.local` / `.env`; shell values always win — details in [apps/api/README.md](./apps/api/README.md)). `OLLAMA_API_KEY` belongs in the API/server environment only. The web app uses the default `NEXT_PUBLIC_API_URL=http://localhost:3001`, needs no key, and runs **no model in the browser**: embeddings come from the API's local Transformers.js provider.
- The **first memory write** downloads the local MiniLM model (`Xenova/all-MiniLM-L6-v2`, 384 dims) into the project-local, gitignored cache `.cache/workforce-models` (configurable via `EMBEDDING_CACHE_DIR`). Afterwards the embedding pipeline is fully offline — no second API key, no hosted embeddings (ADR-007).
- `DATABASE_URL` defaults to `postgresql://workforce:workforce@127.0.0.1:55432/workforce` — the docker-compose `postgres` service. Local dev only: the Phase 6 deployment must set an explicit secret URL.
- The migration runs automatically in `predev`. Re-run it manually after pulling new migrations with `npm run db:migrate` (uses the repo's local Prisma 6.19.3 — no `npx` download; it never runs inside the API process).

Offline checks (core is built first so CLI/API imports resolve; none of these need Postgres or Redis running):

```bash
npm run typecheck   # root tsc (shared/CLI/API) + core, API-test and web typechecks
npm test            # every workspace's tests: core, CLI, API, web — offline total currently 339 green
npm run build       # core → CLI → API → web, in dependency order
```

Real integration tests (opt-in; both use a deterministic mock model — no Ollama
and no API key; URL values are never printed):

```bash
npm run test:integration # API test-live suite: real Redis (chat streaming) AND
                         # real Postgres/pgvector + BullMQ memory pipeline.
                         # Needs: docker compose up -d redis postgres. The core
                         # build and `db:migrate` run automatically in the
                         # `pretest:integration` hook — run the migration once
                         # per fresh database before the first integration run.
npm run test:embedding   # Real local Transformers.js embedding smoke
                         # (Xenova/all-MiniLM-L6-v2, 384 dims). The FIRST run
                         # downloads the model from HuggingFace into the
                         # project-local cache apps/api/.cache/workforce-models
                         # (gitignored, ~30MB quantized); the cache persists
                         # and later runs load from disk. No key needed.
```

Both suites are hermetic per run: unique run scopes/queue names, exact-run
cleanup (test rows by scope, test queue by name — never FLUSHDB, never other
rows/queues).

### Live memory walkthrough with the real API (Farhan's demo)

The seeder drives a RUNNING dev server over plain HTTP; it reads no Ollama key.
The only real model call happens **server-side**: the 31st seeded block crosses
the compaction threshold and the API's compactor (your key, inside the server
process) summarizes the 30 oldest blocks; the summary is embedded by the real
local MiniLM worker like any other write.

```bash
npm run dev:infra                       # Redis + Postgres/pgvector
export OLLAMA_API_KEY=<your key>        # optional now — a key in .env is loaded automatically; a shell value would win
npm run dev                             # predev builds core + runs db:migrate
npm run demo:memory                     # separate terminal — seeds + polls; exits when the summary is ready
```

The seeder is idempotent: rerun `npm run demo:memory` to RESUME the live demo
`demo`/`compaction/small-models` (31 ready blocks, no summary after the first
provider timeout) — it queues one fresh compaction with a new trigger and
polls; no blocks are appended and no duplicate summary is created. If the
summary exists but its embedding is pending/failed, the rerun requeues only
that embedding; if it is already ready, the seeder reports success immediately.

Then open `http://localhost:3000/memory`:

1. Browse scope `demo`, path `compaction/small-models`, switch **include superseded** on: one `learning` summary plus its 30 retained observations (superseded, still readable) — this is the compaction evidence for the real Ollama call.
2. Quick create/search checks: write an observation on a fresh path → it goes `pending` → `ready`; run a semantic search that should hit it (the page shows cosine, recency, score, status); superseded sources appear only with **include superseded** on.
3. Correction check: write two facts at one path, create a correction superseding the first, confirm the default browse hides the superseded one and the related view shows the `supersedes` edge.

Optional script env: `WORKFORCE_API_URL` (default `http://localhost:3001`),
`DEMO_SCOPE` (default `demo`), `DEMO_PATH` (default
`compaction/small-models` — the seeder refuses an already-seeded path and asks
for a new one). Demo rows are left in place on purpose for UI inspection —
delete them by hand or pick a new `DEMO_PATH` next time.

These development checks alone are not the validation claim. The Phase 2 live
gate — visible streaming, tool result in the UI, history retention, mid-stream
refresh resume, double-submit protection, provider/network error containment —
passed on 2026-11-19: Farhan confirmed the live Phase 2 web flow is working on
2026-11-19. Full evidence:
[`docs/phases/phase-2-streaming.md`](./docs/phases/phase-2-streaming.md).
**Phase 3 is implemented and now has a green real-stack integration suite
(Postgres/pgvector + BullMQ memory pipeline) plus a real local-embedding smoke,
but the interactive Phase 3 UI/live gate has not been run with a real agent/Ollama
call — the phase stays incomplete until Farhan explicitly approves it.**

### Phase 1 — CLI REPL (optional, validated)

```bash
npm run build --workspace @workforce/core   # the CLI resolves @workforce/core from its dist/
npm run dev --workspace @workforce/cli      # REPL against Ollama Cloud
```

---

## Stack

- **Language**: TypeScript (strict)
- **Runtime**: Node.js 24+ (migrated from Node 20 on 2026-11-21)
- **Backend**: Express 4 (NOT Fastify — keep it boring)
- **DB**: Postgres 16 + Prisma 6.19.3 + pgvector, `vector(384)` (Phase 3 — built, validation pending)
- **Embeddings**: local `@huggingface/transformers` — `Xenova/all-MiniLM-L6-v2`, mean pooling + normalized, 384-dim; first use downloads to a local ignored cache, then offline (ADR-007)
- **Redis**: chat messages, idempotency keys, active stream markers, resumable-stream relay (Phase 2); BullMQ memory queue on top — embedding + compaction jobs (Phase 3 — built, validation pending); scheduler later (Phase 5)
- **LLM**: Ollama Cloud (`glm-5.3-flash`, OpenAI-compatible API) — raw HTTP in Phase 1, via AI SDK `@ai-sdk/openai-compatible` in Phase 2; provider-swappable by design
- **AI SDK**: Vercel AI SDK v6 (`useChat`, `DefaultChatTransport`, `streamText`)
- **UI** (Phase 2+): Next.js 16 + React 19 (Tailwind + React Query join later)
- **Observability**: pino (structured logs), OpenTelemetry (stretch)

---

## Status

- [x] Phase 0 — repo scaffolding
- [x] Phase 1 — LLM core (validated 2026-11-17 → [`docs/phases/phase-1-llm-core.md`](./docs/phases/phase-1-llm-core.md))
- [x] Phase 2 — Streaming (validated 2026-11-19 → [`docs/phases/phase-2-streaming.md`](./docs/phases/phase-2-streaming.md)); automated suites green and Farhan confirmed the live Phase 2 web flow is working on 2026-11-19
- [ ] Phase 3 — Memory (**active** since 2026-11-19 — implementation complete offline: 298 green tests; live validation gate pending → [`docs/phases/phase-3-memory.md`](./docs/phases/phase-3-memory.md))
- [ ] Phase 4 — Multi-agent (not started)
- [ ] Phase 5 — Queues & scheduler
- [ ] Phase 6 — Deploy

Last updated: 2026-11-21 — Runtime migrated from Node.js 20 to Node.js 24 (`>=24.0.0` across all five workspaces, `.nvmrc` → `24`, `@types/node` 24.19.2); all offline suites, typecheck, full build, real Redis/Postgres integration tests and local ONNX/Transformers embedding tests re-verified under Node 24.20.0 (see [phase-2 doc](./docs/phases/phase-2-streaming.md) and [phase-3 doc](./docs/phases/phase-3-memory.md) for run notes). Phase 3 (Memory) is **active, not validated**: design fixed and [ADR-003](./docs/decisions/ADR-003-memory-tree.md) + [ADR-007](./docs/decisions/ADR-007-pgvector.md) accepted 2026-11-19; implementation is in place — memory domain + Prisma pgvector adapter + migration in `packages/core` (MemoryService, in-memory + Postgres stores), memory REST routes + local Transformers.js embeddings + Ollama compactor + BullMQ worker in `apps/api`, `/memory` page in `apps/web`, and local infra in docker-compose (Phase 2 Redis + Phase 3 `pgvector/pgvector:pg16` Postgres on `127.0.0.1:55432`, `DATABASE_URL` defaulting to the local `workforce` stack). Offline suites total **298 green tests** (core 109, CLI 30, API 114, web 45); app deployment stays Phase 6. The Phase 3 live validation gate has **not** been run — the phase is incomplete until Farhan explicitly approves. Phase 1 and Phase 2 remain completed & validated (Phase 2 on 2026-11-19: 156/156 offline tests (core 31, CLI 30, API 74, web 21), 3/3 real Redis integration tests, root typecheck, full build, desktop/mobile accessibility smoke, and Farhan confirmed the live Phase 2 web flow is working on 2026-11-19; ADR-005 and ADR-008 accepted).
