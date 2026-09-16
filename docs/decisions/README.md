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
| 001 | Composition-time read/write gating | 4 | 🔴 Not written |
| 002 | Agents call own REST API (no shadow API) | 4 | 🔴 Not written |
| 003 | Memory tree over flat memory | 3 | 🔴 Not written |
| 004 | Depth cap at 2 (not 3) | 4 | 🔴 Not written |
| 005 | SSE + idempotency vs. WebSockets | 2 | 🔴 Not written |
| 006 | BullMQ over in-process cron | 5 | 🔴 Not written |
| 007 | pgvector over Pinecone | 3 | 🔴 Not written |
| 008 | AI SDK UI message streams vs. custom protocol | 2 | 🔴 Not written |

---

## ADR file naming

- `ADR-001-composition-time-gating.md`
- `ADR-002-agents-call-own-api.md`
- …etc

One file per ADR, in this folder.
