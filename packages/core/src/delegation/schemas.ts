/**
 * Zod schemas for delegation inputs. These are the authoritative input
 * contracts; repositories re-validate with them, so raw JSON and pre-parsed
 * objects are both safe to pass.
 *
 * Normalizing behavior (zod 4 executes chained checks in order):
 * - `scope`: memory-domain scope rules, optional, defaults to `"default"`.
 * - `parentChatId` / `childChatId` / `parentMessageId`: trimmed, 1..128 chars.
 * - `task`: trimmed, 1..10000 characters.
 * - `result`: trimmed, 1..100000 characters when supplied.
 * - `error`: trimmed, 1..1000 characters when supplied. Hosts pass SAFE,
 *   classified error text (never raw provider messages/bodies).
 * - `depth`: integer 1..{@link MAX_DELEGATION_DEPTH} (the CHILD's depth).
 * - `status`: one of pending|running|completed|failed|timeout.
 */

import { z } from 'zod';

import { memoryScopeSchema } from '../memory/schemas.js';
import { MAX_DELEGATION_DEPTH } from '../agents/types.js';
import { delegationModes, delegationStatuses, delegationTargetAgents } from './kinds.js';
import { DelegationValidationError } from './errors.js';

export const DELEGATION_MAX_TASK_LENGTH = 10000 as const;
export const DELEGATION_MAX_RESULT_LENGTH = 100000 as const;
export const DELEGATION_MAX_ERROR_LENGTH = 1000 as const;
export const DELEGATION_MAX_EXTERNAL_ID_LENGTH = 128 as const;
export const DELEGATION_LIST_LIMIT_MAX = 100 as const;
export const DELEGATION_LIST_LIMIT_DEFAULT = 20 as const;

export const delegationIdSchema = z.uuid();

export const delegationExternalIdSchema = z
  .string()
  .trim()
  .min(1, 'external id must not be empty')
  .max(
    DELEGATION_MAX_EXTERNAL_ID_LENGTH,
    `external id must be at most ${DELEGATION_MAX_EXTERNAL_ID_LENGTH} characters`,
  );

export const delegationTargetAgentSchema = z.enum(delegationTargetAgents);

export const delegationModeSchema = z.enum(delegationModes);

export const delegationStatusSchema = z.enum(delegationStatuses);

export const delegationTaskSchema = z
  .string()
  .trim()
  .min(1, 'task must not be empty')
  .max(DELEGATION_MAX_TASK_LENGTH, `task must be at most ${DELEGATION_MAX_TASK_LENGTH} characters`);

export const delegationResultSchema = z
  .string()
  .trim()
  .min(1, 'result must not be empty when supplied')
  .max(DELEGATION_MAX_RESULT_LENGTH, `result must be at most ${DELEGATION_MAX_RESULT_LENGTH} characters`);

export const delegationErrorSchema = z
  .string()
  .trim()
  .min(1, 'error must not be empty when supplied')
  .max(DELEGATION_MAX_ERROR_LENGTH, `error must be at most ${DELEGATION_MAX_ERROR_LENGTH} characters`);

/**
 * Platform-user owner id (Better Auth `User.id`, TEXT — NOT a UUID): trimmed,
 * 1..128 characters. Legacy ownerless rows carry `null`; owner filters match
 * EXACTLY (an expected owner never matches ownerless rows).
 */
export const delegationOwnerIdSchema = delegationExternalIdSchema;

/** The CHILD agent's depth: 1 for a root's delegation, 2 for a child's. */
export const delegationDepthSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_DELEGATION_DEPTH);

// ---------------------------------------------------------------------------
// Repository input schemas
// ---------------------------------------------------------------------------

export const createDelegationInputSchema = z.strictObject({
  id: delegationIdSchema.optional(),
  scope: memoryScopeSchema.optional().default('default'),
  parentChatId: delegationExternalIdSchema,
  childChatId: delegationExternalIdSchema,
  parentMessageId: delegationExternalIdSchema,
  targetAgent: delegationTargetAgentSchema,
  mode: delegationModeSchema,
  task: delegationTaskSchema,
  depth: delegationDepthSchema,
  /**
   * Optional platform-user owner id (legacy callers omit it; the row is then
   * ownerless). The authenticated API layer MUST always pass the acting user.
   */
  ownerId: delegationOwnerIdSchema.optional(),
  /**
   * Optional creation timestamp override (ISO string or Date) for
   * deterministic tests; defaults to the repository clock. Must be a valid
   * date when supplied.
   */
  createdAt: z.union([z.iso.datetime(), z.date()]).optional(),
});

export const listDelegationsByParentInputSchema = z.strictObject({
  parentChatId: delegationExternalIdSchema,
  /**
   * Owner filter: EXACT match only. When set, ownerless legacy rows and other
   * users' rows are never returned (prevents unbounded global reads).
   */
  ownerId: delegationOwnerIdSchema.optional(),
  order: z.enum(['oldest', 'newest']).optional().default('newest'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(DELEGATION_LIST_LIMIT_MAX)
    .optional()
    .default(DELEGATION_LIST_LIMIT_DEFAULT),
});

export const updateDelegationStatusInputSchema = z.strictObject({
  id: delegationIdSchema,
  status: delegationStatusSchema,
  result: delegationResultSchema.optional(),
  error: delegationErrorSchema.optional(),
  /**
   * Atomic CLAIM guard: when set, the write applies ONLY if the current
   * status equals `expectedFrom`; a mismatch is a typed
   * {@link DelegationConflictError} (409) before any transition logic runs.
   * Used for the pending → running hand-off so exactly ONE runner of many
   * concurrent candidates can claim a delegation.
   */
  expectedFrom: delegationStatusSchema.optional(),
  /**
   * Owner guard: when set, the delegation must belong EXACTLY to this user
   * (ownerless legacy rows never match) — a mismatch reads as 404 BEFORE the
   * claim/transition logic, so a wrong owner is never a status oracle.
   */
  expectedOwnerId: delegationOwnerIdSchema.optional(),
});

/**
 * Read options for `get`/`getByChild`: the owner guard reads a foreign or
 * ownerless delegation as absent (`null`) — never an existence oracle.
 */
export const delegationReadOptionsSchema = z.strictObject({
  expectedOwnerId: delegationOwnerIdSchema.optional(),
});

// ---------------------------------------------------------------------------
// Parsed (post-normalization) input types
// ---------------------------------------------------------------------------

export type DelegationCreateInput = z.input<typeof createDelegationInputSchema>;
export type DelegationListByParentInput = z.input<typeof listDelegationsByParentInputSchema>;
export type DelegationUpdateStatusInput = z.input<typeof updateDelegationStatusInputSchema>;
export type DelegationReadOptions = z.input<typeof delegationReadOptionsSchema>;

// Output (parsed) shapes with defaults applied.
export type ParsedDelegationCreateInput = z.output<typeof createDelegationInputSchema>;
export type ParsedDelegationListByParentInput = z.output<typeof listDelegationsByParentInputSchema>;
export type ParsedDelegationUpdateStatusInput = z.output<typeof updateDelegationStatusInputSchema>;
export type ParsedDelegationReadOptions = z.output<typeof delegationReadOptionsSchema>;

/**
 * Parse repository input against `schema`, converting Zod errors into the
 * typed {@link DelegationValidationError} routes can map to 400. Issue
 * messages never echo submitted values.
 */
export function parseDelegationInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new DelegationValidationError(`invalid delegation input (${issues.join('; ')})`, { issues });
  }
  return result.data;
}
