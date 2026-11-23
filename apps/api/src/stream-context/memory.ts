/**
 * In-memory `StreamContext` with the exact semantics required from the
 * `resumable-stream` adapter, for tests:
 * - records the full stream durably (in the returned promise's resolution),
 * - full replay from the start (never deltas),
 * - `null` for finished streams, `undefined` for unknown streams.
 *
 * `createNewResumableStream` settles only after the source has been fully
 * recorded — deterministic for tests; the production adapter settles at
 * registration time and keeps pumping as a tracked background task (the
 * library tracks its own pump through our `waitUntil`).
 */
import type { StreamContext } from './types.js';

export interface InMemoryStreamState {
  /** Recorded chunk sequences by stream ID, in order. */
  readonly streams: Map<string, string[]>;
  /** Stream IDs whose source has fully finished. */
  readonly done: Set<string>;
}

export interface InMemoryStreamContext extends StreamContext {
  readonly state: InMemoryStreamState;
}

export function createInMemoryStreamContext(): InMemoryStreamContext {
  const state: InMemoryStreamState = {
    streams: new Map(),
    done: new Set(),
  };
  return {
    state,
    async createNewResumableStream(streamId, streamSource) {
      const chunks: string[] = [];
      state.streams.set(streamId, chunks);
      const source = streamSource();
      const reader = source.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          state.done.add(streamId);
          break;
        }
        chunks.push(value ?? '');
      }
      return new ReadableStream<string>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
    },
    async resumeExistingStream(streamId) {
      const chunks = state.streams.get(streamId);
      if (chunks === undefined) {
        return undefined;
      }
      if (state.done.has(streamId)) {
        return null;
      }
      return new ReadableStream<string>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
    },
  };
}

/** Concatenates a Web stream of strings fully (test helper). */
export async function drainTextStream(stream: ReadableStream<string>): Promise<string> {
  let text = '';
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += value;
  }
  return text;
}
