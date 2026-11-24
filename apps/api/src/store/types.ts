import type { UIMessage } from 'ai';

/**
 * A chat addressed by agent slug + owner + client chat ID (pre-Phase 6
 * authentication). `ownerId` is REQUIRED on every ref: messages, the active
 * stream marker, idempotency keys, and the per-owner chat index are all
 * namespaced by it, so two users using the same slug+chatId are fully
 * isolated. Legacy (ownerless) Redis keys are structurally unreachable from
 * the new key shapes.
 */
export interface ChatRef {
  /** Better Auth `User.id` of the chat's owner. */
  readonly ownerId: string;
  readonly slug: string;
  readonly chatId: string;
}

/**
 * The persisted state of Phase 2 chats (ADR-005/ADR-008):
 * - serialized `UIMessage`s per chat (durable, no TTL), stored append-only —
 *   one message per list entry so concurrent turns can never overwrite or
 *   delete each other's messages,
 * - the currently active stream ID per chat (cleared on completion),
 * - idempotency keys scoped per chat with a TTL.
 *
 * Append-only is a correctness requirement, not a storage detail: whole-list
 * load→save replacement races a concurrent turn between its load and its save
 * and deletes the messages appended in between, so `saveMessages` must not
 * exist on the production contract.
 */
export interface ChatStore {
  /**
   * Loads stored messages for a chat, oldest first. Returns `[]` when the chat
   * has no stored messages.
   * Throws `StoreUnavailableError` when the backing storage fails or a stored
   * entry cannot be parsed.
   */
  loadMessages(chat: ChatRef): Promise<unknown[]>;

  /**
   * Atomically appends one message as the newest list entry. Two concurrent
   * appends both land; no append ever deletes or rewrites other entries.
   * Throws `StoreUnavailableError` when the backing storage fails.
   */
  appendMessage(chat: ChatRef, message: UIMessage): Promise<void>;

  /** Returns the active stream ID, or `null` when none is active. */
  getActiveStreamId(chat: ChatRef): Promise<string | null>;

  /**
   * Records `streamId` as the chat's active stream (24h TTL, aligned with the
   * resumable-stream sentinel). Called before the stream response is handed
   * to the client.
   */
  setActiveStreamId(chat: ChatRef, streamId: string): Promise<void>;

  /**
   * Atomically: if the chat's active stream ID equals `streamId`, deletes the
   * marker; otherwise does nothing. An old, slow completion must never clear a
   * newer stream's marker. Returns whether it deleted.
   */
  clearActiveStreamId(chat: ChatRef, streamId: string): Promise<boolean>;

  /**
   * Atomically `SET NX` with an expiry of exactly `ttlSeconds`. Returns `true`
   * when the key was acquired (first caller wins), `false` when it already
   * exists (duplicate submit — reply 409 without a second generation).
   */
  acquireIdempotencyKey(chat: ChatRef, key: string, ttlSeconds: number): Promise<boolean>;

  /**
   * Deletes only `key` for this chat. Called exclusively for keys this process
   * acquired before streaming began (pre-stream setup failure); a key acquired
   * by another stream is never touched here.
   */
  releaseIdempotencyKey(chat: ChatRef, key: string): Promise<void>;

  /**
   * HITL resume (Phase 4): atomically resolves ONE pending `ask_user` tool part
   * — a tool part on the assistant message `assistantMessageId` whose
   * `state` is exactly `input-available` — to `output-available` with
   * `{ answer }`. The update is a BYTE-EXACT compare-and-set of the ONE list
   * entry (Lua `LINDEX` equality + `LSET` in Redis; plain object CAS in
   * memory): everything else is left untouched, so user messages stay
   * append-only, duplicate calls are no-ops, and co-located payloads
   * (`options: []`, large numeric literals, key order) survive untouched —
   * no cjson/JSON re-serialization of the whole entry anywhere.
   * Returns a TYPED status:
   * - `'applied'`   — the part transitioned this call;
   * - `'unchanged'` — no pending matching part existed (already answered,
   *                   absent, or not the referenced message);
   * - `'stale'`     — a matching pending part was seen but the CAS kept losing
   *                   to a concurrent writer (bounded retries exhausted).
   * Throws `StoreUnavailableError` when the backing storage fails.
   */
  answerPendingAskUser(chat: ChatRef, assistantMessageId: string, toolCallId: string, answer: string): Promise<AskUserAnswerStatus>;

  /**
   * Recent-chat listing for the sidebar history API (`GET /api/chats`):
   * identity + bounded title/preview + count + activity timestamp per chat,
   * newest activity first for chats tracked by the activity index, and chats
   * created BEFORE the index existed (legacy) deterministically after them
   * with `lastActivityAt: null` (never fabricated). Legacy discovery is
   * bounded (Redis: bounded SCAN + bounded per-chat reads). `ownerId` is
   * REQUIRED: only that user's index/chats are listed, and pre-auth
   * (ownerless) legacy keys can never match the owner-scoped discovery.
   * Corrupt/garbage stored entries are skipped leniently here — the strict
   * `StoreUnavailableError`-on-corruption contract stays on `loadMessages`
   * (generation correctness), not on this read-only summary path.
   * Throws `StoreUnavailableError` when the backing storage fails.
   */
  listRecentChats(ownerId: string, limit: number): Promise<ChatSummary[]>;

  /**
   * Owner-scoped DESTRUCTIVE delete (pre-Phase 6 chat lifecycle):
   * atomically removes THAT owner's messages list, active-stream marker, and
   * the chat's per-owner index member; then (outside the atomic step)
   * deletes the chat's message-scoped idempotency keys (bounded SCAN) —
   * they are semantically dead without the chat, but removing them is
   * preferred so a reused prompt cannot be blocked by a stale key.
   * Refuses (`'busy'`) while an ACTIVE STREAM marker exists (a generation is
   * running/resumable) — the marker is the exact contract the chat POST
   * uses, so no generation can be silently orphaned mid-flight.
   * `'not-found'` when this owner has no such chat (unknown or other-owner).
   * Deliberate exclusions: WorkDocs, Delegation audit rows, AgentTask
   * history, delegated child chats, and every other owner's data are NEVER
   * touched — they are durable artifacts that outlive their chat.
   * Throws `StoreUnavailableError` when the backing storage fails.
   */
  deleteChat(chat: ChatRef): Promise<ChatDeleteResult>;

  /**
   * Owner-scoped BRANCH: copies THIS chat's messages UP TO AND INCLUDING the
   * selected message (index found by message id, searched newest-first) into
   * a NEW empty destination chat under the SAME owner+slug, preserving the
   * EXACT raw stored JSON bytes and order (no re-serialization anywhere).
   * The destination must be non-existent/empty AND marker-free (`'destination-
   * conflict'` otherwise). The source is never modified (active-stream marker
   * included). No idempotency keys are copied (the destination is fresh).
   * The destination's per-owner index member is written atomically with the
   * copied entries in ONE Redis script.
   * Throws `StoreUnavailableError` when the backing storage fails.
   */
  branchChat(chat: ChatRef, branch: { readonly messageId: string; readonly newChatId: string }): Promise<ChatBranchResult>;

  /**
   * Owner-scoped DESTRUCTIVE REWIND: keeps messages UP TO AND INCLUDING the
   * selected message (newest-last search by id) and atomically removes the
   * LATER messages with a compare-and-set against concurrent appends
   * (expected list length + byte-exact tail + byte-exact first-removed
   * entry; a concurrent append changes both) — bounded retries then
   * `'stale'` (the route answers a fixed 409). The kept entries' raw bytes
   * are preserved untouched (LTRIM, never cjson). Idempotency keys of REMOVED
   * user messages are deleted so a reused prompt can regenerate; keys of
   * KEPT messages are never touched. The per-owner index member is re-scored
   * honestly (the chat was just mutated). The active-stream refusal stays at
   * the route layer (fixed 409 while a generation runs) and the caller MUST
   * have checked the marker; the store never rewinds a live chat (the CAS
   * plus the marker guarantee it).
   * DOCUMENTED EXCEPTION to append-only: this is the only store operation
   * that removes existing message entries, and it removes only a tail.
   * Throws `StoreUnavailableError` when the backing storage fails.
   */
  rewindChat(chat: ChatRef, messageId: string): Promise<ChatRewindResult>;

  /**
   * The chat's SELECTED model (server-validated id) for one owner+slug+chat,
   * or `null` when unset (the generation resolves the DEFAULT then). Redis:
   * persistent `…:model` key, no TTL; in-memory parity. Rewind preserves it;
   * branch copies it atomically with the transcript; delete removes it.
   */
  getChatModel(chat: ChatRef): Promise<string | null>;

  /** Assigns (`modelId`) or clears (`null`) the chat's selected model. */
  setChatModel(chat: ChatRef, modelId: string | null): Promise<void>;
}

/** Result of the destructive owner-scoped chat delete. */
export interface ChatDeleteResult {
  readonly status: 'deleted' | 'busy' | 'not-found';
  /** Message-scoped idempotency keys actually removed (best-effort cleanup). */
  readonly removedIdempotencyKeys: number;
}

/** Result of the owner-scoped chat branch. */
export interface ChatBranchResult {
  readonly status: 'branched' | 'chat-not-found' | 'message-not-found' | 'destination-conflict';
  /** Messages copied into the destination (through the selected one). */
  readonly copiedMessages: number;
}

/** Result of the owner-scoped destructive rewind. */
export interface ChatRewindResult {
  readonly status: 'applied' | 'chat-not-found' | 'message-not-found' | 'stale';
  readonly kept: number;
  readonly removed: number;
}

/** Owner id shape for chat-store keys (Better Auth `User.id`, TEXT-safe). */
export const CHAT_OWNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type AskUserAnswerStatus = 'applied' | 'unchanged' | 'stale';

/** Sentinel answer recorded for older pending questions nobody answered. */
export const ASK_USER_NO_ANSWER = '(no answer given)';

/** Idempotency key time-to-live in seconds (ADR-005). */
export const IDEMPOTENCY_KEY_TTL_SECONDS = 900;

/**
 * One recent-chat entry for the sidebar history API (`GET /api/chats`).
 *
 * Deliberately minimal: identity (`agent` slug + `chatId`), the bounded
 * first-user-text `title`, the bounded latest visible user/assistant text
 * `preview`, the number of stored list entries, and the last activity time.
 * `lastActivityAt` is an ISO-8601 string for chats present in the activity
 * index and `null` for legacy chats that predate it — it is never fabricated.
 * No other message content (no tool payloads, no full bodies) is ever
 * attached to a summary.
 */
export interface ChatSummary {
  readonly chatId: string;
  readonly agent: string;
  readonly title: string;
  readonly preview: string;
  readonly messageCount: number;
  readonly lastActivityAt: string | null;
}
