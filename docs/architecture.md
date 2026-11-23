# Workforce — Architecture

Written during Phase 0 scaffold; extended as we build. This is the **single source of truth** for the system's shape — if code and this doc disagree, the doc wins until we update it.

> Current state (2026-11-23): Phase 1 (CLI agent) **validated 2026-11-17**; Phase 2 (streaming, SSE, idempotency) **validated 2026-11-19** — see [`docs/phases/phase-2-streaming.md`](./phases/phase-2-streaming.md). Phase 3 (Memory) **validated 2026-11-23** — design fixed in [ADR-003](./decisions/ADR-003-memory-tree.md) and [ADR-007](./decisions/ADR-007-pgvector.md); evidence: **374 green offline tests** (core 137, CLI 30, API 162, web 45), real Postgres/pgvector+BullMQ integration **14/14**, real local-MiniLM embedding smoke **5/5**, and a live demo with Farhan's real Ollama key (compaction succeeded: one ready summary over 30 superseded sources; browser showed the READY summary and superseded observations); Farhan approved the phase on 2026-11-23 (topic self-assessment remained waived — not claimed). Phase 4 (Multi-Agent) is **implemented and integration-tested — validation pending** ([ADR-001](./decisions/ADR-001-composition-gating.md), [ADR-002](./decisions/ADR-002-same-rest-api.md), [ADR-004](./decisions/ADR-004-delegation-depth.md) accepted 2026-11-23): **583 green offline tests** (core 203, CLI 30, API 256, web 94), root typecheck + production build pass, real-infrastructure suite **23 tests green twice with cleanup** (11 memory + 3 Phase 2 Redis streaming + 9 Phase 4: Prisma WorkDoc CAS/rollback/links, sync same-REST delegation, real BullMQ async with atomic single-claim, real Redis `ask_user` byte-CAS, read-only `query_data` guardrails) — models mocked, so **the real Ollama/browser live gate and Farhan's explicit approval remain: the phase is not validated**. Recovery claims are per API process (no multi-process failover). Phase 5+ not started.

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
│                     │  Capability Layer  │  (registry, approval)  │
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
| **Shared calculator tool** | `packages/core/capabilities/` (`@workforce/core`) | **Phase 2 (validated)** | The one shared tool (`calculate`) used by CLI (Phase 1) and API (Phase 2) — stays the single shared local primitive in Phase 4 |
| **API routes** | `apps/api/routes/` | **Phase 2 (validated)**; Phase 4 **implemented** (validation pending) | Chat POST, resume GET, hydration GET; Phase 4: chat dispatch by slug + mode + server-resolved depth, Work Docs / Delegations / `query_data` routes (`general`-only 404 fallback when agent deps are absent) |
| **Streaming** | `apps/api/streams/` | **Phase 2 (validated)** | SSE via AI SDK UI message streams, resumable streams, idempotency — unchanged by Phase 4 (child chats reuse it) |
| **Web UI** | `apps/web/` | **Phase 2 (validated)**; `/memory` **Phase 3 (validated)**; Phase 4 **implemented** (validation pending) | Minimal accessible chat page (`useChat`, resume, hydration). Phase 4: agent picker, agent-scoped chat URLs, `/work` + `/work/[id]` Work Docs, `/delegations` panel (8 routes total) |
| **Memory** | `packages/core/memory/` | **Phase 3 (validated 2026-11-23)** | Domain contracts + `MemoryService` (`writeBlock/queryBlocks/semanticSearch/exploreRelated`), embedding/compaction processing methods, in-memory unit store; Prisma Postgres/pgvector adapter (`vector(384)`) + migration |
| **Memory REST routes** | `apps/api/src/memory/` (routes) | **Phase 3 (validated 2026-11-23)** | Blocks browse/search/related/retry/compact endpoints (registered only when memory deps are injected) — built on top of `@workforce/core`; reused by the Phase 4 `search_memory` tool |
| **Memory web page** | `apps/web/` (`/memory`) | **Phase 3 (validated 2026-11-23)** | Accessible page: create, path/keyword browse, semantic search, related/superseded, retry, compact |
| **Memory queue + worker** | `apps/api/src/memory/` (BullMQ `workforce-memory` queue) | **Phase 3 (validated 2026-11-23)** | Embedding + compaction jobs on the existing Redis: deterministic job IDs, bounded retries w/ backoff, idempotent workers, failed status visible; local Transformers.js embeddings + Ollama compactor |
| **Agents & capability registry** | `packages/core/agents/` | **Phase 4 — implemented (validation pending)** | Agent definitions (`orchestrator`, `analyst`, `researcher`; `general` unchanged), tool registry with Zod schemas + `readOnly`/approval metadata, pure `composeAgentCapabilities(agent, mode, depth, registry)` (ADR-001) |
| **Work Docs** | `packages/core` + `apps/api` (Prisma) + `apps/api/routes` | **Phase 4 — implemented (validation pending)** | Durable versioned documents (`WorkDoc`/`WorkDocVersion`/`WorkDocRevision`/`WorkDocLink`), `expectedVersion` CAS updates, rollback → NEW version, audit source tagging, REST routes (ADR-002) |
| **Delegation** | `apps/api` (routes + BullMQ `workforce-delegation` worker) | **Phase 4 — implemented (validation pending)** | Sync + async delegation over the same REST chat endpoint; `Delegation` tracker rows with atomic `expectedFrom` single-claim + stale `running` recovery; server-signed depth context; depth cap 2 (ADR-004) |
| **Agent runtime** | `packages/core/runtime/` + agent composition | **Phase 4 — implemented (validation pending)** | Tools composed once per generation from the registry; transcript validation against the full action-set so plan/action switching stays valid; child chats route through the chat endpoint |
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

Each agent is defined by **which capability tools compose into its generation**. The registry carries Zod input/output schemas, descriptions, `readOnly` and approval metadata per tool; the pure `composeAgentCapabilities(agent, mode, depth, registry)` selects the actual tool instances **once per generation**. In **plan mode**, write and delegation tools are **never even attached** to the toolkit — so the model cannot accidentally call a write tool, even if the prompt went sideways. At delegation depth ≥ 2, `delegate_task` is likewise absent (ADR-001, ADR-004).

> Interview line: *"Read/write permissions are enforced when the agent is assembled, not when the model runs. Prompt injection can try, but there's no write tool in the tool list to hijack."*

### 2. Self-Hosted Tools (Agents Call Own API)

Tools inside the registry don't write through private paths (`write_doc`, `query_data`, `search_memory`, `delegate_task` call the existing Express REST routes — Work Docs, a read-only SQL pass, the Phase 3 memory API, and the chat endpoint itself) via an injectable fetch: production loopback URL, mocked fetch in offline tests. This means validation, ownership checks, idempotency, and error handling are written **once**, used by both humans and agents — and delegated child chats run over the **same chat endpoint with the same SSE/idempotency machinery** (ADR-002, ADR-004).

> Interview line: *"No shadow API. Agent tools go through the same middleware stack as the frontend. Means one auth model, one tenancy model, one validation library."*

### 3. Path-Addressed Memory Tree with Hybrid Search

Memory blocks live at **domain-neutral slash paths** like `research/small-language-models` (single-tenant `scope = default`; never brand paths). Each block has a **kind** (learning / correction / changelog / observation / decision / preference), a **confidence**, typed **relations** (`supports / supersedes / contradicts`), and a pgvector `vector(384)` embedding. Retrieval uses:

```
score = 0.8 * cosine_similarity + 0.2 * recency_decay
```

… with pgvector HNSW cosine for candidate recall, per-kind half-lives (`recency = 0.5^(ageDays / kindHalfLife)`), and async LLM-driven compaction when active blocks at an exact path exceed 30 (one summary block with `compactedFromIds`, sources retained but superseded). Flat memory dies around block 50; the tree design scales to thousands.

> Interview line: *"Memory is a tree, not a list. Each agent gets its own namespace; retrieval is hybrid — cosine for semantics, recency for staleness. Pruning is LLM-driven and half-life weighted."*

### 4. Depth-Capped Delegation — Sync + Async, Same REST Child Chats

Two ways for agents to offload work (ADR-004):

- **Sync** — call another agent's chat REST endpoint mid-loop and consume its UI SSE stream; block until the child's final answer arrives as tool output.
- **Async** — enqueue a job on the existing BullMQ/Redis infrastructure; a worker invokes the same child chat REST endpoint; status transitions live in tracked `Delegation` rows (`pending → running → completed/failed/timeout`) with a UI list/detail.

An orchestration-DAG mode (LLM-authored dependency plans fanned out by an executor) was sketched in early Phase 0 notes and is **explicitly not part of the Phase 4 design** — no DAG requirement; sync + async depth-capped delegation is the whole surface.

All delegation is **depth-capped at 2** (root=0, child=1; a depth-2 chat may still exist but composes **no** `delegate_task`, and any request implying depth ≥ 3 is rejected at the delegation REST layer). The cap is enforced at composition time — the `delegate_task` tool is absent from the toolkit at depth ≥ 2 — and depth travels **server-side only** (a short-TTL signed internal delegation context bound to the child chat id; the client body never carries depth). Self-targeting and invalid targets are rejected with fixed safe 400s.

> Interview line: *"Delegation is sync or async, both depth-capped. At depth 2 the delegation tool literally doesn't exist in the toolkit — that's composition-time enforcement, and the depth travels in a signed server-side context, not a client field. Child chats are the same REST chat endpoint our UI uses, so they're idempotent, resumable, and visible in the UI."*

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

AgentDefinition       (static config in code; Phase 4 design: slugs general | orchestrator | analyst | researcher)
  ├── slug
  ├── capabilities[]          (tool keys from the capability registry)
  ├── delegatableAgents[]     (orchestrator: analyst, researcher only)
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

WorkDoc                      (Phase 4 — built; see phase-4 doc)
  ├── scope                  (single-tenant: "default")
  ├── chatId                 (owning chat — same-scope/chat ownership enforced)
  ├── type                   (report / plan / analysis)
  ├── title / content
  ├── status                 (draft / active / archived)
  ├── version                (integer CAS counter — optimistic expectedVersion)
  ├── WorkDocVersion[]       (immutable snapshots)
  ├── WorkDocRevision[]      (audit: source agent|user, actorId?, from/to versions, summary)
  └── WorkDocLink[]          (typed: memory_block | chat | delegation)

Delegation                   (Phase 4 — built; see phase-4 doc)
  ├── parentChatId / childChatId (stable UUID) / parentMessageId
  ├── targetAgent            (analyst | researcher)
  ├── mode                   (sync | async)
  ├── status                 (pending → running → completed | failed | timeout)
  ├── result / error
  ├── depth                  (parent depth + 1; cap 2 — grandchild forbidden)
  └── createdAt / startedAt / completedAt
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
| Tool throws uncaught error | Error containment wrapper around the tool — loop continues with a safe tool error |
| Model calls write tool in plan mode | Tool absent from toolkit — model cannot even reference it |
| Memory grows unbounded | Async LLM compaction when active blocks at an exact path exceed 30 — oldest 30 → one summary block; sources retained, superseded (ADR-003) |
| Embedding job fails (model unavailable/invalid output) | Block stays `failed` and path-queryable; retry endpoint; failed never masquerades as ready |
| Postgres/pgvector unavailable | Memory operations return an explicit 503 — no silent writes, no fake readiness |
| Duplicate embed/compaction jobs | Deterministic job IDs + idempotent workers + per-path compaction duplicate protection |
| Delegation infinite recursion | Depth cap 2 enforced at capability composition — `delegate_task` absent at depth ≥ 2; trusted depth server-side only; requests implying depth ≥ 3 rejected (ADR-004) |
| Concurrent Work Doc edit | `expectedVersion` CAS — second write rejected (409), no lost update; rollback writes a new version, history never rewritten (integration-proven) |
| `query_data` write/multi-statement attempt | Read-only transaction (DB-level), single SELECT/WITH screening, statement timeout, row cap (integrated; demonstration, not a firewall) |
| Async delegation run twice (concurrent runners, worker retries) | Atomic `expectedFrom: 'pending'` single-claim → exactly one execution; stale `running` rows recover from the child transcript (per-process, no multi-process failover claim) |
| BullMQ worker crash mid-job | Job idempotency via deterministic ids + retry with backoff (memory queue; Phase 4 delegation uses the `expectedFrom` claim + stale-`running` recovery — per-process) |
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

- ADR-001: [Composition-time capability gating (not prompt-only)](./decisions/ADR-001-composition-gating.md) — **Accepted 2026-11-23**
- ADR-002: [Agents call own REST API (no shadow API, injectable fetch)](./decisions/ADR-002-same-rest-api.md) — **Accepted 2026-11-23**
- ADR-003: [Memory tree + relations + compaction over flat memory / graph DB](./decisions/ADR-003-memory-tree.md) — **Accepted 2026-11-19**
- ADR-004: [Depth cap at 2 (not 3) + same-REST child chats](./decisions/ADR-004-delegation-depth.md) — **Accepted 2026-11-23**
- ADR-005: [SSE + idempotency vs. WebSockets](./decisions/ADR-005-sse-idempotency.md) — **Accepted 2026-11-17**
- ADR-006: BullMQ over in-process cron — Phase 5, not written
- ADR-007: [pgvector + local MiniLM embeddings (dimension tradeoff, local cache/privacy/cost)](./decisions/ADR-007-pgvector.md) — **Accepted 2026-11-19**
- ADR-008: [AI SDK UI message streams vs. custom protocol](./decisions/ADR-008-ai-sdk-ui-streams.md) — **Accepted 2026-11-17**

---

## Interview narrative seed

When an interviewer opens this repo and asks *"talk me through it"*, the answer starts here:

> *"It's a multi-agent platform — a workforce, not a chatbot. Three things stand out.*
>
> *First, safety is compositional: whether an agent can write depends on which tools were composed into its generation, not on the prompt.*
>
> *Second, memory is hierarchical and hybrid — path-addressed, cosine-and-recency-scored, LLM-compacted.*
>
> *Third, delegation is depth-capped and tracked — agents offload sync or async-via-queue, child chats run over the same REST chat endpoint as the UI (idempotent, resumable, auditable), and depth never travels from the client.*
>
> *Around those, the usual production plumbing: idempotency keys, resumable streams, structured logging, queue-backed schedulers."*
