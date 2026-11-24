'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceShell } from '@/components/WorkspaceShell';
import { StatusBadge } from '@/components/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
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
 * Phase 3 memory workspace on the shared Tailwind + shadcn shell. Pure
 * request/mapping/format helpers live in `src/lib/memory.ts` (tested); this
 * component only wires state, events and rendering. Text-only rendering —
 * React escapes everything, so there is no `dangerouslySetInnerHTML`
 * anywhere.
 */
export function Memory(): React.ReactElement {
  const apiBaseUrl = resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL);
  const [created, setCreated] = useState<CreatedSignal | null>(null);
  const createToken = useRef(0);

  return (
    <WorkspaceShell
      active="memory"
      eyebrow="Knowledge"
      title="Memory"
      description="The blocks agents remember — create, browse, search, relate and compact them. Embeddings run server-side; this page only reads and lists."
    >
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
    </WorkspaceShell>
  );
}

/* ------------------------------------------------------------------ */
/* Shared form primitives (Tailwind + shadcn, no parallel system)        */
/* ------------------------------------------------------------------ */

function Field({
  grow = false,
  full = false,
  className,
  children,
}: {
  grow?: boolean;
  full?: boolean;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const width = full
    ? 'min-w-0 basis-full'
    : grow
      ? 'flex-[2_1_14rem] min-w-56'
      : 'min-w-0 flex-1 basis-32';
  return (
    <div className={cn('flex flex-col gap-1 text-sm', width, className)}>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="flex flex-wrap gap-3">{children}</div>;
}

function Form({
  onSubmit,
  children,
}: {
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(event);
      }}
    >
      {children}
    </form>
  );
}

function Hint({ live = false, children }: { live?: boolean; children: React.ReactNode }): React.ReactElement {
  return (
    <p aria-live={live ? 'polite' : undefined} className="m-0 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function NoticeText({ notice, live = false }: { notice: Notice | null; live?: boolean }): React.ReactElement {
  if (notice === null) return <></>;
  return (
    <p
      aria-live={live ? 'polite' : undefined}
      role={notice.kind === 'error' ? 'alert' : 'status'}
      className={cn(
        'm-0 rounded-md px-2.5 py-1.5 text-[0.85rem]',
        notice.kind === 'ok'
          ? 'border border-emerald-200 bg-emerald-50 text-emerald-900'
          : 'border border-red-200 bg-red-50 text-red-800',
      )}
    >
      {notice.text}
    </p>
  );
}

function StatusLine({ text }: { text: string }): React.ReactElement {
  return <p aria-live="polite" className="m-0 min-h-5 text-sm text-muted-foreground">{text}</p>;
}

function ErrorBanner({ text, children }: { text: string; children?: React.ReactNode }): React.ReactElement {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
      <p className="m-0">{text}</p>
      {children}
    </div>
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
    <Card aria-labelledby="memory-create-heading" className="gap-4 px-4 py-4 sm:px-5 sm:py-5">
      <h2 id="memory-create-heading" className="m-0 text-base font-semibold tracking-tight">
        Create a memory block
      </h2>
      <Form
        onSubmit={() => {
          void submit();
        }}
      >
        <Row>
          <Field>
            <Label htmlFor="memory-create-scope">Scope</Label>
            <Input
              id="memory-create-scope"
              aria-label="Scope"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              required
              maxLength={SCOPE_MAX_LENGTH}
            />
          </Field>
          <Field grow>
            <Label htmlFor="memory-create-path">Path</Label>
            <Input
              id="memory-create-path"
              aria-label="Path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              required
              maxLength={PATH_MAX_LENGTH}
              placeholder="research/small-language-models"
            />
          </Field>
          <Field>
            <Label htmlFor="memory-create-kind">Kind</Label>
            <NativeSelect
              id="memory-create-kind"
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
            </NativeSelect>
          </Field>
          <Field>
            <Label htmlFor="memory-create-confidence">Confidence</Label>
            <Input
              id="memory-create-confidence"
              aria-label="Confidence"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={confidence}
              onChange={(event) => setConfidence(event.target.value)}
              required
            />
          </Field>
        </Row>
        <Field full>
          <Label htmlFor="memory-create-content">Content</Label>
          <Textarea
            id="memory-create-content"
            aria-label="Content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            required
            maxLength={CONTENT_MAX_LENGTH}
            rows={4}
            placeholder="What should be remembered? Plain text, up to 1000 characters."
          />
          <span className="text-xs text-muted-foreground">
            {content.trim().length}/{CONTENT_MAX_LENGTH} characters
          </span>
        </Field>
        <Field full>
          <Label htmlFor="memory-create-supersedes">Supersedes block ID (optional)</Label>
          <Input
            id="memory-create-supersedes"
            aria-label="Supersedes block ID (optional)"
            value={supersedesId}
            onChange={(event) => setSupersedesId(event.target.value)}
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
            placeholder="Leave empty, or paste the UUID this block corrects"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create block'}
          </Button>
        </div>
        <NoticeText notice={notice} />
      </Form>
    </Card>
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
    <Card aria-labelledby="memory-browse-heading" className="gap-4 px-4 py-4 sm:px-5 sm:py-5">
      <h2 id="memory-browse-heading" className="m-0 text-base font-semibold tracking-tight">
        Browse blocks
      </h2>
      <Form
        onSubmit={() => {
          setPollActive(true);
          void refresh();
        }}
      >
        <Row>
          <Field>
            <Label htmlFor="memory-browse-scope">Scope</Label>
            <Input
              id="memory-browse-scope"
              aria-label="Browse scope"
              value={filters.scope}
              onChange={(event) => setFilters((current) => ({ ...current, scope: event.target.value }))}
              maxLength={SCOPE_MAX_LENGTH}
            />
          </Field>
          <Field grow>
            <Label htmlFor="memory-browse-path">Path (prefix match)</Label>
            <Input
              id="memory-browse-path"
              aria-label="Browse path (prefix match)"
              value={filters.path}
              onChange={(event) => setFilters((current) => ({ ...current, path: event.target.value }))}
              maxLength={PATH_MAX_LENGTH}
              placeholder="research — includes descendants"
            />
          </Field>
          <Field>
            <Label htmlFor="memory-browse-kind">Kind</Label>
            <NativeSelect
              id="memory-browse-kind"
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
            </NativeSelect>
          </Field>
        </Row>
        <Row>
          <Field grow>
            <Label htmlFor="memory-browse-keyword">Keyword</Label>
            <Input
              id="memory-browse-keyword"
              aria-label="Browse keyword"
              value={filters.keyword}
              onChange={(event) => setFilters((current) => ({ ...current, keyword: event.target.value }))}
              maxLength={KEYWORD_MAX_LENGTH}
            />
          </Field>
          <Field>
            <Label htmlFor="memory-browse-limit">Limit</Label>
            <NativeSelect
              id="memory-browse-limit"
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
            </NativeSelect>
          </Field>
        </Row>
        <div className="flex flex-none items-center gap-2 text-sm">
          <input
            id="memory-browse-superseded"
            type="checkbox"
            aria-label="Include superseded blocks"
            className="size-4 accent-primary"
            checked={filters.includeSuperseded}
            onChange={(event) =>
              setFilters((current) => ({ ...current, includeSuperseded: event.target.checked }))
            }
          />
          <Label htmlFor="memory-browse-superseded" className="font-normal">
            Include superseded blocks
          </Label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh list'}
          </Button>
        </div>
      </Form>

      {error !== null && <ErrorBanner text={error} />}
      <StatusLine
        text={
          notice?.kind === 'ok' ? notice.text : loading ? 'Loading…' : ''
        }
      />

      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {blocks.map((block) => (
          <li key={block.id} className="list-none">
            <BlockCard
              block={block}
              onRelated={() => void openRelated(block.id)}
              onRetry={() => void retryBlock(block.id)}
              retrying={retryingIds.includes(block.id)}
            />
          </li>
        ))}
      </ul>
      {blocks.length === 0 && (
        <p className="m-0 text-sm text-muted-foreground">
          {loading ? 'Loading blocks…' : loadedOnce ? 'No blocks match these filters.' : ''}
        </p>
      )}

      <RelatedView state={related} />
    </Card>
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
    <Card className="gap-2.5 bg-muted/50 px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs break-all">
          {block.scope}/{block.path}
        </span>
        <Badge variant="secondary" data-kind={block.kind}>
          {block.kind}
        </Badge>
        <StatusBadge status={block.embeddingStatus}>
          {block.embeddingStatus}
        </StatusBadge>
        {block.supersededById !== null && (
          <Badge variant="outline" data-superseded="true" className="max-w-full tracking-normal normal-case">
            superseded by {block.supersededById}
          </Badge>
        )}
      </div>
      <p className="m-0 text-sm break-words whitespace-pre-wrap">{block.content}</p>
      <p className="m-0 text-xs break-all text-muted-foreground">
        confidence {formatConfidence(block.confidence)} · access count {block.accessCount} ·
        model {block.embeddingModel ?? '—'}
      </p>
      <p className="m-0 text-xs break-all text-muted-foreground">
        created {formatDateTime(block.createdAt)} · updated {formatDateTime(block.updatedAt, '—')} ·
        embedded {formatDateTime(block.embeddedAt, '—')} · last accessed{' '}
        {formatDateTime(block.lastAccessedAt, '—')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onRelated}>
          Related
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={block.embeddingStatus !== 'failed' || retrying}
          title="Re-queues the embedding job. Only failed blocks can retry."
        >
          {retrying ? 'Retrying…' : 'Retry embedding'}
        </Button>
      </div>
    </Card>
  );
}

function RelatedView({ state }: { state: RelatedState }): React.ReactElement {
  if (state.status === 'idle') return <></>;
  if (state.status === 'loading') {
    return (
      <p aria-live="polite" className="m-0 min-h-5 text-sm text-muted-foreground">
        Loading related blocks…
      </p>
    );
  }
  if (state.status === 'error' || state.data === null) {
    return <ErrorBanner text={state.error ?? 'Related blocks are temporarily unavailable. Try again.'} />;
  }
  const { block, outgoing, incoming } = state.data;
  return (
    <div className="flex flex-col gap-2.5 border-t pt-3" aria-live="polite">
      <h3 className="m-0 text-[0.95rem] font-semibold">Related blocks</h3>
      <p className="m-0 text-sm break-all text-muted-foreground">
        Requested: <span className="font-mono">{block.id}</span> ({block.scope}/{block.path},{' '}
        {block.kind})
      </p>
      <p className="m-0 text-sm break-words whitespace-pre-wrap">{truncateMemoryText(block.content)}</p>
      <RelationList heading="Outgoing relations" edges={outgoing} />
      <RelationList heading="Incoming relations" edges={incoming} />
      {outgoing.length === 0 && incoming.length === 0 && (
        <p className="m-0 text-sm text-muted-foreground">This block has no relations yet.</p>
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
    <div className="min-w-0">
      <h4 className="mt-2 mb-1 text-[0.85rem] font-semibold text-muted-foreground">{heading}</h4>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {edges.map((edge, index) => (
          <li key={`${edge.relation.type}-${index}`} className="flex flex-wrap items-baseline gap-2 text-[0.85rem]">
            <Badge variant="outline" data-relation={edge.relation.type}>
              {edge.relation.type}
            </Badge>
            <span className="min-w-0 break-all">
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
    <Card aria-labelledby="memory-search-heading" className="gap-4 px-4 py-4 sm:px-5 sm:py-5">
      <h2 id="memory-search-heading" className="m-0 text-base font-semibold tracking-tight">
        Semantic search
      </h2>
      <Hint>
        Final score = 80% semantic (cosine similarity between embeddings) + 20% recency. Only
        blocks whose embedding is ready are searchable.
      </Hint>
      <Form
        onSubmit={() => {
          void submit();
        }}
      >
        <Field full>
          <Label htmlFor="memory-search-query">Query</Label>
          <Textarea
            id="memory-search-query"
            aria-label="Search query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            required
            maxLength={QUERY_MAX_LENGTH}
            rows={2}
            placeholder="e.g. what did we learn about small model latency?"
          />
        </Field>
        <Row>
          <Field grow>
            <Label htmlFor="memory-search-path">Path (optional)</Label>
            <Input
              id="memory-search-path"
              aria-label="Search path (optional)"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              maxLength={PATH_MAX_LENGTH}
            />
          </Field>
          <Field>
            <Label htmlFor="memory-search-kind">Kind</Label>
            <NativeSelect
              id="memory-search-kind"
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
            </NativeSelect>
          </Field>
          <Field>
            <Label htmlFor="memory-search-limit">Limit</Label>
            <NativeSelect
              id="memory-search-limit"
              aria-label="Search limit"
              value={String(limit)}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMIT_OPTIONS.map((option) => (
                <option key={option} value={String(option)}>
                  {option}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </Row>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Searching…' : 'Search'}
          </Button>
        </div>
      </Form>
      <NoticeText notice={error} />
      <StatusLine text={busy ? 'Searching…' : ''} />
      {ran && results !== null && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {results.map((result) => (
            <li key={result.block.id} className="list-none">
              <Card className="gap-2.5 bg-muted/50 px-3.5 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs break-all">
                    {result.block.scope}/{result.block.path}
                  </span>
                  <Badge variant="secondary" data-kind={result.block.kind}>
                    {result.block.kind}
                  </Badge>
                </div>
                <p className="m-0 text-sm break-words whitespace-pre-wrap">{result.block.content}</p>
                <p className="m-0 text-xs break-all text-muted-foreground">
                  cosine {formatScore(result.cosineSimilarity)} · recency{' '}
                  {formatScore(result.recencyScore)} · final {formatScore(result.score)} (80%
                  semantic + 20% recency)
                </p>
              </Card>
            </li>
          ))}
          {results.length === 0 && (
            <li className="text-sm text-muted-foreground">No ready embeddings matched this query.</li>
          )}
        </ul>
      )}
    </Card>
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
    <Card aria-labelledby="memory-compact-heading" className="gap-4 px-4 py-4 sm:px-5 sm:py-5">
      <h2 id="memory-compact-heading" className="m-0 text-base font-semibold tracking-tight">
        Compact a path
      </h2>
      <Hint>
        Compaction applies when an exact path holds more than 30 active blocks: the API summarizes
        the oldest 30 and supersedes them. Trigger it deliberately — describe your expectation
        first.
      </Hint>
      <Form
        onSubmit={() => {
          if (!expectationOk) return; // native minlength also blocks this
          void submit();
        }}
      >
        <Row>
          <Field>
            <Label htmlFor="memory-compact-scope">Scope</Label>
            <Input
              id="memory-compact-scope"
              aria-label="Compact scope"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              required
              maxLength={SCOPE_MAX_LENGTH}
            />
          </Field>
          <Field grow>
            <Label htmlFor="memory-compact-path">Path (exact match)</Label>
            <Input
              id="memory-compact-path"
              aria-label="Compact path (exact match)"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              required
              maxLength={PATH_MAX_LENGTH}
              placeholder="research/small-language-models"
            />
          </Field>
        </Row>
        <Field full>
          <Label htmlFor="memory-compact-expectation">What should the summary capture?</Label>
          <Textarea
            id="memory-compact-expectation"
            aria-label="What should the summary capture?"
            value={expectation}
            onChange={(event) => setExpectation(event.target.value)}
            required
            minLength={COMPACT_EXPECTATION_MIN_LENGTH + 1}
            rows={3}
            placeholder="e.g. Summarize the benchmark observations into one learning covering latency and cost trade-offs."
          />
          <span aria-live="polite" className="text-xs text-muted-foreground">
            {expectationOk
              ? 'Ready to queue.'
              : `More than ${COMPACT_EXPECTATION_MIN_LENGTH} characters required (now ${expectation.trim().length}).`}
          </span>
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Queuing…' : 'Queue compaction'}
          </Button>
        </div>
        <NoticeText notice={notice} />
        {queued !== null && (
          <p className="m-0 text-xs break-all text-muted-foreground">
            Queued: scope {queued.scope} · path {queued.path} · trigger block{' '}
            {queued.triggerBlockId}. No summary exists yet.
          </p>
        )}
      </Form>
    </Card>
  );
}
