# Phase 1 — LLM Core

**Duration**: 1-2 weeks (flexes based on self-assessment)
**Goal**: You deeply understand how LLMs ingest prompts, decide to call tools, and iterate through loops. You can build an agent loop without copy-pasting.

---

## What gets built in this phase

**`apps/cli/`** — a terminal-based agent with **ONE tool** (your choice: `get_weather`, `calculate`, or `lookup_word`).

Requirements:
- Maintains conversation history across turns
- Tool result feeds back into the model before it continues
- Stop condition: max 10 steps OR model emits no tool call
- Logs each step: model input, model output, tool call, tool result
- Runs **without** the Vercel AI SDK (raw HTTP to OpenAI/Anthropic) — you'll use the SDK in Phase 2, but you need to feel the wire first

---

## Topics to self-assess

Rate each 🟢 / 🟡 / 🔴 **before** starting. Don't move on until all are at least 🟡.

| # | Topic | Your rating | Notes |
|---|---|---|---|
| 1.1 | Tokens, context window, temperature | _ | |
| 1.2 | System / user / developer messages | _ | |
| 1.3 | Tool calling / function calling (JSON schema contract) | _ | |
| 1.4 | Structured output (forcing JSON, Zod validation) | _ | |
| 1.5 | Token counting & cost (input vs. output pricing) | _ | |
| 1.6 | The agent loop (Observe → Think → Act → Observe) | _ | |
| 1.7 | Multi-turn state & summarization strategies | _ | |

---

## Learning resources (per topic)

> I'll fill these in with specific links once you tell me your ratings. The curriculum ([`docs/learning/CURRICULUM.md`](../learning/CURRICULUM.md)) has generic pointers; I'll tailor them based on your self-assessment.

---

## Build artifact — detailed spec

```
apps/cli/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # entry point, REPL loop
│   ├── llm.ts             # low-level fetch to OpenAI/Anthropic
│   ├── history.ts         # conversation state (in-memory for now)
│   ├── tools/
│   │   └── index.ts       # registry of ONE tool
│   │   └── getWeather.ts  # or calculate / lookupWord
│   └── loop.ts            # the Observe → Think → Act loop
└── README.md              # how to run, what it does, what you learned
```

**Constraints**:
- Only 1 tool (don't get ambitious)
- No streaming yet (Phase 2)
- No UI (terminal only)
- No memory (Phase 3)
- No multiple agents (Phase 4)

These constraints exist so you focus on **the loop** and nothing else.

---

## Validation gate for Phase 1

**Format**: Mixed (per your preference 1D).

1. **Demo** — you run the CLI live. I watch you send 3 prompts, at least one of which requires 2+ tool calls.
2. **Probe** — I ask "what if the tool throws?" and "what if the model hallucinates a tool call that doesn't exist?" — you walk me through your error handling.
3. **Whiteboard** — you sketch the message array after 3 turns, pointing out where the tool results sit.

Pass = you can explain your own code without looking at it.

---

## Notes

_(Fill this in as you go. What surprised you? What took longer than expected? What would you do differently?)_

---

## When done

→ Start [Phase 2 — Streaming & Real-Time UX](./phase-2-streaming.md)
