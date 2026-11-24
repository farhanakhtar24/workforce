/**
 * {@link SchedulerStore} implementation for fast unit tests — same contract,
 * typed errors, CAS rules, and ordering guarantees as the Prisma adapter (via
 * the shared `../validate.js` rules), backed by plain Maps.
 *
 * Concurrency model (mirrors `InMemoryWorkDocStore`): JavaScript is
 * single-threaded, and every write runs without an intervening `await`
 * between the check and the mutation, so check-then-act is atomic. Two
 * concurrent `claimExecution` calls with the same expectations therefore
 * serialize: exactly one winner, every loser gets a typed conflict —
 * mirroring the Postgres row lock.
 */

import { randomUUID } from 'node:crypto';

import {
  MAX_TASK_ATTEMPTS,
  AGENT_TASK_TIMEZONE,
} from '../kinds.js';
import {
  validateListParams,
  validateReadOptions,
  validateStoreClaim,
  validateStoreExecutionCreate,
  validateStoreExecutionMark,
  validateStoreTaskCreate,
  validateStoreTaskUpdate,
  resolveNextRunAtForUpdate,
  canMarkExecution,
  sameMarkPayload,
  notFound,
  assertCondition,
  compareByCreatedAtThenId,
  enforceRowOwner,
} from '../validate.js';
import { SchedulerConflictError, SchedulerNotFoundError, SchedulerValidationError } from '../errors.js';
import { schedulerIdSchema, parseSchedulerInput } from '../schemas.js';
import type {
  SchedulerReadOptions,
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
import type { AgentTask, AgentTaskExecution } from '../types.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function toIso(): string {
  return new Date().toISOString();
}

/** Composite key for the atomic only-SCHEDULED (taskId, scheduledFor) uniqueness. */
function scheduledKey(taskId: string, scheduledForMs: number): string {
  return `${taskId}\u0000${scheduledForMs.toString(10)}`;
}

export class InMemorySchedulerStore implements SchedulerStore {
  private readonly tasks = new Map<string, AgentTask>();
  private readonly executions = new Map<string, AgentTaskExecution>();
  /** SCHEDULED rows only: (taskId, scheduledForMs) -> execution id. */
  private readonly scheduledIndex = new Map<string, string>();
  private readonly queueJobIndex = new Map<string, string>();
  private readonly repeatJobIndex = new Map<string, string>();

  // -- tasks -----------------------------------------------------------------

  async createTask(data: SchedulerStoreTaskCreate): Promise<AgentTask> {
    return this.createTaskSync(data);
  }

  private createTaskSync(data: SchedulerStoreTaskCreate): AgentTask {
    // One synchronous critical section: no await between check and writes.
    const validated = validateStoreTaskCreate(data);
    const id = validated.id ?? randomUUID();
    if (this.tasks.has(id)) {
      throw new SchedulerConflictError(`agent task ${id} already exists`);
    }

    const createdAtIso = validated.createdAt.toISOString();
    const task: AgentTask = {
      id,
      name: validated.name,
      agentSlug: validated.agentSlug,
      mode: validated.mode,
      prompt: validated.prompt,
      scope: validated.scope,
      recurrenceType: validated.recurrenceType,
      recurrenceConfig: validated.recurrenceConfig,
      skipDates: validated.skipDates,
      isActive: true,
      timezone: AGENT_TASK_TIMEZONE,
      nextRunAt: validated.nextRunAt ? validated.nextRunAt.toISOString() : null,
      ownerId: validated.ownerId,
      createdAt: createdAtIso,
      updatedAt: createdAtIso,
    };
    this.tasks.set(id, task);
    return clone(task);
  }

  async updateTask(data: SchedulerStoreTaskUpdate): Promise<AgentTask> {
    return this.updateTaskSync(data);
  }

  private updateTaskSync(data: SchedulerStoreTaskUpdate): AgentTask {
    const validated = validateStoreTaskUpdate(data);
    const existing = notFound(this.tasks.get(validated.id), `agent task ${validated.id} not found`);
    // Owner guard FIRST: a wrong owner reads as 404 (no patch oracle).
    // Ownerless legacy tasks never satisfy any expected owner.
    enforceRowOwner(existing, validated.expectedOwnerId);

    const updatedAt = validated.now.toISOString();
    const nextRunAt = resolveNextRunAtForUpdate(existing, validated);
    const updated: AgentTask = {
      ...existing,
      // `id` is preserved by construction: never patched.
      name: validated.name ?? existing.name,
      prompt: validated.prompt ?? existing.prompt,
      agentSlug: validated.agentSlug ?? existing.agentSlug,
      mode: validated.mode ?? existing.mode,
      scope: validated.scope ?? existing.scope,
      recurrenceType: validated.recurrenceType ?? existing.recurrenceType,
      recurrenceConfig: validated.recurrenceConfig ?? existing.recurrenceConfig,
      skipDates: validated.skipDates ?? existing.skipDates,
      nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
      updatedAt,
    };
    this.tasks.set(validated.id, updated);
    return clone(updated);
  }

  async getTask(id: string, options?: SchedulerReadOptions): Promise<AgentTask | null> {
    const parsedId = parseSchedulerInput(schedulerIdSchema, id);
    const parsedOptions = validateReadOptions(options);
    const task = this.tasks.get(parsedId);
    if (!task) {
      return null;
    }
    // Owner guard: foreign/ownerless rows read as absent — never an oracle.
    if (parsedOptions.expectedOwnerId !== null && (task.ownerId ?? null) !== parsedOptions.expectedOwnerId) {
      return null;
    }
    return clone(task);
  }

  async listTasks(params?: SchedulerStoreTaskListParams): Promise<readonly AgentTask[]> {
    const validated = validateListParams(params);
    return [...this.tasks.values()]
      .filter((task) => {
        // EXACT owner match: ownerless legacy tasks never satisfy an owner;
        // ownedOnly excludes EVERY ownerless row (startup reconciliation).
        if (validated.ownerId !== null && (task.ownerId ?? null) !== validated.ownerId) {
          return false;
        }
        if (validated.ownedOnly && task.ownerId === null) {
          return false;
        }
        if (validated.isActive !== null && task.isActive !== validated.isActive) {
          return false;
        }
        return true;
      })
      .sort(compareByCreatedAtThenId(validated.order))
      .slice(0, validated.limit)
      .map((task) => clone(task));
  }

  async setTaskActive(id: string, isActive: boolean, options?: SchedulerReadOptions): Promise<AgentTask> {
    return this.setTaskActiveSync(id, isActive, options);
  }

  private setTaskActiveSync(id: string, isActive: boolean, options?: SchedulerReadOptions): AgentTask {
    if (typeof isActive !== 'boolean') {
      throw new SchedulerValidationError('isActive must be a boolean');
    }
    const parsedId = parseSchedulerInput(schedulerIdSchema, id);
    const parsedOptions = validateReadOptions(options);
    const existing = notFound(this.tasks.get(parsedId), `agent task ${parsedId} not found`);
    // Owner guard: a wrong owner reads as 404 (never a row oracle).
    enforceRowOwner(existing, parsedOptions.expectedOwnerId);
    const updated: AgentTask = {
      ...existing,
      isActive,
      updatedAt: toIso(),
    };
    this.tasks.set(parsedId, updated);
    return clone(updated);
  }

  // -- executions ------------------------------------------------------------

  async createExecution(
    task: AgentTask,
    data: SchedulerStoreExecutionCreate,
  ): Promise<SchedulerStoreExecutionCreateResult> {
    return this.createExecutionSync(task, data);
  }

  private createExecutionSync(
    task: AgentTask,
    data: SchedulerStoreExecutionCreate,
  ): SchedulerStoreExecutionCreateResult {
    const validated = validateStoreExecutionCreate(data);
    const taskId = parseSchedulerInput(schedulerIdSchema, task.id);
    const ownerTask = notFound(this.tasks.get(taskId), `agent task ${taskId} not found`);

    if (validated.trigger === 'RETRY') {
      const sourceId = validated.retryOfExecutionId;
      const source = notFound(
        sourceId === undefined ? null : this.executions.get(sourceId),
        `retry source execution ${sourceId ?? '(missing id)'} not found`,
      );
      // Owner binding BEFORE the 409s: a foreign/ownerless source reads as
      // 404 (no cross-tenant oracle), ownerless legacy tasks stay exempt.
      const resolvedOwnerId = validated.ownerId ?? (ownerTask.ownerId ?? null);
      if (resolvedOwnerId !== null && (source.ownerId ?? null) !== resolvedOwnerId) {
        throw new SchedulerNotFoundError(`retry source execution ${source.id} not found`);
      }
      assertCondition(
        source.status === 'DEAD_LETTER',
        `retry source ${source.id} is ${source.status}; RETRY requires DEAD_LETTER`,
      );
      assertCondition(
        source.taskId === taskId,
        `retry source ${source.id} belongs to task ${source.taskId}, not ${taskId}`,
      );
    }

    // Atomic duplicate guard FIRST (Prisma parity): at most ONE SCHEDULED row
    // per (taskId, scheduledFor). A duplicate create returns the existing row
    // (created: false) and NEVER writes a second row — queue/repeat identity
    // collisions are irrelevant on this path because no insert happens.
    const scheduledKeyMs = scheduledKey(taskId, validated.scheduledFor.getTime());
    if (validated.trigger === 'SCHEDULED') {
      const existingId = this.scheduledIndex.get(scheduledKeyMs);
      if (existingId !== undefined) {
        const existing = notFound(this.executions.get(existingId), 'scheduled execution lost from the index');
        return { execution: clone(existing), created: false };
      }
    }

    // Genuinely new execution: identity guards below apply before the insert.
    const id = validated.id ?? randomUUID();
    if (this.executions.has(id)) {
      throw new SchedulerConflictError(`agent task execution ${id} already exists`);
    }
    const queueJobId = validated.queueJobId ?? null;
    if (queueJobId !== null && this.queueJobIndex.has(queueJobId)) {
      throw new SchedulerConflictError(`queue job id ${queueJobId} is already recorded`);
    }
    const repeatJobKey = validated.repeatJobKey ?? null;
    if (repeatJobKey !== null && this.repeatJobIndex.has(repeatJobKey)) {
      throw new SchedulerConflictError(`repeat job key ${repeatJobKey} is already recorded`);
    }

    const createdAtIso = validated.now.toISOString();
    const execution: AgentTaskExecution = {
      id,
      taskId,
      retryOfExecutionId: validated.retryOfExecutionId ?? null,
      scheduledFor: validated.scheduledFor.toISOString(),
      trigger: validated.trigger,
      status: 'PENDING',
      attempt: 0,
      maxAttempts: MAX_TASK_ATTEMPTS,
      durationMs: null,
      tokenUsage: null,
      error: null,
      // chatId IS the execution id: one execution -> one isolated chat.
      chatId: id,
      // Owner inheritance (documented): explicit owner wins, otherwise the
      // execution belongs to the task's tenant (ownerless tasks -> null).
      ownerId: validated.ownerId ?? (ownerTask.ownerId ?? null),
      queueJobId,
      repeatJobKey,
      createdAt: createdAtIso,
      updatedAt: createdAtIso,
      finishedAt: null,
    };

    this.executions.set(id, execution);
    if (validated.trigger === 'SCHEDULED') {
      this.scheduledIndex.set(scheduledKeyMs, id);
    }
    if (queueJobId !== null) {
      this.queueJobIndex.set(queueJobId, id);
    }
    if (repeatJobKey !== null) {
      this.repeatJobIndex.set(repeatJobKey, id);
    }
    return { execution: clone(execution), created: true };
  }

  async getExecution(id: string, options?: SchedulerReadOptions): Promise<AgentTaskExecution | null> {
    const parsedId = parseSchedulerInput(schedulerIdSchema, id);
    const parsedOptions = validateReadOptions(options);
    const execution = this.executions.get(parsedId);
    if (!execution) {
      return null;
    }
    // Owner guard: foreign/ownerless rows read as absent — never an oracle.
    if (parsedOptions.expectedOwnerId !== null && (execution.ownerId ?? null) !== parsedOptions.expectedOwnerId) {
      return null;
    }
    return clone(execution);
  }

  async listExecutions(
    params?: SchedulerStoreExecutionListParams,
  ): Promise<readonly AgentTaskExecution[]> {
    const validated = validateListParams(params);
    const taskId = params?.taskId === undefined ? null : parseSchedulerInput(schedulerIdSchema, params.taskId);
    const status = params?.status ?? null;
    return [...this.executions.values()]
      .filter((execution) => {
        if (taskId !== null && execution.taskId !== taskId) {
          return false;
        }
        if (status !== null && execution.status !== status) {
          return false;
        }
        // EXACT owner match: ownerless legacy rows never satisfy an owner.
        if (validated.ownerId !== null && (execution.ownerId ?? null) !== validated.ownerId) {
          return false;
        }
        return true;
      })
      .sort(compareByCreatedAtThenId(validated.order))
      .slice(0, validated.limit)
      .map((execution) => clone(execution));
  }

  // -- CAS mutations ---------------------------------------------------------

  async claimExecution(data: SchedulerStoreExecutionClaim): Promise<AgentTaskExecution> {
    return this.claimExecutionSync(data);
  }

  private claimExecutionSync(data: SchedulerStoreExecutionClaim): AgentTaskExecution {
    const validated = validateStoreClaim(data);
    const execution = notFound(this.executions.get(validated.id), `agent task execution ${validated.id} not found`);
    // Owner guard BEFORE the CAS: a wrong owner reads as 404 (no status or
    // attempt oracle). Ownerless legacy rows never satisfy any expected owner.
    enforceRowOwner(execution, validated.expectedOwnerId);
    // Atomic compare-and-set: no await between check and write, so concurrent
    // candidates serialize and exactly one wins the transition.
    assertCondition(
      execution.status === validated.allowedFrom,
      `agent task execution ${validated.id} was expected to be ${validated.allowedFrom} but is ${execution.status}`,
    );
    assertCondition(
      execution.attempt + 1 === validated.attempt,
      `agent task execution ${validated.id} attempt must move ${execution.attempt} -> ${validated.attempt}`,
    );

    const updated: AgentTaskExecution = {
      ...execution,
      status: 'RUNNING',
      attempt: validated.attempt,
      updatedAt: toIso(),
    };
    this.executions.set(validated.id, updated);
    return clone(updated);
  }

  async markExecution(data: SchedulerStoreExecutionMark): Promise<AgentTaskExecution> {
    return this.markExecutionSync(data);
  }

  private markExecutionSync(data: SchedulerStoreExecutionMark): AgentTaskExecution {
    const validated = validateStoreExecutionMark(data);
    const execution = notFound(this.executions.get(validated.id), `agent task execution ${validated.id} not found`);
    // Owner guard BEFORE the CAS: a wrong owner reads as 404 (no status
    // oracle). Ownerless legacy rows never satisfy any expected owner.
    enforceRowOwner(execution, validated.expectedOwnerId);
    const { target } = validated;

    if (execution.status === target) {
      // Same outcome again: idempotent ONLY with an equivalent payload.
      if (
        (target === 'COMPLETED' || target === 'FAILED' || target === 'DEAD_LETTER') &&
        sameMarkPayload(execution, validated)
      ) {
        return clone(execution);
      }
      throw new SchedulerConflictError(
        `agent task execution ${validated.id} is already ${target}; payload differs or the mark is not idempotent`,
      );
    }
    // CAS matrix + the typed-conflict path for everything else.
    assertCondition(
      canMarkExecution(execution.status, target),
      `agent task execution ${validated.id} cannot move from ${execution.status} to ${target}`,
    );

    const isTerminal =
      target === 'COMPLETED' || target === 'FAILED' || target === 'DEAD_LETTER' || target === 'SKIPPED';
    const nowIso = validated.now.toISOString();
    const updated: AgentTaskExecution = {
      ...execution,
      status: target,
      durationMs: target === 'COMPLETED' ? (validated.durationMs ?? 0) : execution.durationMs,
      tokenUsage: target === 'COMPLETED' ? (validated.tokenUsage ?? null) : execution.tokenUsage,
      error: target === 'FAILED' || target === 'DEAD_LETTER' ? (validated.error ?? null) : execution.error,
      updatedAt: nowIso,
      // finishedAt is stamped exactly once, at the first terminal CAS.
      finishedAt: isTerminal && execution.finishedAt === null ? nowIso : execution.finishedAt,
    };
    this.executions.set(validated.id, updated);
    return clone(updated);
  }
}
