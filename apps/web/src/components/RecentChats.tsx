'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { History, RotateCw } from 'lucide-react';
import { AgentAvatar } from '@/components/AgentAvatar';
import { resolveApiBaseUrl } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  CHATS_CHANGED_EVENT,
  RECENT_CHATS_DEFAULT_LIMIT,
  RECENT_CHATS_HINT,
  fetchRecentChats,
  formatRecentChatMeta,
  isCurrentRecentChat,
  recentChatHref,
  type RecentChat,
} from '@/lib/recent-chats';

/**
 * Real recent-chat history fed by `GET /api/chats` through the public API
 * base — no localStorage and no fabricated data. Desktop: an independently
 * scrollable region below the primary nav inside the dark sidebar (the
 * primary nav/actions stay usable). Mobile: a compact collapsed disclosure
 * inside the existing top bar. Title/preview/count are real and bounded;
 * legacy rows honestly show "no timestamp". "New chat" only opens a new
 * view — it never deletes history — and the accessible copy says so. The
 * primary navigation landmark is untouched; this region carries its own
 * labelled nav. Refresh triggers: route change + `workforce:chats-changed`
 * (dispatched by the chat when a generation settles).
 */

type LoadPhase =
  | { phase: 'loading' }
  | { phase: 'ready'; chats: ReadonlyArray<RecentChat> }
  | { phase: 'error'; error: string };

export function RecentChats(): React.ReactElement {
  const apiBaseUrl = resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL);
  const [state, setState] = useState<LoadPhase>({ phase: 'loading' });
  const requestSeq = useRef(0);
  // Last successfully mapped rows: background refreshes keep them on screen.
  const knownRowsRef = useRef<ReadonlyArray<RecentChat> | null>(null);

  const load = useCallback(
    async (options?: { soft?: boolean }): Promise<void> => {
      const seq = ++requestSeq.current;
      const priorRows = knownRowsRef.current;
      // Skeleton only when there are no prior usable rows (initial load,
      // route change without history, or a previous hard failure). A soft
      // `chats-changed` refresh must NEVER flash the skeleton over an
      // already-ready list; a silent soft failure simply keeps the prior
      // rows instead of degrading to the error panel.
      if (!options?.soft || priorRows === null) {
        setState({ phase: 'loading' });
      }
      const result = await fetchRecentChats({ apiBaseUrl, limit: RECENT_CHATS_DEFAULT_LIMIT });
      if (seq !== requestSeq.current) return; // superseded by a newer request
      if (result.ok) {
        knownRowsRef.current = result.chats;
        setState({ phase: 'ready', chats: result.chats });
        return;
      }
      if (options?.soft === true && priorRows !== null) {
        return; // keep the last good list; the next settle/refresh retries
      }
      setState({ phase: 'error', error: result.error });
    },
    [apiBaseUrl],
  );

  // Refetch on route change (hard: skeleton over a fresh view is correct)
  // and, softly, when the chat reports that a generation settled.
  const pathname = usePathname() ?? '/';
  useEffect(() => {
    void load();
    const onChanged = (): void => {
      void load({ soft: true });
    };
    window.addEventListener(CHATS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(CHATS_CHANGED_EVENT, onChanged);
    };
  }, [load, pathname]);

  const rows = state.phase === 'ready' ? state.chats : [];

  return (
    <>
      {/* Desktop: scrollable region between the primary nav and the footer. */}
      <div className="hidden min-h-0 flex-1 flex-col gap-1.5 md:flex">
        <p className="flex items-center gap-1.5 px-2.5 text-[0.7rem] font-semibold tracking-[0.06em] text-sidebar-foreground/55 uppercase">
          <History size={13} aria-hidden="true" />
          Recent chats
        </p>
        <nav
          aria-label="Recent chats"
          title={RECENT_CHATS_HINT}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5"
        >
          <RecentChatsBody state={state} chats={rows} pathname={pathname} onRetry={() => void load()} />
        </nav>
      </div>

      {/* Mobile: collapsed disclosure inside the existing top bar. */}
      <details className="md:hidden">
        <summary
          className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2.5 py-1 text-[0.78rem] font-medium text-sidebar-foreground/70"
          title={RECENT_CHATS_HINT}
        >
          <History size={13} aria-hidden="true" />
          Recent chats
          {state.phase === 'ready' && rows.length > 0 && (
            <span className="rounded-full bg-sidebar-accent px-1.5 text-[0.65rem] text-sidebar-foreground">
              {rows.length}
            </span>
          )}
        </summary>
        <nav
          aria-label="Recent chats"
          title={RECENT_CHATS_HINT}
          className="max-h-64 overflow-y-auto overscroll-contain"
        >
          <RecentChatsBody state={state} chats={rows} pathname={pathname} onRetry={() => void load()} />
        </nav>
      </details>
    </>
  );
}

function RecentChatsBody({
  state,
  chats,
  pathname,
  onRetry,
}: {
  state: LoadPhase;
  chats: ReadonlyArray<RecentChat>;
  pathname: string;
  onRetry: () => void;
}): React.ReactElement {
  if (state.phase === 'loading') {
    return (
      <ul className="m-0 flex list-none flex-col gap-1 p-1" aria-label="Loading recent chats">
        {[0, 1, 2].map((index) => (
          <li key={index} className="list-none" aria-hidden="true">
            <div className="h-9 animate-pulse rounded-md bg-sidebar-accent" />
          </li>
        ))}
        <li className="px-1.5 text-[0.7rem] text-sidebar-foreground/55">Loading recent chats…</li>
      </ul>
    );
  }
  if (state.phase === 'error') {
    return (
      <div className="flex flex-col gap-1.5 p-1.5">
        <p role="alert" className="m-0 text-[0.75rem] text-sidebar-foreground/75">
          {state.error}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-sidebar-border px-2 py-1 text-[0.75rem] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
        >
          <RotateCw size={12} aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }
  if (chats.length === 0) {
    return (
      <p className="m-0 px-1.5 py-1 text-[0.75rem] leading-snug text-sidebar-foreground/60">
        No chats yet — send a message and it appears here. Starting a new chat never deletes this
        history.
      </p>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-1" aria-label="Recent chats">
      {chats.map((chat) => {
        const isActive = isCurrentRecentChat(pathname, chat);
        const meta = formatRecentChatMeta(chat);
        return (
          <li key={`${chat.agent}:${chat.chatId}`} className="list-none">
            <a
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground',
                isActive && 'bg-sidebar-accent font-medium text-sidebar-foreground',
              )}
              href={recentChatHref(chat)}
              aria-current={isActive ? 'page' : undefined}
              title={RECENT_CHATS_HINT}
            >
              <AgentAvatar agent={chat.agent} size={16} />
              <span className="min-w-0 flex-1 truncate text-[0.82rem] leading-snug">{chat.title}</span>
              <span
                aria-hidden="true"
                className="shrink-0 text-[0.62rem] tabular-nums text-sidebar-foreground/45"
              >
                {chat.messageCount}
              </span>
              {/* Real metadata (honest timestamp, preview) stays available to
                  assistive tech even in the compact single-line row. */}
              <span className="sr-only">{`. ${meta}`}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
