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
  type ParsedSetTaskActiveInput,
  type SetTaskActiveInput,
  type UpdateTaskInput,
} from './schemas.js';
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

  /** Create a task; nextRunAt derives from the recurrence (after afterAsOf/now). */
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
      afterAsOf: parsed.afterAsOf ?? null,
    });
  }

  /**
   * Atomic patch: `id` is required and preserved. Recurrence changes
   * (recurrenceType/recurrenceConfig/skipDates) recompute nextRunAt; explicit
   * nextRunAt applies only when no recurrence field is present. `isActive`
   * only changes via `setTaskActive`.
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
    });
  }

  /** The task, or null when absent. */
  async getTask(id: string): Promise<AgentTask | null> {
    const parsedId = parseSchedulerInput(schedulerIdSchema, id);
    return this.store.getTask(parsedId);
  }

  /** Bounded deterministic listing (createdAt then id). */
  async listTasks(input?: ListTasksInput): Promise<readonly AgentTask[]> {
    const parsed: ParsedListTasksInput = parseSchedulerInput(listTasksInputSchema, input ?? {});
    return this.store.listTasks({ order: parsed.order, limit: parsed.limit });
  }

  /** The ONLY way isActive changes; missing task -> typed 404. */
  async setTaskActive(input: SetTaskActiveInput): Promise<AgentTask> {
    const parsed: ParsedSetTaskActiveInput = parseSchedulerInput(setTaskActiveInputSchema, input);
    return this.store.setTaskActive(parsed.id, parsed.isActive);
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
    });
  }

  /** The execution, or null when absent. */
  async getExecution(id: string): Promise<AgentTaskExecution | null> {
    const parsedId = parseSchedulerInput(schedulerIdSchema, id);
    return this.store.getExecution(parsedId);
  }

  /** Bounded deterministic listing filtered by taskId/status. */
  async listExecutions(input?: ListExecutionsInput): Promise<readonly AgentTaskExecution[]> {
    const parsed: ParsedListExecutionsInput = parseSchedulerInput(listExecutionsInputSchema, input ?? {});
    return this.store.listExecutions({
      taskId: parsed.taskId,
      status: parsed.status,
      order: parsed.order,
      limit: parsed.limit,
    });
  }

  /**
   * Atomic CAS claim PENDING|RETRYING -> RUNNING. `attempt` must move
   * current -> current+1 (1..3). Same-status RUNNING is NOT an idempotent
   * claim; fresh RUNNING/terminal rows throw the typed conflict.
   */
  async claimExecution(input: ClaimExecutionInput): Promise<AgentTaskExecution> {
    const parsed: ParsedClaimExecutionInput = parseSchedulerInput(claimExecutionInputSchema, input);
    return this.store.claimExecution(parsed);
  }

  /** RUNNING -> RETRYING (the runner hands the row back to the queue). */
  async markRetrying(input: MarkExecutionRetryingInput): Promise<AgentTaskExecution> {
    const parsed = parseSchedulerInput(markExecutionRetryingInputSchema, input);
    return this.store.markExecution({ id: parsed.id, target: 'RETRYING' });
  }

  /** RUNNING -> COMPLETED; durationMs >= 0 and optional tokenUsage recorded. */
  async markCompleted(input: MarkExecutionCompletedInput): Promise<AgentTaskExecution> {
    const parsed: ParsedMarkExecutionCompletedInput = parseSchedulerInput(markExecutionCompletedInputSchema, input);
    return this.store.markExecution({
      id: parsed.id,
      target: 'COMPLETED',
      durationMs: parsed.durationMs,
      tokenUsage: parsed.tokenUsage ?? null,
    });
  }

  /** RUNNING -> FAILED with bounded SAFE error text. */
  async markFailed(input: MarkExecutionFailedInput): Promise<AgentTaskExecution> {
    const parsed: ParsedMarkExecutionFailedInput = parseSchedulerInput(markExecutionFailedInputSchema, input);
    return this.store.markExecution({ id: parsed.id, target: 'FAILED', error: parsed.error });
  }

  /** RUNNING -> DEAD_LETTER when attempts are exhausted (bounded SAFE text). */
  async markDeadLetter(input: MarkExecutionDeadLetterInput): Promise<AgentTaskExecution> {
    const parsed: ParsedMarkExecutionDeadLetterInput = parseSchedulerInput(markExecutionDeadLetterInputSchema, input);
    return this.store.markExecution({ id: parsed.id, target: 'DEAD_LETTER', error: parsed.error });
  }

  /** PENDING -> SKIPPED (never ran; e.g. task deactivated before claim). */
  async markSkipped(input: MarkExecutionSkippedInput): Promise<AgentTaskExecution> {
    const parsed = parseSchedulerInput(markExecutionSkippedInputSchema, input);
    return this.store.markExecution({ id: parsed.id, target: 'SKIPPED' });
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
    const source: AgentTaskExecution | null = await this.store.getExecution(parsed.retryOfExecutionId);
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
