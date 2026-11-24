/**
 * One chat turn: user message → persisted → `streamText` → UI message stream
 * with a durable resumable copy (ADR-005/ADR-008).
 *
 * Lifecycle rules encoded here:
 * - The caller acquires the idempotency key before invoking this module; the
 *   assistant generation here is the "generation" the key protects.
 * - The user message is persisted BEFORE generation starts.
 * - The active stream ID is written before the response is attached and is
 *   cleared only by an equal-ID compare/delete at completion.
 * - The resumable copy is pumped by a tracked background promise; a client
 *   disconnect neither aborts the model nor deletes the active marker, and
 *   replay is always full.
 * - Provider failures become a safe stream error part; raw provider bodies
 *   and secrets never reach the wire (errors are replaced by fixed text).
 */
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  stepCountIs,
  type LanguageModel,
  type ToolSet,
  type TextStreamPart,
  type UIMessage,
} from 'ai';
import type { ChatStore, ChatRef } from './store/types.js';
import type { StreamContext } from './stream-context/types.js';
import type { BackgroundTaskTracker } from './background.js';
import type { SafeLogger } from './logging.js';
import { agentTools, MAX_MODEL_STEPS, validateAndConvertMessages } from './messages.js';
import { createMessageId, createStreamId } from './ids.js';

/** Fixed safe text used whenever generation fails — nothing else ships. */
export const STREAM_ERROR_TEXT = 'An error occurred while generating the response. Please try again.';

/** Upper bound for a single usage counter (matches the scheduler domain bound). */
export const MAX_USAGE_TOKEN_COUNT = 2_147_483_647 as const;

/**
 * Bounded, scheduler-shape token usage from the normalized AI SDK usage: only
 * finite nonnegative integers survive; the object is omitted entirely when no
 * field is valid (usage is never fabricated). `metadata.usage` rides along on
 * the assistant message for every consumer (scheduler executions read it;
 * other chats may simply ignore it).
 */
export function usageMetadata(usage: LanguageModelUsageLike): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | null {
  const bounded = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_USAGE_TOKEN_COUNT) {
      return undefined;
    }
    return value;
  };
  const inputTokens = bounded(usage.inputTokens);
  const outputTokens = bounded(usage.outputTokens);
  const totalTokens = bounded(usage.totalTokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return null;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/** Structural surface of the normalized AI SDK usage object (v6). */
interface LanguageModelUsageLike {
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly totalTokens?: unknown;
}

/**
 * `messageMetadata` for `toUIMessageStream`: emits `metadata.usage` on finish
 * when the provider reported a parseable usage (Phase 5). Old Phase 2/4
 * streams without usage metadata are unchanged (the chunks simply carry no
 * `messageMetadata`).
 */
function chatTurnMessageMetadata({ part }: { part: TextStreamPart<ToolSet> }): { usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } } | undefined {
  if (part.type !== 'finish') {
    return undefined;
  }
  const usage = usageMetadata(part.totalUsage);
  return usage === null ? undefined : { usage };
}

export interface CreateChatTurnStreamOptions {
  chat: ChatRef;
  /**
   * Stored messages (prior turns) plus the newly appended, already-validated
   * newest user message, in order.
   */
  messages: UIMessage[];
  store: ChatStore;
  streamContext: StreamContext;
  background: BackgroundTaskTracker;
  logger: SafeLogger;
  model: LanguageModel;
  /**
   * Phase 4: COMPOSED tools for this generation (plan/depth filtered) and the
   * agent's FULL allowed action set used for transcript validation. Both
   * default to the Phase 2 `{calculate}` set — `general` is unchanged.
   */
  tools?: ToolSet;
  validationTools?: ToolSet;
  /** Phase 4: definition system prompt for NEW agents; `null`/absent = none. */
  systemPrompt?: string | null;
  /**
   * Phase 4: deadline abort signal for INTERNAL delegated child generations
   * only. Ordinary browser disconnects still never abort (no signal from the
   * public route path).
   */
  abortSignal?: AbortSignal;
}

export interface ChatTurn {
  /** Server-generated durable stream ID (also written to the store). */
  streamId: string;
  /** Web `Response` carrying the UI message stream as SSE. */
  response: Response;
}

export async function createChatTurnStream(options: CreateChatTurnStreamOptions): Promise<ChatTurn> {
  const {
    chat: ref,
    messages,
    store,
    streamContext,
    background,
    logger,
    model,
    tools = agentTools,
    validationTools = agentTools,
    systemPrompt = null,
    abortSignal = undefined,
  } = options;

  const modelMessages = await validateAndConvertMessages(messages, validationTools);
  if (modelMessages === null) {
    // The caller validated the newest message shape already; this can only be
    // corrupt stored chat state, which must not reach the provider.
    throw new InvalidStoredChatError();
  }
  // Phase 4: definition system prompt for NEW agents (general stays promptless)
  // — passed through the SDK `system` option, never as a message.
  const generation = {
    model,
    messages: modelMessages,
    tools,
    // Phase 4 (internal delegation only): the bounded deadline aborts the
    // provider work itself. Browser disconnects still never abort (no
    // signal from the public route path).
    ...(abortSignal !== undefined ? { abortSignal } : {}),
    ...(typeof systemPrompt === 'string' && systemPrompt.length > 0 ? { system: systemPrompt } : {}),
  } as const;

  const streamId = createStreamId();

  const uiMessageStream = createUIMessageStream<UIMessage>({
    originalMessages: messages,
    generateId: createMessageId,
    onError: () => STREAM_ERROR_TEXT,
    execute: ({ writer }) => {
      const result = streamText({
        ...generation,
        stopWhen: stepCountIs(MAX_MODEL_STEPS),
        onError: (event) => {
          logger.error('provider-stream-failure', event.error);
        },
      });
      writer.merge(
        result.toUIMessageStream({
          generateMessageId: createMessageId,
          originalMessages: messages,
          // Provider/stream failures must never ship provider output.
          onError: () => STREAM_ERROR_TEXT,
          // Phase 5: bounded `metadata.usage` on finish (never fabricated).
          messageMetadata: chatTurnMessageMetadata,
        }),
      );
    },
    onFinish: async ({ responseMessage }) => {
      const context = 'chat-turn-finish';
      try {
        // Append-only persistence (never whole-list overwrite): concurrent
        // turns keep every message, and this completion adds exactly its own
        // response — with streamed text and tool parts (ADR-008). A failed
        // generation that produced no content appends nothing (the user
        // message was already appended separately).
        const hasContent = responseMessage.parts.some((part) => part.type !== 'step-start');
        if (hasContent) {
          await store.appendMessage(ref, responseMessage);
        }
        await store.clearActiveStreamId(ref, streamId);
      } catch (error) {
        logger.error(context, error);
      }
    },
  });

  // Durable replica consumed off the request path: registered as a tracked
  // background task so shutdown waits for it (Express has no after()).
  const response = createUIMessageStreamResponse({
    stream: uiMessageStream,
    consumeSseStream: ({ stream }) => {
      background.track(
        streamContext
          .createNewResumableStream(streamId, () => stream)
          .then(() => undefined)
          .catch((error: unknown) => {
            logger.error('chat-turn-checkpoint', error);
          }),
      );
    },
  });

  return { streamId, response };
}

/** Stored chat state failed re-validation; surfaced as a plain 503. */
export class InvalidStoredChatError extends Error {
  constructor() {
    super('Stored chat state is invalid.');
    this.name = 'InvalidStoredChatError';
  }
}
