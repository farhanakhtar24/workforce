# ADR-004: Delegation Depth Cap of 2 (Not 3), with Same-REST Child Chats

**Date**: 2026-11-23
**Status**: Accepted
**Phase**: 4
**Deciders**: Mohd Farhan Akhtar

---

## Context

Delegation is recursive by nature: the orchestrator delegates to workers, and if a worker could delegate, cost and latency grow multiplicatively while traceability collapses. An uncapped delegation loop is a runaway-recursion failure mode; even a cap of 3 gives four levels of nested generation (root + 3) with unbounded fan-out at each level.

Delegation has two modes for this phase: **sync** (the parent blocks mid-loop and consumes the child's UI SSE stream) and **async** (BullMQ job on the existing Redis; the worker invokes the child). An orchestration DAG (LLM-authored step plans fanned out by an executor) was sketched in early notes — it is **not** part of this decision and not built in Phase 4.

---

## Problem

How deep may delegation go, where is that cap enforced, and over what surface do child chats actually run?

---

## Options Considered

### Option A — Depth cap 3

**Description**: Root (0) → child (1) → grandchild (2) → great-grandchild (3) allowed; the delegation tool is omitted at depth ≥ 3.

**Pros**:
- Deeper hierarchies (manager → sub-manager → worker) fit richer role trees later.

**Cons**:
- Four nested generations: worst-case latency and token cost compound; debugging a four-deep transcript chain is painful.
- No phase-4 role tree needs it: targets are fixed (`analyst`, `researcher`) and no worker delegates anyway.
- More combinations to test for marginal capability we do not use.

### Option B — Depth cap 2 (chosen)

**Description**: Root = depth 0, child = depth 1. Enforcement is composition-time (ADR-001): `delegate_task` is **absent from the toolkit at depth ≥ 2** — not a runtime rejection, a missing tool. A depth-2 grandchild chat **may exist as a real chat** over the same REST contract, but it composes no `delegate_task`; **only requests that would create a child at depth ≥ 3 are rejected by the delegation REST route (`403`)**, while self-targeting and invalid targets are fixed-400-safe. The trusted depth travels **server-side only**: the delegations service issues a short-TTL signed internal delegation context (child chat id + depth + target) that the child chat request carries in an internal header — never a client body field. **Child chats run over the same REST chat endpoint** humans use (`POST /api/agents/:slug/chat`, `Idempotency-Key`, UI SSE stream consumed from tool or worker); sync blocks mid-loop, async runs through the existing BullMQ/Redis worker with deterministic job ids and a bounded timeout.

**Pros**:
- Bounded worst case: at most root + one child generation per delegation edge; cost/latency and mental model both stay small.
- Structural enforcement: at depth ≥ 2 there is no delegation tool to call (prompt injection has nothing to hijack); a hand-crafted REST attempt fails signature/depth validation anyway.
- Same-REST child chats inherit the whole Phase 2 contract (idempotency, persistence, resumable SSE) and are visible in the web UI by URL — full auditability with zero new protocol.
- The depth value travels in a signed, expiring, chat-bound context: a client cannot claim depth 0 for an internal child.

**Cons**:
- Deep hierarchies are impossible (accepted — nothing in v1 needs them; revisiting for a later phase would be a new ADR).
- The internal delegation-context header is security-sensitive: it must be signature-verified, TTL-bounded, chat-bound, and never logged (a new small surface to test).
- Tool errors must wrap the child call's bounded timeout honestly (`timeout` status, never a silent hang).

### Option C — No cap, trust the model

**Cons**:
- A recursion failure mode instead of a design limit; cost unbounded. Rejected without hesitation.

---

## Decision

We chose **Option B**: depth cap **2** (root 0, child 1).

**Clarified 2026-11-23 (implementation contract — wording supersedes the earlier "grandchild forbidden" phrasing; the decision itself and its Accepted status are unchanged):** a depth-2 grandchild chat **exists and runs as a real chat over the same REST chat endpoint**, but composes **no** `delegate_task` (omitted at composition time) — no delegation can start at depth 2. Only requests that would create a child at **depth ≥ 3** are rejected, with **403** at the delegation REST layer; self-target and invalid-target validation stays fixed-400-safe. Trusted depth travels only through a server-signed internal delegation context bound to the child chat id — client-supplied depth is never read. Child chats are the **same REST chat endpoint** (existing idempotency + SSE + persistence), invoked by the sync tool or the async BullMQ worker; there is no shadow child runner and no separate provider implementation. The DAG orchestration idea is explicitly dropped for now: sync + async, depth-capped, is the whole delegation surface for this phase.

---

## Consequences

### Positive

- Runaway recursion is structurally impossible: at most two levels exist (root 0, child 1, and a depth-2 chat that composes no `delegate_task`); no delegation can start at depth ≥ 2.
- Every child chat is a first-class chat: persisted, idempotent, resumable, visible in the UI at `/chat/:childChatId`.
- The delegation tracker (`Delegation` rows with `pending → running → completed/failed/timeout`) gives the async path observable status with safe errors.

### Negative

- No multi-level fan-out even if a use case appears; lifting the cap is a future ADR.
- Signed internal context adds one credential-like surface to protect (TTL, verification, never logged).

### Risks / Open questions

- If a future target agent is itself a delegator (e.g., orchestrator-to-orchestrator), the depth context mechanism is already in place — only the target validation widens.

---

## Validation

- Automated: matrix tests prove `delegate_task` absent at depth ≥ 2 (composition time) and that a depth-2 chat still composes its other tools; REST tests prove self-target/invalid target → 400 and a request implying a depth ≥ 3 child → 403, each with no Delegation row and no child call; sync/async success, child failure, bounded timeout (`timeout` status), and `Idempotency-Key` duplicate → 409 with no second generation.
- Live (Phase 4 gate): orchestrator delegates to researcher (sync answer visible) and analyst async status transitions visible; the tool list shows no delegation ability for any child.

---

## References

- [Phase 4 — Multi-Agent Systems](../phases/phase-4-multi-agent.md)
- [ADR-001: Composition-time capability gating](./ADR-001-composition-gating.md)
- [ADR-002: Agents call own REST API](./ADR-002-same-rest-api.md) (same-REST child chats)
- [ADR-005: SSE + idempotency](./ADR-005-sse-idempotency.md) (the contract child chats inherit)
