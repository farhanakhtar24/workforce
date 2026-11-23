/**
 * The `calculate` tool adapter for the CLI.
 *
 * Parsing, validation, and execution live in `@workforce/core` so the CLI and
 * other transports share exactly the same behavior; this file only adapts the
 * core capability to the local `ToolDefinition` contract.
 */

import {
  calculateParametersSchema,
  calculateToolDescription,
  calculateToolName,
  executeCalculate,
} from '@workforce/core';
import type { ToolDefinition } from '../types.js';

export const calculateTool: ToolDefinition = {
  schema: {
    name: calculateToolName,
    description: calculateToolDescription,
    parameters: calculateParametersSchema,
  },
  execute: executeCalculate,
};
