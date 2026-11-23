# Workforce — Roadmap

Eight weeks part-time to a deployable multi-agent platform. This file is the single source of truth for **what we're building and when**. Each phase has its own detailed doc in [`docs/phases/`](./docs/phases/).

---

## Phase flow (applies to every phase)

1. **Topic listing** — 5-7 numbered topics for the phase.
2. **Self-assessment** — you rate 🟢 / 🟡 / 🔴 in the phase doc.
3. **Targeted learning** — based on ratings; you don't relearn what you know.
4. **Build the artifact** — code that extends the shared codebase.
5. **Validation gate** — mixed format (quiz / explain-back / demo+probe). Pass to continue.

**Rule**: No phase begins until the previous phase's validation gate is passed.

---

## Phase 0 — Scaffolding (1 day)

**Goal**: A clean repo with every folder in place. No code yet.

**Topics**: none — pure mechanics.

**Deliverables**:
- All folders from [`README.md`](./README.md#repo-layout) created
- Base configs: `tsconfig.json`, `.gitignore`, `.nvmrc`, `package.json` (workspace root)
- Docs structure: `docs/architecture.md`, `docs/decisions/`, `docs/phases/`, `docs/learning/`

**Validation**: I run `ls` and see the scaffold. Done.

📄 Phase doc: [`docs/phases/phase-0-scaffolding.md`](./docs/phases/phase-0-scaffolding.md)

---

## Phase 1 — LLM Core (1-2 weeks)

**Status (2026-11-17)**: ✅ **Validated.** Live demo passed ("Hello" → no tool; `(12+8)*3` → `calculate` → 60; "Add 7 to that result" → history resent → 67), 56/56 offline tests, root typecheck, CLI build, missing-key and EOF probes. Farhan waived self-assessment/whiteboard and explicitly approved progression ("Yes next phase"). Details: [phase doc](./docs/phases/phase-1-llm-core.md).

**Goal**: Understand the agent loop deeply enough to explain it to a stranger, and implement it.

**Topics**:
- 1.1 What an LLM actually is (tokens, context, temperature)
- 1.2 Prompt engineering (system / user / developer messages, CoT, few-shot)
- 1.3 Tool calling / Function calling (JSON schema contract, tool result feedback)
- 1.4 Structured output (Zod-to-JSON-schema, parsing)
- 1.5 Tokens & cost (input vs. output, counting with tiktoken)
- 1.6 The agent loop (Observe → Think → Act → Observe)
- 1.7 Multi-turn conversation state (history format, summarization)

**Build artifact**: `apps/cli/` — a CLI agent with **one tool**. Maintains conversation history. Runs the full loop: model decides to call tool → exec → feed result back → model continues.

**Validation**: You demo it live. I ask "what if the tool returns an error?" and "what if the model calls the tool twice in a row?" — you defend the behavior.

📄 Phase doc: [`docs/phases/phase-1-llm-core.md`](./docs/phases/phase-1-llm-core.md)

---

## Phase 2 — Streaming & Real-Time UX (1 week)

**Status (2026-11-19)**: ✅ **Validated.** Started 2026-11-17. 156/156 offline tests (core 31, CLI 30, API 74, web 21), 3/3 real Redis integration tests, root typecheck, full build, desktop/mobile accessibility smoke; Farhan confirmed the live Phase 2 web flow is working on 2026-11-19. Design: [phase doc](./docs/phases/phase-2-streaming.md), [ADR-005](./docs/decisions/ADR-005-sse-idempotency.md), [ADR-008](./docs/decisions/ADR-008-ai-sdk-ui-streams.md). Details: [phase doc](./docs/phases/phase-2-streaming.md).

**Goal**: Production-grade streaming with resumability + idempotency.

**Topics**:
- 2.1 Server-Sent Events (SSE) — when, how, wire format
- 2.2 Streaming LLM responses (chunks, deltas)
- 2.3 Vercel AI SDK basics (`useChat`, `streamText`, UI message streams)
- 2.4 Resumable streams (resumable-stream's Redis relay, process-local replay buffers, why streams break)
- 2.5 Idempotency-Key header pattern
- 2.6 Error handling mid-stream (abort signals, partial saves)

**Build artifact**: Extend the CLI into `apps/api/` with a streaming HTTP endpoint, and add a very basic `apps/web/` page that consumes it with `useChat`.

**Validation**: I kill the connection mid-stream. You resume from where it left off without duplicated tokens.

📄 Phase doc: [`docs/phases/phase-2-streaming.md`](./docs/phases/phase-2-streaming.md)

---

## Phase 3 — Memory, Embeddings, Hybrid Search (1-2 weeks)

**Status (2026-11-19, last updated 2026-11-19)**: 🚧 **Active — implementation complete, automated + real-service validation green, live gate pending.** Phase 2 closed 2026-11-19 and Farhan said "next"; this phase started the same day. The design is fixed (not open for re-litigation) and recorded in [ADR-003](./docs/decisions/ADR-003-memory-tree.md) (memory tree + relations + compaction) and [ADR-007](./docs/decisions/ADR-007-pgvector.md) (pgvector + local MiniLM embeddings), both accepted 2026-11-19. Implementation is in place: the memory domain + Prisma/pgvector adapter + migrations in `packages/core`, the memory REST routes + local Transformers.js embeddings + Ollama compactor + BullMQ worker in `apps/api`, the `/memory` page in `apps/web`, and docker-compose Postgres/pgvector alongside Redis — **339 green offline tests** (core 131, CLI 30, API 133, web 45). Automated real-stack validation: real Postgres/pgvector+BullMQ integration **14/14 twice** (`npm run test:integration`), real local-MiniLM embedding smoke **5/5 twice** (`npm run test:embedding`; real model download cached project-locally), plus a real-service browser smoke with a **dummy** key (create pending→ready, semantic search cosine 0.557 / recency 1.0 / score 0.646, correction supersession + outgoing related display, desktop/mobile accessibility with zero missing names) and the `npm run demo:memory` seeder for the live walkthrough. **Not completed**: the real Ollama compaction call (dummy key could not exercise it) and Farhan's live-gate approval — the phase is incomplete until Farhan explicitly approves.

**Goal**: Memory that survives past 50 entries — hierarchical, vector-searchable, compactable.

**Topics**:
- 3.1 What embeddings actually are (vectors, cosine similarity)
- 3.2 Embedding models & providers (local Transformers.js/MiniLM vs hosted; dimensionality tradeoff)
- 3.3 Vector databases (pgvector vs. Pinecone vs. Milvus — pgvector chosen, ADR-007)
- 3.4 Hybrid search (semantic + keyword + recency fusion)
- 3.5 RAG pattern (chunking, retrieval, prompt augmentation)
- 3.6 Memory architectures (flat vs. tree vs. graph — collapse of flat at scale)
- 3.7 Pruning & compaction (LLM-driven summarization, half-lives)

**Build artifact**: Memory system in `packages/core/memory/` with:
- Domain-neutral path-addressed blocks (`research/small-language-models`, …), single-tenant `scope = default`
- Postgres + Prisma 6.19.3 + pgvector, `vector(384)`, HNSW cosine candidate index
- Hybrid retrieval: `0.8 × cosine + 0.2 × recency decay` with per-kind half-lives
- `writeBlock`, `queryBlocks` (path/kind/keyword), `semanticSearch`, `exploreRelated`
- BullMQ `workforce-memory` queue on the existing Redis (embedding + compaction jobs)
- LLM compaction when active blocks at an exact path exceed 30 (sources retained, superseded)
- Local infra: docker-compose Postgres/pgvector (`pgvector/pgvector:pg16`, host port `127.0.0.1:55432`) + `npm run dev:infra` / `npm run db:migrate`; `DATABASE_URL` defaults to the local dev stack (`postgresql://workforce:workforce@127.0.0.1:55432/workforce`) — Phase 6 deployment must set an explicit secret URL
- REST routes in `apps/api` + the `/memory` page in `apps/web` (built — validation pending)

**Validation**: I read you 20 test memories; you run queries against them — and explain *why* a specific result ranked higher (the 0.8/0.2 score + tie-breaks). Plus the live gate in the [phase doc](./docs/phases/phase-3-memory.md): write pending→ready, API restart survives, relevant semantic result, correction supersedes, relations explorable, >30 compaction produces a summary with sources retained, embedding/Postgres failures explicit. **Not complete until Farhan explicitly approves.**

📄 Phase doc: [`docs/phases/phase-3-memory.md`](./docs/phases/phase-3-memory.md)

---

## Phase 4 — Multi-Agent Systems (1-2 weeks)

**Status (2026-11-19)**: ⬜ **Not started.**

**Goal**: Orchestrator that delegates safely — sync and async — without runaway recursion.

**Topics**:
- 4.1 What makes something an "agent" (loop + tools + memory + stop conditions)
- 4.2 Capability adapter contract (readOnlyTools, approvalPolicy)
- 4.3 Plan vs. Action mode (composition-time gating)
- 4.4 Delegation patterns (sync, async via queue, orchestration DAG)
- 4.5 Depth capping (why you cap at 2 or 3)
- 4.6 Human-in-the-loop (HITL) as a loop-level stop
- 4.7 Multi-agent anti-patterns (manager-does-everything, ping-pong, shared mutable memory)

**Build artifact**: Three agents — Orchestrator, Analyst, Researcher — with:
- Orchestrator *cannot* run SQL (capability gating)
- Analyst *cannot* delegate (delegatableAgents = [])
- Sync delegation for "do this now"
- Async delegation via BullMQ + tracker artifact
- Approval policy on write tools
- Depth cap = 2

**Validation**: Whiteboard session. I describe a task, you sketch the delegation tree, marking sync vs. async edges, and justify depth-cap placement.

📄 Phase doc: [`docs/phases/phase-4-multi-agent.md`](./docs/phases/phase-4-multi-agent.md)

---

## Phase 5 — Queues & Schedulers (1 week)

**Goal**: Agents that run while you sleep.

**Topics**:
- 5.1 Why queues exist (sync vs. async, HTTP timeouts)
- 5.2 BullMQ fundamentals (producers, workers, retries, backoff)
- 5.3 Repeatable jobs (cron expressions, timezone, skip dates)
- 5.4 Two-process topology (API vs. cron worker — why separate)
- 5.5 Job idempotency
- 5.6 Dead Letter Queue (when retries exhaust)

**Build artifact**: Task scheduler in `packages/queue/scheduler/` with:
- `ONCE | DAILY | WEEKLY | MONTHLY | CUSTOM_CRON` recurrence types
- `skipDates`, `isActive`
- BullMQ repeatable jobs
- AgentTaskExecution record per run (status, durationMs, tokenUsage)

**Validation**: I break the scheduler (kill a worker mid-job). You debug. Then you write a NEW cron expression from scratch for a scenario I give you.

📄 Phase doc: [`docs/phases/phase-5-queues.md`](./docs/phases/phase-5-queues.md)

---

## Phase 6 — Docker, Deploy, Observability (1 week)

**Goal**: Live URL. Not localhost.

**Topics**:
- 6.1 Docker Compose basics (services, volumes, networks)
- 6.2 Structured logging (pino, JSON logs, correlation IDs)
- 6.3 OpenTelemetry concepts (spans, traces, context propagation)
- 6.4 Deployment targets (Railway / Render / Fly.io + Neon + Upstash)
- 6.5 12-factor app (env config, secrets)

**Build artifact**: `docker-compose.yml` that brings up `api + postgres + redis + web`. Then deploy to Railway/Render with a public URL.

**Validation**: I click the URL, chat with an agent, schedule a task. It works.

📄 Phase doc: [`docs/phases/phase-6-deploy.md`](./docs/phases/phase-6-deploy.md)

---

## Final deliverable

By end of Phase 6:
- Live Workforce URL
- Recorded demo video (~3 minutes)
- 8 ADRs (Architecture Decision Records) in [`docs/decisions/`](./docs/decisions/)
- Clean, commented, hire-me-grade README
- Interview-ready talking points (extracted into a separate doc later)

---

## Timeline risk factors

If you're 🔴 (never touched) on a whole phase's topics, add **+1 week** to that phase's estimate. No shame in this — the point is to actually learn, not to bluff the calendar.

| Phase | Base estimate | If fully 🔴 |
|---|---|---|
| 0 | 1 day | 1 day |
| 1 | 1-2 weeks | 2.5 weeks |
| 2 | 1 week | 1.5 weeks |
| 3 | 1-2 weeks | 2.5 weeks |
| 4 | 1-2 weeks | 2.5 weeks |
| 5 | 1 week | 1.5 weeks |
| 6 | 1 week | 1.5 weeks |
| **Total** | **~8 weeks** | **~12 weeks** |

At 10h/week, plan for the longer estimate. At 15h+/week, the tighter one is realistic.
