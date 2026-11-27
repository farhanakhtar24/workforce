# @workforce/web

Phase 2/3/4/5 minimal Next.js + React client for the Workforce API (`@workforce/api`).
Chat: four agents (`general` / `orchestrator` / `analyst` / `researcher`) with
plan/action modes over the same streaming, idempotent, resumable chat core —
rendered part by part. Memory: `/memory` create/browse/search/related/retry/compact
workspace for the Phase 3 memory routes. Work Docs and Delegations are the Phase 4
additions, `/schedules` (agent task dashboard over the real `/api/scheduler` REST
routes) is the Phase 5 addition.

See `docs/phases/phase-2-streaming.md`, `docs/phases/phase-3-memory.md`,
`docs/phases/phase-4-multi-agent.md`, ADR-005 (SSE + idempotency), ADR-008 (UI
message streams), ADR-001/002 (composition + same-REST tools), ADR-004
(delegation depth cap 2), ADR-003 (memory tree) and ADR-007 (pgvector + local
MiniLM embeddings).

## Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 15 (App Router), React 19, TypeScript strict |
| Chat state | `@ai-sdk/react` `useChat` (AI SDK v6), `DefaultChatTransport` from `ai` |
| Markdown | `react-markdown` + `remark-gfm` (assistant text renders real Markdown; raw HTML is never enabled) |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss`, `postcss.config.mjs`, `@import "tailwindcss"` in `app/globals.css`) |
| UI primitives | shadcn/ui — real registry sources under `src/components/ui` (Button, Card, Badge, Input, Textarea, Label, NativeSelect), `components.json`, `cn` in `src/lib/utils.ts`; icons via `lucide-react` |
| Shell | Shared `src/components/WorkspaceShell.tsx` (dark-ink sidebar + mobile bar, one `nav` landmark, context-query deep links) consumed by every routed surface |
| Tests | `node:test` via `tsx` on pure helpers — no browser, no live API |

## Design system (UI refresh)

Warm neutral canvas (`--background`), white elevated Cards, deep-green
`--primary`/`--ring`, dark-ink `--sidebar` palette, soft status tints and the
`--user-bubble` token all live as shadcn-compatible CSS variables in
`app/globals.css`. No gradients. Focus uses a global `:focus-visible` ring;
`prefers-reduced-motion` disables transitions/animation globally.

Focused custom CSS (kept deliberately narrow): assistant Markdown typography
`.chat-md*`, tool-part cards `.chat-tool*`, collapsed regions `.chat-region`,
scheduler tables `.sched-table*`, and the Version-history excerpt `<pre>`
`.work-doc-content*`. Everything else (buttons, cards, badges, inputs,
textareas, labels, selects, shell, badges-pills) comes from Tailwind +
shadcn primitives — no parallel button/card/form system exists.

Notes:
- `@source "../src"; @source "../app";` is declared in `globals.css`: Tailwind
  v4 roots automatic detection at the CSS entry directory, which would miss
  `src/components`. The PostCSS config is the documented Tailwind×Next object
  shape (`plugins: { '@tailwindcss/postcss': {} }`).
- Status pills render through `src/components/StatusBadge.tsx` (shadcn Badge
  wrapper that keeps the original lowercase `data-status` attribute on the
  element); the chat empty-state suggestions come from
  `src/lib/workspace.ts` (`chatSuggestions`) and only fill the composer.
- Safe Markdown rendering is one shared component, `src/components/MarkdownText.tsx`
  (`react-markdown` + `remark-gfm`, raw HTML never enabled — no rehype-raw and no
  `dangerouslySetInnerHTML`). It renders chat responses/thinking, Delegation
  worker results (full content inside a `max-h-60` bounded scroll region —
  truncating Markdown source would leave literal unmatched syntax), and Work Doc
  current content (bounded, display-limit note kept). The Work Doc edit textarea
  stays raw Markdown; version-history excerpts stay plain `<pre>`.
- Chat layout is a viewport-constrained application frame: the shell root is
  `h-dvh overflow-hidden` on chat surfaces, the transcript is the only scroller
  (`min-h-0 flex-1 overflow-y-auto`), and the composer/answer dock is pinned at
  the frame bottom — page `maxScrollY` stays 0 in browser checks (desktop and
  mobile). The transcript scrolls to the latest turn exactly once (first
  nonempty list per mounted chat, or on the user's own send/resume
  re-attach via `status === 'submitted'`); streaming never auto-scrolls, so
  reading position never moves under the user. Workspace surfaces (Memory,
  Work, Work Doc detail, Delegations, Schedules) keep natural document scroll.
  On mobile the shared sidebar becomes the compact top bar, and the active nav
  item is brought into view on mount/route change with a direct nav-list
  `scrollLeft` assignment (never `scrollIntoView`); the desktop sidebar is
  unaffected.
- Real recent chats (`src/components/RecentChats.tsx` + `src/lib/recent-chats.ts`)
  come from the API `GET /api/chats` (no localStorage, no fabricated data):
  scrollable region below the primary nav on desktop, compact collapsed
  disclosure inside the top bar on mobile; per-row agent avatar + bounded
  title/preview, message count, and an honest timestamp (`null` renders
  "saved chat, no timestamp" for legacy rows). Refresh triggers: route change
  (hard) and the chat dispatching `workforce:chats-changed` once per settled
  generation — that background refresh is SOFT: prior rows stay on screen (no
  skeleton flash) and a soft failure never downgrades a ready list to the
  error panel. Malformed listings map to fixed safe errors with Retry.
- Live progress derives the honest stage from `useChat` status plus the
  CURRENT latest assistant's raw parts (`src/lib/chat-progress.ts`:
  `Sending your message` → `Waiting for the model` → `Thinking` (only when a
  live reasoning part arrived) → `Using <tool>` (only while a tool part still
  awaits its result) → `Writing response` — junk/finished parts never fake a
  stage). The dock shows a spinner plus elapsed seconds (`aria-hidden`, so the
  polite status region is not re-announced every second; stage changes still
  announce); after ~12 s an honest "Taking longer than usual…" line appears —
  no fake percentage, no stop button. Streamed reasoning renders as a visibly
  LIVE Thinking panel only for the current generation's latest assistant turn
  (a fresh submit never reopens previous turns' reasoning) and returns to the
  collapsed `Thinking` details once complete, without duplicates.
- Offline awareness uses `navigator.onLine` + online/offline events: an amber
  warning explains that the draft and history remain, the provider request can
  fail, and nothing resumes automatically (reconnect before retrying); while
  busy offline it adds that the pending request has no confirmed progress.
  Restoring the connection clears it. Errors render as "Response failed" with
  the same safe fixed text plus connection guidance — never raw internals.

- Light / dark theme via `next-themes` (class attribute, system default,
  localStorage persistence, pre-paint script + `suppressHydrationWarning` =
  no flash and no hydration mismatch). `ThemeToggle` in the sidebar bottom
  utility area shows the ACTION (Moon + "Dark theme" in light, Sun + "Light
  theme" in dark) with CSS-class-driven markup, so it is hydration-safe
  without a mounted gate; mobile keeps a compact icon-only toggle. The
  `.dark` token set is soft neutral graphite (main `oklch(0.28)`, sidebar
  `oklch(0.245)`) — deliberately lighter than pure black, no green canvas; the
  sidebar is a subtle gray in BOTH themes and green remains only a small
  brand accent. All status colors (amber/red/emerald banners, notices,
  badges, delegation borders, agent avatar tints) carry matching `dark:`
  variants; custom CSS uses tokens only, verified across pages.
- Chat surfaces match the reference: a quiet compact agent/mode header row,
  and on an empty transcript a ChatGPT-calm centered block — greeting
  "What should we accomplish?", THE single composer instance (same
  ids/refs/handlers; rendered there on empty and in the pinned dock once
  populated — exactly one is mounted at any time) and a few rounded
  suggestion chips below. Populated chats keep the centered ~48rem
  transcript, user bubbles, assistant answers, pinned composer and
  transcript-only scrolling. Recent chats render as compact single-line rows
  (agent avatar + title + real count; full metadata stays in the row
  `title`/`aria-label` so accessibility keeps the real timestamp/preview).

/* ------------------------------------------------------------------ */
/* Auth: same-origin Better Auth client + session-aware shell           */
/* ------------------------------------------------------------------ */

- **Signed-in workspace** (Better Auth 1.7.27, same version as the API):
  `src/lib/auth-client.ts` points the official React client at
  `${API_BASE}/api/auth` with `credentials: 'include'`; every API request in
  the app sends cookies — a shared `browserApiFetch`/`browserChatFetch`
  wrapper backs all domain fetchers (memory, workdocs, delegations,
  scheduler, recent chats, hydration client fetch) and the AI-SDK chat
  transport (send + resume). Request contracts, idempotency headers and
  resume semantics are untouched.
  - Status mapping: 401 → fixed session-expired copy **and** a redirect to
    `/sign-in?next=<safe local route>`; 403 → fixed "You do not have access
    to this workspace." — never raw internals (403 also renders the fixed
    access-denied panel in `AuthGate` and on `/sign-in?error=`).
  - `AuthGate` (wrapped by `WorkspaceGate` in the shell): a loading
    skeleton while the session fetch is pending, an unauthenticated redirect
    with the intended local `?next=` route, then the real workspace with the
    user identity row (initials, name, email) and working Sign out that
    never deletes history. No test bypass exists.
  - `/sign-in` renders the standalone brand card with the value copy and
    ONLY the providers the API actually configured (public
    `GET /api/auth/providers` booleans — no fake buttons); buttons use
    Better Auth's `signIn.social({ provider, callbackURL })` with the
    callback constrained to the same-origin local route
    (`safeLocalCallback`: absolute/scheme-relative/backslash/empty values
    all fall back to `/`). Loading, provider error, and honest offline copy
    ("reconnect before signing in — nothing resumes automatically") are all
    fixed text.
- **Layout controls**: the desktop rail collapses to a ~64px icon rail
  (labels hidden, icons `title`-labelled, New chat/Sign out still reachable;
  preference persisted in `localStorage['workforce:sidebar-collapsed']`
  with corrupt-value fallbacks) and expands back; mobile opens an
  accessible drawer (`role="dialog"`, `aria-modal`, Esc + labelled backdrop,
  focus on open) holding nav + history while New chat stays permanently in
  the top bar. The chat transcript/composer column is widened to
  `max-w-[52.8rem]` (~10% over the old `max-w-3xl`).
- **Models** (`src/lib/models.ts` + chat controls): authenticated
  `GET /api/models` catalog (locked rows disabled with the server's
  value-free lock reason; `defaultModelId` = `glm-5.3-flash` in config) at
  the compact chat-controls NativeSelect; per-chat model via
  `GET/PUT /api/agents/:slug/chat/:id/model` (strict `{modelId}`; PUT first,
  applies to the NEXT generation, never interrupts a running stream;
  disabled while busy/HITL/saving; fixed safe 400/404/503/auth copy).
  Model details lazily fetch `GET /api/models/:modelId/details` on hover AND
  keyboard focus AND disclosure open (cached per model, request-sequence
  guarded), showing capabilities / parameter size / context length /
  modified date only when real, `Not reported` otherwise — no `title`-only
  essential info, no invented prices.
- **Usage** (`src/lib/chat-usage.ts`): a Session-usage disclosure by the
  model controls shows exact input/output/total tokens and per-model
  buckets (`(unattributed)` labeled honestly) from the authenticated
  `GET …/usage` route; `Estimated cost: $…` appears ONLY with a real
  `estimatedCostUsd`, otherwise the honest reason (`Pricing not configured`
  / `Partial pricing`). Per-assistant-message badges render
  `metadata.usage`/`metadata.modelId` when valid (accessible disclosure;
  absent → nothing shown, never fake zeros). Usage refreshes once after a
  turn settles (not per token), sequence-guarded, failures non-fatal.
- **Personal memory setting** (`src/lib/settings.ts` + Memory page card):
  an accessible opt-in checkbox loads `GET /api/settings` and PATCHes strict
  `{personalMemoryEnabled}` immediately, with saving/saved/error states and
  the concise explanation + scope note; no settings page added, no fake
  success, no retro-import claims.
- **Delegation depiction**: delegate_task cards and `/delegations` now read
  "Specialist sub-agent", show `Orchestrator → <worker>` with avatars, real
  `depth` chip (from the list; omitted if absent), real status badge, honest
  sync/async explanation in the page description; Markdown worker results
  stay bounded; child chats expose no parent-side relation in current APIs,
  so no fabricated parent claim is rendered there.
- New chat sessions default to **Plan mode**: absent/plan-mode URLs keep
  clean canonical URLs, explicit `?mode=action` links work verbatim, and no
  API default changed.
- **Chat mutations** (`src/lib/chat-mutations.ts` + `RecentChats`/`Chat`):
  real authenticated chat-management controls over the API mutation routes.
  Recent-chats rows expose a Delete action outside the row link (hover/focus
  reveal, always reachable on touch) behind an accessible native confirmation
  dialog naming the chat, its agent and meta, with the "artifacts survive"
  note, in-dialog error + Retry-in-place, spinner, and no accidental
  navigation (the row link and the delete button are separate tab stops).
  Deleting the CURRENT chat refreshes the list and navigates to a fresh
  Plan chat; deleting a background chat soft-refreshes in place. In Chat,
  Branch/Undo-style Rewind compact buttons appear per message (hover/focus
  reveal, always keyboard/touch reachable, disabled while busy or HITL
  pending): Branch generates a `crypto.randomUUID` destination, POSTs the
  strict `{messageId, newChatId}` body, and client-navigates to the canonical
  same-agent/same-mode destination (original preserved); Rewind opens a
  destructive confirmation quoting a surrogate-safe bounded preview of the
  selected message plus exact keep/remove semantics ("everything after it is
  deleted; kept raw bytes intact; cannot be undone"), and on success trims the
  local `useChat` state to the server's `kept` count (in-place remount of the
  same chat id — deleted messages are never retained) and refreshes history.
  Fixed safe copy for 404/409/500 and auth statuses; `workforce:chats-changed`
  fires after each success; all request bodies are validated before fetch.

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
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | The only client-exposed value (the public Express API base). Never an API key. Development keeps the browser talking to the API directly. |
| `API_INTERNAL_URL` | `http://localhost:3001` | **Server-side, never browser**: the private API origin for BOTH the baked `/api/:path*` rewrite (validated at `next build` time as a bounded http(s) origin — no path/query/hash/credentials, trailing slash ignored; an invalid value fails the build with one fixed safe error that never echoes the value; travels as a Docker build arg) AND runtime SSR chat hydration (`resolveServerApiBaseUrl`, injected via the Compose `environment.API_INTERNAL_URL`). Absent/blank at runtime falls back to `NEXT_PUBLIC_API_URL` (host dev/direct-API modes). It is never a secret and the browser never sees it. |

Production (Railway): `NEXT_PUBLIC_API_URL` = the public web origin (the browser's own origin), `API_INTERNAL_URL` = the API's private origin (e.g. `http://api.railway.internal:3001`). Local dev sets neither and stays direct-API.

No secrets reach the browser: `OLLAMA_API_KEY` lives only in the API process.
Memory embeddings run entirely server-side too (local MiniLM, 384-dim); `/memory`
never loads, stores, or requests an embedding model or vectors, and the client
rejects any block payload that carries an `embedding`/`vector` key.

Copy `.env.example` to `.env.local` for non-default values.

## Routes

| Route | Purpose |
|---|---|
| `/` | Mints a fresh chat id (server-side `crypto.randomUUID`) and redirects to the canonical chat URL, carrying a valid `?agent=`/`?mode=` from "New chat". |
| `/agents/[slug]/chat/[chatId]` | **Canonical stable chat URL.** `slug` ∈ general/orchestrator/analyst/researcher; `?mode=plan\|action` optional (default `plan` — new chats start planning; explicit `?mode=action` still honored). Unknown slug → safe 404; unsafe id → 404; unknown mode → default. Server hydration calls `GET /api/agents/<slug>/chat/:chatId` with `no-store` for the SAME slug. |
| `/chat/[chatId]` | Legacy Phase 2 URL — redirects to `/agents/general/chat/<chatId>` (a valid `?agent=`/`?mode=` is honored), so pre-Phase-4 links keep their general transcript. |
| `/memory` | Phase 3 memory workspace (unchanged). |
| `/work` | Work Docs library: filter by scope/chat id/type/status, list, create (real orchestrator POST route, draft v1, requires a chat context). |
| `/work/[workDocId]?chatId=…` | Work Doc detail: content, metadata edit via PATCH (CAS `expectedVersion`), versioned content edit via the REAL agent versions route (CAS `expectedVersion`, new immutable version), revisions, versions, typed links, rollback (`expectedVersion` + `toVersion` + confirm). The owning `chatId` is required by every doc-scoped API call — cross-chat access is a fixed 404, and the UI never links a detail view without it. |
| `/delegations?chatId=…` | One parent chat's delegations through the real `GET /api/agents/orchestrator/delegations?parentChatId=…` route: target, mode, depth, status, task, result/error, timestamps, child-chat link. Polls only while a row is pending/running (tab visible, no overlapping requests, stops on error). No manual run/retry: `/run` is an internal signed route the browser never calls. |
| `/schedules` | Phase 5 schedule dashboard over the real `/api/scheduler` routes (below). Tasks table/cards (agent/mode/recurrence summary/Active-Paused/next run) with Edit, Activate/Pause and Run now; execution-history table/cards with task + status filters, status badges, `scheduledFor` (UTC), `attempt/maxAttempts`, `durationMs`, input/output/total tokens (em dash when absent), bounded safe error, `retryOfExecutionId` link, and an `Open isolated chat` link to `/agents/<owning agent slug>/chat/<execution.chatId>?mode=<owning mode>`. DEAD_LETTER rows carry the only Retry action (details explain it creates a NEW linked execution in a NEW isolated chat; the old row stays immutable). Polls at most every 2 s, only while visible executions are PENDING/RUNNING/RETRYING (or a just-submitted run is settling), tab-gated, non-overlapping, sequence-guarded, stops on error behind a manual Refresh. All schedule input/times are UTC: minute precision, no seconds, no other timezone. The WORKER-ONLY routes (`tasks/:id/run-scheduled`, `executions/:id/run`) are never called and have no client builder. |

## `/api/scheduler` contract (Phase 5)

Contract source of truth: `apps/api/src/app.ts` mounting + `apps/api/src/scheduler/routes.ts`
and `packages/core/src/scheduler` (kinds/schemas/types). The browser may call
exactly these (helpers in `src/lib/scheduler.ts`, all tested):

| Call | Route | Notes |
|---|---|---|
| Create | `POST /api/scheduler/tasks` | body = `{ name, agentSlug, mode, prompt, scope, recurrenceType, recurrenceConfig, skipDates, timezone: 'UTC' }` — 201 `{ task }`; a 503 means the DB row stands and only the BullMQ sync failed (`Scheduler queue is temporarily unavailable.` shown verbatim + saved-row hint; the UI refreshes task state). |
| List | `GET /api/scheduler/tasks?isActive=&limit=` | `{ tasks } ≤ 100`; `isActive` only `true`/`false`. |
| Detail | `GET /api/scheduler/tasks/:id` | `{ task, executions ≤ 10 }`. |
| Update | `PATCH /api/scheduler/tasks/:id` | full editable field set; `recurrenceType`+`recurrenceConfig` always together; `nextRunAt` is recomputed server-side; same honest 503 semantics. |
| Activate/Pause | `POST /api/scheduler/tasks/:id/activate` / `/pause` | the ONLY way `isActive` changes; `{ task }`; honest 503 as above. |
| Run now | `POST /api/scheduler/tasks/:id/run` | MANUAL trigger → NEW execution + enqueue; 202 `{ execution }` (starts PENDING and settles in the history). |
| History | `GET /api/scheduler/executions?taskId=&status=&limit=` | task (UUID) / status (the 7 statuses) filters; invalid values are omitted client-side. |
| One row | `GET /api/scheduler/executions/:id` | `{ execution }`. |
| Retry | `POST /api/scheduler/executions/:id/retry` | DEAD_LETTER-only (409 otherwise): NEW linked execution + NEW isolated chat; 202 `{ execution, retryOfExecutionId }`. |
| NEVER | `POST /api/scheduler/tasks/:id/run-scheduled`, `POST /api/scheduler/executions/:id/run` | WORKER-ONLY (they carry BullMQ occurrence metadata the browser never mints); no builder exists in the client. |

Recurrence shapes (strict pair rule, from `packages/core/src/scheduler`):
`ONCE { runAt: UTC Z ISO }` (a `datetime-local` value converted by the client —
seconds never stored), `DAILY { hour, minute }`, `WEEKLY { hour, minute,
weekdays 0..6 unique }` (0=Sunday), `MONTHLY { hour, minute, daysOfMonth 1..31
unique }`, `CUSTOM_CRON { expression: exactly 5 whitespace-separated fields, ≤200 chars }`.
`skipDates`: comma/newline textarea → unique real `YYYY-MM-DD` UTC dates (≤366),
deduped/validated client-side (all-or-nothing). Strict mappers reject malformed
rows (wrong enum/value/shape, config/type mismatch, non-UTC instants, unsafe
chat ids, non-UUID ids, malformed `tokenUsage`) into one safe fixed refresh
error — no raw payload ever reaches the DOM.

## Chat (Phase 2 core, Phase 4 surface)

- **Agent picker + Plan/Action** on every chat page. Selecting an agent or mode
  navigates to the canonical URL for that (slug, mode); the server page re-hydrates
  that key's transcript (transcripts are stored per `(slug, chatId)`), and the client
  component is keyed by slug+mode so `useChat` re-seeds. Plan is visibly labeled as a
  NEXT-generation choice — there is no mid-turn escalation; the mode rides the next
  POST only.
- **Send** (`POST /api/agents/<slug>/chat`): body is exactly
  `{ id: chatId, message: newestUserMessage, mode }` (mode omitted only when no
  selection is made), with the unchanged header `Idempotency-Key: <chatId>:<messageId>`
  (API 400s on any mismatch; duplicate message id → 409 surfaced safely).
- **Resume**: `useChat({ resume: true })` reconnects at mount via
  `prepareReconnectToStreamRequest` against `GET …/chat/:chatId/stream` for the same
  slug. `resumeStreamIsReplay` stays at its default `true` (ADR-008): full SSE replay,
  interrupted assistant message rebuilt exactly once, `204` = silent idle.
- **No stop button.** Refresh/disconnect never aborts the provider generation
  (ADR-005); reconnecting resumes it. There is no abort call in this codebase.
- **Throttle**: `experimental_throttle: 50` (≈50 ms) for streamed UI updates.
- **Assistant message regions** (`src/lib/parts.ts` + Chat components): each assistant
  turn renders exactly once per part, split into labeled regions so reasoning and tool
  output never mix into the prose:
  - `Response` — all text parts joined in original order with blank lines and rendered
    as real Markdown (`react-markdown` + `remark-gfm`: headings, lists, bold/italic,
    blockquotes, rules, code, GFM tables/strikethrough). Raw HTML is NOT enabled (no
    `rehype-raw`, no `dangerouslySetInnerHTML`) and wide tables/fenced code scroll
    sideways inside the column. Partial streamed Markdown renders as plain prose until
    syntax closes — streaming never crashes.
  - `Thinking` — all reasoning parts in a collapsed-by-default `<details>`.
  - `Tool activity (N)` — every non-HITL tool part (all six cards below, plus unknown
    `tool-*` fallback) in a separate collapsed-by-default `<details>` whose summary
    lists deduplicated tool names, so giant always-open results (e.g. `search_memory`)
    never dominate the thread.
  - Pending HITL: an unanswered (`input-available`) `ask_user` stays top-level and
    prominent while the answer gate is active (newest assistant message only — the
    same gate as the composer); answered/older `ask_user` parts move into Tool
    activity as readable cards. Never hidden, never duplicated.
  - `user` messages keep the plain Phase 2 text rendering; `general`/`calculate`
    behavior stays compatible (a simple calculate turn shows the answer text plus the
    collapsed calculate card).
- **Tool-part rendering** (`src/lib/tools.ts` + component views): human-labeled cards,
  all content bounded plain text (React escapes; no `dangerouslySetInnerHTML`):
  - `calculate` — unchanged Phase 2 rendering (dedicated tested helper).
  - `write_doc` — create/update/rollback operation, doc id, target/version; links to
    `/work/<id>?chatId=<current chat>` when the id is a UUID.
  - `delegate_task` — target/mode/task bounded; status, result/error rounded down to
    safe bounded text; child chat links to `/agents/<target>/chat/<childChatId>` only
    for safe ids and worker slugs.
  - `query_data` — bounded SQL, column/row table (≤8 rows on screen), `rowCount`, and
    an explicit "showing the first rows only" note when the display is truncated.
  - `search_memory` — query, ≤5 bounded results with path/kind/scores, link to `/memory`.
  - `ask_user` — prominent, screen-reader-announced question with options; the answer
    form below the thread is the channel:
- **HITL answering**: while the newest message is an assistant turn holding a pending
  (`input-available`) `ask_user` part, the normal composer is disabled and a labeled
  answer form (textarea + suggested-answer buttons + "Send answer") is shown. Submitting
  sends a NORMAL user message through the same path — the API marks the part
  `output-available { answer }` and resumes the generation. No fake local answer state.
  Generic `tool-*` parts fall back to a bounded name/state/input/output card.

## /memory workspace (Phase 3 — unchanged)

Same panels and behaviors as the Phase 3 release: create (bounded fields, live
counter), browse (filters + refresh + auto-poll while blocks are `pending`), semantic
search (80% cosine + 20% recency, fixed 3-decimal display), related blocks, retry for
failed embeddings, compaction with the >30-character expectation gate. Pure helpers in
`src/lib/memory.ts` (tested); polling is 2 s, visibility-gated, non-overlapping.

## Architecture

```
app/page.tsx                          root → crypto.randomUUID() → redirect to canonical chat URL (with selection)
app/chat/[chatId]/page.tsx            legacy /chat/:id → redirect (general; honors a valid ?agent=/)
app/agents/[slug]/chat/[chatId]/page.tsx server hydration fetch (no-store) → <Chat> seed; safe notFound boundaries
app/memory/page.tsx                   /memory shell → <Memory>
app/work/page.tsx                     /work shell → <WorkDocsList> (chatId/scope/agent params validated)
app/work/[workDocId]/page.tsx         detail shell → <WorkDocDetailView> (chatId required)
app/delegations/page.tsx              delegation panel shell → <DelegationsView>
app/schedules/page.tsx                /schedules shell → <Schedules> (fully dynamic)
src/components/Chat.tsx               'use client': agent/mode controls, useChat + transport, tool-part and HITL rendering
src/components/Memory.tsx             'use client': Phase 3 workspace (unchanged)
src/components/WorkDocs.tsx           'use client': library list + create (real routes)
src/components/WorkDocDetail.tsx      'use client': metadata PATCH, versioned content edit, versions/revisions/links, rollback
src/components/Delegations.tsx        'use client': parent-chat delegation list + polling
src/components/Schedules.tsx          'use client': Phase 5 schedule dashboard (create/edit form, task table/cards, execution history + polling)
src/lib/scheduler.ts                  Phase 5 scheduler request/body/mapping/poll/link helpers (tested)
src/lib/api.ts                        chat request/response helpers (send/hydrate/resume, slug-aware; tested)
src/lib/api-proxy.ts                  Phase 6 server-only /api/:path* rewrite target for `next.config.ts` (API_INTERNAL_URL; tested)
src/lib/agents.ts                     agent/mode roster, URL builders, guidance (tested)
src/lib/tools.ts                      tool-part formatting + pending-ask_user scan (tested)
src/lib/parts.ts                      assistant-part partitioning into Response/Thinking/Activity regions (tested)
src/lib/workdocs.ts                   Work-Docs request/body/mapping helpers (tested)
src/lib/delegations.ts                delegation list mapping/query/poll helpers (tested)
src/lib/memory.ts                     Phase 3 memory helpers (tested, unchanged)
src/lib/calculate.ts                  Phase 2 calculate formatting (tested, unchanged)
src/lib/messages.ts                   UIMessage typing for the six Phase 4 tool keys
```

Design rules kept from Phase 2/3: stable ids in URLs, server as source of truth,
`no-store` hydration, full-replay resume, no stop/abort, explicit accessible names on
every control, `role="status"`/`role="alert"` live regions, visible focus outlines,
single-column responsive layout, safe text-only rendering (assistant Markdown renders
through `react-markdown`'s React tree — raw HTML disabled, everything escaped, no
`dangerouslySetInnerHTML`), safe fixed error strings only.

## Tests (offline, pure — node:test)

`npm test` runs 240 tests across:

- `test/api.test.ts` — Phase 2 wire contract (send body/headers, endpoints,
  hydration mapping, safe errors) — unchanged and green.
- `test/calculate.test.ts` — `calculate` output formatting — unchanged and green.
- `test/memory.test.ts` — Phase 3 memory helpers — unchanged and green.
- `test/agents.test.ts` — roster/mode parsing, canonical + legacy URL building,
  child-chat URL gating, slug-aware send/hydrate/resume endpoints, `{id,message,mode}`
  body + unchanged idempotency header, plan/action guidance that names only composed
  tools — with the web-wide default flipped to `plan`: absent/plan URLs stay clean,
  explicit `?mode=action` rides the documented body/URL and every pre-existing
  explicit-mode link keeps working unchanged.
- `test/tools.test.ts` — lifecycle labels, bounded text/JSON shaping, write_doc /
  delegate_task / query_data / search_memory / ask_user parsing, pending-ask_user
  scan, generic unknown-tool fallback.
- `test/parts.test.ts` — assistant-part region partitioning: reasoning separation,
  multiple text parts joined in original order with blank lines around tools, tool
  grouping/count + summary label, pending ask_user exclusion/gating (and answered
  or second ask_user never pending), streaming/junk/unknown parts dropped without
  duplication.
- `test/workdocs.test.ts` — exact endpoint URLs (?chatId everywhere it is required),
  list/PATCH/version/rollback/create body contracts (CAS `expectedVersion` +
  `toVersion`), response mappers (valid/malformed), 409 conflict text + hint,
  typed-link → in-app page mapping, display truncation.
- `test/delegations.test.ts` — required `parentChatId` query, row validation against
  the status machine, poll predicate (pending/running only), child-chat URL gating,
  safe error collapse, no-retry stance (the guarded `/run` route is never surfaced).
- `test/scheduler.test.ts` — exact `/api/scheduler` endpoint URLs (tasks, activate/
  pause/run, executions, retry), task + execution query builders (invalid enum/UUID
  values dropped), every recurrence type valid + invalid with ONCE `datetime-local`
  → UTC `Z` conversion (seconds stripped, offsets/non-real dates rejected), skip-dates
  editor (comma/newline, dedupe, real dates, 366 cap), create/update bodies (UTC
  timezone, scope normalization, NO `isActive` on create/update), strict task/execution
  mappers (malformed rows, config/type mismatch, token usage, non-UTC instants,
  unsafe chat ids rejected), response mappers (list/detail/mutation/run 202/retry
  202), formatters (recurrence summary per type, `attempt/maxAttempts`, `durationMs`,
  token em dashes, bounded error, badge data-status), chat/retry links keyed to the
  OWNING task's agent+mode, DEAD_LETTER-only retry gate, poll predicate
  (PENDING/RUNNING/RETRYING + settle window, never terminal-only), and stub-fetch
  orchestration for the real routes (API error text verbatim, honest 503 status).
- `test/workspace.test.ts` — UI-refresh shell/empty-state helpers: nav metadata  covers every section id once (Chat → Memory → Work docs → Delegations →
  Schedules) with stable hrefs/prefixes, canonical `/agents/:slug/chat/:id` and
  legacy `/chat/:id` URLs route to the chat section (`/` matches only itself,
  never other roots), detail paths (`/work/:id`) stay in their section, unknown
  paths fall back to chat, every servable agent has a human label with a raw-slug
  fallback, and every agent gets 3–4 non-empty unique empty-state suggestions that
  stay honest to each agent toolset (general calculation-only, researcher without
  SQL, orchestrator naming its real memory/query/document/delegation verbs).
- `test/auth.test.ts` — auth contract helpers: `safeLocalCallback`
  (same-origin local routes only — absolute/scheme-relative/backslash/empty
  values fall back to `/`, queries kept, custom fallback honored),
  401→session-expired vs 403→access-denied fixed mappings (other statuses
  null), non-browser-safe `requestAuthError`, provider endpoint URL with
  trailing-slash normalization, strict boolean `mapAuthProviders` (valid
  rows pass, every malformed shape maps to the fixed safe error, extra
  fields accepted), and the literal `credentials: 'include'` contract.
- `test/layout-controls.test.ts` — sidebar collapse persistence through an
  injected storage (missing/corrupt/throwing storage never breaks callers,
  explicit true/false round-trips), expanded `md:w-[260px]` vs collapsed
  `md:w-[64px]` rail widths, and the chat column `max-w-[52.8rem]`
  (~1.10× the old `max-w-3xl`) as a statically detectable class.
- `test/chat-mutations.test.ts` — chat mutation contract helpers: canonical
  DELETE/branch/rewind endpoint URLs (unsafe ids/slugs produce none; trailing
  slash normalized), strict `{messageId,newChatId}` / `{messageId}` body
  validation BEFORE fetch, 200/201 response mapping plus the exact fixed
  404/409/500/auth-status copies (401 → session-expired), mutation gating
  while busy/HITL, destination href preserving agent+mode, rewind local-state
  trim (`kept` prefix, never mutating the source), and the bounded surrogate-
  safe message preview used by the destructive confirmation.
- `test/recent-chats.test.ts` — recent-chats history contract: endpoint URL
  (default 20, max-50 clamp, invalid limits fall back), structural mapping of
  valid rows (bounded trimmed title/preview, integer counts, ISO timestamps)
  with empty-title → "Untitled chat" and empty-preview kept as hidden, legacy
  or invalid timestamps staying `null` (never fabricated), every malformed
  shape (bad chatId/agent/title/preview/count, wrong `chats` container, non-
  object rows) mapping to the fixed safe error, canonical agent-scoped hrefs,
  current-row detection ignoring `?mode=`, bounded UTC stamp/meta formatting
  (honest "saved chat, no timestamp"), surrogate-pair-safe truncation
  (boundary-in-pair retreats; intact pairs kept), and the namespaced
  `workforce:chats-changed` event value.
- `test/chat-progress.test.ts` — progress stage machine: submitted → "Sending
  your message"; streaming with empty/junk parts → "Waiting for the model";
  thinking only for live reasoning (whitespace-only ignored); `Using <tool>`
  only while `input-streaming`/`input-available` (finished tool parts are
  history); visible text → "Writing response"; precedence tool > text >
  reasoning; first pending tool wins; long-wait threshold (≥12 s honest copy,
  never promising auto-resume); floored/clamped elapsed formatting; offline
  copy keeping draft/history, requesting reconnect, and stating no confirmed
  progress while busy.
- `test/api-proxy.test.ts` — Phase 6 single-origin API proxy helpers
  (`src/lib/api-proxy.ts`, ADR-009): the SERVER-ONLY `/api/:path*` rewrite
  target (`API_INTERNAL_URL`) — default/blank fallback to
  `http://localhost:3001` (itself a bounded origin), Railway-style private
  origins accepted with a single trailing slash normalized away, every
  non-origin shape (real path, trailing multi-slash, query, hash, userinfo,
  wrong scheme, relative/scheme-relative, empty host, out-of-range port)
  rejected with the ONE fixed safe error that never echoes the value
  (build/log safe), and `apiProxyRewrites` building exactly
  `{ source: '/api/:path*', destination: '<origin>/api/:path*' }` so auth
  callbacks, `providers` and SSE resume stay same-origin through one source.

## Validation limitations (honest — the phase gate is Farhan's live run)

- Tests cover only the **pure helpers**. No React/browser tests were added
  (by design, no extra stack).
- Phase 5 (`/schedules`) is NOT live-validated yet. Not yet run against the live
  stack: creating every recurrence type end-to-end, the honest 503 queue-sync flow
  (row stands, UI keeps the task after refresh), MANUAL run 202 → PENDING →
  RUNNING → terminal settling through the 2 s poll, DEAD_LETTER retry creating a
  NEW linked execution + NEW isolated chat, filter-driven history refresh,
  execution chat links landing in the right agent transcript, and the scheduler
  worker actually picking the synced BullMQ jobs. Run the API (`npm run dev` with
  Redis + Postgres + the scheduler worker) and `npm run dev` here, then walk the
  phase-5 validation gate.
- Not yet run against the live Phase 4 stack: agent/mode switch navigation +
  per-slug hydration, plan-mode generations actually WITHOUT write/delegation tools,
  `write_doc` → Work Doc page round-trip, CAS conflict (409) behavior in the PATCH /
  version forms, rollback creating a new version, delegation status polling
  (`pending → running → completed/failed/timeout`), child-chat linking, and HITL
  `ask_user` end-to-end (question asked → answer submitted through the normal POST →
  part resolved → generation resumed). Run the API (`npm run dev` in `apps/api`, with
  Redis + Postgres) and `npm run dev` here, then walk the phase-4 validation gate.
- Content editing in the UI goes through the REAL agent versions route
  (`POST …/work-docs/:id/versions`) with `source: 'user'` recorded in the
  revision trail (the route accepts optional `source: 'agent' | 'user'`,
  default `agent`; agent-originated `write_doc` calls stay server-side).
  There is no shadow user-content endpoint.

- **Three-column workspace (Farhan, visual refs)**: desktop chat is now
  left rail + flexible center + a ~320px right **Session** context rail
  (`lg:flex`, border-left, independent scroll; `<lg` becomes a labelled
  toggled overlay drawer via the icon button in the quiet center header).
  The top toolbar is gone — agent select and Plan/Action moved INTO the
  composer control row, and the model NativeSelect became the reference
  `ModelPicker` popover (Radix `Popover`, search box, real filtered catalog,
  selected check, locked-Kimi rows disabled with the lock reason, keyboard +
  Esc/outside dismissal) with an adjacent detail region fed on hover/focus/
  selection: provider `Ollama Cloud`, real capabilities, `Input: text[, image]`
  (image only with a real `vision` capability), `Output: text`, context/
  parameter where real (`Not reported` otherwise), thinking flag when the API
  reports one, and **Cost ($/1M tokens)** from the additive `pricing` field or
  honest `Not configured`. Old model-details/Session-usage header disclosures
  were REMOVED (functionality moved); per-message usage badges stay. The
  Session rail shows: provider/model/agent/mode; **context % of the latest
  request** (latest assistant `metadata.usage.inputTokens` ÷ selected model's
  real `contextLength`, bounded, `Not reported` if either side missing);
  exact session in/out/total with per-model buckets; configured estimate or
  honest reason; latest-turn usage; real tool count from parts; and real
  delegation rows (target/mode/status + child links) polling only while
  pending/running and visible (seq-guarded). Unavailable metrics (cache
  hits, quotas, tokens/sec, timing, files changed) are omitted, never
  fabricated. Chat keeps transcript-only scrolling with the pinned composer,
  one composer instance, and all preserved behaviors listed above.
- **Session rail helpers** (`src/lib/session-rail.ts`, `test/session-rail.test.ts`):
  `contextPercent` (bounded 0-100, strict integer inputs, unknown `null`),
  `latestAssistantUsage` (strict metadata read), `countToolParts` (HITL
  ask_user pending question excluded), `filterModels` (name/id
  case-insensitive), `inputModality` (image only with real `vision`), and
  `formatModelCardLines` (provider/real-fields/`Not reported`/pricing or
  `Not configured`/lock reason). `mapModelDetails` now validates the additive
  `pricing: null | {inputUsdPerMillion,outputUsdPerMillion}` — non-null but
  missing/partial/invalid rates REJECT the payload (never $0).

## Pre-Phase-6 sprint integration note (2026-11-24 final)

Recorded from the orchestrator's live desktop gate (1440×900, explicit
`Browser Gate` identity via the gitignored `.openchamber/browser-gate-proxy.mts`
proxy on `127.0.0.1:3002`): real model catalog/details and locked-Kimi
selection behavior, per-chat model persistence, real calculator turn with
per-message/session usage (pricing honestly unavailable), the personal-memory
toggle round-trip (capture took effect for a fresh chat; OFF verified),
branch/rewind/delete flows (synchronous-`showModal()` rewind dialog,
kept-prefix rebuild, fresh-Plan redirect on current-chat delete), sidebar
collapse/expand, Specialist sub-agent depiction for a real async delegation,
and the final sidebar-viewport + default-Plan + rewind-dialog fixes.
Offline total for the web workspace: **213/213** (root offline 980 across all
workspaces; the real-integration suite **54/54** and the production build
passed before those last three small web fixes — no new build/integration
rerun is claimed after them). Known limitation: the new mobile drawer was NOT
live-verified (no reliable mobile-resize viewport in this run; mobile CSS and
pure helper tests remain). OAuth follow-up: a real user reached Google, but
the post-auth return landed on the API origin (`http://localhost:3001/…
Not found`) because a relative `callbackURL` resolves against the AUTH base;
`SignInView` now sends an absolute same-origin web callback via
`absoluteWebCallback(window.location.origin, nextPath)` (regression-tested in
`test/auth.test.ts`). Real Google/GitHub browser confirmation POST-FIX remains
pending.

## OpenChamber rework follow-up (2026-11-25 — fix pass on the three-column build)

Browser-verified misses from the first three-column build, fixed:

1. **Header layers**: the shell no longer renders the eyebrow/title header on
   chat surfaces; the chat's own quiet identity line
   (`{Agent} · {Plan|Action} mode · {model}` with `aria-live`) is the ONLY
   header, plus the Session rail toggle. Operational page headers unchanged.
2. **Session sheet**: the rail's per-section bordered cards were replaced by
   ONE bottom-anchored sheet with rounded top corners
   (`rounded-t-2xl border-t border-x bg-card shadow-sm`), compact sections
   divided by hairlines, real metrics only; the raw chat short ID and
   empty-value noise were removed. The desktop rail column anchors the sheet
   to the bottom (`justify-end`, scrollable); the <lg drawer holds the same
   sheet. Collapse/reopen (labelled header button + vertical reopen strip)
   and the drawer flow are unchanged.
3. **Model picker**: the always-on detail card was replaced by an
   OpenChamber-style hover/focus Tooltip (Radix `Tooltip`, portal,
   `collisionPadding`, side="right") showing EXACTLY Provider, Capabilities,
   Input, Output, and Cost ($/1M tokens with real in/out rates or honest
   `Not configured`); no model name, context, parameter size, thinking,
   modified date, or note in the tooltip. Locked Kimi rows stay disabled
   with the server lock reason visible ON the row. Search autofocus
   (`searchRef` focus in `onOpenAutoFocus`), selected check,
   keyboard/Esc/outside close, and catalog loading/error states kept. The
   real `detailsLoading` state is threaded and drives honest "Loading…"
   VALUES inside the five fields (never a fabricated fake row count).
4. **Plan→Action flicker**: mode is now IN-PLACE client state
   (`activeMode` + ref) with a shallow
   `history.replaceState(modeReplaceHistoryState(history.state, url), '', url)`
   — no RSC navigation, no Chat remount, no useChat reset. The chat page key
   is now `${agent}:${chatId}` (mode removed), the transport is stable
   (`useMemo` deps `[apiBaseUrl, agent]`) and reads the mode ref at send
   time; genuine agent navigation re-hydrates as before via
   `navigateTo`, which now routes mode changes to the in-place path when
   only mode differs. Draft, messages, and scroll survive the switch.
5. **Composer**: one clean rounded rectangle (`rounded-2xl border bg-card`)
   with the textarea borderless inside it, and a bottom toolbar row
   (ModelPicker + agent + Plan/Action + hint + Send) under a hairline
   divider. Empty state centers the same single composer; populated state
   keeps transcript-only scrolling with the pinned dock; the HITL answer
   form is unchanged.

Verification (implementation pass): web typecheck clean; web tests 222/222;
web production build exit 0. Final orchestrator run: root `npm run typecheck`
PASS and **root tests 1018/1018** = core 314 + queue 47 + CLI 30 + API 405 +
web 222 (supersedes an earlier timeout and one intermittent API 404 test; no
behavior change was made for it). The final browser gate used the Browser
Gate test identity (web `127.0.0.1:3100`, proxy 3002, real API/models/store):
one compact header, one rounded composer card with model/agent/Plan/Action,
the bottom-anchored Session sheet (x1094/y346, 330×554, 16px top radius),
nonduplicated labels with distinct rail/drawer IDs, model search/select and
locked Kimi, `glm-5.3-flash` default restored, in-place Plan→Action with
draft preserved and no visible remount, a real send answered **42** (exactly
2 messages, one `calculate`), real usage 580/64/644 with model-correct
context **0%** and tools **1**, Session hide/reopen, and reliable small-tab
(~634px) default Plan + drawer open/close. Pending: post-fix real OAuth
redirect confirmation; the tooltip's five fields are source/pure-test
verified (live hover not drivable by the browser API); no claim of
exhaustive component testing. Post-fix real OAuth redirect confirmation remains pending (fix and regression tests recorded above).

## Phase 6 local production closeout (2026-11-27 — runtime container SSR verified, real OAuth still pending)

The web app passed the Docker isolated **single-origin production gate**
(local only — unique Compose project, fresh volumes, alternate loopback
ports, dummy secrets, **local mock OpenAI/Ollama**):

- **Runtime SSR verification passed** in the standalone container: the
  earlier SSR failure (`Chat history is temporarily unavailable`) is fixed
  by `resolveServerApiBaseUrl` + the Compose runtime
  `API_INTERNAL_URL`; rebuilt SSR HTML **includes the transcript** (no
  error), and unauthenticated/foreign-owner requests see **no** transcript.
  This confirms the dual role documented in the env table above: the same
  `API_INTERNAL_URL`/`WORKFORCE_WEB_INTERNAL_API_URL` value drives BOTH the
  build-time `/api/:path*` rewrite target AND runtime SSR hydration
  (runtime value changes need `docker compose up --build` for the rewrite;
  SSR hydration follows the container env).
- **Browser-side, through the public web origin only**: streamed chat
  (`calculate`, exact mock usage 28/18/46), hydration/export/usage correct,
  duplicate send → 409 with no extra model call, disconnect → **full
  same-origin replay exactly once** → post-complete resume → 204.
  Same-process replay only (replay completed before restart — **no
  cross-process replay claim**).
- **Identity (local only)**: real Better Auth `User`/`Session` fixtures with
  valid signed cookies; dummy-provider matrix (true/false), unauth
  get-session → null and chat → 401, and social sign-in init building the
  public web callback URL without contacting Google/GitHub all verified.
  **The real Google/GitHub OAuth return is STILL pending** — unchanged from
  the pending notes above.
- Current workspace totals within the 2026-11-27 root gate: web offline
  **245/245**, root offline 1095/1095 + integration 62/62 + full production
  build — all green. Phase 6 remains active and **not validated** (public
  URL gate deferred by Farhan's local-only decision).
