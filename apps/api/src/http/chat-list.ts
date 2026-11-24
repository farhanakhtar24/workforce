/**
 * Recent-chat history route for the sidebar (`GET /api/chats?limit=N`).
 *
 * Contract (Phase 6 UX):
 * - `limit`: optional integer, default {@link RECENT_CHATS_LIMIT_DEFAULT},
 *   hard max {@link RECENT_CHATS_LIMIT_MAX}; ANY other value (non-numeric,
 *   0, negative, fractional, oversized, `?limit=`, `?limit=a&limit=b`) is a
 *   fixed safe 400 — never an echo of the input.
 * - Response `200 { chats: ChatSummary[] }` with `Cache-Control: no-store`:
 *   identity + bounded title/preview + message count + activity timestamp
 *   only. No message contents beyond those bounds, no tool payloads, no
 *   provider details.
 * - Indexed chats come newest-activity-first; legacy (pre-index) chats are
 *   deterministically ordered afterward with `lastActivityAt: null`.
 * - Store (Redis) failures are a safe 503 — without Redis the exact sidebar
 *   set cannot be honored, matching every other chat route (ADR-005).
 * - No new auth surface in this local phase; CORS is the app-wide middleware.
 */
import type { Request, RequestHandler, Response } from 'express';
import type { SafeLogger } from '../logging.js';
import type { ChatStore } from '../store/types.js';
import { RECENT_CHATS_LIMIT_DEFAULT, RECENT_CHATS_LIMIT_MAX } from '../store/chat-history.js';
import { sendJsonError } from './adapter.js';

/** Fixed safe validation message; the input value is never echoed. */
const LIMIT_ERROR_MESSAGE = `limit must be an integer between 1 and ${String(RECENT_CHATS_LIMIT_MAX)}.`;

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

export interface ChatListRouteDeps {
  store: ChatStore;
  logger: SafeLogger;
}

export function createChatListRoute(deps: ChatListRouteDeps): { listChats: RequestHandler } {
  const { store, logger } = deps;

  const listChats: RequestHandler = async (req: Request, res: Response) => {
    const limit = parseChatListLimit(req.query['limit']);
    if (limit === null) {
      sendJsonError(res, 400, LIMIT_ERROR_MESSAGE);
      return;
    }
    let chats;
    try {
      chats = await store.listRecentChats(limit);
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
