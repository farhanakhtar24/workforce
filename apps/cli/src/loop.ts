/**
 * Raw agent loop: model -> tool calls -> tool result messages -> model,
 * repeated until the model answers without tool calls or the step cap for
 * the current user turn is reached.
 *
 * No streaming, persistence, UI, or SDK. Every observable step travels
 * through the typed event callback; this module never logs to the console
 * and never includes API keys or other config in events or error payloads.
 */

import { registeredTools } from './tools/index.js';
import type { ConversationHistory } from './history.js';
import type {
  AgentLoopResult,
  AssistantMessage,
  ChatMessage,
  FunctionToolCall,
  LlmClient,
  TokenUsage,
  ToolDefinition,
  ToolMessage,
} from './types.js';

/** Upper bound on LLM round trips per user turn. */
export const DEFAULT_MAX_STEPS = 10;

/**
 * One observable step of the loop. `model_input` / `model_output` / `tool_call`
 * / `tool_result` are enough for a logger to trace each model round trip.
 */
export type AgentLoopEvent =
  | {
      readonly type: 'model_input';
      /** 1-based model invocation number within the current user turn. */
      readonly step: number;
      readonly messages: readonly ChatMessage[];
    }
  | {
      readonly type: 'model_output';
      readonly step: number;
      readonly message: AssistantMessage;
      readonly usage?: TokenUsage;
    }
  | {
      readonly type: 'tool_call';
      readonly step: number;
      /** The exact tool call as it arrived on the assistant message. */
      readonly call: FunctionToolCall;
    }
  | {
      readonly type: 'tool_result';
      readonly step: number;
      readonly callId: string;
      readonly name: string;
      readonly content: string;
      readonly status: 'success' | 'error';
    };

export type AgentLoopEventCallback = (event: AgentLoopEvent) => void;

export interface RunAgentTurnOptions {
  readonly input: string;
  readonly history: ConversationHistory;
  readonly llm: LlmClient;
  /** Defaults to `registeredTools`; lookup is derived from this array. */
  readonly tools?: readonly ToolDefinition[];
  /** Defaults to {@link DEFAULT_MAX_STEPS}; must be a positive integer. */
  readonly maxSteps?: number;
  /** Synchronous, optional observer for every loop step. */
  readonly onEvent?: AgentLoopEventCallback;
}

function structuredError(
  kind: 'unknown_tool' | 'invalid_arguments' | 'tool_error',
  message: string,
): string {
  return JSON.stringify({ error: kind, message });
}

/**
 * Safe message from an arbitrary thrown value. `String(error)` for non-Error
 * values; no config, keys, or stack traces are ever included.
 */
function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

interface ExecutedToolCall {
  readonly call: FunctionToolCall;
  readonly content: string;
  readonly status: 'success' | 'error';
}

/**
 * Run one tool call end to end. Every failure mode (unknown name, malformed
 * JSON arguments, execution throw — synchronous or async) becomes a
 * structured JSON tool message instead of an exception escaping the loop.
 */
async function executeToolCall(
  call: FunctionToolCall,
  toolMap: ReadonlyMap<string, ToolDefinition>,
): Promise<Omit<ExecutedToolCall, 'call'>> {
  const name = call.function.name;
  const tool = toolMap.get(name);
  if (!tool) {
    return {
      content: structuredError(
        'unknown_tool',
        `No tool named ${JSON.stringify(name)} is registered.`,
      ),
      status: 'error',
    };
  }

  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments) as unknown;
  } catch (error) {
    return {
      content: structuredError(
        'invalid_arguments',
        `Arguments for tool ${JSON.stringify(name)} are not valid JSON: ${safeErrorMessage(error)}`,
      ),
      status: 'error',
    };
  }

  try {
    const result = await tool.execute(args);
    const content = typeof result === 'string' ? result : JSON.stringify(result ?? null);
    return { content, status: 'success' };
  } catch (error) {
    return {
      content: structuredError(
        'tool_error',
        `Tool ${JSON.stringify(name)} failed: ${safeErrorMessage(error)}`,
      ),
      status: 'error',
    };
  }
}

/**
 * Run one user turn against the LLM until it answers without tool calls or
 * `maxSteps` LLM invocations have happened.
 *
 * Stop/error semantics:
 * - Unknown tools, malformed argument JSON, and thrown tool errors never
 *   escape the loop; each becomes one structured tool message fed back to
 *   the model.
 * - The only reject paths are `llm.complete` rejections and invalid
 *   `maxSteps` (< 1 or not an integer).
 * - When the final allowed response still requests tools, those calls are
 *   executed and recorded, then the run returns a max-step message without
 *   an additional LLM call. Counter is per call; the transcript persists.
 */
export async function runAgentTurn(options: RunAgentTurnOptions): Promise<AgentLoopResult> {
  const tools = options.tools ?? registeredTools;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error(`maxSteps must be a positive integer, received ${maxSteps}`);
  }
  const onEvent = options.onEvent;
  const toolMap = new Map<string, ToolDefinition>(
    tools.map((tool) => [tool.schema.name, tool] as const),
  );

  let llmCalls = 0;
  options.history.addUser(options.input);

  for (;;) {
    const step = llmCalls + 1;

    // Step 1: full snapshot of the current transcript for this round trip.
    const messages = options.history.snapshot();
    onEvent?.({ type: 'model_input', step, messages });

    // Step 2: the model call itself.
    const response = await options.llm.complete(messages, tools.map((tool) => tool.schema));
    llmCalls += 1;

    // Step 3: record the assistant turn and report it.
    options.history.append(response.message);
    onEvent?.({
      type: 'model_output',
      step,
      message: response.message,
      usage: response.usage,
    });

    // Step 4: no tool calls -> final text for the turn.
    const calls = response.message.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        text: response.message.content ?? '',
        messages: options.history.snapshot(),
        llmCalls,
      };
    }

    // Step 5: execute every call in order. When the step cap was just used,
    // the results are still appended so the history stays complete, then the
    // loop returns before requesting another model response.
    const executed: ExecutedToolCall[] = [];
    for (const call of calls) {
      onEvent?.({ type: 'tool_call', step, call });
      const outcome = await executeToolCall(call, toolMap);
      executed.push({ call, content: outcome.content, status: outcome.status });
    }

    for (const { call, content, status } of executed) {
      const toolMessage: ToolMessage = { role: 'tool', tool_call_id: call.id, content };
      options.history.append(toolMessage);
      onEvent?.({
        type: 'tool_result',
        step,
        callId: call.id,
        name: call.function.name,
        content,
        status,
      });
    }

    if (llmCalls >= maxSteps) {
      return {
        text:
          `Reached the maximum of ${maxSteps} LLM calls for this turn; ` +
          'the latest tool results are recorded in history and the loop stopped before another model call.',
        messages: options.history.snapshot(),
        llmCalls,
      };
    }
  }
}
