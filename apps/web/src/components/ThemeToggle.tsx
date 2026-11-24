'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Theme control for the explicit Light/Dark system (next-themes, class
 * attribute). Hydration-safe without a mounted gate: CSS classes decide which
 * icon/label is visible under `.dark`, so server and client markup agree.
 * Copy states the ACTION — the icon shows where the click goes (Moon +
 * "Dark theme" in light mode; Sun + "Light theme" in dark mode). No current
 * state is claimed in text because the visible itself is the state.
 */
export function ThemeToggle({ compact = false, className }: { compact?: boolean; className?: string }): React.ReactElement {
  // next-themes v0.4 exposes `setTheme` only; the click handler resolves the
  // toggle from `resolvedTheme` at click time (well after hydration), so the
  // rendered markup stays class-driven and hydration-safe.
  const { setTheme, resolvedTheme } = useTheme();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn('border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground', className)}
      aria-label="Toggle light / dark theme. The visible icon shows the target theme of the click."
      title="Toggle light / dark theme"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      <span className="inline-flex items-center gap-2 dark:hidden">
        <Moon aria-hidden="true" />
        {!compact && <span>Dark theme</span>}
      </span>
      <span className="hidden items-center gap-2 dark:inline-flex">
        <Sun aria-hidden="true" />
        {!compact && <span>Light theme</span>}
      </span>
    </Button>
  );
}

export default ThemeToggle;
