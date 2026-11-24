# Phase 4 — Multi-Agent Systems

**Duration**: 1-2 weeks
**Goal**: A team of agents that delegate to each other safely — sync and async — without runaway recursion, with a real Work Doc artifact and human-in-the-loop (HITL) questions.

> **Status: ✅ Validated 2026-11-23.** Phase 3 validated on 2026-11-23 and Farhan said "yes, next phase". The design below is fixed (not open for re-litigation) and recorded as decisions in [ADR-001](../decisions/ADR-001-composition-gating.md) (composition-time gating, not prompt-only), [ADR-002](../decisions/ADR-002-same-rest-api.md) (tools through the own REST API via injectable fetch) and [ADR-004](../decisions/ADR-004-delegation-depth.md) (depth cap 2 + same-REST child chats), all accepted 2026-11-23. Everything below is **implemented** across `packages/core`, `apps/api` and `apps/web`: **593 green offline tests** (core 203, CLI 30, API 256, web 104), root typecheck + production-build checks pass (the consolidated root test run executes separately), and the real-infrastructure suite (`npm run test:integration`) covers **23 tests — 11 memory + 3 Phase 2 Redis streaming + 9 Phase 4** — passed twice with exact per-run cleanup. The **live browser gate ran on 2026-11-23** on Farhan's already-running real-provider servers via saved env (no key inspected or printed; real Ollama calls occurred through the browser) — see the validation record below. **Farhan explicitly approved the live gate on 2026-11-23 ("yes next phase pls") — the phase is validated**; recovery claims remain per API process (no multi-process failover claim).

---

## What gets built in this phase

All built — implemented, integration-tested, and **validated (2026-11-23)**. Four agent slugs under `packages/core/agents/`. The existing slug `general` stays exactly as it is (full backward compatibility):

| Slug | Role | Can query data? | Can search memory? | Can write Work Docs? | Can delegate? | Tools |
|---|---|---|---|---|---|---|
| `general` | Phase 1-2 chat agent — **unchanged** | ❌ | ❌ | ❌ | ❌ | `calculate` only |
| `orchestrator` | Coordinates, delegates, writes documents | ✅ | ✅ | ✅ | ✅ (to analyst/researcher, depth-capped) | `calculate`, `query_data`, `search_memory`, `write_doc`, `delegate_task`, `ask_user` |
| `analyst` | Answers data questions with SQL | ✅ | ✅ | ❌ | ❌ | `calculate`, `query_data`, `search_memory`, `ask_user` |
| `researcher` | Answers research questions from memory | ❌ | ✅ | ❌ | ❌ | `calculate`, `search_memory`, `ask_user` |

Plus:

- **Capability registry** — every tool entry carries Zod input/output schemas, description, `readOnly` and approval metadata; a **pure** `composeAgentCapabilities(agent, mode, depth, registry)` selects the actual tool instances **once per generation** (ADR-001).
- **Plan vs. Action mode** — plan mode omits write and delegation tools entirely from the toolkit (not prompt-only); orchestrator defaults to action, may request plan.
- **Work Docs** — durable Postgres/Prisma documents with immutable versions, an audit revision trail, typed links, and optimistic-concurrency (CAS) updates. No filesystem artifact store.
- **Delegation** — sync (blocks mid-loop) and async (BullMQ job) to `analyst`/`researcher`, both **depth-capped at 2**; child chats run over the **same REST chat endpoint** as humans use; tracked `Delegation` rows with statuses. No DAG orchestration, no shadow child runner.
- **HITL** — `ask_user` ends the model turn with a persisted, answerable question; the next user response resumes the same chat.
- **Web** — agent picker, agent-scoped chat URLs, Work Docs pages (`/work` + `/work/[id]`), delegation panel (`/delegations`), generic tool-part rendering. No redesign; existing styles only. (Next.js now serves **8 routes**, including agent-scoped chat, `/work`, `/work/[id]`, `/delegations` and `/memory`.)

Explicitly **not** in this phase: no Postgres scheduling (Phase 5), no DAG requirement, no extra phases pulled forward (no auth, no deployment, no tenancy), no Shopify/domain-specific tools, no hosted embedding key (local MiniLM + the existing Memory API are reused).

---

## Topics to self-assess

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 4.1 | What makes something an "agent" | _ | |
| 4.2 | Capability registry + composition-time tool selection | _ | |
| 4.3 | Plan vs. Action mode (tools absent, not suppressed) | _ | |
| 4.4 | Delegation patterns (sync / async via queue — no DAG) | _ | |
| 4.5 | Depth capping — why 2, where enforced, how tested | _ | |
| 4.6 | HITL — execute-less tool as loop-level stop; resume semantics | _ | |
| 4.7 | Multi-agent anti-patterns (manager-does-everything, ping-pong, shared mutable memory) | _ | |

---

## Fixed design

### Agent roster & backward compatibility

- `general` keeps its current behavior: system prompt unchanged, exactly **one tool (`calculate`)**, and existing `{id, message}` chat requests remain valid. Any Phase 2 regression counts as a Phase 4 failure.
- New agents live in `packages/core/agents/` as declarative definitions (slug, role, system prompt template, capability keys, delegation targets). No agent code bypasses the registry.
- Local MiniLM embeddings and the existing Phase 3 Memory REST API are reused as-is. **No hosted embedding key enters Phase 4.**

### Capability registry & composition (ADR-001)

- One registry: each entry has `name`, Zod `inputSchema`/`outputSchema`, `description`, `readOnly: boolean`, and approval metadata. `ask_user` is registered like any tool but with **no execute function** (HITL marker).
- `composeAgentCapabilities(agent, mode, depth, registry)` is a **pure function**: given the agent definition, requested mode, resolved depth and the registry, it returns the exact tool instance set for **this generation** — composed once, before `streamText` starts. Re-composition per generation is deliberate; mid-turn tool escalation does not exist.
- **Plan mode omits write/delegation tools entirely** (`write_doc`, `delegate_task` absent from the toolkit). **Action mode adds only permitted writes**. Workers (`analyst`, `researcher`) always run action but their toolsets contain no write or delegation tools anyway.
- **Delegation tool omitted at `depth >= 2`.** Root = depth 0, child = depth 1. A depth-2 grandchild chat **may exist as a real chat** (persisted, same REST contract) but composes **no** `delegate_task` — it cannot delegate further — and any request that would create a depth ≥ 3 child is rejected at the delegation REST layer (`403`).
- Prompt instructions are **secondary**. Enforcement is the tool list: a tool that is not composed cannot be called by the model — there is nothing to hijack.

### Modes & chat request changes

- `POST /api/agents/:slug/chat` accepts an optional `mode: 'plan' | 'action'` in the body. Default: `action` for orchestrator; workers are always action. Existing `{id, message}` requests keep working (no mode → action; `general` ignores the field entirely).
- The web app may expose a Plan/Action switch **for the orchestrator only**.
- The route now resolves **tools and system prompt by slug + mode + depth**. Slug determines the agent; depth comes only from a server-side delegation context (below) — never from a client body field.

### Tool inventory

Exactly **one shared deterministic local primitive remains: `calculate`** (as in Phases 1-2). New tools:

| Tool | Input (Zod-verified) | Behavior | Agents |
|---|---|---|---|
| `write_doc` | create `{type, title, content}` / update `{docId, expectedVersion, content, title?}` / rollback `{docId, expectedVersion, toVersion}` | Calls Work Docs REST (ADR-002) with optimistic CAS. Orchestrator only. | orchestrator |
| `delegate_task` | `{targetAgent: 'analyst' \| 'researcher', task, mode: 'sync' \| 'async'}` | Sync: blocking child chat over REST. Async: BullMQ job + tracker. Orchestrator only; absent at `depth >= 2`. | orchestrator |
| `query_data` | `{query, limit?}` | Restricted SELECT/WITH over own Postgres (read-only transaction, statement timeout, row cap). | orchestrator, analyst |
| `search_memory` | `{query, path?, limit?}` | Calls the existing Memory REST search (semantic + recency scoring). | orchestrator, analyst, researcher |
| `ask_user` | `{question, options?}` | **No execute function** — ends the turn, persists an answerable question. | orchestrator, analyst, researcher |

No Shopify or domain-specific tools enter the registry. Tool errors carry **fixed safe messages**; no secrets, provider internals, or sensitive response bodies in tool errors or logs.

### Work Docs (durable, versioned, linked)

Prisma models (Postgres — same instance as memory; no filesystem artifacts):

| Model | Fields |
|---|---|
| `WorkDoc` | `id`, `scope` (`default`, single-tenant), `chatId`, `type` (`report \| plan \| analysis`), `title`, `content`, `status` (`draft \| active \| archived`), `version` (integer CAS counter), `createdAt`, `updatedAt` |
| `WorkDocVersion` | `id`, `docId`, `version` (integer), `content`, `title`, `createdAt` — **immutable snapshots** |
| `WorkDocRevision` | `id`, `docId`, `fromVersion?`, `toVersion`, `source` (`agent \| user`), `actorId?` (chat id / agent slug; auth arrives later), `summary`, `createdAt` — **audit trail** |
| `WorkDocLink` | `id`, `docId`, `targetType` (`memory_block \| chat \| delegation`), `targetId`, `createdAt` — **typed links** |

Semantics:

- `create` → version 1, status `draft`, snapshot v1, revision (`fromVersion` null → 1).
- `update` with **`expectedVersion` CAS**: if the doc's current `version ≠ expectedVersion` → fixed 409, **no write**. Success → content replaced, `version + 1`, new immutable snapshot + revision. This makes concurrent edits detectable for both the tool path and the UI path.
- `rollback {version}` → copies that historical version's content into a **NEW current version** (`version + 1`, new snapshot + revision). History is **never deleted or rewritten**.
- `PATCH` (UI route) is **metadata-only** (`status`/`title`) — content changes go through the versioned `POST …/versions` path, which the browser sends with source `'user'` and `write_doc` with source `'agent'`.
- **Ownership enforced**: a doc's `chatId` must match the calling chat (tool passes its chat id; UI passes the chat it renders). Cross-chat or cross-scope access → fixed 404 (no existence leak). Single `scope = default`.
- Links and versions live in Postgres and **survive refresh**; the Work Docs page reads them through the REST routes below.

### REST routes — Work Docs (UI and tools, same routes — as implemented)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/agents/:slug/work-docs?scope&chatId&limit` | List documents, newest first |
| POST | `/api/agents/orchestrator/work-docs` | Create (agent-sourced, the `write_doc` create): `{chatId, type, title, content}` → version 1 draft + v1 snapshot + creation revision |
| GET | `/api/agents/:slug/work-docs/:id?chatId=` | One doc + recent versions + links; ownership enforced (wrong chat → 404, no existence oracle) |
| PATCH | `/api/agents/:slug/work-docs/:id` | USER **metadata-only** `{chatId, expectedVersion, title?, status?}` via CAS — content is never edited here |
| POST | `/api/agents/orchestrator/work-docs/:id/versions` | Content/title/status updates via CAS (`{chatId, expectedVersion, content, title?, status?, summary?}`) — the `write_doc` update path |
| GET | `/api/agents/:slug/work-docs/:id/versions` / `…/versions/:version` | Immutable version list (bounded) / one immutable snapshot |
| POST | `/api/agents/:slug/work-docs/:id/rollback` | `{chatId, expectedVersion, toVersion, summary?, source?}` — copies the OLD snapshot into a NEW current version; history never rewritten |
| GET | `/api/agents/:slug/work-docs/:id/revisions` | Audit trail (source, actorId, from/to, summary) |
| POST / GET | `/api/agents/:slug/work-docs/:id/links` | Add a typed link (`{targetType, targetId, label?}`, idempotent per doc+type+target) / list links |

Fixed safe errors: 400 invalid payload, 404 unknown/unowned id, 409 CAS conflict (`expectedVersion` mismatch), 503 Postgres unavailable. **No document content logged, no secrets logged** — logs carry ids and error codes only.

**Revision source as implemented**: Work Doc content versions created from the **browser UI record source `'user'`**; agent `write_doc` updates default to source `'agent'`. Both paths create the same immutable version + revision records.

### Delegation — REST, tracking, trusted depth (ADR-004)

`Delegation` rows (Postgres): `id`, `parentChatId`, `childChatId` (**stable UUID, assigned up front**), `parentMessageId`, `targetAgent` (`analyst \| researcher`), `mode` (`sync \| async`), `status` (`pending \| running \| completed \| failed \| timeout`), `result?`, `error?`, `depth` (parent depth + 1), `createdAt` / `startedAt` / `completedAt`.

Routes (as implemented):

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/agents/orchestrator/delegations` | Create a tracked delegation (`{parentChatId, parentMessageId, target, task, mode: sync \| async}`); a signed internal context is required (400 without). Sync waits for the run → `201 {delegation, childChatId}`; async enqueues on `workforce-delegation` → `202 {…, status: 'pending'}`. Child depth = `parentDepth + 1`; a request implying depth ≥ 3 → **403**. |
| GET | `/api/agents/:slug/delegations?parentChatId&limit` | List **one parent chat's** delegations, newest first. `parentChatId` is required — a deliberate, safer deviation from a global list (delegations are only observable from their owning chat). |
| GET | `/api/agents/:slug/delegations/:delegationId` | Status + result/error + child chat id. |
| POST | `/api/agents/:slug/delegations/:delegationId/run` | INTERNAL — signed create/run context required. `pending → running → completed/failed/timeout`; `running`/terminal rows are returned untouched (no second child generation — safe retries). |

Safe validation: self-target (orchestrator → orchestrator) → 400, invalid target → 400, depth ≥ 3 → **403** (and the delegation tool simply does not exist at `depth >= 2`). No secrets in delegation errors.

**Trusted depth is server-side only.** The delegations service issues a short-TTL, server-signed internal **delegation context** (`X-Workforce-Delegation-Context`: base64url payload + HMAC-SHA256 over `{kind, parentChatId, childChatId?, targetAgent?, depth, expiresAt, …}`, signed with `DELEGATION_CONTEXT_SECRET` or a per-boot random secret with a safe warning — bytes never logged). The chat route verifies the signature and resolves mode/depth/toolset from it; a verified context claiming depth ≥ 3 → 403. Client body fields claiming depth are **never read**; an invalid or expired internal header → fixed 400. Depth can only enter the system by creating a Delegation row server-side.

**Synchronous delegation** (parent mid-loop):

1. Model calls `delegate_task {targetAgent, task, mode: 'sync'}`.
2. Tool creates the Delegation row (`POST …/delegations`, mode sync) — status `pending`; then `POST …/delegations/:id/run` atomically claims `pending → running`.
3. The run route calls the **existing** `POST /api/agents/{target}/chat` over the same REST contract the UI uses: child chat id + newest user `UIMessage` carrying the task, `Idempotency-Key` header, signed child context — and **consumes its UI SSE stream** (`parseJsonEventStream` + the SDK's UI chunk schema) to completion.
4. On finish: status `completed`, `result` = the child's final assistant text; the tool returns that text as tool output so the orchestrator continues with it. On provider/stream failure → `failed` (safe error); on timeout → abort + `timeout`. **Budget**: ordinary tool REST calls use the standard 30 s timeout, but the sync create/run path gets the delegation budget — `DELEGATION_TIMEOUT_MS` (default 120 000 ms) + `TOOL_RUN_MARGIN_MS` (10 000 ms) = **default 130 000 ms (130 s)** — so the child context TTL, the child fetch/SSE consumption and the parent's tool wait all fit inside one bounded window.
5. The child chat is a **real chat**: persisted, idempotent, resumable, visible at `/chat/:childChatId`. No shadow child runner, no separate provider implementation anywhere.

**Asynchronous delegation**:

1. Model calls `delegate_task {…, mode: 'async'}`; the tool creates the Delegation row (`mode async`) and immediately returns `{delegationId, status: 'pending'}` as tool output ("delegation accepted; check status").
2. The delegations service enqueues a BullMQ job on `workforce-delegation` (the existing Redis/BullMQ infrastructure) with a **deterministic job id** `delegation-<delegationId>` and a bounded job budget; nothing else changes about the existing queue setup.
3. The worker (runs inside the API process, max 2, attempts 3, exponential backoff — like the memory worker) picks the job → `POST …/delegations/:id/run` → invokes the **same child chat REST endpoint** (Idempotency-Key + signed child context + consumed SSE stream) → updates the row to `completed` / `failed` / `timeout` with `result` / `error`.
4. **Exactly one execution** is enforced by an **atomic `expectedFrom` claim** (`updateStatus { expectedFrom: 'pending' }` compare-and-set): concurrent runners — sync tool, create-wait, worker retries — yield one `running` claim and one child generation; losers get the untouched row. A `running` row past the delegation budget is **stale-recovered** from the child chat's durable transcript (`completed` with the recovered answer, or `failed`) — never a duplicate generation, never a permanent wedge. The child user message id derives from the delegation id, so the child `Idempotency-Key` is stable across every retry. (Recovery is per API process — no multi-process failover claim.)
5. The panel shows status transitions and links to the child chat.

### `query_data` — restricted read-only SQL

- Connection/pool dedicated to reads: transaction forced **read-only** (`READ ONLY` transaction + `SET LOCAL statement_timeout`) — the DB itself discards/rolls back writes even if screening misses one (proven over real Postgres: rollback/discard, timeout, cap, dangerous-function rejection).
- Served at `POST /api/agents/:slug/data/query` (`{query, limit?}`) — only for slugs whose composition includes `query_data` (`orchestrator`, `analyst`; others 404). Success: `{columns, rows, rowCount, truncated}`.
- Statement screening (demonstration-grade, not a production SQL firewall): exactly **one statement**, leading keyword must be `SELECT` or `WITH`, comments stripped before the keyword check, semicolons/multiple statements rejected.
- Postgres `statement_timeout` (default 2 000 ms, `QUERY_STATEMENT_TIMEOUT_MS`) and a **row cap** (default 200 rows, `QUERY_ROW_CAP`, enforced as `LIMIT (cap + 1)` around the user query — cap + 1 rows → fixed 400, never silent truncation).
- Runs over the **existing project tables** (chats/messages, memory blocks, work docs) — a neutral demonstration of the pattern, **not a general production SQL firewall**.

### `ask_user` — HITL as an execute-less tool

1. `ask_user` is registered with its input Zod schema and **no execute function**. When the model calls it, the generation **ends its turn naturally** (AI SDK behavior for execute-less tools; the part is persisted `input-available`). **No custom `stop()`** anywhere.
2. The assistant `UIMessage` with the visible question is persisted by the existing Phase 2 machinery (idempotency, stream lifecycle unchanged).
3. On the **next user response** in that chat, **after** the idempotency key is acquired but **before** `validateUIMessages` → `convertToModelMessages`, the route **atomically resolves pending questions** over the real transcript: byte-exact compare-and-set of one list entry (`LINDEX` equality + `LSET` in Redis, no `cjson`; the same raw-entry algorithm in the in-memory store). The **newest** pending (`input-available`) question receives the newest user text as `output-available: {answer}`, every **older** pending question receives the bounded sentinel `(no answer given)`. Invalid inputs never mutate the questions and duplicate submits never double-answer; `options: []` and huge numeric byte payloads survive byte-for-byte (proven over real Redis in integration; stale resolutions resolve clean). The new user message is then appended and the generation **resumes** — the model sees the answer as the tool result.
4. Phase 2 guarantees (idempotency, replay, hydration) are untouched: the part-state update is a deliberate, tested exception to "append-only" — **user messages are still append-only**; an assistant message may receive a targeted part-state update (in-place update of the known transcript entry), so a resume replays the answered state.
5. A mid-stream refresh between question and answer hydrates the pending question; after resume it hydrates the answered state.

### Chat route integration — Phase 2 contract preserved

- The same `POST /api/agents/:slug/chat` now dispatches on slug + mode + server-resolved depth: agent definition → system prompt → `composeAgentCapabilities` → `streamText` (unchanged step caps/provider).
- Delegated child requests are indistinguishable at the wire level from any chat POST apart from the verified internal delegation header; their toolsets come from the child agent at the context's depth.
- Phase 2 idempotency (`SET NX`, 409, TTL), full replay resume, hydration, and transcript handling remain **unchanged** and must stay green (regression tests + `general` suites).

### Web (reuse existing styles — no redesign, no design system)

- **Chat**: agent picker (`general` / `orchestrator` / `analyst` / `researcher`), stable `/chat/:chatId` URLs (existing chat id), agent slug included in the client transport, Plan/Action toggle for orchestrator only.
- **Work Docs page**: list and detail with type/status/title/content/version; revision history (source, from/to, summary); typed links; **safe rollback** (confirm + current `expectedVersion`, 409 handled visibly).
- **Delegation list/detail**: statuses (`pending → running → completed/failed/timeout`), result/error display, link to the child chat URL.
- **Tool-part rendering** for `calculate` / `write_doc` / `delegate_task` / `query_data` / `search_memory` / `ask_user`: generic accessible part cards; the `ask_user` question is a **visible human question** (prominent, announced to screen readers), with the answer shown once recorded.
- Accessible labels required everywhere (desktop/mobile pass like Phase 3).

---

## Tests

Current state (2026-11-23 — implemented & run):

- **Offline: 593 green** (core 203, CLI 30, API 256, web 104); root `typecheck` and production-build checks pass (the consolidated root test run executes separately).
- The `composeAgentCapabilities` **tool omission matrix**: every agent × mode × depth yields the exact expected tool set (plan omits `write_doc`/`delegate_task` entirely; workers never compose write/delegate tools; `delegate_task` absent at `depth ≥ 2`; `general` always `calculate`-only).
- **Forbidden delegation**: self-target/invalid-target rejections; a request implying depth ≥ 3 → 403 (no row, no child call); worker toolsets cannot delegate even on a hallucinated call.
- **Sync delegation** (real Redis + real contract): same-REST child chat POST (verified `Idempotency-Key`), SSE consumed, result fed back, row `completed`; failure → `failed` (safe error); bounded timeout → `timeout`.
- **Async delegation** (real BullMQ/Redis): deterministic `delegation-<id>` job id, worker invokes the child chat REST endpoint, status transitions `pending → running → completed/failed/timeout`, `result`/`error` persisted; the atomic `expectedFrom: 'pending'` claim yields **exactly one execution** under concurrent runners; a stale `running` row is recovered, never wedged.
- **Work Docs** over real Prisma/Postgres: create; CAS update (correct `expectedVersion` → new version; stale → 409 **no write**); user-source update (browser path, source `'user'`); **rollback writes a NEW current version with immutable history intact**; **concurrent link additions are idempotent** (no duplicates).
- **`ask_user`** over real Redis: byte-exact CAS resolution preserving `options: []` and huge numeric byte payloads; stale/pending resolutions resolve clean; resume replays the answered state.
- **`query_data`** over real Postgres: read-only transaction (rollback/discard of a rejected write), single SELECT/WITH screening, statement timeout fires, row cap fires (`truncated` semantics, no silent truncation), and dangerous-function (write-ish) calls rejected.
- **Regression**: existing `general` chat tests and the full Phase 2 suites unchanged and green.
- Models are **mocked everywhere** (`ai/test`'s mock model) — **no real Ollama call is made by any test**; the root `npm run test:integration` passed **twice with exact per-run cleanup** (23 tests: 11 memory + 3 Phase 2 Redis streaming + 9 Phase 4; never FLUSHDB, never other scopes/queues).

### Review findings — found and fixed (integration-polished, not re-verified against multi-process failover)

Review rounds caught and fixed: a transaction pool-poisoning path, the **sync delegation budget** (`DELEGATION_TIMEOUT_MS` + `TOOL_RUN_MARGIN_MS`, default 130 s — ordinary REST calls stay at the standard 30 s), a Redis `cjson` corruption risk in transcript CAS (replaced with raw-entry `LINDEX`/`LSET` byte matching), a **delegation double-run window** (now the `expectedFrom` atomic claim), a **stale `ask_user` wedge** (older pending questions resolve to `(no answer given)`), **stale `running` delegations** (budget-based recovery from the child transcript), an `addLink` aborted-transaction re-read, plus audit **source tagging and race polish**. Recovery is per API process — **no multi-process failover claim** is made.

---

## Validation record — live browser gate (2026-11-23, orchestrator run)

**Setup honestly stated**: the gate ran against Farhan's **already-running real-provider servers** via saved env — **no key was inspected or printed** by the runner; the real Ollama calls occurred through the **browser** (server-side provider calls, as designed).

- **Duplicate-submit bug found live and fixed**: the first Plan test produced **2 user IDs / 2 assistant rows** from one send. Fixed with a **synchronous `submissionGate` shared by the normal path and the HITL answer path**; browser regression then proved Enter ("OK") and the button ("DONE") each submit **exactly one message pair**.
- **Plan mode (orchestrator chat `52790846-b7b8-4520-8def-23aacf5a96f8`)**: exactly **2 messages**; `search_memory` ran — **no `write_doc`, no `delegate_task`** (tools absent, per ADR-001).
- **Action mode (same chat)**: `search_memory` → sync `delegate_task` — delegation `eb0be373-6ad2-438e-b014-95a445d1b385` **completed**, child chat `b71b4125-c0cb-4282-a909-6eba686f0418` — → `write_doc` created report **"SLM Comparison Brief"** (`86ee3a08-a8b1-471c-b6bc-d0b9e0782082`, v1). The model's **first `write_doc` attempt passed an unsupported argument (`summary`)** and got a contained output-error; the model corrected itself and succeeded. **Honest error-containment evidence**; 4 final messages before HITL.
- **HITL (same chat)**: `ask_user` offered **Concise/Detailed**; the browser answer "Concise" produced **exactly one user answer**, stored output `{answer: 'Concise'}`, and the final response was concise — no duplicate.
- **Analyst (chat `d2c66e6e-6641-4984-89b8-4f5df481836b`)**: `query_data` with `SELECT 1 AS ok` → columns `['ok']`, rows `[[1]]`, rowCount 1; no writes, no delegation.
- **Researcher (chat `2919cbba-6416-45ba-b999-327498a65a48`)**: `search_memory` **three times**, summarized distinct quantization/latency conclusions; no writes, no delegation.
- **Async delegation (same orchestrator)**: one async `delegate_task` — delegation `b91349db-dc07-4885-97c4-25e40d520795` `pending → completed` via **real BullMQ**; analyst child chat `210ef1d4-6e2a-4157-9fd6-11bcf7a54ea5` returned 42. The `/delegations` panel lists **both sync + async completed** and the child-chat links work.
- **Work Docs UI**: the artifact shows content, **version history and the agent revision audit**. Earlier browser smoke already proved create, user `v2` edit and rollback to a **new v3**; **CAS conflicts are proven by the real integration suite** — no fresh real-provider conflict test is claimed here.
- **Ops note (not an app failure)**: dev assets transiently 404'd once because the production build overwrote the running dev server's assets; only the dev server was restarted and they recovered (200).
- **Artifact URLs for Farhan's approval walkthrough** (localhost:3000):
  - `/agents/orchestrator/chat/52790846-b7b8-4520-8def-23aacf5a96f8`
  - `/work/86ee3a08-a8b1-471c-b6bc-d0b9e0782082?chatId=52790846-b7b8-4520-8def-23aacf5a96f8`
  - `/delegations?chatId=52790846-b7b8-4520-8def-23aacf5a96f8&agent=orchestrator`

**Recorded 2026-11-23: live browser gate passed by the orchestrator; Farhan explicitly approved the same day ("yes next phase pls") — Phase 4 VALIDATED 2026-11-23.**

---

## Validation gate for Phase 4 (live, with Farhan)

Ready-to-paste prompts (run `npm run dev` with your own env; never paste an API key into chat):

| # | Where / mode | What to ask | Expected |
|---|---|---|---|
| 1 | Orchestrator, **Plan** toggle | "Sketch a plan to research this project's memory system. Do not write anything or delegate." | A plan arrives; `write_doc`/`delegate_task` are **absent from the turn** (nothing written, no delegation row). No tool call at all is also acceptable. |
| 2 | Orchestrator, **Action** | "Search memory for what we learned about compaction, then delegate a summary of it to the researcher (sync), then write a report Work Doc with what came back." | `search_memory` → `delegate_task` (sync, researcher) → child answer as tool output → `write_doc` report created. |
| 3 | Analyst | "Use query_data to run exactly: `SELECT 1 AS ok`." | `query_data` call succeeds with one row. |
| 4 | Researcher | "Search memory for the compaction design and summarize it briefly." | `search_memory` call with relevant results. |
| 5 | Any worker/orchestrator | "Before you continue, ask me a question with options." | Visible `ask_user` question (options incl. empty list); answer **through the UI**; the same chat resumes with the answer as tool result. |
| 6 | `/work` page | Edit a Work Doc's content in the browser; open a stale view and save again; then roll back | Content edit records source `user`; stale save → **conflict** (no lost update); rollback → NEW current version, full history retained. |
| 7 | `/delegations` panel | Inspect rows after steps 2 (and an async run) | Statuses `pending → running → completed`, results visible, **child-chat links open real chats**. |

Gate criteria (unchanged):

1. Plan mode cannot write or delegate — because the tools are absent (demonstrate the absence, not a refusal).
2. Action-mode orchestrator delegates (sync) to the researcher and writes/updates a Work Doc.
3. Analyst safe SQL; researcher memory search.
4. Refresh restores the Work Doc with **versions, revisions, and links**.
5. **Async delegation** status changes visible and linked to the child chat.
6. **`ask_user`** pauses with a visible question; the next message resumes the same chat.

**Honesty note**: the model is not guaranteed to always obey the intended tool order — if a turn picks a different (allowed) tool, or the exact failure appears, **record exactly what happened** (slug, mode, tool, response) and report it; that is a finding for the gate discussion, not a doc error to paper over. *(The 2026-11-23 orchestrator run demonstrated exactly this: one contained `write_doc` argument error, self-corrected — see the validation record above.)*

**Phase 4 was closed on 2026-11-23: Farhan explicitly approved this live gate ("yes next phase pls"). It is validated.**

---

## When done

✅ Done 2026-11-23. → [Phase 5 — Queues & Schedulers](./phase-5-queues.md) opened the same day — design fixed in [ADR-006](../decisions/ADR-006-bullmq-scheduler.md) (BullMQ Job Schedulers); implementation not started.
