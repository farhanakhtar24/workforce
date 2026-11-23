/**
 * Per-generation toolset composition for the API (ADR-001): the ONLY place
 * that turns (slug, mode, depth, context) into an AI SDK `ToolSet`.
 *
 * Two sets are produced each generation:
 * - `tools` — the COMPOSED generation set: definition tools ∩ mode/depth rules.
 *   Plan mode omits write_doc/delegate_task entirely; depth ≥ 2 omits
 *   delegate_task; workers/general can never receive them.
 * - `validationTools` — the agent's FULL allowed action set at depth 0. Used
 *   for `validateUIMessages`/`convertToModelMessages` so HISTORICAL tool parts
 *   from earlier action-mode generations stay valid when the user switches to
 *   plan mode or a child runs at depth ≥ 1. Unknown/forbidden tool parts still
 *   fail validation (safe 400).
 */
import {
  composeAgentCapabilities,
  MapAgentRegistry,
  type AgentMode,
  type AgentSlug,
} from '@workforce/core';
import { toToolSet, type ToolSetLike } from './capability-adapter.js';

import { buildHostCapabilities, type AgentToolContext, type HostCapabilityDeps } from './host-capabilities.js';
import type { ToolSet } from 'ai';

export interface PreparedGeneration {
  readonly agent: AgentSlug;
  readonly mode: AgentMode;
  readonly depth: number;
  /** Composed tools handed to `streamText`. */
  readonly tools: ToolSet;
  /** Full allowed action/depth-0 set used for transcript validation/conversion. */
  readonly validationTools: ToolSet;
  /** Definition system prompt (NEW agents only; `general` stays promptless). */
  readonly systemPrompt: string | null;
  readonly allowsDelegation: boolean;
  readonly toolNames: readonly string[];
}

export interface PrepareGenerationInput {
  readonly slug: AgentSlug;
  readonly mode: AgentMode;
  readonly depth: number;
  readonly chatId: string;
  readonly parentMessageId: string;
}

/**
 * Composes ONCE per generation: registry instances are built around the trusted
 * context closure, then core composition applies mode/depth filters.
 */
export function prepareGeneration(deps: HostCapabilityDeps, input: PrepareGenerationInput): PreparedGeneration {
  const ctx: AgentToolContext = {
    slug: input.slug,
    chatId: input.chatId,
    parentMessageId: input.parentMessageId,
    scope: 'default',
    depth: input.depth,
  };
  const registry = new MapAgentRegistry(buildHostCapabilities(deps, ctx));
  const composed = composeAgentCapabilities({
    agent: input.slug,
    mode: input.mode,
    depth: input.depth,
    registry,
  });
  const validation = composeAgentCapabilities({
    agent: input.slug,
    mode: 'action',
    depth: 0,
    registry,
  });
  return {
    agent: composed.agent,
    mode: composed.mode,
    depth: composed.depth,
    tools: toToolSet(composed.capabilities),
    validationTools: toToolSet(validation.capabilities),
    // general keeps its Phase 1-2 promptless behavior bit-for-bit.
    systemPrompt: input.slug === 'general' ? null : composed.definition.systemPrompt,
    allowsDelegation: composed.allowsDelegation,
    toolNames: composed.toolNames,
  };
}

export type { ToolSetLike };
