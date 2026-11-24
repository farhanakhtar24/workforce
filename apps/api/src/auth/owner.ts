/**
 * Owner resolution middleware (pre-Phase 6 authentication).
 *
 * ONE trust contract for every non-public API route:
 * - BROWSER requests resolve their owner ONLY from the Better Auth session
 *   (`auth.api.getSession({ headers: fromNodeHeaders(req.headers) })`) —
 *   never from a body/query field or an unsigned header. No session → fixed
 *   401 `Authentication required.`, no existence oracle, no data access.
 * - The optional email allowlist (`AUTH_EMAIL_ALLOWLIST`) is enforced on the
 *   SESSION OWNER at every request (sign-in/session access included): a
 *   non-allowlisted email gets a fixed 403 `Access denied.` and no data.
 * - INTERNAL calls (loopback tools, delegation children, scheduler runs)
 *   carry a server-SIGNED owner context (`delegation-context.ts`): the
 *   `delegation-child-chat` header on child chat POSTs or the
 *   `internal-owner` header on hydration/resume/memory reads. The signature
 *   + expiry + exact owner binding make them unforgeable; the owner id is
 *   NEVER trusted from a request body or an unsigned header.
 * - A browser session AND an internal context with DIFFERENT owners is a
 *   fixed 400 (forged/ambiguous request), never a fallback to either.
 * - Test injection flows through `buildApp` deps only (`staticOwner`):
 *   production wiring never passes it, so a production boot without a valid
 *   auth config has NO route that bypasses authentication.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';

import {
  DELEGATION_CONTEXT_HEADER,
  INTERNAL_OWNER_HEADER,
  type DelegationContextSigner,
} from '../agents/delegation-context.js';
import type { SafeLogger } from '../logging.js';
import type { WorkforceAuth } from './factory.js';

/** The resolved platform owner driving one request. */
export interface AuthOwner {
  /** Better Auth `User.id` (TEXT). */
  readonly userId: string;
  /** Session email ('' for internal signed owners — the row is the truth). */
  readonly email: string;
  readonly emailVerified: boolean;
}

export const AUTH_401_MESSAGE = 'Authentication required.';
export const AUTH_403_MESSAGE = 'Access denied.';
export const AUTH_OWNER_MISMATCH_MESSAGE = 'Authentication context mismatch.';

/** Reads the auth owner the requireOwner middleware attached (or null). */
export function ownerOf(res: Response): AuthOwner | null {
  const owner = res.locals?.['owner'];
  if (owner === null || owner === undefined || typeof owner !== 'object') {
    return null;
  }
  const candidate = owner as Partial<AuthOwner>;
  if (typeof candidate.userId !== 'string' || candidate.userId.length === 0) {
    return null;
  }
  return { userId: candidate.userId, email: candidate.email ?? '', emailVerified: candidate.emailVerified === true };
}

function fixedError(res: Response, status: 400 | 401 | 403, message: string): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: message }));
}

/**
 * Extracts the owner from one signed internal header (any owner-carrying
 * kind: `internal-owner`, `delegation-create`, `delegation-child-chat`). A
 * missing header is `none`; a present-but-forged/incomplete one is an error.
 */
function internalOwnerFromHeader(
  signer: DelegationContextSigner,
  headerValue: string | undefined,
): { kind: 'none' } | { kind: 'ok'; owner: AuthOwner } | { kind: 'error' } {
  if (typeof headerValue !== 'string' || headerValue.length === 0) {
    return { kind: 'none' };
  }
  const verified = signer.verify(headerValue);
  if (!verified.ok) {
    return { kind: 'error' };
  }
  const payload = verified.payload;
  if (payload.kind === 'internal-owner' || payload.kind === 'delegation-create' || payload.kind === 'delegation-child-chat') {
    return { kind: 'ok', owner: { userId: payload.ownerId, email: '', emailVerified: false } };
  }
  return { kind: 'error' };
}

/**
 * All signed internal headers on one request must agree on the SAME owner
 * (e.g. a delegation create call also carries its internal-owner header).
 * A mismatch is a fixed 400; no signed header at all is `none` (the plain
 * 401/no-internal path applies downstream).
 */
function internalOwnerPair(
  signer: DelegationContextSigner | undefined,
  delegationHeader: string | undefined,
  internalHeader: string | undefined,
): { kind: 'none' } | { kind: 'ok'; owner: AuthOwner } | { kind: 'error'; status: 400 | 401 } {
  if (signer === undefined) {
    return { kind: 'none' };
  }
  const fromDelegation = internalOwnerFromHeader(signer, delegationHeader);
  const fromInternal = internalOwnerFromHeader(signer, internalHeader);
  if (fromDelegation.kind === 'error' || fromInternal.kind === 'error') {
    return { kind: 'error', status: 400 };
  }
  if (fromDelegation.kind === 'none' && fromInternal.kind === 'none') {
    return { kind: 'none' };
  }
  const first = fromDelegation.kind === 'ok' ? fromDelegation.owner : (fromInternal as { kind: 'ok'; owner: AuthOwner }).owner;
  const second = fromInternal.kind === 'ok' ? fromInternal.owner : null;
  if (second !== null && first.userId !== second.userId) {
    return { kind: 'error', status: 400 };
  }
  return { kind: 'ok', owner: first };
}

/** A Better Auth instance the middleware resolves browser sessions with. */
export interface RequireOwnerAuthDeps {
  readonly auth: WorkforceAuth;
  /**
   * Parsed `AUTH_EMAIL_ALLOWLIST` (empty = disabled). Enforced on browser
   * sessions at EVERY gated request; internal signed owners were minted
   * from an allowlisted identity at their entry point.
   */
  readonly emailAllowlist: readonly string[];
  /** Signs/verifies the internal owner contexts (loopback + child chats). */
  readonly signer?: DelegationContextSigner;
  /** Safe logger (production); absence keeps the middleware silent. */
  readonly logger?: SafeLogger;
}

/** Explicit per-test injection; production wiring never provides it. */
export interface StaticOwnerInjection {
  readonly staticOwner: AuthOwner;
}

/**
 * Builds the `requireOwner` middleware for one app instance. With a real
 * Better Auth instance the browser session is the only production identity;
 * `staticOwner` exists ONLY for test injection through buildApp deps.
 */
export function createRequireOwner(options: RequireOwnerAuthDeps | StaticOwnerInjection): RequestHandler {
  if ('staticOwner' in options) {
    const owner = options.staticOwner;
    return (_req: Request, res: Response, next: NextFunction): void => {
      res.locals['owner'] = owner;
      next();
    };
  }
  const { auth, emailAllowlist, signer, logger } = options;
  const allowlist = [...emailAllowlist];
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      const headers = fromNodeHeaders(req.headers);
      interface SessionUserShape {
        id?: unknown;
        email?: unknown;
        emailVerified?: unknown;
      }
      interface SessionShape {
        user?: SessionUserShape | null;
      }
      let session: SessionShape | null = null;
      try {
        session = (await auth.api.getSession({ headers })) as unknown as SessionShape | null;
      } catch {
        // A failed session read is a fixed 401 — never provider/store text,
        // and never a fallback to unauthenticated access.
        fixedError(res, 401, AUTH_401_MESSAGE);
        return;
      }
      const sessionUser = session === null ? null : session.user ?? null;
      const delegationHeader = signer === undefined ? undefined : req.get(DELEGATION_CONTEXT_HEADER);
      const internalHeader = signer === undefined ? undefined : req.get(INTERNAL_OWNER_HEADER);

      const sessionOwner: AuthOwner | null =
        sessionUser !== null &&
        typeof sessionUser.id === 'string' && sessionUser.id.length > 0 &&
        typeof sessionUser.email === 'string'
          ? { userId: sessionUser.id, email: sessionUser.email, emailVerified: sessionUser.emailVerified === true }
          : null;

      let internalOwner: AuthOwner | null = null;
      const internal = internalOwnerPair(signer, delegationHeader, internalHeader);
      if (internal.kind === 'ok') {
        internalOwner = internal.owner;
      } else if (internal.kind === 'error') {
        // A PRESENT signed header that failed signature/binding/verify is a
        // fixed 400 REGARDLESS of a browser session (forged, expired,
        // ambiguous) — a valid session never rescues an invalid internal
        // context. A genuinely ABSENT header stays the normal paths below.
        fixedError(res, 400, AUTH_OWNER_MISMATCH_MESSAGE);
        return;
      }

      if (sessionOwner !== null && internalOwner !== null && sessionOwner.userId !== internalOwner.userId) {
        fixedError(res, 400, AUTH_OWNER_MISMATCH_MESSAGE);
        return;
      }

      const owner = sessionOwner ?? internalOwner;
      if (owner === null) {
        fixedError(res, 401, AUTH_401_MESSAGE);
        return;
      }
      if (sessionOwner !== null && allowlist.length > 0 && !allowlist.includes(owner.email.toLowerCase())) {
        fixedError(res, 403, AUTH_403_MESSAGE);
        return;
      }
      res.locals['owner'] = owner;
      next();
    })().catch((error: unknown) => {
      // Never leak resolver internals; any failure denies access.
      logger?.error('owner-resolution-failed', error);
      fixedError(res, 401, AUTH_401_MESSAGE);
    });
  };
}
