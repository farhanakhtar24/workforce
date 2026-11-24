/**
 * BullMQ-backed scheduler queue (`workforce-scheduler`, Phase 5): keeps
 * Redis job state in lockstep with the scheduler domain's store rows.
 *
 * ## Job-scheduler ownership (recurring)
 * For an ACTIVE recurring task the queue calls
 * `queue.upsertJobScheduler(task.id, { pattern, tz: 'UTC' }, template)`:
 * - the PATTERN comes from the domain (`cronExpressionForRecurrence`) — UTC,
 *   DST-free by construction; SKIP DATES are a domain/store concern and are
 *   enforced by the run client, not by cron;
 * - the TEMPLATE is `{ name: 'agent-task', data: { taskId }, opts: options }`;
 *   BullMQ OWNS the repeat job ids — we never pass a custom jobId/repeat key.
 *
 * ## Deterministic ONCE jobs
 * An active ONCE task gets ONE deterministic job id `once-<taskId>` with
 * data `{ taskId, scheduledFor }` and `delay = max(0, scheduledFor - now)`.
 * An already-existing job in another instant is REPLACED (remove + add);
 * same-instant duplicates and every-terminal-state jobs are left alone, so a
 * sync can never wedge duplicates. PAST once (`nextRunAt: null`) adds nothing.
 *
 * ## Executions
 * MANUAL/RETRY executions get one deterministic job `execution-<executionId>`
 * (`name: 'agent-execution'`). An existing job in ANY state (waiting, delayed,
 * active, paused, completed AND failed) means no duplicate add — a terminal /
 * failed execution is never manually re-added.
 *
 * ## Connection rules
 * BullMQ owns every socket when created from a config OBJECT
 * (`maxRetriesPerRequest: null` required); `rediss://` and numeric `/db`
 * paths are supported; URLs are never logged. `ping` uses a fully-owned
 * one-off ioredis client; `close` is bounded and idempotent.
 */

import { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';

import { cronExpressionForRecurrence } from '@workforce/core/scheduler';
import type { AgentTask, AgentTaskExecution } from '@workforce/core/scheduler';

import { connectWithTimeout, redisConnectionOptions, type RedisReconnectStrategy } from '../redis-options.js';
import type { SchedulerLogger } from '../logger.js';
import {
  SCHEDULER_CLOSE_TIMEOUT_MS,
  SCHEDULER_PING_TIMEOUT_MS,
  SCHEDULER_QUEUE_NAME,
  SCHEDULER_TASK_JOB_NAME,
  SCHEDULER_EXECUTION_JOB_NAME,
} from './constants.js';
import {
  onceDelayMs,
  schedulerExecutionJobId,
  schedulerJobOptions,
  schedulerOnceJobId,
} from './job-helpers.js';
import { isIsoInstantZ, isValidSchedulerQueueId, type SchedulerJobData } from './types.js';

/**
 * Structural surface of one BullMQ job the queue needs (tests inject fakes;
 * production `Job` values satisfy this structurally).
 */
export interface SchedulerQueueJobLike {
  /** Job payload (already JSON-parsed); used for same-instant dedupe. */
  readonly data?: unknown;
  getState(): Promise<string>;
  remove(): Promise<void>;
}

/**
 * Structural surface of the BullMQ `Queue` this class drives (tests inject
 * fakes; the real `Queue` satisfies this — methods are called with plain
 * option objects only).
 */
export interface SchedulerQueueLike {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  getJob(jobId: string): Promise<SchedulerQueueJobLike | null | undefined>;
  getJobScheduler(jobSchedulerId: string): Promise<unknown>;
  removeJobScheduler(jobSchedulerId: string): Promise<unknown>;
  upsertJobScheduler(jobSchedulerId: string, repeatOpts: unknown, jobTemplate?: unknown): Promise<unknown>;
  close?(): Promise<void>;
}

/** Outcome of one scheduler target during a sync. */
export type SchedulerSyncOutcome = 'upserted' | 'removed' | 'none';

/** What one {@link BullMQSchedulerQueue.syncTask} (or `removeTask`) did. */
export interface SchedulerSyncResult {
  /**
   * Job scheduler (`recurring` side) outcome:
   * `upserted` (active recurring), `removed` (inactive/once/past), `none`.
   */
  readonly recurringScheduler: SchedulerSyncOutcome;
  /**
   * Deterministic ONCE job (`once-<taskId>`) outcome: `added`,
   * `updated` (removed + re-added for a new instant), `removed`,
   * `deferred` (job ACTIVE mid-run; replacement postponed), `none`.
   */
  readonly onceJob: 'added' | 'updated' | 'removed' | 'deferred' | 'none';
}

export interface BullMQSchedulerQueueOptions {
  /** Redis URL; required unless a prebuilt `queue` is injected (tests). */
  redisUrl?: string;
  /** Injected queue (tests); when present, no ioredis connection is created. */
  queue?: SchedulerQueueLike;
  /** Queue name override; default {@link SCHEDULER_QUEUE_NAME} (tests isolate). */
  queueName?: string;
  /** Safe logger for connection-level errors (context strings only). */
  logger?: SchedulerLogger;
  /** ioredis reconnect strategy override (tests use fail-fast). */
  reconnectStrategy?: RedisReconnectStrategy;
  /** close() bound; default {@link SCHEDULER_CLOSE_TIMEOUT_MS} (tests shorten). */
  closeTimeoutMs?: number;
}

/**
 * Reads the desired instant stored on an existing ONCE job's payload; null
 * when absent/unparseable (unknown instants force a replacement attempt).
 */
function onceScheduledForOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const value = (data as { scheduledFor?: unknown }).scheduledFor;
  return isIsoInstantZ(value) ? value : null;
}

export class BullMQSchedulerQueue {
  readonly queue: SchedulerQueueLike;
  readonly queueName: string;

  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly closeTimeoutMs: number;
  private readonly connectionOptions: RedisOptions | null = null;

  constructor(options: BullMQSchedulerQueueOptions) {
    this.queueName = options.queueName ?? SCHEDULER_QUEUE_NAME;
    this.closeTimeoutMs = options.closeTimeoutMs ?? SCHEDULER_CLOSE_TIMEOUT_MS;
    if (options.queue !== undefined) {
      this.queue = options.queue;
      return;
    }
    if (options.redisUrl === undefined) {
      throw new Error('BullMQSchedulerQueue requires a redisUrl (or an injected queue).');
    }
    // BullMQ OWNS the connection when given a config object: it creates,
    // duplicates (blocking commands) and closes every socket on close() —
    // passing an instance leaks duplicated sockets when close() hangs.
    this.connectionOptions = redisConnectionOptions(options.redisUrl, options.reconnectStrategy);
    this.queue = new Queue<SchedulerJobData, unknown, string>(this.queueName, {
      connection: this.connectionOptions,
    }) as unknown as SchedulerQueueLike;
  }

  /**
   * Puts one task's queue state (job scheduler / deterministic once job) in
   * lockstep with the domain row. DETERMINISTIC only: catch-up and execution
   * creation are the host's job, never this method's.
   */
  async syncTask(task: AgentTask, now: Date = new Date()): Promise<SchedulerSyncResult> {
    this.assertOpen();
    const schedulerExisted = await this.jobSchedulerExists(task.id);

    if (!task.isActive) {
      if (schedulerExisted) {
        await this.queue.removeJobScheduler(task.id);
      }
      const onceRemoved = await this.removeOnceJobIfPresent(task.id);
      return {
        recurringScheduler: schedulerExisted ? 'removed' : 'none',
        onceJob: onceRemoved ? 'removed' : 'none',
      };
    }

    if (task.recurrenceType === 'ONCE') {
      // Active ONCE: never keep a recurring scheduler under the task id.
      if (schedulerExisted) {
        await this.queue.removeJobScheduler(task.id);
      }
      const onceJob = await this.syncOnceJob(task, now);
      return {
        recurringScheduler: schedulerExisted ? 'removed' : 'none',
        onceJob,
      };
    }

    const pattern = cronExpressionForRecurrence(task.recurrenceType, task.recurrenceConfig);
    if (pattern === null) {
      // Unreachable for validated non-ONCE tasks; a pattern-less recurring
      // task cannot be expressed as a scheduler — clean it up defensively.
      if (schedulerExisted) {
        await this.queue.removeJobScheduler(task.id);
      }
      return { recurringScheduler: schedulerExisted ? 'removed' : 'none', onceJob: 'none' };
    }

    // Library owns the repeat job ids: pattern + tz + template only, never a
    // custom jobId/repeat key.
    await this.queue.upsertJobScheduler(
      task.id,
      { pattern, tz: 'UTC' },
      {
        name: SCHEDULER_TASK_JOB_NAME,
        data: { taskId: task.id },
        opts: schedulerJobOptions(),
      },
    );
    return { recurringScheduler: 'upserted', onceJob: 'none' };
  }

  /**
   * Removes the task's job scheduler and pending ONCE job. Idempotent: absent
   * structures simply report `'none'`.
   */
  async removeTask(taskId: string): Promise<SchedulerSyncResult> {
    this.assertOpen();
    if (!isValidSchedulerQueueId(taskId)) {
      throw new Error('scheduler task id failed validation');
    }
    const schedulerExisted = await this.jobSchedulerExists(taskId);
    if (schedulerExisted) {
      await this.queue.removeJobScheduler(taskId);
    }
    const onceRemoved = await this.removeOnceJobIfPresent(taskId);
    return {
      recurringScheduler: schedulerExisted ? 'removed' : 'none',
      onceJob: onceRemoved ? 'removed' : 'none',
    };
  }

  /**
   * Enqueues one MANUAL/RETRY execution run. MANUAL/RETRY is the caller's
   * contract (SCHEDULED runs are produced by the scheduler itself). Existing
   * job in ANY state — including failed/completed — means `false`: no
   * duplicate add, no manual re-add of terminal failed executions.
   */
  async enqueueExecution(execution: Pick<AgentTaskExecution, 'id'>): Promise<boolean> {
    this.assertOpen();
    const executionId = execution?.id;
    if (!isValidSchedulerQueueId(executionId)) {
      throw new Error('scheduler execution id failed validation');
    }
    const jobId = schedulerExecutionJobId(executionId);
    const existing = await this.queue.getJob(jobId);
    if (existing !== null && existing !== undefined) {
      return false; // waiting/delayed/active/paused/completed/failed — id taken.
    }
    await this.queue.add(SCHEDULER_EXECUTION_JOB_NAME, { executionId }, {
      ...schedulerJobOptions(),
      jobId,
    });
    return true;
  }

  /**
   * Syncs every task in order (deterministic only — NO catch-up logic, NO
   * execution creation here). Throws on the first failing task.
   */
  async reconcile(tasks: readonly AgentTask[], now?: Date): Promise<SchedulerSyncResult[]> {
    this.assertOpen();
    const results: SchedulerSyncResult[] = [];
    const instant = now ?? new Date();
    for (const task of tasks) {
      results.push(await this.syncTask(task, instant));
    }
    return results;
  }

  /**
   * PINGs Redis with a bounded timeout (startup honesty). No-op when a test
   * injected the queue (no connection to probe).
   */
  async ping(timeoutMs: number = SCHEDULER_PING_TIMEOUT_MS): Promise<void> {
    if (this.connectionOptions === null) {
      return; // injected queue: nothing to check (tests)
    }
    // One-off client this class owns fully: quit (graceful) or disconnect.
    const { Redis: IORedis } = await import('ioredis');
    const client = new IORedis(this.connectionOptions);
    try {
      await connectWithTimeout((c) => c.ping(), client, timeoutMs);
    } finally {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
  }

  /** Closes the BullMQ queue and its sockets; bounded and idempotent. */
  async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), this.closeTimeoutMs);
      void Promise.resolve(this.queue.close?.()).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('scheduler queue is closed');
    }
  }

  private async jobSchedulerExists(jobSchedulerId: string): Promise<boolean> {
    const scheduler = await this.queue.getJobScheduler(jobSchedulerId);
    return scheduler !== null && scheduler !== undefined;
  }

  private async removeOnceJobIfPresent(taskId: string): Promise<boolean> {
    const once = await this.queue.getJob(schedulerOnceJobId(taskId));
    if (once === null || once === undefined) {
      return false;
    }
    await once.remove();
    return true;
  }

  /** Deterministic ONCE sync: dedupe by id+instant, replace on mismatch. */
  private async syncOnceJob(task: AgentTask, now: Date): Promise<SchedulerSyncResult['onceJob']> {
    const scheduledFor = task.nextRunAt;
    if (scheduledFor === null) {
      // Past/exhausted ONCE: adds nothing; any existing job stays (its own
      // state decides whether the worker still runs it).
      return 'none';
    }
    if (!isIsoInstantZ(scheduledFor)) {
      throw new Error('scheduler once instant failed validation');
    }
    const onceId = schedulerOnceJobId(task.id);
    const existing = await this.queue.getJob(onceId);
    if (existing !== null && existing !== undefined) {
      const existingScheduledFor = onceScheduledForOf(existing.data);
      const sameInstant =
        existingScheduledFor !== null &&
        new Date(existingScheduledFor).getTime() === new Date(scheduledFor).getTime();
      if (sameInstant) {
        return 'none'; // deterministic id carries the same instant — no duplicate.
      }
      const state = await existing.getState();
      if (state === 'active') {
        return 'deferred'; // mid-run; a later sync replaces it.
      }
      // Replacement needed: BullMQ ignores an add whose deterministic id is
      // taken, so remove first, then add the fresh instant.
      await existing.remove();
      await this.addOnceJob(task.id, scheduledFor, onceId, now);
      return 'updated';
    }
    await this.addOnceJob(task.id, scheduledFor, onceId, now);
    return 'added';
  }

  private async addOnceJob(taskId: string, scheduledFor: string, onceId: string, now: Date): Promise<void> {
    await this.queue.add(SCHEDULER_TASK_JOB_NAME, { taskId, scheduledFor }, {
      ...schedulerJobOptions(),
      jobId: onceId,
      delay: onceDelayMs(scheduledFor, now),
    });
  }
}
