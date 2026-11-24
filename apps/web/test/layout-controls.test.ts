import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_CONTENT_CLASS,
  SIDEBAR_COLLAPSE_KEY,
  desktopSidebarWidthClass,
  readStoredSidebarCollapsed,
  writeStoredSidebarCollapsed,
} from '../src/lib/layout-controls.js';

function memoryStorage(initial: Record<string, string> = {}): {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  entries: Record<string, string>;
} {
  const entries: Record<string, string> = { ...initial };
  return {
    entries,
    getItem: (k) => (k in entries ? entries[k] : null),
    setItem: (k, v) => {
      entries[k] = v;
    },
  };
}

test('sidebar collapse preference: storage persistence with safe fallbacks', () => {
  const fresh = memoryStorage();
  assert.equal(readStoredSidebarCollapsed(fresh), false);
  assert.equal(readStoredSidebarCollapsed(null), false);
  assert.equal(readStoredSidebarCollapsed(undefined), false);
  // Explicit false stays false; true persists.
  writeStoredSidebarCollapsed(fresh, true);
  assert.equal(fresh.entries[SIDEBAR_COLLAPSE_KEY], 'true');
  assert.equal(readStoredSidebarCollapsed(fresh), true);
  writeStoredSidebarCollapsed(fresh, false);
  assert.equal(fresh.entries[SIDEBAR_COLLAPSE_KEY], 'false');
  assert.equal(readStoredSidebarCollapsed(fresh), false);

  // Corrupt values never expand a rail that was never intended.
  const corrupt = memoryStorage({ [SIDEBAR_COLLAPSE_KEY]: 'garbage' });
  assert.equal(readStoredSidebarCollapsed(corrupt), false);

  // Throwing storage (private-mode quota) never breaks callers.
  const throwing = {
    getItem: () => {
      throw new Error('quota');
    },
    setItem: () => {
      throw new Error('quota');
    },
  } as unknown as Pick<Storage, 'getItem' | 'setItem'>;
  assert.equal(readStoredSidebarCollapsed(throwing), false);
  assert.doesNotThrow(() => writeStoredSidebarCollapsed(throwing, true));
});

test('rail width classes: expanded 260px column vs collapsed ~64px icon rail', () => {
  assert.equal(desktopSidebarWidthClass(false), 'md:w-[260px]');
  assert.equal(desktopSidebarWidthClass(true), 'md:w-[64px]');
});

test('chat column widened ~10% (48rem → 52.8rem) as an explicit static class', () => {
  assert.equal(CHAT_CONTENT_CLASS, 'max-w-[52.8rem]');
  // 52.8 / 48 ≈ 1.10: the class string itself must encode that ratio so
  // Tailwind can statically detect it (no dynamic width interpolation).
  const ratio = 52.8 / 48;
  assert.ok(ratio > 1.09 && ratio < 1.11);
  assert.ok(CHAT_CONTENT_CLASS.startsWith('max-w-['));
});
