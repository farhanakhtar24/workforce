# ADR-008: AI SDK UI Message Streams over a Custom Wire Protocol

**Date**: 2026-11-17
**Status**: Accepted
**Phase**: 2
**Deciders**: Mohd Farhan Akhtar

---

## Context

Phase 2 streams chat from the API to the browser. The payload is not just text tokens: the `calculate` tool call must reach the client as a typed part (tool state, arguments, result), and the client must be able to rebuild a fully correct conversation after a disconnect. Independently of transport choice (ADR-005), we had to decide **what the stream contains** and **how resume reconstructs state**.

The application state lives as `UIMessage`s — the shape AI SDK's `useChat` renders against. Message persistence decisions (who owns IDs, what gets saved) determine whether resume is exact or lossy.

---

## Problem

Do we invent a custom SSE JSON protocol and persist our own message format, or adopt AI SDK UI message streams end-to-end — and within that, do we resume by full replay or by delta-only checkpointing?

---

## Options Considered

### Option A — Custom SSE protocol + custom message format

**Description**: Hand-rolled JSON events (`token`, `tool_call`, `done`), our own persisted message rows, our own client parser.

**Pros**:
- Total control; no dependency on AI SDK's evolving stream format.
- Smallest possible payload.

**Cons**:
- We reimplement token/tool/finish framing, error events, and client parsing by hand.
- Every new part type (reasoning, attachments, HITL later) touches the custom parser.
- A second source of truth appears between our persisted format and what `useChat` renders — conversion code, or worse, drift.
- All of it is untested glue code the AI SDK already ships.

### Option B — AI SDK UI message streams (UIMessages end-to-end) (chosen)

**Description**: Server returns `createUIMessageStreamResponse` from `streamText`; the client consumes it with `DefaultChatTransport` + `useChat`. We persist whole `UIMessage`s (with stable **server-generated** assistant message IDs) in Redis as an **append-only LIST** (one JSON UIMessage per entry, RPUSH/LRANGE — no rewrite of prior entries). The client sends only chat ID + the newest user `UIMessage` via `prepareSendMessagesRequest`; the server loads prior UIMessages, appends, runs `validateUIMessages` → `convertToModelMessages` — one source of truth.

**Pros**:
- Tool calls, streaming text, errors, and finish reasons are already structured parts of a `UIMessage`.
- Persisting UIMessages directly means hydration and rendering need no translation layer.
- `validateUIMessages` gives a validation boundary at the trust edge.
- One message shape across wire, store, and React state.

**Cons**:
- Coupling to AI SDK v6 UIMessage/message-stream format; upgrades need checking.
- The stream is a Web `Response` — needs our small tested adapter into Express/Node (see ADR-005).

### Option C — AI SDK streams, delta-only resume

**Description**: Same as B, but on resume, only stream the parts produced after the client's last seen offset (delta-only), trimming replayed content.

**Pros**:
- Less bandwidth on resume for very long messages.

**Cons**:
- Client must bookkeep offsets and reconstruct partial messages — new failure modes for a UI that is not bandwidth-bound.
- Exactness is harder to prove; a missed delta shows up as silent truncation.

(Within B, we keep `resumeStreamIsReplay: true` — the library default — meaning resume = **full SSE replay**.)

---

## Decision

We chose **Option B**: AI SDK UI message streams end-to-end, with **full-replay resume** (`DefaultChatTransport` default `resumeStreamIsReplay: true`, `useChat({ resume: true })`, reconnect URL pointed at the Express `GET .../stream` route).

Stable IDs and persistence rules that make replay exact:

- Assistant `UIMessage`s get **stable server-generated IDs**, persisted with the message — client-side IDs are never trusted.
- Idempotency key derives from **chat ID + user message ID**; the server may not regenerate a message under a live key (retry goes through resume).
- On stream completion the server appends **exactly the new assistant response message** to the append-only message LIST (RPUSH/LRANGE — never a whole-list rewrite, so a concurrent turn cannot lose another message) and clears only **its own** `activeStreamId` (atomic compare-and-del), so a slow old completion cannot wipe a newer stream's marker.
- Hydration is whole-history: `GET /api/agents/:slug/chat/:clientChatId` returns saved UIMessages + active-stream flag; the Next page fetches `no-store` and seeds `initialMessages`.

Rationale: exactly-once + full replay + server-owned IDs make the refresh/reconnect path byte-exact by construction, which is the property we actually need to demo and defend. The replay buffer itself is process-local (see ADR-005's replay boundary note); after an API restart the client hydrates from the persisted LIST instead.

---

## Consequences

### Positive

- No custom protocol to spec, version, or document for interviewers — the AI SDK stream format is the documented interface.
- Refresh mid-response rebuilds the assistant message fully; token duplication is structurally prevented, not just handled in UI code.
- The Web UI stays minimal: `useChat` parts render naturally, including the `calculate` tool state/result.
- Server-side ID assignment means persistence is consistent regardless of which tab/stream won.

### Negative

- Full replay on resume sends the whole in-flight message again (bandwidth over correctness — acceptable at chat scale).
- Dependency lock-in on AI SDK v6 stream/message shapes.
- Server must be disciplined about IDs and clear-on-match completion logic; bugs there are silent state corruption, hence the tests.

### Risks / Open questions

- AI SDK major-version changes to UIMessage shapes will require a persistence migration path; deferred until one actually lands.
- Multi-agent phases may need richer part types; UIMessage is extensible, but ADR-004-era designs should confirm before Phase 4.

---

## Validation

- Automated: adapter streams with `UI_MESSAGE_STREAM_HEADERS` and no buffering; hydration returns persisted UIMessages with server IDs; duplicate-key POST never creates a second assistant message.
- Live (Phase 2 gate): refresh during a long response → full replay, no duplicated tokens; second turn retains turn-one history; `calculate` tool result renders from streamed parts.

---

## References

- [AI SDK — Chatbot Message Persistence](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence)
- [AI SDK — Chatbot Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)
- [AI SDK — Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)
- [Ollama — OpenAI Compatibility](https://docs.ollama.com/api/openai-compatibility)
