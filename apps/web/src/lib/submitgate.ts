/**
 * Pure synchronous single-flight submission gate (Phase 4 chat duplicate
 * submission fix).
 *
 * One Enter keypress can reach the chat twice in the same tick: the textarea
 * keydown handler AND the form's implicit submit event (browser automation
 * tools that press Enter, plus double-clicks on Send) both invoke the
 * submit handler, and React's `status`/`canSend` closure has not rerendered
 * in between — so the busy check alone cannot reject the second call.
 *
 * The gate is deliberately dumb and synchronous: the first `tryStart()`
 * wins, every other immediate call is rejected, and `release()` is driven
 * by the component (when `useChat` is no longer submitted/streaming or the
 * send promise rejects). Creating the gate is per-mount state, so an
 * agent/mode remount starts unlocked.
 */
export interface SubmissionGate {
  /** True exactly once until released; false for every concurrent caller. */
  tryStart(): boolean;
  /** Unlock (turn finished/errored). Harmless when already unlocked. */
  release(): void;
  isLocked(): boolean;
}

export function createSubmissionGate(): SubmissionGate {
  let locked = false;
  return {
    tryStart(): boolean {
      if (locked) return false;
      locked = true;
      return true;
    },
    release(): void {
      locked = false;
    },
    isLocked(): boolean {
      return locked;
    },
  };
}
