/**
 * In-memory `ChatStore` honoring the exact semantics of the Redis store,
 * IMPLEMENTED OVER THE SAME RAW-ENTRY LIST: entries are the JSON strings the
 * Redis LIST would hold, so ask_user answers run the identical byte-CAS
 * algorithm (`applyAskUserAnswer`) — no cjson-style re-serialization, no
 * empty-array/empty-object ambiguity, no numeric drift — and both stores are
 * contract-identical (`applied`/`unchanged`/`stale`), including append-only
 * message persistence, the compare-and-delete clear, and `SET NX` idempotency.
 *
 * Recent-chat history (`listRecentChats`) mirrors the Redis store's activity
 * index exactly: an in-process sorted map member `${slug}:${chatId}` →
 * epoch-ms score re-scored on EVERY append inside the same single step, the
 * same score-DESC/member-DESC ordering (Redis ZRANGE REV parity), the same
 * ascending legacy order, and `lastActivityAt: null` (never fabricated) for
 * chats appended before the index existed or otherwise missing from it.
 *
 * Deliberately not a "fake Redis": it implements `ChatStore` directly over the
 * same raw-entry discipline the Redis store uses.
 */
import type { UIMessage } from 'ai';
import { StoreUnavailableError } from '../errors.js';
import type { AskUserAnswerStatus, ChatRef, ChatStore, ChatSummary } from './types.js';
import { applyAskUserAnswer } from './ask-user.js';
import {
  buildChatSummary,
  chatIndexMember,
  clampRecentChatsLimit,
  compareIndexEntriesDesc,
  legacyOrderKey,
  parseChatIndexMember,
  parseRawEntriesLeniently,
  scoreToIso,
} from './chat-history.js';

export function createInMemoryChatStore(options: { now?: () => number } = {}): ChatStore & {
  snapshot(chat: ChatRef): { messages: unknown[]; activeStreamId: string | null; idempotencyKeys: Map<string, number> };
  /**
   * Test-only seeding that models PRE-INDEX ("legacy") storage: messages
   * land in the list WITHOUT an activity-index member, exactly the state a
   * store upgraded from a pre-index version would hold. Never called by the
   * app itself (like `snapshot`).
   */
  seedLegacyChat(chat: ChatRef, messages: unknown[]): void;
} {
  const now = options.now ?? (() => Date.now());
  const chatKeys = new Map<string, string[]>();
  const activeStreams = new Map<string, string>();
  const idempotency = new Map<string, number>();
  /** Activity index member `${slug}:${chatId}` → epoch-ms of latest append. */
  const chatIndex = new Map<string, number>();

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
      // Concurrent appends both land; no append touches other entries. The
      // activity index re-score is part of the SAME call body — a store this
      // simple cannot fail between the two, mirroring the single-Lua-script
      // atomicity of the Redis store.
      const list = chatKeys.get(messageKey(chat)) ?? [];
      list.push(JSON.stringify(message));
      chatKeys.set(messageKey(chat), list);
      chatIndex.set(chatIndexMember(chat), Math.max(0, Math.floor(now())));
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
    seedLegacyChat(chat, messages) {
      chatKeys.set(
        messageKey(chat),
        messages.map((message) => JSON.stringify(message)),
      );
    },
    async listRecentChats(limit: number): Promise<ChatSummary[]> {
      const bounded = clampRecentChatsLimit(limit);
      // 1. Indexed chats: score DESC, member DESC on equal scores — the exact
      // in-process mirror of Redis ZRANGE … REV with equal-score members.
      const indexedEntries = [...chatIndex.entries()]
        .map((entry) => ({ member: entry[0], score: entry[1] }))
        .sort(compareIndexEntriesDesc)
        .filter((entry) => parseChatIndexMember(entry.member) !== null);
      const summaries: ChatSummary[] = [];
      const indexed = new Set<string>();
      for (const { member, score } of indexedEntries) {
        if (summaries.length >= bounded) {
          break;
        }
        const ref = parseChatIndexMember(member);
        if (ref === null) {
          continue;
        }
        const raw = chatKeys.get(messageKey(ref)) ?? [];
        if (raw.length === 0) {
          continue; // stale member with no stored messages
        }
        indexed.add(member);
        appendSummary(summaries, ref, raw, scoreToIso(score));
      }
      // 2. Legacy chats (appended before the index existed, or with the
      // member otherwise missing, or whose member fell outside the bounded
      // window slice of the indexed pass): deterministic ascending order,
      // then the remaining slots in that order. Index-membership parity with
      // the Redis store: a member present in the index keeps its REAL
      // timestamp via a direct lookup (never a window-position `null`); only
      // truly unindexed chats get `lastActivityAt: null` — never fabricated.
      const legacy: Array<{ slug: string; chatId: string }> = [];
      for (const key of chatKeys.keys()) {
        const ref = parseChatIndexMember(key.slice('messages:'.length));
        if (ref === null || indexed.has(chatIndexMember(ref))) {
          continue;
        }
        legacy.push(ref);
      }
      legacy.sort((a, b) => (legacyOrderKey(a) < legacyOrderKey(b) ? -1 : legacyOrderKey(a) > legacyOrderKey(b) ? 1 : 0));
      for (const ref of legacy) {
        if (summaries.length >= bounded) {
          break;
        }
        const raw = chatKeys.get(messageKey(ref)) ?? [];
        if (raw.length === 0) {
          continue;
        }
        const indexedScore = chatIndex.get(chatIndexMember(ref));
        appendSummary(summaries, ref, raw, indexedScore === undefined ? null : scoreToIso(indexedScore));
      }
      return summaries;
    },
  };
}

/**
 * Builds one summary from the raw list. `messageCount` is the RAW stored
 * entry count (LLEN parity); corrupt entries never leak into title/preview
 * (lenient parse), matching the Redis store where LLEN counts every entry.
 */
function appendSummary(
  summaries: ChatSummary[],
  ref: { slug: string; chatId: string },
  raw: readonly string[],
  lastActivityAt: string | null,
): void {
  const entries = parseRawEntriesLeniently(raw);
  summaries.push(
    buildChatSummary({
      slug: ref.slug,
      chatId: ref.chatId,
      messageCount: raw.length,
      titleEntries: entries,
      previewEntries: entries,
      lastActivityAt,
    }),
  );
}
