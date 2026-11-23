import type { UIMessage } from 'ai';
import type { ChatRef, ChatStore } from './types.js';

/**
 * In-memory `ChatStore` honoring the exact semantics of the Redis store
 * (including append-only message persistence, the compare-and-delete clear,
 * and `SET NX` idempotency) for tests and for running the API without Redis
 * in exotic local setups.
 *
 * Deliberately not a "fake Redis": it implements `ChatStore` directly so tests
 * exercise the same contract the Redis store implements.
 */
export function createInMemoryChatStore(): ChatStore & {
  snapshot(chat: ChatRef): { messages: unknown[]; activeStreamId: string | null; idempotencyKeys: Map<string, number> };
} {
  const chatKeys = new Map<string, unknown[]>();
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

  return {
    async loadMessages(chat) {
      return [...(chatKeys.get(messageKey(chat)) ?? [])];
    },
    async appendMessage(chat, message) {
      // Concurrent appends both land; no append touches other entries.
      const list = chatKeys.get(messageKey(chat)) ?? [];
      list.push(message);
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
    snapshot(chat) {
      return {
        messages: [...(chatKeys.get(messageKey(chat)) ?? [])],
        activeStreamId: activeStreams.get(streamKey(chat)) ?? null,
        idempotencyKeys: new Map(idempotency),
      };
    },
  };
}
