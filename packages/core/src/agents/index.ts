/**
 * Public API of the agent composition domain: `@workforce/core/agents`.
 *
 * Pure module (zod only, no Prisma side effects), safe for the CLI. The
 * registry is supply-side; transport/queue wiring lives in the host apps.
 */

export {
  ROOT_AGENT_DEPTH,
  MAX_DELEGATION_DEPTH,
  DELEGATION_TOOL_NAME,
  WRITE_DOC_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  agentSlugs,
  agentModes,
  agentToolNames,
  agentApprovalPolicies,
  isAgentToolName,
  allowsDelegation,
  childDepth,
  type AgentSlug,
  type AgentMode,
  type AgentToolName,
  type AgentApprovalPolicy,
} from './types.js';

export { AgentError, AgentCompositionError, type AgentErrorCode } from './errors.js';

export {
  defineCapability,
  isExecutableCapability,
  type Capability,
  type CapabilityExecutor,
  type CapabilityDescriptor,
  type CapabilityMetadata,
  type ExecutableCapability,
  type AskUserCapability,
  type AskUserCapabilityDescriptor,
} from './capability.js';

export { calculateCapability, calculateOutputSchema, type CalculateCapabilityResult } from './calculate-capability.js';

export {
  agentDefinitions,
  definitionModes,
  type AgentDefinition,
} from './definitions.js';

export {
  composeAgentCapabilities,
  composeAllowedToolNames,
  composeWritePotential,
  MapAgentRegistry,
  builtinAgentRegistry,
  type AgentRegistry,
  type ComposeAgentInput,
  type ComposedAgent,
} from './compose.js';
