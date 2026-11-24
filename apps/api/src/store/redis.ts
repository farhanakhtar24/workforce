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
 * Key layout (all namespaced under `workforce:phase2:`, pre-Phase 6 auth):
 * - `workforce:phase2:chat:{ownerId}:{slug}:{chatId}:messages` — Redis LIST,
 *   one JSON UIMessage per entry (RPUSH newest to tail, LRANGE oldest-first,
 *   no TTL: durable). Append-only so concurrent turns can never delete each
 *   other's messages.
 * - `workforce:phase2:chat:{ownerId}:{slug}:{chatId}:active-stream` — active
 *   stream ID, EX 86400 (24h, aligned with the resumable-stream sentinel),
 *   cleared on completion.
 * - `workforce:phase2:idempotency:{ownerId}:{slug}:{chatId}:{key}` — SET NX,
 *   EX 900s exactly
 * - `workforce:phase2:chat-index:{ownerId}` — PER-OWNER ZSET, member
 *   `${slug}:${chatId}` (safe alphabet verified on parse), score = epoch-ms
 *   wall-clock activity of the latest append. Re-scored in the SAME Lua
 *   script as the RPUSH so an index failure can never split a message write.
 *   Pre-auth ("legacy") global keys (`…:chat:{slug}:{chatId}:*`,
 *   `…:chat-index` without the owner segment) are structurally unreachable:
 *   no new read or bounded SCAN uses a key shape without the owner segment.
 */
import { StoreUnavailableError } from '../errors.js';
import type { UIMessage } from 'ai';
import type {
  AskUserAnswerStatus,
  ChatBranchResult,
  ChatDeleteResult,
  ChatRef,
  ChatRewindResult,
  ChatStore,
  ChatSummary,
} from './types.js';
import { CHAT_OWNER_ID_PATTERN } from './types.js';
import { applyAskUserAnswer } from './ask-user.js';
import { MODEL_ID_PATTERN } from '../models/catalog.js';
import {
  PREVIEW_TAIL_WINDOW,
  TITLE_HEAD_WINDOW,
  buildChatSummary,
  chatIndexKeyFor,
  chatIndexMember,
  clampRecentChatsLimit,
  findMessageIndexById,
  legacyOrderKey,
  parseChatIndexMember,
  parseOwnerChatMessagesKey,
  parseRawEntriesLeniently,
  scoreToIso,
  userMessageIdsOf,
} from './chat-history.js';

export const REDIS_KEY_PREFIX = 'workforce:phase2';

/** Active-stream marker TTL: aligned with the resumable-stream sentinel (24h). */
export const ACTIVE_STREAM_TTL_SECONDS = 86_400;

/**
 * PER-OWNER chat activity index prefix. One ZSET per Better Auth user:
 * ``${REDIS_KEY_PREFIX}:chat-index:{ownerId}``. Both user messages and
 * assistant completions go through `appendMessage`, which re-scores the
 * member on every write, so the sidebar ordering is exact for FUTURE writes.
 * The pre-auth global ZSET (`workforce:phase2:chat-index`) is never read.
 */
export function chatIndexKey(ownerId: string): string {
  return chatIndexKeyFor(REDIS_KEY_PREFIX, ownerId);
}

/**
 * Deterministic bounded legacy-discovery budget (documented behavior):
 * - SCAN with MATCH ``{@link chatIndexKeyFor}``-sibling owner-scoped chat
 *   keys (`${REDIS_KEY_PREFIX}:chat:{ownerId}:*:messages`, COUNT hint of
 *   {@link CHAT_SCAN_COUNT_HINT}),
 * - at most {@link CHAT_SCAN_MAX_ITERATIONS} round trips and at most
 *   {@link CHAT_DISCOVERY_MAX_KEYS} DISTINCT chat keys collected,
 * - when a budget stops the SCAN before cursor `0`, the legacy chats beyond
 *   it are simply not discovered during this call (SCAN's key order is
 *   bucket order, stable per server state). Discovery is strictly read-only:
 *   no FLUSH, no KEYS, no writes, no deletes.
 *
 * "Legacy" here means pre-index chats OF THIS OWNER only: the owner segment
 * is fixed in the MATCH pattern, so pre-authentication ownerless keys can
 * never match — discovery cannot even see them.
 */
export const CHAT_SCAN_COUNT_HINT = 100;
export const CHAT_SCAN_MAX_ITERATIONS = 25;
export const CHAT_DISCOVERY_MAX_KEYS = 256;

/**
 * Bounded idempotency-key cleanup budgets for the destructive chat DELETE
 * (`{owner}:{slug}:{chatId}:*` SCAN): the keys are message-scoped per chat,
 * semantically dead once the chat is gone; they may also expire naturally
 * (TTL), so this cleanup is best-effort and never fails the delete.
 */
export const IDEMPOTENCY_SCAN_COUNT = 100;
export const IDEMPOTENCY_SCAN_MAX_ITERATIONS = 50;

/** CAS retry budget for the destructive REWIND (concurrent-append races). */
export const REWIND_CAS_ATTEMPTS = 5;

/** Normalizes a mutation-script NUMERIC reply into a stable number code. */
function toMutationCode(result: unknown): number {
  if (typeof result === 'number') {
    return result;
  }
  if (typeof result === 'string' && /^-?\d+$/.test(result)) {
    return Number(result);
  }
  if (typeof result === 'object' && result !== null && !Array.isArray(result) && 'ok' in result) {
    // RESP3 integer replies can surface as {ok: 1} maps? (defensive)
    const value = (result as { ok?: unknown }).ok;
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value)) {
      return Number(value);
    }
  }
  throw new StoreUnavailableError('Chat state could not be mutated.');
}

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
 * Owner-scoped chat DELETE (atomic): refuses while an active-stream marker
 * exists (-1: the route answers fixed 409), otherwise removes the chat's
 * message list, active-stream marker, and per-owner index member, atomically.
 * Returns 1 when messages existed (deleted), 0 when the chat had no stored
 * messages (route answers fixed 404). The type checks run BEFORE any write so
 * a WRONGTYPE index can never leave a half-deleted chat (-3 → 503).
 */
export const DELETE_CHAT_LUA = `
local listType = redis.call('TYPE', KEYS[1])
if type(listType) == 'table' then listType = listType['ok'] end
local markerType = redis.call('TYPE', KEYS[2])
if type(markerType) == 'table' then markerType = markerType['ok'] end
local indexType = redis.call('TYPE', KEYS[3])
if type(indexType) == 'table' then indexType = indexType['ok'] end
local modelType = redis.call('TYPE', KEYS[4])
if type(modelType) == 'table' then modelType = modelType['ok'] end
if (listType ~= 'none' and listType ~= 'list')
   or (markerType ~= 'none' and markerType ~= 'string')
   or (indexType ~= 'none' and indexType ~= 'zset')
   or (modelType ~= 'none' and modelType ~= 'string') then
  return -3
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return -1
end
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[4])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`.trim();

/**
 * Owner-scoped chat BRANCH (atomic): copies `entries` into a NEW/empty
 * destination WITHOUT touching the source. Refuses when the destination
 * messages list already holds entries (-1 → route fixed 409), when the
 * destination has an active-stream marker (-2 → 409), or on WRONGTYPE keys
 * (-3 → 503, before any write). Writes all copied raw entries + the
 * destination's per-owner index member in this ONE script.
 * ARGV[1] = destination index member, ARGV[2] = score, ARGV[3..] = raw entries.
 */
export const BRANCH_CHAT_LUA = `
local listType = redis.call('TYPE', KEYS[1])
if type(listType) == 'table' then listType = listType['ok'] end
local markerType = redis.call('TYPE', KEYS[3])
if type(markerType) == 'table' then markerType = markerType['ok'] end
local indexType = redis.call('TYPE', KEYS[2])
if type(indexType) == 'table' then indexType = indexType['ok'] end
local srcModelType = redis.call('TYPE', KEYS[4])
if type(srcModelType) == 'table' then srcModelType = srcModelType['ok'] end
local destModelType = redis.call('TYPE', KEYS[5])
if type(destModelType) == 'table' then destModelType = destModelType['ok'] end
if (listType ~= 'none' and listType ~= 'list')
   or (markerType ~= 'none' and markerType ~= 'string')
   or (indexType ~= 'none' and indexType ~= 'zset')
   or (srcModelType ~= 'none' and srcModelType ~= 'string')
   or (destModelType ~= 'none' and destModelType ~= 'string') then
  return -3
end
if redis.call('LLEN', KEYS[1]) > 0 then
  return -1
end
if redis.call('EXISTS', KEYS[3]) == 1 then
  return -2
end
local copied = 0
for i = 3, #ARGV do
  redis.call('RPUSH', KEYS[1], ARGV[i])
  copied = copied + 1
end
redis.call('ZADD', KEYS[2], tonumber(ARGV[2]), ARGV[1])
local srcModel = redis.call('GET', KEYS[4])
if srcModel then
  redis.call('SET', KEYS[5], srcModel)
end
return copied
`.trim();

/**
 * Owner-scoped DESTRUCTIVE chat REWIND (atomic, documented append-only
 * exception): keeps entries [0..keepLast] (inclusive) and removes the tail,
 * guarded by a byte-exact compare-and-set against concurrent appends
 * (expected LENGTH + exact tail entry + exact first-removed entry; any
 * concurrent append changes them → -2, the store retries then reports
 * 'stale'). Kept bytes are NEVER re-serialized (LTRIM only). Re-scores the
 * per-owner index member honestly (the chat was just mutated). The
 * active-stream refusal is decided by the route (409) and the type checks
 * run before any write (-3 → 503).
 * ARGV: [1]=expectedTailRaw, [2]=expectedLen, [3]=expectedFirstRemovedRaw,
 * [4]=keepLastZeroBased, [5]=score, [6]=indexMember.
 */
export const REWIND_CHAT_LUA = `
local listType = redis.call('TYPE', KEYS[1])
if type(listType) == 'table' then listType = listType['ok'] end
local indexType = redis.call('TYPE', KEYS[2])
if type(indexType) == 'table' then indexType = indexType['ok'] end
if (listType ~= 'none' and listType ~= 'list')
   or (indexType ~= 'none' and indexType ~= 'zset') then
  return -3
end
local len = redis.call('LLEN', KEYS[1])
if len ~= tonumber(ARGV[2]) then
  return -2
end
local keepLast = tonumber(ARGV[4])
if len > 0 then
  local tail = redis.call('LINDEX', KEYS[1], len - 1)
  if tail ~= ARGV[1] then
    return -2
  end
end
local firstRemoved = keepLast + 1
if firstRemoved <= len - 1 then
  local first = redis.call('LINDEX', KEYS[1], firstRemoved)
  if first ~= ARGV[3] then
    return -2
  end
end
redis.call('LTRIM', KEYS[1], 0, keepLast)
redis.call('ZADD', KEYS[2], tonumber(ARGV[5]), ARGV[6])
return len - keepLast - 1
`.trim();

/**
 * Owner-scoped chat model: GET the persistent `…:model` setting (none → nil).
 * Used by BRANCH (copy the model atomically with the transcript) and DELETE.
 * The model key type is string/none; anything else is a -3 (503).
 */
export const CHAT_MODEL_GET_LUA = `
local t = redis.call('TYPE', KEYS[1])
if type(t) == 'table' then t = t['ok'] end
if t ~= 'none' and t ~= 'string' then
  return -3
end
local value = redis.call('GET', KEYS[1])
if value == false then
  return ''
end
return value
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
/** Redis SCAN: bounded cursor iteration over the whole keyspace with
 * MATCH/COUNT; node-redis returns `{ cursor, keys }`.
 */
  scan(
    cursor: number | string,
    options?: { MATCH?: string; COUNT?: number },
  ): Promise<{ cursor: string | number; keys: string[] } | unknown>;
  eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown>;
  del(key: string): Promise<number | unknown>;
}

function chatRefForKeys(chat: ChatRef): string {
  if (typeof chat.ownerId !== 'string' || !CHAT_OWNER_ID_PATTERN.test(chat.ownerId)) {
    throw new StoreUnavailableError('Chat state requires an authenticated owner.');
  }
  return chat.ownerId;
}

function messagesKey(chat: ChatRef): string {
  return `${REDIS_KEY_PREFIX}:chat:${chatRefForKeys(chat)}:${chat.slug}:${chat.chatId}:messages`;
}
function activeStreamKey(chat: ChatRef): string {
  return `${REDIS_KEY_PREFIX}:chat:${chatRefForKeys(chat)}:${chat.slug}:${chat.chatId}:active-stream`;
}
function modelKey(chat: ChatRef): string {
  return `${REDIS_KEY_PREFIX}:chat:${chatRefForKeys(chat)}:${chat.slug}:${chat.chatId}:model`;
}
function idempotencyKey(chat: ChatRef, key: string): string {
  return `${REDIS_KEY_PREFIX}:idempotency:${chatRefForKeys(chat)}:${chat.slug}:${chat.chatId}:${key}`;
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
          keys: [messagesKey(chat), chatIndexKey(chat.ownerId)],
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
      try {        return await applyAskUserAnswer(
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

    async deleteChat(chat: ChatRef): Promise<ChatDeleteResult> {
      const owner = chatRefForKeys(chat);
      try {
        const result = await client.eval(DELETE_CHAT_LUA, {
          keys: [messagesKey(chat), activeStreamKey(chat), chatIndexKey(owner), modelKey(chat)],
          arguments: [chatIndexMember(chat)],
        });
        const code = toMutationCode(result);
        if (code === -3) {
          rethrowAsUnavailable(new StoreUnavailableError('Chat state could not be mutated (key types).'));
        }
        if (code === -1) {
          return { status: 'busy', removedIdempotencyKeys: 0 };
        }
        if (code === 0) {
          return { status: 'not-found', removedIdempotencyKeys: 0 };
        }
        // Message-scoped idempotency cleanup AFTER the atomic delete: the
        // keys are `{owner}:{slug}:{chatId}:{chatId}:{messageId}` — exactly
        // this chat's keys, and semantically dead once the chat is gone.
        const removedIdempotencyKeys = await deleteChatIdempotencyKeys(chat);
        return { status: 'deleted', removedIdempotencyKeys };
      } catch (error) {
        rethrowAsUnavailable(error);
      }
    },

    async branchChat(chat: ChatRef, branch: { readonly messageId: string; readonly newChatId: string }): Promise<ChatBranchResult> {
      const owner = chatRefForKeys(chat);
      const destination: ChatRef = { ownerId: chat.ownerId, slug: chat.slug, chatId: branch.newChatId };
      try {
        const rawEntries = await (async (): Promise<string[]> => {
          const entries = await client.lRange(messagesKey(chat), 0, -1);
          if (!Array.isArray(entries)) {
            throw new StoreUnavailableError('Chat state could not be read (messages).');
          }
          return entries.filter((entry): entry is string => typeof entry === 'string');
        })();
        if (rawEntries.length === 0) {
          return { status: 'chat-not-found', copiedMessages: 0 };
        }
        const keepLastRaw = findMessageIndexById(rawEntries, branch.messageId);
        if (keepLastRaw === null || keepLastRaw < 0) {
          return { status: 'message-not-found', copiedMessages: 0 };
        }
        const copiedRaw = rawEntries.slice(0, keepLastRaw + 1);
        const result = await client.eval(BRANCH_CHAT_LUA, {
          keys: [messagesKey(destination), chatIndexKey(owner), activeStreamKey(destination), modelKey(chat), modelKey(destination)],
          arguments: [chatIndexMember(destination), String(Math.max(0, Math.floor(now()))), ...copiedRaw],
        });
        const code = toMutationCode(result);
        if (code === -3) {
          rethrowAsUnavailable(new StoreUnavailableError('Chat state could not be mutated (key types).'));
        }
        if (code === -1 || code === -2) {
          return { status: 'destination-conflict', copiedMessages: 0 };
        }
        return { status: 'branched', copiedMessages: copiedRaw.length };
      } catch (error) {
        rethrowAsUnavailable(error);
      }
    },

    async rewindChat(chat: ChatRef, messageId: string): Promise<ChatRewindResult> {
      const owner = chatRefForKeys(chat);
      const indexKey = chatIndexKey(owner);
      // Bounded CAS retries: a concurrent append changes the tail bytes; each
      // retry recomputes from a FRESH read. 'stale' only after real losses.
      for (let attempt = 0; attempt < REWIND_CAS_ATTEMPTS; attempt += 1) {
        let rawEntries: string[];
        try {
          const entries = await client.lRange(messagesKey(chat), 0, -1);
          if (!Array.isArray(entries)) {
            throw new StoreUnavailableError('Chat state could not be read (messages).');
          }
          rawEntries = entries.filter((entry): entry is string => typeof entry === 'string');
        } catch (error) {
          if (error instanceof StoreUnavailableError) {
            rethrowAsUnavailable(error);
          }
          rethrowAsUnavailable(error);
        }
        if (rawEntries.length === 0) {
          return { status: 'chat-not-found', kept: 0, removed: 0 };
        }
        const keepLast = findMessageIndexById(rawEntries, messageId);
        if (keepLast === null || keepLast < 0) {
          return { status: 'message-not-found', kept: 0, removed: 0 };
        }
        const expectedLen = rawEntries.length;
        const expectedTail = rawEntries[expectedLen - 1] as string;
        const firstRemovedIndex = keepLast + 1;
        const expectedFirstRemoved =
          firstRemovedIndex <= expectedLen - 1 ? (rawEntries[firstRemovedIndex] as string) : '';
        const removedUserIds =
          firstRemovedIndex <= expectedLen - 1
            ? userMessageIdsOf(rawEntries.slice(firstRemovedIndex))
            : [];
        try {
          const result = await client.eval(REWIND_CHAT_LUA, {
            keys: [messagesKey(chat), indexKey],
            arguments: [
              expectedTail,
              String(expectedLen),
              expectedFirstRemoved,
              String(keepLast),
              String(Math.max(0, Math.floor(now()))),
              chatIndexMember(chat),
            ],
          });
          const code = toMutationCode(result);
          if (code === -3) {
            rethrowAsUnavailable(new StoreUnavailableError('Chat state could not be mutated (key types).'));
          }
          if (code === -2) {
            continue; // concurrent append: recompute and retry
          }
          // Applied (removed >= 0): delete the removed messages' idempotency
          // keys so a reused prompt regenerates; KEPT keys are never touched.
          let removedIdempotencyKeys = 0;
          for (const removedId of removedUserIds) {
            try {
              const removed = await client.del(idempotencyKey(chat, `${chat.chatId}:${removedId}`));
              if (removed === 1 || removed === '1' || removed === true) {
                removedIdempotencyKeys += 1;
              }
            } catch {
              /* key may expire naturally; never fail the rewind for cleanup */
            }
          }
          return { status: 'applied', kept: keepLast + 1, removed: code };
        } catch (error) {
          if (error instanceof StoreUnavailableError) {
            throw error;
          }
          rethrowAsUnavailable(error);
        }
      }
      return { status: 'stale', kept: 0, removed: 0 };
    },

    async getChatModel(chat: ChatRef): Promise<string | null> {
      chatRefForKeys(chat);
      try {
        const result = await client.eval(CHAT_MODEL_GET_LUA, {
          keys: [modelKey(chat)],
        });
        if (typeof result === 'string' && result.length > 0) {
          return result;
        }
        if (result === -3) {
          rethrowAsUnavailable(new StoreUnavailableError('Chat state could not be read (model).'));
        }
        return null;
      } catch (error) {
        if (error instanceof StoreUnavailableError) {
          throw error;
        }
        rethrowAsUnavailable(error);
      }
    },

    async setChatModel(chat: ChatRef, modelId: string | null): Promise<void> {
      chatRefForKeys(chat);
      try {
        if (modelId === null) {
          await client.del(modelKey(chat));
          return;
        }
        // Persistent setting: no TTL. The value was validated at the route;
        // the store is the last line of shape defense.
        if (typeof modelId !== 'string' || !MODEL_ID_PATTERN.test(modelId)) {
          throw new StoreUnavailableError('Chat state could not be written (model).');
        }
        await client.set(modelKey(chat), modelId);
      } catch (error) {
        if (error instanceof StoreUnavailableError) {
          throw error;
        }
        rethrowAsUnavailable(error);
      }
    },

    async listRecentChats(ownerId: string, limit: number): Promise<ChatSummary[]> {
      if (typeof ownerId !== 'string' || !CHAT_OWNER_ID_PATTERN.test(ownerId)) {
        throw new StoreUnavailableError('Chat state requires an authenticated owner.');
      }
      const bounded = clampRecentChatsLimit(limit);
      const ownerIndexKey = chatIndexKey(ownerId);
      try {
        // ---- 1. Newest chats from the user's activity index. BYSCORE REV
        // (args are max→min for the reversed traversal) + LIMIT keep the read
        // bounded; the window carries extra slack so skipped stale members
        // cannot steal slots from live chats. Equal scores come back
        // member-descending (mirrored where the index is sorted in-process).
        const indexReply = await client.zRangeWithScores(ownerIndexKey, '+inf', '-inf', {
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
          const summary = await summarizeChatFromWindow({ ...ref, ownerId }, scoreToIso(score));
          if (summary === null) {
            continue; // no stored messages (deleted/stale member): skip
          }
          indexed.add(chatIndexMember(ref));
          summaries.push(summary);
        }
        if (summaries.length >= bounded) {
          return summaries.slice(0, bounded);
        }

        // ---- 2. Legacy chats (created before THIS OWNER's index existed, or
        // indexed chats whose member fell outside the bounded read window
        // above): bounded, strictly read-only SCAN discovery of
        // `${REDIS_KEY_PREFIX}:chat:{ownerId}:*:messages` keys — the owner
        // segment is part of the pattern, so pre-auth ownerless keys can
        // never match. Deterministically ordered ascending, then the
        // remaining slots are filled in that deterministic order.
        const legacyRefs = await discoverLegacyChatKeys(ownerId, indexed);
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
          const score = toIndexScore(await client.zScore(ownerIndexKey, chatIndexMember(ref)));
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
  async function summarizeChatFromWindow(ref: { ownerId: string; slug: string; chatId: string }, lastActivityAt: string | null): Promise<ChatSummary | null> {
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
   * Bounded SCAN deleting ONLY this chat's message-scoped idempotency keys
   * (`{owner}:{slug}:{chatId}:*`). Best-effort: a stale key expiring mid-scan
   * never fails the destructive delete. Iteration is bounded; a corrupt SCAN
   * reply is a raw read failure (503).
   */
  async function deleteChatIdempotencyKeys(chat: ChatRef): Promise<number> {
    const owner = chatRefForKeys(chat);
    const match = `${REDIS_KEY_PREFIX}:idempotency:${owner}:${chat.slug}:${chat.chatId}:*`;
    let removed = 0;
    let cursor: string = '0';
    let iterations = 0;
    do {
      const reply = await client.scan(cursor, { MATCH: match, COUNT: IDEMPOTENCY_SCAN_COUNT });
      if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
        throw new StoreUnavailableError('Chat state could not be read (idempotency).');
      }
      const nextCursor = (reply as { cursor?: unknown }).cursor;
      const keys = (reply as { keys?: unknown }).keys;
      if (!Array.isArray(keys) || (typeof nextCursor !== 'string' && typeof nextCursor !== 'number')) {
        throw new StoreUnavailableError('Chat state could not be read (idempotency).');
      }
      cursor = String(nextCursor);
      for (const key of keys) {
        if (typeof key !== 'string') {
          continue;
        }
        try {
          const value = await client.del(key);
          if (value === 1 || value === '1' || value === true) {
            removed += 1;
          }
        } catch {
          /* a stale key may expire mid-scan; never fail the delete */
        }
      }
      iterations += 1;
    } while (cursor !== '0' && iterations < IDEMPOTENCY_SCAN_MAX_ITERATIONS);
    return removed;
  }

  /**
   * Bounded legacy discovery: SCAN (cursor + MATCH + COUNT hint) over
   * `${REDIS_KEY_PREFIX}:chat:{ownerId}:*:messages`, capped both in round
   * trips and in distinct chat keys. The owner segment is FIXED inside the
   * pattern, so pre-authentication ownerless keys
   * (`…:chat:{slug}:{chatId}:messages`) never match — they are unreachable
   * from this path for an authenticated list, by construction. Everything is
   * filtered through {@link parseOwnerChatMessagesKey} (owner alphabet +
   * roster slug + safe id alphabet), already-indexed members are excluded,
   * and the result is sorted ascending by `${slug}:${chatId}` so the
   * included subset is deterministic. Never writes, never deletes, no FLUSH,
   * no KEYS.
   */
  async function discoverLegacyChatKeys(
    ownerId: string,
    indexed: Set<string>,
  ): Promise<Array<{ ownerId: string; slug: string; chatId: string }>> {
    const found = new Map<string, { ownerId: string; slug: string; chatId: string }>();
    let cursor: string = '0';
    let iterations = 0;
    do {
      const reply = await client.scan(cursor, {
        MATCH: `${REDIS_KEY_PREFIX}:chat:${ownerId}:*:messages`,
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
        const ref = parseOwnerChatMessagesKey(key, REDIS_KEY_PREFIX);
        if (ref === null || ref.ownerId !== ownerId || indexed.has(chatIndexMember(ref))) {
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
