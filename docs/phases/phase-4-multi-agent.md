# Phase 4 — Multi-Agent Systems

**Duration**: 1-2 weeks
**Goal**: A team of agents that delegate to each other safely — sync and async — without runaway recursion.

> Status: **Not started**. Begin after Phase 3 validation passes.

---

## What gets built in this phase

Three agents in `packages/core/agents/`:

| Agent | Can run SQL? | Can delegate? | Can write? |
|---|---|---|---|
| **Orchestrator** | ❌ | ✅ (to Analyst, Researcher) | ✅ (Work Doc only) |
| **Analyst** | ✅ | ❌ | ❌ |
| **Researcher** | ❌ | ❌ | ❌ |

Plus:
- **Capability adapter contract** with `readOnlyTools` + `approvalPolicy`
- **Plan vs. Action mode** — plan mode drops write tools at composition time
- **HITL** via `cmd_ask_user` — a loop-level stop condition
- **Delegation**:
  - Sync: blocking call to child's chat endpoint
  - Async: BullMQ job → sub-thread → tracker artifact
- **Depth cap**: 2 (root=0, child=1, grandchild forbidden)

---

## Topics to self-assess

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 4.1 | What makes something an "agent" | _ | |
| 4.2 | Capability adapters (readOnlyTools, approvalPolicy) | _ | |
| 4.3 | Plan vs. Action mode (composition-time gating) | _ | |
| 4.4 | Delegation patterns (sync / async / DAG) | _ | |
| 4.5 | Depth capping — why, where, how | _ | |
| 4.6 | HITL — pause points, resume semantics | _ | |
| 4.7 | Multi-agent anti-patterns | _ | |

---

## Build artifact spec

*To be detailed at phase kickoff.*

---

## Validation gate for Phase 4

Whiteboard session. I describe a task ("research 5 competitors and write a report"); you sketch the delegation tree, mark sync vs. async edges, and justify depth-cap placement. Then we trace what happens at depth=2 if the child tries to delegate.

---

## When done

→ Start [Phase 5 — Queues & Schedulers](./phase-5-queues.md)
