/**
 * Tool registry for the Workforce agent loop.
 *
 * Phase 1 registers exactly one tool: `calculate`. The agent loop reads
 * `registeredTools` to build the `tools` payload for the LLM and uses
 * `toolRegistry.get(name)` to dispatch incoming tool calls.
 */

import type { ToolDefinition, ToolRegistry } from '../types.js';
import { calculateTool } from './calculate.js';

export { calculateTool };

/** Every registered tool, in registration order. */
export const registeredTools: readonly ToolDefinition[] = [calculateTool];

/** Lookup by tool name; unknown names return undefined. */
export const toolRegistry: ToolRegistry = {
  get(name: string): ToolDefinition | undefined {
    return registeredTools.find((tool) => tool.schema.name === name);
  },
};
