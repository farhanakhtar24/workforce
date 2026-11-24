/**
 * Redis-backed `ChatStore` (ADR-005) with **append-only** message persistence.
 *
 * `RedisLike` is a deliberately narrow subset of the node-redis client so
 * tests can substitute an in-process stand-in implementing Redis semantics
 * without a live Redis:
 * - `get` / `lrange` / `llen` / `del` / `rpush`
 * - `zadd` / `zrange` (withscores) / bounded `scan` (read-only discovery)
 * - `set` with the same options shape `resumable-stream`'s Publisher uses:
 *   `{ EX?: number; NX?: boolean }` (node-redis v6 accepts it; `expiration` /
 *   `condition` exist but `EX`/`NX` remain supported for clients like this one).
 * - `eval(script, { keys, arguments })` for the atomic compare-and-delete and
 *   the ask_user byte-CAS.
 *
 * Key layout (all namespaced under `workforce:phase2:`):
 * - `workforce:phase2:chat:{slug}:{chatId}:messages`       — Redis LIST, one JSON
 *   UIMessage per entry (RPUSH newest to tail, LRANGE oldest-first, no TTL:
 *   durable). Append-only so concurrent turns can never delete each other's
 *   messages.
 * - `workforce:phase2:chat:{slug}:{chatId}:active-stream`  — active stream ID,
 *   EX 86400 (24h, aligned with the resumable-stream sentinel), cleared on
 *   completion.
 * - `workforce:phase2:idempotency:{slug}:{chatId}:{key}`   — SET NX, EX 900s exactly
 * - `workforce:phase2:chat-index`                          — global ZSET,
 *   member `${slug}:${chatId}` (safe alphabet verified on parse), score =
 *   epoch-ms wall-clock activity of the latest append. Re-scored in the SAME
 *   Lua script as the RPUSH so an index failure can never split a message
 *   write. Pre-index ("legacy") chats are recovered by READ-ONLY bounded
 *   SCAN discovery; the index is never repaired or fabricated by a read.
 */
import { StoreUnavailableError } from '../errors.js';
import type { UIMessage } from 'ai';
import type { AskUserAnswerStatus, ChatRef, ChatStore, ChatSummary } from './types.js';
import { applyAskUserAnswer } from './ask-user.js';
import {
  PREVIEW_TAIL_WINDOW,
  TITLE_HEAD_WINDOW,
  buildChatSummary,
  chatIndexMember,
  clampRecentChatsLimit,
  legacyOrderKey,
  parseChatIndexMember,
  parseChatMessagesKey,
  parseRawEntriesLeniently,
  scoreToIso,
} from './chat-history.js';

export const REDIS_KEY_PREFIX = 'workforce:phase2';

/** Active-stream marker TTL: aligned with the resumable-stream sentinel (24h). */
export const ACTIVE_STREAM_TTL_SECONDS = 86_400;

/**
 * Global chat activity index. A single ZSET: member `${slug}:${chatId}`,
 * score = epoch-ms of the chat's latest append. Both user messages and
 * assistant completions go through `appendMessage`, which re-scores the
 * member on every write, so the sidebar ordering is exact for FUTURE writes.
 */
export const CHAT_INDEX_KEY = `${REDIS_KEY_PREFIX}:chat-index`;

/**
 * Deterministic bounded legacy-discovery budget (documented behavior):
 * - SCAN with MATCH `${REDIS_KEY_PREFIX}:chat:*:messages`, COUNT hint of
 *   {@link CHAT_SCAN_COUNT_HINT},
 * - at most {@link CHAT_SCAN_MAX_ITERATIONS} round trips and at most
 *   {@link CHAT_DISCOVERY_MAX_KEYS} DISTINCT chat keys collected,
 * - when a budget stops the SCAN before cursor `0`, the legacy chats beyond
 *   it are simply not discovered during this call (SCAN's key order is
 *   bucket order, stable per server state). Discovery is strictly read-only:
 *   no FLUSH, no KEYS, no writes, no deletes.
 */
export const CHAT_SCAN_COUNT_HINT = 100;
export const CHAT_SCAN_MAX_ITERATIONS = 25;
export const CHAT_DISCOVERY_MAX_KEYS = 256;

/**
 * Extra index entries read beyond `limit` so that stale members (chats whose
 * message list was deleted outside the API, e.g. by ops) cannot steal slots
 * from live chats within the top window before they are skipped. The final
 * slice always stays within `limit`.
 */
export const CHAT_INDEX_READ_SLACK = 16;

/**
 * Atomic append + activity index (ONE Lua script, never two round trips):
 * refuses (returns -1) WITHOUT touching anything when the index key holds a
 * non-zset value — a corrupt index can never half-write a message list — and
 * otherwise RPUSHes the newest message entry and re-scores the chat's index
 * member in a single script execution.
 *
 * The TYPE reply is normalized for BOTH protocols: under RESP2
 * `redis.call('TYPE', …)` in Lua returns the plain status string
 * (`'none'`/`'zset'`), under RESP3 the status reply converts to a Lua map
 * `{ ok = 'none' }` — verified against node-redis v6.3.1 (RESP3 default)
 * and Redis 7.
 */
export const APPEND_MESSAGE_WITH_INDEX_LUA = `
local indexType = redis.call('TYPE', KEYS[2])
if type(indexType) == 'table' then
  indexType = indexType['ok']
end
if indexType == nil then
  indexType = 'none'
end
if indexType ~= 'none' and indexType ~= 'zset' then
  return -1
end
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
return 1
`.trim();

/** Atomic delete only when the stored active stream matches (Lua compare-and-del). */
export const CLEAR_ACTIVE_STREAM_LUA = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`.trim();

/**
 * HITL resume (Phase 4, byte-exact CAS — NO cjson anywhere): the Lua script
 * compares the current entry (LINDEX) against the EXACT original raw JSON
 * captured by the Node side and LSETs the replacement only on an exact match.
 * All JSON parsing/patching happens in Node (`./ask-user.js`) so co-located
 * data (`options: []`, large integers, key order) is preserved byte-for-byte;
 * cjson decode/encode round-trips corrupted both.
 */
export const ANSWER_PENDING_ASK_USER_LUA = `
local current = redis.call('LINDEX', KEYS[1], tonumber(ARGV[1]))
if current == ARGV[2] then
  redis.call('LSET', KEYS[1], tonumber(ARGV[1]), ARGV[3])
  return 1
end
return 0
`.trim();

/**
 * Subset of the node-redis client used by this store; structural, so a real
 * `RedisClientType` satisfies it directly. NOTE: node-redis v4+ exposes list
 * commands camelCase — `rPush`/`lRange`/`lLen`, NEVER lowercase `rpush`/
 * `lrange`/`llen` (calling the lowercase names on the real client raises
 * "not a function", which previously surfaced as a safe-but-wrong 503).
 * Sorted-set commands follow the same camelCase rule: `zAdd`,
 * `zRangeWithScores`. Method signatures verified against node-redis v6.3.1
 * sources (`@redis/client/dist/lib/commands/{SCAN,ZADD,ZRANGE,EVAL}.d.ts`).
 */
export interface RedisLike {
  get(key: string): Promise<string | null | unknown>;
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<unknown>;
  del(key: string): Promise<number | unknown>;
  /** Redis RPUSH: append to the tail of a list, creating it when missing. */
  rPush(key: string, value: string): Promise<number | unknown>;
  /** Redis LRANGE: list entries oldest-first between inclusive bounds. */
  lRange(key: string, start: number, stop: number): Promise<string[] | unknown>;
  /** Redis LLEN: list length. */
  lLen(key: string): Promise<number | unknown>;
  /** Redis ZSCORE: the score of one member, or `null` when absent. */
  zScore(key: string, member: string): Promise<number | string | null | unknown>;
  /** Redis ZADD: add one or more (value, score) members to a sorted set. */
  zAdd(key: string, members: Array<{ value: string; score: number }>): Promise<number | unknown>;
  /**
   * Redis ZRANGE key min max WITHSCORES: entries as `{ value, score }`
   * oldest-first; `REV` traverses newest-first (with BYSCORE the args are
   * `('+inf', '-inf')`), and `LIMIT` paginates that traversal (Redis 6.2+
   * semantics; LIMIT is ONLY valid together with BYSCORE/BYLEX).
   */
  zRangeWithScores(
    key: string,
    min: number | string,
    max: number | string,
    options?: { BY?: 'SCORE' | 'LEX'; REV?: boolean; LIMIT?: { offset: number; count: number } },
  ): Promise<Array<{ value: string; score: number }> | unknown>;
  /**
   * Redis SCAN: bounded cursor iteration over the whole keyspace with
   * MATCH/COUNT; node-redis returns `{ cursor, keys }`.
   */
  scan(
    cursor: number | string,
    options?: { MATCH?: string; COUNT?: number },
  ): Promise<{ cursor: string | number; keys: string[] } | unknown>;
  eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown>;
}

function messagesKey(chat: ChatRef): string {
  return `${REDIS_KEY_PREFIX}:chat:${chat.slug}:${chat.chatId}:messages`;
}
function activeStreamKey(chat: ChatRef): string {
  return `${REDIS_KEY_PREFIX}:chat:${chat.slug}:${chat.chatId}:active-stream`;
}
function idempotencyKey(chat: ChatRef, key: string): string {
  return `${REDIS_KEY_PREFIX}:idempotency:${chat.slug}:${chat.chatId}:${key}`;
}

export interface RedisChatStoreOptions {
  /** Injectable epoch-ms clock (tests); default wall clock. */
  now?: () => number;
}

/** True when the reply parses to a usable list-length number. */
function isLengthReply(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads a ZSCORE reply as a usable index score (epoch ms): node-redis maps
 * RESP2/RESP3 to a number, but a string-shaped reply is accepted defensively
 * (the same shape real Redis can deliver across wire dialects). Anything
 * else — including the missing-member `null` — returns `null`, which the
 * caller then treats as "not in the index" (legacy `null` timestamp).
 * Scores ≤ 0 never fabricate a 1970 timestamp.
 */
function toIndexScore(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function createRedisChatStore(client: RedisLike, options: RedisChatStoreOptions = {}): ChatStore {
  const now = options.now ?? (() => Date.now());
  /**
   * Converts any client failure into `StoreUnavailableError`. The original
   * error object is deliberately not embedded: node-redis errors can carry
   * connection URLs or server replies, and safe handling happens at the route.
   */
  function rethrowAsUnavailable(error: unknown): never {
    if (error instanceof StoreUnavailableError) {
      throw error;
    }
    throw new StoreUnavailableError();
  }

  return {
    async loadMessages(chat: ChatRef): Promise<unknown[]> {
      try {
        const entries = await client.lRange(messagesKey(chat), 0, -1);
        if (!Array.isArray(entries)) {
          throw new StoreUnavailableError('Chat state could not be read (messages).');
        }
        // Parse every entry; one corrupt entry fails the whole read so callers
        // answer 503 instead of silently truncating the conversation.
        return entries.map((entry) => {
          if (typeof entry !== 'string') {
            throw new StoreUnavailableError('Chat state could not be read (messages).');
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(entry);
          } catch {
            throw new StoreUnavailableError('Chat state could not be read (messages).');
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new StoreUnavailableError('Chat state could not be read (messages).');
          }
          return parsed;
        });
      } catch (error) {
        rethrowAsUnavailable(error);
      }
    },

    async appendMessage(chat: ChatRef, message: UIMessage): Promise<void> {
      try {
        // ONE atomic Lua script: RPUSH of the newest entry + ZADD re-score of
        // the chat's activity-index member. A partial split (message without
        // index, or index without message) can never land from this call:
        // the script refuses up front (-1) when the index key is corrupt
        // (non-zset), and any Redis failure aborts the whole script.
        const score = Math.max(0, Math.floor(now()));
        const result = await client.eval(APPEND_MESSAGE_WITH_INDEX_LUA, {
          keys: [messagesKey(chat), CHAT_INDEX_KEY],
          arguments: [JSON.stringify(message), String(score), chatIndexMember(chat)],
        });
        if (result === -1 || result === '-1') {
          throw new StoreUnavailableError('Chat state could not be written (index).');
        }
      } catch (error) {
        rethrowAsUnavailable(error);
      }
    },

    async getActiveStreamId(chat: ChatRef): Promise<string | null> {
      try {
        const raw = await client.get(activeStreamKey(chat));
        if (raw === null || raw === undefined) {
          return null;
        }
        if (typeof raw !== 'string') {
          throw new StoreUnavailableError('Chat state could not be read (active stream).');
        }
        return raw;
      } catch (error) {
        rethrowAsUnavailable(error);
      }
    },

    async setActiveStreamId(chat: ChatRef, streamId: string): Promise<void> {
      try {
        // 24h TTL aligned with the resumable-stream sentinel: a stream that
        // never completes cannot wedge the marker forever.
        await client.set(activeStreamKey(chat), streamId, { EX: ACTIVE_STREAM_TTL_SECONDS });
      } catch (error) {
        rethrowAsUnavailable(error);
      }
    },

    async clearActiveStreamId(chat: ChatRef, streamId: string): Promise<boolean> {
      try {
        const result = await client.eval(CLEAR_ACTIVE_STREAM_LUA, {
          keys: [activeStreamKey(chat)],
          arguments: [streamId],
        });
        return result === 1 || result === '1' || result === true;
      } catch (error) {
        rethrowAsUnavailable(error);
      }
    },

    async acquireIdempotencyKey(chat: ChatRef, key: string, ttlSeconds: number): Promise<boolean> {
      try {
        const result = await client.set(idempotencyKey(chat, key), '1', { EX: ttlSeconds, NX: true });
        return result !== null;
      } catch (error) {
        rethrowAsUnavailable(error);
      }
    },

    async releaseIdempotencyKey(chat: ChatRef, key: string): Promise<void> {
      try {
        await client.del(idempotencyKey(chat, key));
      } catch (error) {
        rethrowAsUnavailable(error);
      }
    },

    async answerPendingAskUser(chat: ChatRef, assistantMessageId: string, toolCallId: string, answer: string): Promise<AskUserAnswerStatus> {
      try {
        return await applyAskUserAnswer(
          async () => {
            const entries = await client.lRange(messagesKey(chat), 0, -1);
            if (!Array.isArray(entries)) {
              throw new StoreUnavailableError('Chat state could not be read (messages).');
            }
            return entries.map((entry) => {
              if (typeof entry !== 'string') {
                throw new StoreUnavailableError('Chat state could not be read (messages).');
              }
              return entry;
            });
          },
          async (entryIndex, expectedRaw, nextRaw) => {
            const result = await client.eval(ANSWER_PENDING_ASK_USER_LUA, {
              keys: [messagesKey(chat)],
              arguments: [String(entryIndex), expectedRaw, nextRaw],
            });
            return result === 1 || result === '1' || result === true;
          },
          assistantMessageId,
          toolCallId,
          answer,
        );
      } catch (error) {
        rethrowAsUnavailable(error);
      }
    },

    async listRecentChats(limit: number): Promise<ChatSummary[]> {
      const bounded = clampRecentChatsLimit(limit);
      try {
        // ---- 1. Newest chats from the activity index. BYSCORE REV (args
        // are max→min for the reversed traversal) + LIMIT keep the read
        // bounded; the window carries extra slack so skipped stale members
        // cannot steal slots from live chats. Equal scores come back
        // member-descending (mirrored where the index is sorted in-process).
        const indexReply = await client.zRangeWithScores(CHAT_INDEX_KEY, '+inf', '-inf', {
          BY: 'SCORE',
          REV: true,
          LIMIT: { offset: 0, count: bounded + CHAT_INDEX_READ_SLACK },
        });
        if (!Array.isArray(indexReply)) {
          throw new StoreUnavailableError('Chat state could not be read (index).');
        }
        const summaries: ChatSummary[] = [];
        const indexed = new Set<string>();
        for (const { member, score } of parseChatIndexEntries(indexReply)) {
          const ref = parseChatIndexMember(member);
          if (ref === null) {
            continue; // foreign/garbage member: deterministic skip
          }
          const summary = await summarizeChatFromWindow(ref, scoreToIso(score));
          if (summary === null) {
            continue; // no stored messages (deleted/stale member): skip
          }
          indexed.add(chatIndexMember(ref));
          summaries.push(summary);
        }
        if (summaries.length >= bounded) {
          return summaries.slice(0, bounded);
        }

        // ---- 2. Legacy chats (created before the index existed, or indexed
        // chats whose member fell outside the bounded read window above):
        // bounded, strictly read-only SCAN discovery of `…:chat:*:messages`
        // keys, deterministically ordered ascending, then the remaining
        // slots are filled in that deterministic order.
        const legacyRefs = await discoverLegacyChatKeys(indexed);
        for (const ref of legacyRefs) {
          if (summaries.length >= bounded) {
            break;
          }
          const summary = await summarizeChatFromWindow(ref, null);
          if (summary === null) {
            continue;
          }
          // Index-membership verification (one bounded ZSCORE per DISCOVERED
          // candidate whose summary exists): a chat whose index member fell
          // outside the read window above is rediscovered here — it must keep
          // its REAL activity timestamp, never degrade to a fabricated-legacy
          // `null` merely because too many stale members occupied the window.
          // ONLY truly unindexed (legacy) chats end up with `null`.
          const score = toIndexScore(await client.zScore(CHAT_INDEX_KEY, chatIndexMember(ref)));
          summaries.push(score === null ? summary : { ...summary, lastActivityAt: scoreToIso(score) });
        }
        return summaries;
      } catch (error) {
        rethrowAsUnavailable(error);
      }
    },
  };

  /** Validates a ZRANGE-with-scores reply as {value, score} entries. */
  function parseChatIndexEntries(reply: unknown[]): Array<{ member: string; score: number }> {
    const parsed: Array<{ member: string; score: number }> = [];
    for (const entry of reply) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const member = (entry as { value?: unknown }).value;
      const score = (entry as { score?: unknown }).score;
      if (
        typeof member === 'string' &&
        typeof score === 'number' &&
        Number.isSafeInteger(score) &&
        score > 0
      ) {
        parsed.push({ member, score });
      }
    }
    return parsed;
  }

  /**
   * Core per-chat summary: LLEN for the count, `TITLE_HEAD_WINDOW` head
   * entries for the title and `PREVIEW_TAIL_WINDOW` tail entries for the
   * preview — bounded reads, never the whole list. Unusable LLEN (chat list
   * gone or reply shape broken) yields `null` (skip, never a fabricated
   * chat); broken LRANGE reply SHAPE yields a raw read failure (503).
   * Corrupt stored JSON inside a window is skipped leniently by the shared
   * extraction helpers.
   */
  async function summarizeChatFromWindow(ref: { slug: string; chatId: string }, lastActivityAt: string | null): Promise<ChatSummary | null> {
    const key = messagesKey(ref);
    const len = await client.lLen(key);
    if (!isLengthReply(len) || len === 0) {
      return null; // key gone / emptied: not a chat anymore
    }
    const head = await client.lRange(key, 0, Math.min(TITLE_HEAD_WINDOW, len) - 1);
    const tail = await client.lRange(key, Math.max(0, len - PREVIEW_TAIL_WINDOW), -1);
    if (!Array.isArray(head) || !Array.isArray(tail)) {
      throw new StoreUnavailableError('Chat state could not be read (messages).');
    }
    return buildChatSummary({
      slug: ref.slug,
      chatId: ref.chatId,
      messageCount: len,
      titleEntries: parseRawEntriesLeniently(head),
      previewEntries: parseRawEntriesLeniently(tail),
      lastActivityAt,
    });
  }

  /**
   * Bounded legacy discovery: SCAN (cursor + MATCH + COUNT hint) over
   * `${REDIS_KEY_PREFIX}:chat:*:messages`, capped both in round trips and in
   * distinct chat keys. Everything is filtered through
   * {@link parseChatMessagesKey} (roster slug + safe id alphabet), already-
   * indexed members are excluded, and the result is sorted ascending by
   * `${slug}:${chatId}` so the included subset is deterministic. Never
   * writes, never deletes, no FLUSH, no KEYS.
   */
  async function discoverLegacyChatKeys(indexed: Set<string>): Promise<Array<{ slug: string; chatId: string }>> {
    const found = new Map<string, { slug: string; chatId: string }>();
    let cursor: string = '0';
    let iterations = 0;
    do {
      const reply = await client.scan(cursor, {
        MATCH: `${REDIS_KEY_PREFIX}:chat:*:messages`,
        COUNT: CHAT_SCAN_COUNT_HINT,
      });
      if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
        throw new StoreUnavailableError('Chat state could not be read (discovery).');
      }
      const nextCursor = (reply as { cursor?: unknown }).cursor;
      const keys = (reply as { keys?: unknown }).keys;
      if (!Array.isArray(keys) || (typeof nextCursor !== 'string' && typeof nextCursor !== 'number')) {
        throw new StoreUnavailableError('Chat state could not be read (discovery).');
      }
      cursor = String(nextCursor);
      for (const key of keys) {
        const ref = parseChatMessagesKey(key, REDIS_KEY_PREFIX);
        if (ref === null || indexed.has(chatIndexMember(ref))) {
          continue;
        }
        found.set(legacyOrderKey(ref), ref);
        if (found.size >= CHAT_DISCOVERY_MAX_KEYS) {
          break;
        }
      }
      iterations += 1;
    } while (cursor !== '0' && iterations < CHAT_SCAN_MAX_ITERATIONS && found.size < CHAT_DISCOVERY_MAX_KEYS);
    return [...found.values()].sort((a, b) => (legacyOrderKey(a) < legacyOrderKey(b) ? -1 : legacyOrderKey(a) > legacyOrderKey(b) ? 1 : 0));
  }
}
