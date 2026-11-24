'use client';

import 'client-only';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  CalendarClock,
  Database,
  FileText,
  MessageSquare,
  Network,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RecentChats } from '@/components/RecentChats';
import { ThemeToggle } from '@/components/ThemeToggle';
import { cn } from '@/lib/utils';
import {
  WORKSPACE_NAV,
  activeWorkspaceNavId,
  type WorkspaceNavId,
  type WorkspaceNavItem,
} from '@/lib/workspace';

/**
 * Shared app shell for every routed Workforce surface (Tailwind + shadcn,
 * light/dark via the shared token set).
 *
 * ChatGPT-calm geometry, not a branded dashboard: a slim (~260px) NEUTRAL
 * sidebar rail (subtle gray in light, soft graphite in dark) with the simple
 * brand mark, a prominent New chat row, compact icon nav, the real
 * `RecentChats` region (API data), and a bottom utility area (theme toggle +
 * "Local workspace"). One sidebar serves both breakpoints: desktop column,
 * compact mobile top bar with a collapsed history disclosure. One primary
 * navigation landmark with `aria-current`, single nav never duplicated.
 *
 * Chat uses the full-height "chat" variant (viewport frame, transcript-only
 * scroll, pinned composer dock); page surfaces keep the document scroll.
 * `contextQuery` keeps Work/Delegations deep-link filtering when coming from
 * a chat, exactly like the old per-page headers did.
 */

const NAV_ICONS: Readonly<Record<WorkspaceNavId, LucideIcon>> = {
  memory: Database,
  work: FileText,
  delegations: Network,
  schedules: CalendarClock,
  chat: MessageSquare,
};

export interface WorkspaceShellProps {
  /** The surface group this page belongs to (never a guessed value). */
  active: WorkspaceNavId;
  /** Small section label above the page title (page variant). */
  eyebrow?: string;
  /** Page `h1`. Omit (pass `undefined`) when the surface renders its own. */
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Row of contextual links under the description, e.g. "Back to chat". */
  context?: React.ReactNode;
  /** Chat transcript layout instead of a wide workspace page. */
  variant?: 'page' | 'chat';
  /** Where the sidebar "New chat" action points; `/` mints a fresh chat. */
  newChatHref?: string;
  /** Appended to the /work and /delegations nav links (e.g. from a chat). */
  contextQuery?: string;
  children: React.ReactNode;
}

export function WorkspaceShell({
  active,
  eyebrow,
  title,
  description,
  context,
  variant = 'page',
  newChatHref = '/',
  contextQuery,
  children,
}: WorkspaceShellProps): React.ReactElement {
  const pathname = usePathname() ?? '/';
  // Trust the surface's own selection first; fall back to the URL section so
  // detail pages (e.g. /work/:id) still highlight their section.
  const activeId = activeWorkspaceNavId(pathname, active);

  // Mobile-only: the sidebar is the horizontally scrollable top bar below
  // md, so the right-most active item (e.g. Schedules) can clip on mount.
  // Bring the CURRENT page item into view by assigning `scrollLeft` directly
  // on the nav list — never `scrollIntoView`, which would scroll the whole
  // document vertically. Desktop (md+) is untouched: the sidebar fits, no
  // horizontal overflow exists. The single nav landmark + aria-current stay.
  const navListRef = useRef<HTMLUListElement | null>(null);
  const activeLinkRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    const list = navListRef.current;
    const activeLink = activeLinkRef.current;
    if (!list || !activeLink || typeof window === 'undefined') return;
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    const withinList = activeLink.offsetLeft - list.offsetLeft;
    const target = withinList - (list.clientWidth - activeLink.offsetWidth) / 2;
    list.scrollLeft = Math.max(0, target);
  }, [activeId]);

  const navHref = (item: WorkspaceNavItem): string =>
    contextQuery !== undefined && (item.id === 'work' || item.id === 'delegations')
      ? `${item.href}?${contextQuery}`
      : item.href;

  const hasHeader =
    eyebrow !== undefined || title !== undefined || description !== undefined || context !== undefined;

  return (
    <div
      className={cn(
        'flex flex-col md:flex-row',
        // The chat is a viewport-constrained application frame (fixed height,
        // transcript scrolls internally, dock pinned). Page surfaces keep the
        // natural document scroll.
        variant === 'chat' ? 'h-dvh overflow-hidden' : 'min-h-dvh',
      )}
    >
      <a className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:border focus:bg-card focus:px-3 focus:py-2 focus:text-sm" href="#ws-content">
        Skip to content
      </a>
      <aside className="sticky top-0 z-30 flex shrink-0 flex-col gap-2 border-b bg-sidebar px-3 py-2 text-sidebar-foreground md:h-dvh md:w-[260px] md:gap-3 md:border-r md:border-b-0 md:py-3 md:pr-3">
        <div className="flex items-center justify-between gap-2 md:flex-col md:items-stretch md:gap-3 md:border-b md:border-sidebar-border md:pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground" aria-hidden="true">
              <Bot size={15} strokeWidth={2.2} />
            </span>
            <span className="text-[0.95rem] font-medium tracking-tight whitespace-nowrap">
              Workforce
            </span>
          </div>
          <div className="flex items-center gap-1.5 md:w-full md:flex-col">
            <ThemeToggle compact className="md:hidden" />
            <Button
              asChild
              variant="outline"
              size="sm"
              className="justify-start gap-2 border-sidebar-border bg-transparent font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:h-9 md:w-full md:justify-center md:px-3 md:text-[0.875rem]"
            >
              <a href={newChatHref}>
                <Plus aria-hidden="true" />
                New chat
              </a>
            </Button>
          </div>
        </div>
        <nav aria-label="Workforce pages" className="min-w-0">
          <ul ref={navListRef} className="flex gap-0.5 overflow-x-auto md:flex-col md:overflow-visible">
            {WORKSPACE_NAV.map((item) => {
              const Icon = NAV_ICONS[item.id];
              const isActive = item.id === activeId;
              return (
                <li key={item.id} className="shrink-0 md:shrink">
                  <a
                    ref={isActive ? activeLinkRef : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[0.84rem] whitespace-nowrap transition-colors',
                      'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground',
                      isActive &&
                        'bg-sidebar-accent font-medium text-sidebar-foreground',
                    )}
                    href={navHref(item)}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <Icon size={15} aria-hidden="true" />
                    <span>{item.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <RecentChats />
        {/* Desktop bottom utility area: theme control + honest label. Mobile
            keeps a compact theme toggle next to New chat, saving bar rows. */}
        <div className="mt-auto flex flex-col gap-2 border-t border-sidebar-border pt-2 max-md:hidden">
          <ThemeToggle className="w-full justify-center" />
          <div className="text-center text-[0.7rem] text-sidebar-foreground/55">
            Local workspace
          </div>
        </div>
      </aside>
      <main
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          variant === 'chat' ? 'min-h-0' : 'min-h-dvh md:min-h-0',
        )}
      >
        {hasHeader && (
          <header
            className={cn(
              'mx-auto w-full max-w-[70rem] px-4 pt-5 md:px-7 md:pt-6',
              variant === 'chat' && 'shrink-0',
            )}
          >
            <div className={cn(variant === 'chat' && 'mx-auto max-w-[44rem]')}>
              {eyebrow !== undefined && (
                <p className="mb-0.5 text-[0.68rem] font-medium tracking-[0.07em] text-muted-foreground uppercase">
                  {eyebrow}
                </p>
              )}
              {title !== undefined && (
                <h1 className="m-0 text-xl leading-tight font-medium tracking-tight">{title}</h1>
              )}
              {description !== undefined && (
                <p className="mt-1 max-w-[70ch] text-[0.88rem] text-muted-foreground">{description}</p>
              )}
              {context !== undefined && (
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">{context}</div>
              )}
            </div>
          </header>
        )}
        {variant === 'chat' ? (
          <div
            id="ws-content"
            className="mx-auto flex w-full max-w-[47rem] min-h-0 flex-1 flex-col px-4 pt-1 md:px-4"
          >
            {children}
          </div>
        ) : (
          <div
            id="ws-content"
            className="mx-auto flex w-full max-w-[70rem] flex-1 flex-col gap-4 px-4 pt-4 pb-10 md:px-7"
          >
            {children}
          </div>
        )}
      </main>
    </div>
  );
}
