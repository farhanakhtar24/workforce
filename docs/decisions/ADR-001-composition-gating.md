# ADR-001: Composition-Time Capability Gating (Not Prompt-Only Enforcement)

**Date**: 2026-11-23
**Status**: Accepted
**Phase**: 4
**Deciders**: Mohd Farhan Akhtar

---

## Context

Phase 4 introduces three agents with different privileges: an orchestrator that may write Work Docs and delegate, an analyst that may run SQL but must never write or delegate, and a researcher that may only search memory. Plan mode exists for the orchestrator (read-only preparation before acting), and delegation must be depth-capped.

The guarantee we want is stronger than "the model politely obeys": an agent that must not write **cannot** write, even under prompt injection, a confused model, or a hallucinated tool call. Phase 4's whole safety story rests on where this rule lives.

---

## Problem

Where is read/write and delegation permission enforced — in the prompt, at tool-call time, or when the agent's toolkit is assembled?

---

## Options Considered

### Option A — Prompt-only

**Description**: The system prompt tells the model "in plan mode you must not write" and "you must not delegate". Enforcement is the model's compliance.

**Pros**:
- Zero code; the same toolkit is handed to every mode.
- Easy to "change": edit a sentence.

**Cons**:
- **Not enforcement at all** — a prompt-injected user message can contradict the system instruction, and a model can call a tool it was told not to.
- Write tools are still attached in plan mode: a wrong call executes before anyone can veto it.
- Untestable: we cannot assert "analyst cannot delegate" from code; only observe behavior across samples.

### Option B — Runtime checks inside tool handlers

**Description**: All tools are always attached. Each tool's handler reads a permissions context (mode/role/depth) and throws if the call is not permitted.

**Pros**:
- One toolkit per agent to render/maintain in the UI.
- Rejection message can be fed back into the loop for the model to recover.

**Cons**:
- Enforcement happens at **call time**: the failure path (throw, containment, error rendering) must be flawless, and we only discover a violation after the model has already tried.
- The model sees and can keep retrying tools it can never successfully use — wasted generations, confusing transcripts.
- Approvals/status must be checked on every call; one handler forgetting the check is a silent hole.
- Tool lists shown in the UI misrepresent what the agent may actually do.

### Option C — Composition-time tool selection (chosen)

**Description**: Every tool lives in a registry entry with Zod input/output schemas, description, `readOnly` and approval metadata. A **pure** `composeAgentCapabilities(agent, mode, depth, registry)` selects the actual tool instances **once per generation**. Plan mode omits write/delegation tools entirely (they are not in the toolkit, not merely warned against). Action mode adds only permitted writes. `delegate_task` is omitted at `depth >= 2`. Prompt instructions still exist — as secondary guidance, never the enforcement mechanism.

**Pros**:
- The failure mode of a forbidden call is **structural**: there is no tool to call. The model cannot hijack what does not exist.
- The whole permission model is a pure function of `(agent, mode, depth)` — **exhaustively testable** as a matrix with offline tests.
- Smaller, accurate tool lists per mode also help providers choose tools correctly and cost less per generation.
- Composition happens once per generation before `streamText` starts: no mid-turn permission state to race on.

**Cons**:
- Per-combination tool sets must stay in sync with system prompts; the registry must be complete — a tool not registered is unusable by anyone.
- No mid-turn escalation: switching plan → action requires a new generation (deliberate).
- More machinery than a prompt sentence: registry, compose function, matrix tests.

---

## Decision

We chose **Option C**. Read/write and delegation permissions are decided **when the agent is assembled** for a generation, not when the model runs, and never only in the prompt. `composeAgentCapabilities` is pure; prompt text reinforces the rule but is never the gate.

Deliberate corollaries: workers (`analyst`, `researcher`) run action mode but their composed toolsets contain no write or delegation tools, so the plan/action distinction simply never grants them one; the existing `general` agent composes to `calculate`-only, preserving Phase 1-2 behavior bit-for-bit.

---

## Consequences

### Positive

- The safety claim ("plan mode cannot write; analysts cannot delegate") is a testable matrix, not a behavioral hope.
- Prompt injection has no write tool to hijack in plan mode, and no delegation tool at depth ≥ 2.
- Tool lists rendered in the UI match what the agent can actually do (no permission theater).

### Negative

- Every new tool/agent/mode combination must be added to the registry and the matrix tests; drift shows up as a missing capability, not a security hole, but still requires discipline.
- Plan → action transitions need a new generation (no mid-turn upgrade path).

### Risks / Open questions

- A future tool with conditional writability (e.g., update a doc but never archive) will cut across the `readOnly` flag; revisit metadata shape then.

---

## Validation

- Automated: `composeAgentCapabilities` matrix tests — every agent × mode × depth yields the exact expected tool set; plan mode's set provably lacks `write_doc`/`delegate_task`; depth ≥ 2's set provably lacks `delegate_task`; `general` is `calculate`-only.
- Live (Phase 4 gate): Farhan asks the orchestrator in plan mode to write/delegate — the tools are absent (item 3 of the gate), not merely refused.

---

## References

- [Phase 4 — Multi-Agent Systems](../phases/phase-4-multi-agent.md)
- [ADR-004: Depth cap 2 + same-REST child chats](./ADR-004-delegation-depth.md) (composition-time omission of `delegate_task`)
- [ADR-002: Agents call own REST API](./ADR-002-same-rest-api.md) (the tools being gated)
