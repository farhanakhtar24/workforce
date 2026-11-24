/**
 * Better Auth instance factory for @workforce/api (pre-Phase 6).
 *
 * UNMOUNTED: this module builds the Better Auth application handler but
 * touches no Express app and listens nowhere — `src/app.ts`/`src/server.ts`
 * wiring happens in the Phase 6 integration step (see `express.ts` for the
 * exact mount contract).
 *
 * Configuration contract (all verified against better-auth@1.7.27 types):
 * - Database: the official Better Auth PRISMA ADAPTER
 *   (`better-auth/adapters/prisma`, standalone package
 *   `@better-auth/prisma-adapter@<same version>` under the hood) bound to the
 *   generated `@workforce/core/generated/prisma` client the caller passes in.
 *   The Prisma 6 client is used as a plain instance (no driver adapter).
 * - Sessions: PERSISTENT DATABASE sessions. No secondary storage is
 *   configured, so sessions live (and are refreshed/revoked) entirely in the
 *   `Session` table; `session.storeSessionInDatabase` is set explicitly so
 *   the intent survives future refactors. Cookie cache stays disabled.
 * - Trusted origin: the web app origin (`WEB_ORIGIN`, `ApiConfig.webOrigin`
 *   in `src/config.ts`) is passed through `trustedOrigins`; the API's own
 *   `baseURL` is same-origin and always trusted by Better Auth itself.
 * - Social providers: complete Google/GitHub credential pairs ONLY. The
 *   factory includes exactly the providers whose complete pairs it receives
 *   (a missing pair must never appear as a "configured but broken" provider);
 *   safe availability metadata lives in `./env-config.ts`.
 * - Email/password enrollment is explicitly DISABLED: sign-in is
 *   OAuth-only for this phase.
 *
 * Secrets never leave this module's inputs: nothing is logged.
 */
import { betterAuth, type Auth, type BetterAuthOptions } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';

import type { AuthSocialCredentials } from './env-config.js';

/**
 * Structural type of the injected Prisma client. Any generated
 * `PrismaClient` instance satisfies it (the wrapper only needs the object);
 * importing `@workforce/core/generated/prisma` here is intentionally AVOIDED
 * so this module never loads the generated client until the caller does.
 */
export type WorkforceAuthDatabase = object;

export interface CreateWorkforceAuthOptions {
  /** Prisma client instance (must be bound to the schema with the auth models). */
  readonly database: WorkforceAuthDatabase;
  /** Signing secret (`BETTER_AUTH_SECRET`). */
  readonly secret: string;
  /** API origin (`BETTER_AUTH_URL`); Better Auth serves `/api/auth/*` under it. */
  readonly baseURL: string;
  /** Web origins allowed to drive the browser flows (e.g. `WEB_ORIGIN`). */
  readonly trustedOrigins: readonly string[];
  /** Included only when the COMPLETE Google pair was configured. */
  readonly google?: AuthSocialCredentials;
  /** Included only when the COMPLETE GitHub pair was configured. */
  readonly github?: AuthSocialCredentials;
}

/**
 * The Better Auth application instance, widened to the base
 * `Auth<BetterAuthOptions>` contract. The concrete instance carries a
 * literal refined options type that is structurally identical but not
 * assignable back (context invariance), so the factory promises exactly the
 * base contract: `handler`, `api` (e.g. `auth.api.getSession`), `options`.
 */
export type WorkforceAuth = {
  handler: (request: Request) => Promise<Response>;
  options: BetterAuthOptions;
  api: Auth['api'];
};

/**
 * Builds the Better Auth instance. Pure with respect to process state: no
 * env reads, no listening, no database connections (the adapter binds the
 * given client lazily — nothing is queried until a request arrives).
 */
export function createWorkforceAuth(options: CreateWorkforceAuthOptions): WorkforceAuth {
  // Only complete pairs become configured providers; omitted keys mean the
  // provider is simply not configured (availability metadata in env-config
  // mirrors this exactly).
  const socialProviders: NonNullable<BetterAuthOptions['socialProviders']> = {};
  if (options.google !== undefined) {
    socialProviders.google = {
      clientId: options.google.clientId,
      clientSecret: options.google.clientSecret,
    };
  }
  if (options.github !== undefined) {
    socialProviders.github = {
      clientId: options.github.clientId,
      clientSecret: options.github.clientSecret,
    };
  }

  return betterAuth({
    database: prismaAdapter(options.database, {
      provider: 'postgresql',
    }),
    secret: options.secret,
    baseURL: options.baseURL,
    trustedOrigins: [...options.trustedOrigins],
    // OAuth-only in this phase; email/password stays off.
    emailAndPassword: { enabled: false },
    // Persistent DB sessions: the Session table owns session state (no
    // secondary storage anywhere in this API).
    session: { storeSessionInDatabase: true },
    socialProviders,
  }) as unknown as WorkforceAuth;
}
