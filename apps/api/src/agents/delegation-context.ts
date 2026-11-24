/**
 * Server-signed internal contexts (ADR-004 + pre-Phase 6 owner binding).
 *
 * Trusted depth AND the platform owner can only enter the system through
 * these headers — one HMAC secret signs all of them:
 *
 * - `X-Workforce-Delegation-Context` — compact `base64url(payload).base64url(hmac)`
 *   where the HMAC-SHA256 signature covers the exact payload bytes with the
 *   server secret (env `DELEGATION_CONTEXT_SECRET`, or a throwaway
 *   randomBytes(32) secret minted once per API boot). Carries:
 *   - `delegation-child-chat` — the child chat request payload: `parentChatId`,
 *     `childChatId`, `ownerId` (the Better Auth user this run belongs to),
 *     `targetAgent`, `depth` (the CHILD's depth), `expiresAt` (ms epoch) and
 *     `deadline` (ms epoch, the run's bounded timeout).
 *   - `delegation-create` — the create/run REST calls made from the
 *     orchestrator's own process or the delegation worker: `parentChatId`,
 *     `parentDepth`, `ownerId`, `expiresAt`.
 * - `X-Workforce-Internal-Owner` — carries `internal-owner`: ONE platform
 *   `ownerId` + `expiresAt`. Lets loopback calls (agent tools writing docs,
 *   memory search, internal hydration/resume) act WITH the signed owner
 *   instead of a browser session. Same secret, short TTL.
 * - `X-Workforce-Internal-Scheduler` — carries `internal-scheduler-run`: a
 *   scheduler worker run bound to ONE `taskId`/`executionId` (exactly one
 *   present) + `expiresAt`. It does NOT carry the owner: the run route
 *   derives the owner from the DATABASE ROW (the row is the authority) and
 *   rejects ownerless legacy rows — worker callers never need the owner id.
 *
 * Verification is strict: signature `timingSafeEqual`, exact binding of every
 * field the caller claims (chat ids, target agent, depth, owner, task/exec
 * id), kind, and expiry. Header/payload bytes are NEVER logged; errors carry
 * fixed text. The owner id is NEVER trusted from a request body or an
 * unsigned header anywhere in the API.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DELEGATION_CONTEXT_HEADER = 'X-Workforce-Delegation-Context';
export const INTERNAL_OWNER_HEADER = 'X-Workforce-Internal-Owner';
export const INTERNAL_SCHEDULER_HEADER = 'X-Workforce-Internal-Scheduler';

/** Internal contexts are short-TTL: five minutes regardless of run budget. */
export const DEFAULT_CONTEXT_TTL_MS = 300_000;

/** Max header budget: one small JSON payload + signature. */
export const MAX_CONTEXT_HEADER_LENGTH = 4_000;

export const INTERNAL_OWNER_ID_MAX_LENGTH = 128;

export type DelegationContextKind =
  | 'delegation-child-chat'
  | 'delegation-create'
  | 'internal-owner'
  | 'internal-scheduler-run';

export interface ChildChatContextPayload {
  readonly kind: 'delegation-child-chat';
  readonly parentChatId: string;
  readonly childChatId: string;
  /** The platform user (Better Auth `User.id`) this run belongs to. */
  readonly ownerId: string;
  readonly targetAgent: 'analyst' | 'researcher';
  readonly depth: number;
  readonly expiresAt: number;
  readonly deadline: number;
}

export interface CreateContextPayload {
  readonly kind: 'delegation-create';
  readonly parentChatId: string;
  readonly parentDepth: number;
  /** The platform user (Better Auth `User.id`) this run belongs to. */
  readonly ownerId: string;
  readonly expiresAt: number;
}

export interface InternalOwnerContextPayload {
  readonly kind: 'internal-owner';
  /** The platform user (Better Auth `User.id`) the loopback call acts as. */
  readonly ownerId: string;
  readonly expiresAt: number;
}

export interface InternalSchedulerContextPayload {
  readonly kind: 'internal-scheduler-run';
  /** SCHEDULED occurrence run: the task id (no executionId). */
  readonly taskId?: string;
  /** MANUAL/RETRY run: the execution id (no taskId). */
  readonly executionId?: string;
  readonly expiresAt: number;
}

export type DelegationContextPayload =
  | ChildChatContextPayload
  | CreateContextPayload
  | InternalOwnerContextPayload
  | InternalSchedulerContextPayload;

export interface DelegationContextSigner {
  /** Mints a fresh `headerValue`; the caller owns TTL/deadline math. */
  sign(payload: DelegationContextPayload): string;
  /**
   * Verifies the signature/kind/expiry and (when `expected` is given) the exact
   * binding of declared fields. Returns a fixed-text reason on any failure —
   * no payload bytes, no header bytes.
   */
  verify(
    headerValue: string,
    expected?: {
      kind?: DelegationContextKind;
      parentChatId?: string;
      childChatId?: string;
      targetAgent?: ChildChatContextPayload['targetAgent'];
      childDepth?: number;
      parentDepth?: number;
      ownerId?: string;
      taskId?: string;
      executionId?: string;
    },
  ): { ok: true; payload: DelegationContextPayload } | { ok: false; reason: string };
}

const REASONS = {
  malformed: 'Invalid internal delegation context.',
  expired: 'Internal delegation context expired.',
  kindMismatch: 'Internal delegation context kind mismatch.',
  bindingMismatch: 'Internal delegation context does not match this request.',
} as const;

/** Structural check of the owner id carried by every owner-binding payload. */
function isValidOwnerId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= INTERNAL_OWNER_ID_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function createDelegationContextSigner(secret: Buffer): DelegationContextSigner {
  const signPayload = (payloadJson: string): string => {
    const signature = createHmac('sha256', secret).update(payloadJson, 'utf8').digest();
    return `${base64url(payloadJson)}.${base64url(signature)}`;
  };

  const verifySignature = (headerValue: string): { ok: true; payload: string } | { ok: false } => {
    if (typeof headerValue !== 'string' || headerValue.length === 0 || headerValue.length > MAX_CONTEXT_HEADER_LENGTH) {
      return { ok: false };
    }
    const parts = headerValue.split('.');
    if (parts.length !== 2) {
      return { ok: false };
    }
    const [payloadPart, signaturePart] = parts as [string, string];
    let payloadJson: string;
    let signature: Buffer;
    try {
      payloadJson = Buffer.from(payloadPart, 'base64url').toString('utf8');
      signature = Buffer.from(signaturePart, 'base64url');
    } catch {
      return { ok: false };
    }
    if (signature.length === 0) {
      return { ok: false };
    }
    const expected = createHmac('sha256', secret).update(payloadJson, 'utf8').digest();
    if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
      return { ok: false };
    }
    return { ok: true, payload: payloadJson };
  };

  return {
    sign: (payload: DelegationContextPayload): string =>
      signPayload(JSON.stringify({ ...payload, kind: payload.kind })),

    verify: (headerValue, expected) => {
      const signatureResult = verifySignature(headerValue);
      if (!signatureResult.ok) {
        return { ok: false, reason: REASONS.malformed };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(signatureResult.payload);
      } catch {
        return { ok: false, reason: REASONS.malformed };
      }
      if (payload === null || typeof payload !== 'object') {
        return { ok: false, reason: REASONS.malformed };
      }
      const candidate = payload as Record<string, unknown>;
      if (typeof candidate['expiresAt'] !== 'number' || !Number.isFinite(candidate['expiresAt'])) {
        return { ok: false, reason: REASONS.malformed };
      }
      if (Date.now() > (candidate['expiresAt'] as number)) {
        return { ok: false, reason: REASONS.expired };
      }
      if (expected?.kind !== undefined && candidate['kind'] !== expected.kind) {
        return { ok: false, reason: REASONS.kindMismatch };
      }
      if (expected?.parentChatId !== undefined && candidate['parentChatId'] !== expected.parentChatId) {
        return { ok: false, reason: REASONS.bindingMismatch };
      }
      if (expected?.childChatId !== undefined && candidate['childChatId'] !== expected.childChatId) {
        return { ok: false, reason: REASONS.bindingMismatch };
      }
      if (expected?.targetAgent !== undefined && candidate['targetAgent'] !== expected.targetAgent) {
        return { ok: false, reason: REASONS.bindingMismatch };
      }
      if (expected?.childDepth !== undefined && candidate['depth'] !== expected.childDepth) {
        return { ok: false, reason: REASONS.bindingMismatch };
      }
      if (expected?.parentDepth !== undefined && candidate['parentDepth'] !== expected.parentDepth) {
        return { ok: false, reason: REASONS.bindingMismatch };
      }
      // Owner binding: owner-carrying payloads require a well-formed id, and
      // an expected owner always matches EXACTLY.
      if (expected?.ownerId !== undefined) {
        if (!isValidOwnerId(candidate['ownerId']) || (candidate['ownerId'] as string) !== expected.ownerId) {
          return { ok: false, reason: REASONS.bindingMismatch };
        }
      } else if (candidate['kind'] === 'internal-owner') {
        if (!isValidOwnerId(candidate['ownerId'])) {
          return { ok: false, reason: REASONS.malformed };
        }
      }
      const kind = candidate['kind'];
      if (kind === 'internal-scheduler-run') {
        const hasTask = typeof candidate['taskId'] === 'string' && (candidate['taskId'] as string).length > 0;
        const hasExecution = typeof candidate['executionId'] === 'string' && (candidate['executionId'] as string).length > 0;
        if (hasTask === hasExecution) {
          // Exactly ONE of taskId/executionId must be claimed.
          return { ok: false, reason: REASONS.malformed };
        }
        if (expected?.taskId !== undefined && candidate['taskId'] !== expected.taskId) {
          return { ok: false, reason: REASONS.bindingMismatch };
        }
        if (expected?.executionId !== undefined && candidate['executionId'] !== expected.executionId) {
          return { ok: false, reason: REASONS.bindingMismatch };
        }
      }
      return { ok: true, payload: candidate as unknown as DelegationContextPayload };
    },
  };
}

/** Per-boot throwaway secret when DELEGATION_CONTEXT_SECRET is not configured. */
export function generateEphemeralSecret(): Buffer {
  return randomBytes(32);
}

/** Fixed TTL helper: `expiresAt` at 5 minutes; `deadline` at the run budget. */
export function contextWindow(timeoutMs: number, now = Date.now()): { expiresAt: number; deadline: number } {
  return { expiresAt: now + DEFAULT_CONTEXT_TTL_MS, deadline: now + timeoutMs };
}

/** Convenience: an internal-owner header for one signed mint. */
export function internalOwnerHeader(signer: DelegationContextSigner, ownerId: string, ttlMs = DEFAULT_CONTEXT_TTL_MS): Record<string, string> {
  return {
    [INTERNAL_OWNER_HEADER]: signer.sign({
      kind: 'internal-owner',
      ownerId,
      expiresAt: Date.now() + ttlMs,
    }),
  };
}

