/**
 * Static agent definitions for the four Workflow slugs.
 *
 * ## Authorization contract (read this before touching the tool arrays)
 * These arrays are the SINGLE SOURCE OF TRUTH for what an agent may receive.
 * `composeAgentCapabilities` intersects them with the host registry and the
 * mode/depth rules; the system prompts below are plain prose for the MODEL and
 * are deliberately NOT a security mechanism — a prompt change must never be
 * able to grant a tool, which is why every definition object is frozen here.
 *
 * Tool arrays are authored in canonical {@link agentToolNames} order so
 * composed capability order is deterministic.
 *
 * Roles:
 * - general:   calculate only. The workhorse that never leaves arithmetic.
 * - orchestrator: read facts (calculate/query_data/search_memory/ask_user),
 *   write documents (write_doc), and delegate (delegate_task).
 * - analyst:   read-only worker over stored data; no writes, no delegation.
 * - researcher: read-only worker over memory; no SQL (query_data), no writes,
 *   no delegation.
 */

import type { AgentApprovalPolicy, AgentMode, AgentSlug, AgentToolName } from './types.js';

export interface AgentDefinition {
  readonly slug: AgentSlug;
  /** Short human-facing display name. */
  readonly name: string;
  /** One-line summary of the agent's role (docs/UI). */
  readonly description: string;
  /**
   * Concise, domain-neutral system prompt. Secondary on purpose: prompts never
   * grant tools; composition authorizes strictly via the arrays below.
   */
  readonly systemPrompt: string;
  readonly readOnlyTools: readonly AgentToolName[];
  readonly writeTools: readonly AgentToolName[];
  /** Descriptive approval metadata for host UIs; not enforced here. */
  readonly approvalPolicy: AgentApprovalPolicy;
}

const GENERAL_DEFINITION: AgentDefinition = {
  slug: 'general',
  name: 'General Worker',
  description: 'Solves a single task directly and never needs more than arithmetic.',
  systemPrompt:
    'You are a general worker completing one self-contained task. ' +
    'Solve it directly and concisely. ' +
    'Use the calculate tool for every arithmetic step instead of computing numbers in your head. ' +
    'Report exactly what was asked, with the computed numbers.',
  readOnlyTools: ['calculate'],
  writeTools: [],
  approvalPolicy: 'never',
};

const ORCHESTRATOR_DEFINITION: AgentDefinition = {
  slug: 'orchestrator',
  name: 'Orchestrator',
  description: 'Plans work, records decisions, and delegates subtasks to workers.',
  systemPrompt:
    'You are an orchestrator coordinating worker agents. ' +
    'Plan before acting. ' +
    'Use your read tools to gather facts before deciding. ' +
    'Record durable findings and decisions as work documents with write_doc. ' +
    'Delegate self-contained subtasks with delegate_task when specialized or ' +
    'parallel work helps, one clear objective per delegation.',
  readOnlyTools: ['calculate', 'query_data', 'search_memory', 'ask_user'],
  writeTools: ['write_doc', 'delegate_task'],
  approvalPolicy: 'write-operations',
};

const ANALYST_DEFINITION: AgentDefinition = {
  slug: 'analyst',
  name: 'Analyst Worker',
  description: 'Read-only analysis over stored datasets and memory.',
  systemPrompt:
    'You are an analyst worker examining data within your assigned scope. ' +
    'Use calculate for arithmetic and query_data or search_memory to inspect ' +
    'facts already stored in scope. ' +
    'You have no write access and cannot delegate; report your analysis back.',
  readOnlyTools: ['calculate', 'query_data', 'search_memory', 'ask_user'],
  writeTools: [],
  approvalPolicy: 'never',
};

const RESEARCHER_DEFINITION: AgentDefinition = {
  slug: 'researcher',
  name: 'Researcher Worker',
  description: 'Read-only investigation of recorded knowledge in memory.',
  systemPrompt:
    'You are a researcher worker investigating recorded knowledge. ' +
    'Use search_memory to find relevant context and calculate for any ' +
    'arithmetic you need. ' +
    'You have no SQL access, no write access, and cannot delegate; report ' +
    'what you found and what remains unknown.',
  readOnlyTools: ['calculate', 'search_memory', 'ask_user'],
  writeTools: [],
  approvalPolicy: 'never',
};

/** The definitions keyed by slug, deep-frozen: a prompt or array can never be swapped at runtime. */
export const agentDefinitions: Readonly<Record<AgentSlug, AgentDefinition>> = deepFreeze({
  general: GENERAL_DEFINITION,
  orchestrator: ORCHESTRATOR_DEFINITION,
  analyst: ANALYST_DEFINITION,
  researcher: RESEARCHER_DEFINITION,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const propertyValue of Object.values(value as Record<string, unknown>)) {
      deepFreeze(propertyValue);
    }
    Object.freeze(value);
  }
  return value;
}

/** Modes an agent definition is composed under (fixed vocabulary). */
export const definitionModes: readonly AgentMode[] = ['plan', 'action'] as const;
