/**
 * Server-signed internal delegation context (ADR-004).
 *
 * Trusted depth can only enter the system through this header:
 * `X-Workforce-Delegation-Context` — a compact `base64url(payload).base64url(hmac)`
 * pair where the HMAC-SHA256 signature covers the exact payload bytes with the
 * server secret (env `DELEGATION_CONTEXT_SECRET`, or a throwaway randomBytes(32)
 * secret minted once per API boot).
 *
 * Two payload kinds:
 * - `delegation-child-chat` — carried by the child chat request. Binds
 *   `parentChatId`, `childChatId`, `targetAgent`, `depth` (the CHILD's depth),
 *   `expiresAt` (ms epoch) and `deadline` (ms epoch, the run's bounded timeout).
 * - `delegation-create` — carried by the create/run REST calls made from the
 *   orchestrator's own process. Binds `parentChatId`, `parentDepth`,
 *   `expiresAt`.
 *
 * Verification is strict: signature `timingSafeEqual`, exact binding of every
 * field the caller claims (chat id, target agent, depth), kind, and expiry.
 * The header value and payload bytes are NEVER logged; errors carry fixed text.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DELEGATION_CONTEXT_HEADER = 'X-Workforce-Delegation-Context';

/** Internal contexts are short-TTL: five minutes regardless of run budget. */
export const DEFAULT_CONTEXT_TTL_MS = 300_000;

/** Max header budget: one small JSON payload + signature. */
export const MAX_CONTEXT_HEADER_LENGTH = 4_000;

export type DelegationContextKind = 'delegation-child-chat' | 'delegation-create';

export interface ChildChatContextPayload {
  readonly kind: 'delegation-child-chat';
  readonly parentChatId: string;
  readonly childChatId: string;
  readonly targetAgent: 'analyst' | 'researcher';
  readonly depth: number;
  readonly expiresAt: number;
  readonly deadline: number;
}

export interface CreateContextPayload {
  readonly kind: 'delegation-create';
  readonly parentChatId: string;
  readonly parentDepth: number;
  readonly expiresAt: number;
}

export type DelegationContextPayload = ChildChatContextPayload | CreateContextPayload;

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
    },
  ): { ok: true; payload: DelegationContextPayload } | { ok: false; reason: string };
}

const REASONS = {
  malformed: 'Invalid internal delegation context.',
  expired: 'Internal delegation context expired.',
  kindMismatch: 'Internal delegation context kind mismatch.',
  bindingMismatch: 'Internal delegation context does not match this request.',
} as const;

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
