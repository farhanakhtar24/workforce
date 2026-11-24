/**
 * Bounded per-user memory scopes (pre-Phase 6 auth foundation).
 *
 * A user's private memory lives in a scope string that must satisfy the
 * EXISTING `memoryScopeSchema` contract (1..64 chars, ASCII `[a-z0-9_-]`).
 * Better Auth user ids are case-mixed TEXT ids (32 chars of `[a-zA-Z0-9]` by
 * default), so the raw id must not be embedded directly: scopes are
 * lowercased by the memory domain, which would let `user-<aBc>` and
 * `user-<abc>` collide across two different users.
 *
 * The mapping is therefore one-way and derived from the user id:
 *
 *   scope = "user-" + first 48 lowercase hex chars of sha256(userId)
 *
 * - Deterministic and pure: the same user id always maps to the same scope.
 * - Case-safe and charset-safe: the derived key is `[0-9a-f]` only, so the
 *   result always passes `memoryScopeSchema` without further normalization.
 * - Bounded: `user-` (5) + 48 = 53 chars <= the existing 64-char scope limit.
 * - Practically injective: a 48-hex-char (192-bit) digest truncated prefix
 *   keeps the user-id -> scope map collision-free for any realistic user
 *   count; two distinct users never share a scope.
 *
 * The scope is not reversible (one-way hash): anything that needs the user
 * id must hold the authenticated user id itself and derive the scope from
 * it. This is the only safe direction under the per-user privacy model.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { MemoryValidationError } from '../memory/errors.js';
import { memoryScopeSchema } from '../memory/schemas.js';

/** Every user memory scope starts with this literal prefix. */
export const USER_MEMORY_SCOPE_PREFIX = 'user-';

/**
 * Number of lowercase hex chars of the sha256 digest kept in the scope.
 * 48 (192 digest bits) leaves 64 - 5 - 48 = 11 chars of headroom against
 * the existing 64-char scope bound.
 */
export const USER_MEMORY_SCOPE_KEY_CHARS = 48;

/** Upper bound of a derived user memory scope (5 + 48). */
export const USER_MEMORY_SCOPE_MAX_LENGTH =
  USER_MEMORY_SCOPE_PREFIX.length + USER_MEMORY_SCOPE_KEY_CHARS;

/** Shape of a derived user scope key (prefix excluded). */
const USER_MEMORY_SCOPE_KEY_PATTERN = /^[0-9a-f]{48}$/;

/** Sanity guard below the memory domain's own 800-char path input ceiling. */
const MAX_USER_ID_LENGTH = 1024;

function validateUserId(userId: unknown): string {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new MemoryValidationError(
      'user memory scope requires a non-empty user id',
    );
  }
  if (userId.length > MAX_USER_ID_LENGTH) {
    throw new MemoryValidationError(
      `user id must be at most ${MAX_USER_ID_LENGTH} characters`,
    );
  }
  return userId;
}

/**
 * Derives the bounded private memory scope for one authenticated user.
 * Pure, deterministic, and case-safe: two distinct user ids can never
 * produce the same scope (48 hex digest chars), and the result always
 * satisfies the existing `memoryScopeSchema` (ascii lowercase, 1..64).
 * Throws {@link MemoryValidationError} on a missing/too-long user id.
 */
export function userMemoryScope(userId: unknown): string {
  const id = validateUserId(userId);
  const digest = createHash('sha256').update(id, 'utf8').digest('hex');
  return `${USER_MEMORY_SCOPE_PREFIX}${digest.slice(0, USER_MEMORY_SCOPE_KEY_CHARS)}`;
}

/**
 * Shape check only (one-way mapping — no user id can be decoded back).
 * True for a scope derived by `userMemoryScope`, false for every legacy
 * scope (e.g. `"default"`), which is what keeps legacy anonymous scopes
 * structurally distinct from per-user private scopes.
 */
export function isUserMemoryScope(scope: unknown): boolean {
  if (typeof scope !== 'string') {
    return false;
  }
  return (
    scope.startsWith(USER_MEMORY_SCOPE_PREFIX) &&
    scope.length === USER_MEMORY_SCOPE_MAX_LENGTH &&
    USER_MEMORY_SCOPE_KEY_PATTERN.test(
      scope.slice(USER_MEMORY_SCOPE_PREFIX.length),
    )
  );
}

/**
 * The per-user private memory scope contract: the existing memory scope
 * schema plus the derived-shape guarantee. Parsing a scope with this schema
 * proves it is a valid memory scope AND exactly the derived form of a user
 * id — never a legacy scope. The shared memory schema itself is untouched.
 */
export const userMemoryScopeSchema = memoryScopeSchema.pipe(
  z.string().refine(isUserMemoryScope, {
    message: `scope must be a derived user memory scope ("${USER_MEMORY_SCOPE_PREFIX}"${USER_MEMORY_SCOPE_KEY_CHARS} lowercase hex chars)`,
  }),
);
