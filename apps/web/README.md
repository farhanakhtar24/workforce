# @workforce/web

Phase 2/3/4/5 minimal Next.js + React client for the Workforce API (`@workforce/api`).
Chat: four agents (`general` / `orchestrator` / `analyst` / `researcher`) with
plan/action modes over the same streaming, idempotent, resumable chat core —
rendered part by part. Memory: `/memory` create/browse/search/related/retry/compact
workspace for the Phase 3 memory routes. Work Docs and Delegations are the Phase 4
additions, `/schedules` (agent task dashboard over the real `/api/scheduler` REST
routes) is the Phase 5 addition.

See `docs/phases/phase-2-streaming.md`, `docs/phases/phase-3-memory.md`,
`docs/phases/phase-4-multi-agent.md`, ADR-005 (SSE + idempotency), ADR-008 (UI
message streams), ADR-001/002 (composition + same-REST tools), ADR-004
(delegation depth cap 2), ADR-003 (memory tree) and ADR-007 (pgvector + local
MiniLM embeddings).

## Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 15 (App Router), React 19, TypeScript strict |
| Chat state | `@ai-sdk/react` `useChat` (AI SDK v6), `DefaultChatTransport` from `ai` |
| Markdown | `react-markdown` + `remark-gfm` (assistant text renders real Markdown; raw HTML is never enabled) |
| UI framework | None — plain CSS (`app/globals.css`), no design system (Phase 2/3 non-goal) |
| Tests | `node:test` via `tsx` on pure helpers — no browser, no live API |

## Scripts

```sh
npm run dev        # next dev -p 3000
npm run build      # next build
npm start          # next start -p 3000
npm run typecheck  # tsc --noEmit
npm test           # tsx --test test/*.test.ts
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | The only client-exposed value (the public Express API base). Never an API key. |

No secrets reach the browser: `OLLAMA_API_KEY` lives only in the API process.
Memory embeddings run entirely server-side too (local MiniLM, 384-dim); `/memory`
never loads, stores, or requests an embedding model or vectors, and the client
rejects any block payload that carries an `embedding`/`vector` key.

Copy `.env.example` to `.env.local` for non-default values.

## Routes

| Route | Purpose |
|---|---|
| `/` | Mints a fresh chat id (server-side `crypto.randomUUID`) and redirects to the canonical chat URL, carrying a valid `?agent=`/`?mode=` from "New chat". |
| `/agents/[slug]/chat/[chatId]` | **Canonical stable chat URL.** `slug` ∈ general/orchestrator/analyst/researcher; `?mode=plan\|action` optional (default `action`). Unknown slug → safe 404; unsafe id → 404; unknown mode → default. Server hydration calls `GET /api/agents/<slug>/chat/:chatId` with `no-store` for the SAME slug. |
| `/chat/[chatId]` | Legacy Phase 2 URL — redirects to `/agents/general/chat/<chatId>` (a valid `?agent=`/`?mode=` is honored), so pre-Phase-4 links keep their general transcript. |
| `/memory` | Phase 3 memory workspace (unchanged). |
| `/work` | Work Docs library: filter by scope/chat id/type/status, list, create (real orchestrator POST route, draft v1, requires a chat context). |
| `/work/[workDocId]?chatId=…` | Work Doc detail: content, metadata edit via PATCH (CAS `expectedVersion`), versioned content edit via the REAL agent versions route (CAS `expectedVersion`, new immutable version), revisions, versions, typed links, rollback (`expectedVersion` + `toVersion` + confirm). The owning `chatId` is required by every doc-scoped API call — cross-chat access is a fixed 404, and the UI never links a detail view without it. |
| `/delegations?chatId=…` | One parent chat's delegations through the real `GET /api/agents/orchestrator/delegations?parentChatId=…` route: target, mode, depth, status, task, result/error, timestamps, child-chat link. Polls only while a row is pending/running (tab visible, no overlapping requests, stops on error). No manual run/retry: `/run` is an internal signed route the browser never calls. |
| `/schedules` | Phase 5 schedule dashboard over the real `/api/scheduler` routes (below). Tasks table/cards (agent/mode/recurrence summary/Active-Paused/next run) with Edit, Activate/Pause and Run now; execution-history table/cards with task + status filters, status badges, `scheduledFor` (UTC), `attempt/maxAttempts`, `durationMs`, input/output/total tokens (em dash when absent), bounded safe error, `retryOfExecutionId` link, and an `Open isolated chat` link to `/agents/<owning agent slug>/chat/<execution.chatId>?mode=<owning mode>`. DEAD_LETTER rows carry the only Retry action (details explain it creates a NEW linked execution in a NEW isolated chat; the old row stays immutable). Polls at most every 2 s, only while visible executions are PENDING/RUNNING/RETRYING (or a just-submitted run is settling), tab-gated, non-overlapping, sequence-guarded, stops on error behind a manual Refresh. All schedule input/times are UTC: minute precision, no seconds, no other timezone. The WORKER-ONLY routes (`tasks/:id/run-scheduled`, `executions/:id/run`) are never called and have no client builder. |

## `/api/scheduler` contract (Phase 5)

Contract source of truth: `apps/api/src/app.ts` mounting + `apps/api/src/scheduler/routes.ts`
and `packages/core/src/scheduler` (kinds/schemas/types). The browser may call
exactly these (helpers in `src/lib/scheduler.ts`, all tested):

| Call | Route | Notes |
|---|---|---|
| Create | `POST /api/scheduler/tasks` | body = `{ name, agentSlug, mode, prompt, scope, recurrenceType, recurrenceConfig, skipDates, timezone: 'UTC' }` — 201 `{ task }`; a 503 means the DB row stands and only the BullMQ sync failed (`Scheduler queue is temporarily unavailable.` shown verbatim + saved-row hint; the UI refreshes task state). |
| List | `GET /api/scheduler/tasks?isActive=&limit=` | `{ tasks } ≤ 100`; `isActive` only `true`/`false`. |
| Detail | `GET /api/scheduler/tasks/:id` | `{ task, executions ≤ 10 }`. |
| Update | `PATCH /api/scheduler/tasks/:id` | full editable field set; `recurrenceType`+`recurrenceConfig` always together; `nextRunAt` is recomputed server-side; same honest 503 semantics. |
| Activate/Pause | `POST /api/scheduler/tasks/:id/activate` / `/pause` | the ONLY way `isActive` changes; `{ task }`; honest 503 as above. |
| Run now | `POST /api/scheduler/tasks/:id/run` | MANUAL trigger → NEW execution + enqueue; 202 `{ execution }` (starts PENDING and settles in the history). |
| History | `GET /api/scheduler/executions?taskId=&status=&limit=` | task (UUID) / status (the 7 statuses) filters; invalid values are omitted client-side. |
| One row | `GET /api/scheduler/executions/:id` | `{ execution }`. |
| Retry | `POST /api/scheduler/executions/:id/retry` | DEAD_LETTER-only (409 otherwise): NEW linked execution + NEW isolated chat; 202 `{ execution, retryOfExecutionId }`. |
| NEVER | `POST /api/scheduler/tasks/:id/run-scheduled`, `POST /api/scheduler/executions/:id/run` | WORKER-ONLY (they carry BullMQ occurrence metadata the browser never mints); no builder exists in the client. |

Recurrence shapes (strict pair rule, from `packages/core/src/scheduler`):
`ONCE { runAt: UTC Z ISO }` (a `datetime-local` value converted by the client —
seconds never stored), `DAILY { hour, minute }`, `WEEKLY { hour, minute,
weekdays 0..6 unique }` (0=Sunday), `MONTHLY { hour, minute, daysOfMonth 1..31
unique }`, `CUSTOM_CRON { expression: exactly 5 whitespace-separated fields, ≤200 chars }`.
`skipDates`: comma/newline textarea → unique real `YYYY-MM-DD` UTC dates (≤366),
deduped/validated client-side (all-or-nothing). Strict mappers reject malformed
rows (wrong enum/value/shape, config/type mismatch, non-UTC instants, unsafe
chat ids, non-UUID ids, malformed `tokenUsage`) into one safe fixed refresh
error — no raw payload ever reaches the DOM.

## Chat (Phase 2 core, Phase 4 surface)

- **Agent picker + Plan/Action** on every chat page. Selecting an agent or mode
  navigates to the canonical URL for that (slug, mode); the server page re-hydrates
  that key's transcript (transcripts are stored per `(slug, chatId)`), and the client
  component is keyed by slug+mode so `useChat` re-seeds. Plan is visibly labeled as a
  NEXT-generation choice — there is no mid-turn escalation; the mode rides the next
  POST only.
- **Send** (`POST /api/agents/<slug>/chat`): body is exactly
  `{ id: chatId, message: newestUserMessage, mode }` (mode omitted only when no
  selection is made), with the unchanged header `Idempotency-Key: <chatId>:<messageId>`
  (API 400s on any mismatch; duplicate message id → 409 surfaced safely).
- **Resume**: `useChat({ resume: true })` reconnects at mount via
  `prepareReconnectToStreamRequest` against `GET …/chat/:chatId/stream` for the same
  slug. `resumeStreamIsReplay` stays at its default `true` (ADR-008): full SSE replay,
  interrupted assistant message rebuilt exactly once, `204` = silent idle.
- **No stop button.** Refresh/disconnect never aborts the provider generation
  (ADR-005); reconnecting resumes it. There is no abort call in this codebase.
- **Throttle**: `experimental_throttle: 50` (≈50 ms) for streamed UI updates.
- **Assistant message regions** (`src/lib/parts.ts` + Chat components): each assistant
  turn renders exactly once per part, split into labeled regions so reasoning and tool
  output never mix into the prose:
  - `Response` — all text parts joined in original order with blank lines and rendered
    as real Markdown (`react-markdown` + `remark-gfm`: headings, lists, bold/italic,
    blockquotes, rules, code, GFM tables/strikethrough). Raw HTML is NOT enabled (no
    `rehype-raw`, no `dangerouslySetInnerHTML`) and wide tables/fenced code scroll
    sideways inside the column. Partial streamed Markdown renders as plain prose until
    syntax closes — streaming never crashes.
  - `Thinking` — all reasoning parts in a collapsed-by-default `<details>`.
  - `Tool activity (N)` — every non-HITL tool part (all six cards below, plus unknown
    `tool-*` fallback) in a separate collapsed-by-default `<details>` whose summary
    lists deduplicated tool names, so giant always-open results (e.g. `search_memory`)
    never dominate the thread.
  - Pending HITL: an unanswered (`input-available`) `ask_user` stays top-level and
    prominent while the answer gate is active (newest assistant message only — the
    same gate as the composer); answered/older `ask_user` parts move into Tool
    activity as readable cards. Never hidden, never duplicated.
  - `user` messages keep the plain Phase 2 text rendering; `general`/`calculate`
    behavior stays compatible (a simple calculate turn shows the answer text plus the
    collapsed calculate card).
- **Tool-part rendering** (`src/lib/tools.ts` + component views): human-labeled cards,
  all content bounded plain text (React escapes; no `dangerouslySetInnerHTML`):
  - `calculate` — unchanged Phase 2 rendering (dedicated tested helper).
  - `write_doc` — create/update/rollback operation, doc id, target/version; links to
    `/work/<id>?chatId=<current chat>` when the id is a UUID.
  - `delegate_task` — target/mode/task bounded; status, result/error rounded down to
    safe bounded text; child chat links to `/agents/<target>/chat/<childChatId>` only
    for safe ids and worker slugs.
  - `query_data` — bounded SQL, column/row table (≤8 rows on screen), `rowCount`, and
    an explicit "showing the first rows only" note when the display is truncated.
  - `search_memory` — query, ≤5 bounded results with path/kind/scores, link to `/memory`.
  - `ask_user` — prominent, screen-reader-announced question with options; the answer
    form below the thread is the channel:
- **HITL answering**: while the newest message is an assistant turn holding a pending
  (`input-available`) `ask_user` part, the normal composer is disabled and a labeled
  answer form (textarea + suggested-answer buttons + "Send answer") is shown. Submitting
  sends a NORMAL user message through the same path — the API marks the part
  `output-available { answer }` and resumes the generation. No fake local answer state.
  Generic `tool-*` parts fall back to a bounded name/state/input/output card.

## /memory workspace (Phase 3 — unchanged)

Same panels and behaviors as the Phase 3 release: create (bounded fields, live
counter), browse (filters + refresh + auto-poll while blocks are `pending`), semantic
search (80% cosine + 20% recency, fixed 3-decimal display), related blocks, retry for
failed embeddings, compaction with the >30-character expectation gate. Pure helpers in
`src/lib/memory.ts` (tested); polling is 2 s, visibility-gated, non-overlapping.

## Architecture

```
app/page.tsx                          root → crypto.randomUUID() → redirect to canonical chat URL (with selection)
app/chat/[chatId]/page.tsx            legacy /chat/:id → redirect (general; honors a valid ?agent=/)
app/agents/[slug]/chat/[chatId]/page.tsx server hydration fetch (no-store) → <Chat> seed; safe notFound boundaries
app/memory/page.tsx                   /memory shell → <Memory>
app/work/page.tsx                     /work shell → <WorkDocsList> (chatId/scope/agent params validated)
app/work/[workDocId]/page.tsx         detail shell → <WorkDocDetailView> (chatId required)
app/delegations/page.tsx              delegation panel shell → <DelegationsView>
app/schedules/page.tsx                /schedules shell → <Schedules> (fully dynamic)
src/components/Chat.tsx               'use client': agent/mode controls, useChat + transport, tool-part and HITL rendering
src/components/Memory.tsx             'use client': Phase 3 workspace (unchanged)
src/components/WorkDocs.tsx           'use client': library list + create (real routes)
src/components/WorkDocDetail.tsx      'use client': metadata PATCH, versioned content edit, versions/revisions/links, rollback
src/components/Delegations.tsx        'use client': parent-chat delegation list + polling
src/components/Schedules.tsx          'use client': Phase 5 schedule dashboard (create/edit form, task table/cards, execution history + polling)
src/lib/scheduler.ts                  Phase 5 scheduler request/body/mapping/poll/link helpers (tested)
src/lib/api.ts                        chat request/response helpers (send/hydrate/resume, slug-aware; tested)
src/lib/agents.ts                     agent/mode roster, URL builders, guidance (tested)
src/lib/tools.ts                      tool-part formatting + pending-ask_user scan (tested)
src/lib/parts.ts                      assistant-part partitioning into Response/Thinking/Activity regions (tested)
src/lib/workdocs.ts                   Work-Docs request/body/mapping helpers (tested)
src/lib/delegations.ts                delegation list mapping/query/poll helpers (tested)
src/lib/memory.ts                     Phase 3 memory helpers (tested, unchanged)
src/lib/calculate.ts                  Phase 2 calculate formatting (tested, unchanged)
src/lib/messages.ts                   UIMessage typing for the six Phase 4 tool keys
```

Design rules kept from Phase 2/3: stable ids in URLs, server as source of truth,
`no-store` hydration, full-replay resume, no stop/abort, explicit accessible names on
every control, `role="status"`/`role="alert"` live regions, visible focus outlines,
single-column responsive layout, safe text-only rendering (assistant Markdown renders
through `react-markdown`'s React tree — raw HTML disabled, everything escaped, no
`dangerouslySetInnerHTML`), safe fixed error strings only.

## Tests (offline, pure — node:test)

`npm test` runs 138 tests across:

- `test/api.test.ts` — Phase 2 wire contract (send body/headers, endpoints,
  hydration mapping, safe errors) — unchanged and green.
- `test/calculate.test.ts` — `calculate` output formatting — unchanged and green.
- `test/memory.test.ts` — Phase 3 memory helpers — unchanged and green.
- `test/agents.test.ts` — roster/mode parsing, canonical + legacy URL building,
  child-chat URL gating, slug-aware send/hydrate/resume endpoints, `{id,message,mode}`
  body + unchanged idempotency header, plan/action guidance that names only composed tools.
- `test/tools.test.ts` — lifecycle labels, bounded text/JSON shaping, write_doc /
  delegate_task / query_data / search_memory / ask_user parsing, pending-ask_user
  scan, generic unknown-tool fallback.
- `test/parts.test.ts` — assistant-part region partitioning: reasoning separation,
  multiple text parts joined in original order with blank lines around tools, tool
  grouping/count + summary label, pending ask_user exclusion/gating (and answered
  or second ask_user never pending), streaming/junk/unknown parts dropped without
  duplication.
- `test/workdocs.test.ts` — exact endpoint URLs (?chatId everywhere it is required),
  list/PATCH/version/rollback/create body contracts (CAS `expectedVersion` +
  `toVersion`), response mappers (valid/malformed), 409 conflict text + hint,
  typed-link → in-app page mapping, display truncation.
- `test/delegations.test.ts` — required `parentChatId` query, row validation against
  the status machine, poll predicate (pending/running only), child-chat URL gating,
  safe error collapse, no-retry stance (the guarded `/run` route is never surfaced).
- `test/scheduler.test.ts` — exact `/api/scheduler` endpoint URLs (tasks, activate/
  pause/run, executions, retry), task + execution query builders (invalid enum/UUID
  values dropped), every recurrence type valid + invalid with ONCE `datetime-local`
  → UTC `Z` conversion (seconds stripped, offsets/non-real dates rejected), skip-dates
  editor (comma/newline, dedupe, real dates, 366 cap), create/update bodies (UTC
  timezone, scope normalization, NO `isActive` on create/update), strict task/execution
  mappers (malformed rows, config/type mismatch, token usage, non-UTC instants,
  unsafe chat ids rejected), response mappers (list/detail/mutation/run 202/retry
  202), formatters (recurrence summary per type, `attempt/maxAttempts`, `durationMs`,
  token em dashes, bounded error, badge data-status), chat/retry links keyed to the
  OWNING task's agent+mode, DEAD_LETTER-only retry gate, poll predicate
  (PENDING/RUNNING/RETRYING + settle window, never terminal-only), and stub-fetch
  orchestration for the real routes (API error text verbatim, honest 503 status).

## Validation limitations (honest — the phase gate is Farhan's live run)

- Tests cover only the **pure helpers**. No React/browser tests were added
  (by design, no extra stack).
- Phase 5 (`/schedules`) is NOT live-validated yet. Not yet run against the live
  stack: creating every recurrence type end-to-end, the honest 503 queue-sync flow
  (row stands, UI keeps the task after refresh), MANUAL run 202 → PENDING →
  RUNNING → terminal settling through the 2 s poll, DEAD_LETTER retry creating a
  NEW linked execution + NEW isolated chat, filter-driven history refresh,
  execution chat links landing in the right agent transcript, and the scheduler
  worker actually picking the synced BullMQ jobs. Run the API (`npm run dev` with
  Redis + Postgres + the scheduler worker) and `npm run dev` here, then walk the
  phase-5 validation gate.
- Not yet run against the live Phase 4 stack: agent/mode switch navigation +
  per-slug hydration, plan-mode generations actually WITHOUT write/delegation tools,
  `write_doc` → Work Doc page round-trip, CAS conflict (409) behavior in the PATCH /
  version forms, rollback creating a new version, delegation status polling
  (`pending → running → completed/failed/timeout`), child-chat linking, and HITL
  `ask_user` end-to-end (question asked → answer submitted through the normal POST →
  part resolved → generation resumed). Run the API (`npm run dev` in `apps/api`, with
  Redis + Postgres) and `npm run dev` here, then walk the phase-4 validation gate.
- Content editing in the UI goes through the REAL agent versions route
  (`POST …/work-docs/:id/versions`) with `source: 'user'` recorded in the
  revision trail (the route accepts optional `source: 'agent' | 'user'`,
  default `agent`; agent-originated `write_doc` calls stay server-side).
  There is no shadow user-content endpoint.
