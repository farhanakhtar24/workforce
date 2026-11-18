# @workforce/cli

Phase 1 artifact: a terminal REPL agent over the Ollama Cloud OpenAI-compatible Chat Completions endpoint.

## What Phase 1 proves (and what it deliberately does not do)

Built with raw `fetch` — no Vercel AI SDK, no provider SDK, no streaming:

- Config validation from environment variables.
- One LLM transport (`POST /chat/completions`) with timeout and safe error messages.
- One production tool (`calculate`), registered in `src/tools/index.ts`.
- One agent loop (`src/loop.ts`): model → tool calls → tool result messages → model, until the model answers without tool calls or the 10-step cap is hit.
- In-memory, in-process conversation history (`src/history.ts`).

Deliberate limits (kept this way on purpose so the loop stays the focus):

- Exactly one tool, no streaming, no UI beyond terminal prompts.
- No persistence, memory, or summarization: the whole transcript is sent on every call, and it lives only as long as the process.
- Single agent, single model per call, no retries beyond manual re-prompting.

Errors are surfaced, not hidden: unknown tools, malformed argument JSON, thrown tools, and the step cap are all reported back to the model as structured tool messages (so you can watch recovery in the logs), while transport failures end the current turn with an error and the REPL stays open.

## Requirements

- Node.js >= 20.
- An Ollama Cloud API key with access to the `glm-5.3-flash` model.

## Setup

Install once from the repository root (the repo uses npm workspaces):

```sh
npm install
```

Create your own Ollama Cloud API key, then set `OLLAMA_API_KEY` in **your own shell**. Example for the current session:

```sh
export OLLAMA_API_KEY="value-from-your-ollama-account"
```

or for a single command:

```sh
OLLAMA_API_KEY="value-from-your-ollama-account" npm run dev --workspace @workforce/cli
```

Put the key in your shell profile (e.g. `~/.zshrc`) or a directory you do not commit. Never paste a real key into Git history, issue text, or chat. All other settings are optional and have defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_API_KEY` | _(required)_ | Ollama Cloud bearer token |
| `OLLAMA_BASE_URL` | `https://ollama.com/v1` | OpenAI-compatible base URL |
| `OLLAMA_MODEL` | `glm-5.3-flash` | Model name sent in the request |
| `OLLAMA_TIMEOUT_MS` | `60000` | Per-request timeout in milliseconds |

`.env` files are **not** auto-loaded; only real environment variables are read. If configuration is missing or invalid, the CLI prints which variable failed (never its value) and exits with a nonzero status.

## Running

```sh
# dev (tsx, no build step)
npm run dev --workspace @workforce/cli

# build to dist/ and run the compiled JS
npm run build --workspace @workforce/cli
npm run start --workspace @workforce/cli

# tests (offline, no network) and type checking
npm test --workspace @workforce/cli
npm run typecheck --workspace @workforce/cli
```

At startup the CLI prints its model and tool, then prompts (`You> `). Type `exit` or `quit` (case-insensitive), or press Ctrl+C / Ctrl+D, to leave. Diagnostics (per-step logs, errors, stop notices) go to stderr; the final assistant text goes to stdout — so `npm run dev ... 2>/dev/null` shows only the answers.

## Demo prompts

1. Ordinary chat, no tool: `What is the capital of France, in one sentence?`
2. One calculation: `(12 + 8) * 3`
3. Multiple calculations: `Calculate (12 + 8) * 3 and 100 / 4, then add the results.`

The model decides when to call `calculate`; do not assume it always makes a particular number of calls for a given prompt (prompt 3 is designed to require at least two calls, but the model may split or batch them).

## What the model actually sees

The CLI keeps an OpenAI-compatible message array and sends the whole snapshot on every model call. One turn with two tool calls looks like this:

```json
[
  { "role": "system", "content": "You are Workforce CLI, a concise terminal assistant. For any arithmetic, call the calculate tool instead of computing the result yourself. Keep answers short and direct." },
  { "role": "user", "content": "Calculate (12 + 8) * 3 and 100 / 4, then add the results." },
  {
    "role": "assistant",
    "content": null,
    "tool_calls": [
      { "id": "call_a", "type": "function", "function": { "name": "calculate", "arguments": "{\"expression\":\"(12 + 8) * 3\"}" } },
      { "id": "call_b", "type": "function", "function": { "name": "calculate", "arguments": "{\"expression\":\"100 / 4\"}" } }
    ]
  },
  { "role": "tool", "tool_call_id": "call_a", "content": "{\"result\":60}" },
  { "role": "tool", "tool_call_id": "call_b", "content": "{\"result\":25}" },
  { "role": "assistant", "content": "(12 + 8) * 3 is 60 and 100 / 4 is 25, so the sum is 85." }
]
```

Tool results always sit directly after the assistant `tool_calls` they answer, and the next user message is appended after the final assistant text. History persists only for the process: leave the REPL and the conversation is gone.

## Error behavior

| Situation | What happens |
| --- | --- |
| Tool throws (bad expression, division by zero) | Loop catches it and appends a structured `{"error":"tool_error", ...}` tool message; the model sees the error and answers or tries again. |
| Model calls an unregistered tool | Structured `unknown_tool` tool message goes back to the model instead of crashing the loop. |
| Model's argument string is not valid JSON | Structured `invalid_arguments` tool message goes back to the model. |
| Arguments are valid JSON but fail the tool schema (e.g. empty or non-string `expression`) | The `calculate` tool throws; handled as a `tool_error` tool message. |
| Provider error (HTTP status, invalid JSON, malformed response body) | `llm.complete` rejects with a safe message; the turn prints `[error] ...` on stderr and the next prompt still appears — history and REPL survive. |
| Request exceeds `OLLAMA_TIMEOUT_MS` | Treated as a per-turn error (`request timed out after Nms`), same recovery as above. |
| 10 LLM round-trips in one user turn | The loop executes any pending tool calls, records them in history, then returns a stop message; the CLI prints it as `[stop]` on stderr, not as model output. The turn counter resets on the next user message. |

Stack traces are omitted from normal errors, and secrets (including the API key) are never logged. Non-secret configuration such as the model name and the timeout value intentionally appear in output and error messages (for example, a timeout error reports the configured `Nms` value).

## Scope note

This codebase is under active development. Phase 1's own documentation and offline tests cover what exists today; a live end-to-end validation against Ollama Cloud remains to be done (Farhan will run it). Treat this README as a current-behavior description, not a finished-phase announcement.
