# Phase 1 — LLM Core

**Duration**: 1-2 weeks (actual: faster — build + validation closed 2026-11-17)
**Goal**: Deeply understand how LLMs ingest prompts, decide to call tools, and iterate through loops — build an agent loop without copy-pasting.

> **Status: ✅ Completed & validated — 2026-11-17.**
> Validated by a live demo plus automated tests. Farhan explicitly approved progression with "Yes next phase" after the demo.
> Honesty note: the self-assessment, targeted-learning, and whiteboard steps were **waived by Farhan**, not performed. This doc does not claim they happened.

---

## What got built

**`apps/cli/`** — a terminal REPL agent with **one tool: `calculate`**.

- Provider: **Ollama Cloud** (`glm-5.3-flash`) over raw OpenAI-compatible HTTP (`POST /chat/completions`) — no Vercel AI SDK, no provider SDK. Feeling the wire before the SDK was the point.
- Config validation from env (`OLLAMA_API_KEY` required; base URL, model, timeout have defaults). Invalid config prints which variable failed — never its value.
- One LLM transport with timeout and safe error messages (`src/llm.ts`).
- One tool (`src/tools/calculate.ts`) registered in `src/tools/index.ts`.
- One agent loop (`src/loop.ts`): model → tool calls → tool result messages → model, until the model answers with no tool call or the 10-step cap hits. Each step is logged (model output, tool call, tool result).
- In-memory conversation history (`src/history.ts`): the full transcript is resent on every call.
- Error containment: unknown tools, malformed argument JSON, and thrown tools all go back to the model as structured tool messages, so recovery is observable. Transport failures end the turn with an error; the REPL stays open.
- No streaming, no UI beyond terminal prompts, no persistence — deliberately, so the loop stays the focus.

```
apps/cli/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts       # entry point, REPL loop
    ├── config.ts      # env validation
    ├── llm.ts         # raw fetch to Ollama Cloud (OpenAI-compatible)
    ├── history.ts     # conversation state (in-memory)
    ├── types.ts
    ├── loop.ts        # model → tool calls → tool results → model
    ├── llm.test.ts / loop.test.ts
    └── tools/
        ├── calculate.ts / calculate.test.ts
        └── index.ts
```

---

## Topics (originally for self-assessment)

The rating table below was kept as originally planned but **never filled in**: Farhan waived self-assessment and targeted learning before the build.

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 1.1 | Tokens, context window, temperature | _(waived)_ | |
| 1.2 | System / user / developer messages | _(waived)_ | |
| 1.3 | Tool calling (JSON schema contract) | _(waived)_ | |
| 1.4 | Structured output | _(waived)_ | Not used in Phase 1 |
| 1.5 | Token counting & cost | _(waived)_ | |
| 1.6 | The agent loop | _(waived)_ | |
| 1.7 | Multi-turn state | _(waived)_ | Full-history resend, tested live |

Learning resources: **skipped** (waived).

---

## Validation result — 2026-11-17

**Original gate**: live demo (3 prompts, one needing 2+ tool calls) + probe questions on error handling + whiteboard of the message array.
**What actually happened**: live demo + automated tests. The probe/whiteboard parts were waived; error paths and multi-call behavior were covered by automated tests instead.

### Automated evidence (offline, no key needed)

- **56/56 tests pass** (`npm test`) — loops, tool registration, transport, tool errors, multi-call paths.
- Root `typecheck` and CLI `build` pass.
- Missing-key probe: exits nonzero, names the failing variable, never prints a value.
- EOF probe: REPL exits cleanly on closed stdin.

### Live transcript (real CLI session)

| Prompt | Behavior |
|---|---|
| "Hello" | No tool call; direct text answer |
| "(12+8)*3" | Loop invoked `calculate`; returned **60** |
| "Add 7 to that result" | Full history resent in the request; model used the prior tool result; returned **67** |

The third turn is the multi-turn proof: the tool result from turn 2 arrived back to the model as part of the resent history.

### Decision to proceed

After the live demo, Farhan said **"Yes next phase"** — explicit approval. Phase 1 closed, Phase 2 started the same day. Phase 2 validation has its own gate and is **not** complete yet.

---

## When done

→ Started [Phase 2 — Streaming & Real-Time UX](./phase-2-streaming.md) on 2026-11-17.
