/**
 * Agent identity vocabulary: slugs, modes, canonical tool names, depth rules,
 * and approval-policy metadata for Phase 4 agent composition.
 *
 * ## Canonical tool names
 * Every tool a composed agent may receive is one of {@link agentToolNames}.
 * The registry lookup is always keyed by these exact strings; a registry entry
 * whose capability `name` does not match the requested canonical name is a
 * composition error, not a silent downgrade.
 *
 * ## Depth (documented hierarchy)
 * - root = 0, child = 1, grandchild = 2 ({@link MAX_DELEGATION_DEPTH}).
 * - Delegation is allowed only while `depth < {@link MAX_DELEGATION_DEPTH}`;
 *   a grandchild (depth 2) can no longer delegate.
 * - {@link allowsDelegation} is total (never throws, `false` for any invalid
 *   depth); {@link childDepth} throws typed for depths that may not delegate.
 *
 * ## Approval policy
 * `approvalPolicy` on an {@link AgentDefinition} is METADATA for the host
 * application (e.g. which UI confirmation to render). It is descriptive, not
 * enforced here; enforcement of what an agent can actually call happens at
 * composition time via the capability filter, and prompts are secondary —
 * never a security mechanism.
 */

export const agentSlugs = ['general', 'orchestrator', 'analyst', 'researcher'] as const;

/** Every agent identity core knows about. `general` stays calculate-only. */
export type AgentSlug = (typeof agentSlugs)[number];

/** Plan drafting (read only) versus action execution (may include writes). */
export const agentModes = ['plan', 'action'] as const;

export type AgentMode = (typeof agentModes)[number];

/** Canonical tool names. Composition only ever resolves these strings. */
export const agentToolNames = [
  'calculate',
  'write_doc',
  'delegate_task',
  'query_data',
  'search_memory',
  'ask_user',
] as const;

export type AgentToolName = (typeof agentToolNames)[number];

export function isAgentToolName(value: unknown): value is AgentToolName {
  return typeof value === 'string' && (agentToolNames as readonly string[]).includes(value);
}

/** Root agent depth. */
export const ROOT_AGENT_DEPTH = 0 as const;

/** A grandchild (depth 2) is the deepest agent level; it cannot delegate. */
export const MAX_DELEGATION_DEPTH = 2 as const;

export const DELEGATION_TOOL_NAME = 'delegate_task' as const;

export const WRITE_DOC_TOOL_NAME = 'write_doc' as const;

export const ASK_USER_TOOL_NAME = 'ask_user' as const;

/** Delegation is allowed while the agent sits strictly above the depth cap. */
export function allowsDelegation(depth: number): boolean {
  return Number.isInteger(depth) && depth >= ROOT_AGENT_DEPTH && depth < MAX_DELEGATION_DEPTH;
}

/**
 * Depth an agent at `depth` would compose its children with. Throws typed for
 * invalid input (non-integer, negative) and for depths at or beyond the
 * delegation cap (a grandchild has no children).
 */
export function childDepth(depth: number): number {
  if (!Number.isInteger(depth) || depth < ROOT_AGENT_DEPTH) {
    throw new AgentCompositionError(`depth must be an integer >= ${ROOT_AGENT_DEPTH}, got ${String(depth)}`);
  }
  if (depth >= MAX_DELEGATION_DEPTH) {
    throw new AgentCompositionError(
      `an agent at depth ${String(depth)} is at or beyond the delegation cap ` +
        `(${MAX_DELEGATION_DEPTH}) and cannot have children`,
    );
  }
  return depth + 1;
}

import { AgentCompositionError } from './errors.js';

/** Descriptive approval metadata carried on agent definitions. */
export const agentApprovalPolicies = ['never', 'write-operations'] as const;

export type AgentApprovalPolicy = (typeof agentApprovalPolicies)[number];
