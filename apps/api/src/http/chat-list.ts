/**
 * Recent-chat history route for the sidebar (`GET /api/chats?limit=N`).
 *
 * Contract (Phase 6 UX):
 * - `limit`: optional integer, default {@link RECENT_CHATS_LIMIT_DEFAULT},
 *   hard max {@link RECENT_CHATS_LIMIT_MAX}; ANY other value (non-numeric,
 *   0, negative, fractional, oversized, `?limit=`, `?limit=a&limit=b`) is a
 *   fixed safe 400 — never an echo of the input.
 * - `includeArchived`: optional strict boolean query; only `true`/`false`
 *   (case-insensitive) are accepted — absent or `false` preserve the normal
 *   ACTIVE list (archived chats excluded), junk values are a fixed safe 400.
 * - Response `200 { chats: ChatSummary[] }` with `Cache-Control: no-store`:
 *   identity + bounded title/preview + message count + activity timestamp +
 *   `pinned`/`archived` flags (pre-Phase 6 sidebar actions) only. No message
 *   contents beyond those bounds, no tool payloads, no provider details.
 * - Indexed chats come newest-activity-first; pinned chats are listed FIRST
 *   (relative order preserved); legacy (pre-index) chats are
 *   deterministically ordered afterward with `lastActivityAt: null`.
 * - Owner-scoped: the resolved owner namespaces the whole read — another
 *   user's chats (and pre-auth ownerless legacy chats) are unreachable.
 * - Store (Redis) failures are a safe 503 — without Redis the exact sidebar
 *   set cannot be honored, matching every other chat route (ADR-005).
 * - CORS is the app-wide middleware; authentication is the app-wide owner
 *   middleware (pre-Phase 6).
 */
import type { Request, RequestHandler, Response } from 'express';
import type { SafeLogger } from '../logging.js';
import type { ChatStore } from '../store/types.js';
import { RECENT_CHATS_LIMIT_DEFAULT, RECENT_CHATS_LIMIT_MAX } from '../store/chat-history.js';
import { ownerOf } from '../auth/owner.js';
import { sendJsonError } from './adapter.js';

/** Fixed safe validation message; the input value is never echoed. */
const LIMIT_ERROR_MESSAGE = `limit must be an integer between 1 and ${String(RECENT_CHATS_LIMIT_MAX)}.`;
/** Fixed safe validation message for the archival toggle. */
const INCLUDE_ARCHIVED_ERROR_MESSAGE = 'includeArchived must be exactly `true` or `false`.';

/**
 * Accepts `undefined` (→ default) and plain digit strings validated against
 * `1..MAX` in one place. Non-strings (repeated query params resolve to an
 * array in Express) and anything else are rejected.
 */
function parseChatListLimit(raw: unknown): number | null {
  if (raw === undefined) {
    return RECENT_CHATS_LIMIT_DEFAULT;
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > RECENT_CHATS_LIMIT_MAX) {
    return null;
  }
  return value;
}

/** Strict `true`/`false` (case-insensitive); absent → false; else null. */
function parseIncludeArchived(raw: unknown): boolean | null {
  if (raw === undefined) {
    return false;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const lowered = raw.toLowerCase();
  if (lowered === 'true') {
    return true;
  }
  if (lowered === 'false') {
    return false;
  }
  return null;
}

export interface ChatListRouteDeps {
  store: ChatStore;
  logger: SafeLogger;
}

export function createChatListRoute(deps: ChatListRouteDeps): { listChats: RequestHandler } {
  const { store, logger } = deps;

  const listChats: RequestHandler = async (req: Request, res: Response) => {
    const owner = ownerOf(res);
    if (owner === null) {
      sendJsonError(res, 401, 'Authentication required.');
      return;
    }
    const limit = parseChatListLimit(req.query['limit']);
    if (limit === null) {
      sendJsonError(res, 400, LIMIT_ERROR_MESSAGE);
      return;
    }
    const includeArchived = parseIncludeArchived(req.query['includeArchived']);
    if (includeArchived === null) {
      sendJsonError(res, 400, INCLUDE_ARCHIVED_ERROR_MESSAGE);
      return;
    }
    let chats;
    try {
      chats = await store.listRecentChats(owner.userId, limit, includeArchived);
    } catch (error) {
      // Cause logged with context only; the client gets a fixed safe 503.
      logger.error('chat-list-store', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ chats }));
  };

  return { listChats };
}
