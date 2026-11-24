/**
 * Express-compatible mounting for the Better Auth handler (pre-Phase 6).
 *
 * UNMOUNTED: no module here mutates `src/app.ts` — the Phase 6 integration
 * performs the one-line mount. Contract (verified against the official
 * better-auth@1.7.27 Express integration):
 *
 *   app.all(AUTH_MOUNT_PATTERN, createAuthExpressHandler(auth));
 *
 * - Express v4 pattern: `/api/auth/*` (Express v5 would use `/api/auth/*splat`).
 * - MOUNT BEFORE body-parsing middleware (`express.json()`): Better Auth
 *   reads the raw request stream, so anything that consumes the body first
 *   breaks every POST endpoint. In `src/app.ts` the mount must go ABOVE the
 *   existing `express.json` call — with the auth routes absent, the current
 *   API surface stays byte-compatible.
 * - The returned handler is the official `toNodeHandler(auth)` (Node
 *   `IncomingMessage`/`ServerResponse` are the base types of Express's
 *   `Request`/`Response`, so the handler is typed ready for `app.all`).
 * - CORS stays the shared `corsMiddleware` in `src/app.ts` (only
 *   `webOrigin` gets `Access-Control-Allow-Origin`, credentials-safe).
 */
import { toNodeHandler } from 'better-auth/node';
import type { Request, Response } from 'express';

import type { WorkforceAuth } from './factory.js';

/** Base path under which Better Auth serves its endpoints. */
export const AUTH_MOUNT_PATH = '/api/auth';

/** Exact Express v4 mount pattern (Express v5 equivalent: `/api/auth/*splat`). */
export const AUTH_MOUNT_PATTERN = '/api/auth/*';

/**
 * Express-ready request handler for the Better Auth endpoints.
 * (`req`/`res` widen from Node's primitives; Express is compatible.)
 */
export type AuthExpressHandler = (req: Request, res: Response) => Promise<void>;

/**
 * Builds the unmounted Express handler for one Better Auth instance.
 * Pure: never listens, never awaits a request on its own.
 */
export function createAuthExpressHandler(auth: WorkforceAuth): AuthExpressHandler {
  return toNodeHandler(auth);
}
