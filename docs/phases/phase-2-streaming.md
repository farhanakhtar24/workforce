# Phase 2 — Streaming & Real-Time UX

**Duration**: 1 week
**Goal**: Production-grade streaming with resumability and idempotency — the things that break in prod and nobody tells you about.

> Status: **Not started**. Begin after Phase 1 validation passes.

---

## What gets built in this phase

- `apps/api/` — Express server exposing `POST /api/agents/:slug/chat` that streams responses via SSE
- `apps/web/` — minimal Next.js page consuming the stream with `useChat` from AI SDK
- **Resume support**: kill the stream mid-response, refresh the page, watch it pick up where it left off
- **Idempotency**: double-click "send" — request runs exactly once

---

## Topics to self-assess

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 2.1 | Server-Sent Events (SSE) — wire format, EventSource | _ | |
| 2.2 | Streaming LLM responses (chunks, deltas, finish reasons) | _ | |
| 2.3 | Vercel AI SDK basics (`useChat`, `streamText`) | _ | |
| 2.4 | Resumable streams (Redis checkpoints, TTLs) | _ | |
| 2.5 | Idempotency-Key header pattern | _ | |
| 2.6 | Mid-stream errors (AbortSignal, cleanup) | _ | |

---

## Build artifact spec

*To be detailed at phase kickoff.*

---

## Validation gate for Phase 2

*To be detailed at phase kickoff.*

---

## When done

→ Start [Phase 3 — Memory, Embeddings, Hybrid Search](./phase-3-memory.md)
