'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COMPACT_EXPECTATION_MIN_LENGTH,
  CONTENT_MAX_LENGTH,
  KEYWORD_MAX_LENGTH,
  MEMORY_KINDS,
  PATH_MAX_LENGTH,
  QUERY_MAX_LENGTH,
  SCOPE_MAX_LENGTH,
  compactMemoryPath,
  createMemoryBlock,
  fetchMemoryBlocks,
  fetchRelatedBlocks,
  formatConfidence,
  formatDateTime,
  formatScore,
  hasPendingBlocks,
  retryBlockEmbedding,
  resolveApiBaseUrl,
  searchMemoryBlocks,
  truncateMemoryText,
} from '@/lib/memory';
import type {
  CompactQueued,
  MemoryBlock,
  MemoryRelation,
  RelatedBlocks,
  SearchResultItem,
} from '@/lib/memory';

interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

interface CreatedSignal {
  token: number;
  block: MemoryBlock;
}

const LIMIT_OPTIONS = [5, 10, 20, 50, 100];
const POLL_INTERVAL_MS = 2000;

/**
 * Phase 3 minimal accessible memory workspace. Pure request/mapping/format
 * helpers live in `src/lib/memory.ts` (tested); this component only wires
 * state, events and rendering. Text-only rendering — React escapes
 * everything, so there is no `dangerouslySetInnerHTML` anywhere.
 */
export function Memory(): React.ReactElement {
  const apiBaseUrl = resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL);
  const [created, setCreated] = useState<CreatedSignal | null>(null);
  const createToken = useRef(0);

  return (
    <main className="chat-layout">
      <header className="chat-header">
        <h1>Memory</h1>
        <a className="chat-new" href="/">
          Back to chat
        </a>
      </header>

      <CreatePanel
        apiBaseUrl={apiBaseUrl}
        onCreated={(block) => {
          createToken.current += 1;
          setCreated({ token: createToken.current, block });
        }}
      />
      <BrowsePanel apiBaseUrl={apiBaseUrl} created={created} />
      <SearchPanel apiBaseUrl={apiBaseUrl} />
      <CompactPanel apiBaseUrl={apiBaseUrl} />
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

function CreatePanel({
  apiBaseUrl,
  onCreated,
}: {
  apiBaseUrl: string;
  onCreated: (block: MemoryBlock) => void;
}): React.ReactElement {
  const [scope, setScope] = useState('default');
  const [path, setPath] = useState('');
  const [kind, setKind] = useState<string>('observation');
  const [content, setContent] = useState('');
  const [confidence, setConfidence] = useState('0.8');
  const [supersedesId, setSupersedesId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const result = await createMemoryBlock({
      apiBaseUrl,
      input: { scope, path, kind, content, confidence, supersedesId: supersedesId || undefined },
    });
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    const block = result.block;
    setNotice({
      kind: 'ok',
      text: `Block created (${block.path}, ${block.kind}). Embedding status: ${block.embeddingStatus} — it turns ready once the worker finishes.`,
    });
    setContent('');
    setSupersedesId('');
    onCreated(block);
  };

  return (
    <section className="memory-section" aria-labelledby="memory-create-heading">
      <h2 id="memory-create-heading">Create a memory block</h2>
      <form
        className="memory-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="memory-fieldrow">
          <div className="memory-field">
            <label htmlFor="memory-create-scope">Scope</label>
            <input
              id="memory-create-scope"
              className="memory-input"
              aria-label="Scope"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              required
              maxLength={SCOPE_MAX_LENGTH}
            />
          </div>
          <div className="memory-field memory-field-grow">
            <label htmlFor="memory-create-path">Path</label>
            <input
              id="memory-create-path"
              className="memory-input"
              aria-label="Path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              required
              maxLength={PATH_MAX_LENGTH}
              placeholder="research/small-language-models"
            />
          </div>
          <div className="memory-field">
            <label htmlFor="memory-create-kind">Kind</label>
            <select
              id="memory-create-kind"
              className="memory-input"
              aria-label="Kind"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              required
            >
              {MEMORY_KINDS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="memory-field">
            <label htmlFor="memory-create-confidence">Confidence</label>
            <input
              id="memory-create-confidence"
              className="memory-input"
              aria-label="Confidence"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={confidence}
              onChange={(event) => setConfidence(event.target.value)}
              required
            />
          </div>
        </div>
        <div className="memory-field">
          <label htmlFor="memory-create-content">Content</label>
          <textarea
            id="memory-create-content"
            className="memory-input"
            aria-label="Content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            required
            maxLength={CONTENT_MAX_LENGTH}
            rows={4}
            placeholder="What should be remembered? Plain text, up to 1000 characters."
          />
          <span className="memory-hint">
            {content.trim().length}/{CONTENT_MAX_LENGTH} characters
          </span>
        </div>
        <div className="memory-field">
          <label htmlFor="memory-create-supersedes">Supersedes block ID (optional)</label>
          <input
            id="memory-create-supersedes"
            className="memory-input"
            aria-label="Supersedes block ID (optional)"
            value={supersedesId}
            onChange={(event) => setSupersedesId(event.target.value)}
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
            placeholder="Leave empty, or paste the UUID this block corrects"
          />
        </div>
        <div className="memory-actions">
          <button type="submit" className="memory-button-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create block'}
          </button>
        </div>
        <MemoryNotice notice={notice} />
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Browse                                                              */
/* ------------------------------------------------------------------ */

interface BrowseFilters {
  scope: string;
  path: string;
  kind: string;
  keyword: string;
  includeSuperseded: boolean;
  limit: number;
}

const INITIAL_FILTERS: BrowseFilters = {
  scope: 'default',
  path: '',
  kind: '',
  keyword: '',
  includeSuperseded: false,
  limit: 20,
};

interface BrowseProps {
  apiBaseUrl: string;
  created: CreatedSignal | null;
}

function BrowsePanel({ apiBaseUrl, created }: BrowseProps): React.ReactElement {
  const [filters, setFilters] = useState<BrowseFilters>(INITIAL_FILTERS);
  const [blocks, setBlocks] = useState<ReadonlyArray<MemoryBlock>>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pollActive, setPollActive] = useState(true);

  // Related + retry state live here with the list that triggers them.
  const [related, setRelated] = useState<RelatedState>({
    blockId: null,
    status: 'idle',
    data: null,
    error: null,
  });
  const [retryingIds, setRetryingIds] = useState<ReadonlyArray<string>>([]);

  // Avoids overlapping requests and stale updates: only the response of the
  // newest request may touch state.
  const requestSeq = useRef(0);
  const pollInFlight = useRef(false);

  const refresh = useCallback(
    async (override?: BrowseFilters): Promise<void> => {
      const seq = ++requestSeq.current;
      setLoading(true);
      const result = await fetchMemoryBlocks({ apiBaseUrl, filters: override ?? filters });
      if (seq !== requestSeq.current) return; // superseded by a newer request
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        setNotice(null);
        setPollActive(false); // an error stops automatic polling
        return;
      }
      setError(null);
      setLoadedOnce(true);
      setBlocks(result.blocks);
    },
    [apiBaseUrl, filters],
  );

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Initial load on mount only; typed filter edits apply on Refresh.
  useEffect(() => {
    void refreshRef.current();
  }, []);

  const focusCreated = useCallback(
    (block: MemoryBlock): void => {
      const next: BrowseFilters = {
        scope: block.scope,
        path: block.path,
        kind: block.kind,
        keyword: '',
        includeSuperseded: false,
        limit: 20,
      };
      setFilters(next);
      setPollActive(true);
      setNotice({
        kind: 'ok',
        text: `Listing ${block.scope}/${block.path} (${block.kind}). Embedding status: ${block.embeddingStatus}.`,
      });
      void refreshRef.current(next);
    },
    [],
  );

  // After a create, browse focuses the new block's exact scope/path/kind and
  // refetches so the pending row is visible.
  const createdToken = created?.token;
  useEffect(() => {
    if (created) focusCreated(created.block);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createdToken]);

  // Poll every 2 s ONLY while a rendered block is pending, the tab is
  // visible, no earlier poll is in flight, and no error stopped polling.
  const pending = hasPendingBlocks(blocks);
  useEffect(() => {
    if (!pending || !pollActive) return;
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
  }, [pending, pollActive]);

  const openRelated = useCallback(
    async (blockId: string): Promise<void> => {
      setNotice(null);
      setRelated({ blockId, status: 'loading', data: null, error: null });
      const result = await fetchRelatedBlocks({ apiBaseUrl, blockId });
      if (result.ok) {
        setRelated({ blockId, status: 'done', data: result.related, error: null });
      } else {
        setRelated({ blockId, status: 'error', data: null, error: result.error });
      }
    },
    [apiBaseUrl],
  );

  const retryBlock = useCallback(
    async (blockId: string): Promise<void> => {
      setRetryingIds((current) => [...current, blockId]);
      setNotice(null);
      const result = await retryBlockEmbedding({ apiBaseUrl, blockId });
      setRetryingIds((current) => current.filter((id) => id !== blockId));
      if (result.ok) {
        setNotice({ kind: 'ok', text: `Embedding retry queued for block ${result.retry.blockId}.` });
      } else {
        setNotice({ kind: 'error', text: result.error });
      }
      void refreshRef.current();
    },
    [apiBaseUrl],
  );

  return (
    <section className="memory-section" aria-labelledby="memory-browse-heading">
      <h2 id="memory-browse-heading">Browse blocks</h2>
      <form
        className="memory-form"
        onSubmit={(event) => {
          event.preventDefault();
          setPollActive(true);
          void refresh();
        }}
      >
        <div className="memory-fieldrow">
          <div className="memory-field">
            <label htmlFor="memory-browse-scope">Scope</label>
            <input
              id="memory-browse-scope"
              className="memory-input"
              aria-label="Browse scope"
              value={filters.scope}
              onChange={(event) => setFilters((current) => ({ ...current, scope: event.target.value }))}
              maxLength={SCOPE_MAX_LENGTH}
            />
          </div>
          <div className="memory-field memory-field-grow">
            <label htmlFor="memory-browse-path">Path (prefix match)</label>
            <input
              id="memory-browse-path"
              className="memory-input"
              aria-label="Browse path (prefix match)"
              value={filters.path}
              onChange={(event) => setFilters((current) => ({ ...current, path: event.target.value }))}
              maxLength={PATH_MAX_LENGTH}
              placeholder="research — includes descendants"
            />
          </div>
          <div className="memory-field">
            <label htmlFor="memory-browse-kind">Kind</label>
            <select
              id="memory-browse-kind"
              className="memory-input"
              aria-label="Browse kind"
              value={filters.kind}
              onChange={(event) => setFilters((current) => ({ ...current, kind: event.target.value }))}
            >
              <option value="">Any</option>
              {MEMORY_KINDS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="memory-fieldrow">
          <div className="memory-field memory-field-grow">
            <label htmlFor="memory-browse-keyword">Keyword</label>
            <input
              id="memory-browse-keyword"
              className="memory-input"
              aria-label="Browse keyword"
              value={filters.keyword}
              onChange={(event) => setFilters((current) => ({ ...current, keyword: event.target.value }))}
              maxLength={KEYWORD_MAX_LENGTH}
            />
          </div>
          <div className="memory-field">
            <label htmlFor="memory-browse-limit">Limit</label>
            <select
              id="memory-browse-limit"
              className="memory-input"
              aria-label="Browse limit"
              value={String(filters.limit)}
              onChange={(event) =>
                setFilters((current) => ({ ...current, limit: Number(event.target.value) }))
              }
            >
              {LIMIT_OPTIONS.map((option) => (
                <option key={option} value={String(option)}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="memory-field memory-check">
          <input
            id="memory-browse-superseded"
            type="checkbox"
            aria-label="Include superseded blocks"
            checked={filters.includeSuperseded}
            onChange={(event) =>
              setFilters((current) => ({ ...current, includeSuperseded: event.target.checked }))
            }
          />
          <label htmlFor="memory-browse-superseded">Include superseded blocks</label>
        </div>
        <div className="memory-actions">
          <button type="submit" className="memory-button-primary" disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh list'}
          </button>
        </div>
      </form>

      {error !== null && (
        <div role="alert" className="chat-banner chat-banner-error">
          <p>{error}</p>
        </div>
      )}
      <MemoryStatus
        text={
          notice?.kind === 'ok' ? notice.text : loading ? 'Loading…' : ''
        }
      />

      <ul className="memory-cards">
        {blocks.map((block) => (
          <BlockCard
            key={block.id}
            block={block}
            onRelated={() => void openRelated(block.id)}
            onRetry={() => void retryBlock(block.id)}
            retrying={retryingIds.includes(block.id)}
          />
        ))}
      </ul>
      {blocks.length === 0 && (
        <p className="memory-muted">
          {loading ? 'Loading blocks…' : loadedOnce ? 'No blocks match these filters.' : ''}
        </p>
      )}

      <RelatedView state={related} />
    </section>
  );
}

interface RelatedState {
  blockId: string | null;
  status: 'idle' | 'loading' | 'done' | 'error';
  data: RelatedBlocks | null;
  error: string | null;
}

function BlockCard({
  block,
  onRelated,
  onRetry,
  retrying,
}: {
  block: MemoryBlock;
  onRelated: () => void;
  onRetry: () => void;
  retrying: boolean;
}): React.ReactElement {
  return (
    <li className="memory-card">
      <div className="memory-card-head">
        <span className="memory-card-path">
          {block.scope}/{block.path}
        </span>
        <span className="memory-badge" data-kind={block.kind}>
          {block.kind}
        </span>
        <span className="memory-badge" data-status={block.embeddingStatus}>
          {block.embeddingStatus}
        </span>
        {block.supersededById !== null && (
          <span className="memory-badge memory-badge-superseded">
            superseded by {block.supersededById}
          </span>
        )}
      </div>
      <p className="memory-card-content">{block.content}</p>
      <p className="memory-meta">
        confidence {formatConfidence(block.confidence)} · access count {block.accessCount} ·
        model {block.embeddingModel ?? '—'}
      </p>
      <p className="memory-meta">
        created {formatDateTime(block.createdAt)} · updated {formatDateTime(block.updatedAt, '—')} ·
        embedded {formatDateTime(block.embeddedAt, '—')} · last accessed{' '}
        {formatDateTime(block.lastAccessedAt, '—')}
      </p>
      <div className="memory-actions">
        <button type="button" className="memory-button" onClick={onRelated}>
          Related
        </button>
        <button
          type="button"
          className="memory-button"
          onClick={onRetry}
          disabled={block.embeddingStatus !== 'failed' || retrying}
          title="Re-queues the embedding job. Only failed blocks can retry."
        >
          {retrying ? 'Retrying…' : 'Retry embedding'}
        </button>
      </div>
    </li>
  );
}

function RelatedView({ state }: { state: RelatedState }): React.ReactElement {
  if (state.status === 'idle') return <></>;
  if (state.status === 'loading') {
    return (
      <p aria-live="polite" className="memory-status">
        Loading related blocks…
      </p>
    );
  }
  if (state.status === 'error' || state.data === null) {
    return (
      <div role="alert" className="chat-banner chat-banner-error">
        <p>{state.error ?? 'Related blocks are temporarily unavailable. Try again.'}</p>
      </div>
    );
  }
  const { block, outgoing, incoming } = state.data;
  return (
    <div className="memory-related" aria-live="polite">
      <h3>Related blocks</h3>
      <p className="memory-muted">
        Requested: <span className="memory-mono">{block.id}</span> ({block.scope}/{block.path},{' '}
        {block.kind})
      </p>
      <p className="memory-card-content">{truncateMemoryText(block.content)}</p>
      <RelationList heading="Outgoing relations" edges={outgoing} />
      <RelationList heading="Incoming relations" edges={incoming} />
      {outgoing.length === 0 && incoming.length === 0 && (
        <p className="memory-muted">This block has no relations yet.</p>
      )}
    </div>
  );
}

function RelationList({
  heading,
  edges,
}: {
  heading: string;
  edges: ReadonlyArray<{ relation: MemoryRelation; block: MemoryBlock }>;
}): React.ReactElement {
  if (edges.length === 0) return <></>;
  return (
    <div className="memory-relation-group">
      <h4>{heading}</h4>
      <ul className="memory-relation-list">
        {edges.map((edge, index) => (
          <li key={`${edge.relation.type}-${index}`} className="memory-relation">
            <span className="memory-badge" data-relation={edge.relation.type}>
              {edge.relation.type}
            </span>
            <span className="memory-relation-neighbor">
              {edge.block.scope}/{edge.block.path} ({edge.block.kind}) —{' '}
              {truncateMemoryText(edge.block.content, 160)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Semantic search                                                     */
/* ------------------------------------------------------------------ */

function SearchPanel({ apiBaseUrl }: { apiBaseUrl: string }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [path, setPath] = useState('');
  const [kind, setKind] = useState('');
  const [limit, setLimit] = useState(20);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ReadonlyArray<SearchResultItem> | null>(null);
  const [error, setError] = useState<Notice | null>(null);
  const [ran, setRan] = useState(false);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await searchMemoryBlocks({ apiBaseUrl, input: { query, path, kind, limit } });
    setBusy(false);
    setRan(true);
    if (!result.ok) {
      setError({ kind: 'error', text: result.error });
      setResults(null);
      return;
    }
    setResults(result.results);
  };

  return (
    <section className="memory-section" aria-labelledby="memory-search-heading">
      <h2 id="memory-search-heading">Semantic search</h2>
      <p className="memory-muted">
        Final score = 80% semantic (cosine similarity between embeddings) + 20% recency. Only
        blocks whose embedding is ready are searchable.
      </p>
      <form
        className="memory-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="memory-field">
          <label htmlFor="memory-search-query">Query</label>
          <textarea
            id="memory-search-query"
            className="memory-input"
            aria-label="Search query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            required
            maxLength={QUERY_MAX_LENGTH}
            rows={2}
            placeholder="e.g. what did we learn about small model latency?"
          />
        </div>
        <div className="memory-fieldrow">
          <div className="memory-field memory-field-grow">
            <label htmlFor="memory-search-path">Path (optional)</label>
            <input
              id="memory-search-path"
              className="memory-input"
              aria-label="Search path (optional)"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              maxLength={PATH_MAX_LENGTH}
            />
          </div>
          <div className="memory-field">
            <label htmlFor="memory-search-kind">Kind</label>
            <select
              id="memory-search-kind"
              className="memory-input"
              aria-label="Search kind"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="">Any</option>
              {MEMORY_KINDS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="memory-field">
            <label htmlFor="memory-search-limit">Limit</label>
            <select
              id="memory-search-limit"
              className="memory-input"
              aria-label="Search limit"
              value={String(limit)}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMIT_OPTIONS.map((option) => (
                <option key={option} value={String(option)}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="memory-actions">
          <button type="submit" className="memory-button-primary" disabled={busy}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>
      <MemoryNotice notice={error} />
      <MemoryStatus text={busy ? 'Searching…' : ''} />
      {ran && results !== null && (
        <ul className="memory-cards">
          {results.map((result) => (
            <li key={result.block.id} className="memory-card">
              <div className="memory-card-head">
                <span className="memory-card-path">
                  {result.block.scope}/{result.block.path}
                </span>
                <span className="memory-badge" data-kind={result.block.kind}>
                  {result.block.kind}
                </span>
              </div>
              <p className="memory-card-content">{result.block.content}</p>
              <p className="memory-meta">
                cosine {formatScore(result.cosineSimilarity)} · recency{' '}
                {formatScore(result.recencyScore)} · final {formatScore(result.score)} (80%
                semantic + 20% recency)
              </p>
            </li>
          ))}
          {results.length === 0 && (
            <li className="memory-muted">No ready embeddings matched this query.</li>
          )}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Compaction                                                          */
/* ------------------------------------------------------------------ */

function CompactPanel({ apiBaseUrl }: { apiBaseUrl: string }): React.ReactElement {
  const [scope, setScope] = useState('default');
  const [path, setPath] = useState('');
  const [expectation, setExpectation] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [queued, setQueued] = useState<CompactQueued | null>(null);

  // Intentionality gate: an expectation of more than 30 characters proves the
  // action is deliberate. Nothing is summarized client-side — the API job
  // owns the summary; the UI only reports the queued response.
  const expectationOk = expectation.trim().length > COMPACT_EXPECTATION_MIN_LENGTH;

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setQueued(null);
    const result = await compactMemoryPath({ apiBaseUrl, scope, path });
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setQueued(result.compact);
    setNotice({
      kind: 'ok',
      text: `Compaction queued for ${result.compact.scope}/${result.compact.path} (trigger block ${result.compact.triggerBlockId}). The summary block will appear in the list once the job finishes.`,
    });
    setExpectation('');
  };

  return (
    <section className="memory-section" aria-labelledby="memory-compact-heading">
      <h2 id="memory-compact-heading">Compact a path</h2>
      <p className="memory-muted">
        Compaction applies when an exact path holds more than 30 active blocks: the API summarizes
        the oldest 30 and supersedes them. Trigger it deliberately — describe your expectation
        first.
      </p>
      <form
        className="memory-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!expectationOk) return; // native minlength also blocks this
          void submit();
        }}
      >
        <div className="memory-fieldrow">
          <div className="memory-field">
            <label htmlFor="memory-compact-scope">Scope</label>
            <input
              id="memory-compact-scope"
              className="memory-input"
              aria-label="Compact scope"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              required
              maxLength={SCOPE_MAX_LENGTH}
            />
          </div>
          <div className="memory-field memory-field-grow">
            <label htmlFor="memory-compact-path">Path (exact match)</label>
            <input
              id="memory-compact-path"
              className="memory-input"
              aria-label="Compact path (exact match)"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              required
              maxLength={PATH_MAX_LENGTH}
              placeholder="research/small-language-models"
            />
          </div>
        </div>
        <div className="memory-field">
          <label htmlFor="memory-compact-expectation">What should the summary capture?</label>
          <textarea
            id="memory-compact-expectation"
            className="memory-input"
            aria-label="What should the summary capture?"
            value={expectation}
            onChange={(event) => setExpectation(event.target.value)}
            required
            minLength={COMPACT_EXPECTATION_MIN_LENGTH + 1}
            rows={3}
            placeholder="e.g. Summarize the benchmark observations into one learning covering latency and cost trade-offs."
          />
          <span
            className="memory-hint"
            aria-live="polite"
          >
            {expectationOk
              ? 'Ready to queue.'
              : `More than ${COMPACT_EXPECTATION_MIN_LENGTH} characters required (now ${expectation.trim().length}).`}
          </span>
        </div>
        <div className="memory-actions">
          <button type="submit" className="memory-button-primary" disabled={busy}>
            {busy ? 'Queuing…' : 'Queue compaction'}
          </button>
        </div>
        <MemoryNotice notice={notice} />
        {queued !== null && (
          <p className="memory-meta">
            Queued: scope {queued.scope} · path {queued.path} · trigger block{' '}
            {queued.triggerBlockId}. No summary exists yet.
          </p>
        )}
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function MemoryNotice({ notice }: { notice: Notice | null }): React.ReactElement {
  if (notice === null) return <></>;
  return (
    <p
      aria-live="polite"
      role={notice.kind === 'error' ? 'alert' : 'status'}
      className={`memory-notice memory-notice-${notice.kind}`}
    >
      {notice.text}
    </p>
  );
}

function MemoryStatus({ text }: { text: string }): React.ReactElement {
  return (
    <p aria-live="polite" className="memory-status">
      {text}
    </p>
  );
}
