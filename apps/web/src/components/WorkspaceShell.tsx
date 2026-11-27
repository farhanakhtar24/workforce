'use client';

import 'client-only';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  CalendarClock,
  Database,
  FileText,
  LogOut,
  MessageSquare,
  Menu,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { resolveApiBaseUrl } from '@/lib/api';
import { RecentChats } from '@/components/RecentChats';
import { ThemeToggle } from '@/components/ThemeToggle';
import { WorkspaceSettings } from '@/components/WorkspaceSettings';
import { AuthGate, hasSessionUser } from '@/components/AuthGate';
import { authClient, useSession } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import { desktopSidebarWidthClass } from '@/lib/layout-controls';
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
 * Signed-in workspace: `WorkspaceGate` wraps the shell with `AuthGate`
 * (loading skeleton → unauthenticated redirect to `/sign-in` with the safe
 * local return path; fixed access-denied presentation on failures/403; the
 * user identity row and Sign out live in the rail/drawer).
 *
 * ChatGPT-calm geometry: slim 260px neutral rail (desktop) with brand, New
 * chat, compact icon nav, the real RecentChats region, user identity and the
 * bottom utility area (Collapse panel toggle, theme, "Local workspace").
 * Layout controls (Farhan):
 * - Desktop: the rail collapses to a usable icon rail (labels hidden, icons
 *   centered, `title` tooltips; New chat/Sign out stay reachable via icons)
 *   and expands back; the preference persists in localStorage
 *   (`workforce:sidebar-collapsed`) — no server dependency.
 * - Mobile: a proper accessible drawer (role=dialog, aria-modal, Esc +
 *   labelled backdrop, focus on open) holds nav + history; New chat stays
 *   permanently visible in the top bar. Nav is vertical now, so the old
 *   horizontal scroll-centering helper is superseded and removed.
 * Chat variant keeps the viewport frame (transcript-only scroll, pinned
 * composer) with the widened chat column (`CHAT_CONTENT_CLASS`, ~10% wider
 * than the old `max-w-3xl`). `contextQuery` preserves chat → Work/
 * Delegations deep-link filtering.
 */

const NAV_ICONS: Readonly<Record<WorkspaceNavId, LucideIcon>> = {
  memory: Database,
  work: FileText,
  delegations: Network,
  schedules: CalendarClock,
  chat: MessageSquare,
};

const COLLAPSE_KEY = 'workforce:sidebar-collapsed';

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

export function WorkspaceGate(props: WorkspaceShellProps): React.ReactElement {
  return (
    <AuthGate>
      <WorkspaceShellInner {...props} />
    </AuthGate>
  );
}

function WorkspaceShellInner({
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
  const activeId = activeWorkspaceNavId(pathname, active);

  // Desktop collapse preference: read after mount (no SSR mismatch).
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(COLLAPSE_KEY);
    if (stored === 'true' || stored === 'false') {
      setCollapsed(stored === 'true');
    } else if (stored !== null) {
      window.localStorage.removeItem(COLLAPSE_KEY); // corrupt value
    }
  }, []);
  const toggleCollapsed = useCallback((): void => {
    setCollapsed((current) => {
      const next = !current;
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(COLLAPSE_KEY, next ? 'true' : 'false');
        } catch {
          // Storage unavailable: preference stays in memory.
        }
      }
      return next;
    });
  }, []);

  const [mobileOpen, setMobileOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    drawerRef.current?.focus();
    return () => {
      document.body.style.overflow = priorOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [mobileOpen]);

  const navHref = (item: WorkspaceNavItem): string =>
    contextQuery !== undefined && (item.id === 'work' || item.id === 'delegations')
      ? `${item.href}?${contextQuery}`
      : item.href;

  // Operational pages render the eyebrow/title header. The chat keeps ONE
  // quiet identity header of its own (inside the center column), so the
  // shell never adds a second header above it.
  const hasHeader =
    variant !== 'chat' &&
    (eyebrow !== undefined || title !== undefined || description !== undefined || context !== undefined);

  return (
    <div
      className={cn(
        'relative flex flex-col md:flex-row',
        variant === 'chat' ? 'h-dvh overflow-hidden' : 'min-h-dvh',
      )}
    >
      <a
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:border focus:bg-card focus:px-3 focus:py-2 focus:text-sm"
        href="#ws-content"
      >
        Skip to content
      </a>

      {/* Mobile top bar: drawer button + brand + always-visible New chat. */}
      <div className="sticky top-0 z-30 flex shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-3 py-2 text-sidebar-foreground md:hidden">
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent"
          aria-label="Open navigation menu"
          aria-expanded={mobileOpen}
          aria-controls="ws-mobile-drawer"
          onClick={() => setMobileOpen(true)}
        >
          <Menu size={16} aria-hidden="true" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="inline-flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground" aria-hidden="true">
            <Bot size={15} strokeWidth={2.2} />
          </span>
          <span className="text-[0.95rem] font-medium tracking-tight whitespace-nowrap">Workforce</span>
        </div>
        <ThemeToggle compact />
        <Button
          asChild
          variant="outline"
          size="sm"
          className="shrink-0 border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <a href={newChatHref} aria-label="Start a new chat (history is never deleted)">
            <Plus aria-hidden="true" />
            <span>New chat</span>
          </a>
        </Button>
      </div>

      {/* Mobile drawer (accessible disclosure; Esc + labelled backdrop close). */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Workspace navigation"
        >
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default bg-black/40"
            aria-label="Close navigation menu"
            onClick={() => setMobileOpen(false)}
          />
          <div
            id="ws-mobile-drawer"
            ref={drawerRef}
            tabIndex={-1}
            className="absolute inset-y-0 left-0 flex w-72 flex-col gap-2 overflow-y-auto overscroll-contain border-r border-sidebar-border bg-sidebar px-3 py-3 text-sidebar-foreground outline-none"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="inline-flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground" aria-hidden="true">
                  <Bot size={15} strokeWidth={2.2} />
                </span>
                <span className="text-[0.95rem] font-medium tracking-tight">Workforce</span>
              </div>
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-md border border-sidebar-border"
                aria-label="Close navigation menu"
                onClick={() => setMobileOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="w-full justify-center border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <a href={newChatHref}>
                <Plus aria-hidden="true" />
                New chat
              </a>
            </Button>
            <NavList activeId={activeId} navHref={navHref} />
            <RecentChats />
            <UserBlock />
            <div className="mt-auto flex flex-col gap-2 border-t border-sidebar-border pt-2">
              <button
                type="button"
                aria-haspopup="dialog"
                aria-label="Open workspace settings"
                className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-md border border-sidebar-border text-[0.78rem] font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                onClick={(event) => {
                  settingsOpenerRef.current =
                    event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
                  setSettingsOpen(true);
                }}
              >
                <SettingsIcon size={14} aria-hidden="true" />
                Settings
              </button>
              <ThemeToggle />
              <div className="text-center text-[0.7rem] text-sidebar-foreground/55">Local workspace</div>
            </div>
          </div>
        </div>
      )}

      {/* Desktop rail (collapsible to an icon rail). */}
      <aside
        data-collapsed={collapsed ? 'true' : 'false'}
        className={cn(
          'sticky top-0 z-30 hidden shrink-0 flex-col gap-3 border-r border-sidebar-border bg-sidebar px-3 py-3 text-sidebar-foreground md:h-dvh md:max-h-dvh md:overflow-hidden md:flex',
          desktopSidebarWidthClass(collapsed),
        )}
      >
        <div className="flex shrink-0 flex-col gap-3 border-b border-sidebar-border pb-3">
          <div className={cn('flex min-h-6 items-center gap-2', collapsed && 'justify-center')}>
            <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground" aria-hidden="true">
              <Bot size={15} strokeWidth={2.2} />
            </span>
            {!collapsed && (
              <span className="text-[0.95rem] font-medium tracking-tight whitespace-nowrap">Workforce</span>
            )}
          </div>
          <Button
            asChild
            variant="outline"
            size="sm"
            className={cn(
              'border-sidebar-border bg-transparent font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              collapsed ? 'h-9 justify-center px-2' : 'h-9 w-full justify-center text-[0.875rem]',
            )}
            title={collapsed ? 'New chat — history is never deleted' : undefined}
            aria-label={collapsed ? 'New chat (expanded label hidden)' : undefined}
          >
            <a href={newChatHref}>
              <Plus aria-hidden="true" />
              {!collapsed && <span>New chat</span>}
            </a>
          </Button>
        </div>
        <NavList activeId={activeId} navHref={navHref} collapsed={collapsed} />
        {!collapsed && <RecentChats />}
        {!collapsed && <UserBlock />}
        {collapsed && <CollapsedSignOut />}
        {collapsed && (
          <div className="flex shrink-0 flex-col justify-center">
            <AvatarSlot />
          </div>
        )}
        <div className="mt-auto flex shrink-0 flex-col gap-2 border-t border-sidebar-border pt-2">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="inline-flex h-8 w-full items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            {collapsed ? <PanelLeftOpen size={15} aria-hidden="true" /> : <PanelLeftClose size={15} aria-hidden="true" />}
          </button>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label="Open workspace settings"
            title={collapsed ? 'Settings' : 'Workspace settings — hourly usage, archived chats'}
            className={cn(
              'inline-flex h-8 w-full items-center justify-center gap-2 rounded-md border border-sidebar-border text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground',
              collapsed && 'px-0',
            )}
            onClick={(event) => {
              settingsOpenerRef.current =
                event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
              setSettingsOpen(true);
            }}
          >
            <SettingsIcon size={15} aria-hidden="true" />
            {!collapsed && <span className="text-[0.78rem] font-medium">Settings</span>}
          </button>
          <ThemeToggle compact={collapsed} className="w-full justify-center" />
          {!collapsed && (
            <div className="text-center text-[0.7rem] text-sidebar-foreground/55">Local workspace</div>
          )}
        </div>
      </aside>
      <WorkspaceSettings
        apiBaseUrl={resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL)}
        open={settingsOpen}
        openerElement={settingsOpenerRef}
        onClose={() => setSettingsOpen(false)}
      />

      <main
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          variant === 'chat' ? 'min-h-0' : 'min-h-dvh md:min-h-0',
        )}
      >
        {hasHeader && (
          <header className="mx-auto w-full max-w-[70rem] px-4 pt-5 md:px-7 md:pt-6">
            <div>
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
            className="flex w-full min-h-0 flex-1 flex-col px-4 pt-1 md:px-4"
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

function UserBlock(): React.ReactElement {
  const { data: session } = useSession();
  if (!hasSessionUser(session)) return <></>;
  const { user } = session;
  const name = user.name !== null && user.name !== '' ? user.name : user.email;
  const initial = name.slice(0, 1).toUpperCase();
  return (
    <div className="shrink-0 border-t border-sidebar-border pt-2" data-testid="workspace-user">
      <div className="flex items-center gap-2 px-1 py-1">
        <span
          aria-hidden="true"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[0.7rem] font-semibold text-secondary-foreground"
        >
          {initial}
        </span>
        <span className="min-w-0 flex-1 text-[0.75rem] leading-tight">
          <span className="block truncate font-medium text-sidebar-foreground">{name}</span>
          <span className="block truncate text-sidebar-foreground/60">{user.email}</span>
        </span>
      </div>
      <button
        type="button"
        className="mt-1 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-sidebar-border px-2 py-1 text-[0.75rem] font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        aria-label="Sign out of the Workforce workspace. Your data and history stay."
        title="Sign out — your data and history stay"
        onClick={() => {
          void authClient.signOut().finally(() => {
            window.location.assign('/sign-in');
          });
        }}
      >
        <LogOut size={12} aria-hidden="true" />
        Sign out
      </button>
    </div>
  );
}

/**
 * Collapsed-rail sign-out: a real accessible button (an avatar alone inside a
 * noninteractive container would leave Sign out unreachable), invoking the
 * same safe sign-out handler as the expanded rail. Data/history stay.
 */
function CollapsedSignOut(): React.ReactElement | null {
  const { data: session } = useSession();
  if (!hasSessionUser(session)) return null;
  const { user } = session;
  const name = user.name !== null && user.name !== '' ? user.name : user.email;
  return (
    <div
      className="flex shrink-0 justify-center border-t border-sidebar-border px-1 pt-2"
      data-testid="workspace-user-collapsed"
    >
      <button
        type="button"
        className="flex w-full items-center justify-center rounded-md py-2 text-[0.68rem] font-semibold text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        aria-label={`Sign out of the Workforce workspace. Signed in as ${name}. Your data and history stay.`}
        title={`Sign out (signed in as ${name}) — your data and history stay`}
        onClick={() => {
          void authClient.signOut().finally(() => {
            window.location.assign('/sign-in');
          });
        }}
      >
        {name.slice(0, 1).toUpperCase()}
      </button>
    </div>
  );
}

function AvatarSlot(): React.ReactElement {
  const { data: session } = useSession();
  const user = hasSessionUser(session) ? session.user : null;
  const name = user !== null && user.name !== null && user.name !== '' ? user.name : (user?.email ?? '');
  return (
    <span
      className="inline-flex size-8 items-center justify-center rounded-full bg-secondary text-[0.65rem] font-semibold text-secondary-foreground"
      title={name !== '' ? `Signed in as ${name}` : 'Signed in'}
    >
      {name.slice(0, 1).toUpperCase() || '?'}
    </span>
  );
}

/**
 * The single primary navigation list (vertical on rails and drawer).
 * Optional icon-only collapse keeps every item reachable with tooltips;
 * `aria-current` marks the active section and the landmark stays one nav.
 */
function NavList({
  activeId,
  navHref,
  collapsed = false,
}: {
  activeId: WorkspaceNavId;
  navHref: (item: WorkspaceNavItem) => string;
  collapsed?: boolean;
}): React.ReactElement {
  return (
    <nav aria-label="Workforce pages" className="shrink-0 min-w-0">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {WORKSPACE_NAV.map((item) => {
          const Icon = NAV_ICONS[item.id];
          const isActive = item.id === activeId;
          return (
            <li key={item.id}>
              <a
                className={cn(
                  'flex items-center rounded-md transition-colors',
                  'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground',
                  isActive && 'bg-sidebar-accent font-medium text-sidebar-foreground',
                  collapsed
                    ? 'justify-center px-0 py-2'
                    : 'gap-2 px-2.5 py-1.5 text-[0.84rem]',
                )}
                href={navHref(item)}
                aria-current={isActive ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
              >
                <Icon size={15} aria-hidden="true" />
                {!collapsed && <span>{item.label}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

