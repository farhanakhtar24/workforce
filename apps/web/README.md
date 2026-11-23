# @workforce/web

Phase 2/3 minimal Next.js + React client for the Workforce API (`@workforce/api`).
Chat: agent `general`, single `calculate` tool — rendered part by part, streamed
incrementally. Memory: `/memory` create/browse/search/related/retry/compact
workspace for the Phase 3 memory routes.

See `docs/phases/phase-2-streaming.md`, `docs/phases/phase-3-memory.md`,
ADR-005 (SSE + idempotency), ADR-008 (UI message streams), ADR-003 (memory tree
+ relations + compaction), and ADR-007 (pgvector + local MiniLM embeddings).

## Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 15 (App Router), React 19, TypeScript strict |
| Chat state | `@ai-sdk/react` `useChat` (AI SDK v6), `DefaultChatTransport` from `ai` |
| UI framework | None — plain CSS (`app/globals.css`), no design system (Phase 2/3 non-goal) |
| Tests | `node:test` via `tsx` on pure helpers — no browser, no live API |

## Scripts

```sh
npm run dev        # next dev -p 3000
npm run build      # next build
npm start          # next start -p 3000
npm run typecheck  # tsc --noEmit
npm test           # tsx --test test/*.test.ts
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | The only client-exposed value (the public Express API base). Never an API key. |

No secrets reach the browser: `OLLAMA_API_KEY` lives only in the API process.
Memory embeddings run entirely server-side too: the MiniLM model
(`Xenova/all-MiniLM-L6-v2`, 384-dim) is downloaded to a server-local cache on
first use by the **API** process; `/memory` never loads, stores, or requests an
embedding model or vectors. Blocks arrive as metadata only — the client even
rejects any payload that carries an `embedding`/`vector` key.

Copy `.env.example` to `.env.local` for non-default values.

## Run against the live stack

```sh
npm run dev                                  # in apps/web
npm run dev                                  # in apps/api, with Redis + .env.local
# or from the repo root: npm run dev (starts API + web together; needs Redis and OLLAMA_API_KEY exported)
# open http://localhost:3000 → redirects to /chat/<fresh-uuid>
```

## Architecture

```
app/page.tsx               root → creates crypto.randomUUID() → redirect /chat/:id
app/chat/[chatId]/page.tsx server hydration fetch (no-store) → <Chat> seed
app/memory/page.tsx        /memory shell → mounts the client <Memory> workspace
src/components/Chat.tsx    'use client': useChat + transport + all rendering
src/components/Memory.tsx  'use client': create/browse/search/related/retry/compact
src/lib/api.ts             pure chat request/response helpers (tested)
src/lib/memory.ts          pure memory request/validation/format helpers (tested)
src/lib/calculate.ts       pure tool-part formatting helpers (tested)
src/lib/messages.ts        UIMessage typing for the calculate tool
```

- **Stable chat ID in the URL.** `/` minted a fresh UUID per visit;
  `/chat/:id` pages own it. No localStorage; the server is the source of truth
  (`GET …/chat/:id` → `{ messages, hasActiveStream }`).
- **Send** (`POST /api/agents/general/chat`): `prepareSendMessagesRequest`
  sends the documented body — exactly `{ id: chatId, message: newestUserMessage }`
  — and the exact header `Idempotency-Key: <chatId>:<messageId>` (API 400s on
  any mismatch; 409 on duplicates → the client shows the error and the user can
  send a new message).
- **Hydration** (`GET …/chat/:id`): the server page fetches with `no-store`,
  validates the shape, and passes `initialMessages` + `hasActiveStream` to the
  client. API down at page load → the page still renders with a safe fixed
  retry banner; build never depends on a running API (route is dynamic).
- **Resume** (`GET …/chat/:id/stream`): `useChat({ resume: true })` reconnects
  at mount via `prepareReconnectToStreamRequest`. `resumeStreamIsReplay` stays
  at its **default `true`** (ADR-008): the API replays the whole stream, the
  hook rebuilds the interrupted assistant message exactly once, and nothing
  appends replayed deltas by hand. `204` (idle) is a silent no-op.
- **No stop button.** Refresh/disconnect never aborts the provider generation
  (ADR-005); reconnecting resumes it. There is no abort call in this codebase.
- **Throttle**: `experimental_throttle: 50` (≈50 ms) for streamed UI updates.
- **Navigation**: the chat header links to `/memory` (and keeps `New chat`);
  `/memory` links back to `/`. Root metadata is `Workforce` with a
  `%s · Workforce` title template.

## /memory workspace (Phase 3)

Client component `src/components/Memory.tsx` + pure helpers `src/lib/memory.ts`
against the Phase 3 REST routes (`POST /api/memory/blocks`,
`GET /api/memory/blocks`, `POST /api/memory/search`,
`GET /api/memory/blocks/:id/related`, `POST /api/memory/blocks/:id/retry`,
`POST /api/memory/compact`). No dependency added; no test stack added.

- **Create**: scope (default `default`), path (placeholder
  `research/small-language-models`), kind select (six fixed kinds), content
  textarea (1–1000 chars, live counter), confidence number input (0–1,
  step 0.05, default 0.8), optional supersedes UUID (native `pattern`). Native
  validation plus bounded lengths; submit disabled while busy; success/error
  notices are live regions. After a create, the browse panel focuses the new
  block's exact scope/path/kind and refetches, showing its `pending` status.
- **Browse**: scope/path (prefix — includes descendants)/kind/keyword filters,
  include-superseded checkbox, limit select (5–100, API default 20), explicit
  Refresh button. Cards show content, path, kind, confidence, embedding status,
  created/updated/embedded/last-accessed timestamps, access count, embedding
  model and a `superseded by <id>` marker when applicable.
- **Semantic search**: query + optional path/kind/limit. Results show
  content/path/kind plus cosine, recency and the final score, each formatted
  with fixed 3 decimals. The page explains the formula: final score = **80%
  semantic (cosine) + 20% recency**; only `ready` embeddings are searchable.
- **Related**: per-block action fetches `{ block, outgoing, incoming }` and
  renders each relation (`supports` / `supersedes` / `contradicts`) with the
  neighbor's content.
- **Retry**: per-block action, enabled only for `embeddingStatus: failed`
  (disabled while retrying a request or for `pending`/`ready` blocks — the API
  answers 409 for a ready block and the safe error is surfaced verbatim).
- **Compact**: scope + **exact** path and a required expectation note (`>30`
  chars). The response is only ever reported as `queued` (with the trigger
  block id) — the UI never fabricates a summary.
- **Live updates**: the open browse list polls every 2 s *only while* at least
  one rendered block is `pending`, the tab is visible, and no prior poll is in
  flight; it stops on error, when only `ready`/`failed` blocks remain, and on
  unmount. A request-sequence guard discards stale responses. Manual refresh
  always works.
- **Accessibility & safety**: every control is labeled; async notices use
  `role="status"` or `role="alert"` with `aria-live`; focus outlines and
  keyboard operability come from native elements; layout is single-column and
  responsive; all content renders as escaped text only (no
  `dangerouslySetInnerHTML`, so no HTML injection path). Errors are always the
  API's safe `{ error }` message or a fixed fallback — never stacks, payloads
  or internals.

### First use, local model behavior

- Embeddings are computed **server-side** in the API process by local
  Transformers.js (`Xenova/all-MiniLM-L6-v2`, 384-dim). On first use the API
  downloads the model into a project-local ignored cache; afterwards it works
  offline. The browser never downloads or runs any model, and no model name or
  API key appears in the web bundle beyond the embedding-model string that the
  API may include in a block's metadata field.
- A freshly created block reports `embeddingStatus: pending`; the browse list
  auto-polls until it turns `ready` (or `failed`, which can then be retried).
  Semantic search returns nothing for pending/failed blocks by design.

### /memory live validation checklist (not yet run — the gate below is manual)

1. Create a block → card appears `pending` → auto-poll flips it to `ready`.
2. Stop the API → browse/search show the fixed safe error banner; polling
   stops; manual refresh recovers once the API is back.
3. Path prefix: browse `research` lists `research/small-language-models` and
   deeper descendants.
4. Supersede: create a block with a supersedes UUID → default list hides the
   old block; "Include superseded" shows it with the marker; Related on either
   side shows the `supersedes` relation.
5. Search: relevant result ranks first; cosine/recency/final displayed; a
   query with no ready embeddings returns an empty-but-successful result.
6. Retry: failed block can retry (notice + refreshed status); ready block's
   retry button is disabled.
7. Compact: expectation < 31 chars blocks submit; valid note queues the job
   and reports `queued` + trigger id — no summary until the job finishes.
- **Rendering**: messages render by parts — text streams incrementally;
  `tool-calculate` parts show lifecycle state, input (`expression`), and the
  output, which is currently the JSON string `{"result":14}` — parsed safely
  and rendered as plain text only (no `dangerouslySetInnerHTML`, so no HTML
  injection path). Status line shows `submitted / streaming / ready / error`;
  error text goes through `describeChatError`, which surfaces only the API's
  fixed safe `{"error": …}` message or a fixed fallback.

## Validation limitations (honest)

- Tests cover only the **pure helpers**: send body/headers, resume and
  hydration URLs, base-URL resolution, id-format parity with the API,
  hydration mapping, safe error mapping, `calculate` output formatting, and —
  for `/memory` — endpoint/query/body mappings, response validation (including
  rejection of vector-bearing payloads), safe error collapse, score/date
  formatting, the compaction expectation gate, and the pending-poll predicate.
  No React rendering tests were added (by design, no extra stack).
- Live validation items **not yet manually verified** in this repo worktree:
  actual browser streaming, mid-stream refresh → full replay with no
  duplicated tokens, `204` resume, `409` double-submit surfacing, CORS
  preflight, throttled rendering smoothness, and **every `/memory` item in the
  checklist above** (the API routes and worker are being built concurrently —
  nothing here has been run against the live Phase 3 stack). Run the API
  `npm run dev` (with Redis + Postgres/pgvector) and `npm run dev` here, then
  walk the phase-3 live checklist and gate.
