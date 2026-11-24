/**
 * Pure, testable client helpers for the Phase 4 Work Docs UI.
 *
 * Contract source of truth: `apps/api/src/agents/work-doc-routes.ts` (the SAME
 * routes the `write_doc` tool uses) + `packages/core/src/work-docs/`.
 *
 * - GET    /api/agents/orchestrator/work-docs                    list (?scope=&chatId=&type=&status=&limit=)
 * - GET    /api/agents/orchestrator/work-docs/:id?chatId=…       one doc (+recentVersions+links)
 * - PATCH  /api/agents/orchestrator/work-docs/:id                `{chatId, expectedVersion, title?, status?}`
 * - GET    /api/agents/orchestrator/work-docs/:id/versions?chatId=…
 * - POST   /api/agents/orchestrator/work-docs/:id/rollback       `{chatId, expectedVersion, toVersion, summary?, source?}`
 * - GET    /api/agents/orchestrator/work-docs/:id/revisions?chatId=…
 * - GET    /api/agents/orchestrator/work-docs/:id/links?chatId=…
 *
 * OWNERSHIP: every doc-scoped call must carry the owning `chatId` (query for
 * GETs, body for mutations) — a mismatch is a fixed 404 with no existence
 * leak, so the UI never links a detail view without the chat it came from.
 * Content edits from the UI go through the POST versions route (the REAL
 * versioned path, `source: 'user'` from the builder); users also change
 * metadata (PATCH) or roll back (rollback route).
 *
 * Errors are always fixed safe strings — the API's `{ error }` message is
 * surfaced verbatim, everything else collapses to fixed fallbacks. Fixed API
 * texts pinned by the routes:
 *   400 'Invalid work document request.'  404 'Work document not found.'
 *   409 'Work document version conflict.' 503 'Work document service is temporarily unavailable.'
 */
import {
  MEMORY_TEXT_LIMIT,
  extractApiErrorMessage,
  formatDateTime,
  UUID_PATTERN,
  truncateMemoryText,
} from './memory';
import { isSafeChatId, browserApiFetch, requestAuthError } from './api';

/** The UI always talks to the doc-owning agent's route namespace. */
export const WORK_DOC_SLUG = 'orchestrator';

export const WORK_DOC_TYPES = ['report', 'plan', 'analysis'] as const;
export type WorkDocType = (typeof WORK_DOC_TYPES)[number];
export const WORK_DOC_STATUSES = ['draft', 'active', 'archived'] as const;
export type WorkDocStatus = (typeof WORK_DOC_STATUSES)[number];
export const WORK_DOC_LINK_TARGET_TYPES = ['memory_block', 'chat', 'delegation'] as const;
export type WorkDocLinkTargetType = (typeof WORK_DOC_LINK_TARGET_TYPES)[number];

export const WORK_DOC_TITLE_MAX = 200;
export const WORK_DOC_CONTENT_MAX = 100000;
export const WORK_DOC_SUMMARY_MAX = 500;
export const WORK_DOC_LIST_LIMIT_MIN = 1;
export const WORK_DOC_LIST_LIMIT_MAX = 100;

export function isWorkDocType(value: unknown): value is WorkDocType {
  return typeof value === 'string' && (WORK_DOC_TYPES as readonly string[]).includes(value);
}

export function isWorkDocStatus(value: unknown): value is WorkDocStatus {
  return typeof value === 'string' && (WORK_DOC_STATUSES as readonly string[]).includes(value);
}

export function isWorkDocLinkTargetType(value: unknown): value is WorkDocLinkTargetType {
  return typeof value === 'string' && (WORK_DOC_LINK_TARGET_TYPES as readonly string[]).includes(value);
}

/** Document (and version/revision/link row) ids are UUIDs. */
export function isWorkDocId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/* ------------------------------------------------------------------ */
/* Endpoints + page URLs                                                */
/* ------------------------------------------------------------------ */

export function workDocsListEndpoint(apiBaseUrl: string, query?: string): string {
  return `${apiBaseUrl}/api/agents/${WORK_DOC_SLUG}/work-docs${query ?? ''}`;
}

export function workDocDetailEndpoint(apiBaseUrl: string, workDocId: string, chatId: string): string {
  return `${workDocBase(apiBaseUrl, workDocId)}?chatId=${encodeURIComponent(chatId)}`;
}

export function workDocVersionsEndpoint(apiBaseUrl: string, workDocId: string, chatId: string, limit?: number): string {
  return `${workDocBase(apiBaseUrl, workDocId)}/versions?chatId=${encodeURIComponent(chatId)}${limit !== undefined ? `&limit=${limit}` : ''}`;
}

export function workDocRevisionsEndpoint(apiBaseUrl: string, workDocId: string, chatId: string, limit?: number): string {
  return `${workDocBase(apiBaseUrl, workDocId)}/revisions?chatId=${encodeURIComponent(chatId)}${limit !== undefined ? `&limit=${limit}` : ''}`;
}

export function workDocLinksEndpoint(apiBaseUrl: string, workDocId: string, chatId: string): string {
  return `${workDocBase(apiBaseUrl, workDocId)}/links?chatId=${encodeURIComponent(chatId)}`;
}

function workDocBase(apiBaseUrl: string, workDocId: string): string {
  return `${apiBaseUrl}/api/agents/${WORK_DOC_SLUG}/work-docs/${encodeURIComponent(workDocId)}`;
}

/** `/work/<id>?chatId=…` — the detail page's own owning-chat context. */
export function workDocPagePath(workDocId: string, chatId: string): string {
  return `/work/${encodeURIComponent(workDocId)}?chatId=${encodeURIComponent(chatId)}`;
}

/** `/work` or `/work?chatId=…` — the list page filter. */
export function workListPagePath(chatId?: string): string {
  return chatId !== undefined && chatId !== '' ? `/work?chatId=${encodeURIComponent(chatId)}` : '/work';
}

/* ------------------------------------------------------------------ */
/* Query/body builders                                                  */
/* ------------------------------------------------------------------ */

export interface WorkDocListFilters {
  scope?: string;
  chatId?: string;
  type?: string;
  status?: string;
  limit?: number;
}

/** Encoded query for the list route; empty filters omitted, limit bounded. */
export function buildWorkDocListQuery(filters: WorkDocListFilters): string {
  const params = new URLSearchParams();
  const text = (value: string | undefined, key: string): void => {
    const trimmed = value?.trim();
    if (trimmed) params.set(key, trimmed);
  };
  text(filters.scope, 'scope');
  if (isSafeChatId(filters.chatId ?? '')) params.set('chatId', (filters.chatId ?? '').trim());
  if (isWorkDocType(filters.type)) params.set('type', filters.type);
  if (isWorkDocStatus(filters.status)) params.set('status', filters.status);
  if (
    typeof filters.limit === 'number' &&
    Number.isInteger(filters.limit) &&
    filters.limit >= WORK_DOC_LIST_LIMIT_MIN &&
    filters.limit <= WORK_DOC_LIST_LIMIT_MAX
  ) {
    params.set('limit', String(filters.limit));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

export type WorkDocPatchBodyResult =
  | { ok: true; body: { chatId: string; expectedVersion: number; title?: string; status?: WorkDocStatus } }
  | { ok: false; error: string };

/** PATCH body: metadata only (title/status) + CAS `expectedVersion`. */
export function buildWorkDocPatchBody(input: {
  chatId: string;
  expectedVersion: number | string;
  title?: string;
  status?: string;
}): WorkDocPatchBodyResult {
  const chatId = isSafeChatId(input.chatId) ? input.chatId : '';
  if (!chatId) return { ok: false, error: 'A chat context is required to edit this document.' };
  const expectedVersion = normalizeVersion(input.expectedVersion);
  if (expectedVersion === null) {
    return { ok: false, error: 'Expected version must be a whole number of 1 or more.' };
  }
  const rawTitle = input.title?.trim() ?? '';
  if (rawTitle.length > WORK_DOC_TITLE_MAX) {
    return { ok: false, error: `Title must be at most ${WORK_DOC_TITLE_MAX} characters.` };
  }
  const title = rawTitle.length > 0 ? rawTitle : undefined;
  const status = isWorkDocStatus(input.status) ? input.status : undefined;
  if (title === undefined && status === undefined) {
    return { ok: false, error: 'Change the title or the status before saving.' };
  }
  return {
    ok: true,
    body: {
      chatId,
      expectedVersion,
      ...(title !== undefined ? { title } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  };
}

export type WorkDocRollbackBodyResult =
  | { ok: true; body: { chatId: string; expectedVersion: number; toVersion: number; summary?: string; source: 'user' } }
  | { ok: false; error: string };

/**
 * Create body per the real route: `{chatId, type, title, content}` (orchestrator
 * namespace). Starts the doc as draft v1 with an immutable snapshot.
 */
export type WorkDocCreateBodyResult =
  | { ok: true; body: { chatId: string; type: WorkDocType; title: string; content: string } }
  | { ok: false; error: string };

export function buildWorkDocCreateBody(input: {
  chatId: string;
  type: string;
  title: string;
  content: string;
}): WorkDocCreateBodyResult {
  const chatId = isSafeChatId(input.chatId) ? input.chatId : '';
  if (!chatId) return { ok: false, error: 'A chat context is required to create a document.' };
  if (!isWorkDocType(input.type)) return { ok: false, error: 'Choose a document type.' };
  const title = input.title.trim();
  if (title.length === 0) return { ok: false, error: 'Title is required.' };
  if (title.length > WORK_DOC_TITLE_MAX) {
    return { ok: false, error: `Title must be at most ${WORK_DOC_TITLE_MAX} characters.` };
  }
  const content = input.content.trim();
  if (content.length === 0) return { ok: false, error: 'Content is required.' };
  if (content.length > WORK_DOC_CONTENT_MAX) {
    return { ok: false, error: `Content must be at most ${WORK_DOC_CONTENT_MAX} characters.` };
  }
  return { ok: true, body: { chatId, type: input.type, title, content } };
}

/**
 * Versioned content update body for the REAL agent versions route
 * (POST `/api/agents/orchestrator/work-docs/:id/versions`). It carries the CAS
 * `expectedVersion` and at least one of content/title/status, plus
 * `source: 'user'` so the audit trail records UI-driven edits as user
 * revisions (the route accepts optional `source: 'agent' | 'user'`, default
 * agent; agent-originated write_doc stays server-side). There is no shadow
 * user-content endpoint — this IS the versioned path.
 */
export type WorkDocVersionBodyResult =
  | {
      ok: true;
      body: { chatId: string; expectedVersion: number; content?: string; title?: string; status?: WorkDocStatus; summary?: string; source: 'user' };
    }
  | { ok: false; error: string };

export function buildWorkDocVersionBody(input: {
  chatId: string;
  expectedVersion: number | string;
  content?: string;
  title?: string;
  status?: string;
  summary?: string;
}): WorkDocVersionBodyResult {
  const chatId = isSafeChatId(input.chatId) ? input.chatId : '';
  if (!chatId) return { ok: false, error: 'A chat context is required to save this document.' };
  const expectedVersion = normalizeVersion(input.expectedVersion);
  if (expectedVersion === null) {
    return { ok: false, error: 'Expected version must be a whole number of 1 or more.' };
  }
  const content = input.content?.trim() ?? '';
  if (content.length > WORK_DOC_CONTENT_MAX) {
    return { ok: false, error: `Content must be at most ${WORK_DOC_CONTENT_MAX} characters.` };
  }
  const rawTitle = input.title?.trim() ?? '';
  if (rawTitle.length > WORK_DOC_TITLE_MAX) {
    return { ok: false, error: `Title must be at most ${WORK_DOC_TITLE_MAX} characters.` };
  }
  const rawSummary = input.summary?.trim() ?? '';
  if (rawSummary.length > WORK_DOC_SUMMARY_MAX) {
    return { ok: false, error: `Summary must be at most ${WORK_DOC_SUMMARY_MAX} characters.` };
  }
  const body: { chatId: string; expectedVersion: number; content?: string; title?: string; status?: WorkDocStatus; summary?: string; source: 'user' } = {
    chatId,
    expectedVersion,
    source: 'user',
  };
  if (input.content !== undefined && content.length > 0) body.content = content;
  if (input.title !== undefined && rawTitle.length > 0) body.title = rawTitle;
  if (isWorkDocStatus(input.status)) body.status = input.status;
  if (rawSummary.length > 0) body.summary = rawSummary;
  if (body.content === undefined && body.title === undefined && body.status === undefined) {
    return { ok: false, error: 'Write some content before saving.' };
  }
  return { ok: true, body };
}

/**
 * Rollback body. BOTH `expectedVersion` (current CAS counter) and `toVersion`
 * (target historical version) are REQUIRED; the revision trail records the
 * user source. Rollback creates a NEW current version — history is immutable.
 */
export function buildWorkDocRollbackBody(input: {
  chatId: string;
  expectedVersion: number | string;
  toVersion: number | string;
  summary?: string;
}): WorkDocRollbackBodyResult {
  const chatId = isSafeChatId(input.chatId) ? input.chatId : '';
  if (!chatId) return { ok: false, error: 'A chat context is required to roll this document back.' };
  const expectedVersion = normalizeVersion(input.expectedVersion);
  const toVersion = normalizeVersion(input.toVersion);
  if (expectedVersion === null || toVersion === null) {
    return { ok: false, error: 'Both the current version and the target version must be whole numbers of 1 or more.' };
  }
  const rawSummary = input.summary?.trim() ?? '';
  if (rawSummary.length > WORK_DOC_SUMMARY_MAX) {
    return { ok: false, error: `Summary must be at most ${WORK_DOC_SUMMARY_MAX} characters.` };
  }
  return {
    ok: true,
    body: {
      chatId,
      expectedVersion,
      toVersion,
      ...(rawSummary.length > 0 ? { summary: rawSummary } : {}),
      source: 'user',
    },
  };
}

function normalizeVersion(value: number | string): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Response validation                                                  */
/* ------------------------------------------------------------------ */

export type WorkDocResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reqString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Bounded on-screen document content display (rendered as text). */
export const WORK_DOC_DISPLAY_LIMIT = 4000;

export function truncateWorkDocContent(value: string, limit: number = WORK_DOC_DISPLAY_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export function formatWorkDocTime(value: unknown, fallback = '(unknown)'): string {
  return typeof value === 'string' ? formatDateTime(value, fallback) : fallback;
}

export interface WorkDoc {
  id: string;
  scope: string;
  chatId: string;
  type: WorkDocType;
  title: string;
  /** Raw content (detail page truncates for display via truncateWorkDocContent). */
  content: string;
  status: WorkDocStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function mapWorkDoc(raw: unknown): WorkDocResult<WorkDoc> {
  if (!isPlainObject(raw)) return { ok: false, error: WORK_DOC_DETAIL_ERROR };
  const doc = raw;
  if (
    !isWorkDocId(doc.id) ||
    !reqString(doc.scope) ||
    !reqString(doc.chatId) ||
    !isWorkDocType(doc.type) ||
    !reqString(doc.title) ||
    !reqString(doc.content) ||
    !isWorkDocStatus(doc.status) ||
    typeof doc.version !== 'number' ||
    !Number.isInteger(doc.version) ||
    doc.version < 1 ||
    !reqString(doc.createdAt) ||
    !reqString(doc.updatedAt)
  ) {
    return { ok: false, error: WORK_DOC_DETAIL_ERROR };
  }
  return {
    ok: true,
    value: {
      id: doc.id,
      scope: doc.scope,
      chatId: doc.chatId,
      type: doc.type,
      title: doc.title,
      content: doc.content,
      status: doc.status,
      version: doc.version,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    },
  };
}

export interface WorkDocVersion {
  id: string;
  documentId: string;
  version: number;
  title: string;
  content: string;
  status: WorkDocStatus;
  createdAt: string;
}

export function mapWorkDocVersion(raw: unknown): WorkDocResult<WorkDocVersion> {
  if (!isPlainObject(raw)) return { ok: false, error: WORK_DOC_DETAIL_ERROR };
  const version = raw.version;
  if (
    !isWorkDocId(raw.id) ||
    !isWorkDocId(raw.documentId) ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    !reqString(raw.title) ||
    !reqString(raw.content) ||
    !isWorkDocStatus(raw.status) ||
    !reqString(raw.createdAt)
  ) {
    return { ok: false, error: WORK_DOC_DETAIL_ERROR };
  }
  return {
    ok: true,
    value: {
      id: raw.id,
      documentId: raw.documentId,
      version,
      title: raw.title,
      content: raw.content,
      status: raw.status,
      createdAt: raw.createdAt,
    },
  };
}

export interface WorkDocRevision {
  id: string;
  documentId: string;
  source: 'agent' | 'user';
  actorId: string | null;
  fromVersion: number | null;
  toVersion: number;
  summary: string;
  createdAt: string;
}

export function mapWorkDocRevision(raw: unknown): WorkDocResult<WorkDocRevision> {
  if (!isPlainObject(raw)) return { ok: false, error: WORK_DOC_DETAIL_ERROR };
  const toVersion = raw.toVersion;
  const fromVersion = raw.fromVersion;
  if (
    !isWorkDocId(raw.id) ||
    !isWorkDocId(raw.documentId) ||
    (raw.source !== 'agent' && raw.source !== 'user') ||
    (raw.actorId !== null && !reqString(raw.actorId)) ||
    (fromVersion !== null && (typeof fromVersion !== 'number' || !Number.isInteger(fromVersion))) ||
    typeof toVersion !== 'number' ||
    !Number.isInteger(toVersion) ||
    toVersion < 1 ||
    !reqString(raw.summary) ||
    !reqString(raw.createdAt)
  ) {
    return { ok: false, error: WORK_DOC_DETAIL_ERROR };
  }
  return {
    ok: true,
    value: {
      id: raw.id,
      documentId: raw.documentId,
      source: raw.source,
      actorId: reqString(raw.actorId) ? (raw.actorId as string) : null,
      fromVersion,
      toVersion,
      summary: raw.summary,
      createdAt: raw.createdAt,
    },
  };
}

export interface WorkDocLink {
  id: string;
  documentId: string;
  targetType: WorkDocLinkTargetType;
  targetId: string;
  label: string | null;
  createdAt: string;
}

export function mapWorkDocLink(raw: unknown): WorkDocResult<WorkDocLink> {
  if (!isPlainObject(raw)) return { ok: false, error: WORK_DOC_DETAIL_ERROR };
  if (
    !isWorkDocId(raw.id) ||
    !isWorkDocId(raw.documentId) ||
    !isWorkDocLinkTargetType(raw.targetType) ||
    !reqString(raw.targetId) ||
    (raw.label !== null && !reqString(raw.label)) ||
    !reqString(raw.createdAt)
  ) {
    return { ok: false, error: WORK_DOC_DETAIL_ERROR };
  }
  return {
    ok: true,
    value: {
      id: raw.id,
      documentId: raw.documentId,
      targetType: raw.targetType,
      targetId: raw.targetId,
      label: reqString(raw.label) ? (raw.label as string) : null,
      createdAt: raw.createdAt,
    },
  };
}

function mapArray<T>(entries: readonly unknown[], item: (raw: unknown) => WorkDocResult<T>, error: string): WorkDocResult<T[]> {
  const list: T[] = [];
  for (const entry of entries) {
    const mapped = item(entry);
    if (!mapped.ok) return { ok: false, error };
    list.push(mapped.value);
  }
  return { ok: true, value: list };
}

function mapList<T>(payload: unknown, key: string, item: (raw: unknown) => WorkDocResult<T>, error: string): WorkDocResult<T[]> {
  if (!isPlainObject(payload) || !Array.isArray(payload[key])) return { ok: false, error };
  return mapArray(payload[key] as unknown[], item, error);
}

/* GET …/work-docs → { documents } */
export function mapWorkDocListResponse(raw: unknown, error = WORK_DOC_LIST_ERROR): WorkDocResult<WorkDoc[]> {
  return mapList(raw, 'documents', mapWorkDoc, error);
}

/* GET …/work-docs/:id → { document, recentVersions, links } */
export interface WorkDocDetail {
  document: WorkDoc;
  recentVersions: WorkDocVersion[];
  links: WorkDocLink[];
}

export function mapWorkDocDetailResponse(raw: unknown, error = WORK_DOC_DETAIL_ERROR): WorkDocResult<WorkDocDetail> {
  if (!isPlainObject(raw) || !Array.isArray(raw.recentVersions) || !Array.isArray(raw.links)) {
    return { ok: false, error };
  }
  const document = mapWorkDoc(raw.document);
  if (!document.ok) return { ok: false, error };
  const recentVersions = mapArray(raw.recentVersions, mapWorkDocVersion, error);
  if (!recentVersions.ok) return { ok: false, error };
  const links = mapArray(raw.links, mapWorkDocLink, error);
  if (!links.ok) return { ok: false, error };
  return { ok: true, value: { document: document.value, recentVersions: recentVersions.value, links: links.value } };
}

/* GET …/versions → { versions } */
export function mapWorkDocVersionsResponse(raw: unknown, error = WORK_DOC_DETAIL_ERROR): WorkDocResult<WorkDocVersion[]> {
  return mapList(raw, 'versions', mapWorkDocVersion, error);
}

/* GET …/revisions → { revisions } */
export function mapWorkDocRevisionsResponse(raw: unknown, error = WORK_DOC_DETAIL_ERROR): WorkDocResult<WorkDocRevision[]> {
  return mapList(raw, 'revisions', mapWorkDocRevision, error);
}

/* GET …/links → { links } */
export function mapWorkDocLinksResponse(raw: unknown, error = WORK_DOC_DETAIL_ERROR): WorkDocResult<WorkDocLink[]> {
  return mapList(raw, 'links', mapWorkDocLink, error);
}

/* PATCH …/work-docs/:id and POST …/rollback → { document } */
export function mapWorkDocUpdateResponse(raw: unknown, error = WORK_DOC_UPDATE_ERROR): WorkDocResult<WorkDoc> {
  if (!isPlainObject(raw)) return { ok: false, error };
  return mapWorkDoc(raw.document);
}

/* ------------------------------------------------------------------ */
/* Safe errors + request plumbing                                       */
/* ------------------------------------------------------------------ */

export const WORK_DOC_FALLBACK_ERROR = 'Something went wrong. Please try again.';
export const WORK_DOC_LIST_ERROR = 'Work documents are temporarily unavailable. Refresh to retry.';
export const WORK_DOC_DETAIL_ERROR = 'Work document is temporarily unavailable. Refresh to retry.';
export const WORK_DOC_UPDATE_ERROR = 'Document could not be updated. Refresh and try again.';
export const WORK_DOC_CREATE_ERROR = 'Document could not be created. Refresh and try again.';
export const WORK_DOC_ROLLBACK_ERROR = 'Rollback could not be applied. Refresh and try again.';

/** The CAS conflict is common enough to deserve a fixed, actionable line. */
export const WORK_DOC_CONFLICT_HINT =
  'The document changed on the server while you were editing. Refresh to load the current version, then retry.';

export interface WorkFetch {
  (
    input: string,
    init?: {
      method?: 'GET' | 'POST' | 'PATCH';
      cache?: 'no-store';
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
}

export type WorkRequestResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: string };

/** One JSON request helper: never throws, `no-store`, safe fixed errors. */
export async function requestWorkJson(options: {
  url: string;
  method: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  fallbackError: string;
  fetchImpl?: WorkFetch;
}): Promise<WorkRequestResult> {
  const { url, method, body, fallbackError, fetchImpl = browserApiFetch } = options;
  const init: NonNullable<Parameters<WorkFetch>[1]> = {
    method,
    cache: 'no-store',
    headers: { accept: 'application/json' },
  };
  if (method !== 'GET' && body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    try {
      init.body = JSON.stringify(body);
    } catch {
      return { ok: false, error: fallbackError };
    }
  }
  try {
    const response = await fetchImpl(url, init);
    let raw: unknown = null;
    try {
      raw = await response.json();
    } catch {
      if (response.ok) return { ok: false, error: fallbackError };
      raw = null;
    }
    if (response.ok) return { ok: true, status: response.status ?? 0, body: raw };
    const authError = requestAuthError(response.status ?? 0);
    if (authError !== null) return { ok: false, error: authError };
    return { ok: false, error: extractApiErrorMessage(raw, fallbackError) };
  } catch {
    return { ok: false, error: fallbackError };
  }
}

/* ------------------------------------------------------------------ */
/* One-call orchestration per endpoint                                  */
/* ------------------------------------------------------------------ */

export type WorkDocListFetchResult =
  | { ok: true; documents: WorkDoc[] }
  | { ok: false; error: string };

export async function fetchWorkDocList(options: {
  apiBaseUrl: string;
  filters: WorkDocListFilters;
  fetchImpl?: WorkFetch;
}): Promise<WorkDocListFetchResult> {
  const { apiBaseUrl, filters, fetchImpl } = options;
  const result = await requestWorkJson({
    url: workDocsListEndpoint(apiBaseUrl, buildWorkDocListQuery(filters)),
    method: 'GET',
    fallbackError: WORK_DOC_LIST_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapWorkDocListResponse(result.body);
  return mapped.ok ? { ok: true, documents: mapped.value } : mapped;
}

export type WorkDocDetailFetchResult =
  | { ok: true; detail: WorkDocDetail }
  | { ok: false; error: string };

export async function fetchWorkDocDetail(options: {
  apiBaseUrl: string;
  workDocId: string;
  chatId: string;
  fetchImpl?: WorkFetch;
}): Promise<WorkDocDetailFetchResult> {
  const { apiBaseUrl, chatId, fetchImpl } = options;
  if (!isWorkDocId(options.workDocId) || !isSafeChatId(chatId)) {
    return { ok: false, error: WORK_DOC_DETAIL_ERROR };
  }
  const result = await requestWorkJson({
    url: workDocDetailEndpoint(apiBaseUrl, options.workDocId, chatId),
    method: 'GET',
    fallbackError: WORK_DOC_DETAIL_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapWorkDocDetailResponse(result.body);
  return mapped.ok ? { ok: true, detail: mapped.value } : mapped;
}

export type WorkDocVersionsFetchResult =
  | { ok: true; versions: WorkDocVersion[] }
  | { ok: false; error: string };

export async function fetchWorkDocVersions(options: {
  apiBaseUrl: string;
  workDocId: string;
  chatId: string;
  limit?: number;
  fetchImpl?: WorkFetch;
}): Promise<WorkDocVersionsFetchResult> {
  const { apiBaseUrl, chatId, limit, fetchImpl } = options;
  if (!isWorkDocId(options.workDocId) || !isSafeChatId(chatId)) {
    return { ok: false, error: WORK_DOC_DETAIL_ERROR };
  }
  const result = await requestWorkJson({
    url: workDocVersionsEndpoint(apiBaseUrl, options.workDocId, chatId, limit),
    method: 'GET',
    fallbackError: WORK_DOC_DETAIL_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapWorkDocVersionsResponse(result.body);
  return mapped.ok ? { ok: true, versions: mapped.value } : mapped;
}

export type WorkDocRevisionsFetchResult =
  | { ok: true; revisions: WorkDocRevision[] }
  | { ok: false; error: string };

export async function fetchWorkDocRevisions(options: {
  apiBaseUrl: string;
  workDocId: string;
  chatId: string;
  limit?: number;
  fetchImpl?: WorkFetch;
}): Promise<WorkDocRevisionsFetchResult> {
  const { apiBaseUrl, chatId, limit, fetchImpl } = options;
  if (!isWorkDocId(options.workDocId) || !isSafeChatId(chatId)) {
    return { ok: false, error: WORK_DOC_DETAIL_ERROR };
  }
  const result = await requestWorkJson({
    url: workDocRevisionsEndpoint(apiBaseUrl, options.workDocId, chatId, limit),
    method: 'GET',
    fallbackError: WORK_DOC_DETAIL_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapWorkDocRevisionsResponse(result.body);
  return mapped.ok ? { ok: true, revisions: mapped.value } : mapped;
}

export type WorkDocUpdateResult =
  | { ok: true; document: WorkDoc }
  | { ok: false; error: string };

/** Metadata-only PATCH (title/status) with the required CAS version. */
export async function updateWorkDocMetadata(options: {
  apiBaseUrl: string;
  workDocId: string;
  body: { chatId: string; expectedVersion: number; title?: string; status?: WorkDocStatus };
  fetchImpl?: WorkFetch;
}): Promise<WorkDocUpdateResult> {
  const { apiBaseUrl, body, fetchImpl } = options;
  if (!isWorkDocId(options.workDocId)) {
    return { ok: false, error: WORK_DOC_UPDATE_ERROR };
  }
  const result = await requestWorkJson({
    url: workDocBase(apiBaseUrl, options.workDocId),
    method: 'PATCH',
    body,
    fallbackError: WORK_DOC_UPDATE_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapWorkDocUpdateResponse(result.body);
  return mapped.ok ? { ok: true, document: mapped.value } : mapped;
}

/** Rollback: `{ expectedVersion, toVersion }` required → NEW current version. */
export async function rollbackWorkDoc(options: {
  apiBaseUrl: string;
  workDocId: string;
  body: { chatId: string; expectedVersion: number; toVersion: number; summary?: string; source: 'user' };
  fetchImpl?: WorkFetch;
}): Promise<WorkDocUpdateResult> {
  const { apiBaseUrl, body, fetchImpl } = options;
  if (!isWorkDocId(options.workDocId)) {
    return { ok: false, error: WORK_DOC_ROLLBACK_ERROR };
  }
  const result = await requestWorkJson({
    url: `${workDocBase(apiBaseUrl, options.workDocId)}/rollback`,
    method: 'POST',
    body,
    fallbackError: WORK_DOC_ROLLBACK_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapWorkDocUpdateResponse(result.body, WORK_DOC_ROLLBACK_ERROR);
  return mapped.ok ? { ok: true, document: mapped.value } : mapped;
}

export type WorkDocVersionPostResult =
  | { ok: true; document: WorkDoc }
  | { ok: false; error: string };

/**
 * Versioned content/title/status update through the REAL agent versions
 * route (POST …/versions) with `source: 'user'` from the builder. 409 CAS
 * conflicts surface the API's fixed 'Work document version conflict.' text
 * verbatim.
 */
export async function postWorkDocVersion(options: {
  apiBaseUrl: string;
  workDocId: string;
  body: { chatId: string; expectedVersion: number; content?: string; title?: string; status?: WorkDocStatus; summary?: string; source: 'user' };
  fetchImpl?: WorkFetch;
}): Promise<WorkDocVersionPostResult> {
  const { apiBaseUrl, body, fetchImpl } = options;
  if (!isWorkDocId(options.workDocId)) {
    return { ok: false, error: WORK_DOC_UPDATE_ERROR };
  }
  const result = await requestWorkJson({
    url: `${workDocBase(apiBaseUrl, options.workDocId)}/versions`,
    method: 'POST',
    body,
    fallbackError: WORK_DOC_UPDATE_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapWorkDocUpdateResponse(result.body);
  return mapped.ok ? { ok: true, document: mapped.value } : mapped;
}

export type WorkDocCreateResult =
  | { ok: true; document: WorkDoc }
  | { ok: false; error: string };

/** Create a draft document through the real route (orchestrator namespace). */
export async function createWorkDoc(options: {
  apiBaseUrl: string;
  body: { chatId: string; type: WorkDocType; title: string; content: string };
  fetchImpl?: WorkFetch;
}): Promise<WorkDocCreateResult> {
  const { apiBaseUrl, body, fetchImpl } = options;
  const result = await requestWorkJson({
    url: workDocsListEndpoint(apiBaseUrl),
    method: 'POST',
    body,
    fallbackError: WORK_DOC_CREATE_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapWorkDocUpdateResponse(result.body, WORK_DOC_CREATE_ERROR);
  return mapped.ok ? { ok: true, document: mapped.value } : mapped;
}

/* ------------------------------------------------------------------ */
/* Typed-link navigation (cross-feature, no cross-chat leaks)           */
/* ------------------------------------------------------------------ */

/**
 * Where a typed link points inside this UI. `null` = render the target id as
 * plain text instead of a link (unknown target shape / unsafe id).
 */
export function workDocLinkHref(
  link: WorkDocLink,
  contextChatId: string,
): { href: string; text: string } | null {
  if (link.targetType === 'memory_block') {
    return { href: '/memory', text: link.label ?? 'Memory block' };
  }
  if (link.targetType === 'chat') {
    if (!isSafeChatId(link.targetId)) return null;
    return {
      href: `/chat/${encodeURIComponent(link.targetId)}`,
      text: link.label ?? 'Chat',
    };
  }
  if (link.targetType === 'delegation') {
    // Delegations are scoped by parent chat; link back to THIS chat's list so
    // no other chat's existence is disclosed.
    if (!isSafeChatId(contextChatId)) return null;
    return {
      href: `/delegations?chatId=${encodeURIComponent(contextChatId)}`,
      text: link.label ?? 'Delegations in this chat',
    };
  }
  return null;
}

/** Short bounded summary line for a version row (`v3 · draft · 2026-…`). */
export function workDocVersionLine(version: WorkDocVersion): string {
  return `v${version.version} · ${version.status} · ${formatWorkDocTime(version.createdAt)}`;
}

/** Re-exported shaping helpers the components share with memory. */
export { truncateMemoryText as truncateWorkText, MEMORY_TEXT_LIMIT as WORK_TEXT_LIMIT };
