/**
 * Shared, pure chat-summary extraction for the recent-chat history API
 * (`GET /api/chats`, Phase 6 UX): bounded title/preview extraction, roster-
 * safe key/member parsing, and deterministic ordering. Both the Redis store
 * and the in-memory mirror consume this module so their summaries are
 * contract-identical.
 *
 * Data-discipline encoded here:
 * - Only `text` parts of `user`/`assistant` messages count as "visible text";
 *   tool parts, step markers, and unknown part shapes are ignored, so no tool
 *   payload ever lands in a title or preview.
 * - Titles come from the FIRST user message's visible text; previews from the
 *   NEWEST user/assistant message with visible text (an assistant message with
 *   only tool parts is skipped, walking to the earlier user text).
 * - Both strings are whitespace-collapsed and bounded in characters, with a
 *   fixed fallback when nothing usable exists.
 * - Every parse on this path is LENIENT: a corrupt/garbage stored entry is
 *   skipped, never thrown. Strict corruption → 503 remains the
 *   `loadMessages` contract (generation correctness); a read-only listing
 *   must degrade, not fail.
 * - Legacy chats (created before the activity index existed) surface with
 *   `lastActivityAt: null`. Timestamps are NEVER fabricated.
 */
import type { ChatMetadata, ChatMetadataPatch, ChatSummary } from './types.js';
import { clientIdSchema, isKnownSlug } from '../validation.js';

export const RECENT_CHATS_LIMIT_DEFAULT = 20;
export const RECENT_CHATS_LIMIT_MAX = 50;

/** Character bounds for the sidebar strings. */
export const TITLE_CHAR_LIMIT = 80;
export const PREVIEW_CHAR_LIMIT = 80;

/** Fixed fallbacks — never fabricated content, never blank strings. */
export const FALLBACK_TITLE = '(no title)';
export const FALLBACK_PREVIEW = '(no preview)';

/** Head entries scanned for the title (the first user text in practice). */
export const TITLE_HEAD_WINDOW = 4;
/** Tail entries scanned for the preview (newest visible text). */
export const PREVIEW_TAIL_WINDOW = 8;

/** Ellipsis appended to a truncated title/preview. */
const ELLIPSIS = '…';

/**
 * Cuts a collapsed string to the bound, appending the ellipsis when cut.
 * Astral-plane characters (emoji, CJK ext-B, …) are UTF-16 surrogate PAIRS:
 * when the cut boundary lands between the pair's two units, the slice is
 * retreated by ONE code unit so the ellipsis is appended after a whole
 * character and the split high surrogate never ships. The visible bound and
 * the fallbacks stay exactly as documented (the retreat never applies to
 * uncut strings).
 */
function bounded(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const slice = text.slice(0, limit);
  const last = limit > 0 ? slice.charCodeAt(limit - 1) : -1;
  // A trailing HIGH surrogate means its LOW partner sits just outside the
  // slice: the pair straddles the boundary.
  if (last >= 0xd800 && last <= 0xdbff) {
    return `${slice.slice(0, limit - 1)}${ELLIPSIS}`;
  }
  return `${slice}${ELLIPSIS}`;
}

/**
 * Bounds the `limit` argument defensively: non-finite/non-positive values
 * fall back to the default, everything else truncates into [1, MAX]. The
 * route validates strictly (400); this clamp is store-layer defense in depth
 * so a programmatic caller can never blow the read budget.
 */
export function clampRecentChatsLimit(limit: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    return Math.min(RECENT_CHATS_LIMIT_DEFAULT, RECENT_CHATS_LIMIT_MAX);
  }
  return Math.min(Math.floor(limit), RECENT_CHATS_LIMIT_MAX);
}

/**
 * Joins the visible text of a message's `text` parts, whitespace-collapsed
 * and trimmed. Returns `null` when the message has no visible text (unknown
 * shape, non-user/assistant role, or only tool/step parts).
 */
export function visibleTextOf(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const message = entry as { role?: unknown; parts?: unknown };
  if ((message.role !== 'user' && message.role !== 'assistant') || !Array.isArray(message.parts)) {
    return null;
  }
  const pieces: string[] = [];
  for (const part of message.parts) {
    if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) {
        pieces.push(text);
      }
    }
  }
  if (pieces.length === 0) {
    return null;
  }
  const joined = pieces.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > 0 ? joined : null;
}

/** First user text among the entries (oldest first), bounded. */
export function extractChatTitle(entries: readonly unknown[]): string {
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object' && (entry as { role?: unknown }).role === 'user') {
      const text = visibleTextOf(entry);
      if (text !== null) {
        return bounded(text, TITLE_CHAR_LIMIT);
      }
    }
  }
  return FALLBACK_TITLE;
}

/** Newest user/assistant visible text among the entries (tail first), bounded. */
export function extractChatPreview(entries: readonly unknown[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const text = visibleTextOf(entries[index]);
    if (text !== null) {
      return bounded(text, PREVIEW_CHAR_LIMIT);
    }
  }
  return FALLBACK_PREVIEW;
}

/**
 * Parses raw stored entries leniently: JSON objects survive, everything else
 * (unparsable JSON, arrays, primitives, non-strings) is skipped. A skipped
 * entry keeps `messageCount` honest (it counts STORED entries) while never
 * leaking garbage into a summary.
 */
export function parseRawEntriesLeniently(entries: readonly unknown[]): unknown[] {
  const parsed: unknown[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      continue;
    }
    try {
      const value = JSON.parse(entry) as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        parsed.push(value);
      }
    } catch {
      // Lenient: corrupt entries are skipped on the summary path only.
    }
  }
  return parsed;
}

/**
 * Assembles one {@link ChatSummary} from bounded head/tail entries. The
 * `slug`/`chatId` pair must already be roster/safe validated by the caller.
 */
export function buildChatSummary(input: {
  slug: string;
  chatId: string;
  messageCount: number;
  titleEntries: readonly unknown[];
  previewEntries: readonly unknown[];
  lastActivityAt: string | null;
  metadata?: ChatMetadata;
}): ChatSummary {
  return {
    chatId: input.chatId,
    agent: input.slug,
    title: input.metadata?.title ?? extractChatTitle(input.titleEntries),
    preview: extractChatPreview(input.previewEntries),
    messageCount: input.messageCount,
    lastActivityAt: input.lastActivityAt,
    pinned: input.metadata?.pinned ?? false,
    archived: input.metadata?.archived ?? false,
  };
}

// ---------------------------------------------------------------------------
// Chat metadata (pre-Phase 6 sidebar actions): pure validation + ordering
// ---------------------------------------------------------------------------

/** Max custom title length (Unicode-safe: counts CODE POINTS, not UTF-16). */
export const CHAT_TITLE_MAX_CHARS = 80;

/** Normalized patch (≥1 field, Unicode-safe title ≤80 code points). */
export interface ParsedChatMetadataPatch {
  readonly title?: string | null;
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

/**
 * Strict patch validation at the trust edge. `null`/empty/whitespace title
 * CLEARS the custom title (normalized to null); a non-empty title trims and
 * accepts 1..80 code points. Wrong types / unknown semantics are the
 * caller's (zod) responsibility — this validates VALUE shape.
 */
export function parseChatMetadataPatch(patch: ChatMetadataPatch): ParsedChatMetadataPatch | null {
  let sawAny = false;
  const parsed: { title?: string | null; pinned?: boolean; archived?: boolean } = {};
  if (patch.title !== undefined) {
    if (patch.title === null || typeof patch.title === 'string') {
      if (typeof patch.title === 'string') {
        const trimmed = patch.title.trim();
        if (trimmed.length === 0) {
          parsed.title = null;
        } else if ([...trimmed].length <= CHAT_TITLE_MAX_CHARS) {
          parsed.title = trimmed;
        } else {
          return null;
        }
      } else {
        parsed.title = null;
      }
      sawAny = true;
    } else {
      return null;
    }
  }
  if (patch.pinned !== undefined) {
    if (typeof patch.pinned !== 'boolean') {
      return null;
    }
    parsed.pinned = patch.pinned;
    sawAny = true;
  }
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== 'boolean') {
      return null;
    }
    parsed.archived = patch.archived;
    sawAny = true;
  }
  return sawAny ? parsed : null;
}

/** Applies a normalized patch onto current metadata (pure). */
export function applyChatMetadataPatch(current: ChatMetadata, patch: ParsedChatMetadataPatch): ChatMetadata {
  return {
    title: patch.title !== undefined ? patch.title : current.title,
    pinned: patch.pinned !== undefined ? patch.pinned : current.pinned,
    archived: patch.archived !== undefined ? patch.archived : current.archived,
  };
}

export const DEFAULT_CHAT_METADATA: ChatMetadata = { title: null, pinned: false, archived: false };

/**
 * Sidebar presentation: pinned chats FIRST (their existing relative order is
 * preserved), then the rest in the SAME relative order the caller produced
 * (newest-activity / deterministic). `includeArchived=false` drops archived
 * chats entirely.
 */
export function orderChatSummaries(
  summaries: readonly ChatSummary[],
  options: { includeArchived: boolean },
): ChatSummary[] {
  const visible = options.includeArchived ? [...summaries] : summaries.filter((chat) => chat.archived === false);
  const pinned = visible.filter((chat) => chat.pinned === true);
  const rest = visible.filter((chat) => chat.pinned !== true);
  return [...pinned, ...rest];
}

/**
 * Parses an index member `${slug}:${chatId}` against the agent roster and the
 * safe chat-id alphabet (the SAME validation the chat routes apply). Returns
 * `null` for anything else — hand-planted or foreign keys are skipped
 * deterministically, never parsed loosely. The member is owner-independent:
 * the owner namespaces the whole sorted set (per-owner index key), so two
 * users with the same slug+chatId never share one member space.
 */
export function parseChatIndexMember(member: string): { slug: string; chatId: string } | null {
  if (typeof member !== 'string') {
    return null;
  }
  const colon = member.indexOf(':');
  if (colon === -1) {
    return null;
  }
  const slug = member.slice(0, colon);
  const chatId = member.slice(colon + 1);
  if (!isKnownSlug(slug) || !clientIdSchema.safeParse(chatId).success) {
    return null;
  }
  return { slug, chatId };
}

const CHAT_OWNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Parses a Redis messages-list key
 * `${keyPrefix}:chat:{ownerId}:{slug}:{chatId}:messages` with exactly the
 * same roster/safe-id discipline as {@link parseChatIndexMember}, plus the
 * REQUIRED owner segment (Better Auth `User.id` alphabet). Legacy
 * pre-authentication keys (`${keyPrefix}:chat:{slug}:{chatId}:messages`)
 * have no owner segment and ALWAYS parse to `null`, so the bounded legacy
 * discovery can never surface them to an authenticated per-owner list.
 */
export function parseOwnerChatMessagesKey(
  key: string,
  keyPrefix: string,
): { ownerId: string; slug: string; chatId: string } | null {
  if (typeof key !== 'string') {
    return null;
  }
  const middlePrefix = `${keyPrefix}:chat:`;
  const suffix = ':messages';
  if (!key.startsWith(middlePrefix) || !key.endsWith(suffix) || key.length <= middlePrefix.length + suffix.length) {
    return null;
  }
  const member = key.slice(middlePrefix.length, key.length - suffix.length);
  // `{ownerId}:{slug}:{chatId}` — the owner segment never contains a colon
  // (same safe alphabet as chat ids), so the FIRST colon is its delimiter.
  const colon = member.indexOf(':');
  if (colon === -1) {
    return null;
  }
  const ownerId = member.slice(0, colon);
  if (!CHAT_OWNER_ID_PATTERN.test(ownerId)) {
    return null;
  }
  const rest = parseChatIndexMember(member.slice(colon + 1));
  if (rest === null) {
    return null;
  }
  return { ownerId, slug: rest.slug, chatId: rest.chatId };
}

/** Deterministic legacy order key: `${agent}:${chatId}` ascending (per owner). */
export function legacyOrderKey(ref: { slug: string; chatId: string }): string {
  return `${ref.slug}:${ref.chatId}`;
}

/** Index member for a chat ref (identical to the Redis sorted-set member). */
export function chatIndexMember(ref: { slug: string; chatId: string }): string {
  return `${ref.slug}:${ref.chatId}`;
}

/**
 * Per-owner activity index key: each Better Auth user gets an OWN ZSET
 * (`${prefix}:chat-index:{ownerId}`), so legacy global index keys
 * (`${prefix}:chat-index`, pre-authentication) are structurally unreachable
 * from every new read.
 */
export function chatIndexKeyFor(keyPrefix: string, ownerId: string): string {
  if (typeof ownerId !== 'string' || !CHAT_OWNER_ID_PATTERN.test(ownerId)) {
    throw new Error('chat index key requires a valid owner id');
  }
  return `${keyPrefix}:chat-index:${ownerId}`;
}

/**
 * The sorted-set ordering both stores mirror: activity score DESC, and for
 * equal scores the member string DESC (Redis stores equal scores
 * lexicographically ascending, so ZRANGE … REV returns them descending).
 */
export function compareIndexEntriesDesc(a: { member: string; score: number }, b: { member: string; score: number }): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.member === b.member) {
    return 0;
  }
  return a.member < b.member ? 1 : -1;
}

/** Turns an index score (epoch ms) into an ISO-8601 string. */
export function scoreToIso(score: number): string {
  return new Date(score).toISOString();
}

// ---------------------------------------------------------------------------
// Chat mutation helpers (delete/branch/rewind) — operate on RAW entries
// ---------------------------------------------------------------------------

/**
 * Finds the index of the LAST stored entry whose parsed `id` equals
 * `messageId` (ids are unique; newest-last wins by construction), or `null`
 * when the id is absent. Operates on raw JSON strings WITHOUT
 * re-serialization — branch/rewind then slice raw bytes directly.
 */
export function findMessageIndexById(entries: readonly string[], messageId: string): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry);
    } catch {
      continue; // corrupt entry: never matches (strict corruption is loadMessages' contract)
    }
    if (parsed !== null && typeof parsed === 'object' && (parsed as { id?: unknown }).id === messageId) {
      return index;
    }
  }
  return null;
}

/**
 * The message ids of the USER entries in `entries` (order preserved) —
 * exactly the set whose message-scoped idempotency keys
 * (`{keyPrefix}:idempotency:{owner}:{slug}:{chatId}:{chatId}:{messageId}`)
 * may be deleted on rewind. Corrupt entries contribute nothing.
 */
export function userMessageIdsOf(entries: readonly string[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry);
    } catch {
      continue;
    }
    if (
      parsed !== null && typeof parsed === 'object' &&
      (parsed as { role?: unknown }).role === 'user' &&
      typeof (parsed as { id?: unknown }).id === 'string' &&
      (parsed as { id: string }).id.length > 0
    ) {
      ids.push((parsed as { id: string }).id);
    }
  }
  return ids;
}
