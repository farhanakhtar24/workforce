'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceGate } from '@/components/WorkspaceShell';
import { StatusBadge } from '@/components/StatusBadge';
import { AgentAvatar } from '@/components/AgentAvatar';
import { MarkdownText } from '@/components/MarkdownText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  childChatUrlFor,
  fetchDelegations,
  formatDelegationTime,
  hasActiveDelegations,
  truncateDelegationText,
  DELEGATION_TEXT_LIMIT,
  delegationStatusLabel,
  type Delegation,
} from '@/lib/delegations';
import { backToChatUrl } from '@/lib/agents';

export interface DelegationsProps {
  apiBaseUrl: string;
  /** `?chatId=` — the parent chat whose delegations this page lists. */
  chatId: string;
  /** `?agent=` — steers the "Back to chat" link back to the origin transcript. */
  agent: string;
}

const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const POLL_INTERVAL_MS = 2000;

interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

/**
 * `/delegations?chatId=…` — the parent chat's delegation list (Phase 4) on
 * the shared Tailwind + shadcn shell. Rows come from the real
 * `GET /api/agents/orchestrator/delegations` route; polling follows the
 * /memory pattern: only while a row is pending/running, tab visible, never
 * overlapping requests, and it stops on errors. There is deliberately NO
 * manual retry: a completed child must never be regenerated, and `run` is an
 * internal signed route the browser does not have access to.
 */
export function DelegationsView({ apiBaseUrl, chatId, agent }: DelegationsProps): React.ReactElement {
  if (!CHAT_ID_PATTERN.test(chatId)) {
    return (
      <WorkspaceGate
        active="delegations"
        eyebrow="Delegation"
        title="Delegations"
        description="Runs delegated from this chat to specialist sub-agents — quick asks return synchronously (result inline), longer work runs asynchronously in an isolated child chat. Records survive chat deletion."
      >
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          <p className="m-0">
            Delegations are listed per chat — open this page from a chat's <code>Delegations</code>{' '}
            link (<code>/delegations?chatId=…</code>).
          </p>
        </div>
      </WorkspaceGate>
    );
  }
  return <DelegationsLoaded apiBaseUrl={apiBaseUrl} chatId={chatId} agent={agent} />;
}

function DelegationsLoaded({
  apiBaseUrl,
  chatId,
  agent,
}: {
  apiBaseUrl: string;
  chatId: string;
  agent: string;
}): React.ReactElement {
  const [rows, setRows] = useState<ReadonlyArray<Delegation>>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Non-overlapping, visibility-gated polling (same pattern as /memory).
  const requestSeq = useRef(0);
  const pollInFlight = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const result = await fetchDelegations({ apiBaseUrl, parentChatId: chatId, limit: 100 });
    if (seq !== requestSeq.current) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      setNotice(null);
      return; // an error also stops automatic polling (empty list)
    }
    setError(null);
    setLoadedOnce(true);
    setRows(result.delegations);
    setNotice({
      kind: 'ok',
      text: `${result.delegations.length} delegation(s) created from this chat.`,
    });
  }, [apiBaseUrl, chatId]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refreshRef.current();
  }, []);

  const pollActive = hasActiveDelegations(rows) && error === null;
  useEffect(() => {
    if (!pollActive) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (pollInFlight.current) return; // never overlap requests
      pollInFlight.current = true;
      void refreshRef.current().finally(() => {
        pollInFlight.current = false;
      });
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      pollInFlight.current = false;
    };
  }, [pollActive]);

  return (
    <WorkspaceGate
      active="delegations"
      eyebrow="Delegation"
      title="Delegations"
      description={`Delegated runs from this chat (${chatId}) to specialist worker agents — quick asks return synchronously (result inline), longer work runs asynchronously in an isolated child chat. Records survive chat deletion.`}
      context={
        <a
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          href={backToChatUrl(chatId, agent)}
        >
          Back to chat
        </a>
      }
    >
      {error !== null && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
        >
          <p className="m-0">{error}</p>
          <Button type="button" variant="outline" size="sm" className="shrink-0 border-red-300 bg-transparent text-red-900 dark:hover:bg-red-950/60 dark:hover:text-red-200" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      )}
      <p aria-live="polite" className="m-0 min-h-5 text-sm text-muted-foreground">
        {notice?.kind === 'ok' ? notice.text : loading ? 'Loading…' : ''}
      </p>

      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {rows.map((row) => (
          <li key={row.id} className="list-none">
            <DelegationCard row={row} />
          </li>
        ))}
      </ul>
      {rows.length === 0 && (
        <p className="m-0 text-sm text-muted-foreground">
          {loading ? 'Loading delegations…' : loadedOnce ? 'No delegations have been created from this chat yet.' : ''}
        </p>
      )}
      {pollActive && (
        <p aria-live="polite" className="m-0 text-sm text-muted-foreground">
          Waiting for pending delegations — this list refreshes itself until each child finishes.
        </p>
      )}
    </WorkspaceGate>
  );
}

function DelegationCard({ row }: { row: Delegation }): React.ReactElement {
  const childUrl = childChatUrlFor(row.childChatId, row.targetAgent);
  return (
    <Card
      className={cn(
        'gap-2.5 px-3.5 py-3',
        row.status === 'pending' && 'border-amber-300 dark:border-amber-800',
        row.status === 'running' && 'border-primary',
        (row.status === 'failed' || row.status === 'timeout') && 'border-red-300 dark:border-red-800',
      )}
      data-status={row.status}
    >
      <p className="m-0 text-[0.68rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
        Specialist sub-agent
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5" title="Orchestrator (coordinator)">
          <AgentAvatar agent="orchestrator" size={18} />
          <span className="text-[0.82rem] font-medium">Orchestrator</span>
        </span>
        <span aria-hidden="true" className="text-muted-foreground">→</span>
        <span className="flex items-center gap-1.5" title={row.targetAgent}>
          <AgentAvatar agent={row.targetAgent} size={18} />
          <span className="text-[0.82rem] font-medium">{row.targetAgent}</span>
          <Badge variant="outline">{row.mode}</Badge>
        </span>
        {row.depth >= 1 && (
          <Badge variant="outline" className="tabular-nums">
            depth {row.depth}
          </Badge>
        )}
        <StatusBadge status={row.status}>
          {delegationStatusLabel(row.status)}
        </StatusBadge>
      </div>
      <p className="m-0 text-sm break-words whitespace-pre-wrap">{truncateDelegationText(row.task, DELEGATION_TEXT_LIMIT)}</p>
      {row.result !== null && (
        <>
          <p className="m-0 font-semibold break-words">Worker result</p>
          {/* The FULL result renders as Markdown inside a bounded scroll
              region: truncating the Markdown source leaves literal unmatched
              syntax (e.g. a cut `**…`), so the bound lives on height, not
              content. Task and error lines keep their text truncation. */}
          <div className="max-h-60 overflow-y-auto overscroll-contain">
            <MarkdownText text={row.result} />
          </div>
        </>
      )}
      {row.error !== null && (
        <p className="m-0 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-sm break-words whitespace-pre-wrap text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200">
          {truncateDelegationText(row.error, DELEGATION_TEXT_LIMIT)}
        </p>
      )}
      <p className="m-0 text-xs break-all text-muted-foreground">
        created {formatDelegationTime(row.createdAt)} · completed {formatDelegationTime(row.completedAt)} ·
        delegation <span className="font-mono">{row.id}</span>
      </p>
      <div className="flex flex-wrap gap-3">
        {childUrl !== null && (
          <a
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            href={childUrl.href}
          >
            Open child chat
          </a>
        )}
        <a
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          href={`/work?chatId=${encodeURIComponent(row.parentChatId)}`}
        >
          Documents from this chat
        </a>
      </div>
    </Card>
  );
}
