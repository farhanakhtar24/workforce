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
import type { PrepareStepFunction } from 'ai';
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
 * when the provider reported a parseable usage (Phase 5), and
 * `metadata.modelId` when the generation carries its model provenance
 * (pre-Phase 6). Old Phase 2/4 streams without either are unchanged.
 */
function chatTurnMessageMetadata(
  { part }: { part: TextStreamPart<ToolSet> },
  modelId: string | undefined,
): { usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; modelId?: string } | undefined {
  if (part.type !== 'finish') {
    return undefined;
  }
  const usage = usageMetadata(part.totalUsage);
  if (usage === null) {
    return undefined;
  }
  return { usage, ...(modelId !== undefined && modelId !== null ? { modelId } : {}) };
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
   * The model id this generation runs on (the chat's stored selection or the
   * configured default); persisted as `metadata.modelId` on the assistant
   * finish alongside usage (model provenance). Absent in legacy shapes.
   */
  modelId?: string;
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
   * Pre-Phase 6 opt-in personal memory: the BOUNDED untrusted reference
   * context recalled before this generation (recall module builds it). It is
   * concatenated AFTER the agent system prompt inside the SDK `system`
   * option and is treated as data by contract (header frames it).
   */
  memoryContext?: string;
  /**
   * Pre-Phase 6 hourly budget: the AGGREGATE output-token budget for this
   * generation across up to MAX_MODEL_STEPS steps (the admission's derived
   * output cap). Enforced with a prepareStep hook that divides the REMAINING
   * budget (reservation minus actual emitted output observed so far) over
   * the REMAINING possible steps. Absent = normal unbounded generation.
   */
  outputTokenBudget?: number;
  /**
   * Pre-Phase 6 opt-in personal capture hook, invoked ON THE ASSISTANT FINISH
   * after the response message was persisted (with content). The hook
   * internally checks the enablement + schedules the ONE deterministic
   * capture job; failures must never break the stream (hook owners catch).
   */
  onAssistantFinished?: (finished: AssistantTurnFinished) => void;
  /**
   * Phase 4: deadline abort signal for INTERNAL delegated child generations
   * only. Ordinary browser disconnects still never abort (no signal from the
   * public route path).
   */
  abortSignal?: AbortSignal;
}

/** Ids the capture/recall pipeline keys ONE completed assistant turn by. */
export interface AssistantTurnFinished {
  /** Chat reference the generation ran in. */
  readonly chat: CreateChatTurnStreamOptions['chat'];
  /** The persisted assistant (response) message id. */
  readonly assistantMessageId: string;
  /** The newest user message id of the turn. */
  readonly userMessageId: string;
  /** False when the generation produced no content (nothing persisted). */
  readonly hasContent: boolean;
  /**
   * The ACTUAL provider usage this finish reported (the same object attached
   * as `metadata.usage`); absent when the provider supplied none. The hourly
   * budget settlement consumes it (missing/invalid usage retains the
   * conservative reservation).
   */
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number };
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
    modelId = undefined,
    tools = agentTools,
    validationTools = agentTools,
    systemPrompt = null,
    memoryContext = undefined,
    onAssistantFinished = undefined,
    abortSignal = undefined,
  } = options;

  const modelMessages = await validateAndConvertMessages(messages, validationTools);
  if (modelMessages === null) {
    // The caller validated the newest message shape already; this can only be
    // corrupt stored chat state, which must not reach the provider.
    throw new InvalidStoredChatError();
  }
  // Phase 4: definition system prompt for NEW agents (general stays promptless)
  // — passed through the SDK `system` option, never as a message. The
  // opt-in personal-memory recall (pre-Phase 6) is appended AFTER the
  // agent prompt as bounded UNTRUSTED reference context (framed as data).
  const systemParts = [
    typeof systemPrompt === 'string' && systemPrompt.length > 0 ? systemPrompt : null,
    typeof memoryContext === 'string' && memoryContext.length > 0 ? memoryContext : null,
  ].filter((part): part is string => part !== null);
  // Hourly budget: AGGREGATE output cap across model steps, enforced BOTH
  // by per-step prepareStep(maxOutputTokens) and by a custom stopWhen.
  // - emittedTotals counts each completed step's ACTUAL output tokens (AI
  //   SDK v6: `step.usage.outputTokens` is a total number — reasoning
  //   included — or undefined when the provider did not report it).
  // - A step WITHOUT usable output usage FAILS CLOSED: no further model
  //   steps run (the reservation absorbs that step's unknown spend); the
  //   generation completes with what it streamed.
  // - Remaining allocation: each step receive an exact divisor of the
  //   remaining budget over the remaining possible steps; the final allowed
  //   step receives the EXACT remainder. The only deliberate slack is a
  //   documented 1-token floor per capped step (the provider rejects a 0
  //   cap), bounded at MAX_MODEL_STEPS − 1 extra tokens overall.
  const outputBudget = typeof options.outputTokenBudget === 'number' && Number.isFinite(options.outputTokenBudget) ? Math.max(0, Math.floor(options.outputTokenBudget)) : null;

  function emittedOutputTokens(steps: ReadonlyArray<{ readonly usage?: { readonly outputTokens?: number | undefined } }>): { total: number; sawInvalid: boolean } {
    let total = 0;
    let sawInvalid = false;
    for (const step of steps) {
      const outputTokens = step.usage?.outputTokens;
      if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0) {
        total += Math.floor(outputTokens);
      } else {
        sawInvalid = true;
      }
    }
    return { total, sawInvalid };
  }

  const prepareStep: PrepareStepFunction<ToolSet> | undefined =
    outputBudget === null
      ? undefined
      : async ({ steps }) => {
          const { total, sawInvalid } = emittedOutputTokens(steps);
          if (sawInvalid || total >= outputBudget) {
            // Fail-closed: this residual step (only reached on client-tool
            // continuation despite an exhausted/unknown budget) gets a 1
            // token allowance — the documented rounding bound.
            return { maxOutputTokens: 1 };
          }
          const remainingSteps = Math.max(1, MAX_MODEL_STEPS - steps.length);
          const budgetLeft = Math.max(0, outputBudget - total);
          return { maxOutputTokens: Math.max(1, Math.floor(budgetLeft / remainingSteps)) };
        };

  const budgetStopWhen =
    outputBudget === null
      ? undefined
      : ({ steps }: { steps: ReadonlyArray<{ readonly usage?: { readonly outputTokens?: number | undefined } }> }): boolean => {
          const { total, sawInvalid } = emittedOutputTokens(steps);
          return sawInvalid || total >= outputBudget;
        };

  const generation = {
    model,
    messages: modelMessages,
    tools,
    // Phase 4 (internal delegation only): the bounded deadline aborts the
    // provider work itself. Browser disconnects still never abort (no
    // signal from the public route path).
    ...(abortSignal !== undefined ? { abortSignal } : {}),
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
  } as const;

  const streamId = createStreamId();

  const uiMessageStream = createUIMessageStream<UIMessage>({
    originalMessages: messages,
    generateId: createMessageId,
    onError: () => STREAM_ERROR_TEXT,
    execute: ({ writer }) => {
      const result = streamText({
        ...generation,
        // Budget-capable stop condition: the step cap PLUS the aggregate
        // output budget (fail-closed on missing/invalid step usage). Without
        // a budget this is exactly the legacy stepCountIs(10).
        stopWhen: budgetStopWhen === undefined ? stepCountIs(MAX_MODEL_STEPS) : ({ steps }): boolean => steps.length >= MAX_MODEL_STEPS || budgetStopWhen({ steps }),
        // Hourly budget: per-step maxOutputTokens divided over remaining
        // steps so the AGGREGATE stays within the admitted reservation.
        ...(prepareStep !== undefined ? { prepareStep } : {}),
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
          messageMetadata: (part) => chatTurnMessageMetadata(part, modelId),
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
          // Output-capped partial tool-call protection: parts that never
          // finished STREAMING their input (`input-streaming`, state of a
          // part whose tool-call chunk never arrived) are OMITTED before
          // persistence so the stored transcript can never hold a
          // malformed/incomplete tool call fragment that would brick future
          // validate/convert. The HITL `input-available` ask_user state IS a
          // valid persisted terminal (resolved later by the byte-CAS route)
          // and `output-available`/`output-error` cards are untouched.
          if (responseMessage.parts.some((part) => isNonTerminalToolPart(part))) {
            responseMessage.parts = responseMessage.parts.filter((part) => isNonTerminalToolPart(part) === false);
          }
          await store.appendMessage(ref, responseMessage);
        }
        await store.clearActiveStreamId(ref, streamId);
        // Opt-in personal capture: scheduled AFTER persistence, never on the
        // response path (the hook is fire-and-forget; the owner of the hook
        // catches its own failures).
        if (onAssistantFinished !== undefined && hasContent) {
          // The user message may not be the very last entry on HITL-resume
          // turns; scan backwards for role 'user'.
          const userMessageId = [...messages].reverse().find((entry) => entry.role === 'user')?.id ?? '';
          const finishedUsage = responseMessage.metadata ?? {};
          const usageRecord = (finishedUsage as { usage?: Record<string, unknown> }).usage ?? {};
          const usage =
            typeof usageRecord['inputTokens'] === 'number' || typeof usageRecord['outputTokens'] === 'number'
              ? {
                  inputTokens: typeof usageRecord['inputTokens'] === 'number' ? usageRecord['inputTokens'] : undefined,
                  outputTokens: typeof usageRecord['outputTokens'] === 'number' ? usageRecord['outputTokens'] : undefined,
                  totalTokens: typeof usageRecord['totalTokens'] === 'number' ? usageRecord['totalTokens'] : undefined,
                }
              : undefined;
          onAssistantFinished({
            chat: ref,
            assistantMessageId: responseMessage.id,
            userMessageId,
            hasContent,
            usage,
          });
        }
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

/**
 * True for tool parts whose input never finished streaming (a budget-cut
 * tool call fragment). `input-available` is the VALID persisted HITL
 * terminal state for ask_user (resolved later by the byte-CAS route), so it
 * is preserved; `output-available`/`output-error` cards are untouched.
 */
function isNonTerminalToolPart(part: unknown): boolean {
  if (part === null || typeof part !== 'object') {
    return false;
  }
  const record = part as { type?: unknown; state?: unknown };
  if (typeof record.type !== 'string' || record.type.startsWith('tool-') === false) {
    return false;
  }
  return record.state === 'input-streaming';
}

/** Stored chat state failed re-validation; surfaced as a plain 503. */
export class InvalidStoredChatError extends Error {
  constructor() {
    super('Stored chat state is invalid.');
    this.name = 'InvalidStoredChatError';
  }
}
