/**
 * Adapter between core `Capability` instances (SDK-independent) and AI SDK v6
 * `tool()` objects.
 *
 * Rules (ADR-001/002, phase spec):
 * - Same Zod input schema as the capability; the SDK validates unknown input.
 * - `outputSchema` is forwarded whenever the capability carries one, so tool
 *   outputs are schema-validated at the boundary too.
 * - `ask_user` stays genuinely execute-less: `tool()` is created WITHOUT an
 *   `execute` function, so the model turn ends with a persisted
 *   `input-available` part and no `stop()` is involved anywhere.
 * - Any error escaping a capability executor is replaced by a `CapabilityToolError`
 *   with a FIXED safe message — provider bodies, URLs, secrets, or raw store
 *   errors must never reach the model/UI as tool output.
 * - `calculate` maps to the EXISTING shared `calculateTool` object (byte-for-
 *   byte Phase 2 behavior: same description, schema, execute, JSON output).
 */
import { tool, type Tool, type ToolSet } from 'ai';

/** ToolSet alias kept structurally identical to AI SDK's `ToolSet`. */
export type ToolSetLike = ToolSet;
import type { z } from 'zod';
import { isExecutableCapability, type Capability } from '@workforce/core';
import { calculateCapability } from '@workforce/core';

import { agentTools } from '../messages.js';
import { ToolRestError } from './host-capabilities.js';

/** Fixed safe error thrown by adapted capabilities; safe to show in the UI. */
export class CapabilityToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityToolError';
  }
}

export function safeCapabilityError(error: unknown): CapabilityToolError {
  if (error instanceof CapabilityToolError) {
    return error;
  }
  if (error instanceof ToolRestError) {
    // Authored fixed text (invalid 400 / conflict 409 / unavailable 503 / …):
    // already classified and never carries backend/provider content — keep the
    // distinction instead of collapsing every REST failure into one generic.
    return error as CapabilityToolError;
  }
  return new CapabilityToolError('Tool execution failed. Check the API logs for details.');
}

/** Creates the AI SDK `tool()` for one capability (ask_user stays execute-less). */
export function adaptCapabilityToTool(capability: Capability): Tool {
  // Phase 1-2 calculate: reuse the exact shared tool object.
  if (capability.name === 'calculate' && capability === (calculateCapability as unknown)) {
    return agentTools['calculate'] as Tool;
  }
  const description = capability.description;
  const inputSchema = capability.inputSchema as z.ZodType;
  if (!isExecutableCapability(capability)) {
    return tool({ description, inputSchema }) as Tool; // ask_user (execute-less)
  }
  const execute = capability.execute;
  const outputSchema = capability.outputSchema ?? undefined;
  return tool({
    description,
    inputSchema,
    ...(outputSchema !== undefined ? { outputSchema: outputSchema as z.ZodType } : {}),
    execute: async (input: unknown) => {
      try {
        return await execute(input);
      } catch (error: unknown) {
        throw safeCapabilityError(error);
      }
    },
  }) as Tool;
}

/** Builds a `ToolSet` record keyed by capability name. */
export function toToolSet(capabilities: readonly Capability[]): ToolSet {
  const set: Record<string, Tool> = {};
  for (const capability of capabilities) {
    set[capability.name] = adaptCapabilityToTool(capability);
  }
  return set as ToolSet;
}

/** Canonical name list of a ToolSet (for tests asserting the composed view). */
export function toolNamesOf(set: ToolSet): string[] {
  return Object.keys(set).sort();
}
