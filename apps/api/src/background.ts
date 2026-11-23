/**
 * Tracked background promises — the Express replacement for Next's `after()`
 * (ADR-005). Every detached task (resumable-stream checkpoint pumping,
 * persistence) is registered here so graceful shutdown can await it within a
 * bounded time instead of killing work mid-write.
 */
export interface BackgroundTaskTracker {
  /** Registers a promise; never throws it. Rejections are contained by `onError`. */
  track(promise: Promise<unknown>): void;
  /** Resolves when all tracked promises settle, or when `timeoutMs` elapses. */
  waitForAll(timeoutMs: number): Promise<void>;
  /** Number of still-pending tracked promises. */
  readonly pendingCount: number;
}

export interface CreateBackgroundTrackerOptions {
  /** Called with a rejected tracked promise. Must not throw. */
  onError?: (error: unknown) => void;
}

export function createBackgroundTracker(options: CreateBackgroundTrackerOptions = {}): BackgroundTaskTracker {
  const onError = options.onError ?? (() => undefined);
  const tasks = new Set<Promise<unknown>>();

  return {
    track(promise: Promise<unknown>): void {
      const wrapped = promise
        .catch((error: unknown) => {
          try {
            onError(error);
          } catch {
            // onError must never break housekeeping.
          }
        })
        .finally(() => {
          tasks.delete(wrapped);
        });
      tasks.add(wrapped);
    },
    get pendingCount(): number {
      return tasks.size;
    },
    async waitForAll(timeoutMs: number): Promise<void> {
      if (tasks.size === 0) {
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      try {
        // Race, never wait: newly tracked tasks get whatever budget remains.
        await Promise.race([Promise.allSettled([...tasks]), timeout]).then(() => undefined);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
