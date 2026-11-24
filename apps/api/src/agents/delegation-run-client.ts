/**
 * The async delegation worker's run client (Phase 4 + pre-Phase 6 owners):
 * executes delegations THROUGH the own REST surface — never by generating a
 * child directly.
 *
 * One run: the job payload carries the owner (`DelegationJobData.ownerId`,
 * persisted by BullMQ, so restarted jobs recover the SAME owner) → mint a
 * fresh signed `delegation-create` context + `internal-owner` header bound
 * to that owner → GET the delegation detail (owner-guarded; a foreign/ownerless
 * row reads as 404) → POST the run route. The run route re-verifies the
 * signed context against the ROW (owner binding included) and performs the
 * child chat through the same endpoint humans use (ADR-002/ADR-004), owning
 * all row-state idempotency, so retried jobs cannot double-run.
 *
 * Failures return `false` (BullMQ retries with attempts/backoff); the row
 * itself is never touched here. No URLs, headers, or bodies are logged.
 */
import {
  DELEGATION_CONTEXT_HEADER,
  contextWindow,
  internalOwnerHeader,
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
  readonly ownerId?: unknown;
}

export function createDelegationRunJobClient(options: DelegationRunClientOptions): DelegationRunJobClient {
  const { signer, fetchFn, baseUrl, delegationTimeoutMs } = options;
  // Shared margin (B2): the run POST carries the full budget + TOOL_RUN_MARGIN_MS
  // via delegationRestTimeoutMs — never a hardwired literal.
  const runBudgetMs = delegationRestTimeoutMs(delegationTimeoutMs);
  return {
    async run(delegationId: string, parentSlug: string, ownerId: string): Promise<boolean> {
      if (typeof ownerId !== 'string' || ownerId.length === 0) {
        // No owner in the payload: the run could never be bound — refuse.
        return false;
      }
      try {
        // SIGNED internal owner: the (browser-gated) detail route resolves
        // the same identity the job was created for.
        const detail = await fetchFn(delegationDetailUrl(baseUrl, parentSlug, delegationId), {
          method: 'GET',
          headers: internalOwnerHeader(signer, ownerId),
          signal: AbortSignal.timeout(Math.min(runBudgetMs, 30_000)),
        });
        if (!detail.ok) {
          // 404 etc.: the delegation vanished (or belongs to nobody the
          // signed name can prove): a retry would only repeat it.
          return false;
        }
        const body = (await detail.json()) as { delegation?: DelegationRowShape };
        const row = body?.delegation;
        if (
          row === null || row === undefined ||
          typeof row.parentChatId !== 'string' ||
          typeof row.depth !== 'number' ||
          typeof row.ownerId !== 'string' ||
          row.ownerId !== ownerId
        ) {
          // The row's owner must EXACTLY match the signed payload owner.
          return false;
        }
        const window = contextWindow(delegationTimeoutMs);
        const header = signer.sign({
          kind: 'delegation-create',
          parentChatId: row.parentChatId,
          parentDepth: row.depth - 1,
          ownerId,
          expiresAt: window.expiresAt,
        });
        const response = await fetchFn(delegationRunUrl(baseUrl, parentSlug, delegationId), {
          method: 'POST',
          headers: { [DELEGATION_CONTEXT_HEADER]: header, ...internalOwnerHeader(signer, ownerId) },
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
