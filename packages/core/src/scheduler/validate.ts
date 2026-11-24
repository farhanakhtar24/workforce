/**
 * Shared store-level validation for the scheduler domain (defense in depth).
 *
 * BOTH store implementations (`stores/in-memory-scheduler-store.js` and
 * `postgres/index.js`) call these helpers, so the two stores cannot drift:
 * identical bounds, identical CAS rules, identical nextRunAt resolution, and
 * identical ordering. The service parses raw JSON first (schemas.ts); these
 * helpers re-check the mapped payloads so every store stands alone.
 */

import { z } from 'zod';

import { normalizeScope } from '../memory/paths.js';
import { memoryScopeSchema } from '../memory/schemas.js';
import type { AgentMode, AgentSlug } from '../agents/types.js';
import { agentModes, agentSlugs } from '../agents/types.js';
import {
  SCHEDULER_LIST_LIMIT_DEFAULT,
  SCHEDULER_LIST_LIMIT_MAX,
  type AgentTaskExecutionStatus,
  type RecurrenceType,
} from './kinds.js';
import {
  agentModeSchema,
  agentSlugSchema,
  agentTaskExecutionTokenUsageSchema,
  agentTaskNameSchema,
  agentTaskPromptSchema,
  parseSchedulerInput,
  schedulerIdSchema,
  schedulerOwnerIdSchema,
  skipDatesSchema,
  skipDateSchema,
  assertRecurrencePair,
} from './schemas.js';
import {
  computeNextRunAt,
  isRealUtcCalendarDate,
  validateCronExpression,
} from './recurrence.js';
import {
  SchedulerConflictError,
  SchedulerNotFoundError,
  SchedulerValidationError,
} from './errors.js';
import {
  schedulerMarkTargets,
  type SchedulerMarkTarget,
  type SchedulerReadOptions,
  type SchedulerStoreExecutionClaim,
  type SchedulerStoreExecutionCreate,
  type SchedulerStoreExecutionMark,
  type SchedulerStoreExecutionListParams,
  type SchedulerStoreTaskCreate,
  type SchedulerStoreTaskListParams,
  type SchedulerStoreTaskUpdate,
} from './store.js';
import type {
  AgentTask,
  AgentTaskExecution,
  AgentTaskExecutionTokenUsage,
} from './types.js';

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

/** Parse an instant that must exist (ISO `Z` string or Date). */
export function toInstant(value: string | Date, label: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime()) || Array.isArray(value)) {
    throw new SchedulerValidationError(`${label} must be a valid UTC instant`);
  }
  return parsed;
}

/** Parse an optional instant; `null`/`undefined` stay that way. */
export function toOptionalInstant(value: string | Date | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return toInstant(value, 'instant');
}

// ---------------------------------------------------------------------------
// Ownership (platform-user owner ids)
// ---------------------------------------------------------------------------

/** Validate an explicit owner-id value (trimmed 1..128 chars) for writes. */
export function validateOwnerId(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return parseSchedulerInput(schedulerOwnerIdSchema, value);
}

/**
 * Validate owner guard options on single-row reads (`getTask`/`getExecution`).
 * The guard matches EXACTLY: ownerless legacy rows never satisfy an owner.
 */
export function validateReadOptions(options?: SchedulerReadOptions): { expectedOwnerId: string | null } {
  return { expectedOwnerId: validateOwnerId(options?.expectedOwnerId) };
}

/**
 * Enforce the owner guard on a mapped row: a mismatch MUST read as not-found
 * (the caller never learns that a foreign/ownerless row exists). Used by BOTH
 * stores so the two adapters cannot drift.
 */
export function enforceRowOwner(
  row: { readonly ownerId: string | null },
  expectedOwnerId: string | null,
): void {
  if (expectedOwnerId !== null && (row.ownerId ?? null) !== expectedOwnerId) {
    throw new SchedulerNotFoundError('row not found for owner');
  }
}

// ---------------------------------------------------------------------------
// Ordering + limits
// ---------------------------------------------------------------------------

export function compareByCreatedAtThenId(
  order: 'newest' | 'oldest',
): (a: { id: string; createdAt: string }, b: { id: string; createdAt: string }) => number {
  return (a, b) => {
    const aMs = Date.parse(a.createdAt);
    const bMs = Date.parse(b.createdAt);
    if (aMs !== bMs) {
      return order === 'newest' ? bMs - aMs : aMs - bMs;
    }
    if (a.id === b.id) {
      return 0;
    }
    return order === 'newest' ? (a.id > b.id ? -1 : 1) : a.id < b.id ? -1 : 1;
  };
}

export function validateListParams(params?: {
  order?: 'newest' | 'oldest';
  limit?: number;
  ownerId?: string | null;
  ownedOnly?: boolean;
  isActive?: boolean;
}): {
  order: 'newest' | 'oldest';
  limit: number;
  ownerId: string | null;
  ownedOnly: boolean;
  isActive: boolean | null;
} {
  const order = params?.order ?? 'newest';
  if (order !== 'newest' && order !== 'oldest') {
    throw new SchedulerValidationError('order must be newest or oldest');
  }
  const rawLimit = params?.limit ?? SCHEDULER_LIST_LIMIT_DEFAULT;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > SCHEDULER_LIST_LIMIT_MAX) {
    throw new SchedulerValidationError(`limit must be an integer 1..${SCHEDULER_LIST_LIMIT_MAX}`);
  }
  const ownerId = validateOwnerId(params?.ownerId);
  const ownedOnly = params?.ownedOnly;
  if (ownedOnly !== undefined && typeof ownedOnly !== 'boolean') {
    throw new SchedulerValidationError('ownedOnly must be a boolean');
  }
  const isActive = params?.isActive;
  if (isActive !== undefined && typeof isActive !== 'boolean') {
    throw new SchedulerValidationError('isActive must be a boolean');
  }
  return {
    order,
    limit: rawLimit,
    ownerId,
    ownedOnly: ownedOnly ?? false,
    isActive: isActive === undefined ? null : isActive,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface ValidatedTaskCreate {
  readonly id?: string;
  readonly name: string;
  readonly agentSlug: AgentSlug;
  readonly mode: AgentMode;
  readonly prompt: string;
  readonly scope: string;
  readonly recurrenceType: RecurrenceType;
  readonly recurrenceConfig: AgentTask['recurrenceConfig'];
  readonly skipDates: readonly string[];
  readonly ownerId: string | null;
  readonly createdAt: Date;
  readonly after: Date;
  readonly nextRunAt: Date | null;
}

export function validateStoreTaskCreate(data: SchedulerStoreTaskCreate): ValidatedTaskCreate {
  if (!data || typeof data !== 'object') {
    throw new SchedulerValidationError('task create payload must be an object');
  }
  const id = data.id === undefined ? undefined : parseSchedulerInput(schedulerIdSchema, data.id);
  const name = parseSchedulerInput(agentTaskNameSchema, data.name);
  const agentSlug = parseSchedulerInput(agentSlugSchema, data.agentSlug);
  if (!(agentSlugs as readonly string[]).includes(agentSlug)) {
    throw new SchedulerValidationError('agentSlug must be one of general, orchestrator, analyst, researcher');
  }
  const mode = parseSchedulerInput(agentModeSchema, data.mode);
  if (!(agentModes as readonly string[]).includes(mode)) {
    throw new SchedulerValidationError('mode must be plan or action');
  }
  const prompt = parseSchedulerInput(agentTaskPromptSchema, data.prompt);
  const scope = normalizeScope(parseSchedulerInput(memoryScopeSchema, data.scope ?? 'default'));
  const ownerId = validateOwnerId(data.ownerId);
  if (!isRecurrenceTypeValue(data.recurrenceType)) {
    throw new SchedulerValidationError('recurrenceType must be ONCE, DAILY, WEEKLY, MONTHLY, or CUSTOM_CRON');
  }
  const recurrenceType = data.recurrenceType;
  const recurrenceConfig = validateRecurrenceConfig(recurrenceType, data.recurrenceConfig);
  const skipDates = parseSchedulerInput(skipDatesSchema, data.skipDates ?? []);
  const nowDate = toInstant(data.now ?? new Date(), 'now');
  const createdAt = nowDate;
  const after = toInstant(data.afterAsOf ?? nowDate, 'afterAsOf');
  const nextRunAt = computeNextRunAt({ recurrenceType, recurrenceConfig, after, skipDates });
  return { id, name, agentSlug, mode, prompt, scope, recurrenceType, recurrenceConfig, skipDates, ownerId, createdAt, after, nextRunAt };
}

function isRecurrenceTypeValue(value: unknown): value is RecurrenceType {
  return value === 'ONCE' || value === 'DAILY' || value === 'WEEKLY' || value === 'MONTHLY' || value === 'CUSTOM_CRON';
}

function isAgentModeValue(value: unknown): value is AgentMode {
  return value === 'plan' || value === 'action';
}

function isAgentSlugValue(value: unknown): value is AgentSlug {
  return (
    value === 'general' || value === 'orchestrator' || value === 'analyst' || value === 'researcher'
  );
}

/** Pair rule + cron validity in ONE call (used by create and update). */
export function validateRecurrenceConfig(
  recurrenceType: RecurrenceType,
  recurrenceConfig: unknown,
): AgentTask['recurrenceConfig'] {
  assertRecurrencePair(recurrenceType, recurrenceConfig);
  if (recurrenceType === 'CUSTOM_CRON') {
    const expression = (recurrenceConfig as { expression: unknown }).expression;
    if (typeof expression !== 'string') {
      throw new SchedulerValidationError('cron expression must be a string');
    }
    validateCronExpression(expression);
  }
  return recurrenceConfig as AgentTask['recurrenceConfig'];
}

export interface ValidatedTaskUpdate {
  readonly id: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly agentSlug?: AgentSlug;
  readonly mode?: AgentMode;
  readonly scope?: string;
  readonly recurrenceType?: RecurrenceType;
  readonly recurrenceConfig?: AgentTask['recurrenceConfig'];
  readonly skipDates?: readonly string[];
  /** Set when the patch carries an explicit nextRunAt (clears when null). */
  readonly nextRunAt: Date | null | undefined;
  readonly skipSet: boolean;
  readonly hasRecurrenceChange: boolean;
  readonly after: Date;
  readonly now: Date;
  /** Owner guard; `null` when unset (never a mutable field). */
  readonly expectedOwnerId: string | null;
}

export function validateStoreTaskUpdate(data: SchedulerStoreTaskUpdate): ValidatedTaskUpdate {
  if (!data || typeof data !== 'object') {
    throw new SchedulerValidationError('task update payload must be an object');
  }
  const id = parseSchedulerInput(schedulerIdSchema, data.id);
  const name = data.name === undefined ? undefined : parseSchedulerInput(agentTaskNameSchema, data.name);
  const prompt = data.prompt === undefined ? undefined : parseSchedulerInput(agentTaskPromptSchema, data.prompt);
  let agentSlug: AgentSlug | undefined;
  if (data.agentSlug !== undefined) {
    agentSlug = parseSchedulerInput(agentSlugSchema, data.agentSlug);
    if (!isAgentSlugValue(agentSlug)) {
      throw new SchedulerValidationError('agentSlug must be one of general, orchestrator, analyst, researcher');
    }
  }
  let mode: AgentMode | undefined;
  if (data.mode !== undefined) {
    mode = parseSchedulerInput(agentModeSchema, data.mode);
    if (!isAgentModeValue(mode)) {
      throw new SchedulerValidationError('mode must be plan or action');
    }
  }
  const scope =
    data.scope === undefined
      ? undefined
      : normalizeScope(parseSchedulerInput(memoryScopeSchema, data.scope));
  const hasRecurrenceType = data.recurrenceType !== undefined;
  const hasRecurrenceConfig = data.recurrenceConfig !== undefined;
  if (hasRecurrenceType !== hasRecurrenceConfig) {
    throw new SchedulerValidationError('recurrenceType and recurrenceConfig must be provided together');
  }
  let recurrenceType: RecurrenceType | undefined;
  let recurrenceConfig: AgentTask['recurrenceConfig'] | undefined;
  if (hasRecurrenceType) {
    if (!isRecurrenceTypeValue(data.recurrenceType)) {
      throw new SchedulerValidationError('recurrenceType must be ONCE, DAILY, WEEKLY, MONTHLY, or CUSTOM_CRON');
    }
    recurrenceType = data.recurrenceType;
    recurrenceConfig = validateRecurrenceConfig(recurrenceType, data.recurrenceConfig);
  }
  const skipSet = data.skipDates !== undefined;
  const skipDates = skipSet ? parseSchedulerInput(skipDatesSchema, data.skipDates) : undefined;
  const nextRunAt = data.nextRunAt === undefined ? undefined : toOptionalInstant(data.nextRunAt);
  const nowDate = toInstant(data.now ?? new Date(), 'now');
  const after = toInstant(data.afterAsOf ?? nowDate, 'afterAsOf');
  return {
    id,
    name,
    prompt,
    agentSlug,
    mode,
    scope,
    recurrenceType,
    recurrenceConfig,
    skipDates,
    nextRunAt,
    skipSet,
    hasRecurrenceChange: hasRecurrenceType || skipSet,
    after,
    now: nowDate,
    expectedOwnerId: validateOwnerId(data.expectedOwnerId),
  };
}

/**
 * The shared nextRunAt resolution rule for updates (contract in
 * `../store.js`): recurrence changes recompute (after = the supplied
 * `afterAsOf` instant or the store clock); explicit `nextRunAt` applies only
 * when no recurrence field changes.
 */
export function resolveNextRunAtForUpdate(
  existing: AgentTask,
  patch: ValidatedTaskUpdate,
): Date | null {
  const hasRecurrence = patch.recurrenceType !== undefined || patch.skipSet;
  if (hasRecurrence) {
    const recurrenceType = patch.recurrenceType ?? existing.recurrenceType;
    const recurrenceConfig = patch.recurrenceConfig ?? existing.recurrenceConfig;
    const skipDates = patch.skipDates ?? existing.skipDates;
    return computeNextRunAt({ recurrenceType, recurrenceConfig, after: patch.after, skipDates });
  }
  if (patch.nextRunAt !== undefined) {
    return patch.nextRunAt;
  }
  return existing.nextRunAt === null ? null : new Date(existing.nextRunAt);
}

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------

export interface ValidatedExecutionCreate {
  readonly id?: string;
  readonly scheduledFor: Date;
  readonly trigger: AgentTaskExecutionCreateTrigger;
  readonly queueJobId?: string;
  readonly repeatJobKey?: string;
  readonly retryOfExecutionId?: string;
  /** Explicit owner; stores inherit the task's owner when `null`. */
  readonly ownerId: string | null;
  readonly now: Date;
}

type AgentTaskExecutionCreateTrigger = 'SCHEDULED' | 'MANUAL' | 'RETRY';

const queueIdSchema = z
  .string()
  .trim()
  .min(1, 'queue id must not be empty')
  .max(128, 'queue id must be at most 128 characters');

export function validateStoreExecutionCreate(
  data: SchedulerStoreExecutionCreate,
): ValidatedExecutionCreate {
  if (!data || typeof data !== 'object') {
    throw new SchedulerValidationError('execution create payload must be an object');
  }
  const id = data.id === undefined ? undefined : parseSchedulerInput(schedulerIdSchema, data.id);
  const scheduledFor = toInstant(data.scheduledFor, 'scheduledFor');
  if (
    data.trigger !== 'SCHEDULED' &&
    data.trigger !== 'MANUAL' &&
    data.trigger !== 'RETRY'
  ) {
    throw new SchedulerValidationError('trigger must be SCHEDULED, MANUAL, or RETRY');
  }
  const trigger: AgentTaskExecutionCreateTrigger = data.trigger;
  const orUndefined = <T,>(value: T | null | undefined): T | undefined =>
    value === undefined || value === null ? undefined : value;
  const queueJobId = orUndefined(data.queueJobId) === undefined ? undefined : parseSchedulerInput(queueIdSchema, orUndefined(data.queueJobId));
  const repeatJobKey = orUndefined(data.repeatJobKey) === undefined ? undefined : parseSchedulerInput(queueIdSchema, orUndefined(data.repeatJobKey));
  const retryOfExecutionId = orUndefined(data.retryOfExecutionId) === undefined
    ? undefined
    : parseSchedulerInput(schedulerIdSchema, orUndefined(data.retryOfExecutionId));
  if (trigger === 'RETRY' && retryOfExecutionId === undefined) {
    throw new SchedulerValidationError('RETRY executions require retryOfExecutionId');
  }
  if (trigger !== 'RETRY' && retryOfExecutionId !== undefined) {
    throw new SchedulerValidationError('retryOfExecutionId is only allowed on RETRY executions');
  }
  const ownerId = validateOwnerId(data.ownerId);
  return {
    id,
    scheduledFor,
    trigger,
    queueJobId,
    repeatJobKey,
    retryOfExecutionId,
    ownerId,
    now: toInstant(data.now ?? new Date(), 'now'),
  };
}

export interface ValidatedClaim {
  readonly id: string;
  readonly attempt: number;
  readonly allowedFrom: 'PENDING' | 'RETRYING';
  /** Owner guard; `null` when unset. */
  readonly expectedOwnerId: string | null;
}

export function validateStoreClaim(data: SchedulerStoreExecutionClaim): ValidatedClaim {
  if (!data || typeof data !== 'object') {
    throw new SchedulerValidationError('claim payload must be an object');
  }
  const id = parseSchedulerInput(schedulerIdSchema, data.id);
  if (!Number.isInteger(data.attempt) || data.attempt < 1 || data.attempt > 3) {
    throw new SchedulerValidationError('attempt must be an integer 1..3');
  }
  if (data.allowedFrom !== 'PENDING' && data.allowedFrom !== 'RETRYING') {
    throw new SchedulerValidationError("allowedFrom must be 'PENDING' or 'RETRYING'");
  }
  return { id, attempt: data.attempt, allowedFrom: data.allowedFrom, expectedOwnerId: validateOwnerId(data.expectedOwnerId) };
}

/** CAS matrix for the five mark targets: `expectedFrom` is FIXED per target. */
export function expectedFromForMark(target: SchedulerMarkTarget): AgentTaskExecutionStatus {
  switch (target) {
    case 'SKIPPED':
      return 'PENDING';
    default:
      // RETRYING | COMPLETED | FAILED | DEAD_LETTER all expect RUNNING.
      return 'RUNNING';
  }
}

export function canMarkExecution(
  from: AgentTaskExecutionStatus,
  target: SchedulerMarkTarget,
): boolean {
  if (from === target) {
    // Handled by the payload-equivalence rule in the stores, not here.
    return false;
  }
  if (from === 'PENDING') {
    return target === 'SKIPPED';
  }
  if (from === 'RUNNING') {
    return target === 'RETRYING' || target === 'COMPLETED' || target === 'FAILED' || target === 'DEAD_LETTER';
  }
  return false;
}

export interface ValidatedMark {
  readonly id: string;
  readonly target: SchedulerMarkTarget;
  readonly durationMs: number | null;
  readonly tokenUsage: AgentTaskExecutionTokenUsage | null;
  readonly error: string | null;
  readonly now: Date;
  /** Owner guard; `null` when unset. */
  readonly expectedOwnerId: string | null;
}

const errorTextSchema = z
  .string()
  .trim()
  .min(1, 'error must not be empty')
  .max(1000, 'error must be at most 1000 characters');

export function validateStoreExecutionMark(data: SchedulerStoreExecutionMark): ValidatedMark {
  if (!data || typeof data !== 'object') {
    throw new SchedulerValidationError('mark payload must be an object');
  }
  const id = parseSchedulerInput(schedulerIdSchema, data.id);
  if (!schedulerMarkTargets.includes(data.target as SchedulerMarkTarget)) {
    throw new SchedulerValidationError('mark target must be RETRYING, COMPLETED, FAILED, DEAD_LETTER, or SKIPPED');
  }
  const target: SchedulerMarkTarget = data.target;
  let durationMs: number | null = null;
  if (data.durationMs !== undefined && data.durationMs !== null) {
    if (!Number.isInteger(data.durationMs) || data.durationMs < 0 || data.durationMs > 2147483647) {
      throw new SchedulerValidationError('durationMs must be an integer 0..2147483647');
    }
    durationMs = data.durationMs;
  }
  let tokenUsage: AgentTaskExecutionTokenUsage | null = null;
  if (data.tokenUsage !== undefined && data.tokenUsage !== null) {
    tokenUsage = parseSchedulerInput(agentTaskExecutionTokenUsageSchema, data.tokenUsage);
  }
  let error: string | null = null;
  if (data.error !== undefined && data.error !== null) {
    error = parseSchedulerInput(errorTextSchema, data.error);
  }
  if (target === 'COMPLETED' && data.durationMs === undefined) {
    throw new SchedulerValidationError('marking COMPLETED requires durationMs');
  }
  if (target !== 'COMPLETED' && data.durationMs !== undefined && data.durationMs !== null) {
    throw new SchedulerValidationError('durationMs is only allowed when marking COMPLETED');
  }
  if ((target === 'FAILED' || target === 'DEAD_LETTER') && data.error === undefined) {
    throw new SchedulerValidationError(`marking ${target} requires error`);
  }
  if (target !== 'FAILED' && target !== 'DEAD_LETTER' && data.error !== undefined && data.error !== null) {
    throw new SchedulerValidationError('error is only allowed when marking FAILED or DEAD_LETTER');
  }
  if (target === 'RETRYING' && tokenUsage !== null) {
    throw new SchedulerValidationError('tokenUsage is only allowed when marking COMPLETED');
  }
  if (target === 'SKIPPED' && tokenUsage !== null) {
    throw new SchedulerValidationError('tokenUsage is only allowed when marking COMPLETED');
  }
  return {
    id,
    target,
    durationMs,
    tokenUsage,
    error,
    now: toInstant(data.now ?? new Date(), 'now'),
    expectedOwnerId: validateOwnerId(data.expectedOwnerId),
  };
}

/**
 * Payload equivalence for idempotent same-outcome terminal repeats:
 * COMPLETED compares durationMs + tokenUsage (canonicalized), FAILED and
 * DEAD_LETTER compare error text.
 */
export function sameMarkPayload(row: AgentTaskExecution, mark: ValidatedMark): boolean {
  const tokenUsageEqual = sameTokenUsage(row.tokenUsage, mark.tokenUsage);
  const durationEqual = (row.durationMs ?? null) === (mark.durationMs ?? null);
  const errorEqual = (row.error ?? null) === (mark.error ?? null);
  switch (mark.target) {
    case 'COMPLETED':
      return durationEqual && tokenUsageEqual;
    case 'FAILED':
    case 'DEAD_LETTER':
      return errorEqual;
    default:
      return false;
  }
}

export function sameTokenUsage(
  left: AgentTaskExecutionTokenUsage | null,
  right: AgentTaskExecutionTokenUsage | null,
): boolean {
  const a = { inputTokens: null, outputTokens: null, totalTokens: null, ...(left ?? {}) } as Record<string, number | null>;
  const b = { inputTokens: null, outputTokens: null, totalTokens: null, ...(right ?? {}) } as Record<string, number | null>;
  return (
    (a.inputTokens ?? null) === (b.inputTokens ?? null) &&
    (a.outputTokens ?? null) === (b.outputTokens ?? null) &&
    (a.totalTokens ?? null) === (b.totalTokens ?? null)
  );
}

// ---------------------------------------------------------------------------
// Defensive mapping guards (rows read back from stores/DB)
// ---------------------------------------------------------------------------

export function validateSkipDatesRow(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new SchedulerValidationError('stored skipDates must be an array of YYYY-MM-DD strings');
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !skipDateSchema.safeParse(entry).success || !isRealUtcCalendarDate(entry)) {
      throw new SchedulerValidationError('stored skipDates must be an array of YYYY-MM-DD strings');
    }
  }
  if (value.length > 366) {
    throw new SchedulerValidationError('stored skipDates must hold at most 366 entries');
  }
  return value;
}

export function assertExecutionRowShape(row: AgentTaskExecution): AgentTaskExecution {
  if (row.chatId !== row.id) {
    throw new SchedulerValidationError('execution chatId must always equal the execution id');
  }
  return row;
}

export function notFound<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new SchedulerNotFoundError(message);
  }
  return value;
}

export function assertCondition(condition: unknown, message: string): void {
  if (!condition) {
    throw new SchedulerConflictError(message);
  }
}
