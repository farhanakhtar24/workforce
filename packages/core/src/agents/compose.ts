/**
 * {@link composeAgentCapabilities} — the composition-time authorization gate.
 *
 * Guarantees (tested in `./agents.test.ts`):
 * 1. The composed tool set is EXACTLY the agent definition's tools for the
 *    given mode, filtered by the delegation depth cap — never the registry's
 *    own list. Plan mode omits `write_doc` and `delegate_task` ENTIRELY, even
 *    when the caller "requests" them or the registry offers more capabilities.
 * 2. Worker agents (analyst/researcher) and `general` carry no write tools in
 *    any mode or depth: forbidden tools are absent, not blocked at runtime.
 * 3. `delegate_task` is omitted whenever `depth >= MAX_DELEGATION_DEPTH`
 *    (root=0, child=1, grandchild=2).
 * 4. Registry lookups happen only for canonical tool names the definition
 *    allows; a registry capability whose `name` does not match the requested
 *    name is a typed composition error (no silent substitution).
 * 5. Capabilities absent from the registry are simply unavailable (a host may
 *    ship a subset); the composed agent carries the intersection.
 * 6. Everything returned is deeply frozen: definitions, arrays, capabilities.
 * 7. `ask_user` is the ONLY capability that may be composed WITHOUT an
 *    execute function: it is human-in-the-loop metadata — the human answer
 *    travels back through the conversation channel, never through the call
 *    path. Every other canonical tool without an execute function is a typed
 *    composition error.
 *
 * No runtime reliance on prompts: selecting capabilities only reads the
 * definition's tool arrays; system prompt text can never change the outcome.
 */

import {
  DELEGATION_TOOL_NAME,
  WRITE_DOC_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  ROOT_AGENT_DEPTH,
  MAX_DELEGATION_DEPTH,
  agentModes,
  agentSlugs,
  isAgentToolName,
  allowsDelegation,
  type AgentMode,
  type AgentSlug,
  type AgentToolName,
} from './types.js';
import { AgentCompositionError } from './errors.js';
import type { Capability } from './capability.js';
import { calculateCapability } from './calculate-capability.js';
import { agentDefinitions, type AgentDefinition } from './definitions.js';

/** Supply-side registry: hosts expose only the capabilities they provide. */
export interface AgentRegistry {
  /**
   * Resolve one capability by its CANONICAL tool name. Returning undefined or
   * null means "not provided" (the composed agent omits the tool). Returning
   * a capability whose `name` differs from `name` is rejected by composition.
   */
  get(name: string): Capability | null | undefined;
}

/** Simple record-backed registry implementation. */
export class MapAgentRegistry implements AgentRegistry {
  private readonly byName: ReadonlyMap<string, Capability>;

  constructor(capabilities: readonly Capability[]) {
    const map = new Map<string, Capability>();
    for (const capability of capabilities) {
      if (typeof capability?.name !== 'string' || capability.name.length === 0) {
        throw new AgentCompositionError('registry capabilities must carry a non-empty name');
      }
      map.set(capability.name, capability);
    }
    this.byName = map;
  }

  get(name: string): Capability | null | undefined {
    return this.byName.get(name);
  }
}

/** Built-in registry: core ships exactly one real capability — pure arithmetic. */
export const builtinAgentRegistry: AgentRegistry = new MapAgentRegistry([calculateCapability]);

export interface ComposeAgentInput {
  readonly agent: AgentSlug;
  readonly mode: AgentMode;
  /** Root=0, child=1, grandchild=2; must be an integer within [0, 2]. */
  readonly depth: number;
  /** Defaults to {@link builtinAgentRegistry}. */
  readonly registry?: AgentRegistry;
}

export interface ComposedAgent {
  readonly agent: AgentSlug;
  readonly mode: AgentMode;
  readonly depth: number;
  /** The agent's static definition, deep-frozen (prompt included, advisory only). */
  readonly definition: AgentDefinition;
  /** Registry-resolved capabilities in the definition's canonical tool order. */
  readonly capabilities: readonly Capability[];
  readonly readOnlyCapabilities: readonly Capability[];
  readonly writeCapabilities: readonly Capability[];
  /** Canonical tool names corresponding 1:1 to `capabilities`. */
  readonly toolNames: readonly AgentToolName[];
  /** `delegate_task` availability after mode/depth filtering. */
  readonly allowsDelegation: boolean;
}

interface ValidatedComposeInput {
  readonly agent: AgentSlug;
  readonly mode: AgentMode;
  readonly depth: number;
  readonly registry: AgentRegistry;
}

function validateComposeInput(input: ComposeAgentInput): ValidatedComposeInput {
  if (typeof input?.agent !== 'string' || !(agentSlugs as readonly string[]).includes(input.agent)) {
    throw new AgentCompositionError(
      `unknown agent slug ${JSON.stringify(input?.agent)}; expected one of ${agentSlugs.join(', ')}`,
    );
  }
  if (typeof input?.mode !== 'string' || !(agentModes as readonly string[]).includes(input.mode)) {
    throw new AgentCompositionError(
      `unknown agent mode ${JSON.stringify(input?.mode)}; expected one of ${agentModes.join(', ')}`,
    );
  }
  const depth = input?.depth;
  if (
    typeof depth !== 'number' ||
    !Number.isInteger(depth) ||
    depth < ROOT_AGENT_DEPTH ||
    depth > MAX_DELEGATION_DEPTH
  ) {
    throw new AgentCompositionError(
      `depth must be an integer between ${ROOT_AGENT_DEPTH} and ${MAX_DELEGATION_DEPTH}, got ${String(depth)}`,
    );
  }
  const registry = input.registry ?? builtinAgentRegistry;
  if (typeof registry?.get !== 'function') {
    throw new AgentCompositionError('registry must expose get(name) returning a capability or undefined');
  }
  return { agent: input.agent, mode: input.mode, depth, registry };
}

/**
 * Which canonical tools the (slug, mode, depth) triple may receive:
 * - read tools: always, for every mode/depth;
 * - write tools: action mode only, minus `delegate_task` when the depth cap
 *   forbids delegation (plan mode drops all write tools).
 */
export function composeAllowedToolNames(agent: AgentSlug, mode: AgentMode, depth: number): readonly AgentToolName[] {
  const definition = agentDefinitions[agent];
  const allowed: AgentToolName[] = [...definition.readOnlyTools];
  if (mode === 'action') {
    for (const tool of definition.writeTools) {
      if (tool === DELEGATION_TOOL_NAME && !allowsDelegation(depth)) {
        continue;
      }
      allowed.push(tool);
    }
  }
  return allowed;
}

export function composeAgentCapabilities(input: ComposeAgentInput): ComposedAgent {
  const { agent, mode, depth, registry } = validateComposeInput(input);
  const definition = agentDefinitions[agent];
  const allowedTools = composeAllowedToolNames(agent, mode, depth);

  const capabilities: Capability[] = [];
  const toolNames: AgentToolName[] = [];
  for (const toolName of allowedTools) {
    if (!isAgentToolName(toolName)) {
      // Defense in depth: definitions may only list canonical tool names.
      throw new AgentCompositionError(`definition for ${agent} lists non-canonical tool ${JSON.stringify(toolName)}`);
    }
    const capability = registry.get(toolName);
    if (capability === undefined || capability === null) {
      continue; // Not provided by this host; omitted entirely, never stubbed.
    }
    if (typeof capability?.name !== 'string' || capability.name !== toolName) {
      throw new AgentCompositionError(
        `registry returned a capability named ${JSON.stringify(capability?.name)} for tool ` +
          `${JSON.stringify(toolName)}; capability names must match the requested canonical tool`,
      );
    }
    if (typeof capability.execute !== 'function' && toolName !== ASK_USER_TOOL_NAME) {
      throw new AgentCompositionError(
        `capability ${JSON.stringify(toolName)} must expose an execute function; ` +
          `only ${JSON.stringify(ASK_USER_TOOL_NAME)} may be composed metadata-only (human-in-the-loop)`,
      );
    }
    capabilities.push(capability);
    toolNames.push(toolName);
  }

  const readOnlyCapabilities = capabilities.filter((capability) => capability.readOnly === true);
  const writeCapabilities = capabilities.filter((capability) => capability.readOnly !== true);

  return Object.freeze({
    agent,
    mode,
    depth,
    definition: agentDefinitions[agent],
    capabilities: Object.freeze(capabilities.slice()),
    readOnlyCapabilities: Object.freeze(readOnlyCapabilities),
    writeCapabilities: Object.freeze(writeCapabilities),
    toolNames: Object.freeze(toolNames.slice()),
    allowsDelegation: toolNames.includes(DELEGATION_TOOL_NAME),
  });
}

/**
 * Guard for write-capable composition: the write_doc / delegate_task tools an
 * agent may receive in the given mode (before registry availability is known).
 * Useful for host UIs that render "would write" affordances from metadata.
 */
export function composeWritePotential(agent: AgentSlug, mode: AgentMode, depth: number): readonly AgentToolName[] {
  if (mode !== 'action') {
    return Object.freeze([] as AgentToolName[]);
  }
  return Object.freeze(
    composeAllowedToolNames(agent, mode, depth).filter(
      (tool) => tool === WRITE_DOC_TOOL_NAME || tool === DELEGATION_TOOL_NAME,
    ),
  );
}
