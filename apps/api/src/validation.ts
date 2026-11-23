import { z } from 'zod';
import type { UIMessage } from 'ai';

/**
 * Request-side validation at the trust edge.
 *
 * Rules (Phase 2 design, ADR-005/ADR-008; Phase 4 additions):
 * - IDs are bounded and restricted to a safe alphabet: 1–64 chars of
 *   `A-Z a-z 0-9 _ -` (chat/message/stream IDs). Redis key safety + URL safety.
 * - The POST body is exactly `{ id, message }` plus an OPTIONAL
 *   `mode: 'plan' | 'action'` (Phase 4); additional wrapper keys are rejected.
 *   Absent mode = `action`. The field is NEVER read for depth — depth comes
 *   only from the verified internal delegation context header.
 * - Idempotency keys must equal `${chatId}:${message.id}`, are bounded, and
 *   are scoped to the chat in the store.
 */
import { agentSlugs, agentModes, type AgentMode } from '@workforce/core';

export const AGENT_SLUGS: readonly string[] = agentSlugs;
export type KnownAgentSlug = (typeof agentSlugs)[number];
/** Back-compat alias (Phase 2 name); the list is now the Phase 4 roster. */
export type AgentSlug = KnownAgentSlug;

/**
 * Whether the given slug is servable by THIS process: `general` always; the
 * Phase 4 roster only when the agent runtime deps are wired (tests/buildApp
 * callers without them keep the Phase 2 surface byte-compatible).
 */
export function isKnownSlug(slug: string): slug is KnownAgentSlug {
  return (AGENT_SLUGS as readonly string[]).includes(slug);
}

export const chatModeSchema = z.enum(agentModes);
export type ChatMode = AgentMode;

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

/** POST body: exactly `{ id, message }` plus optional `mode` (Phase 4). */
export const chatRequestSchema = z.strictObject({
  id: idSchema,
  message: uiMessageSchema,
  mode: chatModeSchema.optional(),
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
