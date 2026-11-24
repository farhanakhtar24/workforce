'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
 * `/delegations?chatId=…` — the parent chat's delegation list (Phase 4).
 * Rows come from the real `GET /api/agents/orchestrator/delegations`
 * route; polling follows the /memory pattern: only while a row is
 * pending/running, tab visible, never overlapping requests, and it stops on
 * errors. There is deliberately NO manual retry: a completed child must
 * never be regenerated, and `run` is an internal signed route the browser
 * does not have access to.
 */
export function DelegationsView({ apiBaseUrl, chatId, agent }: DelegationsProps): React.ReactElement {
  if (!CHAT_ID_PATTERN.test(chatId)) {
    return (
      <main className="chat-layout">
        <header className="chat-header">
          <h1>Delegations</h1>
          <nav className="chat-nav" aria-label="Workforce pages">
            <a className="chat-new" href="/">
              New chat
            </a>
            <a className="chat-new" href="/memory">
              Memory
            </a>
            <a className="chat-new" href="/schedules">
              Schedules
            </a>
            <a className="chat-new" href="/work">
              Work
            </a>
          </nav>
        </header>
        <div role="alert" className="chat-banner chat-banner-warning">
          <p>
            Delegations are listed per chat — open this page from a chat's <code>Delegations</code>{' '}
            link (<code>/delegations?chatId=…</code>).
          </p>
        </div>
      </main>
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
    <main className="chat-layout">
      <header className="chat-header">
        <h1>Delegations</h1>
        <nav className="chat-nav" aria-label="Workforce pages">
          <a className="chat-new" href={backToChatUrl(chatId, agent)}>
            Back to chat
          </a>
          <a className="chat-new" href="/memory">
            Memory
          </a>
          <a className="chat-new" href="/schedules">
            Schedules
          </a>
          <a className="chat-new" href="/work">
            Work
          </a>
        </nav>
      </header>

      {error !== null && (
        <div role="alert" className="chat-banner chat-banner-error">
          <p>{error}</p>
          <button type="button" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      )}
      <p aria-live="polite" className="memory-status">
        {notice?.kind === 'ok' ? notice.text : loading ? 'Loading…' : ''}
      </p>

      <ul className="memory-cards">
        {rows.map((row) => (
          <DelegationCard key={row.id} row={row} />
        ))}
      </ul>
      {rows.length === 0 && (
        <p className="memory-muted">
          {loading ? 'Loading delegations…' : loadedOnce ? 'No delegations have been created from this chat yet.' : ''}
        </p>
      )}
      {pollActive && (
        <p aria-live="polite" className="memory-muted">
          Waiting for pending delegations — this list refreshes itself until each child finishes.
        </p>
      )}
    </main>
  );
}

function DelegationCard({ row }: { row: Delegation }): React.ReactElement {
  const childUrl = childChatUrlFor(row.childChatId, row.targetAgent);
  return (
    <li className={`memory-card delegation-card`} data-status={row.status}>
      <div className="memory-card-head">
        <span className="memory-badge" data-kind={row.targetAgent}>
          → {row.targetAgent}
        </span>
        <span className="memory-badge">{row.mode}</span>
        <span className="memory-badge">depth {row.depth}</span>
        <span className="memory-badge" data-status={row.status}>
          {delegationStatusLabel(row.status)}
        </span>
      </div>
      <p className="memory-card-content">{truncateDelegationText(row.task, DELEGATION_TEXT_LIMIT)}</p>
      {row.result !== null && (
        <>
          <p className="memory-card-title">Worker result</p>
          <p className="memory-card-content">{truncateDelegationText(row.result, DELEGATION_TEXT_LIMIT)}</p>
        </>
      )}
      {row.error !== null && (
        <p className="memory-card-content memory-notice-error">{truncateDelegationText(row.error, DELEGATION_TEXT_LIMIT)}</p>
      )}
      <p className="memory-meta">
        created {formatDelegationTime(row.createdAt)} · completed {formatDelegationTime(row.completedAt)} ·
        delegation <span className="memory-mono">{row.id}</span>
      </p>
      <div className="memory-actions">
        {childUrl !== null && (
          <a className="work-link" href={childUrl.href}>
            Open child chat
          </a>
        )}
        <a className="work-link" href={`/work?chatId=${encodeURIComponent(row.parentChatId)}`}>
          Documents from this chat
        </a>
      </div>
    </li>
  );
}
