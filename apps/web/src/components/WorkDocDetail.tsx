'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceGate } from '@/components/WorkspaceShell';
import { StatusBadge } from '@/components/StatusBadge';
import { MarkdownText } from '@/components/MarkdownText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import {
  buildWorkDocPatchBody,
  buildWorkDocVersionBody,
  fetchWorkDocDetail,
  fetchWorkDocRevisions,
  fetchWorkDocVersions,
  formatWorkDocTime,
  postWorkDocVersion,
  rollbackWorkDoc,
  truncateWorkDocContent,
  updateWorkDocMetadata,
  WORK_DOC_CONFLICT_HINT,
  WORK_DOC_CONTENT_MAX,
  WORK_DOC_DISPLAY_LIMIT,
  WORK_DOC_TITLE_MAX,
  WORK_DOC_SUMMARY_MAX,
  WORK_DOC_STATUSES,
  workDocLinkHref,
  workDocVersionLine,
  workListPagePath,
  type WorkDoc,
  type WorkDocLink,
  type WorkDocRevision,
  type WorkDocVersion,
} from '@/lib/workdocs';

export interface WorkDocDetailProps {
  apiBaseUrl: string;
  workDocId: string;
  /** Owning chat id: required by every doc-scoped API call. */
  chatId: string;
}

interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `/work/:id?chatId=…` — one Work Doc with content, versions, revisions and
 * typed links (Phase 4) on the shared Tailwind + shadcn shell. Metadata
 * (title/status) edits go through the PATCH route with the required CAS
 * `expectedVersion`; rollbacks go through the rollback route with BOTH
 * `expectedVersion` and `toVersion` — a 409 always resolves to a fixed,
 * actionable message, never internals. Content edits go through the REAL
 * agent versions route with `expectedVersion` and `source: 'user'` (a new
 * immutable version; history is never rewritten).
 */
export function WorkDocDetailView({ apiBaseUrl, workDocId, chatId }: WorkDocDetailProps): React.ReactElement {
  if (!CHAT_ID_PATTERN.test(chatId)) {
    return (
      <WorkspaceGate
        active="work"
        eyebrow="Workspace output"
        title="Work document"
        description="One document with its content, versions, revisions and links."
      >
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          <p className="m-0">
            This page needs its owning chat as <code>?chatId=…</code> — open the document from a
            chat's Work link or a list entry on <code>/work</code>.
          </p>
        </div>
      </WorkspaceGate>
    );
  }
  return <WorkDocDetailLoaded apiBaseUrl={apiBaseUrl} workDocId={workDocId} chatId={chatId} />;
}

function WorkDocDetailLoaded({
  apiBaseUrl,
  workDocId,
  chatId,
}: {
  apiBaseUrl: string;
  workDocId: string;
  chatId: string;
}): React.ReactElement {
  const [document, setDocument] = useState<WorkDoc | null>(null);
  const [links, setLinks] = useState<ReadonlyArray<WorkDocLink>>([]);
  const [versions, setVersions] = useState<ReadonlyArray<WorkDocVersion>>([]);
  const [revisions, setRevisions] = useState<ReadonlyArray<WorkDocRevision>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loading, setLoading] = useState(false);

  // Metadata edit form state.
  const [titleDraft, setTitleDraft] = useState('');
  const [statusDraft, setStatusDraft] = useState('');
  const [saveNotice, setSaveNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);

  // Versioned content edit state (real versions route, CAS expectedVersion).
  const [contentDraft, setContentDraft] = useState('');
  const [contentSummary, setContentSummary] = useState('');
  const [contentNotice, setContentNotice] = useState<Notice | null>(null);
  const [savingContent, setSavingContent] = useState(false);

  // Rollback form state: version selection + optional summary + confirm.
  const [rollbackVersion, setRollbackVersion] = useState('');
  const [rollbackSummary, setRollbackSummary] = useState('');
  const [rollbackConfirm, setRollbackConfirm] = useState(false);
  const [rollbackNotice, setRollbackNotice] = useState<Notice | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const requestSeq = useRef(0);

  const loadAll = useCallback(
    async (): Promise<void> => {
      const seq = ++requestSeq.current;
      setLoading(true);
      const [detail, versionsResult, revisionsResult] = await Promise.all([
        fetchWorkDocDetail({ apiBaseUrl, workDocId, chatId }),
        fetchWorkDocVersions({ apiBaseUrl, workDocId, chatId, limit: 100 }),
        fetchWorkDocRevisions({ apiBaseUrl, workDocId, chatId, limit: 100 }),
      ]);
      if (seq !== requestSeq.current) return;
      setLoading(false);
      if (!detail.ok) {
        setLoadError(detail.error);
        setLoadedOnce(true);
        return;
      }
      setLoadError(null);
      setLoadedOnce(true);
      setDocument(detail.detail.document);
      setLinks(detail.detail.links);
      setVersions(versionsResult.ok ? versionsResult.versions : []);
      setRevisions(revisionsResult.ok ? revisionsResult.revisions : []);
      if (!versionsResult.ok || !revisionsResult.ok) {
        setSaveNotice({
          kind: 'error',
          text: 'Document loaded, but its history is temporarily unavailable. Refresh to retry.',
        });
      }
    },
    [apiBaseUrl, workDocId, chatId],
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Keep the edit forms aligned with the loaded document (fresh CAS version).
  useEffect(() => {
    if (document !== null) {
      setTitleDraft(document.title);
      setStatusDraft(document.status);
      setContentDraft(document.content);
    }
  }, [document]);

  const saveMetadata = async (): Promise<void> => {
    if (document === null || saving) return;
    setSaving(true);
    setSaveNotice(null);
    const body = buildWorkDocPatchBody({
      chatId,
      expectedVersion: document.version,
      title: titleDraft,
      status: statusDraft,
    });
    if (!body.ok) {
      setSaving(false);
      setSaveNotice({ kind: 'error', text: body.error });
      return;
    }
    const result = await updateWorkDocMetadata({
      apiBaseUrl,
      workDocId,
      body: body.body,
    });
    setSaving(false);
    if (!result.ok) {
      setSaveNotice({
        kind: 'error',
        text: buildSaveError(result.error, result.error.includes('version conflict')),
      });
      return;
    }
    setSaveNotice({
      kind: 'ok',
      text: `Saved as v${result.document.version} (${result.document.status}). History gained a new revision.`,
    });
    await loadAll();
  };

  const saveContent = async (): Promise<void> => {
    if (document === null || savingContent) return;
    setSavingContent(true);
    setContentNotice(null);
    const body = buildWorkDocVersionBody({
      chatId,
      expectedVersion: document.version,
      content: contentDraft,
      summary: contentSummary,
    });
    if (!body.ok) {
      setSavingContent(false);
      setContentNotice({ kind: 'error', text: body.error });
      return;
    }
    const result = await postWorkDocVersion({
      apiBaseUrl,
      workDocId,
      body: body.body,
    });
    setSavingContent(false);
    if (!result.ok) {
      setContentNotice({
        kind: 'error',
        text: buildSaveError(result.error, result.error.includes('version conflict')),
      });
      return;
    }
    setContentNotice({
      kind: 'ok',
      text: `Content saved — the document is now v${result.document.version} with an immutable snapshot of the replaced content.`,
    });
    setContentSummary('');
    await loadAll();
  };

  const applyRollback = async (): Promise<void> => {
    if (document === null || rollingBack || !rollbackConfirm) return;
    const toVersion = Number.parseInt(rollbackVersion, 10);
    if (!Number.isInteger(toVersion) || toVersion < 1) {
      setRollbackNotice({ kind: 'error', text: 'Choose a version to roll back to.' });
      return;
    }
    setRollingBack(true);
    setRollbackNotice(null);
    const result = await rollbackWorkDoc({
      apiBaseUrl,
      workDocId,
      body: {
        chatId,
        expectedVersion: document.version,
        toVersion,
        ...(rollbackSummary.trim().length > 0 ? { summary: rollbackSummary.trim() } : {}),
        source: 'user',
      },
    });
    setRollingBack(false);
    if (!result.ok) {
      setRollbackNotice({
        kind: 'error',
        text: buildSaveError(result.error, result.error.includes('version conflict')),
      });
      return;
    }
    setRollbackNotice({
      kind: 'ok',
      text: `Rolled back — the document is now v${result.document.version} with the content of v${toVersion}. History was never rewritten.`,
    });
    setRollbackVersion('');
    setRollbackSummary('');
    setRollbackConfirm(false);
    await loadAll();
  };

  return (
    <WorkspaceGate
      active="work"
      eyebrow="Workspace output"
      title={document !== null ? document.title : 'Work document'}
      description="Content edits create new immutable versions; a rollback copies an older version into a new current one. History is never rewritten."
      context={
        <>
          {CHAT_ID_PATTERN.test(chatId) && (
            <a
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              href={`/chat/${encodeURIComponent(chatId)}`}
            >
              Back to chat
            </a>
          )}
          <a
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            href={workListPagePath(chatId)}
          >
            All documents
          </a>
        </>
      }
    >
      {loadError !== null && loadedOnce && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
        >
          <p className="m-0">{loadError}</p>
          <Button type="button" variant="outline" size="sm" className="shrink-0 border-red-300 bg-transparent text-red-900 dark:hover:bg-red-950/60 dark:hover:text-red-200" onClick={() => void loadAll()}>
            Refresh
          </Button>
        </div>
      )}

      {document !== null && (
        <>
          <Card aria-labelledby="work-doc-heading" className="gap-3 px-4 py-4 sm:px-5 sm:py-5">
            <h2 id="work-doc-heading" className="m-0 text-base font-semibold tracking-tight">
              {document.title}
            </h2>
            <WorkDocMeta doc={document} />
            <div className="max-h-96 overflow-y-auto overscroll-contain">
              <MarkdownText text={truncateWorkDocContent(document.content, WORK_DOC_DISPLAY_LIMIT)} />
            </div>
            {document.content.length > WORK_DOC_DISPLAY_LIMIT && (
              <p className="m-0 text-xs text-muted-foreground">
                (displaying the first {WORK_DOC_DISPLAY_LIMIT} characters of {document.content.length})
              </p>
            )}
            <LinksView links={links} chatId={chatId} />
          </Card>

          <Card aria-labelledby="work-doc-edit-heading" className="gap-3 px-4 py-4 sm:px-5 sm:py-5">
            <h2 id="work-doc-edit-heading" className="m-0 text-base font-semibold tracking-tight">
              Edit metadata
            </h2>
            <p className="m-0 text-sm text-muted-foreground">
              Changes title or status with a version check (expected v{document.version}). Content
              edits live in the section below — through the versioned route with{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">source: 'user'</code>; there is no separate user-content endpoint.
            </p>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void saveMetadata();
              }}
            >
              <div className="flex min-w-0 flex-1 basis-full flex-col gap-1 text-sm">
                <Label htmlFor="work-doc-title">Title</Label>
                <Input
                  id="work-doc-title"
                  aria-label="Work document title"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  required
                  maxLength={WORK_DOC_TITLE_MAX}
                />
              </div>
              <div className="flex min-w-0 flex-1 basis-full flex-col gap-1 text-sm">
                <Label htmlFor="work-doc-status">Status</Label>
                <NativeSelect
                  id="work-doc-status"
                  aria-label="Work document status"
                  value={statusDraft}
                  onChange={(event) => setStatusDraft(event.target.value)}
                >
                  {WORK_DOC_STATUSES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save metadata'}
                </Button>
              </div>
              {saveNotice !== null && (
                <NoticeTextLive kind={saveNotice.kind} text={saveNotice.text} />
              )}
            </form>
          </Card>

          <Card aria-labelledby="work-doc-content-heading" className="gap-3 px-4 py-4 sm:px-5 sm:py-5">
            <h2 id="work-doc-content-heading" className="m-0 text-base font-semibold tracking-tight">
              Edit content (new version)
            </h2>
            <p className="m-0 text-sm text-muted-foreground">
              Saving replaces the content through the versioned route with{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">expectedVersion</code> = v{document.version} — a new immutable snapshot and
              revision are recorded and the version number increases. If the document changed on
              the server meanwhile, the version check rejects the save with a fixed conflict
              message; refresh and retry.
            </p>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void saveContent();
              }}
            >
              <div className="flex min-w-0 flex-1 basis-full flex-col gap-1 text-sm">
                <Label htmlFor="work-doc-content">Content</Label>
                <Textarea
                  id="work-doc-content"
                  aria-label="Work document content"
                  value={contentDraft}
                  onChange={(event) => setContentDraft(event.target.value)}
                  required
                  rows={8}
                  maxLength={WORK_DOC_CONTENT_MAX}
                />
                <span className="text-xs text-muted-foreground">
                  {contentDraft.trim().length}/{WORK_DOC_CONTENT_MAX} characters — saved trimmed, 1 minimum.
                </span>
              </div>
              <div className="flex min-w-0 flex-1 basis-full flex-col gap-1 text-sm">
                <Label htmlFor="work-doc-content-summary">Revision summary (optional)</Label>
                <Input
                  id="work-doc-content-summary"
                  aria-label="Revision summary"
                  value={contentSummary}
                  onChange={(event) => setContentSummary(event.target.value)}
                  maxLength={500}
                  placeholder="Recorded in the audit trail"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={savingContent}>
                  {savingContent ? 'Saving version…' : 'Save as new version'}
                </Button>
              </div>
              {contentNotice !== null && <NoticeTextLive kind={contentNotice.kind} text={contentNotice.text} />}
            </form>
          </Card>

          <Card aria-labelledby="work-doc-rollback-heading" className="gap-3 px-4 py-4 sm:px-5 sm:py-5">
            <h2 id="work-doc-rollback-heading" className="m-0 text-base font-semibold tracking-tight">
              Roll back to a version
            </h2>
            <p className="m-0 text-sm text-muted-foreground">
              Rollback copies a historical version into a NEW current version. Current version is{' '}
              v{document.version}; the request sends it as <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">expectedVersion</code>. History is
              never deleted or rewritten.
            </p>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void applyRollback();
              }}
            >
              <div className="flex min-w-0 flex-1 basis-full flex-col gap-1 text-sm">
                <Label htmlFor="work-doc-rollback-version">Version to roll back to</Label>
                <NativeSelect
                  id="work-doc-rollback-version"
                  aria-label="Version to roll back to"
                  value={rollbackVersion}
                  onChange={(event) => setRollbackVersion(event.target.value)}
                  required
                >
                  <option value="">Choose a version…</option>
                  {versions.map((version) => (
                    <option key={version.id} value={version.version}>
                      {workDocVersionLine(version)} — {version.title}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex min-w-0 flex-1 basis-full flex-col gap-1 text-sm">
                <Label htmlFor="work-doc-rollback-summary">Summary (optional)</Label>
                <Input
                  id="work-doc-rollback-summary"
                  aria-label="Rollback summary"
                  value={rollbackSummary}
                  onChange={(event) => setRollbackSummary(event.target.value)}
                  maxLength={WORK_DOC_SUMMARY_MAX}
                  placeholder="Recorded in the audit trail"
                />
              </div>
              <div className="flex flex-none items-center gap-2 text-sm">
                <input
                  id="work-doc-rollback-confirm"
                  type="checkbox"
                  aria-label="Confirm rollback creates a new version and leaves history untouched"
                  className="size-4 accent-primary"
                  checked={rollbackConfirm}
                  onChange={(event) => setRollbackConfirm(event.target.checked)}
                />
                <Label htmlFor="work-doc-rollback-confirm" className="font-normal">
                  I understand this creates a new version (v{document.version + 1}) with the old
                  content
                </Label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  variant="outline"
                  disabled={rollingBack || !rollbackConfirm || rollbackVersion === ''}
                >
                  {rollingBack ? 'Rolling back…' : 'Roll back'}
                </Button>
              </div>
              {rollbackNotice !== null && (
                <NoticeTextLive kind={rollbackNotice.kind} text={rollbackNotice.text} />
              )}
            </form>
          </Card>

          <Card aria-labelledby="work-doc-history-heading" className="gap-3 px-4 py-4 sm:px-5 sm:py-5">
            <h2 id="work-doc-history-heading" className="m-0 text-base font-semibold tracking-tight">
              Version history
            </h2>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {versions.map((version) => (
                <li key={version.id} className="rounded-md border bg-muted/50 px-2.5 py-2">
                  <p className="m-0 text-xs break-all text-muted-foreground">{workDocVersionLine(version)}</p>
                  <pre className="work-doc-content work-doc-content-small">
                    {truncateWorkDocContent(version.content, 500)}
                  </pre>
                </li>
              ))}
            </ul>

            <h3 className="m-0 text-[0.95rem] font-semibold">Revision audit trail</h3>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {revisions.map((revision) => (
                <li key={revision.id} className="rounded-md border bg-muted/50 px-2.5 py-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Badge variant="outline">{revision.source}</Badge>
                    <span className="text-xs break-all text-muted-foreground">
                      {revision.fromVersion === null ? 'created' : `v${revision.fromVersion} →`} v
                      {revision.toVersion} · {revision.actorId !== null ? revision.actorId : 'actor unknown'} ·{' '}
                      {formatWorkDocTime(revision.createdAt, '(unknown)')}
                    </span>
                  </div>
                  <p className="m-0 text-xs break-all text-muted-foreground">{revision.summary}</p>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      {!loadedOnce && loading && (
        <p aria-live="polite" className="m-0 min-h-5 text-sm text-muted-foreground">
          Loading document…
        </p>
      )}
    </WorkspaceGate>
  );
}

function buildSaveError(error: string, conflict: boolean): string {
  return conflict ? `${error} ${WORK_DOC_CONFLICT_HINT}` : error;
}

function NoticeTextLive({ kind, text }: { kind: 'ok' | 'error'; text: string }): React.ReactElement {
  return (
    <p
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={
        kind === 'ok'
          ? 'm-0 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[0.85rem] text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200'
          : 'm-0 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[0.85rem] text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200'
      }
    >
      {text}
    </p>
  );
}

function WorkDocMeta({ doc }: { doc: WorkDoc }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <Badge variant="secondary" data-kind={doc.type}>
        {doc.type}
      </Badge>
      <StatusBadge status={doc.status}>
        {doc.status}
      </StatusBadge>
      <Badge variant="outline">v{doc.version}</Badge>
      <span className="text-xs break-all text-muted-foreground">
        scope {doc.scope} · chat {doc.chatId} · created {formatTime(doc.createdAt)} · updated{' '}
        {formatTime(doc.updatedAt)} · id <span className="font-mono">{doc.id}</span>
      </span>
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '(unknown)';
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function LinksView({ links, chatId }: { links: ReadonlyArray<WorkDocLink>; chatId: string }): React.ReactElement {
  if (links.length === 0) return <></>;
  return (
    <div className="border-t pt-3">
      <h3 className="mb-2 text-[0.95rem] font-semibold">Linked records</h3>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {links.map((link) => {
          const target = workDocLinkHref(link, chatId);
          return (
            <li key={link.id} className="rounded-md border bg-muted/50 px-2.5 py-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <Badge variant="outline">{link.targetType}</Badge>
                {target !== null ? (
                  <a
                    className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                    href={target.href}
                  >
                    {target.text}
                  </a>
                ) : (
                  <span className="text-xs break-all text-muted-foreground">
                    <span className="font-mono">{link.targetId}</span>
                    {link.label !== null && ` — ${link.label}`}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
