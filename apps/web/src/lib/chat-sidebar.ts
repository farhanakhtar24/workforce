/**
 * Chat sidebar action helpers (Farhan's request A): rename, pin/archive,
 * session-id copy, transcript export, and the archived reachable list over
 * the authenticated chat metadata/export endpoints. Pure builders/mappers
 * live here; the recent-chats row menus and the Settings dialog consume them.
 *
 * Contracts (session cookies via browserApiFetch):
 * - GET/PATCH /api/agents/:slug/chat/:chatId/metadata — strict patch with at
 *   least one of {title?, pinned?, archived?}; title `null`/'' clears the
 *   custom title; 200 answers `{ metadata: {...} }`.
 * - GET /api/agents/:slug/chat/:chatId/export — the COMPLETE transcript as a
 *   `text/markdown` attachment (never a client-only fake export).
 * - GET /api/chats?limit=N&includeArchived=true — archived rows reachable.
 */

import { browserApiFetch, isSafeChatId, requestAuthError } from './api';

export const CHAT_TITLE_MAX_CODEPOINTS = 80;

/** Fixed safe copy for the sidebar action operations. */
export const CHAT_METADATA_ERROR = 'Chat settings could not be saved. Refresh and try again.';
export const CHAT_METADATA_CONFLICT = 'That chat was already deleted or never existed.';
export const CHAT_METADATA_BUSY =
  'The chat is busy generating — its title cannot be changed right now. Try again after the reply finishes.';
export const CHAT_EXPORT_ERROR = 'The transcript could not be exported. Refresh and try again.';
export const CHAT_COPY_ERROR = 'The session ID could not be copied. Select and copy it manually.';

/* ------------------------------------------------------------------ */
/* Title validation (Unicode-safe code-point bound)                    */
/* ------------------------------------------------------------------ */

/** Code-point count (a trimmed emoji pair counts as 1, not 2). */
export function titleCodepointLength(title: string): number {
  return Array.from(title).length;
}

/**
 * Sanitizes a rename: trims, enforces the 80-code-point bound, and collapses
 * blank/whitespace input to `null` (an intentional CLEAR of the custom
 * title). `undefined` = don’t change the title in the patch.
 */
export function sanitizeChatTitle(
  rawTitle: string | null | undefined,
): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (rawTitle === undefined) return { ok: true, value: undefined };
  // The API clears a custom title on `null` — an explicit user choice.
  if (rawTitle === null) return { ok: true, value: null };
  if (typeof rawTitle !== 'string') return { ok: false, error: CHAT_METADATA_ERROR };
  const trimmed = rawTitle.replace(/^\s+|\s+$/g, '');
  if (trimmed === '') return { ok: true, value: null };
  const codePoints = Array.from(trimmed);
  if (codePoints.length > CHAT_TITLE_MAX_CODEPOINTS) {
    return {
      ok: false,
      error: `Titles are limited to ${CHAT_TITLE_MAX_CODEPOINTS} characters (currently ${codePoints.length}).`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Strict PATCH body builder: at least one of {title?, pinned?, archived?},
 * mirroring the API's zod contract. Unknown/empty patches never fetch.
 */
export function buildChatMetadataPatch(patch: {
  title?: string | null;
  pinned?: boolean;
  archived?: boolean;
}): { ok: true; body: string } | { ok: false; error: string } {
  const body: { title?: string | null; pinned?: boolean; archived?: boolean } = {};
  if (patch.title !== undefined) {
    const sanitized = sanitizeChatTitle(patch.title);
    if (!sanitized.ok) return { ok: false, error: sanitized.error };
    body.title = sanitized.value;
  }
  if (patch.pinned !== undefined) {
    if (typeof patch.pinned !== 'boolean') return { ok: false, error: CHAT_METADATA_ERROR };
    body.pinned = patch.pinned;
  }
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== 'boolean') return { ok: false, error: CHAT_METADATA_ERROR };
    body.archived = patch.archived;
  }
  if (Object.keys(body).length === 0) {
    return { ok: false, error: CHAT_METADATA_ERROR };
  }
  return { ok: true, body: JSON.stringify(body) };
}

/* ------------------------------------------------------------------ */
/* Endpoints + response mappers                                        */
/* ------------------------------------------------------------------ */

export function chatMetadataEndpoint(apiBaseUrl: string, slug: string, chatId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) return null;
  if (!isSafeChatId(chatId)) return null;
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/agents/${encodeURIComponent(slug)}/chat/${encodeURIComponent(chatId)}/metadata`;
}

export function chatExportEndpoint(apiBaseUrl: string, slug: string, chatId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) return null;
  if (!isSafeChatId(chatId)) return null;
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/agents/${encodeURIComponent(slug)}/chat/${encodeURIComponent(chatId)}/export`;
}

export interface ChatMetadata {
  title: string | null;
  pinned: boolean;
  archived: boolean;
}

export type ChatMetadataResult =
  | { ok: true; metadata: ChatMetadata }
  | { ok: false; error: string; status: number };

/** Strict metadata mapping: exact shape, title ≤80 code points or null. */
export function mapChatMetadata(payload: unknown): ChatMetadataResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: CHAT_METADATA_ERROR, status: 502 };
  }
  const settings = (payload as Record<string, unknown>)['metadata'];
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, error: CHAT_METADATA_ERROR, status: 502 };
  }
  const record = settings as Record<string, unknown>;
  const title = record['title'];
  const pinned = record['pinned'];
  const archived = record['archived'];
  const titleOk = title === null || (typeof title === 'string' && titleCodepointLength(title) <= CHAT_TITLE_MAX_CODEPOINTS);
  if (!titleOk || typeof pinned !== 'boolean' || typeof archived !== 'boolean') {
    return { ok: false, error: CHAT_METADATA_ERROR, status: 502 };
  }
  return {
    ok: true,
    metadata: { title: typeof title === 'string' ? title : null, pinned: pinned === true, archived: archived === true },
  };
}

export async function patchChatMetadata(options: {
  apiBaseUrl: string;
  slug: string;
  chatId: string;
  patch: { title?: string | null; pinned?: boolean; archived?: boolean };
  fetchImpl?: typeof browserApiFetch;
}): Promise<ChatMetadataResult> {
  const url = chatMetadataEndpoint(options.apiBaseUrl, options.slug, options.chatId);
  if (url === null) return { ok: false, error: CHAT_METADATA_ERROR, status: 400 };
  const body = buildChatMetadataPatch(options.patch);
  if (!body.ok) return { ok: false, error: body.error, status: 400 };
  try {
    const response = await (options.fetchImpl ?? browserApiFetch)(url, {
      method: 'PATCH',
      cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: body.body,
    });
    if (!response.ok) {
      const authError = requestAuthError(response.status ?? 0);
      if (authError !== null) return { ok: false, error: authError, status: response.status ?? 0 };
      const status = response.status ?? 0;
      const conflict = status === 404 ? CHAT_METADATA_CONFLICT : status === 409 ? CHAT_METADATA_BUSY : CHAT_METADATA_ERROR;
      return { ok: false, error: conflict, status };
    }
    return mapChatMetadata(await response.json());
  } catch {
    return { ok: false, error: CHAT_METADATA_ERROR, status: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* Transcript export (server-owned Markdown)                           */
/* ------------------------------------------------------------------ */

export type ChatExportResult =
  | { ok: true; markdown: string; filename: string }
  | { ok: false; error: string; status: number };

/** `chat-<chatId>-export-<iso>.md`, id sanitized, ISO time-slug. */
export function exportFilenameFor(chatId: string, exportedAtIso: string): string {
  // ISO timestamps carry colons (T12:00:00); sanitize them for filenames.
  const stamp = (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.exec(exportedAtIso)?.[0] ?? 'export').replace(/:/g, '-');
  const safeId = /^[A-Za-z0-9._:-]{1,80}$/.test(chatId) ? chatId.replace(/[^A-Za-z0-9._:-]+/g, '-') : 'chat';
  return `chat-${safeId}-export-${stamp}.md`;
}

export async function fetchChatExport(options: {
  apiBaseUrl: string;
  slug: string;
  chatId: string;
  fetchImpl?: typeof browserApiFetch;
}): Promise<ChatExportResult> {
  const url = chatExportEndpoint(options.apiBaseUrl, options.slug, options.chatId);
  if (url === null) return { ok: false, error: CHAT_EXPORT_ERROR, status: 400 };
  try {
    const response = await (options.fetchImpl ?? browserApiFetch)(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'text/markdown' },
    });
    if (!response.ok) {
      const authError = requestAuthError(response.status ?? 0);
      if (authError !== null) return { ok: false, error: authError, status: response.status ?? 0 };
      const status = response.status ?? 0;
      return { ok: false, error: status === 404 ? CHAT_METADATA_CONFLICT : CHAT_EXPORT_ERROR, status };
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!(contentType.startsWith('text/markdown') || contentType.startsWith('text/'))) {
      return { ok: false, error: CHAT_EXPORT_ERROR, status: 502 };
    }
    const markdown = await response.text();
    const disposition = response.headers.get('content-disposition') ?? '';
    const serverName = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
    return {
      ok: true,
      markdown,
      filename: serverName !== null && serverName.length > 0 && !/[\\/\u0000-\u001f]/.test(serverName)
        ? serverName
        : exportFilenameFor(options.chatId, new Date().toISOString()),
    };
  } catch {
    return { ok: false, error: CHAT_EXPORT_ERROR, status: 0 };
  }
}

/** Clipboard write with a text-area fallback; resolves to success honestly. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  try {
    if (navigator.clipboard !== undefined && navigator.clipboard.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  if (typeof document === 'undefined') return false;
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy') === true;
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
