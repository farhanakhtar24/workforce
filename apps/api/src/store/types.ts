import type { UIMessage } from 'ai';

/**
 * A chat addressed by agent slug + client chat ID. Used instead of a bare
 * chatId so Redis key layout can stay slug-scoped.
 */
export interface ChatRef {
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
}

/** Idempotency key time-to-live in seconds (ADR-005). */
export const IDEMPOTENCY_KEY_TTL_SECONDS = 900;
