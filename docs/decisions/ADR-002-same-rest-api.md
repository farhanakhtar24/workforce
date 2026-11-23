# ADR-002: Capability Tools Call the Own REST API (No Shadow API)

**Date**: 2026-11-23
**Status**: Accepted
**Phase**: 4
**Deciders**: Mohd Farhan Akhtar

---

## Context

Phase 4's tools need to touch app data: `write_doc` (Work Docs), `query_data` (Postgres reads), `search_memory` (the Phase 3 Memory API), and `delegate_task` (which must start a real child chat and feed its result back into the parent loop). The web UI reads and writes the same data through Express REST routes.

Two things must not happen: a second, tool-only write path that duplicates validation/ownership logic, and a second place where a child agent generation is implemented (a "shadow child runner" that bypasses the chat endpoint's idempotency, streaming, and persistence). Phase 2 proved that machinery is expensive to get right; duplicating it for delegation would be the most expensive way to be wrong twice.

---

## Problem

How do capability tools and the agents' delegated sub-chats reach the data and the child generation — through their own in-process paths, or through the same REST surface the UI uses?

---

## Options Considered

### Option A — Tools touch the DB/provider directly

**Description**: Capability handlers import Prisma clients and service modules directly; `delegate_task` runs a child `streamText` loop in-process.

**Pros**:
- Fastest path to working code; no HTTP hop.
- Simple error handling (plain exceptions).

**Cons**:
- Route-level invariants (validation, ownership checks, safe errors, "no content logging") are written and enforced in REST handlers — a direct-DB tool silently bypasses all of them. Two write paths drift.
- A shadow child runner duplicates idempotency, transcript persistence, resumable streams, and the provider wiring. Every Phase 2 fix must be re-applied in the copy, forever.
- Hard to test offline honestly: tests exercise the tool's internal path, which no longer proves anything about the product surface.

### Option B — Tools call the own REST API over an injectable fetch (chosen)

**Description**: New capability tools (`write_doc`, `query_data`, `search_memory`, `delegate_task`) call **real REST endpoints** — the same ones the UI calls — via an **injectable fetch**: production uses a loopback URL to the running API; tests inject a recorded/mocked fetch and stay offline. Sync delegation `delegate_task` calls the **existing** `POST /api/agents/:slug/chat` (Idempotency-Key + consumed UI SSE stream); async delegation enqueues the existing BullMQ infrastructure, and the worker invokes the same child chat REST endpoint. The existing `calculate` stays the one shared deterministic local primitive (it touches no data — exempt).

**Pros**:
- **One validation/ownership/error surface**, written once, used by humans and agents. The Work Doc CAS, ownership checks, and safe-error map cannot be bypassed by a tool because the tool goes through them.
- Delegation reuses the entire Phase 2 chat contract (idempotency, SSE, resume, persistence). Child chats are indistinguishable from human chats on the wire — they are real chats, visible in the UI.
- Injectable fetch keeps the whole tool layer unit-testable offline (mocked REST responses), with integration tests proving the loopback path against the running API.
- No hosted embedding key, no new provider code: `search_memory` calls the existing Phase 3 memory REST (local MiniLM behind it).

**Cons**:
- Loopback HTTP overhead per tool call (irrelevant at this scale; explicit and measurable).
- REST-level failures surface as tool errors that must be mapped to safe, short messages — the error-containment wrapper needs route-status → message mapping.
- Slightly more wiring (fetch injection seam in the API process).

### Option C — Hybrid: direct DB for reads, REST for writes

**Description**: Read tools query Prisma directly; write tools go through REST.

**Cons**:
- The worst of both: the tool layer still imports DB modules (drift risk), yet we pay the HTTP seam anyway; readers can observe unvalidated or route-invisible state; two truth paths for tenancy/ownership. Rejected for incoherence.

---

## Decision

We chose **Option B**, fully: no shadow API. All new data-touching capability tools call the own REST endpoints through an injectable fetch (production loopback URL, mocked fetch in tests), `delegate_task` reuses the existing chat endpoint and BullMQ/Redis infrastructure in both sync and async modes, and there is no separate provider implementation for child chats anywhere. The existing `calculate` remains the single shared local primitive.

---

## Consequences

### Positive

- Work Docs, memory search, and delegation inherit every REST-level guarantee without re-implementing any.
- The delegation flow is auditable end-to-end in one place (chat route): idempotency keys, transcripts, resumable streams apply to child chats.
- Tests: mocked-fetch unit tests offline; real loopback integration proves the same contract.

### Negative

- Tool latency includes a loopback round trip per call (fine at demo scale).
- Route errors must be mapped into short safe tool messages — no route bodies, stack traces, or provider internals leak into the loop.
- The API must be up even for a "pure tool" turn (`search_memory` without it fails with an explicit 503-style tool error, honestly).

### Risks / Open questions

- Internal-only headers (delegation context, ownership context) travel over loopback; they must never be trusted from the public client — verified signatures server-side only.

---

## Validation

- Automated: every new tool tested against a mocked fetch (success, 4xx-safe-error, 5xx mapping); integration tests prove sync/async delegation both flow through the real `POST /api/agents/:slug/chat` (no shadow runner) with `Idempotency-Key` duplicate → 409 single generation.
- Live (Phase 4 gate): the orchestrator's Work Doc writes and delegations are visible in the chat UI and delegation list — because they are the same REST surfaces, not mirrored ones.

---

## References

- [Phase 4 — Multi-Agent Systems](../phases/phase-4-multi-agent.md)
- [ADR-001: Composition-time capability gating](./ADR-001-composition-gating.md)
- [ADR-004: Depth cap 2 + same-REST child chats](./ADR-004-delegation-depth.md)
- [ADR-005: SSE + idempotency](./ADR-005-sse-idempotency.md) (the chat contract delegation reuses)
