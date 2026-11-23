import { createResumableStreamContext } from 'resumable-stream';
import type { CreateResumableStreamContextOptions, StreamContext } from './types.js';

export const STREAM_KEY_PREFIX = 'workforce:phase2:stream';

/**
 * Production `StreamContext` backed by `resumable-stream` + Redis.
 *
 * `publisher`/`subscriber` must be dedicated node-redis clients (a connection
 * used for pub/sub cannot multiplex regular commands). They are passed in —
 * not created from REDIS_URL inside the library — so one place owns the Redis
 * lifecycle and tests can wire fakes.
 */
export function createResumableStreamAdapter(
  options: Omit<CreateResumableStreamContextOptions, 'keyPrefix'> & { keyPrefix?: string },
): StreamContext {
  const context = createResumableStreamContext({
    keyPrefix: options.keyPrefix ?? STREAM_KEY_PREFIX,
    waitUntil: options.waitUntil,
    publisher: options.publisher as never,
    subscriber: options.subscriber as never,
    ...(options.doneWatchdogIntervalMs === undefined
      ? {}
      : { doneWatchdogIntervalMs: options.doneWatchdogIntervalMs }),
  });
  return {
    async createNewResumableStream(streamId, streamSource) {
      return context.createNewResumableStream(streamId, streamSource);
    },
    async resumeExistingStream(streamId) {
      return context.resumeExistingStream(streamId);
    },
  };
}
