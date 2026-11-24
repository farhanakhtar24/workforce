/**
 * Prisma/Postgres store for the scheduler domain. Exported ONLY from the
 * `@workforce/core/scheduler/postgres` subpath: importing this module loads
 * the generated Prisma client, so consumers that don't need Postgres (the
 * CLI, pure domain tests) must use `@workforce/core` or
 * `@workforce/core/scheduler` instead.
 *
 * ## Prisma usage
 * The caller constructs the PrismaClient (from `@workforce/core/generated/prisma`
 * or `@prisma/client` configured to the same generated output) and hands it to
 * {@link PrismaSchedulerStore}. All access is the typed Prisma model API; the
 * only raw SQL is a handful of parameterized row-lock probes:
 *
 * - `updateTask`/`setTaskActive` lock the AgentTask row FIRST
 *   (`SELECT ... FOR UPDATE`) then re-read, so concurrent task writers
 *   serialize and the nextRunAt recompute inside the lock is linearizable.
 * - `createExecution` locks the task row (existence check + typed 404), which
 *   ALSO serializes the duplicate-SCHEDULED dedupe per task; RETRY executions
 *   additionally lock+verify the source row (DEAD_LETTER, same task).
 * - `claimExecution`/`markExecution` lock the execution row first, then apply
 *   the compare-and-set rules shared with the in-memory store (`../validate.js`):
 *   exactly one concurrent winner, every loser gets a typed conflict.
 * - P2002 unique violations map to typed conflicts; a lost SCHEDULED dedupe
 *   race re-reads the existing row (fresh connection, OUTSIDE the aborted
 *   transaction) and returns `{ created: false }` — no second row.
 *
 * ## Typed errors
 * Missing task/execution -> SchedulerNotFoundError (404); CAS mismatch, stale
 * claim, duplicate queue identity, non-equivalent terminal repeat ->
 * SchedulerConflictError (409); malformed input -> SchedulerValidationError
 * (400). No raw Prisma errors escape with content: they attach as `cause`
 * only. A raced P2025 (row deleted between the locked re-read and the write)
 * maps to the SAME 404 the in-memory store produces for a missing row.
 *
 * ## Ownership
 * `ownerId` is the platform user (Better Auth `User.id`, TEXT) or null for
 * legacy rows; executions inherit the owning task's owner unless an explicit
 * owner is supplied (resolved against the authoritative task ROW, never the
 * caller's argument). Owner guards/filters match EXACTLY — an expected owner
 * never matches ownerless or other-user rows — and mismatches read as
 * 404/null: no cross-tenant oracle. `ownedOnly: true` on listTasks selects
 * ONLY rows with `ownerId != null` (startup reconciliation excludes legacy
 * ownerless tasks). The authenticated API layer MUST always pass the owner;
 * CAS claim/mark semantics are untouched (the owner guard runs BEFORE the
 * CAS).
 */

import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@workforce/core/generated/prisma';

import { MAX_TASK_ATTEMPTS, AGENT_TASK_TIMEZONE } from '../kinds.js';
import {
  assertCondition,
  enforceRowOwner,
  resolveNextRunAtForUpdate,
  sameMarkPayload,
  validateListParams,
  validateReadOptions,
  validateStoreClaim,
  validateStoreExecutionCreate,
  validateStoreExecutionMark,
  validateStoreTaskCreate,
  validateStoreTaskUpdate,
  validateSkipDatesRow,
} from '../validate.js';
import {
  agentTaskExecutionStatusSchema,
  agentTaskTriggerSchema,
  agentTaskExecutionTokenUsageSchema,
  parseSchedulerInput,
  recurrenceConfigSchema,
  recurrenceTypeSchema,
  schedulerIdSchema,
} from '../schemas.js';
import {
  SchedulerConflictError,
  SchedulerNotFoundError,
  SchedulerValidationError,
} from '../errors.js';
import type {
  SchedulerStore,
  SchedulerStoreExecutionClaim,
  SchedulerStoreExecutionCreate,
  SchedulerStoreExecutionCreateResult,
  SchedulerStoreExecutionListParams,
  SchedulerStoreExecutionMark,
  SchedulerStoreTaskCreate,
  SchedulerStoreTaskListParams,
  SchedulerStoreTaskUpdate,
} from '../store.js';
import type { AgentTask, AgentTaskExecution, AgentTaskRecurrenceConfig } from '../types.js';
import type { SchedulerReadOptions } from '../store.js';

type RowTask = Prisma.AgentTaskGetPayload<object>;
type RowExecution = Prisma.AgentTaskExecutionGetPayload<object>;

// ---------------------------------------------------------------------------
// Enum mapping (public SCREAMING_CASE <-> DB lowercase)
// ---------------------------------------------------------------------------

/** DB spellings of the scheduler enums (see the migration SQL). */
type DbRecurrenceType = 'once' | 'daily' | 'weekly' | 'monthly' | 'custom_cron';
type DbTrigger = 'scheduled' | 'manual' | 'retry';
type DbStatus =
  | 'pending'
  | 'running'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'dead_letter'
  | 'skipped';

function recurrenceTypeToDb(value: AgentTask['recurrenceType']): DbRecurrenceType {
  return value.toLowerCase() as DbRecurrenceType;
}

function recurrenceTypeFromDb(value: string): AgentTask['recurrenceType'] {
  const upper = recurrenceTypeSchema.safeParse(value.toUpperCase());
  if (!upper.success) {
    throw new SchedulerValidationError(`stored recurrenceType ${value} is not a known recurrence type`);
  }
  return upper.data;
}

function triggerToDb(value: AgentTaskExecution['trigger']): DbTrigger {
  return value.toLowerCase() as DbTrigger;
}

function triggerFromDb(value: string): AgentTaskExecution['trigger'] {
  const upper = agentTaskTriggerSchema.safeParse(value.toUpperCase());
  if (!upper.success) {
    throw new SchedulerValidationError(`stored trigger ${value} is not a known trigger`);
  }
  return upper.data;
}

function statusToDb(value: AgentTaskExecution['status']): DbStatus {
  return value.toLowerCase() as DbStatus;
}

function statusFromDb(value: string): AgentTaskExecution['status'] {
  const upper = agentTaskExecutionStatusSchema.safeParse(value.toUpperCase());
  if (!upper.success) {
    throw new SchedulerValidationError(`stored status ${value} is not a known execution status`);
  }
  return upper.data;
}

// ---------------------------------------------------------------------------
// JSON mapping + row guards
// ---------------------------------------------------------------------------

/** Re-parse the stored recurrenceConfig JSON against the domain schema. */
function recurrenceConfigFromDb(
  recurrenceType: AgentTask['recurrenceType'],
  value: Prisma.JsonValue,
): AgentTaskRecurrenceConfig {
  const parsed = recurrenceConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new SchedulerValidationError('stored recurrenceConfig does not match the domain schema');
  }
  return parsed.data as AgentTaskRecurrenceConfig;
}

function tokenUsageFromDb(value: Prisma.JsonValue): AgentTaskExecution['tokenUsage'] {
  if (value === null) {
    return null;
  }
  return parseSchedulerInput(agentTaskExecutionTokenUsageSchema, value);
}

function recurrenceConfigToDb(config: AgentTaskRecurrenceConfig): Prisma.InputJsonValue {
  return config as Prisma.InputJsonValue;
}

function skipDatesToDb(skipDates: readonly string[]): Prisma.InputJsonValue {
  return skipDates as unknown as Prisma.InputJsonValue;
}

/** The fixed UTC literal, re-checked on every read. */
function timezoneFromDb(value: string): 'UTC' {
  if (value !== AGENT_TASK_TIMEZONE) {
    throw new SchedulerValidationError('stored timezone must be UTC');
  }
  return AGENT_TASK_TIMEZONE;
}

/** The chatId == id domain invariant, re-checked on every read. */
function chatIdFromDb(row: { id: string; chatId: string }): string {
  if (row.chatId !== row.id) {
    throw new SchedulerValidationError('stored chatId must equal the execution id');
  }
  return row.chatId;
}

function mapTask(row: RowTask): AgentTask {
  const recurrenceType = recurrenceTypeFromDb(row.recurrenceType);
  return {
    id: row.id,
    name: row.name,
    agentSlug: row.agentSlug,
    mode: row.mode,
    prompt: row.prompt,
    scope: row.scope,
    recurrenceType,
    recurrenceConfig: recurrenceConfigFromDb(recurrenceType, row.recurrenceConfig),
    skipDates: validateSkipDatesRow(row.skipDates),
    isActive: row.isActive,
    timezone: timezoneFromDb(row.timezone),
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    // Normalizes absent fields too (fake rows in tests): never `undefined`.
    ownerId: row.ownerId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapExecution(row: RowExecution): AgentTaskExecution {
  return {
    id: row.id,
    taskId: row.taskId,
    retryOfExecutionId: row.retryOfExecutionId,
    scheduledFor: row.scheduledFor.toISOString(),
    trigger: triggerFromDb(row.trigger),
    status: statusFromDb(row.status),
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    durationMs: row.durationMs,
    tokenUsage: tokenUsageFromDb(row.tokenUsage),
    error: row.error,
    chatId: chatIdFromDb(row),
    queueJobId: row.queueJobId,
    repeatJobKey: row.repeatJobKey,
    // Normalizes absent fields too (fake rows in tests): never `undefined`.
    ownerId: row.ownerId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/** Convert a Prisma unique-violation into a typed conflict; rethrow otherwise. */
function asConflictOrOriginal(cause: unknown, message: string): unknown {
  if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
    return new SchedulerConflictError(message, { cause });
  }
  return cause;
}

/**
 * Map a raced P2025 (row vanished between the locked re-read and the write)
 * into the SAME typed 404 the in-memory store produces for a missing row —
 * identical semantics across adapters.
 */
function asNotFoundOrOriginal(cause: unknown, message: string): unknown {
  if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2025') {
    return new SchedulerNotFoundError(message, { cause });
  }
  return cause;
}

/** P2025 first (404), then P2002 (409), then rethrow. */
function asNotFoundOrConflict(cause: unknown, conflictMessage: string, notFoundMessage: string): unknown {
  return asNotFoundOrOriginal(asConflictOrOriginal(cause, conflictMessage), notFoundMessage);
}

export class PrismaSchedulerStore implements SchedulerStore {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    if (!prisma) {
      throw new SchedulerValidationError('PrismaSchedulerStore requires an explicit PrismaClient');
    }
    this.prisma = prisma;
  }

  // -- tasks -----------------------------------------------------------------

  async createTask(data: SchedulerStoreTaskCreate): Promise<AgentTask> {
    const validated = validateStoreTaskCreate(data);
    const id = validated.id ?? undefined;
    try {
      const row = await this.prisma.agentTask.create({
        data: {
          ...(id !== undefined ? { id } : {}),
          name: validated.name,
          agentSlug: validated.agentSlug,
          mode: validated.mode,
          prompt: validated.prompt,
          scope: validated.scope,
          recurrenceType: recurrenceTypeToDb(validated.recurrenceType),
          recurrenceConfig: recurrenceConfigToDb(validated.recurrenceConfig),
          skipDates: skipDatesToDb(validated.skipDates),
          isActive: true,
          timezone: AGENT_TASK_TIMEZONE,
          ownerId: validated.ownerId,
          nextRunAt: validated.nextRunAt,
          createdAt: validated.createdAt,
          updatedAt: validated.createdAt,
        },
      });
      return mapTask(row);
    } catch (cause) {
      throw asConflictOrOriginal(
        cause,
        typeof id === 'string' ? `agent task ${id} already exists` : 'agent task id conflict on create',
      );
    }
  }

  async updateTask(data: SchedulerStoreTaskUpdate): Promise<AgentTask> {
    const validated = validateStoreTaskUpdate(data);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize concurrent same-task writers on the task row.
        await tx.$queryRaw`SELECT "id" FROM "AgentTask" WHERE "id" = ${validated.id}::uuid FOR UPDATE`;
        const row = await tx.agentTask.findUnique({ where: { id: validated.id } });
        if (!row) {
          throw new SchedulerNotFoundError(`agent task ${validated.id} not found`);
        }
        // Owner guard FIRST: a wrong owner reads as 404 (no patch oracle);
        // ownerless legacy tasks never satisfy any expected owner.
        enforceRowOwner(row, validated.expectedOwnerId);
        const existing = mapTask(row);
        const nextRunAt = resolveNextRunAtForUpdate(existing, validated);
        const updated = await tx.agentTask.update({
          where: { id: validated.id },
          data: {
            // `id` is preserved by construction: never patched.
            ...(validated.name !== undefined ? { name: validated.name } : {}),
            ...(validated.prompt !== undefined ? { prompt: validated.prompt } : {}),
            ...(validated.agentSlug !== undefined ? { agentSlug: validated.agentSlug } : {}),
            ...(validated.mode !== undefined ? { mode: validated.mode } : {}),
            ...(validated.scope !== undefined ? { scope: validated.scope } : {}),
            ...(validated.recurrenceType !== undefined
              ? { recurrenceType: recurrenceTypeToDb(validated.recurrenceType) }
              : {}),
            ...(validated.recurrenceConfig !== undefined
              ? { recurrenceConfig: recurrenceConfigToDb(validated.recurrenceConfig) }
              : {}),
            ...(validated.skipDates !== undefined ? { skipDates: skipDatesToDb(validated.skipDates) } : {}),
            nextRunAt,
            updatedAt: validated.now,
          },
        });
        return mapTask(updated);
      });
    } catch (cause) {
      throw asNotFoundOrConflict(
        cause,
        `agent task ${validated.id} concurrent update conflict`,
        `agent task ${validated.id} not found`,
      );
    }
  }

  async getTask(id: string, options?: SchedulerReadOptions): Promise<AgentTask | null> {
    const parsedId = parseSchedulerInput(schedulerIdSchema, id);
    const parsedOptions = validateReadOptions(options);
    const row = await this.prisma.agentTask.findUnique({ where: { id: parsedId } });
    if (!row) {
      return null;
    }
    // Owner guard: foreign/ownerless rows read as absent — never an oracle.
    if (parsedOptions.expectedOwnerId !== null && (row.ownerId ?? null) !== parsedOptions.expectedOwnerId) {
      return null;
    }
    return mapTask(row);
  }

  async listTasks(params?: SchedulerStoreTaskListParams): Promise<readonly AgentTask[]> {
    const validated = validateListParams(params);
    // Combine the EXACT owner filter with ownedOnly (`ownerId IS NOT NULL`)
    // without the spread overwriting one with the other.
    const ownerWhere =
      validated.ownerId === null
        ? (validated.ownedOnly ? { ownerId: { not: null } } : {})
        : { ownerId: validated.ownedOnly ? { equals: validated.ownerId, not: null } : validated.ownerId };
    const rows = await this.prisma.agentTask.findMany({
      where: {
        ...ownerWhere,
        ...(validated.isActive !== null ? { isActive: validated.isActive } : {}),
      },
      orderBy: validated.order === 'newest'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : [{ createdAt: 'asc' }, { id: 'asc' }],
      take: validated.limit,
    });
    return rows.map((row) => mapTask(row));
  }

  async setTaskActive(id: string, isActive: boolean, options?: SchedulerReadOptions): Promise<AgentTask> {
    if (typeof isActive !== 'boolean') {
      throw new SchedulerValidationError('isActive must be a boolean');
    }
    const parsedOptions = validateReadOptions(options);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "AgentTask" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const row = await tx.agentTask.findUnique({ where: { id } });
        if (!row) {
          throw new SchedulerNotFoundError(`agent task ${id} not found`);
        }
        // Owner guard: a wrong owner reads as 404 (never a row oracle).
        enforceRowOwner(row, parsedOptions.expectedOwnerId);
        const updated = await tx.agentTask.update({
          where: { id },
          data: { isActive, updatedAt: new Date() },
        });
        return mapTask(updated);
      });
    } catch (cause) {
      throw asNotFoundOrConflict(
        cause,
        `agent task ${id} concurrent isActive write conflict`,
        `agent task ${id} not found`,
      );
    }
  }

  // -- executions ------------------------------------------------------------

  async createExecution(
    task: AgentTask,
    data: SchedulerStoreExecutionCreate,
  ): Promise<SchedulerStoreExecutionCreateResult> {
    const validated = validateStoreExecutionCreate(data);
    const taskId = parseSchedulerInput(schedulerIdSchema, task?.id);
    const queueJobId = validated.queueJobId ?? null;
    const repeatJobKey = validated.repeatJobKey ?? null;
    const triggerDb = triggerToDb(validated.trigger);
    const id = validated.id ?? randomUUID();

    try {
      return await this.prisma.$transaction(async (tx): Promise<SchedulerStoreExecutionCreateResult> => {
        // Existence + serialization + authoritative owner in ONE probe: every
        // createExecution for the same task queues on this row lock, making
        // the SCHEDULED dedupe below linearizable (two racing creates always
        // see each other), and the locked row (never the caller's argument)
        // supplies the owner for inheritance.
        const taskLock = await tx.$queryRaw<Array<{ id: string; ownerId: string | null }>>`SELECT "id", "ownerId" FROM "AgentTask" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
        if (!taskLock || taskLock.length === 0) {
          throw new SchedulerNotFoundError(`agent task ${taskId} not found`);
        }
        // Owner inheritance (documented): explicit value wins, otherwise the
        // execution belongs to the task's tenant (ownerless tasks -> null).
        const executionOwnerId = validated.ownerId ?? (taskLock[0]?.ownerId ?? null);

        if (validated.trigger === 'RETRY') {
          const retryOfId = validated.retryOfExecutionId;
          if (retryOfId === undefined) {
            throw new SchedulerValidationError('RETRY executions require retryOfExecutionId');
          }
          const sourceLock = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "AgentTaskExecution" WHERE "id" = ${retryOfId}::uuid FOR UPDATE`;
          if (!sourceLock || sourceLock.length === 0) {
            throw new SchedulerNotFoundError(`retry source execution ${retryOfId} not found`);
          }
          const source = await tx.agentTaskExecution.findUnique({ where: { id: retryOfId } });
          if (!source) {
            throw new SchedulerNotFoundError(`retry source execution ${retryOfId} not found`);
          }
          // Owner binding BEFORE the 409s: a foreign/ownerless source reads
          // as 404 (no cross-tenant oracle); ownerless tasks stay exempt.
          if (executionOwnerId !== null && (source.ownerId ?? null) !== executionOwnerId) {
            throw new SchedulerNotFoundError(`retry source execution ${source.id} not found`);
          }
          const sourceStatus = statusFromDb(source.status);
          if (sourceStatus !== 'DEAD_LETTER') {
            throw new SchedulerConflictError(
              `retry source ${source.id} is ${sourceStatus}; RETRY requires DEAD_LETTER`,
            );
          }
          if (source.taskId !== taskId) {
            throw new SchedulerConflictError(
              `retry source ${source.id} belongs to task ${source.taskId}, not ${taskId}`,
            );
          }
        }

        // Atomic duplicate guard: at most ONE SCHEDULED row per
        // (taskId, scheduledFor). The row lock above serializes racing
        // creates, so a duplicate lands HERE — no second row, no P2002.
        const existingScheduled =
          validated.trigger === 'SCHEDULED'
            ? await tx.agentTaskExecution.findFirst({
                where: { taskId, scheduledFor: validated.scheduledFor, trigger: triggerToDb(validated.trigger) },
              })
            : null;
        if (existingScheduled) {
          return { execution: mapExecution(existingScheduled), created: false };
        }

        const created = await tx.agentTaskExecution.create({
          data: {
            id,
            taskId,
            scheduledFor: validated.scheduledFor,
            trigger: triggerDb,
            status: 'pending',
            attempt: 0,
            maxAttempts: MAX_TASK_ATTEMPTS,
            durationMs: null,
            // Nullable Json column, no usage on create -> Prisma.DbNull =
            // SQL NULL. NEVER Prisma.JsonNull: that inserts the JSON literal
            // `null` (jsonb_typeof 'null') and violates the SQL-only
            // AgentTaskExecution_token_usage_check (SQL NULL or object only).
            tokenUsage: Prisma.DbNull,
            error: null,
            // chatId IS the execution id: one execution -> one isolated chat.
            chatId: id,
            // Explicit owner wins; otherwise the task's tenant (see above).
            ownerId: executionOwnerId,
            queueJobId,
            repeatJobKey,
            // FK scalar set only when present; the column defaults to NULL.
            ...(validated.retryOfExecutionId !== undefined
              ? { retryOfExecutionId: validated.retryOfExecutionId }
              : {}),
            createdAt: validated.now,
            updatedAt: validated.now,
            finishedAt: null,
          },
        });
        return { execution: mapExecution(created), created: true };
      });
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
        // Queue-identity collisions (queueJobId/repeatJobKey) map to typed
        // conflicts. A lost SCHEDULED dedupe race (defensive: unreachable
        // under the task lock) re-reads the winner OUTSIDE the aborted
        // transaction on a fresh connection and returns it idempotently.
        if (validated.trigger === 'SCHEDULED') {
          const winner = await this.prisma.agentTaskExecution.findFirst({
            where: { taskId, scheduledFor: validated.scheduledFor, trigger: triggerToDb(validated.trigger) },
          });
          if (winner) {
            return { execution: mapExecution(winner), created: false };
          }
        }
        throw new SchedulerConflictError(
          `execution identity is already recorded for task ${taskId} (queue job id or repeat key)`,
          { cause },
        );
      }
      throw cause;
    }
  }

  async getExecution(id: string, options?: SchedulerReadOptions): Promise<AgentTaskExecution | null> {
    const parsedId = parseSchedulerInput(schedulerIdSchema, id);
    const parsedOptions = validateReadOptions(options);
    const row = await this.prisma.agentTaskExecution.findUnique({ where: { id: parsedId } });
    if (!row) {
      return null;
    }
    // Owner guard: foreign/ownerless rows read as absent — never an oracle.
    if (parsedOptions.expectedOwnerId !== null && (row.ownerId ?? null) !== parsedOptions.expectedOwnerId) {
      return null;
    }
    return mapExecution(row);
  }

  async listExecutions(
    params?: SchedulerStoreExecutionListParams,
  ): Promise<readonly AgentTaskExecution[]> {
    const validatedList = validateListParams(params);
    const taskId = params?.taskId === undefined ? undefined : parseSchedulerInput(schedulerIdSchema, params.taskId);
    const status = params?.status === undefined ? undefined : statusToDb(params.status);
    const rows = await this.prisma.agentTaskExecution.findMany({
      where: {
        ...(taskId !== undefined ? { taskId } : {}),
        ...(status !== undefined ? { status } : {}),
        // EXACT owner match: ownerless legacy rows never satisfy an owner.
        ...(validatedList.ownerId !== null ? { ownerId: validatedList.ownerId } : {}),
      },
      orderBy: validatedList.order === 'newest'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : [{ createdAt: 'asc' }, { id: 'asc' }],
      take: validatedList.limit,
    });
    return rows.map((row) => mapExecution(row));
  }

  // -- CAS mutations ---------------------------------------------------------

  async claimExecution(data: SchedulerStoreExecutionClaim): Promise<AgentTaskExecution> {
    const validated = validateStoreClaim(data);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize concurrent claim candidates on the execution row.
        await tx.$queryRaw`SELECT "id" FROM "AgentTaskExecution" WHERE "id" = ${validated.id}::uuid FOR UPDATE`;
        const row = await tx.agentTaskExecution.findUnique({ where: { id: validated.id } });
        if (!row) {
          throw new SchedulerNotFoundError(`agent task execution ${validated.id} not found`);
        }
        // Owner guard BEFORE the CAS: a wrong owner reads as 404 (no status
        // or attempt oracle). Ownerless legacy rows never satisfy any owner.
        enforceRowOwner(row, validated.expectedOwnerId);
        const execution = mapExecution(row);
        // Atomic compare-and-set: the row lock above serializes concurrent
        // candidates, so exactly one wins and every loser gets this conflict.
        assertCondition(
          execution.status === validated.allowedFrom,
          `agent task execution ${validated.id} was expected to be ${validated.allowedFrom} but is ${execution.status}`,
        );
        assertCondition(
          execution.attempt + 1 === validated.attempt,
          `agent task execution ${validated.id} attempt must move ${execution.attempt} -> ${validated.attempt}`,
        );
        const updated = await tx.agentTaskExecution.update({
          where: { id: validated.id },
          data: {
            status: statusToDb('RUNNING'),
            attempt: validated.attempt,
            updatedAt: new Date(),
          },
        });
        return mapExecution(updated);
      });
    } catch (cause) {
      throw asNotFoundOrConflict(
        cause,
        `agent task execution ${validated.id} concurrent claim conflict`,
        `agent task execution ${validated.id} not found`,
      );
    }
  }

  async markExecution(data: SchedulerStoreExecutionMark): Promise<AgentTaskExecution> {
    const validated = validateStoreExecutionMark(data);
    const targetDb = statusToDb(validated.target);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize concurrent writers on the execution row.
        await tx.$queryRaw`SELECT "id" FROM "AgentTaskExecution" WHERE "id" = ${validated.id}::uuid FOR UPDATE`;
        const row = await tx.agentTaskExecution.findUnique({ where: { id: validated.id } });
        if (!row) {
          throw new SchedulerNotFoundError(`agent task execution ${validated.id} not found`);
        }
        // Owner guard BEFORE the CAS: a wrong owner reads as 404 (no status
        // oracle, no idempotent-repeat oracle). Ownerless legacy rows never
        // satisfy any expected owner.
        enforceRowOwner(row, validated.expectedOwnerId);
        const execution = mapExecution(row);
        const { target } = validated;

        if (execution.status === target) {
          // Same outcome again: idempotent ONLY with an equivalent payload.
          if (
            (target === 'COMPLETED' || target === 'FAILED' || target === 'DEAD_LETTER') &&
            sameMarkPayload(execution, validated)
          ) {
            return execution;
          }
          throw new SchedulerConflictError(
            `agent task execution ${validated.id} is already ${target}; payload differs or the mark is not idempotent`,
          );
        }
        // CAS matrix (PENDING -> SKIPPED; RUNNING -> RETRYING|terminal only).
        const expectedFrom = target === 'SKIPPED' ? 'PENDING' : 'RUNNING';
        assertCondition(
          execution.status === expectedFrom,
          `agent task execution ${validated.id} cannot move from ${execution.status} to ${target}`,
        );

        const isTerminal =
          target === 'COMPLETED' || target === 'FAILED' || target === 'DEAD_LETTER' || target === 'SKIPPED';
        const now = new Date();
        const updated = await tx.agentTaskExecution.update({
          where: { id: validated.id },
          data: {
            status: targetDb,
            ...(target === 'COMPLETED'
              ? {
                  durationMs: validated.durationMs ?? 0,
                  ...(validated.tokenUsage !== null ? { tokenUsage: validated.tokenUsage as Prisma.InputJsonValue } : {}),
                }
              : {}),
            ...(target === 'FAILED' || target === 'DEAD_LETTER'
              ? { error: validated.error ?? null }
              : {}),
            updatedAt: now,
            // finishedAt is stamped exactly once, at the first terminal CAS.
            ...(isTerminal && execution.finishedAt === null ? { finishedAt: now } : {}),
          },
        });
        return mapExecution(updated);
      });
    } catch (cause) {
      throw asNotFoundOrConflict(
        cause,
        `agent task execution ${validated.id} concurrent mark conflict`,
        `agent task execution ${validated.id} not found`,
      );
    }
  }
}

/** Factory kept for symmetry with the other Prisma adapters. */
export function createPrismaSchedulerStore(prisma: PrismaClient): PrismaSchedulerStore {
  return new PrismaSchedulerStore(prisma);
}
