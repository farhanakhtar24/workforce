# ADR-006: BullMQ Job Schedulers over In-Process Cron, with a Separate Worker

**Date**: 2026-11-23
**Status**: Accepted
**Phase**: 5
**Deciders**: Mohd Farhan Akhtar

---

## Context

Phase 5 makes agents run while nobody is watching: `AgentTask` rows define recurring or one-shot agent prompts (`ONCE | DAILY | WEEKLY | MONTHLY | CUSTOM_CRON`), each execution needs a durable audit row (`AgentTaskExecution`), isolated chats, bounded retries, and a dead-letter view. Tasks must survive process restarts, never double-run under concurrent occurrence delivery, and stay observable in a `/schedules` dashboard.

Earlier phase notes said "BullMQ repeatable jobs" — that wording referred to the BullMQ job option of the same era. BullMQ's current, supported mechanism for recurring jobs is the **Job Schedulers** API (`queue.upsertJobScheduler`). A scheduling decision also fixes process topology: the API process should not run cron loops or schedulers inside itself alongside request handling.

---

## Problem

How do we schedule agent tasks so a missed or retried occurrence can never double-generate a chat run, survives restarts, and stays auditable — without hand-writing a cron engine and without a second queue?

---

## Options Considered

### Option A — In-process cron (node-cron / `setInterval` inside the API process)

**Description**: Schedule timers inside the Express API process; on each timer tick, materialize an execution and run the agent inline.

**Pros**:
- No new process; zero queue concepts for simple cases.

**Cons**:
- In-memory state dies with the process: restart loses schedules or double-fires after recovery; no multi-instance safety.
- Conflates API request handling with long agent runs (HTTP timeouts, blocking).
- Retries, backoff, dead-letter semantics are hand-built.
- Directly contradicts the Phase 3 precedent of durable BullMQ work on Redis.

### Option B — Postgres-based scheduler (pg-boss)

**Description**: Drive recurrence and execution from the Postgres database (a Postgres queue like pg-boss, or DB polling for due tasks).

**Pros**:
- Everything in one store; strong transactional guarantees between task and execution rows.
- One less piece of infrastructure in theory.

**Cons**:
- Adds a second queue/cron technology next to the BullMQ we already validate (memory + delegation queues) — one more Redis-like surface to operate and explain.
- Cron evaluation and pattern semantics would be reimplemented or borrowed into the DB layer anyway.
- We already run Redis everywhere (chat state, idempotency, streams) and it is a hard dependency.

### Option C — BullMQ Job Schedulers + separate worker process (chosen)

**Description**: A dedicated `workforce-scheduler` BullMQ queue. Recurring tasks are enqueued as **Job Schedulers**: `queue.upsertJobScheduler(task.id, { pattern, tz: 'UTC' }, template)` — the scheduler's id is the task id and every produced occurrence inherits the template (which carries `taskId`). The produced occurrence/repeat job ids are **library-owned** and never custom. `ONCE` tasks use a deterministic `once-<id>` `queue.add` with a delay; manual and retry runs use deterministic `execution-<uuid>` job ids. A **separate worker process** (`apps/api/src/scheduler-worker.ts`) owns only the scheduler BullMQ Worker and invokes the API's **own REST** routes (ADR-002 extended to processes). Domain persistence (`AgentTask` / `AgentTaskExecution` via Prisma) and recurrence math (validation, next-run computation, skip-date iteration) live in `packages/core/scheduler` using **croner** — no hand-written cron parsing. Idempotency is **execution-table-based**: a unique scheduled execution per `task + scheduledFor` (trigger `SCHEDULED`) collapses duplicate occurrence delivery, plus an atomic `PENDING/RETRYING → RUNNING` claim so exactly one runner proceeds. Retries: attempts 3, exponential backoff (base 1000 ms); exhausted attempts land `DEAD_LETTER`; the retained BullMQ failed jobs (`removeOnFail: false`) plus `DEAD_LETTER` rows are the DLQ view — **no second queue**. `isActive: false` removes the scheduler; an already-produced occurrence records `SKIPPED` without a provider call; `skipDates` occurrences also record `SKIPPED`. **No catch-up/backfill** of missed occurrences.

**nextRunAt is a UI/reconcile METADATA cache, advanced after occurrence materialization**: when `runScheduled` materializes (or dedupes onto) a unique scheduled execution, the API advances `task.nextRunAt` — `null` for `ONCE` (the schedule is consumed; startup reconcile must never re-add a dead once job), otherwise `computeNextRunAt(..., { after: occurrenceInstant, skipDates })`. The update is **guarded**: it only applies while the row's `nextRunAt` equals the delivered occurrence instant, so redelivered/older occurrences and concurrent human edits never overwrite an advanced value (racing deliveries that both pass the guard write the identical computed value — idempotent). The run path **never** calls `queue.syncTask` — BullMQ owns recurring schedules, and delivery must not upsert/reset them. The residual read→write window is milliseconds and scheduler-internal only. Skipped-instant deliveries (the queue cannot know skipDates) are `SKIPPED` and legitimately fail the guard — their metadata already points past the skipped instant.

**Pros**:
- Durable and restart-safe: BullMQ schedulers live in Redis (AOF on), the source-of-truth row set lives in Postgres; startup reconciliation upserts active tasks' schedulers.
- Proven retry/backoff/stalled-job machinery instead of hand-built timers.
- Separate worker keeps the API a request handler; the worker needs only Redis + the internal API URL — **no provider key** — and every run goes through the same chat REST path the UI uses (no shadow runner).
- `upsertJobScheduler` gives declarative add/update/remove of recurrence per task id, replacing legacy repeatable-job wording.

**Cons**:
- Scheduler-generated repeat job ids are not deterministic application keys, so occurrence identity cannot ride the job id — hence the execution-table uniqueness + atomic claim (the core consequence this ADR records).
- One more process to run and supervise (root `npm run dev` runs `concurrently api + web + scheduler`).
- Tradeoffs accepted: no seconds field, UTC-only timezones, no catch-up/backfill in Phase 5. `nextRunAt` is metadata advanced (guarded) after occurrence materialization — never a queue-sync trigger (see Description above). Startup reconcile lists at most the 100 newest tasks (`SCHEDULER_LIST_LIMIT_MAX`) and reconciles them idempotently; it adds nothing for a null `nextRunAt`, so a consumed ONCE schedule is never re-added.

---

## Decision

We chose **Option C**: **BullMQ Job Schedulers** (`upsertJobScheduler`, `tz: 'UTC'`, template carries `taskId`) on a dedicated `workforce-scheduler` queue, a **separate** scheduler-only worker process calling the API's own REST, **execution-table idempotency** (unique scheduled execution per `task + scheduledFor`, atomic `PENDING/RETRYING → RUNNING` claim) precisely **because scheduler repeat job ids are library-owned** and cannot be used as deterministic identity keys, retries (3 attempts, exponential backoff base 1000) exhausting into a `DEAD_LETTER` status whose rows + retained BullMQ failed jobs form the DLQ view with **no second queue**, and **no catch-up/backfill** of missed occurrences in Phase 5. Recurrence validation, next-run computation and skip-date iteration use `croner` in `packages/core/scheduler`. Phase 5 constraints: no seconds field, UTC-only timezones.

---

## Consequences

### Positive

- Recurring runs survive restarts; startup reconciliation restores every active task's scheduler.
- Exactly-once occurrence materialization and exactly-one runner are enforced by database constraints plus an atomic status claim — not by job-id tricks that BullMQ schedulers do not expose.
- The DLQ is a view over existing state (`DEAD_LETTER` rows + retained failed jobs); nothing new to operate.
- Every scheduled/manual/retry execution runs in its **own isolated chat** (`chatId = execution.id`) with the Phase 2 idempotency contract (`Idempotency-Key: execution.chatId:execution.id`) — recurring tasks never accumulate unbounded context, and duplicate child POSTs recover via durable hydration + the existing resume stream, never another generation.

### Negative

- Occurrence job metadata (`prevMillis`, `timestamp`, `repeatJobKey`) must travel through the worker to the internal REST route; the browser never mints it.
- A missed occurrence is missed (no backfill) — acceptable for a demo-grade scheduler, revisit later if needed.
- One more process in dev/deploy topology.

### Risks / Open questions

- Real-provider token usage availability per run: `tokenUsage` stays nullable and is captured only when the provider/UI metadata makes it available — never fabricated.

---

## Validation

- Mocked units: recurrence validation per type (five-field `CUSTOM_CRON`, no seconds), croner next-run/skip-date iteration, unique-execution constraints, claim transition matrix, error taxonomy (nonretryable validation → `FAILED`; transient → `RETRYING` → exhausted → `DEAD_LETTER`).
- Real Redis/Postgres/BullMQ integration: concurrent duplicate occurrence → one `SCHEDULED` row; retries then exhausted `DEAD_LETTER`; skip dates/pause → `SKIPPED` without provider; manual run/retry → new linked executions (`retryOfExecutionId`); worker killed mid-job → recovery with **no double generation**; `Idempotency-Key` 409 duplicate path on the isolated chat.
- Cron scenario: write a NEW cron expression from scratch for a fresh scenario.
- Real provider/browser scheduled orchestrator run via saved env later; Phase 5 is NOT complete until Farhan explicitly approves.

---

## References

- [BullMQ Job Schedulers](https://docs.bullmq.io/guide/job-schedulers)
- [BullMQ Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs)
- [Phase 5 — Queues & Schedulers](../phases/phase-5-queues.md)
- [ADR-002: Agents call own REST API](./ADR-002-same-rest-api.md) (the worker also calls the own REST — no shadow runner)
- [ADR-005: SSE + idempotency](./ADR-005-sse-idempotency.md) (the chat contract each execution inherits)
