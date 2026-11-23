import { z } from 'zod';
import type { UIMessage } from 'ai';

/**
 * Request-side validation at the trust edge.
 *
 * Rules (Phase 2 design, ADR-005/ADR-008):
 * - IDs are bounded and restricted to a safe alphabet: 1–64 chars of
 *   `A-Z a-z 0-9 _ -` (chat/message/stream IDs). Redis key safety + URL safety.
 * - The POST body is exactly `{ id, message }` — additional wrapper keys are
 *   rejected — where `message` is a single user `UIMessage` (the newest).
 * - Idempotency keys must equal `${chatId}:${message.id}`, are bounded, and
 *   are scoped to the chat in the store.
 * - Only the `general` agent slug exists in Phase 2.
 */
export const AGENT_SLUGS = ['general'] as const;
export type AgentSlug = (typeof AGENT_SLUGS)[number];

/** Phase 2 exposes exactly one agent; other slugs 404. */
export function isKnownSlug(slug: string): slug is AgentSlug {
  return (AGENT_SLUGS as readonly string[]).includes(slug);
}

/** Safe identifier: never contains `/`, `:`, whitespace, or control chars. */
const idSchema = z
  .string({ message: 'id must be a string' })
  .min(1, 'id must be 1-64 characters')
  .max(64, 'id must be 1-64 characters')
  .regex(/^[A-Za-z0-9_-]+$/, 'id must contain only letters, digits, `_` and `-`');

export const clientIdSchema = idSchema;
export const messageIdSchema = idSchema;
export const streamIdSchema = idSchema;

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string({ message: 'part.text must be a string' }).max(10_000, 'part.text must be at most 10000 characters'),
});

const unknownObjectSchema = z.object({ type: z.string().min(1) }).loose();

/**
 * Newest-user-message schema: text parts plus other known `UIMessage` parts
 * (opaque here, strictly validated again by `validateUIMessages` with the
 * registered tools before model conversion).
 */
const uiMessageSchema = z.object({
  id: messageIdSchema,
  role: z.literal('user'),
  parts: z
    .array(z.union([textPartSchema, unknownObjectSchema]))
    .min(1, 'message.parts must not be empty')
    .max(64, 'message.parts must contain at most 64 parts'),
});

/** POST body: exactly `{ id, message }`. */
export const chatRequestSchema = z.strictObject({
  id: idSchema,
  message: uiMessageSchema,
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/**
 * Idempotency key (ADR-005): must be exactly `chatId:messageId`, bounded to
 * 1-128 chars. The strict equality (checked by the caller with both ids) is
 * what makes a key useless outside its chat.
 */
export const idempotencyKeySchema = z
  .string({ message: 'Idempotency-Key header must be a string' })
  .min(1, 'Idempotency-Key header must be 1-128 characters')
  .max(128, 'Idempotency-Key header must be 1-128 characters')
  .regex(/^[A-Za-z0-9_.-]+:[A-Za-z0-9_-]+$/, 'Idempotency-Key must equal "{chatId}:{messageId}"');

/** Narrowing helper for the validated newest user message. */
export function toUIMessageInput(message: ChatRequest['message']): UIMessage {
  return message as unknown as UIMessage;
}
