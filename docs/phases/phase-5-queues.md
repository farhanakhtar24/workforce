# Phase 5 — Queues & Schedulers

**Duration**: 1 week
**Goal**: Agents that run while you sleep — recurring tasks, retries, idempotency, dead-letter handling.

> **Status: 🚧 Active — implemented and integration-tested; live real-provider browser gate PASSED 2026-11-24 (orchestrator) — awaiting Farhan's explicit approval; NOT validated.** Design fixed 2026-11-23 ([ADR-006](../decisions/ADR-006-bullmq-scheduler.md) accepted) after Phase 4 was validated the same day — Farhan explicitly approved the already-recorded live browser gate ("yes next phase pls"). Implementation is in place across `packages/core`, the new `packages/queue` workspace, `apps/api` and `apps/web`: **757 green offline tests** (core 243, `@workforce/queue` 47, CLI 30, API 299, web 138; root typecheck passes; the prior production build passed and was not re-run while the dev server was active) and the real-infrastructure suite **34/34 with 0 skips** (23 previous + 11 scheduler) — green five consecutive times after the initial fixes and twice more after the `nextRunAt` fix. The real-provider browser gate **ran and PASSED on 2026-11-24**: API + web + the standalone scheduler worker via saved env (no key inspected or printed); manual Run-now, an **automatic** `ONCE` run, and an **automatic** `CUSTOM_CRON` run all finished **COMPLETED attempt 1** — full record below. **Phase 5 is NOT complete until Farhan explicitly approves this gate.**

---

## What gets built in this phase

Where it lives (built with the originally planned `packages/queue` home; the existing memory and delegation queues **did not move**):

- **Domain + persistence — `packages/core/scheduler`**: `AgentTask` + `AgentTaskExecution` domain contracts, in-memory unit store, Prisma adapter + migration (same Postgres stack as memory); recurrence validation, next-run computation and skip-date iteration via **croner** (no hand-written cron parsing).
- **Queue adapter — `packages/queue/scheduler` (workspace `@workforce/queue`, 47 offline tests)**: the `workforce-scheduler` BullMQ queue — Job Scheduler upsert/remove, `ONCE` adds, manual/retry execution jobs.
- **API composition + REST routes — `apps/api/src/scheduler`**: the `/api/scheduler` routes; the API process produces and syncs schedules and reconciles schedulers at startup.
- **Worker — `apps/api/src/scheduler-worker.ts`**: owns **only** the scheduler BullMQ Worker and invokes the API's **own REST** (no shadow provider runner). Needs Redis + internal API base URL only — **no provider key**. Graceful bounded close and recovery.
- **Web — `apps/web` `/schedules` dashboard**: task create/list/edit, activate/pause, run now, execution views, dead-letter retry.
- **Dev topology**: root `npm run dev` runs `concurrently api + web + scheduler`; standalone `npm run dev:scheduler` runs only the scheduler worker. The existing memory (`apps/api/src/memory`) and delegation workers are unchanged.

---

## Topics to self-assess

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 5.1 | Why queues exist (sync vs async, HTTP timeouts, long jobs) | _ | |
| 5.2 | BullMQ fundamentals (producers, workers, retries, backoff) | _ | |
| 5.3 | BullMQ Job Schedulers (`upsertJobScheduler` templates, UTC patterns, library-owned repeat job ids) | _ | |
| 5.4 | Two-process topology (API vs scheduler worker — why separate) | _ | |
| 5.5 | Job idempotency (unique execution rows + atomic claims — not just Redis locks) | _ | |
| 5.6 | Dead Letter Queue (when retries exhaust — status rows + retained failed jobs, no second queue) | _ | |

---

## Fixed design

### `AgentTask` (domain model — Prisma in `packages/core/scheduler`)

| Field | Shape / values |
|---|---|
| `id` | UUID |
| `name` | Human label |
| `agentSlug` | `general` \| `orchestrator` \| `analyst` \| `researcher` |
| `mode` | `plan` \| `action` |
| `prompt` | The prompt sent as the run's user message |
| `scope` | Single-tenant `default` |
| `recurrenceType` | `ONCE` \| `DAILY` \| `WEEKLY` \| `MONTHLY` \| `CUSTOM_CRON` |
| `recurrenceConfig` | JSON — `ONCE`: `runAt`; `DAILY`: `hour`/`minute`; `WEEKLY`: `hour`/`minute`/`weekdays`; `MONTHLY`: `hour`/`minute`/`daysOfMonth`; `CUSTOM_CRON`: **exactly five** cron fields (minute hour day-of-month month day-of-week) |
| `skipDates` | `YYYY-MM-DD[]` — occurrences on these dates are recorded `SKIPPED` |
| `isActive` | Activate/pause; deactivate removes the scheduler |
| `timezone` | **UTC only** in Phase 5 |
| `nextRunAt` | Nullable — computed next occurrence |
| `createdAt` / `updatedAt` | Timestamps |

Phase 5 constraints: **no seconds field** in cron or schedule configs, **no arbitrary timezones** (UTC only), **no catch-up/backfill** of missed occurrences.

### `AgentTaskExecution` (audit row per run)

| Field | Shape / values |
|---|---|
| `id` | UUID |
| `taskId` | Owning `AgentTask` |
| `scheduledFor` | The occurrence instant this row realizes |
| `trigger` | `SCHEDULED` \| `MANUAL` \| `RETRY` |
| `status` | `PENDING` \| `RUNNING` \| `RETRYING` \| `COMPLETED` \| `FAILED` \| `DEAD_LETTER` \| `SKIPPED` |
| `attempt` / `maxAttempts` | Attempts up to **3** |
| `durationMs` | Run duration |
| `tokenUsage` | Nullable JSON — captured **when the provider/UI metadata makes it available**; nullable otherwise, **never fabricated** |
| `error` | Safe, bounded error text |
| `chatId` | **Unique**; every execution gets an **isolated chat** (`chatId = execution.id`) so a recurring task never accumulates unbounded context |
| `queueJobId` / `repeatJobKey` | Nullable, unique — BullMQ linkage |
| `retryOfExecutionId` | Nullable — a `RETRY` execution links to its `DEAD_LETTER` predecessor; the old terminal row is immutable and the retry starts a fresh isolated chat |
| `createdAt` / `updatedAt` | Timestamps |

### Scheduling — BullMQ Job Schedulers (ADR-006)

- **Recurring tasks**: `queue.upsertJobScheduler(task.id, { pattern, tz: 'UTC' }, template)` — the scheduler id is the task id; every produced occurrence inherits the template, which carries `taskId`. **Scheduler-generated repeat job ids are library-owned, never custom.**
- **`ONCE` tasks**: `queue.add` with a deterministic colon-free `once-<taskId>` job id and a `delay` computed to `runAt` (colon-free id — the earlier design wording `once-task:<id>` was stale; see the integration fixes below).
- **Manual and retry executions**: deterministic job ids `execution-<uuid>`.
- **Task lifecycle**: create/edit/activate → idempotent `upsertJobScheduler` sync; deactivate (`isActive: false`) → scheduler removed, and an **already-produced** occurrence is recorded `SKIPPED` without a provider call; `skipDates` occurrences are recorded `SKIPPED`.
- **Startup reconciliation**: the API process reconciles active tasks' schedulers on boot (idempotent upsert), listing at most the newest 100 tasks (`SCHEDULER_LIST_LIMIT_MAX`). Adds nothing for a null `nextRunAt`, so a consumed ONCE schedule is never re-added.
- **nextRunAt metadata advancement**: when an occurrence is materialized (or deduped onto its unique execution row), the API advances `task.nextRunAt` — `null` for `ONCE`, otherwise `computeNextRunAt(..., { after: occurrence, skipDates })` — under an exact-instant guard (only while the stored value equals the delivered occurrence instant, so duplicates and concurrent edits never overwrite). The run path never calls `queue.syncTask`; `nextRunAt` is UI/reconcile metadata only, and **no catch-up/backfill** semantics change. A skip-dated delivery is `SKIPPED` and legitimately fails the guard (the stored value already points past the skipped instant).
- **No catch-up/backfill** of missed occurrences in Phase 5.

### Topology — separate scheduler worker

- The **API process** produces and syncs schedules (task CRUD → upsert/remove schedulers; startup reconciliation).
- `apps/api/src/scheduler-worker.ts` owns **only the scheduler BullMQ Worker** and invokes the **own REST** routes for every run — the same chat path the UI uses (ADR-002 across processes). No provider code, no provider key in the worker.
- Root `npm run dev` runs **`concurrently` api + web + scheduler**. Existing memory/delegation workers unchanged.
- The worker uses **graceful bounded close** (stop intake → drain in-flight → close connection) and **recovery** (deterministic ids + BullMQ retries + the claim below): a killed worker recovers without a double-generated run.

### Run flow (scheduled occurrence)

1. BullMQ fires an occurrence; the repeat-job template carries `taskId`; the worker supplies BullMQ occurrence metadata (`prevMillis`, `timestamp`, `repeatJobKey`) to its own REST.
2. **Materialization is idempotent**: a **unique scheduled execution per `task + scheduledFor` (trigger `SCHEDULED`)** prevents duplicate rows under concurrent occurrence delivery.
3. **Atomic claim**: `PENDING | RETRYING → RUNNING` — **only one runner** ever proceeds; losers see the untouched row (conflict/no-op).
4. **Run**: the worker calls `POST /api/agents/:slug/chat` with `task.prompt` — chat message ids are **attempt-scoped**: `execution.id` on attempt 1, `execution.id-a<N>` on retry attempt *N* (same-attempt recovery reuses the attempt's own ids); `Idempotency-Key: execution.chatId:execution.id` (the same Phase 2 pattern); `mode = task.mode`. Every execution is its own isolated chat (`chatId = execution.id`). **No shadow provider runner.**
5. **Duplicate child POST → 409 recovered via durable hydration + the existing resume stream — never another generation.** A fresh running duplicate is a conflict/no-op; a **stale** running execution recovers the completed transcript or lands on retry/failure **without regenerating**.
6. `tokenUsage` is recorded only when the provider/UI metadata makes it available; nullable otherwise — never fabricated.

### Manual run & retry

- `POST /api/scheduler/tasks/:id/run` creates a **new execution** (trigger `MANUAL`) and enqueues an immediate `execution-<uuid>` job.
- Manual retry of a `DEAD_LETTER` execution creates a **new execution** (trigger `RETRY`, `retryOfExecutionId` linked); the old terminal row stays **immutable**, and the retry runs in a **fresh isolated chat**.

### Failure, retries, DLQ

- Attempts **3**, **exponential backoff base 1000 ms**.
- Transient failure while attempts remain → `RUNNING → RETRYING`; attempts exhausted → **`DEAD_LETTER`** (terminal).
- Nonretryable validation failure → **`FAILED`** (no retry).
- **DLQ view** = `DEAD_LETTER` execution rows + the **retained BullMQ failed jobs** (`removeOnFail: false`) — **no second queue**. Completed jobs use bounded retention.
- Execution duration, token usage, and the result chat links are visible per execution.

### Found and fixed during integration (real bugs)

Surfaced by the real-stack suites and fixed; every later run covered the fixes:

- **Prisma `DbNull` vs `JsonNull`** — nullable JSON columns need the explicit `DbNull`/`JsonNull` sentinels; the wrong sentinel broke writes to `null`-valued JSON fields (skipDates, tokenUsage).
- **Colon-free deterministic ONCE job id** — the once-job id is `once-<taskId>` (colon-free); the earlier documented `once-task:<id>` wording was stale.
- **In-memory dedupe order** — the in-memory unit store deduped occurrences in the wrong order; ordering fixed so duplicate occurrences collapse onto their unique execution row consistently.
- **Attempt-scoped chat message ids** — chat user-message ids are `execution.id` on attempt 1 and `execution.id-a<N>` on retry attempt *N*; same-attempt recovery reuses the attempt's own ids, so a recovered run hydrates the same transcript entries instead of minting new ones.
- **Guarded `nextRunAt` advancement** — `nextRunAt` advances only after occurrence materialization: `null` for `ONCE`, otherwise recomputed strictly **after** the materialized `scheduledFor`; the run path never calls `queue.syncTask`; no backfill.

### REST routes (`/api/scheduler`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/scheduler/tasks` | List tasks (+ `nextRunAt`, `isActive`) |
| POST | `/api/scheduler/tasks` | Create (croner-validated recurrence; activates the scheduler when `isActive`) |
| GET | `/api/scheduler/tasks/:id` | Detail + recent executions |
| PATCH | `/api/scheduler/tasks/:id` | Edit / activate / deactivate (delete optional — not required) |
| POST | `/api/scheduler/tasks/:id/run` | `MANUAL` run → new execution + immediate job |
| GET | `/api/scheduler/executions` | Execution list (filter by task/status) |
| GET | `/api/scheduler/executions/:id` | Detail: status, attempt, durationMs, tokenUsage, error, chat link |
| POST | `/api/scheduler/executions/:id/run` | INTERNAL — worker-run metadata; internal + idempotent occurrence materialize/run |
| POST | `/api/scheduler/executions/:id/retry` | `MANUAL` retry of a `DEAD_LETTER` execution |

- Fixed safe errors: **400** invalid payload/recurrence, **404** unknown id, **409** duplicate run/conflict, **503** Redis/Postgres/BullMQ unavailable. No secrets and no prompt/chat content in logs.
- **The browser never mints internal worker metadata** — occurrence metadata (`prevMillis`/`timestamp`/`repeatJobKey`) exists only inside BullMQ and the worker.

### Web `/schedules`

- Accessible task create / list / edit, activate-pause, run now — delete optional, not required.
- Recurrence fields with an explicit **UTC explanation**; `skipDates` picker.
- Execution views: status / duration / attempt / token usage / error / result chat links; **dead-letter retry**.
- Poll **only while active executions exist and the tab is visible**. Existing styles, no design system.

---

## Tests — recorded (2026-11-24)

- **Offline: 757 green** (core 243, `@workforce/queue` 47, CLI 30, API 299, web 138); root typecheck passes. The prior production build passed; **no further production build was run while the dev server was active** (not re-run for this record). Mocked unit coverage includes: recurrence validation per type (five-field `CUSTOM_CRON` only, no seconds), croner next-run + skip-date iteration, deactivate → already-produced occurrence `SKIPPED`, unique-execution constraints, atomic claim transition matrix, error taxonomy (`FAILED` vs `RETRYING` vs `DEAD_LETTER`).
- **Real integration: 34/34 with 0 skips** over real Redis/Postgres/BullMQ — the previous **23** (11 memory + 3 Phase 2 Redis streaming + 9 Phase 4) plus **11 scheduler** tests covering: real BullMQ task CRUD / startup reconcile / `ONCE` scheduling; manual **and** scheduled runs through the **own-REST chat** path; unique occurrence materialization; retries (success on attempt 3, exponential backoff); exhausted attempts → `DEAD_LETTER` with the **retained BullMQ failed job** retained in the DLQ view plus a **manual retry creating a NEW linked execution/chat**; pause/skip → `SKIPPED`; duplicate-occurrence recovery (one row, one generation); token-usage metadata nullable contract (never fabricated); and an **actual scheduler-child SIGKILL → stall → restart → resume, COMPLETED attempt 1, exactly one model generation**.
- Run history: **five consecutive green runs after the initial fixes**, then the `nextRunAt` advancement bug was found and fixed and the suite went green **twice more**.
- Claims scope: models mocked everywhere — **no real provider call in any test**; **no multi-process failover claimed beyond the tested stall recovery**; startup reconcile is the **first-100-tasks** documented bound.
- **The browser gate is not part of the automated suites** — see the record below.

---

## Validation record — live browser gate: PASSED by the orchestrator 2026-11-24 (awaiting Farhan's explicit approval)

**Setup honestly stated**: the orchestrator ran the **full real-provider stack** — API + web + the **standalone scheduler worker** (`npm run dev`) — with the saved env; **no key was inspected or printed**. Real provider calls occur server-side through the app. The browser tab (`browser:browser:agent:1795478292755-7`) remains on `/schedules`; all artifacts/history were kept for Farhan's walkthrough.

1. **Manual run**: task **"Phase 5 Manual Calculator Verified"** (`ea3a71d6-ea5f-4950-bb26-9d64f80c9430`) → browser **Run now** → execution `6bd1599e-a3b7-4ca6-b8d4-6dd16c482256` — **MANUAL COMPLETED**, attempt 1, **durationMs 1237**. The isolated chat used `calculate` **exactly once** and answered **42**. `tokenUsage: null` — **the provider omitted usage, so no token claim is made** (nullable contract exercised, nothing fabricated).
2. **Automatic `ONCE` run** — no human "Run now": task `2ddc25f6-d5f5-4e65-9ec9-e38a07d6122d` scheduled **2026-11-24T00:02:00Z** fired by itself → execution `ca9dd4c5-507a-4a36-97cd-b832e7cea67e` — **SCHEDULED COMPLETED**, attempt 1, **durationMs 687**, `queueJobId: once-2ddc…` (the deterministic `once-<taskId>` id). The isolated chat answered **`AUTOMATIC RUN OK`**. The dashboard then showed Next run **`— (none pending)`** — proving `nextRunAt` cleared after the occurrence.
3. **Automatic `CUSTOM_CRON` run**: task `0c0c7bde-dfd3-4e78-9900-d4c54e17840a`, cron `* * * * *` — **real BullMQ** delivered the occurrence for **2026-11-24T00:03:00Z** → execution `e08ba72f-20ca-4f45-b2e9-244d31d19f6e` — **SCHEDULED COMPLETED**, attempt 1, **durationMs 798**; the **library-owned repeat id / `repeatJobKey` persisted** (scheduler-generated, never custom). The isolated chat answered **`RECURRING RUN OK`**. The dashboard advanced `nextRunAt` to **00:04 UTC**; the task was **paused before that next occurrence — no second run**.
4. **UI checks**: Pause → `PAUSED`, Activate → `ACTIVE`, and an edit rename verified; the execution status filter worked; execution **chat links opened the isolated chats**; mobile cards and filters worked.
5. **Cleanup / honesty**: all three tasks were intentionally left **PAUSED after success** to avoid future provider charges; the artifacts remain for the walkthrough. **No fresh real-provider DLQ/retry was induced in the browser** — DLQ + retained-failed-job + manual-retry evidence stays with the integration suite (mocked models). No git mutations, no real key reads, and no Next production build occurred while the dev server was active.

Automation context (unchanged): offline **757 green** (core 243, `@workforce/queue` 47, CLI 30, API 299, web 138); real integration **34/34 with 0 skips**, passed repeatedly — including the **SIGKILL scheduler-worker recovery** (stall → restart → resume, COMPLETED attempt 1, exactly one model generation) and retry/DLQ/new-linked-execution coverage with mocked models.

**Artifact URLs** (localhost:3000):

- Dashboard: `/schedules`
- Manual execution chat: `/chat/6bd1599e-a3b7-4ca6-b8d4-6dd16c482256`
- Automatic ONCE chat: `/chat/ca9dd4c5-507a-4a36-97cd-b832e7cea67e`
- CUSTOM_CRON chat: `/chat/e08ba72f-20ca-4f45-b2e9-244d31d19f6e`

**Recorded 2026-11-24: the live real-provider browser gate PASSED — manual, automatic `ONCE`, and automatic `CUSTOM_CRON` runs each finished COMPLETED on attempt 1 with the scheduler machinery (unique occurrence, `once-<taskId>` id, library repeat id, guarded `nextRunAt`) visible in the dashboard. Awaiting Farhan's explicit approval — Phase 5 is NOT validated.**

### Rerun — orchestrator browser re-check (2026-11-24, later the same day)

Using the saved env, the orchestrator restarted the stack and ran the browser tests itself — a second live sample of the same criteria:

- `/schedules` → **Run now clicked once** on the paused task **"Phase 5 Manual Calculator Verified"** (`ea3a71d6-ea5f-4950-bb26-9d64f80c9430`) → **exactly one** new execution `374f115b-3eb0-492b-aa70-49ce7f39a057` — **MANUAL COMPLETED**, attempt **1/3**, duration **1336 ms**, at **2026-11-24 10:09 UTC**; the task history went **3 → 4** with no duplicates.
- Isolated chat `/agents/general/chat/374f115b-3eb0-492b-aa70-49ce7f39a057?mode=action`: `calculate` ran **once** → `(18 * 2) + 6 = 42`, with proper **Markdown / Thinking / Tool-activity** rendering.
- Back on `/schedules`: task + `COMPLETED` filters showed **exactly 2 manual runs** (1336 ms and the earlier 1237 ms); filters reset afterward.
- A mobile **390×844 screenshot** visually proved the task and execution cards render properly; the desktop table stays hidden on mobile (a DOM snapshot may expose hidden nodes — the **screenshot is authoritative**).
- Hygiene: filters reset, tasks remain **PAUSED** (no charges), stack/tab left running for Farhan; **no key read or printed**; **no production build** while the dev server was active; **counts unchanged — 757 offline, 34/34 integration** (the rerun is not a test-suite run).

---

## Validation gate for Phase 5

State as of 2026-11-24:

1. ✅ **Kill-a-worker recovery** — proven for real in the integration suite: scheduler child SIGKILL → stall → restart → resume, COMPLETED attempt 1, exactly one model generation.
2. ✅ **Live browser gate** — **PASSED by the orchestrator 2026-11-24** (full record above): manual Run-now, automatic `ONCE`, and automatic `CUSTOM_CRON` runs all COMPLETED attempt 1; `nextRunAt` clear/advance semantics and library repeat ids verified in the dashboard.
3. ✅ **Cron scenario** — completed and recorded in the browser gate: the **`CUSTOM_CRON`** task `0c0c7bde-dfd3-4e78-9900-d4c54e17840a` (`* * * * *`) ran through real BullMQ → execution `e08ba72f-20ca-4f45-b2e9-244d31d19f6e` **SCHEDULED COMPLETED** attempt 1, chat answered **`RECURRING RUN OK`**, `nextRunAt` advanced to 00:04 UTC, then the task was paused before a second run (full record above).
4. ⏳ **Farhan's explicit approval — the only remaining gate item.** The phase is **not validated** until Farhan explicitly approves.

---

## When done

→ After Farhan's explicit approval closes Phase 5, start [Phase 6 — Docker, Deploy, Observability](./phase-6-deploy.md)
