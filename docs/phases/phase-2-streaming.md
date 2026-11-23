# Phase 2 — Streaming & Real-Time UX

**Duration**: 1 week
**Goal**: Production-grade streaming with resumability and idempotency — the things that break in prod and nobody tells you about.

> **Status: ✅ Completed — validated 2026-11-19.** Started 2026-11-17, immediately after Phase 1 validation (see [phase-1-llm-core.md](./phase-1-llm-core.md)).
> The design below is **fixed**, not open for re-litigation. It is recorded as decisions in [ADR-005](../decisions/ADR-005-sse-idempotency.md) (SSE + idempotency) and [ADR-008](../decisions/ADR-008-ai-sdk-ui-streams.md) (AI SDK UI message streams).
> The validation gate below passed on 2026-11-19: the automated evidence and Farhan's explicit approval are recorded under **Validation record** in that section.

---

## What gets built

- `apps/api/` — Express 4 (Node 24+, strict TypeScript) exposing a streaming chat endpoint with SSE, idempotency, and Redis-backed resume.
- `apps/web/` — minimal accessible Next.js/React chat page using `useChat` from `@ai-sdk/react` on AI SDK v6, refreshing the page mid-stream resumes the full response.
- Double-submit protection: same idempotency key → exactly one generation.

### Explicit non-goals (Phase 2)

No Postgres, no BullMQ (Phase 5), no multi-agent logic (Phase 4), no semantic memory (Phase 3), no auth, no deployment work. No custom design system in the UI.

---

## Fixed design

### Stack and provider

| Concern | Choice |
|---|---|
| API | Express 4, Node 24+, strict TS; a separate long-running server (not Next route handlers) |
| Web | Minimal Next.js/React; `@ai-sdk/react` `useChat`; AI SDK v6 `DefaultChatTransport` |
| LLM provider | `@ai-sdk/openai-compatible`, base `https://ollama.com/v1`, model `glm-5.3-flash`, env `OLLAMA_API_KEY` (same provider as Phase 1, now via SDK) |
| Tool | Exactly **one**: existing `calculate`, shared from `@workforce/core` (`packages/core/capabilities`) |
| State | Redis only (Phase 5 adds BullMQ on top of it) |
| Agent | Single `general` slug; `streamText` with `stopWhen: stepCountIs(10)`; **no** `tool_choice`, **no** structured output |

`packages/core` holds only the shared calculator in Phase 2. No `packages/core/runtime` / broader extraction is happening now — planned packages stay planned.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/agents/:slug/chat` | Send newest user message, start generation, stream SSE. `slug` = `general` only |
| GET | `/api/agents/:slug/chat/:clientChatId/stream` | Resume an active stream; `204` when none |
| GET | `/api/agents/:slug/chat/:clientChatId` | Hydration: saved `UIMessage[]` + whether an active stream exists |

### Turn flow (POST)

1. Client `prepareSendMessagesRequest` sends **chat ID + only the newest user `UIMessage`** — not the whole transcript.
2. Validate `Idempotency-Key` (missing/invalid → **400**). Key = chat ID + user message ID, scoped to the chat.
3. Redis `SET NX` with **900 s TTL**. Duplicate key → **409**, and **no second generation is invoked**.
4. Load prior UI messages from Redis, append the new user message, `validateUIMessages`, `convertToModelMessages`, `streamText`.
5. Respond through `createUIMessageStreamResponse`; on completion append exactly the new assistant `UIMessage` (with a **stable server-generated assistant ID**) to the append-only message LIST — never a whole-list overwrite.

Idempotency nuance: a provider/setup failure **before** the stream is created may release the key (retry is safe). **Once streaming has started**, a retry must use resume — it never starts a second generation.

### Resume

- `resumable-stream` + Redis. **Where replay state lives**: resumable-stream 2.2.13 uses Redis for its sentinel/pubsub relay while the replay chunks stay in the **producing API process's memory**. The guaranteed live gate is refresh/disconnect resume against the **same running API process** → full replay, no duplicated tokens. A process restart mid-flight is **not** supported for replay; the client then falls back to hydration of the persisted messages (durable subject to Redis persistence).
- `resumeStreamIsReplay` stays at its default `true`: the client gets a **full SSE replay**, rebuilding the interrupted assistant message exactly once, with no duplicated tokens.
- `useChat({ resume: true })` with a customized reconnect URL pointing at the Express GET stream route (not a Next route).
- Client disconnect or refresh **does not** cancel the provider generation.
- **No explicit stop endpoint in Phase 2** — stop() is only a disconnect under resumable semantics; the server continues and the client can re-attach.

### State hydration

- `GET /api/agents/:slug/chat/:clientChatId` returns saved UI messages + active-stream flag.
- The Next server page fetches it with **`no-store`** and passes the messages as `initialMessages` to `useChat`.
- Chat ID is stable and lives in the URL.

### Stream lifecycle & Redis

Redis keys: chat UI messages, active stream ID, idempotency keys, resumable-stream's relay data.

- Chat UI messages live in an **append-only Redis LIST** (RPUSH/LRANGE, one JSON UIMessage per entry, no TTL) — never rewritten wholesale. On completion the server appends **exactly the new assistant response message**, so a concurrent turn cannot lose the other's messages. Durable subject to Redis persistence.
- Stream creation records an `activeStreamId` with a **24 h TTL**; idempotency keys are `SET NX` with a 900 s TTL — both durable subject to Redis persistence. A resume that hits the ack timeout treats the stream as dead: compare-and-delete the stale marker, answer `204`.
- On completion, clear **only the matching** `activeStreamId` (atomic compare-and-del) — an old completion must never clear a newer stream.
- Before anything durable, the complete appended conversation is validated: an invalid newest `UIMessage` → fixed **400** with no key acquired, nothing appended, no provider work; malformed JSON → fixed **400**; bodies over 256 kb → fixed **413**.
- **Redis is introduced here** specifically for replay + idempotency. If Redis is unavailable, chat POST and resume return an **explicit, safe `503`** — the API does not pretend exactly-once or resume guarantees still hold. (This supersedes the earlier "graceful no-op if Redis is down" wording in the architecture doc; see ADR-005.)

### Server plumbing

- Express is a separate long-running server, so **Next's `after()` is unavailable**: adapt `resumable-stream`'s `waitUntil` to our own tracked background promises.
- AI SDK's `createUIMessageStreamResponse` yields a Web `Response`; a small, unit-tested adapter pipes it into Express/Node as a stream with `UI_MESSAGE_STREAM_HEADERS`, **no buffering**.
- CORS: allow the Next origin **and** the `Idempotency-Key` header.
- Never log API keys or dump sensitive provider response bodies.

### Web UI (deliberately minimal, accessible)

Messages list, streamed text, generic `calculate` tool state/result rendering, input, send status/errors. UI updates throttled around **50 ms**. No stop button (see resume semantics). No custom design system.

---

## Validation gate

Two layers; both required.

### Automated (offline-capable, mocked model + Redis store)

- Duplicate POST with the same idempotency key invokes the generation exactly once.
- Missing/invalid key → 400; duplicate → 409 without a second generation call on the mocked model.
- Redis-unavailable path returns 503 for chat and resume.
- Web Response → Express adapter streams with correct headers, no buffering.
- Old completion clears only its own `activeStreamId`.

### Live (Farhan, on the real stack)

1. Text streams visibly and incrementally.
2. `calculate` tool call executes and its result shows in the UI.
3. Second turn retains history from the first turn.
4. Refresh during a long response → full replay, no duplicated tokens.
5. Double POST with the same key → one generation.
6. Mid-stream provider error is contained; the UI survives.

**Pass rule**: automated suite green **and** Farhan's explicit approval of the live run. Until then, Phase 2 is not done.

### Validation record — 2026-11-19: passed

**Automated evidence** (already verified before the live gate):

- 156/156 offline tests: core 31, CLI 30, API 74, web 21.
- 3/3 real Redis integration tests, which proved: duplicate POST → **409** with exactly one generation; client disconnect without aborting the provider generation; full replay without duplicated deltas; stable server-generated IDs; persistence of messages and markers; and `204` from resume after completion.
- Root typecheck and full build green.
- Browser accessibility smoke on desktop and mobile.
- The replay boundary stays as documented: full replay is guaranteed against the **same running API process** only; no restart-replay claim is made.

**Live gate (Farhan, on the real stack)**: Farhan was given the live checklist above — visible streaming; `calculate` on `(12+8)*3` → 60; follow-up "Add 7" → 67; refresh mid-stream without duplicates; safe provider/network errors — and replied **"Yes working"** on 2026-11-19.

Recorded as: **Farhan confirmed the live Phase 2 web flow is working on 2026-11-19.** The dated confirmation is the claim; a per-item transcript of the live checklist is not recorded here.

---

## When done

✅ Done — gate passed 2026-11-19 (see the Validation record above).

Next: [Phase 3 — Memory, Embeddings, Hybrid Search](./phase-3-memory.md) — **not started**. It begins when Farhan asks to start it.
