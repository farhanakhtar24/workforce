import type { UIMessage } from 'ai';
import { StoreUnavailableError } from '../errors.js';
import type { AskUserAnswerStatus, ChatRef, ChatStore } from './types.js';
import { applyAskUserAnswer } from './ask-user.js';

/**
 * In-memory `ChatStore` honoring the exact semantics of the Redis store,
 * IMPLEMENTED OVER THE SAME RAW-ENTRY LIST: entries are the JSON strings the
 * Redis LIST would hold, so ask_user answers run the identical byte-CAS
 * algorithm (`applyAskUserAnswer`) — no cjson-style re-serialization, no
 * empty-array/empty-object ambiguity, no numeric drift — and both stores are
 * contract-identical (`applied`/`unchanged`/`stale`), including append-only
 * message persistence, the compare-and-delete clear, and `SET NX` idempotency.
 *
 * Deliberately not a "fake Redis": it implements `ChatStore` directly over the
 * same raw-entry discipline the Redis store uses.
 */
export function createInMemoryChatStore(): ChatStore & {
  snapshot(chat: ChatRef): { messages: unknown[]; activeStreamId: string | null; idempotencyKeys: Map<string, number> };
} {
  const chatKeys = new Map<string, string[]>();
  const activeStreams = new Map<string, string>();
  const idempotency = new Map<string, number>();

  function messageKey(chat: ChatRef): string {
    return `messages:${chat.slug}:${chat.chatId}`;
  }
  function streamKey(chat: ChatRef): string {
    return `active-stream:${chat.slug}:${chat.chatId}`;
  }
  function idemKey(chat: ChatRef, key: string): string {
    return `idempotency:${chat.slug}:${chat.chatId}:${key}`;
  }

  function loadRaw(chat: ChatRef): string[] {
    return [...(chatKeys.get(messageKey(chat)) ?? [])];
  }

  function parseEntry(entry: string): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry);
    } catch {
      throw new StoreUnavailableError();
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StoreUnavailableError();
    }
    return parsed;
  }

  return {
    async loadMessages(chat) {
      return loadRaw(chat).map(parseEntry);
    },
    async appendMessage(chat, message) {
      // Concurrent appends both land; no append touches other entries.
      const list = chatKeys.get(messageKey(chat)) ?? [];
      list.push(JSON.stringify(message));
      chatKeys.set(messageKey(chat), list);
    },
    async getActiveStreamId(chat) {
      return activeStreams.get(streamKey(chat)) ?? null;
    },
    async setActiveStreamId(chat, streamId) {
      activeStreams.set(streamKey(chat), streamId);
    },
    async clearActiveStreamId(chat, streamId) {
      const key = streamKey(chat);
      if (activeStreams.get(key) === streamId) {
        activeStreams.delete(key);
        return true;
      }
      return false;
    },
    async acquireIdempotencyKey(chat, key, ttlSeconds) {
      const k = idemKey(chat, key);
      const now = Date.now();
      let entry = idempotency.get(k);
      if (entry !== undefined && entry <= now) {
        idempotency.delete(k);
        entry = undefined;
      }
      if (entry !== undefined) {
        return false;
      }
      idempotency.set(k, now + ttlSeconds * 1000);
      return true;
    },
    async releaseIdempotencyKey(chat, key) {
      idempotency.delete(idemKey(chat, key));
    },
    async answerPendingAskUser(chat, assistantMessageId, toolCallId, answer) {
      // Identical byte-CAS algorithm as the Redis store: load fresh raw
      // entries → patch the ONE pending part → compare-and-set that single
      // entry. Single-threaded JS makes the check+write atomic; the compare
      // stays for exact contract parity with the Redis script.
      return await applyAskUserAnswer(
        async () => loadRaw(chat),
        async (entryIndex, expectedRaw, nextRaw) => {
          const list = chatKeys.get(messageKey(chat));
          const current = list?.[entryIndex];
          if (list === undefined || current !== expectedRaw) {
            return false;
          }
          list[entryIndex] = nextRaw;
          return true;
        },
        assistantMessageId,
        toolCallId,
        answer,
      );
    },
    snapshot(chat) {
      return {
        messages: loadRaw(chat).map(parseEntry),
        activeStreamId: activeStreams.get(streamKey(chat)) ?? null,
        idempotencyKeys: new Map(idempotency),
      };
    },
  };
}
