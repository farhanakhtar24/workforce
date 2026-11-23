/**
 * Delegation vocabulary: target agents, modes, statuses, and the status
 * transition table pinned by the Phase 4 spec.
 *
 * ## Status machine (documented)
 * ```
 * pending -> running
 * running -> completed | failed | timeout
 * completed | failed | timeout  (terminal; only same-status writes allowed)
 * ```
 * Same-status writes are IDEMPOTENT no-ops for the status field (result/error
 * may still be refreshed); a terminal state can never go back to `running` or
 * `pending`. `pending -> completed/failed/timeout` directly is NOT allowed:
 * a delegation passes through `running` first, so sync callers always record
 * the start.
 */

export const delegationTargetAgents = ['analyst', 'researcher'] as const;

/** Workers a parent may delegate to. Orchestrator/general cannot be targets. */
export type DelegationTargetAgent = (typeof delegationTargetAgents)[number];

export const delegationModes = ['sync', 'async'] as const;

export type DelegationMode = (typeof delegationModes)[number];

export const delegationStatuses = ['pending', 'running', 'completed', 'failed', 'timeout'] as const;

export type DelegationStatus = (typeof delegationStatuses)[number];

/** Allowed NEXT statuses per current status (same-status is always allowed). */
export const delegationTransitions: Readonly<Record<DelegationStatus, readonly DelegationStatus[]>> = {
  pending: ['running'],
  running: ['completed', 'failed', 'timeout'],
  completed: [],
  failed: [],
  timeout: [],
};

/** Statuses after which no further transition (besides same-status) exists. */
export const delegationTerminalStatuses = ['completed', 'failed', 'timeout'] as const;

export function isDelegationStatus(value: unknown): value is DelegationStatus {
  return typeof value === 'string' && (delegationStatuses as readonly string[]).includes(value);
}

export function isDelegationTargetAgent(value: unknown): value is DelegationTargetAgent {
  return typeof value === 'string' && (delegationTargetAgents as readonly string[]).includes(value);
}

export function isDelegationMode(value: unknown): value is DelegationMode {
  return typeof value === 'string' && (delegationModes as readonly string[]).includes(value);
}

/**
 * Whether `from -> to` is a legal write: always true when `from === to`
 * (idempotent), otherwise the transition table decides. Terminal states can
 * only rewrite themselves, never leave.
 */
export function canTransitionDelegation(from: DelegationStatus, to: DelegationStatus): boolean {
  if (from === to) {
    return true;
  }
  return (delegationTransitions[from] ?? []).includes(to);
}
