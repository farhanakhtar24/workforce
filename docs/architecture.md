# Workforce — Architecture

Written during Phase 0 scaffold; extended as we build. This is the **single source of truth** for the system's shape — if code and this doc disagree, the doc wins until we update it.

> Current state (2026-11-19): Phase 1 (CLI agent) **validated 2026-11-17**; Phase 2 (streaming, SSE, idempotency) **validated 2026-11-19** — see [`docs/phases/phase-2-streaming.md`](./phases/phase-2-streaming.md). Phase 3 (Memory) is **implemented — validation pending** (design fixed in [ADR-003](./decisions/ADR-003-memory-tree.md) and [ADR-007](./decisions/ADR-007-pgvector.md)); the memory entries in the module map below are **built and covered by 298 green offline tests** (core 109, CLI 30, API 114, web 45), but the phase is **not completed** — its live validation gate has not been run. Phase 4+ not started.

---

## High-level shape

```
┌────────────────────────────────────────────────────────────────┐
│                          Web UI                                │
│                  (Next.js, React, AI SDK)                       │
└──────────────────────────────┬─────────────────────────────────┘
                               │  HTTP / SSE
                               ▼
┌────────────────────────────────────────────────────────────────┐
│                       API Server (Express)                      │
│                                                                  │
│   ┌─────────────┐   ┌──────────────────┐   ┌───────────────┐   │
│   │  Auth       │   │  Agent Runtime   │   │  Threads /    │   │
│   │  Middleware │──▶│  (ToolLoopAgent) │──▶│  Artifacts    │   │
│   └─────────────┘   └─────────┬────────┘   └───────────────┘   │
│                                │                                  │
│                     ┌──────────▼─────────┐                        │
│                     │  Capability Layer  │  (adapters, approval)  │
│                     └──────────┬─────────┘                        │
└────────────────────────────────┼────────────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
          ┌────────┐         ┌──────────┐       ┌──────────┐
           │ Postgres│        │  Redis   │       │  LLM     │
           │ +pgvector│       │ streams/ │       │ Providers│
           │ Phase 3  │       │ idempot. │       │ (Ollama  │
           └────────┘         │  resume  │       │  Cloud)  │
                              │  Phase 2 │       └──────────┘
                              │ (BullMQ: │
                              │ memory   │
                              │ jobs 3;  │
                              │ sched. 5)│
                              └──────────┘
                                  │
                                  ▼
                          ┌──────────────┐
                          │  Cron Worker │
                          │  (separate)  │
                          └──────────────┘
```

---

## Module map

| Module | Where | Status | Responsibility |
|---|---|---|---|
| **Shared calculator tool** | `packages/core/capabilities/` (`@workforce/core`) | **Phase 2 (validated)** | The one shared tool (`calculate`) used by CLI (Phase 1) and API (Phase 2) |
| **API routes** | `apps/api/routes/` | **Phase 2 (validated)** | Chat POST, resume GET, hydration GET (`slug=general` only for now) |
| **Streaming** | `apps/api/streams/` | **Phase 2 (validated)** | SSE via AI SDK UI message streams, resumable streams, idempotency |
| **Web UI** | `apps/web/` | **Phase 2 (validated)** | Minimal accessible chat page (`useChat`, resume, hydration) |
| **Memory** | `packages/core/memory/` | **Phase 3 — implemented, validation pending** | Domain contracts + `MemoryService` (`writeBlock/queryBlocks/semanticSearch/exploreRelated`), embedding/compaction processing methods, in-memory unit store; Prisma Postgres/pgvector adapter (`vector(384)`) + migration |
| **Memory REST routes** | `apps/api/src/memory/` (routes) | **Phase 3 — implemented, validation pending** | Blocks browse/search/related/retry/compact endpoints (registered only when memory deps are injected) — built on top of `@workforce/core` |
| **Memory web page** | `apps/web/` (`/memory`) | **Phase 3 — implemented, validation pending** | Accessible page: create, path/keyword browse, semantic search, related/superseded, retry, compact |
| **Memory queue + worker** | `apps/api/src/memory/` (BullMQ `workforce-memory` queue) | **Phase 3 — implemented, validation pending** | Embedding + compaction jobs on the existing Redis: deterministic job IDs, bounded retries w/ backoff, idempotent workers, failed status visible; local Transformers.js embeddings + Ollama compactor |
| **Agent runtime** | `packages/core/runtime/` | planned (not Phase 2) | ToolLoopAgent assembly, stop conditions, step caps — Phase 2 uses `streamText` directly in `apps/api` |
| **Capabilities** | `packages/core/capabilities/` (full set) | planned | Tool adapters (sql, http_fetch, memory, work_doc, ask_user, scheduler) — memory tool composition arrives Phase 4 |
| **Delegation** | `packages/core/delegation/` | planned (Phase 4) | Sync, async (via queue), orchestration DAG |
| **Scheduler** | `packages/queue/scheduler/` | planned (Phase 5) | BullMQ repeatable jobs, recurrence, execution records |

---

## Local infrastructure (current — not the Phase 6 deployment)

`docker-compose.yml` is local infrastructure only; app containers are Phase 6:

- **Redis 7** (AOF on) — chat state, idempotency keys, active stream markers, resumable-stream relay, and the BullMQ memory queue.
- **Postgres 16 + pgvector** (`pgvector/pgvector:pg16`) — the memory store. Local db/user/password all `workforce`, host port bound to `127.0.0.1:55432` (→ container 5432), named `postgres-data` volume, `pg_isready` healthcheck, `restart: unless-stopped`.

Commands (repo root): `npm run dev:infra` brings both up (`docker compose up -d redis postgres`; `npm run dev:redis` / `npm run dev:postgres` are per-service), and `npm run db:migrate` runs the memory migration with the repo's local Prisma 6.19.3 (`npx prisma migrate deploy --schema packages/core/prisma/schema.prisma` — no `npx` download; migrations never run inside the API process). The root `predev` builds `@workforce/core` and applies the migration before `npm run dev`. `DATABASE_URL` defaults to `postgresql://workforce:workforce@127.0.0.1:55432/workforce` (overridable by env) — a localhost-only convenience for development. It embeds throwaway credentials and **Phase 6 deployment must set an explicit secret URL instead**.

---

## The four flagship patterns (defense points for interviewers)

### 1. Tool Loop with Composition-Time Gating

Each agent is defined by **which capability adapters it loads**. An adapter lists its tools and marks some as `readOnlyTools: [...]`. In **plan mode**, a tool not in `readOnlyTools` is **never even attached** to the loop — so the model cannot accidentally call a write tool, even if the prompt went sideways.

> Interview line: *"Read/write permissions are enforced when the agent is assembled, not when the model runs. Prompt injection can try, but there's no write tool in the tool list to hijack."*

### 2. Self-Hosted Tools (Agents Call Own API)

Tools inside capability adapters don't touch the DB directly. They call `localFetch('/api/warehouse/...')` — the same HTTP endpoints the web UI uses. This means auth middleware, tenancy scoping, and validation logic are written **once**, used by both human users and agents.

> Interview line: *"No shadow API. Agent tools go through the same middleware stack as the frontend. Means one auth model, one tenancy model, one validation library."*

### 3. Path-Addressed Memory Tree with Hybrid Search

Memory blocks live at **domain-neutral slash paths** like `research/small-language-models` (single-tenant `scope = default`; never brand paths). Each block has a **kind** (learning / correction / changelog / observation / decision / preference), a **confidence**, typed **relations** (`supports / supersedes / contradicts`), and a pgvector `vector(384)` embedding. Retrieval uses:

```
score = 0.8 * cosine_similarity + 0.2 * recency_decay
```

… with pgvector HNSW cosine for candidate recall, per-kind half-lives (`recency = 0.5^(ageDays / kindHalfLife)`), and async LLM-driven compaction when active blocks at an exact path exceed 30 (one summary block with `compactedFromIds`, sources retained but superseded). Flat memory dies around block 50; the tree design scales to thousands.

> Interview line: *"Memory is a tree, not a list. Each agent gets its own namespace; retrieval is hybrid — cosine for semantics, recency for staleness. Pruning is LLM-driven and half-life weighted."*

### 4. Depth-Capped Multi-Layer Delegation

Three ways for agents to offload work:

- **Sync** — call another agent's HTTP chat endpoint mid-loop; block until done.
- **Async** — enqueue a BullMQ job; a sub-thread is created, the worker runs the child agent headless, status appears in a tracker artifact.
- **Orchestration DAG** — LLM authors a JSON plan specifying steps + dependencies; an executor fans out satisfied steps.

All delegation is **depth-capped at 2** (0=root, 1=child, never deeper). This is enforced at capability-composition time — the `delegate_task` tool is absent when `delegationLevel >= 2`.

> Interview line: *"Three delegation modes — sync, async-queue, DAG — all depth-capped. The depth cap isn't a runtime check; the tool literally doesn't exist for agents at level 2. That's defense-in-depth."*

---

## Data model sketch

> Will evolve; this was the Phase 0 sketch — `MemoryBlock` is updated to Phase 3 reality (2026-11-19).

```
User ────────────┐
                 │
Thread (AgentThread)
  ├── ThreadMessage[]
  ├── ThreadArtifact[]       (Work Doc, Plan, Outputs)
  ├── ThreadParticipant[]
  └── parentThreadId?        (for sub-threads / delegation)

AgentDefinition       (static config in code)
  ├── slug
  ├── capabilities[]          (adapter IDs)
  ├── delegatableAgents[]     (slugs this agent can call)
  └── memoryPaths[]           (autoload paths)

MemoryBlock
  ├── scope                   (single-tenant: "default")
  ├── path                    (domain-neutral slash paths, e.g. research/small-language-models)
  ├── kind                    (learning / correction / changelog / observation / decision / preference)
  ├── status                  (pending → ready | failed)
  ├── content                 (text, 1..1000 chars)
  ├── confidence              (0..1)
  ├── accessCount             (for relevance)
  ├── embedding               (vector(384) — pgvector, HNSW cosine)
  ├── relations[]             (supersedes / supports / contradicts)
  └── compactedFromIds[]      (compaction provenance; sources retained, superseded)

AgentTask (scheduler)
  ├── agentSlug
  ├── userPrompt
  ├── recurrenceType          (ONCE / DAILY / WEEKLY / MONTHLY / CRON)
  ├── recurrenceConfig        (JSON)
  ├── skipDates[]             (dates to skip)
  └── isActive

AgentTaskExecution
  ├── taskId
  ├── scheduledFor
  ├── startedAt / completedAt
  ├── status                  (RUNNING / SUCCESS / FAILED / SKIPPED)
  ├── tokenUsage
  └── durationMs
```

---

## Streaming shape (Phase 2 — current reality)

Two SSE surfaces; only the first is built in Phase 2:

1. **Chat stream** (`POST /api/agents/:slug/chat`) — AI SDK UI message stream (token deltas, tool calls, finish reasons). **Resumable** via `resumable-stream` (Redis sentinel/pubsub relay; replay chunks live in the producing API process's memory — see the replay boundary below). Resume endpoint: `GET /api/agents/:slug/chat/:clientChatId/stream` (`204` when no active stream). Hydration endpoint: `GET /api/agents/:slug/chat/:clientChatId` returns saved `UIMessage[]` + active-stream flag.

2. **Thread state stream** (`GET /api/threads/:id/stream`) — JSON snapshot/delta of artifacts + approval states. Polls every 2s, emits delta when signature changes. *Planned for later phases; not built yet.*

Phase 2 specifics (see [ADR-005](./decisions/ADR-005-sse-idempotency.md), [ADR-008](./decisions/ADR-008-ai-sdk-ui-streams.md)):

- Client sends **chat ID + only the newest user `UIMessage`** (`prepareSendMessagesRequest`); the server owns the transcript in Redis as an **append-only LIST** (RPUSH/LRANGE, one JSON UIMessage per entry, no TTL).
- Server flow: load prior UI messages → append → `validateUIMessages` → `convertToModelMessages` → `streamText` with `stepCountIs(10)`. No `tool_choice`, no structured output. The **complete appended conversation** is validated before anything durable: an invalid newest message → **400** before any idempotency key is acquired, anything is appended, or the provider is called. Malformed JSON → fixed **400**, bodies over 256 kb → fixed **413**.
- `Idempotency-Key` (chat ID + user message ID) on chat POSTs → Redis `SET NX` TTL 900 → **409** on duplicate with **no second generation**; missing/invalid → **400**.
- Resume is a **full SSE replay** (`resumeStreamIsReplay: true`); `useChat({ resume: true })` reconnects to the Express resume route. Disconnect must not cancel the provider generation; no explicit stop endpoint in Phase 2.
- Stream lifecycle tracks an `activeStreamId` (TTL 86 400 s); completion clears only the matching ID via atomic compare-and-del (an old completion cannot clear a newer stream), and a resume hitting the ack timeout cleans the stale marker and answers `204`.
- **Replay boundary**: resumable-stream 2.2.13 uses Redis for its relay while replay chunks stay in the producing API process's memory. Reconnect to the same running process → full replay, no duplicate tokens. An API restart mid-flight is not covered by replay; clients fall back to hydration of the persisted messages. Redis-held data (messages, idempotency keys, markers) is durable subject to Redis persistence (AOF on). Not a distributed-durability claim.
- UI updates throttled ~50 ms; Web UI is deliberately minimal and accessible.
- Express is a separate long-running server (no Next `after()`): background promises are tracked explicitly, and the AI SDK Web `Response` is piped through a small tested adapter with `UI_MESSAGE_STREAM_HEADERS`, no buffering.

**Redis is a hard Phase 2 dependency** (chat message history, active stream IDs, idempotency keys, resumable-stream's relay). If Redis is unavailable, chat and resume return an **explicit `503`** — we do not degrade to a no-op that silently loses exactly-once/resume guarantees. This supersedes the earlier "graceful no-op if Redis is down" wording. BullMQ joins in Phase 3 with a dedicated memory queue (embedding + compaction jobs) reusing the same Redis; the scheduler arrives in Phase 5.

---

## Failure modes we've designed for

| Mode | Defense |
|---|---|
| Duplicate chat send (double-submit) | Idempotency-Key + Redis NX |
| Mid-stream client disconnect | Resumable stream + full replay (same running API process) |
| API process restart mid-stream | Replay not guaranteed (process-local); client falls back to hydration of persisted messages |
| Tool throws uncaught error | Error containment wrapper in adapter — loop continues |
| Model calls write tool in plan mode | Tool absent from toolkit — model cannot even reference it |
| Memory grows unbounded | Async LLM compaction when active blocks at an exact path exceed 30 — oldest 30 → one summary block; sources retained, superseded (ADR-003) |
| Embedding job fails (model unavailable/invalid output) | Block stays `failed` and path-queryable; retry endpoint; failed never masquerades as ready |
| Postgres/pgvector unavailable | Memory operations return an explicit 503 — no silent writes, no fake readiness |
| Duplicate embed/compaction jobs | Deterministic job IDs + idempotent workers + per-path compaction duplicate protection |
| Delegation infinite recursion | Depth cap, enforced at adapter composition |
| BullMQ worker crash mid-job | Job idempotency via Redis lock + retry with backoff |
| Redis unavailable | Chat/resume return an explicit 503 — no silent drop of exactly-once or resume guarantees (ADR-005) |

---

## Non-goals (and why)

- **Multi-brand tenancy for v1** — single-tenant demo for portfolio. The patterns scale, but we don't need that complexity.
- **Voice / audio** — great Helium feature, not needed for Workforce.
- **MCP server exposure** — nice-to-have, stretch goal only.
- **Shopify / ecom integrations** — domain-agnostic demo.
- **Fine-tuning** — foundation models only, prompt + tools is enough here.
- **Dedicated vector DB (Pinecone / Milvus / ClickHouse)** — pgvector inside the Postgres we already run; local MiniLM embeddings (ADR-007).
- **Graph database** — typed relations on memory blocks give traversal without one (ADR-003).

---

## ADRs (so far, written as we go)

> See [`/docs/decisions/`](./decisions/) for the full list — written when the decision is made:

- ADR-001: Composition-time read/write gating (not runtime) — Phase 4, not written
- ADR-002: Agents call own REST API (no shadow API, no direct DB from tools) — Phase 4, not written
- ADR-003: [Memory tree + relations + compaction over flat memory / graph DB](./decisions/ADR-003-memory-tree.md) — **Accepted 2026-11-19**
- ADR-004: Depth cap at 2 (not 3) — Phase 4, not written
- ADR-005: [SSE + idempotency vs. WebSockets](./decisions/ADR-005-sse-idempotency.md) — **Accepted 2026-11-17**
- ADR-006: BullMQ over in-process cron — Phase 5, not written
- ADR-007: [pgvector + local MiniLM embeddings (dimension tradeoff, local cache/privacy/cost)](./decisions/ADR-007-pgvector.md) — **Accepted 2026-11-19**
- ADR-008: [AI SDK UI message streams vs. custom protocol](./decisions/ADR-008-ai-sdk-ui-streams.md) — **Accepted 2026-11-17**

---

## Interview narrative seed

When an interviewer opens this repo and asks *"talk me through it"*, the answer starts here:

> *"It's a multi-agent platform — a workforce, not a chatbot. Three things stand out.*
>
> *First, safety is compositional: whether an agent can write depends on which adapters it loaded, not on the prompt.*
>
> *Second, memory is hierarchical and hybrid — path-addressed, cosine-and-recency-scored, LLM-compacted.*
>
> *Third, delegation is depth-capped, multi-modal, and tracked — agents offload sync, async-via-queue, or via a DAG the model itself authors.*
>
> *Around those, the usual production plumbing: idempotency keys, resumable streams, structured logging, queue-backed schedulers."*
