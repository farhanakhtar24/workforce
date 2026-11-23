/**
 * The `calculate` tool wiring for the Phase 2 agent plus the message-pipeline
 * helpers (validate → convert) that keep one UIMessage source of truth
 * (ADR-008). The tool set contains **exactly one** tool, shared from
 * `@workforce/core`; no `tool_choice`, no structured output (phase contract).
 */
import {
  convertToModelMessages,
  safeValidateUIMessages,
  tool,
  type Tool,
  type ToolSet,
} from 'ai';
import type { ModelMessage, UIMessage } from 'ai';
import {
  calculateInputSchema,
  calculateToolDescription,
  calculateToolName,
  executeCalculate,
} from '@workforce/core';
import type { z } from 'zod';

/**
 * Exactly one tool: `calculate`, wrapping `@workforce/core`'s exports so the
 * CLI and the API validate and evaluate identically. The execution result is
 * the JSON string produced by `executeCalculate` (e.g. `{"result":60}`).
 */
export const calculateTool = tool({
  description: calculateToolDescription,
  inputSchema: calculateInputSchema,
  execute: async (input: z.infer<typeof calculateInputSchema>) => executeCalculate(input),
});

export const agentTools = {
  [calculateToolName]: calculateTool,
} as const satisfies ToolSet;

export const MAX_MODEL_STEPS = 10;

/** The `tools` record shape `validateUIMessages` expects (AI SDK variance). */
type ValidateToolsOptions = { [name: string]: Tool<unknown, unknown> | undefined };

/**
 * Validates a whole conversation with `validateUIMessages` semantics and
 * converts it to model messages. Returns `null` when validation fails (stored
 * or client state is not a valid UIMessage conversation).
 */
export async function validateAndConvertMessages(
  messages: UIMessage[],
  tools: ToolSet,
): Promise<ModelMessage[] | null> {
  const validated = await safeValidateUIMessages<UIMessage>({
    messages: [...messages],
    tools: tools as ValidateToolsOptions,
  });
  if (!validated.success) {
    return null;
  }
  return await convertToModelMessages(validated.data, { tools });
}
