/**
 * Public API of the pre-Phase 6 auth foundation in @workforce/core.
 *
 * Pure ONLY: everything here is domain logic (hashing + zod) with no Prisma,
 * no Better Auth, and no network — `@workforce/core` CLI consumers must never
 * load the generated client or the auth runtime (those live in `@workforce/api`).
 */

export {
  USER_MEMORY_SCOPE_PREFIX,
  USER_MEMORY_SCOPE_KEY_CHARS,
  USER_MEMORY_SCOPE_MAX_LENGTH,
  userMemoryScope,
  isUserMemoryScope,
  userMemoryScopeSchema,
} from './user-scope.js';
