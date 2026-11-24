/**
 * Opt-in personal-memory capture (pre-Phase 6): the deterministic, idempotent
 * pipeline that runs AFTER an assistant turn completes for an owner who
 * EXPLICITLY enabled personal memory.
 *
 * ## Enqueue gate (generation side)
 * The chat POST handler (the SINGLE generation path — browser chats,
 * delegated child chats, scheduler-run chats) schedules at most one capture
 * job per assistant turn via the shared BullMQ memory queue
 * (`kind: 'capture'`, deterministic id
 * `capture-<sha256(scope|chatId|assistantMessageId)>`). The job carries ids
 * ONLY — never message text — and a disabled setting enqueues NOTHING.
 *
 * ## Worker contract (`processPersonalCaptureJob`)
 * 1. Re-check the enablement at processing time (a toggle mid-flight
 *    suppresses the capture; "off" means zero capture, zero recall).
 * 2. Duplicate guard: an existing derived block on the chat's exact path
 *    whose metadata carries the same `assistantMessageId` makes the job a
 *    no-op (retried/re-delivered/recovered runs never duplicate blocks).
 * 3. Load the transcript, take the bounded VISIBLE text parts of the user +
 *    assistant messages (tool inputs/outputs and reasoning parts are NEVER a
 *    capture source), and skip when there is no durable textual content.
 * 4. Write ONE `observation` block at scope `userMemoryScope(ownerId)` /
 *    path `chats/{chatId}` with metadata
 *    `{source:'personal-chat', chatId, assistantMessageId}` through
 *    `MemoryService.writeBlock` — the EXISTING embedding queue/process makes
 *    it searchable (no new store machinery, no LLM extraction).
 *
 * Embedding/capture failures are never fatal to a completed chat response:
 * the enqueue runs as a tracked background task on the response path and the
 * worker rethrows only to BullMQ's retry/backoff. Logs carry ids and fixed
 * codes only — never message text or provider bodies.
 */
import type { MemoryService } from '@workforce/core/memory';
import { userMemoryScope } from '@workforce/core/auth';

/** The chat path (exact) derived blocks are written to. */
export function personalChatPath(chatId: string): string {
  return `chats/${chatId.toLowerCase()}`;
}

/** One enqueue-side decision: capture iff the owner EXPLICITLY opted in. */
export interface PersonalCaptureEnqueuer {
  enqueueCapture(input: {
    ownerId: string;
    scope: string;
    chatId: string;
    slug: string;
    userMessageId: string;
    assistantMessageId: string;
  }): Promise<boolean>;
}

export interface PersonalMemorySettingsLike {
  get(ownerId: string): Promise<{ personalMemoryEnabled: boolean }>;
}

/** Transcript read surface the capture worker needs. */
export interface PersonalCaptureChatStore {
  loadMessages(chat: { ownerId: string; slug: string; chatId: string }): Promise<unknown[]>;
}

export interface PersonalCaptureWorkerDeps {
  /** Memory service: duplicate-check queryBlocks + writeBlock (embed pipeline). */
  readonly memory: MemoryService;
  /** Enablement re-check at processing time. */
  readonly settings: PersonalMemorySettingsLike;
  /** The chat transcript store (ids → bounded text sources). */
  readonly chatStore: PersonalCaptureChatStore;
  /** Safe logger (ids/codes only). */
  readonly logger: { debug?(message: string): void; warn?(message: string, error?: unknown): void };
}

export interface PersonalCaptureJob {
  readonly ownerId: string;
  readonly scope: string;
  readonly chatId: string;
  readonly slug: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
}

// ---------------------------------------------------------------------------
// Bounded VISIBLE-text derivation (no provider/LLM call anywhere)
// ---------------------------------------------------------------------------

/** Hard excerpt budgets (chars) for the two visible sides. */
export const PERSONAL_CAPTURE_USER_MAX_CHARS = 500;
export const PERSONAL_CAPTURE_ASSISTANT_MAX_CHARS = 500;
/** The memory content schema cap (services re-enforce it). */
const CONTENT_MAX_CHARS = 1000;

/** Joins ONLY real text parts, trimmed and bounded. */
export function visibleText(parts: unknown, maxLength: number): string {
  if (!Array.isArray(parts)) {
    return '';
  }
  const chunks: string[] = [];
  let total = 0;
  for (const part of parts) {
    if (part === null || typeof part !== 'object') {
      continue;
    }
    const record = part as { type?: unknown; text?: unknown };
    // Tool parts (inputs/outputs — may contain tool secrets/rows) and
    // reasoning parts are NEVER a capture source.
    if (record.type !== 'text' || typeof record.text !== 'string') {
      continue;
    }
    const chunk = record.text.trim();
    if (chunk.length === 0) {
      continue;
    }
    chunks.push(chunk);
    total += chunk.length;
    if (total >= maxLength) {
      break;
    }
  }
  const joined = chunks.join(' ') || '';
  return joined.length > maxLength ? joined.slice(0, maxLength) : joined;
}

/**
 * The exact written block content: labeled sides, bounded to the memory
 * content cap (1..1000 trimmed chars). Deterministic per turn.
 */
export function buildCapturedContent(input: { userParts: unknown; assistantParts: unknown }): string {
  const user = visibleText(input.userParts, PERSONAL_CAPTURE_USER_MAX_CHARS);
  const assistant = visibleText(input.assistantParts, PERSONAL_CAPTURE_ASSISTANT_MAX_CHARS);
  const raw = `[user] ${user}\n[assistant] ${assistant}`;
  return raw.length > CONTENT_MAX_CHARS ? raw.slice(0, CONTENT_MAX_CHARS) : raw;
}

/** True when NEITHER visible side carries any text (tool-only/reasoning-only/empty). */
export function hasDurableText(input: { userParts: unknown; assistantParts: unknown }): boolean {
  const user = visibleText(input.userParts, PERSONAL_CAPTURE_USER_MAX_CHARS);
  const assistant = visibleText(input.assistantParts, PERSONAL_CAPTURE_ASSISTANT_MAX_CHARS);
  return user.length > 0 || assistant.length > 0;
}

/**
 * Processes one capture job. Returns the outcome for safe logging; throws on
 * transient failures (BullMQ retry semantics handle them).
 */
export async function processPersonalCaptureJob(
  job: PersonalCaptureJob,
  deps: PersonalCaptureWorkerDeps,
): Promise<'captured' | 'disabled' | 'duplicate' | 'empty' | 'no-text'> {
  // Privacy gate FIRST: a toggle between enqueue and work suppresses the job.
  const settings = await deps.settings.get(job.ownerId);
  if (settings.personalMemoryEnabled !== true) {
    return 'disabled';
  }

  // Duplicate guard: any derived block from THIS assistant turn suppresses.
  const existing = await deps.memory.queryBlocks({
    scope: job.scope,
    path: personalChatPath(job.chatId),
    limit: 100,
    includeSuperseded: true,
  });
  for (const block of existing) {
    if (block.metadata['source'] === 'personal-chat' && block.metadata['assistantMessageId'] === job.assistantMessageId) {
      return 'duplicate';
    }
  }

  // Bounded transcript read → VISIBLE text parts of user + assistant.
  const messages = await deps.chatStore.loadMessages({ ownerId: job.ownerId, slug: job.slug, chatId: job.chatId });
  let userParts: unknown = undefined;
  let assistantParts: unknown = undefined;
  for (const entry of messages) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as { id?: unknown; role?: unknown; parts?: unknown };
    if (candidate.id === job.userMessageId && candidate.role === 'user') {
      userParts = candidate.parts;
    }
    if (candidate.id === job.assistantMessageId && candidate.role === 'assistant') {
      assistantParts = candidate.parts;
    }
  }
  if (userParts === undefined || assistantParts === undefined) {
    return 'no-text';
  }
  // No durable visible text (tool-only / reasoning-only / empty) → no block.
  if (hasDurableText({ userParts, assistantParts }) === false) {
    return 'empty';
  }

  await deps.memory.writeBlock({
    scope: job.scope,
    path: personalChatPath(job.chatId),
    kind: 'observation',
    content: buildCapturedContent({ userParts, assistantParts }),
    confidence: 0.8,
    metadata: {
      source: 'personal-chat',
      chatId: job.chatId,
      assistantMessageId: job.assistantMessageId,
    },
  });
  return 'captured';
}

/**
 * Builds the enqueue-side helper used by the chat handlers: checks the
 * enablement and returns whether a job was scheduled (disabled → false, NO
 * job at all — a disabled owner never leaves queue residue).
 */
export function createPersonalCaptureGate(deps: {
  settings: PersonalMemorySettingsLike;
  queue: PersonalCaptureEnqueuer;
  ownerId: string;
}): (input: { chatId: string; slug: string; userMessageId: string; assistantMessageId: string }) => Promise<boolean> {
  return async (input) => {
    const settings = await deps.settings.get(deps.ownerId);
    if (settings.personalMemoryEnabled !== true) {
      return false;
    }
    return deps.queue.enqueueCapture({
      ownerId: deps.ownerId,
      scope: userMemoryScope(deps.ownerId),
      chatId: input.chatId,
      slug: input.slug,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
    });
  };
}
