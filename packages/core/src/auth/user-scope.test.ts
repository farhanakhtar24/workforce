/**
 * Offline tests for the bounded per-user memory scope helper: determinism,
 * case-safety, schema compatibility (existing memoryScopeSchema untouched),
 * and structurally-separate legacy scopes. No DB, no Better Auth, no network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isUserMemoryScope,
  userMemoryScope,
  USER_MEMORY_SCOPE_KEY_CHARS,
  USER_MEMORY_SCOPE_MAX_LENGTH,
  USER_MEMORY_SCOPE_PREFIX,
  userMemoryScopeSchema,
} from './user-scope.js';
import { memoryScopeSchema, MemoryValidationError } from '../memory/index.js';

test('userMemoryScope is deterministic and injective for distinct ids', () => {
  const a = userMemoryScope('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01');
  const b = userMemoryScope('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02');
  assert.equal(a, userMemoryScope('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01'));
  assert.notEqual(a, b);
});

test('userMemoryScope is case-safe: ids differing only in case never collide', () => {
  // Better Auth ids mix case; memory scopes are lowercased, so a direct
  // embedding could collide. The derived key is hex, so it cannot.
  const lower = userMemoryScope('tTzecUTP4Rz35NkvDkz8Yq5z');
  const upper = userMemoryScope('TTZECUTP4RZ35NKVDKZ8YQ5Z');
  assert.notEqual(lower, upper);
});

test('derived scope is bounded and matches the documented shape', () => {
  const scope = userMemoryScope('some-better-auth-user-id');
  assert.equal(scope, userMemoryScope('some-better-auth-user-id'));
  assert.ok(scope.length === USER_MEMORY_SCOPE_MAX_LENGTH);
  assert.ok(USER_MEMORY_SCOPE_MAX_LENGTH <= 64, 'must fit the 64-char memory scope bound');
  assert.ok(scope.startsWith(USER_MEMORY_SCOPE_PREFIX));
  assert.match(scope.slice(USER_MEMORY_SCOPE_PREFIX.length), /^[0-9a-f]+$/);
  assert.equal(scope.slice(USER_MEMORY_SCOPE_PREFIX.length).length, USER_MEMORY_SCOPE_KEY_CHARS);
});

test('derived scope validates against the EXISTING memoryScopeSchema', () => {
  const scope = userMemoryScope('tTzecUTP4Rz35NkvDkz8Yq5z');
  assert.equal(memoryScopeSchema.parse(scope), scope, 'scope must be usable as a memory scope unchanged');
});

test('userMemoryScopeSchema accepts derived scopes and rejects everything else', () => {
  assert.equal(userMemoryScopeSchema.parse(userMemoryScope('tTzecUTP4Rz35NkvDkz8Yq5z')), userMemoryScope('tTzecUTP4Rz35NkvDkz8Yq5z'));
  // Legacy/anonymous scopes stay structurally distinct from user scopes.
  for (const legacy of ['default', 'user-not-a-hash', `user-${'a'.repeat(47)}`, `user-${'a'.repeat(49)}`, `user-${'g'.repeat(48)}`]) {
    assert.throws(() => userMemoryScopeSchema.parse(legacy), `legacy scope must fail: ${legacy}`);
    assert.equal(isUserMemoryScope(legacy), false);
  }
});

test('userMemoryScope rejects missing, empty, and oversized user ids (safe error text)', () => {
  for (const bad of [undefined, null, 42, '', '   ']) {
    assert.throws(() => userMemoryScope(bad), MemoryValidationError);
  }
  assert.throws(
    () => userMemoryScope('x'.repeat(1025)),
    (error: unknown) => {
      assert.ok(error instanceof MemoryValidationError);
      assert.equal(error.code, 'memory_validation_error');
      // The error must not echo the (oversized) user id value.
      assert.ok(!error.message.includes('xxxx'));
      return true;
    },
  );
});

test('isUserMemoryScope is shape-only and never throws on weird input', () => {
  const scope = userMemoryScope('ok-user');
  assert.equal(isUserMemoryScope(scope), true);
  assert.equal(isUserMemoryScope(undefined), false);
  assert.equal(isUserMemoryScope(42), false);
  assert.equal(isUserMemoryScope(`${scope}extra`), false);
  assert.equal(isUserMemoryScope(`USER-${scope.slice(USER_MEMORY_SCOPE_PREFIX.length)}`), false);
});
