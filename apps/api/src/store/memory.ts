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
 * index exactly: a PER-OWNER in-process sorted map member `${slug}:${chatId}`
 * → epoch-ms score re-scored on EVERY append inside the same single step, the
 * same score-DESC/member-DESC ordering (Redis ZRANGE REV parity), the same
 * ascending legacy order, and `lastActivityAt: null` (never fabricated) for
 * chats appended before the index existed or otherwise missing from it.
 * Chats are keyed with the owner first, so two users with the same
 * slug+chatId are fully isolated.
 *
 * Deliberately not a "fake Redis": it implements `ChatStore` directly over the
 * same raw-entry discipline the Redis store uses.
 */
import type { UIMessage } from 'ai';
import { StoreUnavailableError } from '../errors.js';
import type { AskUserAnswerStatus, ChatMetadata, ChatMetadataPatch, ChatRef, ChatStore, ChatSummary } from './types.js';
import { CHAT_OWNER_ID_PATTERN } from './types.js';
import { applyAskUserAnswer } from './ask-user.js';
import {
  buildChatSummary,
  chatIndexMember,
  applyChatMetadataPatch,
  clampRecentChatsLimit,
  compareIndexEntriesDesc,
  DEFAULT_CHAT_METADATA,
  findMessageIndexById,
  legacyOrderKey,
  orderChatSummaries,
  parseChatIndexMember,
  parseRawEntriesLeniently,
  scoreToIso,
  userMessageIdsOf,
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
  /**
   * PER-OWNER activity index (mirrors the Redis ZSET layout): key
   * `{ownerId}:{slug}:{chatId}` → epoch-ms of the latest append. Owners never
   * share index members, so two users with the same slug+chatId are isolated
   * in listings too.
   */
  const chatIndex = new Map<string, number>();
  /** Per-chat selected model: key `model:{owner}:{slug}:{chatId}` → id. */
  const modelSettings = new Map<string, string>();
  const metadataSettings = new Map<string, ChatMetadata>();

  function ensureOwner(chat: ChatRef): string {
    if (typeof chat.ownerId !== 'string' || !CHAT_OWNER_ID_PATTERN.test(chat.ownerId)) {
      throw new StoreUnavailableError('Chat state requires an authenticated owner.');
    }
    return chat.ownerId;
  }

  /** Full index key: owner-prefixed member. */
  function indexKey(chat: ChatRef): string {
    return `${ensureOwner(chat)}:${chatIndexMember(chat)}`;
  }

  function messageKey(chat: ChatRef): string {
    return `messages:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}`;
  }
  function streamKey(chat: ChatRef): string {
    return `active-stream:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}`;
  }
  function idemKey(chat: ChatRef, key: string): string {
    return `idempotency:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}:${key}`;
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
      chatIndex.set(indexKey(chat), Math.max(0, Math.floor(now())));
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

    async deleteChat(chat) {
      ensureOwner(chat);
      const mKey = messageKey(chat);
      const sKey = streamKey(chat);
      // Active-stream refusal FIRST (marker = a generation is running)...
      if (activeStreams.has(sKey)) {
        return { status: 'busy', removedIdempotencyKeys: 0 };
      }
      // ...then the chat must EXIST (nonempty list or marker, mirroring the
      // Redis script's EXISTS-on-messages check).
      const raw = chatKeys.get(mKey);
      if (raw === undefined) {
        return { status: 'not-found', removedIdempotencyKeys: 0 };
      }
      chatKeys.delete(mKey);
      // The chat's selected model setting dies with the chat.
      modelSettings.delete(`model:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}`);
      // Sidebar metadata dies with the chat (Lua DEL KEYS[5] parity).
      metadataSettings.delete(`metadata:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}`);
      void 0;
      chatIndex.delete(indexKey(chat));
      // Message-scoped idempotency keys for THIS chat: bounded iteration over
      // the per-owner prefixed keys (same semantic dead-ness as the Redis
      // SCAN; the keys are never another chat's).
      const idemPrefix = `idempotency:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}:`;
      let removedIdempotencyKeys = 0;
      for (const key of [...idempotency.keys()]) {
        if (key.startsWith(idemPrefix)) {
          idempotency.delete(key);
          removedIdempotencyKeys += 1;
        }
      }
      return { status: 'deleted', removedIdempotencyKeys };
    },

    async branchChat(chat, branch) {
      ensureOwner(chat);
      const sourceRaw = chatKeys.get(messageKey(chat)) ?? [];
      if (sourceRaw.length === 0) {
        return { status: 'chat-not-found', copiedMessages: 0 };
      }
      const keepLast = findMessageIndexById(sourceRaw, branch.messageId);
      if (keepLast === null || keepLast < 0) {
        return { status: 'message-not-found', copiedMessages: 0 };
      }
      const destination: ChatRef = { ownerId: chat.ownerId, slug: chat.slug, chatId: branch.newChatId };
      const destMKey = messageKey(destination);
      if ((chatKeys.get(destMKey) ?? []).length > 0) {
        return { status: 'destination-conflict', copiedMessages: 0 };
      }
      if (activeStreams.has(streamKey(destination))) {
        return { status: 'destination-conflict', copiedMessages: 0 };
      }
      // EXACT raw bytes, order preserved, no re-serialization (parity with
      // the Redis RPUSH of raw entries). The SELECTED MODEL is copied in the
      // same step (same atomicity as the Redis script).
      chatKeys.set(destMKey, sourceRaw.slice(0, keepLast + 1).map((entry) => entry));
      const srcModel = modelSettings.get(`model:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}`);
      if (srcModel !== undefined) {
        modelSettings.set(`model:${ensureOwner(destination)}:${destination.slug}:${destination.chatId}`, srcModel);
      }
      chatIndex.set(indexKey(destination), Math.max(0, Math.floor(now())));
      return { status: 'branched', copiedMessages: keepLast + 1 };
    },

    async rewindChat(chat, messageId) {
      ensureOwner(chat);
      const mKey = messageKey(chat);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const raw = chatKeys.get(mKey) ?? [];
        if (raw.length === 0) {
          return { status: 'chat-not-found', kept: 0, removed: 0 };
        }
        const keepLast = findMessageIndexById(raw, messageId);
        if (keepLast === null || keepLast < 0) {
          return { status: 'message-not-found', kept: 0, removed: 0 };
        }
        const expectedLen = raw.length;
        const expectedTail = raw[expectedLen - 1] ?? '';
        const firstRemovedIndex = keepLast + 1;
        const expectedFirstRemoved = firstRemovedIndex <= expectedLen - 1 ? (raw[firstRemovedIndex] ?? '') : '';
        const removedUserIds =
          firstRemovedIndex <= expectedLen - 1
            ? userMessageIdsOf(raw.slice(firstRemovedIndex))
            : [];
        // CAS against concurrent appends: verify the tail bytes + length are
        // exactly the snapshot before mutating (re-read inside the same tick;
        // the real interleavings the Redis script guards cannot occur here,
        // but the contract parity is kept).
        const fresh = chatKeys.get(mKey) ?? [];
        if (
          fresh.length !== expectedLen ||
          (fresh[expectedLen - 1] ?? '') !== expectedTail ||
          (firstRemovedIndex <= fresh.length - 1 ? (fresh[firstRemovedIndex] ?? '') !== expectedFirstRemoved : false)
        ) {
          continue; // concurrent append raced us: recompute
        }
        const keptRaw = raw.slice(0, keepLast + 1);
        const removed = raw.length - keepLast - 1;
        if (removed > 0) {
          chatKeys.set(mKey, keptRaw);
        }
        chatIndex.set(indexKey(chat), Math.max(0, Math.floor(now())));
        // Delete the REMOVED user messages' idempotency keys (never earlier
        // ones); KEPT keys survive so re-answered turns stay protected.
        const idemPrefix = `idempotency:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}:`;
        let removedKeys = 0;
        for (const removedId of removedUserIds) {
          const key = `${idemPrefix}${chat.chatId}:${removedId}`;
          if (idempotency.delete(key)) {
            removedKeys += 1;
          }
        }
        void removedKeys;
        return { status: 'applied', kept: keepLast + 1, removed };
      }
      return { status: 'stale', kept: 0, removed: 0 };
    },

    async getChatModel(chat) {
      ensureOwner(chat);
      const value = modelSettings.get(`model:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}`);
      return value === undefined ? null : value;
    },

    async setChatModel(chat, modelId) {
      ensureOwner(chat);
      if (modelId === null) {
        modelSettings.delete(`model:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}`);
        return;
      }
      modelSettings.set(`model:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}`, modelId);
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
    async getChatMetadata(chat: ChatRef): Promise<ChatMetadata> {
      ensureOwner(chat);
      return metadataSettings.get(`metadata:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}`) ?? DEFAULT_CHAT_METADATA;
    },

    async setChatMetadata(chat: ChatRef, patch: ChatMetadataPatch): Promise<ChatMetadata> {
      ensureOwner(chat);
      const key = `metadata:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}`;
      const currentKey = `metadata:${ensureOwner(chat)}:${chat.slug}:${chat.chatId}`;
      const next = applyChatMetadataPatch(metadataSettings.get(currentKey) ?? DEFAULT_CHAT_METADATA, patch);
      metadataSettings.set(key, next);
      return next;
    },

    async chatExists(chat: ChatRef): Promise<boolean> {
      ensureOwner(chat);
      return (chatKeys.get(messageKey(chat)) ?? []).length > 0;
    },

    async listRecentChats(ownerId: string, limit: number, includeArchived?: boolean): Promise<ChatSummary[]> {
      if (typeof ownerId !== 'string' || !CHAT_OWNER_ID_PATTERN.test(ownerId)) {
        throw new StoreUnavailableError('Chat state requires an authenticated owner.');
      }
      const bounded = clampRecentChatsLimit(limit);
      // 1. Indexed chats: score DESC, member DESC on equal scores — the exact
      // in-process mirror of Redis ZRANGE … REV with equal-score members.
      // Only THIS owner's chats are ever read: keys are owner-prefixed and
      // the pre-auth ownerless legacy shape cannot match the prefix probe.
      const ownerKeyPrefix = `messages:${ownerId}:`;
      const ownerIndexPrefix = `${ownerId}:`;
      const indexedEntries = [...chatIndex.entries()]
        .filter((entry) => entry[0].startsWith(ownerIndexPrefix))
        .map((entry) => ({ member: entry[0].slice(ownerIndexPrefix.length), score: entry[1] }))
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
        const raw = chatKeys.get(`${ownerKeyPrefix}${ref.slug}:${ref.chatId}`) ?? [];
        if (raw.length === 0) {
          continue; // stale member with no stored messages
        }
        indexed.add(member);
        appendSummary(summaries, { ...ref, ownerId }, raw, scoreToIso(score));
      }
      // 2. Legacy chats (appended before the index existed, or with the
      // member otherwise missing, or whose member fell outside the bounded
      // window slice of the indexed pass): deterministic ascending order,
      // then the remaining slots in that order. Index-membership parity with
      // the Redis store: a member present in the index keeps its REAL
      // timestamp via a direct lookup (never a window-position `null`); only
      // truly unindexed chats get `lastActivityAt: null` — never fabricated.
      // Keys are owner-prefixed: pre-auth ownerless keys (`messages:{slug}:…`)
      // cannot match the `{ownerId}:` probe and stay invisible here.
      const legacy: Array<{ ownerId: string; slug: string; chatId: string }> = [];
      for (const key of chatKeys.keys()) {
        if (!key.startsWith(ownerKeyPrefix)) {
          continue;
        }
        const ref = parseChatIndexMember(key.slice(ownerKeyPrefix.length));
        if (ref === null || indexed.has(chatIndexMember(ref))) {
          continue;
        }
        legacy.push({ ...ref, ownerId });
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
        const indexedScore = chatIndex.get(indexKey(ref));
        appendSummary(summaries, ref, raw, indexedScore === undefined ? null : scoreToIso(indexedScore));
      }
      // Sidebar presentation parity: metadata, archived filter, pinned first.
      const withMetadata = summaries.slice(0, bounded).map((summary) => {
        const metadata = metadataSettings.get(`metadata:${ownerId}:${summary.agent}:${summary.chatId}`) ?? DEFAULT_CHAT_METADATA;
        return { ...summary, title: metadata.title ?? summary.title, pinned: metadata.pinned, archived: metadata.archived };
      });
      return orderChatSummaries(withMetadata, { includeArchived: includeArchived === true });
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
  ref: { ownerId: string; slug: string; chatId: string },
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
