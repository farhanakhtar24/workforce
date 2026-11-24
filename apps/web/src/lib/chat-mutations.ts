/**
 * Chat mutation helpers (Farhan's request: browser controls for the
 * authenticated chat-mutation APIs). Pure endpoint/body/response helpers in
 * the existing style of `recent-chats.ts` — fixed safe errors, structural
 * mapping, `browserApiFetch` + shared auth status mapping, and the
 * `workforce:chats-changed` refresh event fired by callers after success.
 *
 * Contracts (API-owned, session credential cookies always included):
 * - DELETE /api/agents/:slug/chat/:chatId           → 200 `{deleted:true}`;
 *   404 unknown; 409 while a generation is active. Deletion never removes
 *   work documents, delegations or memory blocks ("artifacts survive").
 * - POST   /api/agents/:slug/chat/:chatId/branch    strict body
 *   `{messageId, newChatId}` → 201 `{branched:true,destinationChatId,
 *   copiedMessages}`; copies THROUGH the selected message (inclusive) into a
 *   NEW chat; the original transcript stays untouched. 404 unknown message;
 *   409 destination id already used.
 * - POST   /api/agents/:slug/chat/:chatId/rewind    strict body
 *   `{messageId}` → 200 `{rewound:true,kept,removed,hasActiveStream:false}`;
 *   DESTRUCTIVELY deletes messages AFTER the selected one (kept raw bytes
 *   stay intact). 404 unknown; 409 active or stale-generation guard.
 */

import { buildChatUrl, isAgentSlug, type WebAgentMode, type WebAgentSlug } from './agents';
import {
  browserApiFetch,
  isSafeChatId,
  requestAuthError,
} from './api';
import { CHATS_CHANGED_EVENT } from './recent-chats';

export type { WebAgentMode, WebAgentSlug };

/** Window event listeners (RecentChats) refresh on this event after success. */
export { CHATS_CHANGED_EVENT } from './recent-chats';

/** Dispatches the shared refresh event in a browser; no-op elsewhere. */
export function notifyChatsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CHATS_CHANGED_EVENT));
}

/* Fixed, safe error copy — never internals, never partial details. */
export const CHAT_DELETE_ERROR = 'The chat could not be deleted. Refresh and try again.';
export const CHAT_DELETE_NOT_FOUND = 'That chat was already deleted or never existed.';
export const CHAT_DELETE_ACTIVE =
  'This chat is still generating — the active stream must finish or be wound down before deletion.';
export const CHAT_BRANCH_ERROR = 'The chat could not be branched. Refresh and try again.';
export const CHAT_BRANCH_NOT_FOUND = 'That message was not found — the transcript may have changed. Refresh and retry.';
export const CHAT_BRANCH_CONFLICT =
  'The destination chat id is already in use. Try branching again with a fresh id.';
export const CHAT_REWIND_ERROR = 'The transcript could not be rewound. Refresh and try again.';
export const CHAT_REWIND_NOT_FOUND = 'That message was not found — the transcript may have changed. Refresh and retry.';
export const CHAT_REWIND_ACTIVE =
  'The transcript cannot be rewound while a generation is active, or the server sees a different newest state. Refresh, then retry.';

/** Deletion semantics shown in the confirmation dialog: work survives. */
export const CHAT_DELETE_NOTE =
  'Artifacts (work documents, delegation records, memory blocks) survive this chat’s deletion.';

/* ------------------------------------------------------------------ */
/* IDs + endpoints                                                     */
/* ------------------------------------------------------------------ */

export interface ChatMutationTarget {
  apiBaseUrl: string;
  slug: WebAgentSlug;
  chatId: string;
}

function chatMutationPath(chatId: string, suffix: '' | '/branch' | '/rewind'): string | null {
  if (!isSafeChatId(chatId)) return null;
  return suffix === '' ? chatId : `${chatId}${suffix}`;
}

function chatEndpoint(options: ChatMutationTarget, suffix: '' | '/branch' | '/rewind'): string | null {
  if (!isAgentSlug(options.slug)) return null;
  const idPart = chatMutationPath(options.chatId, suffix);
  if (idPart === null) return null;
  return `${options.apiBaseUrl.replace(/\/+$/, '')}/api/agents/${encodeURIComponent(options.slug)}/chat/${idPart}`;
}

export function deleteChatEndpoint(apiBaseUrl: string, slug: WebAgentSlug, chatId: string): string | null {
  return chatEndpoint({ apiBaseUrl, slug, chatId }, '');
}

export function branchChatEndpoint(apiBaseUrl: string, slug: WebAgentSlug, chatId: string): string | null {
  return chatEndpoint({ apiBaseUrl, slug, chatId }, '/branch');
}

export function rewindChatEndpoint(apiBaseUrl: string, slug: WebAgentSlug, chatId: string): string | null {
  return chatEndpoint({ apiBaseUrl, slug, chatId }, '/rewind');
}

/** Branch body: strict `{ messageId, newChatId }` — invalid ids fail BEFORE fetch. */
export function buildBranchBody(
  messageId: string,
  newChatId: string,
): { ok: true; body: string } | { ok: false; error: string } {
  if (!isSafeChatId(messageId) || !isSafeChatId(newChatId)) {
    return { ok: false, error: CHAT_BRANCH_ERROR };
  }
  return { ok: true, body: JSON.stringify({ messageId, newChatId }) };
}

/** Rewind body: strict `{ messageId }` — invalid ids fail BEFORE fetch. */
export function buildRewindBody(messageId: string): { ok: true; body: string } | { ok: false; error: string } {
  if (!isSafeChatId(messageId)) {
    return { ok: false, error: CHAT_REWIND_ERROR };
  }
  return { ok: true, body: JSON.stringify({ messageId }) };
}

/* ------------------------------------------------------------------ */
/* Response mapping                                                    */
/* ------------------------------------------------------------------ */

export type MutationResult =
  | { ok: true }
  | { ok: false; error: string; status: number };

export type BranchResult =
  | { ok: true; destinationChatId: string; copiedMessages: number }
  | { ok: false; error: string; status: number };

export type RewindResult =
  | { ok: true; kept: number; removed: number }
  | { ok: false; error: string; status: number };

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function statusErrorFixed(response: { status?: number }, error: string): MutationResult {
  return { ok: false, error, status: response.status ?? 0 };
}

function fixedForStatus(
  status: number,
  notFound: string,
  conflict: string,
  fallback: string,
): string {
  if (status === 404) return notFound;
  if (status === 409) return conflict;
  return fallback;
}

export function mapDeleteChatResponse(payload: unknown): MutationResult {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    (payload as Record<string, unknown>)['deleted'] === true
  ) {
    return { ok: true };
  }
  return { ok: false, error: CHAT_DELETE_ERROR, status: 502 };
}

export function mapBranchResponse(payload: unknown): BranchResult {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: CHAT_BRANCH_ERROR, status: 502 };
  }
  const record = payload as Record<string, unknown>;
  const destinationChatId = typeof record['destinationChatId'] === 'string' ? record['destinationChatId'] : '';
  const copiedMessages = nonNegativeInt(record['copiedMessages']);
  if (record['branched'] !== true || !isSafeChatId(destinationChatId) || copiedMessages === null) {
    return { ok: false, error: CHAT_BRANCH_ERROR, status: 502 };
  }
  return { ok: true, destinationChatId, copiedMessages };
}

export function mapRewindResponse(payload: unknown): RewindResult {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: CHAT_REWIND_ERROR, status: 502 };
  }
  const record = payload as Record<string, unknown>;
  const kept = nonNegativeInt(record['kept']);
  const removed = nonNegativeInt(record['removed']);
  if (record['rewound'] !== true || kept === null || removed === null) {
    return { ok: false, error: CHAT_REWIND_ERROR, status: 502 };
  }
  return { ok: true, kept, removed };
}

/* ------------------------------------------------------------------ */
/* Fetch orchestration                                                 */
/* ------------------------------------------------------------------ */

export type ChatMutationFetch = (
  input: string,
  init?: {
    method?: 'DELETE' | 'POST';
    cache?: 'no-store';
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

type FetchLike = ChatMutationFetch;

async function request(
  fetchImpl: FetchLike,
  url: string,
  method: 'DELETE' | 'POST',
  body: string | undefined,
  fixed: { notFound: string; conflict: string; fallback: string },
): Promise<
  | { ok: true; status: number; json: () => Promise<unknown> }
  | { ok: false; status: number; error: string }
> {
  try {
    const response = await fetchImpl(url, {
      method,
      cache: 'no-store',
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body } : {}),
    });
    if (!response.ok) {
      const authError = requestAuthError(response.status ?? 0);
      if (authError !== null) return { ok: false, status: response.status ?? 0, error: authError };
      return {
        ok: false,
        status: response.status ?? 0,
        error: fixedForStatus(response.status ?? 0, fixed.notFound, fixed.conflict, fixed.fallback),
      };
    }
    return { ok: true, status: response.status ?? 0, json: () => response.json() };
  } catch {
    return { ok: false, status: 0, error: fixed.fallback };
  }
}

export async function deleteChat(options: ChatMutationTarget & { fetchImpl?: ChatMutationFetch }): Promise<MutationResult> {
  const url = deleteChatEndpoint(options.apiBaseUrl, options.slug, options.chatId);
  if (url === null) return { ok: false, error: CHAT_DELETE_ERROR, status: 400 };
  const result = await request(options.fetchImpl ?? browserApiFetch, url, 'DELETE', undefined, {
    notFound: CHAT_DELETE_NOT_FOUND,
    conflict: CHAT_DELETE_ACTIVE,
    fallback: CHAT_DELETE_ERROR,
  });
  if (!result.ok) return { ok: false, error: result.error, status: result.status };
  try {
    return mapDeleteChatResponse(await result.json());
  } catch {
    return { ok: false, error: CHAT_DELETE_ERROR, status: result.status };
  }
}

export async function branchChat(
  options: ChatMutationTarget & { messageId: string; newChatId: string; fetchImpl?: ChatMutationFetch },
): Promise<BranchResult | { ok: false; error: string; status: number }> {
  const url = branchChatEndpoint(options.apiBaseUrl, options.slug, options.chatId);
  if (url === null) return { ok: false, error: CHAT_BRANCH_ERROR, status: 400 };
  const body = buildBranchBody(options.messageId, options.newChatId);
  if (!body.ok) return { ok: false, error: body.error, status: 400 };
  const result = await request(options.fetchImpl ?? browserApiFetch, url, 'POST', body.body, {
    notFound: CHAT_BRANCH_NOT_FOUND,
    conflict: CHAT_BRANCH_CONFLICT,
    fallback: CHAT_BRANCH_ERROR,
  });
  if (!result.ok) return { ok: false, error: result.error, status: result.status };
  try {
    return mapBranchResponse(await result.json());
  } catch {
    return { ok: false, error: CHAT_BRANCH_ERROR, status: result.status };
  }
}

export async function rewindChat(
  options: ChatMutationTarget & { messageId: string; fetchImpl?: ChatMutationFetch },
): Promise<RewindResult | { ok: false; error: string; status: number }> {
  const url = rewindChatEndpoint(options.apiBaseUrl, options.slug, options.chatId);
  if (url === null) return { ok: false, error: CHAT_REWIND_ERROR, status: 400 };
  const body = buildRewindBody(options.messageId);
  if (!body.ok) return { ok: false, error: body.error, status: 400 };
  const result = await request(options.fetchImpl ?? browserApiFetch, url, 'POST', body.body, {
    notFound: CHAT_REWIND_NOT_FOUND,
    conflict: CHAT_REWIND_ACTIVE,
    fallback: CHAT_REWIND_ERROR,
  });
  if (!result.ok) return { ok: false, error: result.error, status: result.status };
  try {
    return mapRewindResponse(await result.json());
  } catch {
    return { ok: false, error: CHAT_REWIND_ERROR, status: result.status };
  }
}

/* ------------------------------------------------------------------ */
/* UI-side pure helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Destination nav for a successful branch: canonical same-agent/same-mode
 * chat URL (mode kept verbatim; plan stays clean, action rides the query).
 */
export function branchDestinationHref(
  destinationChatId: string,
  slug: WebAgentSlug,
  mode: WebAgentMode,
): string {
  return buildChatUrl(destinationChatId, { agent: slug, mode });
}

/**
 * Local transcript slice for a successful rewind: `useChat`'s local state
 * must never retain deleted messages, and `kept` counts the exactly-matching
 * server-side remainder (raw bytes intact), so the client is trimmed to that
 * same prefix.
 */
export function rewindLocalSlice<T>(messages: ReadonlyArray<T>, kept: number): T[] {
  if (!Number.isInteger(kept) || kept < 0) return [];
  return messages.slice(0, Math.min(kept, messages.length));
}

/** Mutations are disabled while a generation is running or HITL is pending. */
export function canTriggerChatMutations(input: { busy: boolean; pendingAsk: boolean }): boolean {
  return !input.busy && !input.pendingAsk;
}

/** Small bounded preview of a selected message for the confirmation dialog. */
export function messagePreviewText(
  parts: ReadonlyArray<unknown>,
  maxLength: number = 200,
): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      const text = record['text'].trim();
      if (text !== '') chunks.push(text);
    }
  }
  const merged = chunks.join(' ');
  if (merged.length <= maxLength) return merged;
  const cut = merged.slice(0, Math.max(0, maxLength - 1));
  // Never strand a lone high surrogate at the preview boundary.
  const lastCode = cut.charCodeAt(cut.length - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff
    ? merged.slice(0, Math.max(0, maxLength - 2))
    : `${cut}…`;
}
