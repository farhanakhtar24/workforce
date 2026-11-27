# Pre-Phase-6 — Product Feature Sprint (implementation plan)

Written 2026-11-24 as a **self-contained implementation plan**. Docs+code sprint on the existing repo; written while Phase 5 was just validated.

**Where we are (2026-11-24)**:

- Phase 5 (Queues & Schedulers) **validated**: the live real-provider browser gate PASSED 2026-11-24 (full evidence in [`docs/phases/phase-5-queues.md`](../docs/phases/phase-5-queues.md)), and Farhan's approval is recorded **by progression the same day** — after the passed gate he said next phase, then explicitly paused Phase 6 for this feature sprint.
- **Phase 6 (Docker, Deploy, Observability) is paused — NOT started.** Farhan explicitly paused it in favor of this sprint. This sprint **never starts or claims Phase 6** (no Docker, pino, OpenTelemetry, deploy targets, or public exposure).
- Phase 1–4, the ADR set (ADR-001…008) and every recorded test total stand untouched. Historical test counts are **never edited** by this sprint; new totals are recorded as new dated entries.

**What Farhan ordered** (restated as sprint features F1–F12):

1. **F1 Auth** — Google + GitHub OAuth via **Better Auth in Express**, with **persistent sessions**.
2. **F2 Tenancy** — **private per-user workspaces** across chats, memory, workdocs, delegations, schedulers.
3. **F3 Legacy hygiene** — old test chats are removed **only** via a separate, explicitly confirmed, **irreversible** cleanup; **never automatic**.
4. **F4 Delete chat** — normal user delete for the user's own chats.
5. **F5 Rewind mode A** — **non-destructive branch-from-message** (fork a chat at any message; original stays intact).
6. **F6 Rewind mode B** — **destructive rewind** (truncate the chat back to a chosen message, dropping everything after).
7. **F7 Stream safety** — **active-stream protection** for every destructive chat op (delete/branch/rewind).
8. **F8 UX polish** — sidebar collapse toggle; chat content width **+10% from `max-w-3xl` to `max-w-[52.8rem]`**; **new chats default to Plan**.
9. **F9 Model catalog** — dynamic Ollama model catalog with **hover details from `/api/tags` + `/api/show`**; **default `glm-5.3-flash`**; **every Kimi id locked in the UI and rejected server-side at selection AND generation**.
10. **F10 Usage & cost** — per-chat token usage and estimated USD **only from explicitly configured per-million input/output rates**; otherwise **honestly unavailable** (Ollama has no per-chat billing).
11. **F11 Delegation depiction** — improved depiction of the **EXISTING sync/async delegation to analyst/researcher**; **not** arbitrary subagent spawning.
12. **F12 Personal learning** — **opt-in** learning from old chats, written into **per-user isolated memory**.

---

## 1. Evidence chain

- Repo state: 8 phases of recorded work; current recorded root offline total **810 green** (core 243, `@workforce/queue` 47, CLI 30, API 318, web 172), recorded real-infrastructure suite **34/34** (earlier chat-history records mention 37 — historical records stay exactly as written; this sprint records fresh totals when it runs).
- Surfaces in place: chat (`/agents/:slug/chat/:chatId`), `/memory`, `/work` + `/work/[id]`, `/delegations`, `/schedules`, shared `WorkspaceShell` (Tailwind v4 + shadcn/ui + Lucide), real recent-chats history, light/dark theme.
- Governing ADRs this sprint must preserve: ADR-001 (composition-time gating), ADR-002 (agents call own REST), ADR-003 (memory tree), ADR-004 (delegation depth cap 2, same-REST child chats), ADR-005 (SSE + idempotency, Redis hard dependency), ADR-006 (BullMQ Job Schedulers), ADR-007 (pgvector + local MiniLM), ADR-008 (AI SDK UI streams).
- Current single-tenant facts: memory blocks/scheduler tasks carry `scope = 'default'`; Work Docs and delegations have no owner column; chat ownership does not exist; there is **no auth layer** today.
- Farhan's requirement that the chat column widen by +10%: `max-w-3xl` = 48 rem → **48 × 1.1 = 52.8 rem** → `max-w-[52.8rem]`.
- Kimi lock is Farhan's product decision: the mechanism in this plan (UI-locked + server-rejected at selection and generation) is the contract, not a justification of the reason.
- Uncertainty owned by the implementing sessions: exact Better Auth version pin, OAuth dev-loop details per provider, and Redis key shapes for chat ownership (design below is the target; adjustments are allowed only if the contracts in §4 hold).

**A new ADR is required at S0 acceptance** (suggested `ADR-009: Better Auth + per-user tenancy over single-tenant demo mode`) — following repo practice of recording architectural decisions when they are made.

---

## 2. Sprint-level architecture decisions

- **Auth**: Better Auth (Prisma adapter over the existing Postgres; Node handler mounted on Express). Sessions live **in Postgres** (persistent across API restarts), cookies `httpOnly`, `sameSite=lax` (`secure` in any future deployment — Phase 6 territory, explicitly not built now). Google + GitHub social providers. The auth mount must receive the **raw body** → it is mounted before the JSON body parser, or its route is excluded from `express.json`.
- **Tenancy**: a new `ownerId` (the Better Auth user id) on every resource created **after** S0/S1. Memory and scheduler reuse the `scope` column with a per-user scope value (`user:<userId>`); WorkDocs/delegations gain a nullable `ownerId` column. **Legacy single-tenant rows are quarantined, never automatically assigned, migrated, or deleted** — their only exit is the S8 cleanup (for chats) or a separate explicitly confirmed decision (for everything else).
- **Chat model**: the existing Redis transcript LIST + per-user recent-chats index stay; ownership is recorded server-side at creation in the durable chat record. Per-user index replaces the single recent list; the legacy list is quarantined with everything else.
- **Internal workers stay key-less and authenticated by signature**: delegation workers (Phase 4) and the scheduler worker (Phase 5) now carry a **server-signed internal context** (HMAC with a persistent env secret, short TTL, bound to chat/execution id + owner scope) on their own-REST calls. The browser can never mint one — this extends the existing trusted-context principle (ADR-002/004) to ownership.
- **Model selection** flows as data, not as a new runtime: chat POST gains an optional `model`; the API validates it against the catalog + Kimi blocklist; the provider call uses the validated id; absent → user preference → **default `glm-5.3-flash`**.
- **Usage/cost is derived, never observed**: tokens come only from provider-reported usage metadata (Phase 5's nullable contract, never fabricated); USD comes only from explicitly configured per-million input/output rates. There is **no Ollama billing integration of any kind**.

---

## 3. Security & privacy invariants (INV-1…INV-12, non-negotiable)

- **INV-1 Session integrity**: sessions are DB-backed and persist across restarts; cookies `httpOnly`/`sameSite=lax`; no session tokens in URLs or logs; OAuth state handled by Better Auth only.
- **INV-2 Gating**: every resource route (existing + new) requires a session behind the auth mount; fixed **401** `{error:'unauthorized'}`. The auth mount itself and any pre-existing health route stay ungated.
- **INV-3 Ownership**: every read/write is scoped to the signed-in owner. Cross-owner access answers **404** (no existence leak), never 200.
- **INV-4 Quarantine**: legacy ownerless data is invisible to all users, never auto-reassigned, never auto-deleted. **Old test chats are removed only via the S8 cleanup — explicitly confirmed, typed-confirmation gated, irreversible, and never automatic** (no cron, no startup path, no UI button, no scheduler task, no test fixture).
- **INV-5 Shared-key spend privacy**: actual **account-level Ollama spend must never be fetched, shown, or be derivable to any user of a shared key.** Cost numbers exist only as per-chat estimates from explicitly configured per-million rates, always labeled "estimate — not your Ollama bill". No billing/account endpoint is ever proxied (`/api/tags` and `/api/show` only).
- **INV-6 Kimi block**: the blocklist decision is **server-side**: model-selection and generation paths reject any Kimi id with fixed **400** regardless of what the UI does; the UI lock is cosmetic only.
- **INV-7 Honest unavailability**: token usage absent → "provider did not report usage"; rates unconfigured → "no configured per-million rates"; catalog unreachable → "model catalog unavailable". Never zeros, never invented numbers (existing repo principle: nullable, never fabricated).
- **INV-8 Active-stream safety**: delete/branch/rewind are refused with fixed **409** while the chat has an active/recovering stream (existing `activeStreamId` marker), while a linked delegation is `pending`/`running`, and for scheduler-execution-owned chats (Phase 5 audit rows are immutable).
- **INV-9 Destructive ops are confirmed**: destructive rewind states what will be permanently dropped before it runs; chat delete confirms; S8 requires its typed confirmation and exact count.
- **INV-10 Internal contexts**: signed internal worker contexts are short-TTL HMAC secrets from server env; browsers never mint or see them; existing "browser never mints internal worker metadata" rule is preserved and extended to ownership.
- **INV-11 No secrets in logs or client bundles**: provider keys stay server-side (existing rule); `BETTER_AUTH_SECRET` and OAuth client secrets never reach `apps/web`.
- **INV-12 Memory isolation**: `search_memory` and Phase 3 memory routes resolve the owner's scope from the session (or the signed internal context for child chats) — cross-user memory is unreachable; personal-learning writes land only in the owner's scope.

---

## 4. Vertical slices

Order: **S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8** (S3 is independent of S2 and may run in parallel; S8 is last and blocked on everything above plus Farhan's explicit go).

Every slice ends **green**: root `npm run typecheck`, root `npm test`, targeted workspace runs, and fresh recorded totals as a **new dated entry** in the sprint record (§6) — never an edit of a historical count.

### S0 — Better Auth foundation: Google + GitHub OAuth, persistent sessions

- **Goal**: sign in with Google or GitHub; a session survives API restarts; signed-out users get fixed 401s on resource routes.
- **Contracts**:
  - Mount `app.all('/api/auth/*', toNodeHandler(auth))` on Express **before** the JSON body parser (raw body required); exclude the auth mount from `express.json`.
  - Better Auth Prisma adapter over the existing Postgres; **database session storage** (persistent; 30-day expiry with rolling refresh on activity). Tables: Better Auth `user`/`session`/`account`/`verification` via migration.
  - Env: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (`http://localhost:3000` locally), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Missing provider creds → that provider's sign-in is disabled with honest "not configured"; **at least one** provider + the secret is required for auth to be enabled; with auth disabled the API boots with a documented warning and every resource route answers 401 (honest, no crash).
  - `requireSession` middleware: session lookup via Better Auth; injectable in offline tests (the repo's injectable-deps pattern); fixed 401 shape.
- **Web**: minimal `/signin` with Google/GitHub buttons; shell user menu (email/avatar-or-initials, sign-out); no fake user data anywhere.
- **Tests**: offline — 401 gating matrix, auth-disabled mode, sign-in button states. Integration (real Postgres) — session row persists and is honored by a **fresh** API instance (restart-safe claim proven, per repo honesty norms).
- **Gate**: `requireSession` on every resource route group; ADR-009 drafted.

### S1 — Private per-user workspaces (chats / memory / workdocs / delegations / schedulers)

- **Goal**: new resources belong to their creator; every list/read/write is owner-scoped; legacy stays quarantined.
- **Contracts**:
  - Creation-time ownership: chat ownership recorded server-side on first append; memory + scheduler `scope = 'user:<userId>'` forced server-side (client-supplied scope ignored/rejected); WorkDocs + delegations get nullable `ownerId` columns (+ indexes) via migration, set from the chat's owner.
  - All existing list/detail routes gain owner filters: own rows only; cross-owner → 404.
  - Delegated **child chats inherit the owner**; delegation + scheduler workers present the signed internal context (owner id + owner scope + chat/execution id; short TTL; persistent env secret — set a persistent value in local env files as already required for `DELEGATION_CONTEXT_SECRET`).
  - `search_memory` in child chats resolves the owner scope from the signed context only.
  - Scheduler tasks created post-S1 run under the owner's scope; existing legacy `default` tasks (the three paused Phase 5 demo tasks included) stay untouched and quarantined.
- **Web**: no visible redesign; lists simply show the user's rows. Recent-chats sidebar reads the per-user index.
- **Tests**: offline ownership matrix (owner / other user / legacy / anonymous); integration over real Redis+Postgres — scoped lists, cross-owner 404, scoped memory search, signed-context worker path accepted, tampered/absent internal context rejected.
- **Gate**: an integration test proves one user cannot see another user's chat transcript, memory block, workdoc, delegation, and scheduler task.

### S2 — Chat lifecycle: delete + both rewind modes + active-stream protection

- **Goal**: users can delete their own chats, fork any own chat non-destructively from a message, and destructively rewind an own chat to a message — with the stream-safety guard everywhere.
- **Contracts** (all `requireSession`):
  - `DELETE /api/chats/:chatId` — permanently removes the **own** chat transcript + stream state + per-user index entry. Non-cascade, explicitly: Work Docs and delegation rows survive (UI states chat links may dangle). 404 unknown/other; **409** on active stream, on linked `pending`/`running` delegation, or for scheduler-execution-owned chats.
  - `POST /api/chats/:chatId/branch` body `{ toMessageId }` — **rewind mode A (non-destructive)**: mints a new chat owned by the same user, seeded with messages up to **and including** `toMessageId`; original chat untouched; `Idempotency-Key` honored (duplicate → 409, never a second branch); size-bounded (`413` above 200 messages / 512 kb).
  - `POST /api/chats/:chatId/rewind` body `{ toMessageId }` — **rewind mode B (destructive)**: truncates the transcript to messages up to **and including** `toMessageId` (Redis `LTRIM`); the dropped tail is permanently gone; same 404/409/`413` guards as above; guard passes **before** any truncation (no partial state on refusal).
  - Shared guard chain (both modes + delete): active-stream marker check → linked-running-delegation check → execution-chat exclusion → ownership → only then mutate.
- **Web**: per-message "Branch from here" and "Rewind to here" affordances with distinct wording ("Branch keeps this chat" / "Rewind permanently deletes N newer messages" + confirm); delete in the chat/sidebar menu with confirm.
- **Tests**: offline guard matrix; real Redis integration — branch copy fidelity, LTRIM truncation exactness, index updates, marker-409, execution-chat 409.
- **Gate**: one integration test proves a rewind refusal leaves the transcript byte-identical.

### S3 — UX polish: sidebar collapse, chat width, default Plan

- **Goal**: three small, shippable UI changes.
- **Contracts**:
  - Sidebar **collapse toggle** in `WorkspaceShell` (desktop): expanded ↔ icon rail; preference persisted client-side the same way the theme preference is; mobile top-bar nav unchanged.
  - Chat transcript column: `max-w-3xl` → **`max-w-[52.8rem]`** (+10%); single source of truth for the class constant; verified at 1440×900 and 390×844.
  - **New chats default to Plan**: the orchestrator chat's mode state initializes to `plan` (user can switch; nothing auto-switches; other agents unchanged).
- **Tests**: unit tests for the collapse-persistence helper and the plan-default state; existing UI tests stay green.
- **Gate**: no layout regression in the existing fixed-frame chat (transcript-only scrolling, pinned composer).

### S4 — Dynamic Ollama model catalog + selection + Kimi lock

- **Goal**: the model list is live from the configured Ollama Cloud account's API, hoverable, default `glm-5.3-flash`, with Kimi ids locked and server-rejected.
- **Contracts**:
  - `GET /api/models` — server-side proxy of `{OLLAMA_BASE_URL}/api/tags`, normalized `{ models: [{ id, locked }] }` + `cachedAt`/`stale`; 60 s in-process cache; upstream failure → serve cache with `stale: true`; no cache ever → **503** `{error:'model catalog unavailable'}`. **Only** `/api/tags` and `/api/show` are ever proxied (INV-5).
  - `GET /api/models/:modelId/details` — proxy of `/api/show` for ids present in the last good catalog; **hover details**; only fields the upstream actually returns; honest "details unavailable" on failure/unknown id. `locked: true` (Kimi) entries stay listed but carry the lock flag; details are permitted (read-only), selection is not.
  - **Default**: `glm-5.3-flash` — explicit default in config, used when no model is selected and no user preference exists.
  - Selection: `PATCH /api/user/model` `{ model }` per user; `GET /api/user/model` returns the effective model. Chat POST gains optional `model` (validated; falls back user preference → default).
  - **Kimi block**: `locked = id.toLowerCase().includes('kimi')`; selection endpoint **and** chat/generation path reject Kimi ids with fixed **400** (`model not allowed`); per-user preference patch rejects them equally. If the request's selected model is absent from the last good catalog → 400 (`model not in catalog`); a provided `model` with an unreachable catalog and no cache → 503 (no silent fallback).
  - Web: model picker in the chat header (disabled Kimi rows + "Unavailable" badge); hover popover from `/details`.
- **Tests**: catalog normalize/cache/stale/503; Kimi rejection at selection, preference, and generation; default fallback; allowlist test asserting nothing but tags/show is proxied.

### S5 — Per-chat token usage + estimated USD (rates-only, honest unavailability)

- **Goal**: per-chat usage panel that only ever shows truth.
- **Contracts**:
  - Capture: assistant-message usage persisted when the provider reports it (Phase 5 nullable contract — **never fabricated**); per-chat aggregate `GET /api/chats/:chatId/usage` → `{ chatId, model, tokens: {input, output, total, messages} | null, estimate: {currency:'USD', input, output, total, ratesFor} | null, unavailable?: reason }`.
  - Estimate math: `usd = tokens ÷ 1_000_000 × rate`; rates **only** from explicit per-model configuration of per-million input/output USD (`OLLAMA_RATES_JSON` or an equivalent explicit config surface, exact shape fixed at implementation); absent config → `estimate: null`, reason `rates not configured for <model>`. No defaults, no averages, no external price fetching.
  - Honest copy states: Ollama Cloud has **no per-chat billing**; numbers are estimates from configured rates. **INV-5 shared-key rule is tested**: the proxy surface test asserts no account/billing endpoint is reachable through this sprint's API.
- **Web**: usage popover in the chat status area with both honest-unavailable states and the "estimate — not your Ollama bill" label.
- **Tests**: rate math, unavailable matrix (`no usage reported`, `rates not configured`), INV-5 allowlist.

### S6 — Delegation depiction improvements (UI only; existing machinery)

- **Goal**: make the **existing** sync/async delegation records readable and navigable — nothing new behind them.
- **Contracts**:
  - `/delegations` REST unchanged. UI: sync/async mode badges, status timeline `pending → running → completed/failed/timeout`, duration, depth chip (capped 2), child-chat link, parent context link, worker-result markdown (existing safe renderer), mode/status filters.
  - In the chat, the `delegate_task` tool card links to its delegation row (and the child chat link inside it).
  - **Explicit**: this depicts the **existing** ADR-004 delegation to `analyst`/`researcher` only. **No arbitrary subagent spawning, no new agent slugs, no new tools, no DAG** — anything else is out of scope (§8) and would be a stop condition.
- **Tests**: pure presentation helpers (status/mode maps) + all existing delegation tests green.

### S7 — Opt-in personal learning from old chats (per-user memory isolation)

- **Goal**: let a user turn their own past chats into personal memory, on purpose, with hard isolation.
- **Contracts**:
  - `POST /api/chats/:chatId/learn` on an **own** chat, explicit per-chat opt-in (UI confirm); queues a `workforce-learning` BullMQ job (deterministic id; one pending job per chat → duplicate enqueue no-ops); compactor-style extraction (the Phase 3 Ollama compactor pattern) writes `learning` blocks into **`user:<userId>` scope**, path namespace `personal/chat-learnings/…`, typed provenance link to the source chat; bounded output (existing ≤1000 chars/block rule, small block cap per run).
  - Results are visible only on that user's `/memory`. **No automatic harvesting**: nothing runs on old chats without the explicit action; the legacy test chats are invisible anyway (S1) so they cannot be learned from.
- **Tests**: scoping (blocks land in the owner scope only), enqueue dedupe, integration happy path (real Postgres/Redis, mocked model), bounded-output test.

### S8 — Legacy old-test-chat cleanup (separate, explicitly confirmed, irreversible; LAST)

- **Goal**: give the ownerless pre-auth test chats a **single, manual, explicitly confirmed, irreversible** exit — and nothing more.
- **Contracts**:
  - A dedicated maintenance script (no npm lifecycle hook, no REST route, no UI, no scheduler task, no test fixture, no startup path). Dry-run by default: lists ownerless quarantined chats — count, sample ids, byte sizes.
  - Deletion **only** with **both** `--confirm "DELETE LEGACY TEST CHATS"` **and** `--yes <exact expected count>` (count must match exactly or the script aborts); writes a before/after deletion report (ids + counts + bytes); irreversible; no undo path.
  - Scope v1: **ownerless test chats only**. Memory blocks, Work Docs, delegations, and scheduler tasks that are legacy are **not** covered — each needs its own separately confirmed decision.
  - **This plan text is not consent.** S8 runs only when Farhan explicitly executes/authorizes it, after S0–S7 are validated.
- **Tests**: default-refusal unit tests (refuses without both confirmations or a mismatched count; dry-run mutates nothing).

---

## 5. Test & gate strategy (cross-cutting)

- **Offline (every slice)**: root `npm run typecheck` + root `npm test`; targeted workspace runs. Mocked models everywhere — **no real provider call in any automated test** (standing repo rule).
- **Real integration (opt-in, exactly per the standing pattern)**: new tests ride the existing hermetic suites over real Redis/Postgres/BullMQ with unique run scopes and exact-run cleanup (`redis-server` never flushed, unrelated rows untouched).
- **Live browser gate (sprint close, orchestrator + Farhan)** — the checklist:
  1. Sign in via **Google** and via **GitHub**; session survives an **API restart** (persistent-session proof).
  2. A second account sees **only its own** workspace (chat/memory/workdocs/delegations/schedulers) — cross-user 404s.
  3. Legacy pre-auth test chats are **invisible**; S8 cleanup is **not run** (unless Farhan explicitly runs it with the typed confirmations — separate moment, separate record).
  4. Delete chat; **branch-from-message** (original intact); **destructive rewind** (tail gone, count shown before confirm); both refused with 409 while a stream is active; execution-owned chats refuse.
  5. Sidebar collapse toggle persists; chat width matches `max-w-[52.8rem]`; a fresh orchestrator chat starts in **Plan**.
  6. Model catalog loads with hover details; default `glm-5.3-flash`; Kimi rows locked — a devtools-forced Kimi selection returns the fixed 400 at selection and the generation path rejects too.
  7. Usage popover: with real provider usage → tokens shown; rates unconfigured → **cost honestly unavailable**; when Farhan supplies rates → estimate shown labeled "estimate — not your Ollama bill"; **no account-level spend anywhere**.
  8. Delegation page: existing sync + async rows richer (mode/status/duration/links); no new agents.
  9. Personal learning: opt-in on an own chat → `learning` blocks appear in **that user's** `/memory` only; second user sees nothing.
  10. Root totals recorded fresh (new dated entry), typecheck green, integration suite green including the new ownership/lifecycle/model tests.
- **Record-keeping rule**: all evidence lands in this file's record section (§6) as dated, additive entries. Historical docs (`docs/phases/*`, earlier records in this file and in `design-plans/agentic-workspace-ui.md`) are never edited for counts or status by this sprint. The Phase 5 validation approval and the Phase 6 pause are recorded in the accompanying docs edits of 2026-11-24 and are not touched by implementation work.

## 6. Sprint record

_(to be appended by implementing sessions; entries dated; historical totals elsewhere untouched)_

- 2026-11-24 — plan authored (docs-only edit; no source/package changes by the authoring session). Baseline recorded totals at authoring time: root offline **810 green** (core 243, `@workforce/queue` 47, CLI 30, API 318, web 172); integration suite **34/34** recorded (later chat-history records mention 37 — left exactly as historically recorded).

## 7. Stop conditions

- Stop and propose an ADR first if any feature requires breaking ADR-001…008, the SSE/idempotency contract, or the scheduler's immutable-execution audit.
- Stop if implementation would automatically assign, migrate, rewrite, or delete **any** legacy data (quarantine-only is the rule; S8 is the sole, gated exit for chats).
- Stop if a step would surface any Ollama account/billing/spend data (INV-5 is absolute).
- Stop if Better Auth in Express demands a change that violates Express-4 "keep it boring" or the no-auth-era single-tenant assumptions in ways this plan didn't capture — record findings, re-plan the slice.
- Stop rather than shipping a fabricated number: absent usage, absent rates, absent catalog → the honest-unavailable states, always.

## 8. Explicit non-goals

- **No Phase 6 work at all** — no Docker/Compose changes, no pino restructuring, no OpenTelemetry, no deploy targets, no public URL. The app **still must not be exposed publicly** this sprint (OAuth is a localhost flow; `BETTER_AUTH_URL=http://localhost:3000`).
- **No account-level Ollama billing/spend integration or display** for anyone (INV-5).
- **No arbitrary subagent spawning, new agent slugs, DAG orchestration, or composition changes** — delegation depiction work covers existing sync/async behavior only.
- **No automatic deletion or migration of anything, ever**; no silent claiming/quota of legacy rows to users.
- **No new LLM providers**, no agent-loop prompt rewrites beyond plumbing the validated model id through; Ollama Cloud stays.
- **No multi-process failover claims** beyond what Phases 4–5 already recorded (per-process recovery only).
- **No scheduler scope creep**: UTC-only, no catch-up/backfill, Phase 5 constraints hold.
- **No redesign** beyond the listed UX items (sidebar collapse, chat width, plan default, model picker, usage popover, delegation view) — the theme/shell work of 2026-11-24 is done and stays.
- **No streaming stop/control endpoint** — current no-stop/always-replay behavior unchanged.
- **No edits to historical phase docs, ADR content, or recorded test counts**; no claiming Phase 6 progress.

---

## 9. Rollout order summary

| Slice | Ships | Hard dependency |
|---|---|---|
| S0 | OAuth (Google+GitHub), persistent sessions, 401 gating | — |
| S1 | Per-user workspaces (all five surfaces) + worker signed contexts | S0 |
| S2 | Delete chat + branch + destructive rewind + stream guard | S1 |
| S3 | Sidebar collapse, `max-w-[52.8rem]`, default Plan | — (parallel-able) |
| S4 | Model catalog + hover details + Kimi lock + default `glm-5.3-flash` | S0 (auth gating) |
| S5 | Per-chat usage + rates-only USD estimates + shared-key privacy | S4 (model ids) |
| S6 | Delegation depiction | — (UI only) |
| S7 | Opt-in personal learning (owner-scope memory) | S1 |
| S8 | Irreversible legacy-test-chat cleanup script | all + **Farhan's explicit go** |

Closing the sprint = live browser gate recorded + Farhan's approval, **then** Phase 6 (Docker, Deploy, Observability) may finally un-pause — not one step earlier.

---

## 10. Current-work record — sprint features shipped (2026-11-24 final; Phase 6 stays PAUSED/NOT started)

**Totals (fresh dated entries; historical counts above untouched)**: offline
root total **975/975 green** (core 314, `@workforce/queue` 47, CLI 30,
API 403, web 208 in `apps/web/test/*`), root typecheck passing after the
final browser fixes; real-integration suite **54/54** and the full production
build passed **before the final three small web fixes** (sidebar viewport,
default Plan, rewind dialog) — no new build/integration rerun is claimed
after them.

**Live desktop browser gate (1440×900), orchestrator run**: identity was an
explicit `Browser Gate` test session through the gitignored
`.openchamber/browser-gate-proxy.mts` on `127.0.0.1:3002`, signing the real
API owner context. **Real OAuth credentials were NOT configured; the
Google/GitHub redirect flow is NOT validated — this gate is not production
OAuth proof**; only cookie-session flows with the test identity are.

Passed evidence per slice:

- **S4 Models** — real `GET /api/models` + `GET /api/models/:id/details` in
  the chat controls: `glm-5.3-flash` context **1,048,576** with real
  capabilities; a locked `kimi-k3` row and its PUT selection answered the
  documented **400**; model selection persisted **default → glm-5.3-flash →
  default**. Hover-and-focus lazy details worked. Unknown fields render
  "Not reported" (never guessed).
- **S2 Mutations** — Branch copied exactly **2 messages** into a NEW chat
  with the original intact; the destructive **Rewind** confirmation opened
  and worked on the generated branch (kept/removed honored); **Delete** on
  the current branch redirected to a fresh **Plan** chat. Fix of record: the
  rewind dialog now calls `showModal()` **synchronously** (the earlier
  `requestAnimationFrame` open never fired in the real browser).
- **S5 Usage** — real per-message and session usage (first turn
  **581 in / 76 out / 657 total**), per-model buckets from the API, and
  pricing **honestly unavailable** (no invented `$0`).
- **S7 Personal learning** — toggle ON → saved → capture ready → a fresh
  chat then recalled the stored `Concise — brief replies` observation; toggle
  **OFF verified `false`**. No retro-import.
- **S6 Delegation depiction** — a real async `orchestrator → analyst`
  delegation `0f552f06-a496-4967-bf1b-84cb58674b04` completed with answer
  **42** (child `7a26a7b1-ac63-438a-b316-55c5517a7956`); the new "Specialist
  sub-agent" depiction rendered in the parent tool card and `/delegations`.
- **S3 UX polish** — sidebar collapse/expand live; final fix of record: the
  desktop aside is `md:h-dvh md:max-h-dvh md:overflow-hidden` with
  `shrink-0` chrome and the internally scrollable Recent-chats region
  (footer had rendered below the fold at 900px). Default **Plan** fix of
  record: the chat page routes mode through `parseChatPageMode` (absent/
  invalid `?mode=` → Plan; explicit Action stays).

**Data hygiene**: the original browser test chat
`cb409c33-4f12-4ba1-8744-e9af6e5a6740` was retained; the generated branch was
deleted; existing legacy chats were **NOT bulk-purged** — S8 still requires a
separate, explicitly confirmed, irreversible cleanup with Farhan's go.

**Honest limitations**: the mobile-resize tooling did not produce a reliable
new-drawer viewport in this final run — **the new mobile drawer is not
live-verified** (its CSS, pure helpers, and 208 web tests remain). Real
OAuth redirect flows are NOT validated (see gate identity note). Phase 6
(Docker, Deploy, Observability) remains paused and not started; no Docker/
pino/OTel/deploy targets/public exposure were added.

## 11. Phase transition record — sprint closed by progression, Phase 6 ACTIVE (2026-11-25)

Docs-only entry (no code/package/env/key/git changes by this session). §10 above stays exactly as written; this entry supersedes its "Phase 6 stays PAUSED" status line only.

- **Close**: Farhan said **"Now the next phase?"** after the feature sprint work — the sprint is **closed by user progression** and **Phase 6 (Docker, Deploy, Observability) is ACTIVE as of 2026-11-25**. Status wording updated in [`docs/phases/phase-6-deploy.md`](../docs/phases/phase-6-deploy.md) (with its build-artifact spec filled), [`ROADMAP.md`](../ROADMAP.md), the [`README.md`](../README.md) status block and [`docs/architecture.md`](../docs/architecture.md). Phase 6 has a spec, not a build: no Docker/Compose/deploy work exists, no target is chosen (Railway/Render/Fly remain options), and the phase is **NOT validated until Farhan explicitly approves its live gate**.
- **Final sprint evidence (last implementing sessions)**: root `npm run typecheck` green plus **1071/1071 offline tests** (core 321, `@workforce/queue` 47, CLI 30, API 440, web 233); real-infrastructure suite **62/62 — green twice** (API agent runs; models mocked).
- **Implemented across the sprint**: Better Auth (Google + GitHub) with DB-backed sessions and 401 gating; per-user ownership on chats, memory scopes, work docs, delegations and scheduler tasks; owner-scoped Redis keys; `query_data` RLS (migration `20261125000100_query_data_rls`, NOLOGIN `workforce_query_reader` role); server-signed internal worker contexts; chat mutations (delete, non-destructive branch, destructive rewind) and in-chat message actions; dynamic Ollama model catalog with Kimi lock and default `glm-5.3-flash`; per-message/per-chat token usage with rates-only USD estimates; the conservative **per-user hourly budget** ledger (`GET /api/usage/hourly`, admission/settlement/cancel); opt-in personal learning memory; OpenChamber UI and responsive fixes (desktop sidebar, mobile drawer, chat width, default Plan).
- **Honest gaps (not claimed by the close)**: the **final post-fix real OAuth return** and the **final authenticated browser gate for the last hourly-budget/menu features** were not completed — Farhan stopped the dev stack before those were re-checked and then chose the next phase. No production Next build was rerun after the final tweaks. **The legacy chat purge (S8) was NOT run** — it still requires its own explicitly confirmed, irreversible, typed-confirmation execution.
- Every historical count and entry above (the §1 baseline, §10's 975/975 + 54/54, and all phase docs) stays exactly as written.
