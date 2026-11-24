/**
 * `/api/scheduler` REST routes (Phase 5): task CRUD + activation, MANUAL
 * runs, dead-letter retries, execution views, and the two WORKER-ONLY run
 * routes (`run-scheduled`, `executions/:id/run`) the standalone scheduler
 * worker calls with BullMQ occurrence metadata — the browser never mints
 * occurrence metadata.
 *
 * Contract:
 * - create/update/activate/pause sync the BullMQ queue AFTER the DB write;
 *   a sync failure is an honest 503 (the row stands and is reconciled at the
 *   next startup) — sync success is never silently claimed.
 * - MANUAL run and DEAD_LETTER retry create a NEW execution and enqueue;
 *   if the enqueue fails the claimed row lands DEAD_LETTER via valid CAS
 *   transitions (PENDING -> RUNNING -> DEAD_LETTER) so the user can retry
 *   later, and the route answers 503 — no execution is left forever-PENDING.
 * - Errors are fixed safe strings (400/404/409/503); no store/queue/provider
 *   text, no ids from payloads, no prompt/chat content anywhere.
 * - The worker header is a CONVENTION, not authentication (see
 *   `worker-contract.ts`).
 */
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import {
  createTaskInputSchema,
  parseSchedulerInput,
  updateTaskInputSchema,
  SchedulerConflictError,
  SchedulerNotFoundError,
  SchedulerValidationError,
  type AgentTask,
  type AgentTaskExecution,
  type SchedulerService,
} from '@workforce/core/scheduler';
import { isIsoInstantZ, isValidSchedulerQueueId } from '@workforce/queue/scheduler';
import { randomUUID } from 'node:crypto';

import type { SafeLogger } from '../logging.js';
import type {
  SchedulerQueuePort,
  SchedulerRunBudgets,
} from './types.js';
import {
  INVALID_SCHEDULER_REQUEST,
  RUN_ERROR_QUEUE_ENQUEUE,
  SCHEDULER_CONFLICT,
  SCHEDULER_EXECUTION_NOT_FOUND,
  SCHEDULER_QUEUE_UNAVAILABLE,
  SCHEDULER_STORE_UNAVAILABLE,
  SCHEDULER_TASK_NOT_FOUND,
  SCHEDULER_WORKER_HEADER_REQUIRED,
} from './types.js';
import { schedulerWorkerHeaderValue } from './worker-contract.js';
import {
  createSchedulerRunService,
  type SchedulerRunOutcome,
  type SchedulerRunService,
} from './run-service.js';

const INTEGER_STRING = /^\d+$/;

/** `isActive`/`limit` filters for GET /tasks (limit reuses the domain bound). */
const SCHEDULER_HTTP_LIMIT_MAX = 100;
const booleanQuerySchema = z.union([z.literal('true'), z.literal('false')]);

/** Worker-only run-route bodies: strict, occurrence metadata only. */
const runScheduledBodySchema = z.strictObject({
  scheduledFor: z.string(),
  queueJobId: z.string().optional(),
  repeatJobKey: z.string().optional(),
  attempt: z.unknown(),
});

const runExecutionBodySchema = z.strictObject({
  queueJobId: z.string().optional(),
  attempt: z.unknown(),
});

export interface SchedulerRouteDeps {
  readonly service: SchedulerService;
  /** Real BullMQ queue in production; `null` keeps every sync an honest 503. */
  readonly queue: SchedulerQueuePort | null;
  /** Own-REST run budgets (fetch/baseUrl/timeout budgets/logger). */
  readonly run: SchedulerRunBudgets;
  readonly logger: SafeLogger;
}

export interface SchedulerRouteHandlers {
  readonly createTask: RequestHandler;
  readonly listTasks: RequestHandler;
  readonly getTask: RequestHandler;
  readonly patchTask: RequestHandler;
  readonly activateTask: RequestHandler;
  readonly pauseTask: RequestHandler;
  readonly runTask: RequestHandler;
  readonly runScheduledOccurrence: RequestHandler;
  readonly listExecutions: RequestHandler;
  readonly getExecution: RequestHandler;
  readonly retryExecution: RequestHandler;
  readonly runExecution: RequestHandler;
}

function json(res: Response, status: number, body: unknown): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Maps core scheduler errors onto the fixed route taxonomy. */
function schedulerErrorResponse(res: Response, error: unknown, notFoundText: string = SCHEDULER_TASK_NOT_FOUND): void {
  if (error instanceof SchedulerValidationError) {
    json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
    return;
  }
  if (error instanceof SchedulerNotFoundError) {
    json(res, 404, { error: notFoundText });
    return;
  }
  if (error instanceof SchedulerConflictError) {
    json(res, 409, { error: SCHEDULER_CONFLICT });
    return;
  }
  json(res, 503, { error: SCHEDULER_STORE_UNAVAILABLE });
}

/** Writes one run outcome; `{ ok: false }` stays 200 so BullMQ can retry. */
function writeRunOutcome(res: Response, outcome: SchedulerRunOutcome): void {
  json(res, outcome.status, outcome.body);
}

function parseLimit(value: unknown): number | 'invalid' | 'absent' {
  if (value === undefined) {
    return 'absent';
  }
  if (typeof value !== 'string' || !INTEGER_STRING.test(value)) {
    return 'invalid';
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > SCHEDULER_HTTP_LIMIT_MAX) {
    return 'invalid';
  }
  return parsed;
}

/**
 * Lands an execution whose deterministic enqueue FAILED as DEAD_LETTER via
 * valid CAS transitions (PENDING -> RUNNING claim -> DEAD_LETTER mark). The
 * user can retry it later; nothing is left forever-PENDING. Returns null on
 * any failure (the route still answers 503 honestly).
 */
async function landEnqueueFailure(
  service: SchedulerService,
  executionId: string,
): Promise<AgentTaskExecution | null> {
  try {
    // Fresh MANUAL/RETRY rows are PENDING/attempt-0: claim then mark. Any
    // claim failure still lets the mark decide the truth (a RUNNING row is
    // not hidden; a terminal row stays immutable).
    await service.claimExecution({ id: executionId, attempt: 1, allowedFrom: 'PENDING' }).catch(() => undefined);
    await service.markDeadLetter({ id: executionId, error: RUN_ERROR_QUEUE_ENQUEUE });
    return await service.getExecution(executionId);
  } catch {
    return null;
  }
}

export function createSchedulerRoutes(deps: SchedulerRouteDeps): SchedulerRouteHandlers {
  const { service, queue, logger } = deps;
  const runService: SchedulerRunService = createSchedulerRunService({ service, budgets: deps.run });

  /** Queue sync AFTER a successful DB write; failures are honest 503s. */
  const syncTaskAfterWrite = async (task: AgentTask, res: Response): Promise<boolean> => {
    if (queue === null) {
      json(res, 503, { error: SCHEDULER_QUEUE_UNAVAILABLE });
      return false;
    }
    try {
      await queue.syncTask(task);
      return true;
    } catch (error) {
      logger.error('scheduler-queue-sync-failed', error);
      json(res, 503, { error: SCHEDULER_QUEUE_UNAVAILABLE });
      return false;
    }
  };

  const enqueueExecutionOr503 = async (execution: AgentTaskExecution, res: Response): Promise<boolean> => {
    if (queue === null) {
      logger.error('scheduler-queue-unavailable-enqueue', new Error('scheduler queue is not wired'));
      await landEnqueueFailure(service, execution.id);
      json(res, 503, { error: SCHEDULER_QUEUE_UNAVAILABLE });
      return false;
    }
    try {
      await queue.enqueueExecution(execution);
      return true;
    } catch (error) {
      logger.error('scheduler-queue-enqueue-failed', error);
      await landEnqueueFailure(service, execution.id);
      json(res, 503, { error: SCHEDULER_QUEUE_UNAVAILABLE });
      return false;
    }
  };

  const taskIdOr404 = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

  const createTask: RequestHandler = async (req, res, next) => {
    try {
      const body = req.body;
      if (body === null || typeof body !== 'object') {
        json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
        return;
      }
      let task: AgentTask;
      try {
        // Route-level parse keeps unknown JSON typed; the service re-validates
        // (defense in depth). Zod issues never echo submitted values.
        const parsed = parseSchedulerInput(createTaskInputSchema, body);
        task = await service.createTask(parsed);
      } catch (error) {
        schedulerErrorResponse(res, error);
        return;
      }
      const synced = await syncTaskAfterWrite(task, res);
      if (!synced) {
        return;
      }
      json(res, 201, { task });
    } catch (error) {
      next(error);
    }
  };

  const listTasks: RequestHandler = async (req, res, next) => {
    try {
      const limit = parseLimit(req.query['limit']);
      if (limit === 'invalid') {
        json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
        return;
      }
      const isActiveRaw = req.query['isActive'];
      let isActive: boolean | undefined;
      if (isActiveRaw !== undefined) {
        const parsed = booleanQuerySchema.safeParse(isActiveRaw);
        if (!parsed.success) {
          json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
          return;
        }
        isActive = parsed.data === 'true';
      }
      let tasks: readonly AgentTask[];
      try {
        tasks = await service.listTasks({
          ...(limit !== 'absent' ? { limit } : {}),
        });
      } catch (error) {
        schedulerErrorResponse(res, error);
        return;
      }
      // The store contract has no isActive filter: bounded lists (<=100) are
      // filtered deterministically here.
      const filtered = isActive === undefined ? tasks : tasks.filter((task) => task.isActive === isActive);
      json(res, 200, { tasks: filtered });
    } catch (error) {
      next(error);
    }
  };

  const getTask: RequestHandler = async (req, res, next) => {
    try {
      const id = taskIdOr404(req.params['id']);
      if (id === null) {
        json(res, 404, { error: SCHEDULER_TASK_NOT_FOUND });
        return;
      }
      let task: AgentTask | null;
      try {
        task = await service.getTask(id);
      } catch (error) {
        schedulerErrorResponse(res, error);
        return;
      }
      if (task === null) {
        json(res, 404, { error: SCHEDULER_TASK_NOT_FOUND });
        return;
      }
      let executions: readonly AgentTaskExecution[];
      try {
        executions = await service.listExecutions({ taskId: task.id, limit: 10 });
      } catch {
        executions = []; // detail stays servable when the execution read fails
      }
      json(res, 200, { task, executions });
    } catch (error) {
      next(error);
    }
  };

  const patchTask: RequestHandler = async (req, res, next) => {
    try {
      const id = taskIdOr404(req.params['id']);
      if (id === null) {
        json(res, 404, { error: SCHEDULER_TASK_NOT_FOUND });
        return;
      }
      const body = req.body;
      if (body === null || typeof body !== 'object') {
        json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
        return;
      }
      let task: AgentTask;
      try {
        // Route-level parse (id is bound to the path param); the service
        // re-validates. Unknown/extra keys are rejected by the strict schema.
        const parsed = parseSchedulerInput(updateTaskInputSchema, { ...(body as Record<string, unknown>), id });
        task = await service.updateTask(parsed);
      } catch (error) {
        schedulerErrorResponse(res, error);
        return;
      }
      const synced = await syncTaskAfterWrite(task, res);
      if (!synced) {
        return;
      }
      json(res, 200, { task });
    } catch (error) {
      next(error);
    }
  };

  const setTaskActiveHandler = (isActive: boolean): RequestHandler => {
    return async (req, res, next) => {
      try {
        const id = taskIdOr404(req.params['id']);
        if (id === null) {
          json(res, 404, { error: SCHEDULER_TASK_NOT_FOUND });
          return;
        }
        let task: AgentTask;
        try {
          task = await service.setTaskActive({ id, isActive });
        } catch (error) {
          schedulerErrorResponse(res, error);
          return;
        }
        const synced = await syncTaskAfterWrite(task, res);
        if (!synced) {
          return;
        }
        json(res, 200, { task });
      } catch (error) {
        next(error);
      }
    };
  };

  const activateTask: RequestHandler = setTaskActiveHandler(true);
  const pauseTask: RequestHandler = setTaskActiveHandler(false);

  /** MANUAL run: NEW execution (trigger MANUAL) + immediate enqueue, 202. */
  const runTask: RequestHandler = async (req, res, next) => {
    try {
      const id = taskIdOr404(req.params['id']);
      if (id === null) {
        json(res, 404, { error: SCHEDULER_TASK_NOT_FOUND });
        return;
      }
      let task: AgentTask | null;
      try {
        task = await service.getTask(id);
      } catch (error) {
        schedulerErrorResponse(res, error);
        return;
      }
      if (task === null) {
        json(res, 404, { error: SCHEDULER_TASK_NOT_FOUND });
        return;
      }
      let execution: AgentTaskExecution;
      try {
        const created = await service.createExecution(task, {
          id: randomUUID(),
          scheduledFor: new Date().toISOString(),
          trigger: 'MANUAL',
        });
        execution = created.execution;
      } catch (error) {
        schedulerErrorResponse(res, error);
        return;
      }
      const enqueued = await enqueueExecutionOr503(execution, res);
      if (!enqueued) {
        return;
      }
      json(res, 202, { execution });
    } catch (error) {
      next(error);
    }
  };

  /**
   * WORKER-ONLY (convention, not auth — see `worker-contract.ts`): one BullMQ
   * occurrence. The body carries the occurrence metadata the browser never
   * mints: `{ scheduledFor, queueJobId?, repeatJobKey?, attempt }`.
   */
  const runScheduledOccurrence: RequestHandler = async (req, res, next) => {
    try {
      if (schedulerWorkerHeaderValue((name: string) => req.get(name)) === undefined) {
        json(res, 400, { error: SCHEDULER_WORKER_HEADER_REQUIRED });
        return;
      }
      const id = taskIdOr404(req.params['id']);
      if (id === null || !isValidSchedulerQueueId(id)) {
        json(res, 404, { error: SCHEDULER_TASK_NOT_FOUND });
        return;
      }
      const parsedBody = runScheduledBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
        return;
      }
      const body = parsedBody.data;
      if (!isIsoInstantZ(body.scheduledFor)) {
        json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
        return;
      }
      const attempt = body.attempt;
      if (
        typeof attempt !== 'number' ||
        !Number.isInteger(attempt) ||
        attempt < 1
      ) {
        json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
        return;
      }
      const queueJobId =
        typeof body.queueJobId === 'string' && isValidSchedulerQueueId(body.queueJobId) ? body.queueJobId : undefined;
      const repeatJobKey =
        typeof body.repeatJobKey === 'string' && isValidSchedulerQueueId(body.repeatJobKey)
          ? body.repeatJobKey
          : undefined;
      const outcome = await runService.runScheduled({
        taskId: id,
        scheduledFor: body.scheduledFor,
        attempt,
        ...(queueJobId !== undefined ? { queueJobId } : {}),
        ...(repeatJobKey !== undefined ? { repeatJobKey } : {}),
      });
      writeRunOutcome(res, outcome);
    } catch (error) {
      next(error);
    }
  };

  /**
   * WORKER-ONLY (convention, not auth): one MANUAL/RETRY execution run.
   * Body: `{ attempt, queueJobId? }` — BullMQ job metadata only.
   */
  const runExecution: RequestHandler = async (req, res, next) => {
    try {
      if (schedulerWorkerHeaderValue((name: string) => req.get(name)) === undefined) {
        json(res, 400, { error: SCHEDULER_WORKER_HEADER_REQUIRED });
        return;
      }
      const id = taskIdOr404(req.params['id']);
      if (id === null) {
        json(res, 404, { error: SCHEDULER_EXECUTION_NOT_FOUND });
        return;
      }
      const parsedBody = runExecutionBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
        return;
      }
      const attempt = parsedBody.data.attempt;
      if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
        json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
        return;
      }
      const queueJobId =
        typeof parsedBody.data.queueJobId === 'string' && isValidSchedulerQueueId(parsedBody.data.queueJobId)
          ? parsedBody.data.queueJobId
          : undefined;
      const outcome = await runService.runExecution({
        executionId: id,
        attempt,
        ...(queueJobId !== undefined ? { queueJobId } : {}),
      });
      writeRunOutcome(res, outcome);
    } catch (error) {
      next(error);
    }
  };

  const listExecutions: RequestHandler = async (req, res, next) => {
    try {
      const limit = parseLimit(req.query['limit']);
      if (limit === 'invalid') {
        json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
        return;
      }
      const taskIdRaw = req.query['taskId'];
      const statusRaw = req.query['status'];
      const statusSchema = z.enum([
        'PENDING',
        'RUNNING',
        'RETRYING',
        'COMPLETED',
        'FAILED',
        'DEAD_LETTER',
        'SKIPPED',
      ]);
      let status: 'PENDING' | 'RUNNING' | 'RETRYING' | 'COMPLETED' | 'FAILED' | 'DEAD_LETTER' | 'SKIPPED' | undefined;
      if (statusRaw !== undefined) {
        const parsed = statusSchema.safeParse(statusRaw);
        if (!parsed.success) {
          json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
          return;
        }
        status = parsed.data;
      }
      if (taskIdRaw !== undefined && (typeof taskIdRaw !== 'string' || taskIdRaw.length === 0)) {
        json(res, 400, { error: INVALID_SCHEDULER_REQUEST });
        return;
      }
      let executions: readonly AgentTaskExecution[];
      try {
        executions = await service.listExecutions({
          ...(typeof taskIdRaw === 'string' ? { taskId: taskIdRaw } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(limit !== 'absent' ? { limit } : {}),
        });
      } catch (error) {
        schedulerErrorResponse(res, error);
        return;
      }
      json(res, 200, { executions });
    } catch (error) {
      next(error);
    }
  };

  const getExecution: RequestHandler = async (req, res, next) => {
    try {
      const id = taskIdOr404(req.params['id']);
      if (id === null) {
        json(res, 404, { error: SCHEDULER_EXECUTION_NOT_FOUND });
        return;
      }
      let execution: AgentTaskExecution | null;
      try {
        execution = await service.getExecution(id);
      } catch (error) {
        schedulerErrorResponse(res, error, SCHEDULER_EXECUTION_NOT_FOUND);
        return;
      }
      if (execution === null) {
        json(res, 404, { error: SCHEDULER_EXECUTION_NOT_FOUND });
        return;
      }
      json(res, 200, { execution });
    } catch (error) {
      next(error);
    }
  };

  /** MANUAL retry: NEW linked execution from a DEAD_LETTER row, 202. */
  const retryExecution: RequestHandler = async (req, res, next) => {
    try {
      const id = taskIdOr404(req.params['id']);
      if (id === null) {
        json(res, 404, { error: SCHEDULER_EXECUTION_NOT_FOUND });
        return;
      }
      let source: AgentTaskExecution | null;
      try {
        source = await service.getExecution(id);
      } catch (error) {
        schedulerErrorResponse(res, error, SCHEDULER_EXECUTION_NOT_FOUND);
        return;
      }
      if (source === null) {
        json(res, 404, { error: SCHEDULER_EXECUTION_NOT_FOUND });
        return;
      }
      if (source.status !== 'DEAD_LETTER') {
        // Terminal rows are immutable; only DEAD_LETTER rows may be retried.
        json(res, 409, { error: SCHEDULER_CONFLICT });
        return;
      }
      const task: AgentTask | null = await service.getTask(source.taskId).catch(() => null);
      if (task === null) {
        json(res, 404, { error: SCHEDULER_TASK_NOT_FOUND });
        return;
      }
      let execution: AgentTaskExecution;
      try {
        const created = await service.createExecution(task, {
          id: randomUUID(),
          scheduledFor: new Date().toISOString(),
          trigger: 'RETRY',
          retryOfExecutionId: source.id,
        });
        execution = created.execution;
      } catch (error) {
        schedulerErrorResponse(res, error);
        return;
      }
      const enqueued = await enqueueExecutionOr503(execution, res);
      if (!enqueued) {
        return;
      }
      json(res, 202, { execution, retryOfExecutionId: source.id });
    } catch (error) {
      next(error);
    }
  };

  return {
    createTask,
    listTasks,
    getTask,
    patchTask,
    activateTask,
    pauseTask,
    runTask,
    runScheduledOccurrence,
    listExecutions,
    getExecution,
    retryExecution,
    runExecution,
  };
}
