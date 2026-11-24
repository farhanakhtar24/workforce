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
