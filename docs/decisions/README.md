# Architecture Decision Records

ADRs are the **why** behind technical choices. Each ADR is short (~1 page) and captures:

- The problem
- Options we considered
- The decision made
- Consequences (good and bad)

Write them **as you make the decision**, not at the end. Interviewers love them because they prove you *thought* about alternatives.

---

## Template

See [`ADR-TEMPLATE.md`](./ADR-TEMPLATE.md).

---

## Planned ADRs

| # | Title | Phase | Status |
|---|---|---|---|
| 001 | [Composition-time capability gating (not prompt-only)](./ADR-001-composition-gating.md) | 4 | 🟢 Accepted 2026-11-23 |
| 002 | [Agents call own REST API (no shadow API)](./ADR-002-same-rest-api.md) | 4 | 🟢 Accepted 2026-11-23 |
| 003 | [Memory tree + relations + compaction over flat memory / graph DB](./ADR-003-memory-tree.md) | 3 | 🟢 Accepted 2026-11-19 |
| 004 | [Depth cap at 2 (not 3) + same-REST child chats](./ADR-004-delegation-depth.md) | 4 | 🟢 Accepted 2026-11-23 |
| 005 | [SSE + idempotency vs. WebSockets](./ADR-005-sse-idempotency.md) | 2 | 🟢 Accepted 2026-11-17 |
| 006 | [BullMQ Job Schedulers over in-process cron](./ADR-006-bullmq-scheduler.md) | 5 | 🟢 Accepted 2026-11-23 (design fixed; Phase 5 not built yet) |
| 007 | [pgvector + local MiniLM embeddings](./ADR-007-pgvector.md) | 3 | 🟢 Accepted 2026-11-19 |
| 008 | [AI SDK UI message streams vs. custom protocol](./ADR-008-ai-sdk-ui-streams.md) | 2 | 🟢 Accepted 2026-11-17 |
| 009 | [Railway deployment (one public web origin, private API, pgvector template)](./ADR-009-railway-deployment.md) | 6 | 🟢 Accepted 2026-11-25 (design only; Phase 6 not validated) |

---

## ADR file naming

- `ADR-001-composition-gating.md`
- `ADR-002-same-rest-api.md`
- …etc

One file per ADR, in this folder.
