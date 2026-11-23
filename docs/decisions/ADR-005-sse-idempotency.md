# ADR-005: SSE + Idempotency over WebSockets for Resumable Chat

**Date**: 2026-11-17
**Status**: Accepted
**Phase**: 2
**Deciders**: Mohd Farhan Akhtar

---

## Context

Phase 2 adds real-time chat. Three production failure modes must be handled, not just happy-path streaming:

1. A client refresh or disconnect should not cancel or lose an in-flight LLM generation — the response must be resumable.
2. A double-submit (double-clicked send, retried POST) must not trigger a second LLM generation.
3. The client must be able to rebuild state after being away (hydration + resume).

The transport, retry, and replay mechanics drive everything downstream: endpoint shape, Redis usage, and how much the client can trust what it renders.

---

## Problem

Which transport and which retry/replay mechanism give us resumable, idempotent chat streams with the smallest amount of custom protocol code — and what happens to our guarantees when Redis is down?

---

## Options Considered

### Option A — WebSockets (bidirectional socket)

**Description**: One persistent socket per chat. Client and server push frames both ways; resume means replaying missed frames, tracked server-side.

**Pros**:
- Native bidirectionality (useful later for HITL approval prompts).
- No HTTP request/retry semantics to reason about.

**Cons**:
- A whole second connection lifecycle (upgrades, heartbeats, reconnect storms) to maintain.
- Socket state dies with the server process; resumability then needs replay machinery anyway.
- HTTP intermediaries (proxies, load balancers) need special handling.
- Does nothing for idempotency on its own — double-submit is still a hand-rolled problem.

### Option B — SSE + Idempotency-Key + `resumable-stream` over Redis (chosen)

**Description**: Chat is plain HTTP. `POST /api/agents/:slug/chat` streams an AI SDK UI message stream as SSE. Every POST carries `Idempotency-Key` (chat ID + user message ID); the server enforces exactly-once generation with Redis `SET NX EX 900`. `resumable-stream` relays the stream over Redis (sentinel/pubsub) while the replay chunks themselves are held in the producing API process's memory; `GET /api/agents/:slug/chat/:clientChatId/stream` replays it. A client that reconnects mid-message on the **same running API process** receives the full replay and rebuilds the assistant message with no duplicated tokens.

**Pros**:
- Unidirectional fits the use case: the model talks, the client listens. Sending is already a plain POST.
- AI SDK `useChat` + `DefaultChatTransport` support resume natively (`resume: true`, replay semantics) — almost no custom protocol.
- Idempotency is explicit and testable: `SET NX` + TTL + 409 on duplicate, one generation per key.
- Replay-after-resume gives byte-exact state rebuild without client-side delta bookkeeping.

**Cons**:
- Needs Redis as a hard dependency (append-only chat message history, idempotency keys, active-stream markers, resumable-stream's relay).
- Replay buffers live in the producing process's memory, so mid-flight replay after an API restart is not covered (see the boundary note under Decision).
- Replay on resume can redeliver already-seen segments; correctness depends on stable assistant message IDs and `resumeStreamIsReplay: true` behavior.
- Web `Response` → Node streaming needs a small adapter since Express is a separate long-running server (no Next `after()`); background work must be tracked by us via adapted `waitUntil`.

### Option C — HTTP polling (client polls state every N ms)

**Description**: No SSE; client polls a messages endpoint and renders diffs.

**Pros**:
- Trivial server-side; survives disconnects naturally.

**Cons**:
- Not streaming in any real sense — the Phase 2 goal is live token-by-token output.
- Poll interval is a latency/cost dial we would rather not have.

---

## Decision

We chose **Option B**: SSE + `Idempotency-Key` + `resumable-stream` relayed over Redis, full-replay resume, and AI SDK v6 transports. Rationale: it matches the one-directional shape of LLM chat, the AI SDK implements the protocol for us, idempotency is enforceable at exactly one layer, and the failure modes (refresh mid-stream, double POST) each have a single, testable answer.

**Replay boundary — an explicit part of this decision**: resumable-stream 2.2.13 uses Redis for its sentinel/pubsub relay while the replay chunks stay in the **producing API process's memory**. The guaranteed gate is therefore: refresh or disconnect mid-stream, resume against the **same running API process** → full replay, no duplicate tokens. An API process restart mid-flight is **not** covered: a restarted process has no replay buffer, and the client falls back to hydration (`GET …/chat/:id`) of the persisted messages. What survives that restart is what Redis durably holds: the append-only chat message LIST (RPUSH/LRANGE), the idempotency keys (`SET NX EX 900`), and the active-stream marker (`EX 86400`, cleared on completion, and compare-and-deleted when a resume hits the ack timeout) — all subject to Redis persistence (AOF on). This ADR does not claim full distributed durability or cross-process replay.

**Redis failure behavior — an explicit part of this decision**: Redis now backs chat messages, active stream IDs, idempotency keys, and resumable-stream's relay. If Redis is unavailable, chat POST and resume return an **explicit `503`**. We deliberately do *not* degrade to a "graceful no-op": without Redis we can no longer guarantee exactly-once generation or resumable replay, and pretending otherwise is worse than a clear error. This supersedes the earlier graceful-no-op wording in the architecture doc.

**Scope note**: Redis is introduced in Phase 2 for replay + idempotency. BullMQ/queues remain Phase 5 and merely reuse the same Redis.

---

## Consequences

### Positive

- Exactly-once generation per key is enforceable and unit-testable (duplicate → 409, no second model call).
- Refresh/disconnect mid-stream on the same running API process rebuilds the full assistant message; nothing is lost or duplicated.
- Client never sends full history — chat ID + newest user `UIMessage` only; the server owns the transcript.
- Minimal custom protocol: AI SDK UI message streams carry tokens, tool parts, and finish reasons.

### Negative

- Redis becomes a hard runtime dependency; a Redis outage takes chat down with an explicit 503 until mitigated (Phase 6 ops work).
- Replay is process-local: an API restart mid-flight ends mid-stream replayability (clients fall back to hydration of the persisted messages — see the boundary note above).
- 900 s idempotency TTL and the 24 h active-stream marker TTL must be tuned together; too short and a late retry double-fires, too long and keys pile up (ack-timeout cleanup removes markers whose producer died).
- The Web Response → Express adapter and tracked-background-promise `waitUntil` are custom code we must test.

### Risks / Open questions

- If later phases (HITL, multi-agent) need genuine bidirectional streaming, SSE + POST remains workable but the HITL decision point may revisit this ADR.
- Replay assumes the client can deduplicate by stable server-assigned assistant message IDs (covered in ADR-008).

---

## Validation

- Automated: same-key double POST → single generation (mocked model counts calls); missing/invalid key → 400; Redis-unavailable → 503 on chat and resume.
- Live (Phase 2 gate): mid-stream refresh → full replay with no duplicate tokens; double POST → one generation; UI survives a mid-stream provider error.

---

## References

- [AI SDK — Chatbot Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)
- [AI SDK — Chatbot Message Persistence](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence)
- [AI SDK — Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)
- [Ollama — OpenAI Compatibility](https://docs.ollama.com/api/openai-compatibility)
- [`resumable-stream`](https://github.com/vercel/resumable-stream)
- [MDN — Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
