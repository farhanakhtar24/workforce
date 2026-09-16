# Phase 5 — Queues & Schedulers

**Duration**: 1 week
**Goal**: Agents that run while you sleep — recurring tasks, retries, idempotency, dead-letter handling.

> Status: **Not started**. Begin after Phase 4 validation passes.

---

## What gets built in this phase

`packages/queue/scheduler/` — BullMQ-based task scheduler:
- Recurrence types: `ONCE | DAILY | WEEKLY | MONTHLY | CUSTOM_CRON`
- `skipDates[]`, `isActive` flag
- BullMQ repeatable jobs + cron expression generation
- `AgentTaskExecution` audit row per run (status, durationMs, tokenUsage, error)
- Two-process topology: `apps/api/` and `apps/api/worker.ts` (or separate)
- Dead Letter Queue on failed jobs after retries exhaust

---

## Topics to self-assess

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 5.1 | Why queues exist (HTTP timeouts, long jobs) | _ | |
| 5.2 | BullMQ fundamentals (producers, workers, retries) | _ | |
| 5.3 | Repeatable jobs (cron expressions, timezone) | _ | |
| 5.4 | Two-process topology | _ | |
| 5.5 | Job idempotency (Redis locks, dedupe) | _ | |
| 5.6 | Dead Letter Queue (DLQ) — when, how | _ | |

---

## Build artifact spec

*To be detailed at phase kickoff.*

---

## Validation gate for Phase 5

I'll intentionally break the scheduler mid-job (kill a worker). You debug why the job isn't finishing, recover it, and explain how the idempotency guard prevented a double-run. Then: write a NEW cron expression from scratch for a fresh scenario I give you.

---

## When done

→ Start [Phase 6 — Docker, Deploy, Observability](./phase-6-deploy.md)
