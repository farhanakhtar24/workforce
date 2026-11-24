/**
 * {@link SchedulerService} — validated façade over the {@link SchedulerStore}
 * for API/agent use.
 *
 * Responsibilities:
 * - Parse every input against the route schemas in `./schemas.js` and convert
 *   Zod issues into typed {@link SchedulerValidationError}s (400), BEFORE the
 *   store is touched. Stores re-validate (defense in depth, `./validate.js`),
 *   but the service is the boundary where raw JSON becomes structured,
 *   normalized input.
 * - Owns the RETRY precondition: a RETRY execution requires an EXISTING source
 *   execution (404) that is DEAD_LETTER (409) on the SAME task (409). The
 *   check is TOCTOU-safe because DEAD_LETTER is terminal and can never change.
 * - Never swallows store state: 404/409 typed errors pass through unchanged.
 *
 * Deliberate NON-responsibilities (documented Phase 5 boundary):
 * - Queue sync (BullMQ enqueue/remove/repeat registration) belongs to the API
 *   layer. The service records rows and computes next runs; it never touches
 *   HTTP, Redis, or queues. Recovery semantics (finding stale RUNNING rows and
 *   re-driving the CAS marks) are likewise service-host logic: they are
 *   expressible with claims+marks only — no HTTP in core.
 *
 * Ownership (documented): `ownerId` is the platform user (Better Auth
 * `User.id`) or null for legacy rows; executions inherit the task's owner.
 * Every owner argument stays optional at this layer, but the authenticated
 * API layer MUST always pass the owner (`ownerId` on create/list, or
 * `expectedOwnerId` on reads/mutations): guards match EXACTLY, and a mismatch
 * reads as 404/null — never a cross-tenant oracle. Startup reconciliation
 * selects owner-required active tasks via
 * `listTasks({ isActive: true, ownedOnly: true })`.
 */

import {
  createTaskInputSchema,
  updateTaskInputSchema,
  setTaskActiveInputSchema,
  listTasksInputSchema,
  createExecutionInputSchema,
  claimExecutionInputSchema,
  markExecutionRetryingInputSchema,
  markExecutionCompletedInputSchema,
  markExecutionFailedInputSchema,
  markExecutionDeadLetterInputSchema,
  markExecutionSkippedInputSchema,
  listExecutionsInputSchema,
  parseSchedulerInput,
  schedulerIdSchema,
  schedulerReadOptionsSchema,
  type ClaimExecutionInput,
  type CreateExecutionInput,
  type CreateTaskInput,
  type ListExecutionsInput,
  type ListTasksInput,
  type MarkExecutionCompletedInput,
  type MarkExecutionDeadLetterInput,
  type MarkExecutionFailedInput,
  type MarkExecutionRetryingInput,
  type MarkExecutionSkippedInput,
  type ParsedClaimExecutionInput,
  type ParsedCreateExecutionInput,
  type ParsedCreateTaskInput,
  type ParsedListExecutionsInput,
  type ParsedListTasksInput,
  type ParsedMarkExecutionCompletedInput,
  type ParsedMarkExecutionDeadLetterInput,
  type ParsedMarkExecutionFailedInput,
  type ParsedMarkExecutionRetryingInput,
  type ParsedMarkExecutionSkippedInput,
  type ParsedSchedulerReadOptions,
  type ParsedSetTaskActiveInput,
  type SetTaskActiveInput,
  type UpdateTaskInput,
} from './schemas.js';
import type { SchedulerReadOptions } from './store.js';
import { SchedulerNotFoundError, SchedulerValidationError, SchedulerConflictError } from './errors.js';
import type { SchedulerStore, SchedulerStoreExecutionCreateResult } from './store.js';
import type { AgentTask, AgentTaskExecution } from './types.js';

export interface SchedulerServiceOptions {
  readonly store: SchedulerStore;
}

export class SchedulerService {
  private readonly store: SchedulerStore;

  constructor(options: SchedulerServiceOptions) {
    if (!options?.store) {
      throw new SchedulerValidationError('SchedulerService requires an explicit store; there is no hidden default');
    }
    this.store = options.store;
  }

  // -- tasks -----------------------------------------------------------------

  /**
   * Create a task; nextRunAt derives from the recurrence (after afterAsOf/now).
   * `ownerId` persists as given (omitted -> ownerless legacy row). The
   * authenticated API layer MUST always pass the acting user's id.
   */
  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    const parsed: ParsedCreateTaskInput = parseSchedulerInput(createTaskInputSchema, input);
    return this.store.createTask({
      id: parsed.id,
      name: parsed.name,
      agentSlug: parsed.agentSlug,
      mode: parsed.mode,
      prompt: parsed.prompt,
      scope: parsed.scope,
      recurrenceType: parsed.recurrenceType,
      recurrenceConfig: parsed.recurrenceConfig,
      skipDates: parsed.skipDates,
      ownerId: parsed.ownerId ?? null,
      afterAsOf: parsed.afterAsOf ?? null,
    });
  }

  /**
   * Atomic patch: `id` is required and preserved. Recurrence changes
   * (recurrenceType/recurrenceConfig/skipDates) recompute nextRunAt; explicit
   * nextRunAt applies only when no recurrence field is present. `isActive`
   * only changes via `setTaskActive`. `expectedOwnerId` (the owner guard
   * authenticated API callers MUST pass) reads a foreign/ownerless task as
   * typed 404 before any patch; it is never a mutable field.
   */
  async updateTask(input: UpdateTaskInput): Promise<AgentTask> {
    const parsed = parseSchedulerInput(updateTaskInputSchema, input);
    return this.store.updateTask({
      id: parsed.id,
      name: parsed.name,
      prompt: parsed.prompt,
      agentSlug: parsed.agentSlug,
      mode: parsed.mode,
      scope: parsed.scope,
      recurrenceType: parsed.recurrenceType,
      recurrenceConfig: parsed.recurrenceConfig,
      skipDates: parsed.skipDates,
      nextRunAt: parsed.nextRunAt,
      afterAsOf: parsed.afterAsOf ?? null,
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    });
  }

  /**
   * The task, or null when absent. With `options.expectedOwnerId` (the owner
   * guard authenticated API callers MUST supply), a foreign or ownerless row
   * also reads as null — never an existence oracle.
   */
  async getTask(id: string, options?: SchedulerReadOptions): Promise<AgentTask | null> {
    const parsedId = parseSchedulerInput(schedulerIdSchema, id);
    const parsedOptions: ParsedSchedulerReadOptions = parseSchedulerInput(schedulerReadOptionsSchema, options ?? {});
    return this.store.getTask(parsedId, parsedOptions);
  }

  /**
   * Bounded deterministic listing (createdAt then id). `ownerId` matches
   * EXACTLY (ownerless legacy tasks never match); `ownedOnly: true` selects
   * ONLY owner-required rows — the explicit startup-reconciliation selector
   * that excludes legacy ownerless tasks; `isActive` combines with both.
   */
  async listTasks(input?: ListTasksInput): Promise<readonly AgentTask[]> {
    const parsed: ParsedListTasksInput = parseSchedulerInput(listTasksInputSchema, input ?? {});
    return this.store.listTasks({
      ownerId: parsed.ownerId ?? null,
      ...(parsed.ownedOnly !== undefined ? { ownedOnly: parsed.ownedOnly } : {}),
      ...(parsed.isActive !== undefined ? { isActive: parsed.isActive } : {}),
      order: parsed.order,
      limit: parsed.limit,
    });
  }

  /** The ONLY way isActive changes; missing task -> typed 404. */
  async setTaskActive(input: SetTaskActiveInput): Promise<AgentTask> {
    const parsed: ParsedSetTaskActiveInput = parseSchedulerInput(setTaskActiveInputSchema, input);
    return this.store.setTaskActive(parsed.id, parsed.isActive, {
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    });
  }

  // -- executions ------------------------------------------------------------

  /**
   * Record one execution row. `createExecution` returns
   * `{ execution, created }`: SCHEDULED duplicates of (task, scheduledFor)
   * return the EXISTING row with `created: false`; MANUAL and RETRY always
   * insert (`created: true`). The task must exist (404).
   */
  async createExecution(
    task: AgentTask,
    input: CreateExecutionInput,
  ): Promise<SchedulerStoreExecutionCreateResult> {
    const parsed: ParsedCreateExecutionInput = parseSchedulerInput(createExecutionInputSchema, input);
    await this.assertRetrySource(parsed, task);
    return this.store.createExecution(task, {
      id: parsed.id,
      scheduledFor: parsed.scheduledFor,
      trigger: parsed.trigger,
      queueJobId: parsed.queueJobId,
      repeatJobKey: parsed.repeatJobKey,
      retryOfExecutionId: parsed.retryOfExecutionId,
      ownerId: parsed.ownerId ?? null,
    });
  }

  /**
   * The execution, or null when absent. With `options.expectedOwnerId` (the
   * owner guard authenticated API callers MUST supply), a foreign or ownerless
   * row also reads as null — never an existence oracle.
   */
  async getExecution(id: string, options?: SchedulerReadOptions): Promise<AgentTaskExecution | null> {
    const parsedId = parseSchedulerInput(schedulerIdSchema, id);
    const parsedOptions: ParsedSchedulerReadOptions = parseSchedulerInput(schedulerReadOptionsSchema, options ?? {});
    return this.store.getExecution(parsedId, parsedOptions);
  }

  /** Bounded deterministic listing filtered by taskId/status/owner. */
  async listExecutions(input?: ListExecutionsInput): Promise<readonly AgentTaskExecution[]> {
    const parsed: ParsedListExecutionsInput = parseSchedulerInput(listExecutionsInputSchema, input ?? {});
    return this.store.listExecutions({
      taskId: parsed.taskId,
      status: parsed.status,
      ownerId: parsed.ownerId ?? null,
      order: parsed.order,
      limit: parsed.limit,
    });
  }

  /**
   * Atomic CAS claim PENDING|RETRYING -> RUNNING. `attempt` must move
   * current -> current+1 (1..3). `expectedOwnerId` (the owner guard
   * authenticated API callers MUST pass) reads a foreign/ownerless row as
   * typed 404 BEFORE the CAS. Same-status RUNNING is NOT an idempotent claim;
   * fresh RUNNING/terminal rows throw the typed conflict.
   */
  async claimExecution(input: ClaimExecutionInput): Promise<AgentTaskExecution> {
    const parsed: ParsedClaimExecutionInput = parseSchedulerInput(claimExecutionInputSchema, input);
    return this.store.claimExecution({
      id: parsed.id,
      attempt: parsed.attempt,
      allowedFrom: parsed.allowedFrom,
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    });
  }

  /** RUNNING -> RETRYING (the runner hands the row back to the queue). */
  async markRetrying(input: MarkExecutionRetryingInput): Promise<AgentTaskExecution> {
    const parsed = parseSchedulerInput(markExecutionRetryingInputSchema, input);
    return this.store.markExecution({
      id: parsed.id,
      target: 'RETRYING',
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    });
  }

  /** RUNNING -> COMPLETED; durationMs >= 0 and optional tokenUsage recorded. */
  async markCompleted(input: MarkExecutionCompletedInput): Promise<AgentTaskExecution> {
    const parsed: ParsedMarkExecutionCompletedInput = parseSchedulerInput(markExecutionCompletedInputSchema, input);
    return this.store.markExecution({
      id: parsed.id,
      target: 'COMPLETED',
      durationMs: parsed.durationMs,
      tokenUsage: parsed.tokenUsage ?? null,
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    });
  }

  /** RUNNING -> FAILED with bounded SAFE error text. */
  async markFailed(input: MarkExecutionFailedInput): Promise<AgentTaskExecution> {
    const parsed: ParsedMarkExecutionFailedInput = parseSchedulerInput(markExecutionFailedInputSchema, input);
    return this.store.markExecution({
      id: parsed.id,
      target: 'FAILED',
      error: parsed.error,
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    });
  }

  /** RUNNING -> DEAD_LETTER when attempts are exhausted (bounded SAFE text). */
  async markDeadLetter(input: MarkExecutionDeadLetterInput): Promise<AgentTaskExecution> {
    const parsed: ParsedMarkExecutionDeadLetterInput = parseSchedulerInput(markExecutionDeadLetterInputSchema, input);
    return this.store.markExecution({
      id: parsed.id,
      target: 'DEAD_LETTER',
      error: parsed.error,
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    });
  }

  /** PENDING -> SKIPPED (never ran; e.g. task deactivated before claim). */
  async markSkipped(input: MarkExecutionSkippedInput): Promise<AgentTaskExecution> {
    const parsed: ParsedMarkExecutionSkippedInput = parseSchedulerInput(markExecutionSkippedInputSchema, input);
    return this.store.markExecution({
      id: parsed.id,
      target: 'SKIPPED',
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    });
  }

  private async assertRetrySource(
    parsed: ParsedCreateExecutionInput,
    task: AgentTask,
  ): Promise<void> {
    if (parsed.trigger !== 'RETRY') {
      if (parsed.retryOfExecutionId !== undefined) {
        throw new SchedulerValidationError('retryOfExecutionId is only allowed on RETRY executions');
      }
      return;
    }
    if (parsed.retryOfExecutionId === undefined) {
      throw new SchedulerValidationError('RETRY executions require retryOfExecutionId');
    }
    // Owner binding (when the retrying task is owned): a foreign/ownerless
    // source reads as 404 — no cross-tenant status/existence oracle. Legacy
    // ownerless tasks keep the exact old behavior.
    const expectedOwnerId = task?.ownerId ?? null;
    const source: AgentTaskExecution | null = await this.store.getExecution(
      parsed.retryOfExecutionId,
      expectedOwnerId !== null ? { expectedOwnerId } : undefined,
    );
    if (source === null) {
      throw new SchedulerNotFoundError(`retry source execution ${parsed.retryOfExecutionId} not found`);
    }
    if (source.status !== 'DEAD_LETTER') {
      throw new SchedulerConflictError(
        `retry source ${source.id} is ${source.status}; RETRY requires DEAD_LETTER`,
      );
    }
    if (source.taskId !== task.id) {
      throw new SchedulerConflictError(
        `retry source ${source.id} belongs to task ${source.taskId}, not ${task.id}`,
      );
    }
  }
}

/** Factory kept for symmetry with the other core services. */
export function createSchedulerService(options: SchedulerServiceOptions): SchedulerService {
  return new SchedulerService(options);
}
