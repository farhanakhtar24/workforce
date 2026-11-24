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
 * `/work` — Work Docs library (Phase 4) on the shared Tailwind + shadcn
 * shell. Filter/list through the real GET route; create through the real
 * orchestrator POST route (draft v1) when a chat context is set. Pure
 * request/mapping/format helpers live in `src/lib/workdocs.ts` (tested); this
 * component only wires state, events and rendering. Text-only rendering —
 * React escapes everything, so there is no `dangerouslySetInnerHTML`
 * anywhere. Each entry links to its detail page together with the owning
 * chat id: the detail route answers a fixed 404 without that chat, so no
 * cross-chat existence leaks either way.
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

  const chatContext = CHAT_ID_PATTERN.test(filters.chatId);

  return (
    <WorkspaceShell
      active="work"
      eyebrow="Workspace output"
      title="Work documents"
      description="Versioned documents agents write and you edit — every save is a new immutable version, and history is never rewritten."
      context={
        chatContext ? (
          <a
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            href={backToChatUrl(filters.chatId, initialAgent)}
          >
            Back to chat
          </a>
        ) : undefined
      }
    >
      <Card aria-labelledby="work-create-heading" className="gap-4 px-4 py-4 sm:px-5 sm:py-5">
        <h2 id="work-create-heading" className="m-0 text-base font-semibold tracking-tight">
          Create a document
        </h2>
        {chatContext ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
          >
            <div className="flex flex-wrap gap-3">
              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <Label htmlFor="work-create-type">Type</Label>
                <NativeSelect
                  id="work-create-type"
                  aria-label="New document type"
                  value={createType}
                  onChange={(event) => setCreateType(event.target.value)}
                >
                  {WORK_DOC_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-[2_1_14rem] min-w-56 flex-col gap-1 text-sm">
                <Label htmlFor="work-create-title">Title</Label>
                <Input
                  id="work-create-title"
                  aria-label="New document title"
                  value={createTitle}
                  onChange={(event) => setCreateTitle(event.target.value)}
                  required
                  maxLength={200}
                  placeholder="What is this document about?"
                />
              </div>
            </div>
            <div className="flex min-w-0 basis-full flex-col gap-1 text-sm">
              <Label htmlFor="work-create-content">Content</Label>
              <Textarea
                id="work-create-content"
                aria-label="New document content"
                value={createContent}
                onChange={(event) => setCreateContent(event.target.value)}
                required
                rows={4}
                maxLength={100000}
                placeholder="First version — saved as draft v1"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={creating}>
                {creating ? 'Creating…' : 'Create draft'}
              </Button>
              <span className="text-xs text-muted-foreground">
                Created for chat {filters.chatId} as a draft (v1). Editing later happens on the
                document's page.
              </span>
            </div>
            {createNotice !== null && (
              <p
                role={createNotice.kind === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                className={
                  createNotice.kind === 'ok'
                    ? 'm-0 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[0.85rem] text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200'
                    : 'm-0 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[0.85rem] text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200'
                }
              >
                {createNotice.text}
              </p>
            )}
          </form>
        ) : (
          <p className="m-0 text-sm text-muted-foreground">
            Set a Chat ID filter (or open <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">/work</code> from a chat's Work link) to create a
            document: every document is owned by exactly one chat.
          </p>
        )}
      </Card>

      <Card aria-labelledby="work-list-heading" className="gap-4 px-4 py-4 sm:px-5 sm:py-5">
        <h2 id="work-list-heading" className="m-0 text-base font-semibold tracking-tight">
          Find documents
        </h2>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void refresh();
          }}
        >
          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-0 flex-1 basis-32 flex-col gap-1 text-sm">
              <Label htmlFor="work-list-scope">Scope</Label>
              <Input
                id="work-list-scope"
                aria-label="List scope"
                value={filters.scope}
                onChange={(event) => setFilters((current) => ({ ...current, scope: event.target.value }))}
                maxLength={64}
              />
            </div>
            <div className="flex min-w-0 flex-[2_1_14rem] min-w-56 flex-col gap-1 text-sm">
              <Label htmlFor="work-list-chatid">Chat ID (ownership filter)</Label>
              <Input
                id="work-list-chatid"
                aria-label="Filter by chat ID"
                value={filters.chatId}
                onChange={(event) => setFilters((current) => ({ ...current, chatId: event.target.value }))}
                placeholder="Leave empty to list documents of the whole scope"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-0 flex-1 basis-32 flex-col gap-1 text-sm">
              <Label htmlFor="work-list-type">Type</Label>
              <NativeSelect
                id="work-list-type"
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
              </NativeSelect>
            </div>
            <div className="flex min-w-0 flex-1 basis-32 flex-col gap-1 text-sm">
              <Label htmlFor="work-list-status">Status</Label>
              <NativeSelect
                id="work-list-status"
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
              </NativeSelect>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </form>

        {error !== null && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
          >
            <p className="m-0">{error}</p>
          </div>
        )}
        <p aria-live="polite" className="m-0 min-h-5 text-sm text-muted-foreground">
          {notice?.kind === 'ok' ? notice.text : loading ? 'Loading…' : ''}
        </p>

        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {documents.map((doc) => (
            <li key={doc.id} className="list-none">
              <WorkDocCard doc={doc} />
            </li>
          ))}
        </ul>
        {documents.length === 0 && (
          <p className="m-0 text-sm text-muted-foreground">
            {loading ? 'Loading documents…' : loadedOnce ? 'No documents match these filters.' : ''}
          </p>
        )}
      </Card>
    </WorkspaceShell>
  );
}

function WorkDocCard({ doc }: { doc: WorkDoc }): React.ReactElement {
  return (
    <Card className="gap-2.5 bg-muted/50 px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge variant="secondary" data-kind={doc.type}>
          {doc.type}
        </Badge>
        <StatusBadge status={doc.status}>
          {doc.status}
        </StatusBadge>
        <Badge variant="outline">v{doc.version}</Badge>
      </div>
      <p className="m-0 font-semibold break-words">{doc.title}</p>
      <p className="m-0 text-xs break-all text-muted-foreground">
        chat {doc.chatId} · updated {formatWorkDocTime(doc.updatedAt)} · created{' '}
        {formatWorkDocTime(doc.createdAt)}
      </p>
      <div className="flex flex-wrap gap-2">
        {CHAT_ID_PATTERN.test(doc.chatId) ? (
          <a
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            href={workDocPagePath(doc.id, doc.chatId)}
          >
            Open document
          </a>
        ) : (
          <span className="text-sm text-muted-foreground">Open this document from its own chat.</span>
        )}
      </div>
    </Card>
  );
}
