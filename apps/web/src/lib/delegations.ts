/**
 * Pure, testable client helpers for the Phase 4 delegation UI.
 *
 * Contract source of truth: `apps/api/src/agents/delegation-routes.ts` +
 * `packages/core/src/delegation/`.
 *
 * - GET /api/agents/orchestrator/delegations?parentChatId=…&limit=  list, newest first
 *   (parentChatId is REQUIRED by the route — the list is always scoped to one
 *   parent chat, so no other chat's delegations can leak in).
 * - GET /api/agents/orchestrator/delegations/:id  detail (not used by the UI:
 *   the list response already carries the full row; no manual retry/re-run
 *   exists anywhere here — a completed child must never be regenerated).
 *
 * Polling rule (mirrors /memory): poll ONLY while a rendered row is still
 * `pending`/`running`, only while the tab is visible, and never overlapping.
 */
import {
  MEMORY_TEXT_LIMIT,
  extractApiErrorMessage,
  formatDateTime,
  UUID_PATTERN,
  truncateMemoryText,
} from './memory';
import { isSafeChatId, browserApiFetch, requestAuthError } from './api';
import { childChatUrl } from './agents';

/** The delegation route namespace belongs to the orchestrator. */
export const DELEGATION_SLUG = 'orchestrator';

export const DELEGATION_STATUSES = ['pending', 'running', 'completed', 'failed', 'timeout'] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];
export const DELEGATION_TARGETS = ['analyst', 'researcher'] as const;
export type DelegationTarget = (typeof DELEGATION_TARGETS)[number];
export const DELEGATION_MODES = ['sync', 'async'] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

/** Route bound: list limit 1..100, default 20. */
export const DELEGATION_LIST_LIMIT_MIN = 1;
export const DELEGATION_LIST_LIMIT_MAX = 100;
/** Child-composition depth carried on each row (1 or 2). */
export const DELEGATION_DEPTH_MAX = 2;

/** parentChatId schema: 1..64 chars of A-Za-z0-9_- (route-verified). */
export function isParentChatId(value: unknown): value is string {
  return typeof value === 'string' && isSafeChatId(value);
}

export function isDelegationStatus(value: unknown): value is DelegationStatus {
  return typeof value === 'string' && (DELEGATION_STATUSES as readonly string[]).includes(value);
}

export function isDelegationTarget(value: unknown): value is DelegationTarget {
  return typeof value === 'string' && (DELEGATION_TARGETS as readonly string[]).includes(value);
}

export function isDelegationMode(value: unknown): value is DelegationMode {
  return typeof value === 'string' && (DELEGATION_MODES as readonly string[]).includes(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                            */
/* ------------------------------------------------------------------ */

export function delegationsListEndpoint(apiBaseUrl: string, query?: string): string {
  return `${apiBaseUrl}/api/agents/${DELEGATION_SLUG}/delegations${query ?? ''}`;
}

/** Encoded query for the list route; `parentChatId` is required and bounded. */
export function buildDelegationsListQuery(filters: { parentChatId?: string; limit?: number }): string {
  const parentChatId = filters.parentChatId?.trim() ?? '';
  if (!isParentChatId(parentChatId)) return '';
  const params = new URLSearchParams({ parentChatId });
  if (
    typeof filters.limit === 'number' &&
    Number.isInteger(filters.limit) &&
    filters.limit >= DELEGATION_LIST_LIMIT_MIN &&
    filters.limit <= DELEGATION_LIST_LIMIT_MAX
  ) {
    params.set('limit', String(filters.limit));
  }
  return `?${params.toString()}`;
}

/* ------------------------------------------------------------------ */
/* Response validation                                                  */
/* ------------------------------------------------------------------ */

export type DelegationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Delegation {
  id: string;
  scope: string;
  parentChatId: string;
  childChatId: string;
  parentMessageId: string;
  targetAgent: DelegationTarget;
  mode: DelegationMode;
  status: DelegationStatus;
  task: string;
  /** Trimmed server text (≤100k); displayed bounded. */
  result: string | null;
  /** Trimmed safe host text (≤1000). */
  error: string | null;
  depth: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export function mapDelegation(raw: unknown): DelegationResult<Delegation> {
  if (raw === null || typeof raw !== 'object') return { ok: false, error: DELEGATION_LIST_ERROR };
  const row = raw as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    !UUID_PATTERN.test(row.id) ||
    typeof row.parentChatId !== 'string' ||
    !isParentChatId(row.parentChatId) ||
    typeof row.childChatId !== 'string' ||
    row.parentChatId.length === 0 ||
    row.childChatId.length === 0 ||
    typeof row.parentMessageId !== 'string' ||
    row.parentMessageId.length === 0 ||
    !isDelegationTarget(row.targetAgent) ||
    !isDelegationMode(row.mode) ||
    !isDelegationStatus(row.status) ||
    typeof row.task !== 'string' ||
    row.task.length === 0 ||
    (row.result !== null && typeof row.result !== 'string') ||
    (row.error !== null && typeof row.error !== 'string') ||
    typeof row.depth !== 'number' ||
    !Number.isInteger(row.depth) ||
    row.depth < 1 ||
    row.depth > DELEGATION_DEPTH_MAX ||
    !isTimestamp(row.createdAt) ||
    !isTimestamp(row.updatedAt) ||
    (row.completedAt !== null && !isTimestamp(row.completedAt))
  ) {
    return { ok: false, error: DELEGATION_LIST_ERROR };
  }
  return {
    ok: true,
    value: {
      id: row.id,
      scope: typeof row.scope === 'string' && row.scope.length > 0 ? row.scope : 'default',
      parentChatId: row.parentChatId,
      childChatId: row.childChatId,
      parentMessageId: row.parentMessageId,
      targetAgent: row.targetAgent,
      mode: row.mode,
      status: row.status,
      task: row.task,
      result: row.result === null || typeof row.result === 'string' ? row.result : null,
      error: row.error === null || typeof row.error === 'string' ? row.error : null,
      depth: row.depth,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt === null || typeof row.completedAt === 'string' ? row.completedAt : null,
    },
  };
}

export type DelegationListFetchResult =
  | { ok: true; delegations: Delegation[] }
  | { ok: false; error: string };

/* GET …/delegations?parentChatId=… → { delegations } */
export function mapDelegationsResponse(
  raw: unknown,
  error: string = DELEGATION_LIST_ERROR,
): DelegationListFetchResult {
  if (raw === null || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).delegations)) {
    return { ok: false, error };
  }
  const rows: Delegation[] = [];
  for (const entry of (raw as { delegations: unknown[] }).delegations) {
    const mapped = mapDelegation(entry);
    if (!mapped.ok) return { ok: false, error };
    rows.push(mapped.value);
  }
  return { ok: true, delegations: rows };
}

/* ------------------------------------------------------------------ */
/* Poll predicate + labels                                             */
/* ------------------------------------------------------------------ */

/**
 * Poll only while at least one rendered delegation is still pending/running.
 * Completed/failed/timeout rows are terminal — no polling for them.
 */
export function hasActiveDelegations(rows: readonly Delegation[]): boolean {
  return rows.some((row) => row.status === 'pending' || row.status === 'running');
}

export function delegationStatusLabel(status: DelegationStatus): string {
  switch (status) {
    case 'pending':
      return 'Waiting to start';
    case 'running':
      return 'Child chat running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'timeout':
      return 'Timed out';
  }
}

export function formatDelegationTime(value: string | null, fallback = '(not set)'): string {
  if (value === null) return fallback;
  return formatDateTime(value, '(unknown)');
}

/* ------------------------------------------------------------------ */
/* Safe errors + request plumbing                                       */
/* ------------------------------------------------------------------ */

export const DELEGATION_FALLBACK_ERROR = 'Something went wrong. Please try again.';
export const DELEGATION_LIST_ERROR = 'Delegations are temporarily unavailable. Refresh to retry.';

/**
 * Child-chat URL — shown ONLY when the chat id is a safe UUID (the API
 * assigns a stable UUID when the delegation row is created). The child runs
 * under its target agent slug, so the link lands on that agent's transcript.
 */
export function childChatUrlFor(
  childChatId: string,
  targetAgent: string,
): { href: string } | null {
  if (!isSafeChatId(childChatId)) return null;
  const href = childChatUrl(childChatId, targetAgent);
  return href === null ? null : { href };
}

export interface DelegationFetch {
  (
    input: string,
    init?: {
      method?: 'GET';
      cache?: 'no-store';
      headers?: Record<string, string>;
    },
  ): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
}

export async function fetchDelegations(options: {
  apiBaseUrl: string;
  parentChatId: string;
  limit?: number;
  fetchImpl?: DelegationFetch;
}): Promise<DelegationListFetchResult> {
  const { apiBaseUrl, limit, fetchImpl = browserApiFetch } = options;
  const query = buildDelegationsListQuery({ parentChatId: options.parentChatId, limit });
  if (query === '') {
    return { ok: false, error: 'Delegations are listed per chat — open this page from a chat’s Delegations link.' };
  }
  try {
    const response = await fetchImpl(delegationsListEndpoint(apiBaseUrl, query), {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      const authError = requestAuthError(response.status ?? 0);
      if (authError !== null) return { ok: false, error: authError };
      let raw: unknown = null;
      try {
        raw = await response.json();
      } catch {
        raw = null;
      }
      return { ok: false, error: extractApiErrorMessage(raw, DELEGATION_LIST_ERROR) };
    }
    return mapDelegationsResponse(await response.json());
  } catch {
    return { ok: false, error: DELEGATION_LIST_ERROR };
  }
}

/** Bounded display of task / result / error text on the cards. */
export { truncateMemoryText as truncateDelegationText, MEMORY_TEXT_LIMIT as DELEGATION_TEXT_LIMIT };
