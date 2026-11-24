/**
 * Public API of the pre-Phase 6 auth module (unmounted Better Auth wiring).
 *
 * Only this module may import better-auth; it is pure with respect to
 * process state (no env reads outside explicit inputs, no DB connects, no
 * listener). Mounting lives in the Phase 6 app/server integration:
 *
 *   const config = parseAuthEnvironment();            // safe env parsing
 *   const auth = createWorkforceAuth({ ... });        // instance factory
 *   app.all(AUTH_MOUNT_PATTERN, createAuthExpressHandler(auth));
 */

export {
  AUTH_ENV_KEYS,
  type AuthEnvKey,
  type SocialProviderId,
  type AuthSocialCredentials,
  type ProviderAvailability,
  type ProviderAvailabilityEntry,
  type ParseAuthProviderPairsResult,
  type ParsedAuthEnvironment,
  parseAuthProviderEnv,
  parseAuthEmailAllowlist,
  parseAuthEnvironment,
  parseOptionalAuthEnvironment,
} from './env-config.js';

export {
  AUTH_401_MESSAGE,
  AUTH_403_MESSAGE,
  AUTH_OWNER_MISMATCH_MESSAGE,
  type AuthOwner,
  type RequireOwnerAuthDeps,
  type StaticOwnerInjection,
  createRequireOwner,
  ownerOf,
} from './owner.js';

// Barrel kept alphabetical-ish by role: env parsing, owner resolution, the
// instance factory, then the Express mount contract.


export {
  type WorkforceAuthDatabase,
  type CreateWorkforceAuthOptions,
  type WorkforceAuth,
  createWorkforceAuth,
} from './factory.js';

export {
  AUTH_MOUNT_PATH,
  AUTH_MOUNT_PATTERN,
  type AuthExpressHandler,
  createAuthExpressHandler,
} from './express.js';
