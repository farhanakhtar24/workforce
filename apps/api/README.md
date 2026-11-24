# @workforce/api

Phase 2 Express API for Workforce: streaming chat over AI SDK v6 UI message
streams, with Redis-backed resumability (`resumable-stream`) and
`Idempotency-Key` exactly-once generation. Phase 3 adds the memory domain
(`@workforce/core/memory`) on the same process: a Postgres/pgvector store
(Prisma), a local Transformers.js embedding provider, an Ollama-backed
compactor, and a BullMQ worker over Redis.

Phase 4 adds the multi-agent runtime (ADR-001/002/004): four agent slugs
(`general` unchanged; `orchestrator`, `analyst`, `researcher`) composed ONCE
per generation from the core registry (`composeAgentCapabilities`), plan vs
action modes, server-trusted delegation depth with signed internal contexts,
Work Documents (CAS versions/rollback/revisions/links), `query_data` over a
read-only Postgres transaction, HITL `ask_user` (execute-less tool), and
sync/async delegation that runs child chats through the SAME chat REST
endpoint (no shadow runner).

See `docs/phases/phase-2-streaming.md`, `docs/phases/phase-3-memory.md`,
`docs/phases/phase-4-multi-agent.md`, ADR-005 (SSE + idempotency), ADR-008
(UI message streams), ADR-007 (pgvector), ADR-001 (composition gating),
ADR-002 (tools call the own REST API), and ADR-004 (depth cap 2) for the
fixed designs.

Phase 5 adds the scheduler (ADR-006, `docs/phases/phase-5-queues.md`): the
`/api/scheduler` REST surface over the Prisma scheduler store/service, the
real BullMQ scheduler queue (`@workforce/queue`), and the two run routes the
standalone `src/scheduler-worker.ts` process calls (`X-Workforce-Scheduler-Worker: 1`
convention). Every run goes through the SAME chat endpoint; each execution is
an isolated chat (`chatId = execution.id`). After an occurrence is materialized
(or deduped) the API advances `task.nextRunAt` under an exact-instant guard —
`null` for `ONCE` (startup reconcile never re-adds a consumed once job),
`computeNextRunAt(..., { after: occurrence, skipDates })` for recurring — as
UI/reconcile metadata only: the run path never calls `queue.syncTask`, and
there is no catch-up/backfill.

## Stack

| Concern | Choice |
|---|---|
| HTTP | Express 4, Node >= 24, strict TypeScript, ESM |
| LLM | `@ai-sdk/openai-compatible` (`createOpenAICompatible({ name: 'ollama' })`), model via `chatModel` |
| Generation | `streamText` with `stopWhen: stepCountIs(10)`, one tool, no `tool_choice`, no structured output |
| Streams | `createUIMessageStreamResponse` → Web `Response` → tested Express adapter (no buffering) |
| Resume | `resumable-stream` + Redis, full SSE replay |
| Chat state | Redis (`redis` v6); keys under `workforce:phase2:*`; messages persist append-only (one JSON UIMessage per list entry) |
| Agent composition | `composeAgentCapabilities` (core registry, ADR-001) — composed once per generation; plan mode omits write/delegate tools; `delegate_task` absent at depth ≥ 2 |
| Delegation | Signed HMAC contexts (`X-Workforce-Delegation-Context`, 5 min TTL), depth 0/1/2, sync tool loop + async BullMQ `workforce-delegation` worker (max 2) — child chats via the SAME `POST /api/agents/:slug/chat` |
| Work docs | `WorkDocService` over Prisma (`createPrismaWorkDocStore`): CAS updates, immutable versions, rollback → NEW version, revisions, typed links |
| `query_data` | Dedicated bounded pg pool, `BEGIN READ ONLY`, `SET LOCAL statement_timeout`, one SELECT/WITH statement, row cap via `LIMIT cap+1` |
| HITL | `ask_user` composed execute-less; the next user turn resolves pending parts to `output-available { answer }` atomically (Lua/CAS) before resume |
| Memory store | Postgres + pgvector via Prisma (`createPostgresMemoryStore`, generated client from `@workforce/core/generated/prisma`) |
| Embeddings | Local `Xenova/all-MiniLM-L6-v2` (384 dims) via `@huggingface/transformers`, q8 CPU, repo-local model cache |
| Compaction | `generateText` on the same Ollama model; plain-text summary, no JSON/tools |
| Jobs | BullMQ `workforce-memory` queue + worker, and `workforce-delegation` queue + worker (both ioredis, `maxRetriesPerRequest: null`) |

## Scripts

```sh
npm run dev                  # tsx --watch src/server.ts
npm run test                 # node:test via tsx, test/*.test.ts (offline: no Redis, no network)
npm run test:integration     # test-live/*.test.ts — REAL Redis + REAL Postgres/pgvector required
npm run test:embedding       # test-embedding/*.test.ts — REAL Transformers.js model download/load
npm run typecheck            # tsc --noEmit -p tsconfig.json
npm run typecheck:tests      # type of src + test (offline checks never need Redis)
npm run typecheck:integration # type of src + test + test-live
npm run typecheck:embedding  # type of src + test-embedding
npm run build                # tsc -p tsconfig.json → dist/ (tests excluded)
npm start                    # node dist/server.js
```

## Running with memory (production wiring)

```sh
docker compose up -d redis postgres              # or: npm run dev:infra (repo root)
npm run db:migrate                               # memory migration (Prisma migrate deploy) — NEVER run by the API itself
node --env-file=.env.local apps/api/dist/server.js
```

`DATABASE_URL` defaults to `postgresql://workforce:workforce@127.0.0.1:55432/workforce` — the local
docker-compose `postgres` service (pgvector `pgvector/pgvector:pg16` on `127.0.0.1:55432` → container 5432). The default
is LOCAL DEVELOPMENT ONLY: the Phase 6 deployment must set an explicit secret URL when it lands.

`src/server.ts` refuses to start without `OLLAMA_API_KEY` and `DATABASE_URL`,
connects Redis (bounded) and Postgres (`$connect`, bounded) first, and exits
non-zero if either is unreachable — it never serves with a broken pipeline.
Shutdown order: stop HTTP → drain tracked background tasks (bounded) → close
the BullMQ worker + queue → `prisma.$disconnect` → quit the existing
node-redis clients (resumable-stream semantics preserved).

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `OLLAMA_API_KEY` | — | Required only at `src/server.ts` startup (real provider creation). Tests inject a mock model and need no key. Never logged, never returned. |
| `OLLAMA_BASE_URL` | `https://ollama.com/v1` | The provider appends `/chat/completions`; keep `/v1` in the value. Trailing slashes stripped on load. |
| `OLLAMA_MODEL` | `glm-5.3-flash` | Chat model and compaction model. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Required at runtime: without Redis the chat/hydration/resume routes return **503** (ADR-005), not a degraded no-op. Also backs the BullMQ memory queue. |
| `DATABASE_URL` | `postgresql://workforce:workforce@127.0.0.1:55432/workforce` | Local dev default, matching the docker-compose `postgres` service (pgvector, host port 55432). Overrides via env; the value is never logged, and the default is never a real credential — **Phase 6 deployment must set an explicit secret URL**. **Required (non-null) to start the server**: it goes to the Prisma client. Tests in `test/` do not need it (in-memory store). NOT used for migrations — run `npm run db:migrate` (memory migration in `packages/core/prisma/migrations`) yourself before starting. |
| `EMBEDDING_CACHE_DIR` | `.cache/workforce-models` | Model cache for the local embedding provider. Relative values resolve against the app cwd; stored resolved-absolute in the config. The model downloads here on first use. |
| `PORT` | `3001` | |
| `WEB_ORIGIN` | `http://localhost:3000` | The only CORS origin; also the only origin that may send `Idempotency-Key`. |
| `INTERNAL_API_BASE_URL` | `http://127.0.0.1:<PORT>` | Loopback base for capability tools/delegation (ADR-002) — the tools call the OWN REST API. |
| `DELEGATION_CONTEXT_SECRET` | — | Optional ≥ 16 chars. Absent → per-boot random secret + safe log warning `delegation-context-secret-ephemeral`. Never logged as a value. |
| `DELEGATION_TIMEOUT_MS` | `120000` | Bounded child-delegation budget (header TTL + fetch deadline). 1000..600000. |
| `QUERY_STATEMENT_TIMEOUT_MS` | `2000` | Postgres `SET LOCAL statement_timeout` for `query_data`. 100..300000. |
| `QUERY_ROW_CAP` | `200` | Row cap enforced as `LIMIT cap+1`; cap+1 rows → fixed 400. 1..10000. |

Env files (startup hydration): before config, real startup loads the gitignored env files — the FIRST file that sets a key wins, in this order:

1. `apps/api/.env.local` (highest precedence),
2. `.env.local` (repo root),
3. `apps/api/.env`,
4. `.env` (repo root, lowest precedence).

Any value already in `process.env` wins over ALL files, including a shell-exported `OLLAMA_API_KEY` (empty values too — unset an export to let a file fill the key). Blank values never block startup: an empty or whitespace-only value counts as absent at config time, so blank optional variables fall back to their documented defaults; a blank `OLLAMA_API_KEY` still refuses startup with the reason `OLLAMA_API_KEY is missing`, and a nonempty malformed value is still rejected with the safe variable-name errors. Missing files are a no-op; directories are resolved from the module location (`tsx src/server.ts` and `node dist/server.js` behave identically), never from the current working directory. A present-but-unreadable env file fails startup safely with the fixed reason `Environment file could not be loaded` — paths, values and parser errors are never logged. Manual composition still works, e.g. `node --env-file=.env.local dist/server.js`. See the root `.env.example` to create your local keys file; `OLLAMA_API_KEY` is still read only through `process.env` after hydration.

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | `{ status: "ok" }`, no details. |
| `POST` | `/api/agents/:slug/chat` | Send the newest user `UIMessage` (exact `{ id, message }` + optional `mode: 'plan' \| 'action'`, default `action`). Slugs: `general` (calculate-only, unchanged), `orchestrator`, `analyst`, `researcher` — the Phase 4 roster requires the agent runtime to be wired (otherwise only `general` is servable, byte-compatible legacy 404s). Depth is resolved ONLY from the verified `X-Workforce-Delegation-Context` header; client body fields like `depth` are rejected (400). |
| `GET` | `/api/agents/:slug/chat/:clientChatId` | Hydration: `{ messages: UIMessage[], hasActiveStream: boolean }`, `Cache-Control: no-store`. |
| `GET` | `/api/agents/:slug/chat/:clientChatId/stream` | Resume the active stream; `204` when none; full replay otherwise. |
| `POST` | `/api/agents/orchestrator/delegations` | Create a tracked delegation (`{parentChatId, parentMessageId, target, task, mode}`). Signed internal context required (400 without); child depth `parentDepth+1` — 3+ → 403. Sync waits for the run and returns `201 { delegation, childChatId }`; async enqueues on `workforce-delegation` and returns `202 {…, status:'pending'}`. |
| `GET` | `/api/agents/:slug/delegations?parentChatId&limit` | List a parent chat's delegations, newest first. |
| `GET` | `/api/agents/:slug/delegations/:delegationId` | Status + result/error + child chat id. |
| `POST` | `/api/agents/:slug/delegations/:delegationId/run` | INTERNAL: signed create/run context required. `pending → running → completed/failed/timeout`; running/terminal rows are returned unmolested (no second child generation — retries are safe). |
| `GET` | `/api/agents/:slug/work-docs?scope&chatId&limit` | List documents (newest first). |
| `POST` | `/api/agents/orchestrator/work-docs` | Create (agent-sourced): `{chatId, type, title, content}` → version 1 draft + v1 snapshot + creation revision. |
| `GET` | `/api/agents/:slug/work-docs/:id?chatId=` | One doc + recent versions + links; ownership enforced (wrong chat → 404, no existence oracle). |
| `PATCH` | `/api/agents/:slug/work-docs/:id` | USER metadata-only `{chatId, expectedVersion, title?, status?}` via CAS (content is versioned elsewhere). |
| `POST` | `/api/agents/orchestrator/work-docs/:id/versions` | Agent content/title/status updates via CAS (`{chatId, expectedVersion, content, title?, status?, summary?}`) — the `write_doc` update path. |
| `GET` | `/api/agents/:slug/work-docs/:id/versions` | Immutable version list (bounded). |
| `GET` | `/api/agents/:slug/work-docs/:id/versions/:version` | One immutable snapshot. |
| `POST` | `/api/agents/:slug/work-docs/:id/rollback` | `{chatId, expectedVersion, toVersion, summary?, source?}` — copies the OLD snapshot into a NEW current version; history never rewritten. |
| `GET` | `/api/agents/:slug/work-docs/:id/revisions` | Audit trail (source, actorId, from/to, summary). |
| `POST` | `/api/agents/:slug/work-docs/:id/links` | Add a typed link (`{targetType, targetId, label?}`), idempotent per (doc, type, target). |
| `GET` | `/api/agents/:slug/work-docs/:id/links` | List typed links. |
| `POST` | `/api/agents/:slug/data/query` | `query_data`: `{query, limit?}` — one SELECT/WITH statement, read-only transaction, statement timeout, row cap (`cap+1` → 400). Served only for slugs whose composition includes `query_data` (`orchestrator`, `analyst`; others 404). Success: `{ columns, rows, rowCount, truncated }`. |
| `POST` | `/api/memory/blocks` | Write a memory block (optionally superseding one), enqueue its embed job. `201 {block}`. |
| `GET` | `/api/memory/blocks` | List blocks, newest first. `scope`, `path` (prefix), `kind`, `keyword`, `includeSuperseded`, `limit` (1..100, default 20). `200 {blocks}`. |
| `POST` | `/api/memory/search` | Hybrid semantic search: `query` (+ optional `scope`, `path`, `kind`, `limit`). `200 {results}` with `cosineSimilarity`, `recencyScore`, `score`. |
| `GET` | `/api/memory/blocks/:id/related` | `{ block, outgoing, incoming }` — relation edges, each with its neighbor block. |
| `POST` | `/api/memory/blocks/:id/retry` | Requeue the embedding job of a `pending`/`failed` block. `202 {status:"queued", blockId}`; `409` when already `ready`. |
| `POST` | `/api/memory/compact` | Enqueue compaction for one exact `(scope, path)`. `202 {status:"queued", scope, path, triggerBlockId}`. |

Agent routes (`agents.runtime`) are registered ONLY when `buildApp` receives
`agents:` deps (production `src/server.ts` always does); memory routes only
with `memory: { service, queue }`. Without them the paths 404 — chat-only
callers and the Phase 2 tests are unaffected.

### POST contract

- `Content-Type: application/json` (else 415).
- Body **exactly**: `{ "id": "<chatId>", "message": <one newest user UIMessage> }`
  — additional wrapper keys are rejected. IDs: `1–64` chars of `A-Za-z0-9_-`.
- Header `Idempotency-Key: <chatId>:<messageId>` — required (400 when missing or
  mismatched), validated, scoped to the chat in Redis. The server enforces the
  key equals `id` + `message.id`.
- Duplicate submit → `409` and **no second model invocation**. A duplicate *user
  message id* (any key) → `409` as well.
- Errors are always JSON `{ "error": "<fixed safe message>" }` — no provider
  bodies, no stacks, no secrets. Malformed JSON → fixed 400; bodies over 256kb →
  fixed 413.

### Turn lifecycle

1. Validate slug/ids/body/header (404 for unknown slug, 400 for bad shape).
2. Load stored messages (Redis 503 on failure, including single corrupt list
   entries). Duplicate user id → 409.
3. Validate the **complete appended conversation** with `validateUIMessages` +
   `convertToModelMessages` before anything durable: an invalid newest message
   → fixed **400** (no key acquired, nothing appended, no provider work), corrupt
   stored history → fixed **503**.
4. `SET NX EX 900` the idempotency key **before any provider work** → 409 on clash.
5. Append the validated user message **atomically** (one RPUSH — not a
   whole-list rewrite) before generation. Pre-stream failures release only the
   just-acquired key.
6. `createUIMessageStream` (persistence mode, server-generated `msg_*` assistant
   ids via `generateId`) wrapping `streamText`; the resumable copy is pumped by a
   tracked background task (Express has no Next `after()`).
7. On completion: **append exactly the new response message** (with streamed
   text and tool parts) — never a whole-list overwrite, so concurrent turns
   cannot delete each other's messages — and clear the active stream id **only
   if it equals this stream's id** (atomic Lua compare-and-del). Once streaming
   starts the idempotency key is never released — retries go through resume.

## Phase 4 behaviors (multi-agent)

- **Composition (ADR-001)** — tools are selected ONCE per generation by
  `composeAgentCapabilities(slug, mode, depth, registry)`. Plan mode omits
  `write_doc`/`delegate_task` entirely; `delegate_task` is absent at depth ≥ 2;
  workers (`analyst`, `researcher`) never compose write/delegation tools;
  `general` stays calculate-only with no system prompt (Phase 1-2 bit-for-bit).
- **Transcript validation** — stored `UIMessage`s are validated/converted
  against the agent's FULL action-set at depth 0 (mode/depth-independent), so
  an action-mode transcript stays valid after a plan switch; the GENERATION
  toolset remains the composed (filtered) one.
- **Trusted depth (ADR-004)** — depth travels ONLY in
  `X-Workforce-Delegation-Context`: `base64url(payload).base64url(hmac)` over
  `{kind, parentChatId, childChatId?, targetAgent?, depth, expiresAt, …}`,
  HMAC-SHA256 with `DELEGATION_CONTEXT_SECRET` (or a per-boot random secret +
  `delegation-context-secret-ephemeral` warning). Invalid/expired/forged →
  fixed 400; a verified context claiming depth 3+ → 403. Client body fields
  are never consulted for depth. All internal headers/payload bytes are never
  logged.
- **HITL `ask_user`** — composed WITHOUT `execute`; the model turn ends with a
  persisted `input-available` question (no `stop()` anywhere). Before the next
  user turn is appended, pending questions are atomically resolved (byte-exact
  compare-and-set of ONE list entry — `LINDEX` equality + `LSET` in Redis, no
  `cjson` anywhere; the SAME raw-entry algorithm backs the in-memory store) to
  `output-available`: the NEWEST pending question receives the newest user
  text, every OLDER pending question receives the bounded sentinel
  `(no answer given)` — before validation/conversion, after idempotency
  acquisition, so invalid inputs never mutate the questions and duplicate
  submits never double-answer. User messages stay append-only forever.
- **Same-REST delegation** — sync `delegate_task` (tool) and the async worker
  both POST `POST /api/agents/orchestrator/delegations/:id/run`; that route
  verifies the signed context, persists the row (`pending → running`), then
  calls the child chat exactly like a human client would
  (`POST /api/agents/{target}/chat`, `Idempotency-Key`, signed child context,
  action mode) and consumes its UI SSE with the AI SDK's
  `parseJsonEventStream` + `uiMessageChunkSchema`. There is no shadow child
  runner anywhere; children are real chats at `/chat/:childChatId`. The
  bounded `DELEGATION_TIMEOUT_MS` deadline aborts the child fetch
  (`timeout` status) — browser disconnects still never abort any generation.
- **Worker lifecycle** — the `workforce-delegation` BullMQ worker (max 2,
  attempts 3, exponential backoff, deterministic `delegation-<id>` job ids)
  starts inside the API like the memory worker and closes with the same
  shutdown order (HTTP → background drain → workers → queues → Postgres →
  Redis). Row-level idempotency is now an ATOMIC claim
  (`updateStatus { expectedFrom: 'pending' }` compare-and-set through the
  repository), so concurrent runners — sync tool, create-wait, worker retries —
  yield exactly ONE running claim and ONE child generation; losers receive the
  untouched row (`executed: false`). A `running` row beyond the delegation
  budget is treated as stale and recovered from the child chat's durable
  transcript (`completed` with the recovered answer, or `failed`) — never a
  duplicate generation, never a permanent wedge. The child user message id is
  derived from the delegation id, so the child `Idempotency-Key` is stable
  across every retry.

## Redis key layout

```
workforce:phase2:chat:{slug}:{chatId}:messages        # Redis LIST - one JSON UIMessage per entry (RPUSH/LRANGE), durable, no TTL
workforce:phase2:chat:{slug}:{chatId}:active-stream    # active stream id, EX 86400 (sentinel alignment), cleared on completion
workforce:phase2:idempotency:{slug}:{chatId}:{key}     # SET NX, EX 900s exactly
workforce:phase2:stream:*                              # resumable-stream checkpoints (24h)
```

Message contents are never logged by default.

## Memory pipeline (Phase 3)

```
POST /api/memory/blocks ──► MemoryService.writeBlock
        │ store.insertSupersedingBlock (commit FIRST, status `pending`)
        ├─► BullMQ queue enqueueEmbedding(blockId)      (fail → block marked `failed`, 503)
        └─► (count > 30 on the path?) enqueueCompaction (fail → logged, write stays valid)

Worker (concurrency 2, attempts 3, exponential backoff base 1000ms)
        ├─ kind:"embed"  → service.processEmbedding(blockId)   loads block, embeds, atomic `ready`
        └─ kind:"compact"→ service.processCompaction(scope, path, triggerBlockId)
                           re-runs under the store's path lock; idempotent skip when the
                           trigger is already represented; summary 1..1000 chars, sources superseded
```

- **Queue `workforce-memory`** with deterministic ids: `embed-<blockId UUID>` and
  `compact-<sha256(scope/path|triggerBlockId)>` (colon-free). Duplicates in
  `waiting`/`delayed`/`active`/`paused`/`completed` are no-ops; a `failed` job is
  genuinely requeued by `POST /retry` (remove + re-add under the same id) and by
  retried compaction jobs — never by claiming an old job is still scheduled.
  Completed jobs are kept (removeOnComplete age 7 days / 10k count) so dedupe
  stays honest while the set stays bounded. Startup PINGs the queue's Redis
  connection (bounded): a down Redis fails startup instead of serving 503s.
- **Local embedding provider**: Transformers.js `feature-extraction` on
  `Xenova/all-MiniLM-L6-v2` (384 dims), mean pooling + normalization, q8
  quantized weights on CPU. The library loads via a dynamic import on the
  FIRST embed only — server startup and offline tests never touch it, no API
  key needed. The model downloads once into `EMBEDDING_CACHE_DIR` on first
  use and is served from disk afterwards. The cache directory is forwarded
  BOTH as the pipeline's `cache_dir` option AND the module's `env.cacheDir`
  (Transformers 4.3.2 ignores the per-pipeline `env` object, so the explicit
  `cache_dir` is what keeps downloads out of node_modules). A failed import
  or pipeline load resets the lazy singleton, so the next embed retries
  without a process restart.
- **Compactor**: `generateText` against `OLLAMA_MODEL` with ONE shared abort
  signal (`AbortSignal.timeout(120_000)`, created before the first call) for
  at most TWO calls — a first summary, then exactly one shortening repair if
  the first draft exceeds the hard limit — so total compaction provider work
  stays inside 120s while compaction holds the store's path lock; the repair
  call sends only the overlong draft, never the source blocks. Both calls use
  `providerOptions` `{ ollama: { reasoningEffort: 'low' } }` — glm-5.3-flash
  keeps reasoning ALWAYS ON and `low` is the documented minimal effort (the
  first live attempt without it spent the full 120s budget reasoning and all
  3 BullMQ attempts timed out); `maxOutputTokens: 8000` (reasoning tokens
  share the same output budget) + `temperature: 0.2` for deterministic
  summaries; the prompt asks for a plain-text synthesis of the current
  conclusions, corrections, decisions, preferences, and uncertainty (target
  500-700 chars, hard `<= 1000`) with redundancy omitted. The output is
  validated on both calls with fixed codes (`COMPACTION_OUTPUT_TOO_LONG`
  after an overlong repair, empty-output codes per finish reason); text is
  never truncated and `reasoningText` is never used. No JSON/structured
  output/tool calls. The core service trims/validates and supersedes the 30
  oldest blocks.
- **Honest statuses**: a block is `pending` → `ready` only on a store commit;
  provider/queue failures mark it `failed`. `POST /retry` 202 means the job
  was queued, nothing more; the block stays `failed` until a worker run
  actually succeeds.
- **Migrations are never run by the API** — not at startup, not per request.

### Memory error contract (fixed strings, no internals)

| Failure | Response |
|---|---|
| Validation (`MemoryValidationError`) | `400 "Invalid memory request."` |
| Unknown block (`MemoryNotFoundError`) | `404 "Memory block not found."` |
| Conflicts (already superseded / already ready) | `409 "Memory conflict."` |
| Queue enqueue/requeue failure (`MemoryQueueError`) | `503 "Memory queue is temporarily unavailable."` |
| Embedding/compaction/store/Prisma/unexpected | `503 "Memory service is temporarily unavailable."` |

Core issue strings, submitted content, DB/provider bodies, URLs, and stacks
never reach a response; logs carry safe types and identifiers only.

## Module layout

```
src/config.ts            env validation (values never included in errors); DATABASE_URL + EMBEDDING_CACHE_DIR (Phase 3)
src/env.ts               gitignored env-file hydration before config (.env/.env.local, app+root; shell values win)
src/ids.ts               server-generated message/stream ids (createIdGenerator)
src/messages.ts          calculate tool + validateAndConvertMessages
src/generation.ts        one chat turn: streamText → UIMessage stream → persistence
src/http/routes.ts       the four chat routes
src/http/adapter.ts      Web Response → Express/Node streaming adapter
src/background.ts        tracked background promises (waitUntil replacement)
src/store/               ChatStore interface, Redis store, in-memory store
src/stream-context/      StreamContext interface, resumable-stream adapter, memory impl
src/memory/routes.ts     the six memory routes (registered only when memory deps are injected)
src/memory/embedding.ts  local Transformers.js embedding provider (dynamic import, lazy singleton)
src/memory/ollama-compactor.ts  MemoryCompactor over generateText (plain-text summary prompt)
src/memory/bullmq-queue.ts      BullMQ queue adapter + deterministic job ids + requeue state machine
src/memory/worker.ts     BullMQ worker (concurrency 2), delegates to MemoryService
src/server.ts            the ONLY side-effectful module (startup + shutdown + memory wiring)
src/...                  everything else is pure and import-safe
```

Dependency-injection: `buildApp({ config, store, streamContext, model, background })`
runs the whole app with injected fakes — used by the tests (`test/*.test.ts`)
with `ai/test`'s `MockLanguageModelV3`, an in-memory `ChatStore`, and an
in-memory `StreamContext`. No test talks to Ollama, Redis, or any network.

## Run against a live stack

From the repo root, start Redis; then run the API with its env file:

```sh
docker compose up -d redis                        # or: npm run dev:redis (repo root); add `postgres` (or npm run dev:infra) for the memory pipeline
node --env-file=.env.local npm run dev            # requires @workforce/core dist/ (see note below)
# then:
curl -X POST http://localhost:3001/api/agents/general/chat \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: chat-demo:m-1' \
  -d '{"id":"chat-demo","message":{"id":"m-1","role":"user","parts":[{"type":"text","text":"What is 21+21?"}]}}'
curl http://localhost:3001/api/agents/general/chat/chat-demo
```

`npm run dev` resolves `@workforce/core` from its `dist/`; if it is missing, build it once from the repo root with `npm run build --workspace @workforce/core` (the root `npm run dev` / `test` / `build` targets do this automatically).

## Integration tests against real Redis (test-live)

The offline suite (`npm test`) never touches Redis. A separate, opt-in live
suite exercises the **production** Redis chat store and the **production**
resumable-stream adapter over three real node-redis connections through the
real Express app, with the same deterministic mock model the offline tests use
(`ai/test`'s `MockLanguageModelV3` + `simulateReadableStream` — **no real
Ollama request is ever made and no API key is needed**).

```sh
docker compose up -d redis                         # from the repo root
npm run test:integration --workspace @workforce/api
npm run typecheck:integration --workspace @workforce/api
```

- Without a reachable Redis the suite fails fast with that same instruction.
- It covers the full lifecycle over the real stack: real SSE + client
  disconnect (model keeps generating), duplicate-key 409 with a single model
  invocation, full replay resume through real Redis pub/sub with no duplicated
  text, post-completion hydration + 204, the message LIST, SET NX EX900
  idempotency, and the EX86400 compare-and-delete active marker.
- Keys are run-scoped (`workforce:phase2:stream-live-test:<runId>`,
  `live-chat-<runId>` ids) and cleanup deletes exactly the keys the run created
  — no `SCAN`/`FLUSH` of the shared database.
- Keep this suite out of CI pipelines that lack the Redis service; it is
  opt-in on purpose.

## Notes for apps/web

- `DefaultChatTransport` with `prepareSendMessagesRequest` sending `{ id, message }`
  and per-request header `Idempotency-Key: chatId:messageId`; `resume: true`
  reconnect URL `GET /api/agents/:slug/chat/:clientChatId/stream`.
- CORS exposes `Idempotency-Key`, allows only `WEB_ORIGIN`.
- Mid-stream provider failures arrive as a safe `error` chunk; the UI survives.
- Malformed JSON → fixed 400 `Malformed JSON request body.`; bodies over 256kb →
  fixed 413 `Request body is too large.`

## Known limitations (Phase 2, fixed design)

- **No process-restart replay claim**: resumable-stream checkpoints are
  process-local; durable per-message persistence + hydration is what a client
  uses after a server restart. Mid-flight SSE replay after a restart is not a
  guarantee this API makes.
- resumable-stream 2.2.13 pumps its checkpoint copy through an internal
  `reader.read().then(...)` chain without a `.catch`, so a Redis failure inside
  that pump surfaces as an unhandled rejection. `src/server.ts` installs a safe
  `process.on('unhandledRejection')` handler (logs error-type only, keeps the
  process alive). This containment does **not** repair a dropped checkpoint
  chunk — an affected replay stops at the last recorded chunk.
- Post-crash stale producers: resume treats `Timeout waiting for ack` like a
  dead stream — compare-and-delete the (24h-TTL'd) active marker and answer
  204, so the client falls back to hydration.

## Live integration suites (opt-in, no Ollama, no API key)

### 1. Real memory pipeline — `npm run test:integration` (workspace: `apps/api`)

`test-live/*` runs three real-stack suites — the root runner totals **23 tests**
(3 Phase 2 Redis streaming + 11 memory + 9 Phase 4), passed twice with exact
per-run cleanup:

- `redis-stream.test.ts` — the Phase 2 chat/resume stack over real Redis.
- `memory.test.ts` — the Phase 3 pipeline: real Prisma + pgvector Postgres,
  real `createPostgresMemoryStore` (session advisory locks on a dedicated
  pg.Client), real BullMQ queue + worker over real Redis, and the real
  `MemoryService`. Embedder and compactor are deterministic mocks (a
  keyword-axes 384-dim embedder and a 700ms-delayed mock compactor) — no
  Transformers, no Ollama.
- **Phase 4 multi-agent tests** — real Prisma WorkDocs (create, CAS updates,
  browser-style user-source updates, rollback with immutable history,
  concurrent idempotent links), sync delegation through the same REST chat
  contract, async delegation over the real BullMQ queue with the atomic
  `expectedFrom: 'pending'` single-claim (exactly one execution) and
  stale-`running` recovery, real-Redis `ask_user` byte-CAS resolution
  (preserving `options: []` and huge numeric byte payloads, plus stale
  resolutions), and `query_data` over real Postgres (rollback/discard,
  statement timeout, row cap, dangerous-function rejection). Models stay
  mocked — **no real provider anywhere**.

Prerequisites:

```sh
docker compose up -d redis postgres   # both must be reachable
npm run db:migrate                    # once per fresh database (the root
                                      # `pretest:integration` hook runs it for
                                      # `npm run test:integration` at the repo root)
```

Isolation and cleanup are exact per run: a unique scope and a unique queue
(`workforce-memory-test-<runId>`); teardown closes worker → queue → Prisma in
bounded steps, deletes exactly the run's rows (parameterized, by scope) and
obliterates exactly the run's queue. Never FLUSHDB, never other scopes/queues.
Retry timing is a TEST-only option (`backoffBaseMs` 250ms); production stays at
1000ms with attempts 3.

### 2. Real local embedding smoke — `npm run test:embedding` (workspace: `apps/api`)

`test-embedding/local-embedding.test.ts` exercises the REAL
`createLocalEmbeddingProvider` (Transformers.js, `Xenova/all-MiniLM-L6-v2`,
384 dims, q8 CPU). The FIRST run downloads the model from HuggingFace into the
project-local gitignored cache `apps/api/.cache/workforce-models` (~30MB
quantized); the cache persists and later runs load from disk (~seconds). No
API key. Assertions: exactly 384 finite values, L2 norm ≈ 1, byte-for-byte
determinism, related-sentence cosine clearly above unrelated text. This suite
is intentionally NOT part of `npm test` / `test:integration` — offline suites
never download or load the model.

### 3. Memory demo seeder — `npm run demo:memory` (workspace: `apps/api`)

`scripts/seed-memory-demo.ts` drives a RUNNING dev server (with Farhan's real
key in the server process) over plain HTTP. The script reads NO Ollama key and
runs no models: embeddings come from the worker's local MiniLM, and the single
real Ollama call is the server-side compaction the 31st write triggers.

| Env | Default | Meaning |
|---|---|---|
| `WORKFORCE_API_URL` | `http://localhost:3001` | API base the script talks to |
| `DEMO_SCOPE` | `demo` | demo scope |
| `DEMO_PATH` | `compaction/small-models` | demo path (refuses a path that already holds blocks) |

Behavior: preflight GET (`includeSuperseded=true`, limit 100) decides a RESUME
branch instead of appending:

- **Ready 30-source summary** → reports success and exits; no writes, no jobs.
- **Summary present but embedding pending/failed** → requeues ONLY that
  embedding (`POST /api/memory/blocks/:id/retry`, once) and polls; never a
  second compaction.
- **No summary, blocks pending** → polls until ready first, then queues ONE
  fresh compaction (`POST /api/memory/compact`, exactly one call, new random
  trigger) when >30 active blocks exist — resumed runs retry the timed-out
  provider attempt without appending blocks (live case: 31 ready, no summary →
  rerun `npm run demo:memory`).
- **`failed` blocks** → clear nonzero exit with retry guidance (UI or
  `/api/memory/blocks/:id/retry`).
- **≤30 active without a summary** → safe refusal (partial demo set; the
  seeder never appends).
- **Unrecognized shapes / foreign `learning` content** at the path → safe
  refusal, existing data untouched.

Empty path → the original first run: 31 sequential observation POSTs.
Bounded poll overall (180s across ALL stages, 2s interval, 10s per-request
abort) until the summary is `ready`; timeout messages point at the API logs /
`/memory` UI and never imply data loss — every state is resumable by rerunning
the seeder. Sources are retained and NOT cleaned up — the demo exists so the
`/memory` UI can show the summary next to its 30 superseded sources.

Live steps: `npm run dev:infra` → put `OLLAMA_API_KEY` in `.env` (optional export works too, shell wins) →
`npm run dev` → separate terminal `npm run demo:memory` → open
`http://localhost:3000/memory`, browse `demo`/`compaction/small-models` with
"include superseded" on, inspect the summary and its 30 sources, then run the
basic create/search/correction checks. See the root README for the same
walkthrough.
