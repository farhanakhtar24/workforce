# Workforce — Architecture

Written during Phase 0 scaffold; extended as we build. This is the **single source of truth** for the system's shape — if code and this doc disagree, the doc wins until we update it.

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
         │ +pgvector│       │ (BullMQ) │       │ Providers│
         └────────┘         └──────────┘       └──────────┘
                                  │
                                  ▼
                          ┌──────────────┐
                          │  Cron Worker │
                          │  (separate)  │
                          └──────────────┘
```

---

## Module map

| Module | Where | Responsibility |
|---|---|---|
| **Agent runtime** | `packages/core/runtime/` | ToolLoopAgent assembly, stop conditions, step caps |
| **Capabilities** | `packages/core/capabilities/` | Tool adapters (sql, http_fetch, memory, work_doc, ask_user, scheduler) |
| **Memory** | `packages/core/memory/` | Path-addressed blocks, pgvector search, hybrid ranking, compaction |
| **Delegation** | `packages/core/delegation/` | Sync, async (via queue), orchestration DAG |
| **Scheduler** | `packages/queue/scheduler/` | BullMQ repeatable jobs, recurrence, execution records |
| **API routes** | `apps/api/routes/` | Threads, chat, memory, scheduler, artifacts |
| **Streaming** | `apps/api/streams/` | SSE, resumable streams, idempotency |
| **Web UI** | `apps/web/` | Chat panel, Work Doc, Memory browser, Delegation graph |

---

## The four flagship patterns (defense points for interviewers)

### 1. Tool Loop with Composition-Time Gating

Each agent is defined by **which capability adapters it loads**. An adapter lists its tools and marks some as `readOnlyTools: [...]`. In **plan mode**, a tool not in `readOnlyTools` is **never even attached** to the loop — so the model cannot accidentally call a write tool, even if the prompt went sideways.

> Interview line: *"Read/write permissions are enforced when the agent is assembled, not when the model runs. Prompt injection can try, but there's no write tool in the tool list to hijack."*

### 2. Self-Hosted Tools (Agents Call Own API)

Tools inside capability adapters don't touch the DB directly. They call `localFetch('/api/warehouse/...')` — the same HTTP endpoints the web UI uses. This means auth middleware, tenancy scoping, and validation logic are written **once**, used by both human users and agents.

> Interview line: *"No shadow API. Agent tools go through the same middleware stack as the frontend. Means one auth model, one tenancy model, one validation library."*

### 3. Path-Addressed Memory Tree with Hybrid Search

Memory blocks live at paths like `brands/{id}/sales/insights`. Each block has a **kind** (learning / correction / decision / observation), a **confidence**, and a pgvector embedding. Retrieval uses:

```
score = 0.8 * cosine_similarity + 0.2 * recency_decay
```

… plus per-kind half-lives and LLM-driven compaction when a path exceeds 30 blocks. Flat memory dies around block 50; the tree design scales to thousands.

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

> Will evolve; this is the Phase 0 sketch.

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
  ├── path                    (brands/{id}/... etc.)
  ├── kind                    (learning / correction / observation / ...)
  ├── content                 (text, ≤1000 chars)
  ├── confidence              (0..1)
  ├── accessCount             (for relevance)
  ├── embedding               (vector(1536))
  └── relations[]             (supersedes / supports / contradicts)

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

## Streaming shape

Two SSE surfaces:

1. **Chat stream** (`POST /api/agents/:slug/chat`) — AI SDK UI message stream (token deltas, tool calls, reasoning). **Resumable** via `resumable-stream` + Redis checkpoint. Resume endpoint: `GET /api/agents/:slug/chat/:clientChatId/stream`.

2. **Thread state stream** (`GET /api/threads/:id/stream`) — JSON snapshot/delta of artifacts + approval states. Polls every 2s, emits delta when signature changes.

Idempotency on chat POSTs via `Idempotency-Key` header → Redis `SET ... NX EX 900` → 409 on duplicate. Graceful no-op if Redis is down.

---

## Failure modes we've designed for

| Mode | Defense |
|---|---|
| Duplicate chat send (double-submit) | Idempotency-Key + Redis NX |
| Mid-stream client disconnect | Resumable stream + checkpoint replay |
| Tool throws uncaught error | Error containment wrapper in adapter — loop continues |
| Model calls write tool in plan mode | Tool absent from toolkit — model cannot even reference it |
| Memory grows unbounded | LLM compaction trigger at 30 blocks/path |
| Delegation infinite recursion | Depth cap, enforced at adapter composition |
| BullMQ worker crash mid-job | Job idempotency via Redis lock + retry with backoff |
| Redis unavailable | Idempotency + resume degrade gracefully to no-op |

---

## Non-goals (and why)

- **Multi-brand tenancy for v1** — single-tenant demo for portfolio. The patterns scale, but we don't need that complexity.
- **Voice / audio** — great Helium feature, not needed for Workforce.
- **MCP server exposure** — nice-to-have, stretch goal only.
- **Shopify / ecom integrations** — domain-agnostic demo.
- **Fine-tuning** — foundation models only, prompt + tools is enough here.

---

## ADRs (so far, written as we go)

> See [`/docs/decisions/`](./decisions/) for the full list. Planned:

- ADR-001: Composition-time read/write gating (not runtime)
- ADR-002: Agents call own REST API (no shadow API, no direct DB from tools)
- ADR-003: Memory tree over flat memory
- ADR-004: Depth cap at 2 (not 3)
- ADR-005: SSE + idempotency vs. WebSockets
- ADR-006: BullMQ over in-process cron
- ADR-007: pgvector over Pinecone (cost + simplicity)
- ADR-008: AI SDK UI message streams vs. custom protocol

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
