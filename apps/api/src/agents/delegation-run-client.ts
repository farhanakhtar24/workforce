/**
 * The async delegation worker's run client (Phase 4): executes delegations
 * THROUGH the own REST surface — never by generating a child directly.
 *
 * One run: GET the delegation row (its parent chat/depth bound the internal
 * header) → mint a fresh signed `delegation-create` context → POST
 * `/api/agents/{parentSlug}/delegations/{id}/run`. The run route performs the
 * child chat via the same endpoint humans use (ADR-002/ADR-004) and owns all
 * row-state idempotency, so retried jobs cannot double-run a delegation.
 *
 * Failures return `false` (BullMQ retries with attempts/backoff); the row
 * itself is never touched here. No URLs, headers, or bodies are logged.
 */
import {
  DELEGATION_CONTEXT_HEADER,
  contextWindow,
  type DelegationContextSigner,
} from './delegation-context.js';
import type { FetchLike } from './host-capabilities.js';
import type { DelegationRunJobClient } from './delegation-queue.js';
import { delegationRestTimeoutMs } from './host-capabilities.js';

export interface DelegationRunClientOptions {
  readonly signer: DelegationContextSigner;
  readonly fetchFn: FetchLike;
  readonly baseUrl: string;
  readonly delegationTimeoutMs: number;
}

function delegationDetailUrl(baseUrl: string, parentSlug: string, delegationId: string): string {
  return `${baseUrl}/api/agents/${encodeURIComponent(parentSlug)}/delegations/${encodeURIComponent(delegationId)}`;
}

function delegationRunUrl(baseUrl: string, parentSlug: string, delegationId: string): string {
  return `${baseUrl}/api/agents/${encodeURIComponent(parentSlug)}/delegations/${encodeURIComponent(delegationId)}/run`;
}

interface DelegationRowShape {
  readonly parentChatId?: unknown;
  readonly parentDepth?: unknown;
  readonly depth?: unknown;
}

export function createDelegationRunJobClient(options: DelegationRunClientOptions): DelegationRunJobClient {
  const { signer, fetchFn, baseUrl, delegationTimeoutMs } = options;
  // Shared margin (B2): the run POST carries the full budget + TOOL_RUN_MARGIN_MS
  // via delegationRestTimeoutMs — never a hardwired literal.
  const runBudgetMs = delegationRestTimeoutMs(delegationTimeoutMs);
  return {
    async run(delegationId: string, parentSlug: string): Promise<boolean> {
      try {
        const detail = await fetchFn(delegationDetailUrl(baseUrl, parentSlug, delegationId), {
          method: 'GET',
          signal: AbortSignal.timeout(Math.min(runBudgetMs, 30_000)),
        });
        if (!detail.ok) {
          // 404 etc.: the delegation vanished; a retry would only repeat it.
          return false;
        }
        const body = (await detail.json()) as { delegation?: DelegationRowShape };
        const row = body?.delegation;
        if (row === null || row === undefined || typeof row.parentChatId !== 'string' || typeof row.depth !== 'number') {
          return false;
        }
        const window = contextWindow(delegationTimeoutMs);
        const header = signer.sign({
          kind: 'delegation-create',
          parentChatId: row.parentChatId,
          parentDepth: row.depth - 1,
          expiresAt: window.expiresAt,
        });
        const response = await fetchFn(delegationRunUrl(baseUrl, parentSlug, delegationId), {
          method: 'POST',
          headers: { [DELEGATION_CONTEXT_HEADER]: header },
          signal: AbortSignal.timeout(runBudgetMs),
        });
        return response.ok;
      } catch {
        // Transient failure: throw-free false lets BullMQ's backoff retry.
        return false;
      }
    },
  };
}
