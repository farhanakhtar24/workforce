/**
 * Public API of the Phase 4 delegation domain: `@workforce/core/delegation`.
 *
 * Pure domain only (zod + the agent depth constants): no HTTP, no BullMQ, no
 * Prisma side effects — the API agent owns transports. The Prisma adapter is
 * exported ONLY from `@workforce/core/delegation/postgres` so importing this
 * module never loads Prisma.
 *
 * Depth helpers (`allowsDelegation`, `childDepth`, `MAX_DELEGATION_DEPTH`,
 * `ROOT_AGENT_DEPTH`) are re-exported here so delegation consumers use the
 * same agent-cap constants instead of redefining caps.
 */

export {
  canTransitionDelegation,
  delegationTerminalStatuses,
  delegationTransitions,
  delegationModes,
  delegationStatuses,
  delegationTargetAgents,
  isDelegationMode,
  isDelegationStatus,
  isDelegationTargetAgent,
  type DelegationMode,
  type DelegationStatus,
  type DelegationTargetAgent,
} from './kinds.js';

export {
  DelegationError,
  DelegationValidationError,
  DelegationNotFoundError,
  DelegationConflictError,
  type DelegationErrorCode,
} from './errors.js';

export type { Delegation } from './types.js';

export {
  DELEGATION_LIST_LIMIT_DEFAULT,
  DELEGATION_LIST_LIMIT_MAX,
  DELEGATION_MAX_ERROR_LENGTH,
  DELEGATION_MAX_EXTERNAL_ID_LENGTH,
  DELEGATION_MAX_RESULT_LENGTH,
  DELEGATION_MAX_TASK_LENGTH,
  createDelegationInputSchema,
  delegationDepthSchema,
  delegationErrorSchema,
  delegationExternalIdSchema,
  delegationIdSchema,
  delegationModeSchema,
  delegationResultSchema,
  delegationStatusSchema,
  delegationTargetAgentSchema,
  delegationTaskSchema,
  listDelegationsByParentInputSchema,
  parseDelegationInput,
  updateDelegationStatusInputSchema,
  type DelegationCreateInput,
  type DelegationListByParentInput,
  type DelegationUpdateStatusInput,
  type ParsedDelegationCreateInput,
  type ParsedDelegationListByParentInput,
  type ParsedDelegationUpdateStatusInput,
} from './schemas.js';

export type {
  DelegationRepository,
} from './repository.js';

export { InMemoryDelegationRepository } from './stores/in-memory-delegation-repository.js';

// Agent-cap depth helpers, re-exported for delegation consumers.
export {
  ROOT_AGENT_DEPTH,
  MAX_DELEGATION_DEPTH,
  DELEGATION_TOOL_NAME,
  WRITE_DOC_TOOL_NAME,
  allowsDelegation,
  childDepth,
} from '../agents/types.js';
