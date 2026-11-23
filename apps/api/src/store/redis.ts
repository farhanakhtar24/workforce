/**
 * Redis-backed `ChatStore` (ADR-005) with **append-only** message persistence.
 *
 * `RedisLike` is a deliberately narrow subset of the node-redis client so
 * tests can substitute an in-process stand-in implementing Redis semantics
 * without a live Redis:
 * - `get` / `lrange` / `del` / `rpush`
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
 */
import { StoreUnavailableError } from '../errors.js';
import type { UIMessage } from 'ai';
import type { AskUserAnswerStatus, ChatRef, ChatStore } from './types.js';
import { applyAskUserAnswer } from './ask-user.js';

export const REDIS_KEY_PREFIX = 'workforce:phase2';

/** Active-stream marker TTL: aligned with the resumable-stream sentinel (24h). */
export const ACTIVE_STREAM_TTL_SECONDS = 86_400;

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
 * commands camelCase — `rPush`/`lRange`, NEVER lowercase `rpush`/`lrange`
 * (calling the lowercase names on the real client raises
 * "not a function", which previously surfaced as a safe-but-wrong 503).
 */
export interface RedisLike {
  get(key: string): Promise<string | null | unknown>;
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<unknown>;
  del(key: string): Promise<number | unknown>;
  /** Redis RPUSH: append to the tail of a list, creating it when missing. */
  rPush(key: string, value: string): Promise<number | unknown>;
  /** Redis LRANGE: list entries oldest-first between inclusive bounds. */
  lRange(key: string, start: number, stop: number): Promise<string[] | unknown>;
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

export function createRedisChatStore(client: RedisLike): ChatStore {
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
        // RPUSH: a single, atomic append. Concurrent appends both land; no
        // append ever touches other list entries.
        await client.rPush(messagesKey(chat), JSON.stringify(message));
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
  };
}
