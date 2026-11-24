'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
 * typed links (Phase 4). Metadata (title/status) edits go through the PATCH
 * route with the required CAS `expectedVersion`; rollbacks go through the
 * rollback route with BOTH `expectedVersion` and `toVersion` — a 409 always
 * resolves to a fixed, actionable message, never internals. Content edits go
 * through the REAL agent versions route with `expectedVersion` and
 * `source: 'user'` (a new immutable version; history is never rewritten).
 */
export function WorkDocDetailView({ apiBaseUrl, workDocId, chatId }: WorkDocDetailProps): React.ReactElement {
  if (!CHAT_ID_PATTERN.test(chatId)) {
    return (
      <main className="chat-layout">
        <header className="chat-header">
          <h1>Work document</h1>
          <nav className="chat-nav" aria-label="Workforce pages">
            <a className="chat-new" href={workListPagePath()}>
              All documents
            </a>
            <a className="chat-new" href="/schedules">
              Schedules
            </a>
          </nav>
        </header>
        <div role="alert" className="chat-banner chat-banner-warning">
          <p>
            This page needs its owning chat as <code>?chatId=…</code> — open the document from a
            chat's Work link or a list entry on <code>/work</code>.
          </p>
        </div>
      </main>
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
    <main className="chat-layout">
      <header className="chat-header">
        <h1>Work document</h1>
        <nav className="chat-nav" aria-label="Workforce pages">
          {CHAT_ID_PATTERN.test(chatId) && (
            <a className="chat-new" href={`/chat/${encodeURIComponent(chatId)}`}>
              Back to chat
            </a>
          )}
          <a className="chat-new" href={workListPagePath(chatId)}>
            Documents
          </a>
          <a className="chat-new" href="/schedules">
            Schedules
          </a>
        </nav>
      </header>

      {loadError !== null && loadedOnce && (
        <div role="alert" className="chat-banner chat-banner-error">
          <p>{loadError}</p>
          <button type="button" onClick={() => void loadAll()}>
            Refresh
          </button>
        </div>
      )}

      {document !== null && (
        <>
          <section className="memory-section" aria-labelledby="work-doc-heading">
            <h2 id="work-doc-heading">{document.title}</h2>
            <WorkDocMeta doc={document} />
            <pre className="work-doc-content">
              {truncateWorkDocContent(document.content, WORK_DOC_DISPLAY_LIMIT)}
              {document.content.length > WORK_DOC_DISPLAY_LIMIT &&
                `\n\n(displaying the first ${WORK_DOC_DISPLAY_LIMIT} characters of ${document.content.length})`}
            </pre>
            <LinksView links={links} chatId={chatId} />
          </section>

          <section className="memory-section" aria-labelledby="work-doc-edit-heading">
            <h2 id="work-doc-edit-heading">Edit metadata</h2>
            <p className="memory-muted">
              Changes title or status with a version check (expected v{document.version}). Content
              edits live in the section below — through the versioned route with{' '}
              <code>source: 'user'</code>; there is no separate user-content endpoint.
            </p>
            <form
              className="memory-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveMetadata();
              }}
            >
              <div className="memory-field">
                <label htmlFor="work-doc-title">Title</label>
                <input
                  id="work-doc-title"
                  className="memory-input"
                  aria-label="Work document title"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  required
                  maxLength={WORK_DOC_TITLE_MAX}
                />
              </div>
              <div className="memory-field">
                <label htmlFor="work-doc-status">Status</label>
                <select
                  id="work-doc-status"
                  className="memory-input"
                  aria-label="Work document status"
                  value={statusDraft}
                  onChange={(event) => setStatusDraft(event.target.value)}
                >
                  {WORK_DOC_STATUSES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <div className="memory-actions">
                <button type="submit" className="memory-button-primary" disabled={saving}>
                  {saving ? 'Saving…' : 'Save metadata'}
                </button>
              </div>
              {saveNotice !== null && (
                <NoticeView notice={saveNotice} />
              )}
            </form>
          </section>

          <section className="memory-section" aria-labelledby="work-doc-content-heading">
            <h2 id="work-doc-content-heading">Edit content (new version)</h2>
            <p className="memory-muted">
              Saving replaces the content through the versioned route with{' '}
              <code>expectedVersion</code> = v{document.version} — a new immutable snapshot and
              revision are recorded and the version number increases. If the document changed on
              the server meanwhile, the version check rejects the save with a fixed conflict
              message; refresh and retry.
            </p>
            <form
              className="memory-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveContent();
              }}
            >
              <div className="memory-field">
                <label htmlFor="work-doc-content">Content</label>
                <textarea
                  id="work-doc-content"
                  className="memory-input"
                  aria-label="Work document content"
                  value={contentDraft}
                  onChange={(event) => setContentDraft(event.target.value)}
                  required
                  rows={8}
                  maxLength={WORK_DOC_CONTENT_MAX}
                />
                <span className="memory-hint">
                  {contentDraft.trim().length}/{WORK_DOC_CONTENT_MAX} characters — saved trimmed, 1 minimum.
                </span>
              </div>
              <div className="memory-field">
                <label htmlFor="work-doc-content-summary">Revision summary (optional)</label>
                <input
                  id="work-doc-content-summary"
                  className="memory-input"
                  aria-label="Revision summary"
                  value={contentSummary}
                  onChange={(event) => setContentSummary(event.target.value)}
                  maxLength={500}
                  placeholder="Recorded in the audit trail"
                />
              </div>
              <div className="memory-actions">
                <button type="submit" className="memory-button-primary" disabled={savingContent}>
                  {savingContent ? 'Saving version…' : 'Save as new version'}
                </button>
              </div>
              {contentNotice !== null && <NoticeView notice={contentNotice} />}
            </form>
          </section>

          <section className="memory-section" aria-labelledby="work-doc-rollback-heading">
            <h2 id="work-doc-rollback-heading">Roll back to a version</h2>
            <p className="memory-muted">
              Rollback copies a historical version into a NEW current version. Current version is{' '}
              v{document.version}; the request sends it as <code>expectedVersion</code>. History is
              never deleted or rewritten.
            </p>
            <form
              className="memory-form"
              onSubmit={(event) => {
                event.preventDefault();
                void applyRollback();
              }}
            >
              <div className="memory-field">
                <label htmlFor="work-doc-rollback-version">Version to roll back to</label>
                <select
                  id="work-doc-rollback-version"
                  className="memory-input"
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
                </select>
              </div>
              <div className="memory-field">
                <label htmlFor="work-doc-rollback-summary">Summary (optional)</label>
                <input
                  id="work-doc-rollback-summary"
                  className="memory-input"
                  aria-label="Rollback summary"
                  value={rollbackSummary}
                  onChange={(event) => setRollbackSummary(event.target.value)}
                  maxLength={WORK_DOC_SUMMARY_MAX}
                  placeholder="Recorded in the audit trail"
                />
              </div>
              <div className="memory-field memory-check">
                <input
                  id="work-doc-rollback-confirm"
                  type="checkbox"
                  aria-label="Confirm rollback creates a new version and leaves history untouched"
                  checked={rollbackConfirm}
                  onChange={(event) => setRollbackConfirm(event.target.checked)}
                />
                <label htmlFor="work-doc-rollback-confirm">
                  I understand this creates a new version (v{document.version + 1}) with the old
                  content
                </label>
              </div>
              <div className="memory-actions">
                <button
                  type="submit"
                  className="memory-button-primary"
                  disabled={rollingBack || !rollbackConfirm || rollbackVersion === ''}
                >
                  {rollingBack ? 'Rolling back…' : 'Roll back'}
                </button>
              </div>
              {rollbackNotice !== null && (
                <NoticeView notice={rollbackNotice} />
              )}
            </form>
          </section>

          <section className="memory-section" aria-labelledby="work-doc-history-heading">
            <h2 id="work-doc-history-heading">Version history</h2>
            <ul className="work-history-list">
              {versions.map((version) => (
                <li key={version.id} className="work-history-item">
                  <p className="memory-meta">{workDocVersionLine(version)}</p>
                  <pre className="work-doc-content work-doc-content-small">
                    {truncateWorkDocContent(version.content, 500)}
                  </pre>
                </li>
              ))}
            </ul>

            <h3>Revision audit trail</h3>
            <ul className="work-history-list">
              {revisions.map((revision) => (
                <li key={revision.id} className="work-history-item">
                  <div className="memory-card-head">
                    <span className="memory-badge">{revision.source}</span>
                    <span className="memory-meta">
                      {revision.fromVersion === null ? 'created' : `v${revision.fromVersion} →`} v
                      {revision.toVersion} · {revision.actorId !== null ? revision.actorId : 'actor unknown'} ·{' '}
                      {formatWorkDocTime(revision.createdAt, '(unknown)')}
                    </span>
                  </div>
                  <p className="memory-meta">{revision.summary}</p>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {!loadedOnce && loading && (
        <p aria-live="polite" className="memory-status">
          Loading document…
        </p>
      )}
    </main>
  );
}

function buildSaveError(error: string, conflict: boolean): string {
  return conflict ? `${error} ${WORK_DOC_CONFLICT_HINT}` : error;
}

function NoticeView({ notice }: { notice: Notice }): React.ReactElement {
  return (
    <p
      role={notice.kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={`memory-notice memory-notice-${notice.kind}`}
    >
      {notice.text}
    </p>
  );
}

function WorkDocMeta({ doc }: { doc: WorkDoc }): React.ReactElement {
  return (
    <div className="memory-card-head">
      <span className="memory-badge" data-kind={doc.type}>
        {doc.type}
      </span>
      <span className="memory-badge" data-status={doc.status}>
        {doc.status}
      </span>
      <span className="memory-badge">v{doc.version}</span>
      <span className="memory-meta">
        scope {doc.scope} · chat {doc.chatId} · created {formatTime(doc.createdAt)} · updated{' '}
        {formatTime(doc.updatedAt)} · id <span className="memory-mono">{doc.id}</span>
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
    <div className="work-links">
      <h3>Linked records</h3>
      <ul className="work-history-list">
        {links.map((link) => {
          const target = workDocLinkHref(link, chatId);
          return (
            <li key={link.id} className="work-history-item">
              <div className="memory-card-head">
                <span className="memory-badge">{link.targetType}</span>
                {target !== null ? (
                  <a className="work-link" href={target.href}>
                    {target.text}
                  </a>
                ) : (
                  <span className="memory-meta">
                    <span className="memory-mono">{link.targetId}</span>
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
