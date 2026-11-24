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

**Status (started 2026-11-19, closed 2026-11-23)**: ✅ **Validated.** Phase 2 closed 2026-11-19 and Farhan said "next"; this phase started the same day. The design is fixed (not open for re-litigation) and recorded in [ADR-003](./docs/decisions/ADR-003-memory-tree.md) (memory tree + relations + compaction) and [ADR-007](./docs/decisions/ADR-007-pgvector.md) (pgvector + local MiniLM embeddings), both accepted 2026-11-19. Implementation is in place: the memory domain + Prisma/pgvector adapter + migrations in `packages/core`, the memory REST routes + local Transformers.js embeddings + Ollama compactor + BullMQ worker in `apps/api`, the `/memory` page in `apps/web`, and docker-compose Postgres/pgvector alongside Redis — **374 green offline tests** (core 137, CLI 30, API 162, web 45). Real-stack validation: real Postgres/pgvector+BullMQ integration **14/14**, real local-MiniLM embedding smoke **5/5** — and the closing live demo on **2026-11-23** with Farhan's REAL Ollama key: the `reasoningEffort: 'low'` compactor succeeded (one ready `learning` summary; the 30 observation sources retained and superseded) and the `/memory` page showed the READY summary plus the superseded observations. Farhan confirmed the live flow and approved progression ("yes, next phase") on **2026-11-23**. The topic self-assessment remained **waived** (never completed; not claimed by this phase). Details: [phase doc](./docs/phases/phase-3-memory.md).

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
- REST routes in `apps/api` + the `/memory` page in `apps/web` (built — validated 2026-11-23)

**Validation**: I read you 20 test memories; you run queries against them — and explain *why* a specific result ranked higher (the 0.8/0.2 score + tie-breaks). Plus the live gate in the [phase doc](./docs/phases/phase-3-memory.md): write pending→ready, API restart survives, relevant semantic result, correction supersedes, relations explorable, >30 compaction produces a summary with sources retained, embedding/Postgres failures explicit. ✅ Closed 2026-11-23 — real Ollama compaction verified live, browser evidence recorded, and Farhan explicitly approved.

📄 Phase doc: [`docs/phases/phase-3-memory.md`](./docs/phases/phase-3-memory.md)

---

## Phase 4 — Multi-Agent Systems (1-2 weeks)

**Status (closed 2026-11-23)**: ✅ **Validated.** Phase 3 validated 2026-11-23 and Farhan said "yes, next phase". Design fixed in [ADR-001](./docs/decisions/ADR-001-composition-gating.md) (composition-time gating), [ADR-002](./docs/decisions/ADR-002-same-rest-api.md) (agents call own REST) and [ADR-004](./docs/decisions/ADR-004-delegation-depth.md) (depth cap 2 + same-REST child chats), all accepted 2026-11-23. Implementation is in place across core/API/web: **593 green offline tests** (core 203, CLI 30, API 256, web 104; root typecheck + production-build checks pass; the consolidated root test run executes separately), and the root `test:integration` suite runs **23 real-infrastructure tests — 11 memory + 3 Phase 2 Redis streaming + 9 Phase 4** — passed twice with exact cleanup (Prisma WorkDoc CAS/rollback/links, sync same-REST delegation, real BullMQ async with atomic single-claim, real Redis `ask_user` byte-CAS, read-only `query_data` guardrails; models mocked, no Ollama). On **2026-11-23 the live browser gate was passed by the orchestrator** on Farhan's already-running real-provider servers via saved env (no key inspected or printed; real Ollama calls through the browser): plan mode held, sync + async delegation completed, `write_doc` created, HITL answered, analyst SQL and researcher memory search clean — full record in the [phase doc](./docs/phases/phase-4-multi-agent.md). **Farhan explicitly approved the live gate on 2026-11-23 ("yes next phase pls") — Phase 4 is validated.**

**Goal**: Orchestrator that delegates safely — sync and async — without runaway recursion.

**Topics**:
- 4.1 What makes something an "agent" (loop + tools + memory + stop conditions)
- 4.2 Capability registry + composition-time tool selection (pure `composeAgentCapabilities`)
- 4.3 Plan vs. Action mode (write/delegation tools omitted from the toolkit — not prompt-only)
- 4.4 Delegation patterns (sync, async via the existing BullMQ/Redis — no DAG in this phase)
- 4.5 Depth capping (why 2; enforced at composition; trusted depth server-side only)
- 4.6 HITL (execute-less `ask_user` as a loop-level stop; resume on the next user message)
- 4.7 Multi-agent anti-patterns (manager-does-everything, ping-pong, shared mutable memory)

**Build artifact** (implemented — validated 2026-11-23): Four agents under `packages/core/agents/` — `general` unchanged (calculate only, fully backward compatible) plus **Orchestrator**, **Analyst**, **Researcher** — with:
- Capability registry (Zod schemas, descriptions, readOnly/approval metadata) + pure `composeAgentCapabilities(agent, mode, depth, registry)` composed once per generation
- Plan/Action mode on the orchestrator (plan omits `write_doc` and `delegate_task` entirely); workers are action-only with no write/delegate tools
- Durable Work Docs (Postgres/Prisma): immutable versions, audit revisions, typed links, `expectedVersion` CAS updates and safe rollback over REST
- Delegation to analyst/researcher: sync (same chat REST endpoint, consumed SSE) and async (existing BullMQ/Redis, deterministic IDs, tracked statuses); **depth cap 2**, server-signed depth context, no shadow child runner
- Tools: `calculate` (unchanged), `write_doc`, `delegate_task`, `query_data` (read-only, capped SQL), `search_memory` (reuses the Phase 3 Memory API), `ask_user` (no execute — HITL)
- Web: agent picker, `/chat/:chatId` URLs, Work Docs page with revisions/links/rollback, delegation list/detail, generic tool-part rendering — existing styles, no redesign
- **No Postgres scheduling (Phase 5), no DAG requirement, no extra phases pulled forward**

**Validation**: Automated suites green (tool omission matrix, forbidden delegation, sync/async success/failure/timeout/idempotency, Work Doc CAS/rollback/versions/revisions/links over real Prisma, SQL guardrails over real Postgres, real Redis `ask_user` stop+resume, Phase 2 regression — see the [phase doc](./docs/phases/phase-4-multi-agent.md) for the recorded evidence and the review fixes). The **live browser gate was recorded as passed by the orchestrator on 2026-11-23** (full evidence + artifact URLs in the [phase doc](./docs/phases/phase-4-multi-agent.md)), and **Farhan explicitly approved it the same day ("yes next phase pls")** — **Phase 4 validated and closed 2026-11-23.**

📄 Phase doc: [`docs/phases/phase-4-multi-agent.md`](./docs/phases/phase-4-multi-agent.md)

---

## Phase 5 — Queues & Schedulers (1 week)

**Status (opened 2026-11-23; updated 2026-11-24)**: 🚧 **Active — implemented and integration-tested; live real-provider browser gate PASSED 2026-11-24 by the orchestrator; awaiting Farhan's explicit approval; NOT validated.** Phase 4 validated and Farhan approved progression ("yes next phase pls") on 2026-11-23. Design fixed in [ADR-006](./docs/decisions/ADR-006-bullmq-scheduler.md) (BullMQ Job Schedulers over in-process cron — accepted 2026-11-23); recorded design in the [phase doc](./docs/phases/phase-5-queues.md). Implementation is in place across `packages/core`, the new `packages/queue` workspace, `apps/api` and `apps/web`: **757 green offline tests** (core 243, @workforce/queue 47, CLI 30, API 299, web 138; root typecheck passes) and the real-infrastructure suite at **34/34 with 0 skips** (23 previous + 11 scheduler) — green five consecutive times after the initial fixes and twice more after the `nextRunAt` fix. The **live real-provider browser gate PASSED on 2026-11-24** (API + web + the standalone scheduler worker via saved env; no key inspected or printed): manual **Run now** → `MANUAL COMPLETED` attempt 1 (1237 ms; isolated chat answered 42 via one `calculate`; `tokenUsage: null` — provider omitted usage); the scheduled **`ONCE`** task fired **without Run now** → `SCHEDULED COMPLETED` attempt 1 (687 ms, `queueJobId once-2ddc…`) with the dashboard Next run showing `— (none pending)` (`nextRunAt` cleared); the **`CUSTOM_CRON`** `* * * * *` task fired through real BullMQ → `SCHEDULED COMPLETED` attempt 1 (798 ms, library repeat id/`repeatJobKey` persisted) with `nextRunAt` advanced to 00:04 UTC and the task paused before a second run. All three tasks were left PAUSED after success (artifacts kept for the walkthrough); no fresh real-provider DLQ was induced in the browser — DLQ/retry evidence stays with the integration suite (mocked models). **Explicit Farhan approval still required — the phase is not validated.**

**Goal**: Agents that run while you sleep.

**Topics**:
- 5.1 Why queues exist (sync vs. async, HTTP timeouts)
- 5.2 BullMQ fundamentals (producers, workers, retries, backoff)
- 5.3 BullMQ Job Schedulers (`upsertJobScheduler` templates, UTC patterns, library-owned repeat job ids — not the legacy repeatable-jobs option)
- 5.4 Two-process topology (API vs. scheduler worker — why separate)
- 5.5 Job idempotency (unique execution rows + atomic claims, not just Redis locks)
- 5.6 Dead Letter Queue (when retries exhaust — status rows + retained failed jobs, no second queue)

**Build artifact** (implemented — integration-tested; live browser gate PASSED 2026-11-24, approval pending):
- Domain + persistence in `packages/core/scheduler` (Prisma adapter + migration): `AgentTask` (`ONCE | DAILY | WEEKLY | MONTHLY | CUSTOM_CRON`, per-type `recurrenceConfig` shapes, `skipDates` `YYYY-MM-DD[]`, `isActive`, UTC-only) + `AgentTaskExecution` audit (`PENDING → RUNNING/RETRYING → COMPLETED/FAILED/DEAD_LETTER` plus `SKIPPED`, attempts 3, `durationMs`, nullable `tokenUsage`, unique isolated `chatId = execution.id` per run); recurrence validation/next-run/skip-date computation via **croner**.
- NEW `packages/queue/scheduler` workspace (`@workforce/queue`, suite of 47 offline tests): the BullMQ `workforce-scheduler` queue — `upsertJobScheduler(task.id, { pattern, tz: 'UTC' }, template)` for recurring tasks (repeat job ids library-owned), colon-free deterministic `once-<taskId>` job id + delay for `ONCE`, `execution-<uuid>` job ids for manual/retry runs; existing memory/delegation queues did not move.
- REST routes in `apps/api/src/scheduler` (`/api/scheduler`), the `/schedules` dashboard in `apps/web`, and the separate `apps/api/src/scheduler-worker.ts` worker process owning only the scheduler worker and calling the API's own REST (Redis + internal API URL only — no provider key); root `npm run dev` runs `concurrently api + web + scheduler` (`npm run dev:scheduler` for the worker alone).
- Idempotency & resilience (integration-proven): unique scheduled execution per `task + scheduledFor` (trigger `SCHEDULED`), atomic `PENDING/RETRYING → RUNNING` claim (one runner), retries (success 3, exponential backoff) → exhausted → `DEAD_LETTER` (DLQ view = dead-letter rows + retained BullMQ failed jobs, `removeOnFail: false`, no second queue), no catch-up/backfill, startup scheduler reconcile (documented bound: first 100 active tasks), duplicate child POST 409 recovered via durable hydration + resume stream — never a second generation; a real scheduler-child SIGKILL → stall → restart → resume completed on attempt 1 with exactly one model generation.

**Validation**: Automated suites green — **757 offline** (core 243, @workforce/queue 47, CLI 30, API 299, web 138), root typecheck passes, and the real-infrastructure suite **34/34 with 0 skips** (11 scheduler tests over real Redis/Postgres/BullMQ: concurrent duplicate occurrence → one row; retries → exhausted `DEAD_LETTER`; skip-dates/pause → `SKIPPED` without provider; manual run/retry → new linked executions; scheduler child killed mid-job → stall → restart → resume, completed on attempt 1 with no double generation) — the recorded history is in the [phase doc](./docs/phases/phase-5-queues.md). The **live browser gate PASSED on 2026-11-24** by the orchestrator (full record in the [phase doc](./docs/phases/phase-5-queues.md)), including the cron-scenario check: the **`CUSTOM_CRON`** task `0c0c7bde-dfd3-4e78-9900-d4c54e17840a` (`* * * * *`) execution `e08ba72f-20ca-4f45-b2e9-244d31d19f6e` **SCHEDULED COMPLETED** attempt 1 (`RECURRING RUN OK`, `nextRunAt` advanced to 00:04 UTC, paused before a second run). A **same-day rerun** (orchestrator, saved env, stack restarted) re-confirmed idempotent manual re-running: **Run now** clicked once on the paused manual task → **exactly one** new execution `374f115b-3eb0-492b-aa70-49ce7f39a057` (**MANUAL COMPLETED**, attempt 1/3, 1336 ms at 10:09 UTC; history 3→4, no duplicates) with the isolated chat running `calculate` once → `(18 * 2) + 6 = 42`, the task + `COMPLETED` filters showing exactly the two manual runs (1336 ms and 1237 ms), and a mobile **390×844** screenshot check; counts unchanged (**757 offline / 34 integration** — the rerun is not a suite run). Remaining for the gate: **only Farhan's explicit approval** — **Phase 5 remains incomplete until Farhan explicitly approves.**

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
