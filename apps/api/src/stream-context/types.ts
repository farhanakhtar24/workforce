/**
 * Abstracts `resumable-stream` behind a small injectable interface
 * (ADR-005). The server only needs two operations:
 * - `createNewResumableStream`: checkpoint a fresh SSE stream into durable
 *   storage so a later GET can replay it in full.
 * - `resumeExistingStream`: replay an existing stream, full replay by design
 *   (`resumeStreamIsReplay` default of the library; ADR-008).
 *
 * `ReadableStream` here is the Web `ReadableStream<string>` of serialized SSE
 * text (`data: {...}\n\n` frames), matching both `consumeSseStream` and the
 * library's return type.
 */
export interface StreamContext {
  /**
   * Starts a durable copy of `streamSource()`. Resolves once registration is
   * done; the returned stream is the live copy (consumed during shutdown /
   * by tests, not by the HTTP response, which streams the original).
   */
  createNewResumableStream(
    streamId: string,
    streamSource: () => ReadableStream<string>,
  ): Promise<ReadableStream<string> | null>;

  /**
   * Replays a previously created stream. Returns `null` when the stream
   * exists but is fully finished, `undefined` when it never existed.
   * Returns the **full** buffered replay — never a delta-only protocol.
   */
  resumeExistingStream(streamId: string): Promise<ReadableStream<string> | null | undefined>;
}

/** Options for the production `resumable-stream`-backed context. */
export interface CreateResumableStreamContextOptions {
  /**
   * Tracked-background entry point (`background.track`). Express has no
   * Next-style `after()`, so checkpoint pumping is registered here (ADR-005).
   */
  waitUntil: (promise: Promise<unknown>) => void;
  /** Key prefix inside Redis, namespaced for Workforce Phase 2. */
  keyPrefix: string;
  /** node-redis publisher client (dedicated connection; see README). */
  publisher: unknown;
  /** node-redis subscriber client (dedicated connection; see README). */
  subscriber: unknown;
  /** Interval at which resumed streams re-check the durable DONE sentinel. */
  doneWatchdogIntervalMs?: number;
}
