/**
 * Workforce CLI entry point and REPL.
 *
 * Phase 1: no streaming, no UI beyond terminal prompts, no persistence, and
 * exactly one production tool (`calculate`). Diagnostics go to stderr so the
 * final assistant text can go to stdout.
 *
 * Security invariants:
 * - The API key is read from the environment only and is never printed,
 *   logged, or embedded in an error message. Configuration errors use the
 *   messages produced by `loadConfig`, which contain variable names only.
 * - Stack traces are never printed for expected startup or per-turn errors.
 */

import { createInterface } from 'node:readline/promises';

import { loadConfig, type Config } from './config.js';
import { createOllamaClient } from './llm.js';
import { ConversationHistory } from './history.js';
import { runAgentTurn, type AgentLoopEvent } from './loop.js';
import type { AgentLoopResult } from './types.js';

/** Same constant for every turn: the identity the model sees. */
const SYSTEM_PROMPT =
  'You are Workforce CLI, a concise terminal assistant. ' +
  'For any arithmetic, call the calculate tool instead of computing the result yourself. ' +
  'Keep answers short and direct.';

/** Prompt shown before each user line. */
const PROMPT = 'You> ';

/** Safe message from an arbitrary thrown value, with no stack trace. */
function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '';
}

/** Log one agent-loop step as a labeled, pretty-printed diagnostic on stderr. */
function logEvent(event: AgentLoopEvent): void {
  switch (event.type) {
    case 'model_input': {
      process.stderr.write(
        `[step ${event.step}] model_input: ${pretty(event.messages)}\n`,
      );
      break;
    }
    case 'model_output': {
      const payload: Record<string, unknown> = {
        message: event.message,
      };
      if (event.usage !== undefined) {
        payload.usage = event.usage;
      }
      process.stderr.write(
        `[step ${event.step}] model_output: ${pretty(payload)}\n`,
      );
      break;
    }
    case 'tool_call': {
      process.stderr.write(
        `[step ${event.step}] tool_call: ${pretty({
          id: event.call.id,
          name: event.call.function.name,
          arguments: event.call.function.arguments,
        })}\n`,
      );
      break;
    }
    case 'tool_result': {
      process.stderr.write(
        `[step ${event.step}] tool_result: ${pretty({
          id: event.callId,
          name: event.name,
          status: event.status,
          content: event.content,
        })}\n`,
      );
      break;
    }
  }
}

/**
 * Print the outcome of one turn. A normal completion goes to stdout as the
 * agent's own text; a max-step stop goes to stderr as a warning so it is
 * never mistaken for model output.
 */
function printTurnResult(result: AgentLoopResult): void {
  const lastMessage = result.messages.at(-1);
  if (lastMessage?.role === 'assistant') {
    const text = result.text.length > 0 ? result.text : '(the model returned no text)';
    process.stdout.write(`\nWorkforce: ${text}\n\n`);
    return;
  }
  process.stderr.write(`\n[stop] ${result.text}\n\n`);
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`Workforce CLI failed to start: ${safeMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const client = createOllamaClient(config);
  const history = new ConversationHistory(SYSTEM_PROMPT);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    rl.close();
  });

  // On EOF (Ctrl+D) Node abandons the pending question without settling it,
  // so watch 'close' explicitly and race it against each prompt.
  let settleClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    settleClosed = resolve;
  });
  rl.on('close', () => {
    settleClosed?.();
  });

  process.stdout.write(
    `Workforce CLI — model: ${config.model}, tool: calculate. ` +
      `Type a message; 'exit' or 'quit' (or Ctrl+C / Ctrl+D) to leave.\n\n`,
  );

  for (;;) {
    const line = await Promise.race([
      rl.question(PROMPT).then(
        (value) => value,
        () => null, // interface closed while answering
      ),
      closed.then(() => null), // 'close' fired (EOF or Ctrl+C)
    ]);
    if (line === null) {
      break;
    }

    const input = line.trim();
    if (input.length === 0) {
      continue;
    }
    if (/^(exit|quit)$/i.test(input)) {
      break;
    }

    try {
      const result = await runAgentTurn({
        input,
        history,
        llm: client,
        onEvent: logEvent,
      });
      printTurnResult(result);
    } catch (error) {
      // A failed model request does not end the REPL; the operator can try
      // again with the same history.
      process.stderr.write(`[error] ${safeMessage(error)}\n\n`);
    }
  }

  rl.close();
  process.stderr.write('Goodbye.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`[fatal] ${safeMessage(error)}\n`);
  process.exitCode = 1;
});
