# OpenChamber chat workspace — implementation record (2026-11-25)

Farhan supplied OpenChamber visual references and directed a three-column chat
workspace with a session context rail and a rich model picker. Implemented in
`apps/web` only; existing Tailwind v4 + shadcn primitives + the installed
`radix-ui` package (Popover) are reused — no new dependencies. The additive
model-details contract (`pricing: null | { inputUsdPerMillion, outputUsdPerMillion }`)
arrived in parallel; the web mapper validates it strictly when non-null.

## Shipped

1. **Three-column desktop workspace** — left WorkspaceShell rail (unchanged,
   incl. collapse + mobile drawer), flexible center (transcript-only scroll,
   pinned composer, `max-w-[52.8rem]` center measure inside a full-width
   shell container), right **Session** rail (`~320px`, border-left,
   independent scroll). `<lg` screens: the rail is moved into an accessible
   overlay drawer opened by a labelled icon button (`aria-expanded`,
   `aria-controls`, Esc + labelled backdrop) in the quiet center header.
2. **Quiet center header + composer-owned controls** — the crowded
   "Agent and mode" toolbar was removed; the center header is now identity +
   right-pane toggle only. The single composer instance gains a control row:
   ModelPicker popover + Agent select + Plan/Action segmented radios
   (URL/navigation semantics, Plan default, busy/HITL disabling,
   single-flight Enter/Send and suggestion fill-only behavior all byte-for-
   byte preserved). `chat-agent` id/aria moved with it.
3. **ModelPicker (`src/components/ModelPicker.tsx`, Radix Popover)** —
   trigger shows the selected model; popup has an autofocused search input
   (exact match first on Enter), the real filtered catalog, selected check,
   locked Kimi rows disabled with the server's value-free lock reason on the
   row + `title`, keyboard focus between rows, Esc/outside dismissal, and an
   adjacent detail region fed on hover/focus/selection: provider
   `Ollama Cloud`, real capabilities, `Input: text[, image]` (image only with
   a real `vision` capability), `Output: text`, context length / parameter
   size where real (`Not reported` otherwise), `Thinking: yes/no` when real,
   modified date when real, and **Cost ($/1M tokens)** from `pricing` —
   missing/`null` → `Not configured`, never invented. Old NativeSelect +
   "Model details"/"Session usage" topbar disclosures were removed
   (functionality moved; no duplicate controls); per-message usage badges
   stay.
4. **Session rail (`src/components/SessionRail.tsx`)** — real data only:
   provider/model/agent/mode row; **context % of the latest request** =
   latest assistant `metadata.usage.inputTokens` ÷ selected model's real
   `contextLength` (bounded 0–100; `Not reported` when either side is
   missing — NEVER cumulative session totals); exact session in/out/total
   with per-model buckets (`(unattributed)` labeled honestly, refresh
   button); configured estimate or honest reason; latest-turn in/out/total;
   tool count derived from the latest assistant's actual parts (pending HITL
   question excluded); real delegation rows for THIS chat with
   target/mode/status + child-chat links, polling only while rows are
   pending/running AND the tab is visible (2 s, non-overlapping,
   sequence-guarded, stops on error). Unavailable OpenChamber metrics
   (cache hits, monthly quotas, tokens/sec, elapsed/model/tool timing, files
   changed) are omitted — never fabricated. Empty chat shows the honest
   "No turns yet…" note.
5. **Additive pricing contract** — `mapModelDetails` strictly validates
   `pricing` when non-null (object with finite non-negative rates); missing/
   partial/invalid ⇒ payload rejected with the fixed mapper error (never
   treated as $0). Pure helpers: `formatModelCardLines` (provider/modalities/
   context/parameter/pricing/lock lines), `inputModality` (image only on real
   `vision`), `filterModels` (name+id, case-insensitive).

Preserved exactly: useChat transport/idempotency/resume, 50 ms throttle,
submissionGate, Enter/Shift+Enter, HITL answer dock + tool cards + Markdown
(no raw HTML), delete/branch/rewind (incl. synchronous `showModal()` rewind
dialog + kept-prefix rebuild), offline/progress/elapsed behavior, themes,
recent-chats soft-refresh + delete action, sign-in/session gating.

## Verification (this pass)

- `tsc --noEmit` (web): clean. **Web tests: 220/220** (213 preserved + 7 new
  pure tests: pricing strictness, input/output modalities incl. vision gate,
  reference card lines incl. `Not configured` cost, picker filtering,
  context-percent bounds, latest-turn usage, tool count with HITL exclusion,
  bucket labeling).
- `npm run build --workspace @workforce/web` — exit 0.
- `npm run typecheck` (root) — fails ONLY in apps/api's own in-flight
  `modelPricingJson` test-stub typing (the API agent's parallel work, zero
  `apps/web` items).

## Honest gaps

- No live browser pass yet for the three-column layout/drawer (dev server was
  stopped during this pass); geometry at 1440×900/390×844 and Popover focus
  order need the orchestrator's browser run. Popover content width on very
  small screens clamps at `92vw`, but edge collisions with the open mobile
  drawer are unverified.
- Radix Popover auto-focus intentionally targets the search input
  (`onOpenAutoFocus` preventDefault + React autofocus); screen-reader listbox
  semantics are simplified (buttons in a labelled region, no virtual-list
  `aria-activedescendant` roving index) — acceptable for the bounded (~50)
  catalog size but noted for a future a11y pass.
- The rail's context % uses the SELECTED (next-turn) model context even while
  a generation runs with its started model — contract-consistent (usage
  attaches after settle) but the number can briefly reflect the next model
  right after a switch.

## Fix pass (2026-11-25 — browser-found misses from the first three-column build)

Root causes taken from source inspection; all in `apps/web`:

1. **Header duplication** — WorkspaceGate rendered `Agent workspace`/General
   above Chat's own identity line, plus a separate `agent general · Plan
   mode` status paragraph. The shell now skips its page header on chat
   variants (`hasHeader` excludes `variant === 'chat'`), the duplicate status
   paragraph was merged into Chat's single quiet header line
   (`{Agent} · {Plan|Action} mode · {model}`, `aria-live`), and the dead
   `variant === 'chat'` branches in the page header were removed.
2. **Session sheet** — per-section bordered cards replaced by ONE
   bottom-anchored sheet: `rounded-t-2xl border-t border-x bg-card`
   sections divided by hairlines (`RailSection` = title + rows + bottom
   border), the raw chat short ID removed, and wrapper geometry changed so
   the sheet rises from the bottom: the lg column is
   `justify-end … overflow-y-auto` (sheet grows upward, scrolls when tall)
   and the <lg drawer holds the same sheet full-height. Collapse/reopen
   (labelled header button + vertical reopen strip) untouched.
3. **Model picker** — the always-rendered detail card (hover OR selected OR
   first row) was replaced by a Radix `Tooltip` per catalog row: portal + 
   `collisionPadding={10}` + `side="right"` (viewport-safe), exactly five
   fields — Provider; Capabilities; Input (`text[, image]` on real
   `vision`); Output (text); Cost ($/1M tokens with real rates or honest
   `Not configured`) — no model name, context, parameter size, thinking,
   modified date, or note. Locked rows keep the lock reason ON the row
   itself. `searchRef` + `onOpenAutoFocus` now focus the search input
   (`preventDefault` on Radix's first-tabbable focus). The real
   `detailsLoading` state is threaded into the tooltip: values show honest
   "Loading…" while the lazy fetch runs and never fabricate results; cached
   details render instantly (existing cache + seq guard unchanged).
4. **Plan→Action flicker** — mode is in-place client state: Chat holds
   `activeMode` + `activeModeRef`, the transport's `useMemo` deps dropped
   `mode` and `prepareSendMessagesRequest` reads `activeModeRef.current`
   (stable transport ⇒ no useChat reset). Switching calls `setActiveMode`
   + `window.history.replaceState(modeReplaceHistoryState(history.state,
   url), '', url)` (Next router state preserved). Page key is now
   `${agent}:${chatId}` (mode removed), so no remount; drafts, messages and
   scroll survive. Agent switching remains real navigation via Router
   (`navigateTo` in-lines the current in-place mode into the target URL;
   a navigation with only a mode change is routed to the in-place path).
   `modeUrlValue` (plan omitted, action explicit) and the history-state
   helper are pure and tested.
5. **Composer** — one rounded card (`rounded-2xl border`) with a borderless
   textarea and a hairline-divided bottom toolbar (picker + agent +
   Plan/Action; hint + Send). Empty state centers that single card;
   populated state pins it; HITL answer form unchanged.

Verification (implementation pass): web typecheck clean; **web tests
222/222** (213 preserved + 9 new pure tests: `modeUrlValue`,
`modeReplaceHistoryState`, the five-field tooltip with honest fallbacks,
and model-mixing guards `detailsModelPercentSource`/`contextModelPercent`);
web production build exit 0.

## Final orchestrator gate (2026-11-24/25 — browser + full suites)

Final orchestrator root `npm run typecheck`: **PASS**. Final root `npm
test`: **1018/1018** = core 314 + `@workforce/queue` 47 + CLI 30 + API 405 +
web 222 (supersedes an earlier orchestrator run timeout and one intermittent
API 404 test failure; no source behavior was changed for that test — only
its assertion diagnostic message). Web production build passed earlier while
dev was stopped, BEFORE the rail accessibility/responsive-toggle tweaks; no
new production build is claimed while dev was active afterwards.

**Browser gate used the explicit Browser Gate test identity** (web on
`127.0.0.1:3100`, proxy on 3002, real API/models/store). Real OAuth redirect
completion is NOT claimed. Verified live:

- one compact header; one rounded composer card with model/agent/Plan/Action
  controls; the unified bottom-anchored Session sheet measured at
  x1094, y346, w330, h554 (bottom 900, 16px top radius); nonduplicated
  accessible labels and correct distinct rail/drawer IDs
  (`ws-session-rail-desktop` / `ws-session-rail-drawer`);
- model search/filter/select and the locked Kimi row; default restored to
  `glm-5.3-flash`;
- Plan → Action in-place URL update preserving the draft with no visible
  remount;
- one real send answered **42** with exactly 2 messages and one `calculate`
  call; real usage **580/64/644**, model-correct context **0%**, tools **1**;
- Session hide/reopen (collapse → vertical strip → restore);
- at a ~634px-wide FRESH TAB: default Plan, navigation drawer, Session drawer
  open/close with correct accessible state, and the model popover
  (x54, w326) with an internally scrollable 256px list.

Explicit limitations: existing-tab resize did NOT reliably emulate 390px;
the hover/focus tooltip could not be driven by the available browser action
API, so its exact five fields are source/pure-test verified rather than
live-hover verified; screenshot capture was unavailable. Behavior of chat /
mutations / HITL / streaming is preserved by tests and earlier evidence; no
legacy purge occurred; Phase 6 remains paused.
