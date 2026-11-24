'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildWorkDocCreateBody,
  createWorkDoc,
  fetchWorkDocList,
  formatWorkDocTime,
  workDocPagePath,
  WORK_DOC_TYPES,
  WORK_DOC_STATUSES,
  type WorkDoc,
} from '@/lib/workdocs';
import { backToChatUrl } from '@/lib/agents';

export interface WorkDocsListProps {
  apiBaseUrl: string;
  /** `?chatId=` — optional ownership filter owned by the URL. */
  initialChatId: string;
  /** `?agent=` — lets "Back to chat" return to the same agent's transcript. */
  initialAgent: string;
  initialScope: string;
}

interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `/work` — Work Docs library (Phase 4). Filter/list through the real GET
 * route; create through the real orchestrator POST route (draft v1) when a
 * chat context is set. Pure request/mapping/format helpers live in
 * `src/lib/workdocs.ts` (tested); this component only wires state, events and
 * rendering. Text-only rendering — React escapes everything, so there is no
 * `dangerouslySetInnerHTML` anywhere. Each entry links to its detail page
 * together with the owning chat id: the detail route answers a fixed 404
 * without that chat, so no cross-chat existence leaks either way.
 */
export function WorkDocsList({ apiBaseUrl, initialChatId, initialAgent, initialScope }: WorkDocsListProps): React.ReactElement {
  const [filters, setFilters] = useState({
    scope: initialScope,
    chatId: initialChatId,
    type: '',
    status: '',
    limit: 20,
  });
  const [documents, setDocuments] = useState<ReadonlyArray<WorkDoc>>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Avoids overlapping requests and stale updates: only the response of the
  // newest request may touch state.
  const requestSeq = useRef(0);

  const refresh = useCallback(
    async (override?: typeof filters): Promise<void> => {
      const seq = ++requestSeq.current;
      setLoading(true);
      const result = await fetchWorkDocList({ apiBaseUrl, filters: override ?? filters });
      if (seq !== requestSeq.current) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        setNotice(null);
        return;
      }
      setError(null);
      setLoadedOnce(true);
      setDocuments(result.documents);
      setNotice({
        kind: 'ok',
        text: `${result.documents.length} document(s) listed.`,
      });
    },
    [apiBaseUrl, filters],
  );

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refreshRef.current();
  }, []);

  // Create state (library creation through the real orchestrator POST route).
  const [createType, setCreateType] = useState<string>(WORK_DOC_TYPES[0]);
  const [createTitle, setCreateTitle] = useState('');
  const [createContent, setCreateContent] = useState('');
  const [createNotice, setCreateNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(false);

  const submitCreate = async (): Promise<void> => {
    if (creating || !CHAT_ID_PATTERN.test(filters.chatId)) return;
    setCreating(true);
    setCreateNotice(null);
    const body = buildWorkDocCreateBody({
      chatId: filters.chatId,
      type: createType,
      title: createTitle,
      content: createContent,
    });
    if (!body.ok) {
      setCreating(false);
      setCreateNotice({ kind: 'error', text: body.error });
      return;
    }
    const result = await createWorkDoc({ apiBaseUrl, body: body.body });
    setCreating(false);
    if (!result.ok) {
      setCreateNotice({
        kind: 'error',
        text: result.error.includes('version conflict')
          ? result.error
          : result.error.includes('Not found') || result.error.includes('404')
            ? 'The API does not serve document creation here. Open a document from an orchestrator chat instead.'
            : result.error,
      });
      return;
    }
    setCreateNotice({
      kind: 'ok',
      text: `Created "${result.document.title}" as draft v1 for chat ${result.document.chatId}.`,
    });
    setCreateTitle('');
    setCreateContent('');
    void refreshRef.current();
  };

  return (
    <main className="chat-layout">
      <header className="chat-header">
        <h1>Work documents</h1>
        <nav className="chat-nav" aria-label="Workforce pages">
          {CHAT_ID_PATTERN.test(filters.chatId) && (
            <a className="chat-new" href={backToChatUrl(filters.chatId, initialAgent)}>
              Back to chat
            </a>
          )}
          <a className="chat-new" href="/memory">
            Memory
          </a>
          <a className="chat-new" href="/schedules">
            Schedules
          </a>
          <a className="chat-new" href="/">
            New chat
          </a>
        </nav>
      </header>

      <section className="memory-section" aria-labelledby="work-create-heading">
        <h2 id="work-create-heading">Create a document</h2>
        {CHAT_ID_PATTERN.test(filters.chatId) ? (
          <form
            className="memory-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
          >
            <div className="memory-fieldrow">
              <div className="memory-field">
                <label htmlFor="work-create-type">Type</label>
                <select
                  id="work-create-type"
                  className="memory-input"
                  aria-label="New document type"
                  value={createType}
                  onChange={(event) => setCreateType(event.target.value)}
                >
                  {WORK_DOC_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <div className="memory-field memory-field-grow">
                <label htmlFor="work-create-title">Title</label>
                <input
                  id="work-create-title"
                  className="memory-input"
                  aria-label="New document title"
                  value={createTitle}
                  onChange={(event) => setCreateTitle(event.target.value)}
                  required
                  maxLength={200}
                  placeholder="What is this document about?"
                />
              </div>
            </div>
            <div className="memory-field">
              <label htmlFor="work-create-content">Content</label>
              <textarea
                id="work-create-content"
                className="memory-input"
                aria-label="New document content"
                value={createContent}
                onChange={(event) => setCreateContent(event.target.value)}
                required
                rows={4}
                maxLength={100000}
                placeholder="First version — saved as draft v1"
              />
            </div>
            <div className="memory-actions">
              <button type="submit" className="memory-button-primary" disabled={creating}>
                {creating ? 'Creating…' : 'Create draft'}
              </button>
              <span className="memory-hint">
                Created for chat {filters.chatId} as a draft (v1). Editing later happens on the
                document's page.
              </span>
            </div>
            {createNotice !== null && (
              <p
                role={createNotice.kind === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                className={`memory-notice memory-notice-${createNotice.kind === 'ok' ? 'ok' : 'error'}`}
              >
                {createNotice.text}
              </p>
            )}
          </form>
        ) : (
          <p className="memory-muted">
            Set a Chat ID filter (or open <code>/work</code> from a chat's Work link) to create a
            document: every document is owned by exactly one chat.
          </p>
        )}
      </section>

      <section className="memory-section" aria-labelledby="work-list-heading">
        <h2 id="work-list-heading">Find documents</h2>
        <form
          className="memory-form"
          onSubmit={(event) => {
            event.preventDefault();
            void refresh();
          }}
        >
          <div className="memory-fieldrow">
            <div className="memory-field">
              <label htmlFor="work-list-scope">Scope</label>
              <input
                id="work-list-scope"
                className="memory-input"
                aria-label="List scope"
                value={filters.scope}
                onChange={(event) => setFilters((current) => ({ ...current, scope: event.target.value }))}
                maxLength={64}
              />
            </div>
            <div className="memory-field memory-field-grow">
              <label htmlFor="work-list-chatid">Chat ID (ownership filter)</label>
              <input
                id="work-list-chatid"
                className="memory-input"
                aria-label="Filter by chat ID"
                value={filters.chatId}
                onChange={(event) => setFilters((current) => ({ ...current, chatId: event.target.value }))}
                placeholder="Leave empty to list documents of the whole scope"
              />
            </div>
          </div>
          <div className="memory-fieldrow">
            <div className="memory-field">
              <label htmlFor="work-list-type">Type</label>
              <select
                id="work-list-type"
                className="memory-input"
                aria-label="Filter by type"
                value={filters.type}
                onChange={(event) => setFilters((current) => ({ ...current, type: event.target.value }))}
              >
                <option value="">Any</option>
                {WORK_DOC_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div className="memory-field">
              <label htmlFor="work-list-status">Status</label>
              <select
                id="work-list-status"
                className="memory-input"
                aria-label="Filter by status"
                value={filters.status}
                onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
              >
                <option value="">Any</option>
                {WORK_DOC_STATUSES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="memory-actions">
            <button type="submit" className="memory-button-primary" disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </form>

        {error !== null && (
          <div role="alert" className="chat-banner chat-banner-error">
            <p>{error}</p>
          </div>
        )}
        <p aria-live="polite" className="memory-status">
          {notice?.kind === 'ok' ? notice.text : loading ? 'Loading…' : ''}
        </p>

        <ul className="memory-cards">
          {documents.map((doc) => (
            <WorkDocCard key={doc.id} doc={doc} />
          ))}
        </ul>
        {documents.length === 0 && (
          <p className="memory-muted">
            {loading ? 'Loading documents…' : loadedOnce ? 'No documents match these filters.' : ''}
          </p>
        )}
      </section>
    </main>
  );
}

function WorkDocCard({ doc }: { doc: WorkDoc }): React.ReactElement {
  return (
    <li className="memory-card">
      <div className="memory-card-head">
        <span className="memory-badge" data-kind={doc.type}>
          {doc.type}
        </span>
        <span className="memory-badge" data-status={doc.status}>
          {doc.status}
        </span>
        <span className="memory-badge">v{doc.version}</span>
      </div>
      <p className="memory-card-title">{doc.title}</p>
      <p className="memory-meta">
        chat {doc.chatId} · updated {formatWorkDocTime(doc.updatedAt)} · created{' '}
        {formatWorkDocTime(doc.createdAt)}
      </p>
      <div className="memory-actions">
        {CHAT_ID_PATTERN.test(doc.chatId) ? (
          <a className="work-link" href={workDocPagePath(doc.id, doc.chatId)}>
            Open document
          </a>
        ) : (
          <span className="memory-muted">Open this document from its own chat.</span>
        )}
      </div>
    </li>
  );
}
