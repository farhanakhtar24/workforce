/**
 * Pure layout-control helpers for the signed-in workspace shell (Farhan's UX
 * request 4+5): desktop sidebar collapse persistence and the widened chat
 * content column. Storage is injected so these stay testable without a
 * browser; callers decide which storage they actually pass.
 */

/** localStorage key for the desktop "collapsed icon rail" preference. */
export const SIDEBAR_COLLAPSE_KEY = 'workforce:sidebar-collapsed';

/** Chat transcript column: the audited `max-w-3xl` widened by ~10% (48 → 52.8rem). */
export const CHAT_CONTENT_CLASS = 'max-w-[52.8rem]';

/** Reads the stored desktop preference; corrupt/missing values collapse to false. */
export function readStoredSidebarCollapsed(
  storage: Pick<Storage, 'getItem'> | null | undefined,
  key: string = SIDEBAR_COLLAPSE_KEY,
): boolean {
  if (storage === null || storage === undefined) return false;
  try {
    return storage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

/** Persists the desktop preference; storage failures are ignored (no throw). */
export function writeStoredSidebarCollapsed(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  collapsed: boolean,
  key: string = SIDEBAR_COLLAPSE_KEY,
): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(key, collapsed ? 'true' : 'false');
  } catch {
    // Private-mode quota errors etc. — preference just stays in memory.
  }
}

/**
 * Class for the aside at the md+ breakpoint: roomy 260px column, or a usable
 * ~64px icon rail (labels hidden, icons remain centered). Mobile drawer
 * visibility is decided separately by `mobileOpen`.
 */
export function desktopSidebarWidthClass(collapsed: boolean): string {
  return collapsed ? 'md:w-[64px]' : 'md:w-[260px]';
}

export function desktopSidebarHiddenNames(collapsed: boolean): string {
  return collapsed ? 'max-md:hidden md:group-data-collapsed:hidden' : '';
}
