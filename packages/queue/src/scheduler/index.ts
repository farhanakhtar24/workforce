/**
 * Public API of the scheduler bridge: `@workforce/queue/scheduler`.
 *
 * Everything the Phase 5 host needs to keep the `workforce-scheduler` BullMQ
 * queue in lockstep with `@workforce/core/scheduler` domain rows: constants,
 * payload/run-contract types, pure job helpers, the {@link BullMQSchedulerQueue},
 * and the {@link createSchedulerWorker} entry point — plus the package-local
 * Redis option plumbing (never imports app code).
 */

export * from './constants.js';
export * from './types.js';
export * from './job-helpers.js';
export * from './queue.js';
export * from './worker.js';

export type { RedisReconnectStrategy } from '../redis-options.js';
export { connectWithTimeout, redisConnectionOptions } from '../redis-options.js';
export type { SchedulerLogger } from '../logger.js';
