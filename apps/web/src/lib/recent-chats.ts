/**
 * Recent-chats history helpers (Farhan's UX request A) over the real
 * `GET /api/chats` route. Titles/previews are real bounded plain text from
 * stored messages — nothing here fabricates history: legacy chats surface
 * `lastActivityAt: null`, rendered as an honest "no timestamp" label.
 */

import { isAgentSlug, buildChatUrl, type WebAgentSlug } from './agents';
import { isSafeChatId } from './api';

/** Window event the chat dispatches when a generation settles, so the shell
 *  history can refresh (same real data — never localStorage). */
export const CHATS_CHANGED_EVENT = 'workforce:chats-changed';
export const RECENT_CHATS_DEFAULT_LIMIT = 20;
export const RECENT_CHATS_MAX_LIMIT = 50;

export interface RecentChat {
  chatId: string;
  agent: WebAgentSlug;
  title: string;
  preview: string;
  messageCount: number;
  lastActivityAt: string | null;
}

export type RecentChatsResult =
  | { ok: true; chats: ReadonlyArray<RecentChat> }
  | { ok: false; error: string; status: number };

/** Fixed, safe labels — never internals, never a forged list. */
export const RECENT_CHATS_MAP_ERROR = 'The recent-chats list could not be read.';
export const RECENT_CHATS_UNREACHABLE = 'The recent-chats service is unreachable right now.';
export const RECENT_CHAT_UNTITLED = 'Untitled chat';

export function recentChatsEndpoint(apiBaseUrl: string, limit: number = RECENT_CHATS_DEFAULT_LIMIT): string {
  const bounded =
    Number.isInteger(limit) && limit > 0
      ? Math.min(limit, RECENT_CHATS_MAX_LIMIT)
      : RECENT_CHATS_DEFAULT_LIMIT;
  return `${apiBaseUrl}/api/chats?limit=${bounded}`;
}

function boundedPlain(value: unknown, maxLength: number): string | null {
  // Non-strings fail the row; empty strings pass and render as
  // "Untitled chat" (title) or are hidden (preview) upstream.
  if (typeof value !== 'string') return null;
  return sliceSafe(value.trim(), maxLength);
}

/**
 * Length cap that never splits an astral (surrogate-pair) code point: a
 * UTF-16 slice whose last unit is a lone HIGH surrogate retreats one unit so
 * the boundary keeps pairs intact and never emits a broken character.
 */
function sliceSafe(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 0) return '';
  let end = maxLength;
  if (value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) {
    // High surrogate at the cut: its low half was cut away — retreat.
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Structural, safe mapping of the wire payload. Each malformed row fails the
 * whole list with a fixed safe error — a partial list could quietly drop or
 * fake content, so it never ships.
 */
export function mapRecentChats(payload: unknown): RecentChatsResult {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: RECENT_CHATS_MAP_ERROR, status: 502 };
  }
  const chats = (payload as Record<string, unknown>)['chats'];
  if (!Array.isArray(chats)) {
    return { ok: false, error: RECENT_CHATS_MAP_ERROR, status: 502 };
  }
  const mapped: RecentChat[] = [];
  for (const row of chats) {
    if (row === null || typeof row !== 'object') {
      return { ok: false, error: RECENT_CHATS_MAP_ERROR, status: 502 };
    }
    const record = row as Record<string, unknown>;
    const chatId = typeof record['chatId'] === 'string' ? record['chatId'] : '';
    const agentRaw = typeof record['agent'] === 'string' ? record['agent'] : '';
    const title = boundedPlain(record['title'], 200);
    const preview = boundedPlain(record['preview'], 300);
    const countRaw = record['messageCount'];
    const messageCount = typeof countRaw === 'number' && Number.isFinite(countRaw) && countRaw >= 0 ? Math.trunc(countRaw) : null;
    const lastActivityAt =
      typeof record['lastActivityAt'] === 'string' && !Number.isNaN(Date.parse(record['lastActivityAt']))
        ? (record['lastActivityAt'] as string)
        : null;
    if (
      !isSafeChatId(chatId) ||
      !isAgentSlug(agentRaw) ||
      title === null ||
      preview === null ||
      messageCount === null
    ) {
      return { ok: false, error: RECENT_CHATS_MAP_ERROR, status: 502 };
    }
    mapped.push({
      chatId,
      agent: agentRaw as WebAgentSlug,
      title: title === '' ? RECENT_CHAT_UNTITLED : title,
      preview,
      messageCount,
      lastActivityAt,
    });
  }
  return { ok: true, chats: mapped };
}

export async function fetchRecentChats(options: {
  apiBaseUrl: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<RecentChatsResult> {
  const url = recentChatsEndpoint(options.apiBaseUrl, options.limit);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: options.signal,
    });
    if (response.status === 400 || response.status === 503) {
      // Fixed API contract: fixed safe copy, never internals.
      return { ok: false, error: RECENT_CHATS_MAP_ERROR, status: response.status };
    }
    if (!response.ok) {
      return { ok: false, error: RECENT_CHATS_MAP_ERROR, status: response.status };
    }
    return mapRecentChats(await response.json());
  } catch {
    return { ok: false, error: RECENT_CHATS_UNREACHABLE, status: 0 };
  }
}

/** Canonical chat URL for a history row (agent + chat id; mode default). */
export function recentChatHref(chat: RecentChat): string {
  return buildChatUrl(chat.chatId, { agent: chat.agent });
}

/**
 * Current-row detection for the active highlight: matches the canonical
 * agent-scoped path regardless of `?mode=` (mode never changes the history).
 */
export function isCurrentRecentChat(pathname: string, chat: RecentChat): boolean {
  const match = /^\/agents\/([^/]+)\/chat\/([^/?]+)/.exec(pathname);
  if (match === null) return false;
  let slug = match[1];
  let id = match[2];
  try {
    slug = decodeURIComponent(slug);
    id = decodeURIComponent(id);
  } catch {
    // Keep the raw segments; they still cannot equal the mapped values.
  }
  return slug === chat.agent && id === chat.chatId;
}

/** Bounded absolute stamp from a stored ISO instant; null for legacy rows. */
export function formatRecentChatStamp(lastActivityAt: string | null): string | null {
  if (lastActivityAt === null) return null;
  const date = new Date(lastActivityAt);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * One honest meta line per row: singular/plural count and, for `null`
 * timestamps, the explicit saved/legacy label — nothing invented.
 */
export function formatRecentChatMeta(chat: RecentChat): string {
  const count = `${chat.messageCount} message${chat.messageCount === 1 ? '' : 's'}`;
  const stamp = formatRecentChatStamp(chat.lastActivityAt);
  return stamp === null ? `${count} · saved chat, no timestamp` : `${count} · ${stamp}`;
}

/** Accessible helper that tells the truth about how this list behaves. */
export const RECENT_CHATS_HINT =
  'Live history from this workspace. Starting a new chat never deletes anything — every sent message updates this list.';
