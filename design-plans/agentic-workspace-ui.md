# Workforce agentic workspace UI refresh

Written against: `76666b4` plus existing uncommitted Phase 1–5 source.

## Evidence chain

- Surface: Next.js app in `apps/web`; primary chat `/agents/orchestrator/chat/52790846-b7b8-4520-8def-23aacf5a96f8?mode=action`, plus `/memory`, `/work`, `/delegations`, `/schedules`.
- Problem: rendered chat is a 46rem document column with crowded underlined navigation, large form controls above the transcript, uniformly boxed messages, and a composer thousands of pixels below the first response. Utility pages reuse the same narrow `.chat-layout`, generic `.memory-section`, and `.memory-card` patterns. It reads as a prototype form, not a coherent agent workspace.
- Design evidence: rendered desktop browser inspection on 2026-11-24; `app/globals.css:1-1117`; repeated headers/navigation in all six components; existing Response/Thinking/Tool activity separation is good and must remain.
- Owner: `apps/web/app/globals.css`, a new shared workspace shell under `apps/web/src/components`, and the six existing surface components.
- Scope and affected surfaces: visual presentation, layout, navigation, empty/loading/streaming presentation, responsive behavior, and UI copy in `apps/web` only.
- Uncertainty: final hierarchy, overflow, and mobile navigation require browser verification at desktop and mobile widths.

## Design language

- Audited surface: Workforce agent workspace, with chat as the primary task and shared navigation into Memory, Work, Delegations, and Schedules.
- Design sources: current CSS variables/components and rendered app; no current DESIGN.md exists.
- Documented decisions: safe text-only Markdown, full-replay resume, no stop button, stable URL state, explicit accessible names, visible focus, responsive layouts.
- Governing owners and consumers: `globals.css` owns legacy tokens; every surface owns a duplicate header/nav; `Chat.tsx` owns the AI SDK transport and submission behavior.
- Explicit exceptions: None documented.

## Design decision

Build a quiet, warm, capable agent platform rather than copying another product or adding a component library for its own sake. Use a reusable app shell with a slim dark-ink sidebar on desktop and compact top/navigation treatment on mobile. Use warm neutral workspace backgrounds, white elevated surfaces, deep green as the single primary accent, generous but efficient spacing, subtle borders/shadows, and small status dots/badges. Use Tailwind CSS v4 with shadcn/ui components and Lucide icons, following the current official Next.js installation contracts. Farhan explicitly required Tailwind and shadcn after the initial audit. Configure Tailwind through `@tailwindcss/postcss`, initialize a valid `components.json`, and add real shadcn-owned primitives under the app’s configured UI directory. Existing complex Markdown, operational tables, and scheduler-specific CSS can remain as focused component styles; migrate shared controls/shell/cards/forms to the new system rather than keeping two competing design systems.

Chat becomes a focused conversational workspace: compact agent/mode controls, readable centered transcript, distinct user bubbles and assistant identity, calm collapsed reasoning/activity, useful empty-state prompt suggestions, and a sticky bottom composer that stays visible while the transcript scrolls. Other pages become full-width workspaces with clear page titles/descriptions, consistent panels, filters, cards, tables, badges, and actions. Do not invent chat history, usage metrics, online provider status, or capabilities absent from the API.

## Reuse

- Preserve and extend the existing CSS variable approach in `app/globals.css`.
- Preserve `Chat.tsx` transport, `useChat`, `submissionGate`, URL state, `AssistantPartsView`, all tool views, Markdown rendering, and HITL behavior.
- Reuse existing form controls, badges, safe errors, and scheduler/mobile card logic; restyle rather than rewrite data flows.
- New primitive required: `WorkspaceShell`/`WorkspaceNav`, because six components currently duplicate navigation and no shared product frame exists. All routed surfaces should consume it.
- New small primitives may include `Icon`, `AgentAvatar`, `StatusBadge`, and `EmptyState` only where they remove real repetition. Do not create a broad design-system package.
- Dependencies required: Tailwind CSS v4 (`tailwindcss`, `@tailwindcss/postcss`, `postcss`) and the actual shadcn/ui dependency set for selected primitives (`class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, and Radix packages only where the generated component needs them). Use shadcn CLI or its exact generated source, not lookalike components. No CSS-in-JS or theme builder.

## Changes

1. `apps/web/src/components/WorkspaceShell.tsx` and focused supporting UI files
   - Change: add a shared responsive shell with Workforce brand mark, New chat action, primary navigation, concise agent-capability context, and a restrained footer label such as “Local workspace”. Provide desktop sidebar and usable mobile navigation without hiding essential routes. Support page eyebrow/title/description and a chat-specific full-height content variant.
   - Preserve: existing URLs and all application state; no fake recent-chat list or server-health claims.
   - Verify: every route has one main landmark, one primary navigation, current-page indication, keyboard-accessible controls, and no horizontal page overflow.

2. `apps/web/app/globals.css`, `app/layout.tsx`
   - Change: configure Tailwind v4 and shadcn/ui, then replace prototype styling with a coherent token system exposed through shadcn/Tailwind theme variables: warm canvas, contrasting sidebar, readable foreground/muted colors, green accent, success/warning/error tones, consistent radii/spacing/type/focus rings. Add `postcss.config.mjs`, `components.json`, and `src/lib/utils.ts`; import Tailwind at the top of globals. Set an updated honest metadata description. Add restrained transitions and respect `prefers-reduced-motion`.
   - Preserve: Markdown typography, bounded overflow for code/tables, existing status data attributes, and all accessible names.
   - Verify: readable contrast, visible focus, 1440×900 and 390×844 layouts, long IDs/content wrap, tables/code scroll locally.

3. `apps/web/src/components/Chat.tsx`
   - Change: compose the shared shell in a full-height chat layout. Replace the large stacked Agent/Mode fieldset area with compact intentional controls; retain complete capability guidance in a subtle details/popover-like native region. Remove the raw chat UUID from the primary status line (a truncated/copyable identifier is optional, not necessary). Add an agent-aware empty state with a warm headline such as “What should we accomplish?” and 3–4 prompt buttons that fill the composer without auto-sending. Give user and assistant turns distinct visual hierarchy; keep Response, Thinking, Tool activity, and pending ask_user separate. Put the composer in a sticky/fixed-by-layout bottom region with Enter/Shift+Enter hint and clear busy state.
   - Preserve: exact transport body/headers, stable chat IDs, no abort/stop, full-replay resume, single-flight submission, HITL answer path, Markdown security, all tool-card functionality.
   - Verify: composer remains visible in a long chat; empty chat is welcoming; Enter and Send still create exactly one turn; pending ask_user remains prominent; streaming text and tool updates render once.

4. `apps/web/src/components/Memory.tsx`, `WorkDocs.tsx`, `WorkDocDetail.tsx`, `Delegations.tsx`, `Schedules.tsx`
   - Change: replace duplicated headers/navigation with the shared shell and concise page-specific descriptions. Use the wider workspace canvas, clear section headings, aligned forms/actions, polished cards/tables/badges, and useful empty states. On schedules, retain the existing table/card dual rendering and polling behavior. Keep advanced/destructive actions visually secondary.
   - Preserve: every API call, form field, validation rule, filter, poll, retry gate, WorkDoc CAS/rollback flow, and link.
   - Verify: every existing browser task remains discoverable and operable; mobile cards remain usable; no controls lose accessible names.

5. `apps/web/test/**`, `apps/web/README.md`
   - Change: add pure tests only for new testable helpers (for example agent-specific suggestions or navigation metadata), preserve all existing tests, and update the UI stack/architecture documentation. Do not claim browser behavior without running it.
   - Preserve: existing test expectations unless a deliberate copy/structure change requires a narrowly justified update; never weaken behavior assertions.
   - Verify: web typecheck/tests and root typecheck/tests pass. Do not run a Next production build while the active Next dev server is using `.next`; coordinate build validation with a dev restart afterward.

## Scope

- Inherit: all Workforce web routes and responsive states.
- Verify: chat with existing long orchestrator transcript, fresh empty chat, `/memory`, `/work`, WorkDoc detail, `/delegations`, `/schedules`, desktop and mobile.
- Exclude: API/core/CLI/queue changes, new backend features, chat-history storage, authentication, theme switching, command palette, global search, model picker, token/cost dashboards, and Phase 6 work.

## Validation

- Product: navigate between all surfaces, start a fresh chat, inspect existing chat, fill a suggested prompt without auto-send, submit once, open/close Thinking and Tool activity, inspect HITL if already present, and open existing WorkDoc/delegation/execution links.
- Interface: 1440×900 and 390×844; empty/loading/streaming/error states; long Markdown, code, tables, IDs, badges, and forms.
- System: one shared shell, no duplicate nav implementations, real shadcn primitives consumed by product components, Tailwind compiles without unknown utility/theme errors.
- Repository: `npm run typecheck --workspace @workforce/web`, `npm test --workspace @workforce/web`, `npm run typecheck`, `npm test` → all pass. Run a production build only after stopping the dev server, then restart dev for final browser evidence.

## Stop conditions

- Stop and report if a visual change requires changing a REST contract, provider behavior, streaming semantics, or durable data.
- Stop rather than hiding a pending ask_user, removing navigation, or weakening existing accessibility.
- Keep scope to `apps/web` plus this plan; no git mutations and no reading/printing secrets.

## Design documentation

- Update `apps/web/README.md` after acceptance with the Tailwind v4 + shadcn/ui + custom token/shell/Lucide choice and actual validation evidence. No phase validation status changes belong to this UI task.

## Implementation/validation record (2026-11-24 — UI task only; all phase validation/approval statuses unchanged)

Built as planned, on `apps/web` only: Tailwind CSS v4 (`@tailwindcss/postcss`, documented `plugins: { '@tailwindcss/postcss': {} }` PostCSS config, `@import "tailwindcss"` + `@source "../src"; @source "../app";` because v4 roots auto-detection at the CSS entry directory would miss `src/`), real shadcn/ui primitives from the current registry (`Button`, `Card`, `Badge`, `Input`, `Textarea`, `Label`, `NativeSelect` under `src/components/ui` with `components.json`, `cn` in `src/lib/utils.ts`, deps `class-variance-authority`, `clsx`, `tailwind-merge`, `radix-ui`, `lucide-react`), the shared `WorkspaceShell` (one nav landmark, `aria-current`, context-query deep links, skip link, dark-ink sidebar / mobile top bar) and the small shared `AgentAvatar`/`StatusBadge` primitives. Legacy CSS stays deliberately narrow (`.chat-md*` Markdown typography, `.chat-tool*` tool cards, `.chat-region*`, `.sched-table*`, `.work-doc-content*` version excerpts). No half-built parallel system remains; no feature beyond the plan was added.

Browser fixes found during the orchestrator's real audits (each fixed narrowly):

1. **Tailwind did not compile in dev** — served CSS still contained raw `@theme`/`@source`/`@tailwind utilities`/`@apply`. Root cause: `postcss.config.mjs` postdates the long-running dev server's webpack persistent cache in `.next/cache/webpack`, and the config file is not a tracked dependency of the cached CSS module — a server restart reuses the raw module. Fix: align the config to the official documented object shape and touch `globals.css` (comment line) so the next content build re-runs the loader; served CSS then verified with zero raw directives and the full utility set. The restart itself stays orchestrator-owned.
2. **Composer off-viewport in long chats** — the chat column had no constrained height. Fix: chat surfaces render as a fixed application frame (root `h-dvh overflow-hidden`, `min-h-0` chain to the transcript `flex-1 overflow-y-auto overscroll-contain`), the composer/answer dock is a pinned `mt-auto shrink-0` block with a safe-area bottom pad, and page surfaces keep document scroll. Verified: page `maxScrollY 0`, transcript is the only inner scroller, composer always visible, desktop + mobile.
3. **Initial position of long chats** — exactly-once scroll to the latest turn (first nonempty transcript per mounted chat; own sends also catch up via `status === 'submitted'`); no continuous auto-scroll during streaming, so reading position is never yanked.
4. **Schedules double render** — desktop table + mobile cards both displayed because the old `sched-desktop-only`/`sched-mobile-only` display rules no longer existed. Fix: direct Tailwind visibility (`hidden md:block` wrappers, `md:hidden` card lists) on both Tasks and Execution history; both variants kept.
5. **Markdown rendered raw outside chat** — shared `MarkdownText` (same react-markdown + remark-gfm + no-raw-HTML contract) now renders Delegation worker results (FULL content inside a `max-h-60` bound — truncating the source left literal unmatched `**…`) and Work Doc current content (bounded scroll, display-limit note kept); the edit textarea stays raw, version-history excerpts stay plain `<pre>`.
6. **Mobile active nav clipped** — after the horizontal top-bar scroll, the right-most active item could render off-view. Fix: refs + a mobile-guarded (`max-width: 767px`) effect that centers the active item by assigning the nav list's `scrollLeft` directly — no `scrollIntoView`, no document scroll.

Validation as recorded: root `npm test` total is now **767 green offline tests** (core 243, `@workforce/queue` 47, CLI 30, API 299, web 148 — web grew by the 10 `test/workspace.test.ts` cases) and root typecheck + root tests pass after the final source changes. Orchestrator browser evidence: desktop/mobile long chat `maxScrollY 0`; fresh suggestions fill the composer only; one real `general` Enter submission produced exactly one user+assistant turn (`UI OK`); Memory, Work list/detail, Delegations with real results, and Schedules (desktop/mobile) verified. **No Next production build was run** — the real `next dev` server stayed active for Farhan at all times (a production build against the same `.next` would corrupt dev assets), so the plan's build-after-stopping-dev-server step remains for a coordinated window.

## Follow-up implementation record (2026-11-24 — real chat history + live progress/offline; review fixes; all phase validation/approval statuses unchanged)

After the shell work shipped, two Farhan UX requests landed and the browser review fixes followed (scope: `apps/web` + the API's own `GET /api/chats` route, owned by the API workspace):

- **Real recent chats**: the sidebar gained a history region fed exclusively by the real `GET /api/chats` (default 20 / max 50 / `no-store`; bounded server-side title/preview plain text; indexed last-activity timestamps with honest `null` for legacy rows; fixed 400/503 mapping client-side; atomic `RPUSH`+`ZADD` persistence with a bounded legacy `SCAN` backfill — API-owned, real-tested). Desktop renders an independently scrollable region below the primary nav; mobile a collapsed disclosure in the top bar. Refresh on route change (hard) and once per settled generation via the `workforce:chats-changed` window event (soft: prior rows never flash to skeleton; soft failures keep the last good list). Current `(agent, chatId)` row highlighted (`aria-current`), links to canonical chat URLs; accessible copy states that "New chat" never deletes history. No localStorage anywhere.
- **Real loading progress + live thinking + offline**: the dead space under a busy assistant turn is replaced by a stage indicator derived purely from `useChat` status + the CURRENT generation's raw parts (Sending your message → Waiting for the model → Thinking only for live reasoning → Using <tool> only while that tool awaits → Writing response), with spinner + aria-hidden elapsed seconds and the honest >12 s "Taking longer than usual…" note — no fake progress, no stop button. Streamed reasoning renders in a visibly live Thinking panel only for the current assistant turn (a fresh submit can no longer reopen previous turns' reasoning) and collapses back on completion without duplication. `navigator.onLine` + online/offline events drive an honest amber warning (draft/history remain; the request can fail; nothing resumes automatically; busy-offline adds "no confirmed progress"), and errors present as "Response failed" with fixed text + connection guidance.

Final review fixes: live-thinking gating to the newest assistant message, elapsed span marked `aria-hidden` (no per-second re-announcement; stage changes still announce), skeleton-free soft history refresh, and surrogate-pair-safe title/preview truncation with an astral boundary test.

Validation: production build passed before the final review-only fixes; the dev server is active now (no further build — orchestrator-owned). Current root offline total **810 green tests** (core 243, `@workforce/queue` 47, CLI 30, API 318, web 172; web grew by the `recent-chats` and `chat-progress` suites) with root typecheck and root tests passing. Real integration: full suite previously **37/37**; after the `zScore` edge fix the targeted real chat-history suite passed **4/4** (one new test; no full rerun claimed). Browser evidence: real sending progress settling into a completed compute response; a new chat indexed first with a real timestamp; an old-chat click restoring the transcript with `UI OK`; mobile disclosure verified. No offline-browser simulation is claimed: the offline event/copy helpers are unit-tested — the real browser did not toggle the machine's network.

## Follow-up implementation record (2026-11-24 — Farhan's ChatGPT-style light/dark request; all phase validation/approval statuses unchanged)

Farhan supplied a ChatGPT dark screenshot: "make the UI this kind, give light dark modes, also don't make it too dark." Implemented on `apps/web` only:

- **Working Light + Dark mode** via standard `next-themes` (class attribute,
  `defaultTheme="system"`, localStorage persistence, injected pre-paint script
  + `suppressHydrationWarning` — no flash, no hydration mismatch). `ThemeToggle`
  shows the action (Moon/"Dark theme" in light; Sun/"Light theme" in dark) with
  CSS-class-driven markup (hydration-safe, no mounted gate), compact icon-only
  on mobile. **Explicit `.dark` token set** (also refined the light one): main
  soft graphite `oklch(0.28 0.007 255)` and sidebar `oklch(0.245)` — visibly
  lighter than the screenshot's pure black and NOT dark-green; the sidebar rail
  is a subtle neutral gray in both themes (`oklch(0.968)` light) and deep green
  survives only as a small brand mark/accent (`--primary`, ring, avatar).
  Every status color (amber/red/emerald banners, notices, status/delegation
  badges, avatar tints) gained matching `dark:` variants; the custom legacy CSS
  is token-based and audited for dark compatibility.
- **ChatGPT-calm shell geometry**: slim `md:w-[260px]` neutral rail — brand
  mark row, prominent New chat row, compact icon nav, the real single-line
  Recent chats (avatar chip + truncated title + real message count; full
  honest metadata kept accessible via per-row `aria-label`/`title`), and a
  bottom utility area (theme toggle + "Local workspace"). Quieter page
  headers; mobile keeps nav scroll-centering + the collapsed history
  disclosure + icon theme toggle.
- **Empty chat rebuild**: greeting "What should we accomplish?" + the ONE
  composer instance centered under it + a few rounded suggestion chips below
  (the single form is repositioned per state — centered when empty, pinned
  dock once populated; ids/aria/handlers unchanged, never two forms).
  Suggestion chips remain fill-only.

Preservation (all verified by diff + tests): transport/idempotency/resume,
submissionGate, Enter/Shift+Enter, fixed h-dvh frame with transcript-only
scrolling and pinned dock, initial-latest scroll, real RecentChats data/
events/loading/error/empty/soft-refresh/active/mobile disclosure, progress
stages + aria-hidden elapsed + long-wait note, current-turn-only live
Thinking, HITL dock, tool cards, safe Markdown, WorkDoc CAS/rollback,
delegations/scheduler polling. New dependency: `next-themes@0.4.6` (allowed:
the documented standard for class-based themes). Checks: web typecheck pass,
web tests 172/172, root typecheck exit 0, root tests exit 0 (810 offline =
core 243 + queue 47 + CLI 30 + API 318 + web 172; one API-owned memory-route
test flaked once and passed in isolation plus the full rerun). Orchestrator
browser verification still open for both themes × desktop/mobile ×
empty/populated chat, including dark-contrast eyeballing of the graphite
surfaces.

## Follow-up implementation record (2026-11-24 — signed-in workspace + layout controls; all phase validation/approval statuses unchanged)

Farhan's follow-up: real accounts. Implemented on `apps/web` plus the
API-owned endpoints; better-auth pinned to the API's exact **1.7.27**.

- **Same-version Better Auth React client** (`src/lib/auth-client.ts`) pointed
  at `${API_BASE}/api/auth` with `credentials: 'include'`. **Every browser
  API call now sends cookies**: a shared `browserApiFetch` became the default
  fetch impl of the memory/scheduler/workdocs/delegations/recent-chats
  request helpers and the client hydration fetch, and `browserChatFetch`
  (standard signature) backs the AI-SDK `DefaultChatTransport.fetch` so chat
  sends and resume carry the session too. Bodies, idempotency headers and
  resume semantics byte-unchanged.
- **Auth surface**: a standalone, theme-consistent `/sign-in` page — value
  copy, ONLY the providers the API configured (public
  `GET /api/auth/providers` booleans drive the buttons; no fake providers),
  per-provider loading, fixed provider/offline/`?error=` access-denied copy,
  signed-in visitors bounced to the intended route. `callbackURL` is the
  sanitized same-origin local route (`safeLocalCallback`: absolute URLs,
  `//`, `/\`, empty → `/`); Better Auth performs the redirect itself and
  validates `trustedOrigins` server-side.
- **Guard + identity**: `WorkspaceGate`/`AuthGate` wraps every shell surface
  — loading skeleton, unauthenticated redirect to
  `/sign-in?next=<intended local route>`, fixed access-denied panel on
  session failures, identity row (initials/name/email) and working Sign out
  (history never deleted) in the rail/drawer. Server-side chat hydration now
  forwards the incoming `Cookie` header through Next `headers()` (never
  logged); 401 in any client fetcher redirects to sign-in, 403 shows the
  fixed denial. No test bypass exists.
- **Layout controls**: desktop rail collapses to a `md:w-[64px]` icon rail
  and expands back (labels hidden; New chat/Sign out reachable via icons;
  `localStorage['workforce:sidebar-collapsed']` persistence with
  corrupt/throwing-storage fallbacks); mobile gains an accessible drawer
  (role=dialog, aria-modal, Esc + labelled backdrop, focus on open, body
  scroll lock) holding nav + history while New chat stays permanently in the
  top bar. The chat column widened ~10% to `max-w-[52.8rem]` (header block
  aligned to the same width). Vertical nav replaced the horizontally
  scrolled mobile nav, so the old scroll-centering helper was superseded.
- **New chats default Plan**: absent/plan URLs keep clean canonical routes,
  explicit `?mode=action` links work verbatim; only the web default changed
  (`DEFAULT_MODE = 'plan'`), never an API default.

Validation: web typecheck green; web tests **182/182** (172 preserved — only
the action→plan default expectations changed intentionally — plus new
`test/auth.test.ts` and `test/layout-controls.test.ts`); root typecheck/test
**currently failing only inside `apps/api`'s own in-flight auth work**
(`dbg-branch.ts` debug file, chat-mutations runtime test + chat-mutations/
chat-routes test-stub typecheck errors — `deleteChat/branchChat/rewindChat`
interface work owned by the API workspace; zero `apps/web` items in the
failure logs). Real OAuth needs the provider credential pairs and remains
the orchestrator's live gate; the `credentials: 'include'` contract itself
is unit-tested.
