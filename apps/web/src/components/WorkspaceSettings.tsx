'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/navigation';
import {
  Archive,
  ArchiveRestore,
  Loader2,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  fetchHourlyUsage,
  formatHourlyCost,
  formatHourlyReset,
  type HourlyUsageSummary,
} from '@/lib/hourly-usage';
import {
  fetchRecentChats,
  recentChatHref,
  type RecentChat,
} from '@/lib/recent-chats';
import { patchChatMetadata, CHAT_METADATA_ERROR } from '@/lib/chat-sidebar';
import { resolveApiBaseUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Workspace Settings dialog (Farhan's request B): bottom-left utility entry.
 * Real data only — the authenticated HOURLY usage window (requests used/
 * remaining, conservative estimated cost of the $1 cap and remaining, reset
 * time in local + UTC titles, per-model buckets, honest settlement warning)
 * and the ARCHIVED chats list (includeArchived fetch) with Unarchive. Links
 * to the Memory page for the personal-learning opt-in; no fake controls.
 * Loaded on dialog open + explicit Refresh, never per token.
 */

type UsagePhase =
  | { phase: 'loading' }
  | { phase: 'ready'; summary: HourlyUsageSummary }
  | { phase: 'error'; error: string };

type ArchivedPhase =
  | { phase: 'loading' }
  | { phase: 'ready'; chats: ReadonlyArray<RecentChat>; rowError?: { key: string; error: string } | null }
  | { phase: 'error'; error: string };

export interface WorkspaceSettingsProps {
  apiBaseUrl: string;
  open: boolean;
  onClose: () => void;
  /** Element to restore focus to when the settings dialog closes. */
  openerElement?: { current: HTMLElement | null } | null;
}

export function WorkspaceSettings({
  apiBaseUrl,
  open,
  onClose,
  openerElement,
}: WorkspaceSettingsProps): React.ReactElement {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  // Native native dialog owns the top layer: showModal() on open, focus
  // restored to the opener element on close, Escape via native `cancel`.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open && dialogRef.current !== null && !dialogRef.current.open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialogRef.current.showModal();
    }
    if (!open && dialogRef.current !== null && dialogRef.current.open) {
      dialogRef.current.close();
      (openerElement?.current ?? openerRef.current)?.focus();
      openerRef.current = null;
    }
  }, [open, onClose]);
  const [usage, setUsage] = useState<UsagePhase>({ phase: 'loading' });
  const [archived, setArchived] = useState<ArchivedPhase>({ phase: 'loading' });
  const [archivingFor, setArchivingFor] = useState<string | null>(null);
  const usageSeq = useRef(0);
  const archivedSeq = useRef(0);

  const loadUsage = useCallback(async (): Promise<void> => {
    const seq = ++usageSeq.current;
    setUsage({ phase: 'loading' });
    const result = await fetchHourlyUsage({ apiBaseUrl });
    if (seq !== usageSeq.current) return;
    setUsage(result.ok ? { phase: 'ready', summary: result.summary } : { phase: 'error', error: result.error });
  }, [apiBaseUrl]);

  const loadArchived = useCallback(async (): Promise<void> => {
    const seq = ++archivedSeq.current;
    setArchived({ phase: 'loading' });
    const result = await fetchRecentChats({ apiBaseUrl, limit: 50, includeArchived: true });
    if (seq !== archivedSeq.current) return;
    setArchived(result.ok ? { phase: 'ready', chats: result.chats } : { phase: 'error', error: result.error });
  }, [apiBaseUrl]);

  useEffect(() => {
    if (open) {
      void loadUsage();
      void loadArchived();
    }
  }, [open, loadUsage, loadArchived]);

  const unarchive = useCallback(
    async (chat: RecentChat): Promise<void> => {
      const key = `${chat.agent}:${chat.chatId}`;
      if (archivingFor !== null) return;
      setArchivingFor(key);
      const result = await patchChatMetadata({ apiBaseUrl, slug: chat.agent, chatId: chat.chatId, patch: { archived: false } });
      setArchivingFor(null);
      if (result.ok) {
        // Remove the row; the chat returns to Recent chats (recents refresh
        // via the chats-changed event).
        setArchived((current) =>
          current.phase === 'ready'
            ? { ...current, chats: current.chats.filter((c) => `${c.agent}:${c.chatId}` !== key), rowError: null }
            : current,
        );
        window.dispatchEvent(new CustomEvent('workforce:chats-changed'));
        return;
      }
      // A single failure stays INLINE on the row: the archived list remains
      // READY so the user can Retry without closing or reopening anything.
      setArchived((current) =>
        current.phase === 'ready'
          ? { ...current, rowError: { key, error: result.error } }
          : { phase: 'error', error: result.error },
      );
    },
    [apiBaseUrl, archivingFor],
  );

  if (!open) return <></>;

  return (
    <div
      className="fixed inset-0 z-50"
      aria-labelledby="ws-settings-title"
    >
      <button
        type="button"
        className="absolute inset-0 h-full w-full cursor-default bg-black/40"
        aria-label="Close workspace settings"
        title="Close workspace settings (Escape)"
        onClick={onClose}
      />
      <dialog
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ws-settings-title"
        className="m-auto w-[24rem] max-w-[94vw] rounded-xl border border-border bg-card p-5 text-card-foreground shadow-lg backdrop:bg-black/40"
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
        onClick={(event) => {
          if (event.target === dialogRef.current) onClose();
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id="ws-settings-title" className="m-0 flex items-center gap-2 text-[0.95rem] font-semibold">
            <SettingsIcon className="size-4 text-primary" aria-hidden="true" />
            Workspace settings
          </h2>
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            aria-label="Close workspace settings"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        {/* Hourly usage (whole-user, conservative estimates). */}
        <section aria-labelledby="ws-settings-usage-title" className="mt-4">
          <p id="ws-settings-usage-title" className="m-0 flex items-center justify-between text-[0.7rem] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
            Hourly usage
            <button
              type="button"
              className="inline-flex size-5 items-center justify-center rounded-md hover:bg-accent"
              aria-label="Refresh hourly usage"
              title="Refresh hourly usage"
              onClick={() => void loadUsage()}
            >
              {usage.phase === 'loading' ? (
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw size={11} aria-hidden="true" />
              )}
            </button>
          </p>
          {usage.phase === 'ready' && (
            <dl className="m-0 text-[0.8rem]">
              <div className="flex justify-between gap-2 py-0.5">
                <dt className="text-muted-foreground">Requests</dt>
                <dd className="tabular-nums text-right">
                  {usage.summary.requestCount} / {usage.summary.requestLimit} · {usage.summary.remainingRequests} left
                </dd>
              </div>
              <div className="flex justify-between gap-2 py-0.5">
                <dt className="text-muted-foreground">Estimated cost</dt>
                <dd className="tabular-nums text-right">{formatHourlyCost(usage.summary)}</dd>
              </div>
              {(() => {
                const reset = formatHourlyReset(usage.summary.resetAt);
                if (reset === null) return null;
                return (
                  <div className="flex justify-between gap-2 py-0.5">
                    <dt className="text-muted-foreground">Resets</dt>
                    <dd title={`Resets at ${reset.utc}`}>{reset.local}</dd>
                  </div>
                );
              })()}
              {usage.summary.usageComplete === false && (
                <p role="status" className="m-0 mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[0.7rem] leading-snug text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                  Some recent requests are still settling — their conservative numbers are reserved and may change. This is not a final bill.
                </p>
              )}
              {usage.summary.models.length > 0 && (
                <ul className="m-0 mt-1 list-none" aria-label="Per-model usage in this hour">
                  {usage.summary.models.map((bucket) => (
                    <li key={bucket.modelId} className="py-0.5 text-[0.7rem] break-words">
                      {bucket.modelId}: {bucket.requests} request{bucket.requests === 1 ? '' : 's'} ·{' '}
                      {bucket.inputTokens.toLocaleString('en-US')} in / {bucket.outputTokens.toLocaleString('en-US')} out
                      {bucket.estimatedCostUsd > 0 ? ` · $${bucket.estimatedCostUsd.toFixed(4)}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </dl>
          )}
          {usage.phase === 'loading' && (
            <p aria-busy="true" className="m-0 flex items-center gap-1.5 text-[0.78rem] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Loading hourly usage…
            </p>
          )}
          {usage.phase === 'error' && (
            <p role="alert" className="m-0 text-[0.7rem] text-destructive">
              {usage.error}
            </p>
          )}
        </section>

        {/* Archived chats (reachable even though the recents list hides them). */}
        <section aria-labelledby="ws-settings-archived-title" className="mt-4 border-t border-border pt-3">
          <p id="ws-settings-archived-title" className="m-0 flex items-center gap-1.5 text-[0.7rem] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
            <Archive className="size-3.5" aria-hidden="true" />
            Archived chats
          </p>
          {archived.phase === 'ready' ? (
            archived.chats.filter((chat) => chat.archived).length === 0 ? null : (
              <ul className="m-0 mt-1.5 list-none" aria-label="Archived chats">
                {archived.chats
                  .filter((chat) => chat.archived)
                  .map((chat) => {
                    const key = `${chat.agent}:${chat.chatId}`;
                    return (
                      <li key={key} className="flex flex-col gap-1 rounded-md border border-border bg-muted/50 px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <a
                            href={recentChatHref(chat)}
                            className="min-w-0 flex-1 truncate text-[0.78rem] hover:underline"
                            title={`Open ${chat.title}`}
                          >
                            {chat.title}
                          </a>
                          <button
                            type="button"
                            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-input px-1.5 py-0.5 text-[0.68rem] font-medium hover:bg-accent"
                            disabled={archivingFor === key}
                            title="Move this chat back into Recent chats"
                            onClick={() => void unarchive(chat)}
                          >
                            {archivingFor === key ? (
                              <Loader2 size={10} className="animate-spin" aria-hidden="true" />
                            ) : (
                              <ArchiveRestore size={11} aria-hidden="true" />
                            )}
                            Unarchive
                          </button>
                        </div>
                        <p className="m-0 text-[0.65rem] break-all text-muted-foreground">{key}</p>
                        {archived.rowError != null && archived.rowError.key === key && (
                          <p
                            role="alert"
                            className="m-0 rounded-md border border-red-200 bg-red-50 px-1.5 py-1 text-[0.65rem] text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
                          >
                            {archived.rowError.error}
                          </p>
                        )}
                      </li>
                    );
                  })}
              </ul>
            )
          ) : null}
          {archived.phase === 'ready' && archived.chats.filter((chat) => chat.archived).length === 0 && (
            <p className="m-0 mt-1 text-[0.7rem] text-muted-foreground">No archived chats.</p>
          )}
          {archived.phase === 'loading' && (
            <p aria-busy="true" className="m-0 mt-1 flex items-center gap-1.5 text-[0.72rem] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              Loading archived chats…
            </p>
          )}
          {archived.phase === 'error' && (
            <p role="alert" className="m-0 mt-1 text-[0.7rem] text-destructive">
              {CHAT_METADATA_ERROR}
            </p>
          )}
        </section>

        {/* Personal memory opt-in lives on the Memory page (whole-user setting). */}
        <section aria-labelledby="ws-settings-learning-title" className="mt-4 border-t border-border pt-3">
          <p id="ws-settings-learning-title" className="m-0 flex items-center gap-1.5 text-[0.7rem] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Personal memory
          </p>
          <a
            href="/memory"
            className="mt-1 inline-flex items-center gap-1 text-[0.78rem] text-primary underline-offset-4 hover:underline"
          >
            Manage the opt-in personal-learning setting
            <ExternalLinkHint />
          </a>
        </section>
      </dialog>
    </div>
  );
}

function ExternalLinkHint(): React.ReactElement {
  return <span aria-hidden="true" className="text-muted-foreground">→</span>;
}

export default WorkspaceSettings;
