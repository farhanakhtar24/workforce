/**
 * The built-in `calculate` capability: a {@link Capability} adapter around the
 * Phase 1 pure calculator (`executeCalculate`). Pure, read-only, no approval.
 *
 * `execute` validates `input` against the same strict schema the CLI/AI-SDK
 * tool uses, evaluates the arithmetic, and returns the parsed result object
 * (`{ result: 60 }`) plus the original JSON string for transport parity.
 */

import { z } from 'zod';

import { calculateInputSchema, executeCalculate } from '../capabilities/calculate/calculate.js';
import { defineCapability } from './capability.js';

export const CALCULATE_CAPABILITY_NAME = 'calculate' as const;

export const calculateOutputSchema = z.object({ result: z.number() }).strict();

export interface CalculateCapabilityResult {
  readonly result: number;
  /** The exact JSON string the raw-HTTP tool contract returns (`{"result":60}`). */
  readonly json: string;
}

export const calculateCapability = defineCapability(
  {
    name: CALCULATE_CAPABILITY_NAME,
    description:
      'Evaluate an arithmetic expression and return the numeric result. ' +
      'Use this tool for any arithmetic instead of computing numbers yourself. ' +
      'Supports + - * / with normal precedence, unary +/-, parentheses, and decimals.',
    inputSchema: calculateInputSchema,
    outputSchema: calculateOutputSchema,
    readOnly: true,
    requiresApproval: false,
    approvalReason: null,
  },
  (input: unknown): CalculateCapabilityResult => {
    const json = executeCalculate(input);
    const parsed = calculateOutputSchema.parse(JSON.parse(json));
    return { result: parsed.result, json };
  },
);
