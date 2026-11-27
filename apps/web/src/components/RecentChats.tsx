'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  Archive,
  Archive as ArchiveIcon,
  ArchiveRestore,
  Copy,
  Download,
  History,
  Loader2,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import { ContextMenu, DropdownMenu } from 'radix-ui';
import { AgentAvatar } from '@/components/AgentAvatar';
import { resolveApiBaseUrl } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  RECENT_CHATS_DEFAULT_LIMIT,
  RECENT_CHATS_HINT,
  CHATS_CHANGED_EVENT,
  fetchRecentChats,
  formatRecentChatMeta,
  isCurrentRecentChat,
  recentChatHref,
  type RecentChat,
} from '@/lib/recent-chats';
import {
  CHAT_DELETE_NOTE as DELETE_NOTE,
  deleteChat,
  notifyChatsChanged,
  type ChatMutationTarget,
} from '@/lib/chat-mutations';
import {
  CHAT_COPY_ERROR,
  CHAT_METADATA_CONFLICT,
  CHAT_METADATA_BUSY,
  patchChatMetadata,
  fetchChatExport,
  copyToClipboard,
} from '@/lib/chat-sidebar';

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

  const [pendingDelete, setPendingDelete] = useState<RecentChat | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Sidebar row actions (A): rename / copy / pin / export / archive. A single
  // accessible status line announces each honest result under the header.
  const [pendingRename, setPendingRename] = useState<RecentChat | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameDialogRef = useRef<HTMLDialogElement | null>(null);
  const [actionBusyFor, setActionBusyFor] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // One open row menu at a time (per-row DropdownMenu, controlled).
// (removed duplicate)

  const announce = useCallback((kind: 'ok' | 'error', text: string): void => {
    setActionStatus({ kind, text });
  }, []);

  const openRename = useCallback((chat: RecentChat): void => {
    setRenameError(null);
    setRenameDraft(chat.title);
    setPendingRename(chat);
    renameDialogRef.current?.showModal();
  }, []);

  const closeRename = useCallback((): void => {
    if (renaming) return;
    renameDialogRef.current?.close();
    setPendingRename(null);
    setRenameError(null);
  }, [renaming]);

  const saveRename = useCallback(async (): Promise<void> => {
    const target = pendingRename;
    if (target === null || renaming) return;
    setRenaming(true);
    setRenameError(null);
    const result = await patchChatMetadata({
      apiBaseUrl,
      slug: target.agent,
      chatId: target.chatId,
      patch: { title: renameDraft },
    });
    setRenaming(false);
    if (!result.ok) {
      setRenameError(result.error);
      return;
    }
    renameDialogRef.current?.close();
    setPendingRename(null);
    announce(
      'ok',
      result.metadata.title === null
        ? 'Custom title cleared.'
        : `Renamed to “${result.metadata.title}”.`,
    );
    notifyChatsChanged();
    void load({ soft: true });
  }, [pendingRename, renaming, renameDraft, apiBaseUrl, announce, load]);

  const setRowBusy = useCallback((chat: RecentChat, busy: boolean): void => {
    setActionBusyFor(busy ? `${chat.agent}:${chat.chatId}` : null);
  }, []);

  const toggleSidecar = useCallback(
    async (chat: RecentChat, patch: { pinned?: boolean; archived?: boolean }): Promise<void> => {
      const key = `${chat.agent}:${chat.chatId}`;
      if (actionBusyFor !== null) return;
      setActionBusyFor(key);
      setActionStatus(null);
      const result = await patchChatMetadata({ apiBaseUrl, slug: chat.agent, chatId: chat.chatId, patch });
      setActionBusyFor(null);
      if (!result.ok) {
        announce('error', result.error);
        return;
      }
      notifyChatsChanged();
      void load({ soft: true });
      announce(
        'ok',
        patch.pinned !== undefined
          ? result.metadata.pinned
            ? 'Chat pinned — it stays at the top of Recent chats.'
            : 'Chat unpinned.'
          : result.metadata.archived
            ? 'Chat archived — find it under Settings → Archived chats.'
            : 'Chat unarchived — it is back in Recent chats.',
      );
    },
    [actionBusyFor, apiBaseUrl, announce, load],
  );

  // One open row menu at a time (per-row DropdownMenu, controlled).
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const exportChat = useCallback(
    async (chat: RecentChat): Promise<void> => {
      const key = `${chat.agent}:${chat.chatId}`;
      if (actionBusyFor !== null) return;
      setActionBusyFor(key);
      setActionStatus(null);
      const result = await fetchChatExport({ apiBaseUrl, slug: chat.agent, chatId: chat.chatId });
      setActionBusyFor(null);
      if (!result.ok) {
        announce('error', result.error);
        return;
      }
      // COMPLETE owner-scoped server transcript downloaded as a Blob (never a
      // client-faked transcript).
      const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      announce('ok', `Transcript exported as ${result.filename}.`);
    },
    [actionBusyFor, apiBaseUrl, announce],
  );

  const copySessionId = useCallback(
    async (chat: RecentChat): Promise<void> => {
      // The chat UUID is the Workforce resource id — never an auth token.
      const copied = await copyToClipboard(chat.chatId);
      announce(
        copied ? 'ok' : 'error',
        copied ? 'Session ID copied to the clipboard.' : CHAT_COPY_ERROR,
      );
    },
    [announce],
  );

  const openDelete = useCallback((chat: RecentChat): void => {
    setDeleteError(null);
    setPendingDelete(chat);
    dialogRef.current?.showModal();
  }, []);

  const closeDelete = useCallback((): void => {
    if (deleting) return;
    dialogRef.current?.close();
    setPendingDelete(null);
    setDeleteError(null);
  }, [deleting]);

  const confirmDelete = useCallback(async (): Promise<void> => {
    const target = pendingDelete;
    if (target === null || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const mutation: ChatMutationTarget = {
      apiBaseUrl,
      slug: target.agent,
      chatId: target.chatId,
    };
    const result = await deleteChat(mutation);
    setDeleting(false);
    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }
    dialogRef.current?.close();
    setPendingDelete(null);
    // The list (and any active-generation state) must refresh; deleting the
    // CURRENT chat also navigates the view to a fresh Plan chat.
    notifyChatsChanged();
    if (isCurrentRecentChat(window.location.pathname, target)) {
      window.location.assign('/');
    } else {
      void load({ soft: true });
    }
  }, [pendingDelete, deleting, load]);

  return (
    <>
      <div className="hidden min-h-0 flex-1 flex-col gap-1.5 md:flex">
        <p className="flex items-center gap-1.5 px-2.5 text-[0.7rem] font-semibold tracking-[0.06em] text-sidebar-foreground/55 uppercase">
          <History size={13} aria-hidden="true" />
          Recent chats
        </p>
        <p
          aria-live="polite"
          role="status"
          className={cn(
            'm-0 mx-2 mb-1 text-[0.65rem] leading-snug',
            actionStatus !== null && actionStatus.kind === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {actionStatus !== null ? actionStatus.text : RECENT_CHATS_HINT}
        </p>
        <nav
          aria-label="Recent chats"
          title={RECENT_CHATS_HINT}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5"
        >
          <RecentChatsBody
            state={state}
            chats={rows}
            pathname={pathname}
            onRetry={() => void load()}
            onRequestDelete={openDelete}
            onRename={openRename}
            onCopy={copySessionId}
            onTogglePin={toggleSidecar}
            onExport={exportChat}
            onToggleArchive={toggleSidecar}
            busyFor={actionBusyFor}
            menuFor={menuFor}
            setMenuFor={setMenuFor}
          />
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
          <RecentChatsBody
            state={state}
            chats={rows}
            pathname={pathname}
            onRetry={() => void load()}
            onRequestDelete={openDelete}
            onRename={openRename}
            onCopy={copySessionId}
            onTogglePin={toggleSidecar}
            onExport={exportChat}
            onToggleArchive={toggleSidecar}
            busyFor={actionBusyFor}
            menuFor={menuFor}
            setMenuFor={setMenuFor}
          />
                    <p
              aria-live="polite"
              role="status"
              className={cn(
                'm-0 px-2 pt-1 text-[0.65rem] leading-snug',
                actionStatus !== null && actionStatus.kind === 'error' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {actionStatus !== null ? actionStatus.text : RECENT_CHATS_HINT}
            </p>
          </nav>
      </details>

      {/* Accessible native confirmation dialog (Escape + backdrop close via
          the explicit Cancel button; focus starts on the dialog). */}
      <dialog
        ref={dialogRef}
        aria-labelledby="recent-chats-delete-title"
        className="m-auto w-[26rem] max-w-[92vw] rounded-xl border border-border bg-card p-5 text-card-foreground shadow-lg backdrop:bg-black/40"
        onClick={(event) => {
          if (event.target === dialogRef.current) closeDelete();
        }}
        onCancel={(event) => {
          event.preventDefault();
          closeDelete();
        }}
      >
        {pendingDelete !== null && (
          <>
            <div className="flex items-start justify-between gap-2">
              <h2 id="recent-chats-delete-title" className="m-0 flex items-center gap-2 text-[0.95rem] font-semibold">
                <Trash2 className="size-4 text-destructive" aria-hidden="true" />
                Delete chat?
              </h2>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                aria-label="Close delete confirmation"
                onClick={closeDelete}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <p className="mt-2 mb-0 text-sm">
              <span className="font-medium">{pendingDelete.title}</span>
              <span className="block text-xs text-muted-foreground">
                {pendingDelete.agent} · {formatRecentChatMeta(pendingDelete)}
              </span>
            </p>
            <p className="mt-2 mb-0 text-xs leading-snug text-muted-foreground">{DELETE_NOTE}</p>
            {deleteError !== null && (
              <p
                role="alert"
                className="mt-2 mb-0 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
              >
                {deleteError}
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-md border border-input px-3 text-[0.8rem] font-medium hover:bg-accent"
                onClick={closeDelete}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive px-3 text-[0.8rem] font-semibold text-destructive-foreground transition-opacity disabled:opacity-60"
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                {deleting && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                Delete chat
              </button>
            </div>
          </>
        )}
      </dialog>

      {/* Accessible rename dialog (trim + 80-code-point save; blank input
          is an INTENTIONAL clear of the custom title). */}
      <dialog
        ref={renameDialogRef}
          aria-labelledby="recent-chats-rename-title"
          className="m-auto w-[24rem] max-w-[92vw] rounded-xl border border-border bg-card p-5 text-card-foreground shadow-lg backdrop:bg-black/40"
          onClick={(event) => {
            if (event.target === renameDialogRef.current) closeRename();
          }}
          onCancel={(event) => {
            event.preventDefault();
            closeRename();
          }}
        >
          {pendingRename !== null && (
            <>
              <div className="flex items-start justify-between gap-2">
                <h2 id="recent-chats-rename-title" className="m-0 text-[0.95rem] font-semibold">
                  Rename chat
                </h2>
                <button
                  type="button"
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                  aria-label="Close rename dialog"
                  onClick={closeRename}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
              <p className="mt-1 mb-0 text-xs text-muted-foreground">
                Blank input clears the custom title. Up to 80 characters.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveRename();
                }}
              >
                <label htmlFor="recent-chats-rename-input" className="mt-3 block text-[0.78rem] font-medium">
                  Chat title
                </label>
                <input
                  id="recent-chats-rename-input"
                  name="recent-chats-rename-input"
                  className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[0.85rem] text-card-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void saveRename();
                    }
                  }}
                  maxLength={200}
                  placeholder="Custom title (blank to clear)"
                  disabled={renaming}
                />
                {renameError !== null && (
                  <p
                    role="alert"
                    className="mt-2 mb-0 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
                  >
                    {renameError}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    className="inline-flex h-8 items-center rounded-md border border-input px-3 text-[0.8rem] font-medium hover:bg-accent"
                    onClick={closeRename}
                    disabled={renaming}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[0.8rem] font-semibold text-primary-foreground transition-opacity disabled:opacity-60"
                    onClick={() => void saveRename()}
                    disabled={renaming}
                  >
                    {renaming && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                    Save title
                  </button>
                </div>
              </form>
            </>
          )}
        </dialog>
    </>
  );
}

/**
 * The SIX-row action set shared by the visible three-dot dropdown and the
 * right-click context menu. Items are real API-backed actions; Delete keeps
 * the existing native confirmation dialog. Menu items are disabled while
 * that row is mutating.
 */
function RowMenuItems({
  chat,
  busy,
  onRename,
  onCopy,
  onTogglePin,
  onExport,
  onToggleArchive,
  onRequestDelete,
}: {
  chat: RecentChat;
  busy: boolean;
  onRename: (chat: RecentChat) => void;
  onCopy: (chat: RecentChat) => Promise<void>;
  onTogglePin: (chat: RecentChat, patch: { pinned?: boolean; archived?: boolean }) => Promise<void>;
  onExport: (chat: RecentChat) => Promise<void>;
  onToggleArchive: (chat: RecentChat, patch: { pinned?: boolean; archived?: boolean }) => Promise<void>;
  onRequestDelete: (chat: RecentChat) => void;
}): React.ReactElement {
  return (
    <>
      <DropdownMenu.Item
              disabled={busy}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.8rem] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
          busy && 'cursor-not-allowed opacity-50 data-[highlighted]:bg-transparent data-[highlighted]:text-inherit',
        )}
        onSelect={(event) => {
          event.preventDefault();
          onRename(chat);
        }}
      >
        <Pencil size={13} aria-hidden="true" />
        Rename
      </DropdownMenu.Item>
      <DropdownMenu.Item
              disabled={busy}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.8rem] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
          busy && 'cursor-not-allowed opacity-50 data-[highlighted]:bg-transparent data-[highlighted]:text-inherit',
        )}
        onSelect={(event) => {
          event.preventDefault();
          void onCopy(chat);
        }}
      >
        <Copy size={13} aria-hidden="true" />
        Copy session ID
      </DropdownMenu.Item>
      <DropdownMenu.Item
              disabled={busy}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.8rem] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
          busy && 'cursor-not-allowed opacity-50 data-[highlighted]:bg-transparent data-[highlighted]:text-inherit',
        )}
        onSelect={(event) => {
          event.preventDefault();
          void onTogglePin(chat, { pinned: !chat.pinned });
        }}
      >
        {chat.pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
        {chat.pinned ? 'Unpin' : 'Pin'}
      </DropdownMenu.Item>
      <DropdownMenu.Item
              disabled={busy}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.8rem] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
          busy && 'cursor-not-allowed opacity-50 data-[highlighted]:bg-transparent data-[highlighted]:text-inherit',
        )}
        onSelect={(event) => {
          event.preventDefault();
          void onExport(chat);
        }}
      >
        <Download size={13} aria-hidden="true" />
        Export Markdown
      </DropdownMenu.Item>
      <DropdownMenu.Item
              disabled={busy}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.8rem] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
          busy && 'cursor-not-allowed opacity-50 data-[highlighted]:bg-transparent data-[highlighted]:text-inherit',
        )}
        onSelect={(event) => {
          event.preventDefault();
          void onToggleArchive(chat, { archived: !chat.archived });
        }}
      >
        {chat.archived ? <ArchiveRestore size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
        {chat.archived ? 'Unarchive' : 'Archive'}
      </DropdownMenu.Item>
      <DropdownMenu.Separator className="my-1 border-t border-border" />
      <DropdownMenu.Item
              disabled={busy}
        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.8rem] text-destructive outline-none data-[highlighted]:bg-red-50 data-[highlighted]:text-red-800 data-[highlighted]:dark:bg-red-950/50 data-[highlighted]:dark:text-red-200"
        onSelect={(event) => {
          event.preventDefault();
          onRequestDelete(chat);
        }}
      >
        <Trash2 size={13} aria-hidden="true" />
        Delete
      </DropdownMenu.Item>
    </>
  );
}

function RecentChatsBody({
  state,
  chats,
  pathname,
  onRetry,
  onRequestDelete,
  onRename,
  onCopy,
  onTogglePin,
  onExport,
  onToggleArchive,
  busyFor,
  menuFor,
  setMenuFor,
}: {
  state: LoadPhase;
  chats: ReadonlyArray<RecentChat>;
  pathname: string;
  onRetry: () => void;
  onRequestDelete: (chat: RecentChat) => void;
  onRename: (chat: RecentChat) => void;
  onCopy: (chat: RecentChat) => Promise<void>;
  onTogglePin: (chat: RecentChat, patch: { pinned?: boolean; archived?: boolean }) => Promise<void>;
  onExport: (chat: RecentChat) => Promise<void>;
  onToggleArchive: (chat: RecentChat, patch: { pinned?: boolean; archived?: boolean }) => Promise<void>;
  busyFor: string | null;
  menuFor: string | null;
  setMenuFor: (next: string | null) => void;
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
        const rowKey = `${chat.agent}:${chat.chatId}`;
        const busy = busyFor === rowKey;
        return (
          <li key={rowKey} className="group/row relative list-none">
            <ContextMenu.Root>
              <ContextMenu.Trigger asChild>
                <a
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 pr-12 py-1.5 transition-colors',
                    'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground',
                    isActive && 'bg-sidebar-accent font-medium text-sidebar-foreground',
                  )}
                  href={recentChatHref(chat)}
                  aria-current={isActive ? 'page' : undefined}
                  title={RECENT_CHATS_HINT}
                >
                  <AgentAvatar agent={chat.agent} size={16} />
                  <span className="min-w-0 flex-1 truncate text-[0.82rem] leading-snug">{chat.title}</span>
                  {chat.pinned && <Pin size={11} aria-hidden="true" className="shrink-0 text-sidebar-foreground/50" />}
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-[0.62rem] tabular-nums text-sidebar-foreground/45"
                  >
                    {chat.messageCount}
                  </span>
                  {/* Real metadata (honest timestamp, preview) stays available
                      to assistive tech even in the compact single-line row. */}
                  <span className="sr-only">{`. ${meta}`}</span>
                </a>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                {/* Right-click opens the SAME actions without navigation —
                    Radix preventDefaults the browser context menu. */}
                <ContextMenu.Content className="z-60 w-52 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  <RowMenuItems
                    chat={chat}
                    busy={busy}
                    onRename={onRename}
                    onCopy={onCopy}
                    onTogglePin={onTogglePin}
                    onExport={onExport}
                    onToggleArchive={onToggleArchive}
                    onRequestDelete={onRequestDelete}
                  />
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
            {/* Visible three-dot button: also a keyboard trigger
                (Shift+F10 per menu contract; Enter/ArrowDown via Radix). */}
            <DropdownMenu.Root
              open={menuFor === rowKey && !busy}
              onOpenChange={(next) => setMenuFor(next ? rowKey : null)}
              modal={false}
            >
              <DropdownMenu.Trigger asChild disabled={busy}>
                <button
                  type="button"
                  onKeyDown={(event) => {
                    // Explicit keyboard trigger: Shift+F10 opens the row menu.
                    if (event.key === 'F10' && event.shiftKey) {
                      event.preventDefault();
                      setMenuFor(rowKey);
                    }
                  }}
                  className={cn(
                    'absolute top-1/2 right-1 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/50 opacity-100 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground sm:opacity-0 sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100',
                    'focus-visible:opacity-100',
                    isActive && 'text-sidebar-foreground/70',
                  )}
                  aria-label={`Chat actions for: ${chat.title}. ${meta}. Rename, copy session ID, pin, export, archive, delete.`}
                  title="Chat actions (right-click also available)"
                >
                  {busy ? (
                    <Loader2 size={12} aria-hidden="true" className="animate-spin" />
                  ) : (
                    <MoreVertical size={12} aria-hidden="true" />
                  )}
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={2}
                  collisionPadding={10}
                  className="z-60 w-52 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
                >
                  <RowMenuItems
                    chat={chat}
                    busy={busy}
                    onRename={onRename}
                    onCopy={onCopy}
                    onTogglePin={onTogglePin}
                    onExport={onExport}
                    onToggleArchive={onToggleArchive}
                    onRequestDelete={onRequestDelete}
                  />
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </li>
        );
      })}
    </ul>
  );
}
