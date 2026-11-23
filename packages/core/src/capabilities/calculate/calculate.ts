/**
 * The `calculate` tool: safe arithmetic evaluation for the agent.
 *
 * Shared by the Phase 1 raw-HTTP CLI and the Phase 2 AI SDK integration, so
 * both transports validate and evaluate expressions identically.
 */

import { z } from 'zod';
import { evaluateArithmetic } from './calculator.js';

/** Hard upper bound on expression length, mirrored by the Zod schema. */
const MAX_EXPRESSION_LENGTH = 500;

/** Name of the calculate tool, as registered with the model. */
export const calculateToolName = 'calculate';

export const calculateToolDescription =
  'Evaluate an arithmetic expression and return the numeric result as JSON. ' +
  'Use this tool for any arithmetic you need to compute, for example "(12 + 8) * 3". ' +
  'Supports + - * / with normal precedence, unary + and -, parentheses, decimals, and whitespace. ' +
  'Returns {"result":60} style JSON.';

/**
 * Strict Zod schema for the tool's arguments: `{ expression: string }`.
 * Unknown keys are rejected, and the expression must be 1-500 characters.
 */
export const calculateInputSchema = z.strictObject({
  expression: z
    .string()
    .min(1, 'expression must not be empty')
    .max(MAX_EXPRESSION_LENGTH, `expression must be at most ${MAX_EXPRESSION_LENGTH} characters`),
});

/**
 * JSON Schema describing the tool's arguments, as sent to an
 * OpenAI-compatible model.
 */
export const calculateParametersSchema = {
  type: 'object',
  properties: {
    expression: {
      type: 'string',
      description:
        'Arithmetic expression to evaluate, for example "(12 + 8) * 3". ' +
        'Supports + - * /, unary + and -, parentheses, decimals, and whitespace.',
    },
  },
  required: ['expression'],
  additionalProperties: false,
};

/**
 * Validate `args` against {@link calculateInputSchema} and evaluate the
 * expression, returning the result as a JSON string such as {"result":60}.
 * Throws Error with a useful message for invalid arguments and invalid
 * expressions (syntax, division by zero, non-finite results).
 */
export function executeCalculate(args: unknown): string {
  const parsed = calculateInputSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid arguments for the calculate tool: ${issues}`);
  }
  return evaluateArithmetic(parsed.data.expression);
}
