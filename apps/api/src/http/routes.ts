/**
 * Phase 2 routes (ADR-005 endpoint table):
 * - GET  /health
 * - GET  /api/agents/:slug/chat/:clientChatId          — hydration
 * - POST /api/agents/:slug/chat                        — generation + SSE
 * - GET  /api/agents/:slug/chat/:clientChatId/stream   — resume (204 when none)
 *
 * Error contract: every failure is JSON `{ "error": "<fixed safe message>" }`
 * with no provider bodies, stacks, or secrets. Redis failures are 503
 * everywhere chat state is touched: without Redis, exactly-once generation
 * and resume guarantees cannot be honored, so the API says so (ADR-005).
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from 'ai';
import { IDEMPOTENCY_KEY_TTL_SECONDS, type ChatStore, type ChatRef } from '../store/types.js';
import type { StreamContext } from '../stream-context/types.js';
import type { ApiConfig } from '../config.js';
import type { CreateChatTurnStreamOptions } from '../generation.js';
import { createChatTurnStream, InvalidStoredChatError } from '../generation.js';
import { agentTools, validateAndConvertMessages } from '../messages.js';
import { sendJsonError, sendWebResponse } from '../http/adapter.js';
import {
  chatRequestSchema,
  clientIdSchema,
  idempotencyKeySchema,
  isKnownSlug,
} from '../validation.js';

const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export interface ChatRoutesDeps {
  config: Pick<ApiConfig, 'webOrigin'>;
  store: ChatStore;
  streamContext: StreamContext;
  /** Injected model (real Ollama-compatible model in `server.ts`, mock in tests). */
  model: CreateChatTurnStreamOptions['model'];
  background: CreateChatTurnStreamOptions['background'];
  logger: CreateChatTurnStreamOptions['logger'];
}

/** Runs an async handler, forwarding rejections to Express' error handling. */
function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

const NO_STORE_HEADERS: Record<string, string> = { 'Cache-Control': 'no-store' };

function chatRefFromRequest(slug: string, clientChatId: string): ChatRef {
  return { slug, chatId: clientChatId };
}

export interface ChatRouteHandlers {
  health: RequestHandler;
  hydration: RequestHandler;
  postChat: RequestHandler;
  resumeStream: RequestHandler;
}

export function createChatRoutes(deps: ChatRoutesDeps): ChatRouteHandlers {
  const { store, streamContext, model, background, logger } = deps;

  /**
   * Compare-and-delete the active stream marker. Best-effort: the resume path
   * already knows the stream is not live, so a cleanup failure only logs — it
   * must not turn the safe 204 into an error. Only a matching ID can be
   * deleted (a stale completion never clears a newer stream's marker).
   */
  const clearActiveMarkerBestEffort = async (chat: ChatRef, activeStreamId: string): Promise<void> => {
    try {
      await store.clearActiveStreamId(chat, activeStreamId);
    } catch (error) {
      logger.error('resume-active-stream-cleanup', error);
    }
  };

  const health: RequestHandler = (_req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ status: 'ok' }));
  };

  const hydration = asyncRoute(async (req: Request, res: Response) => {
    const slug = req.params['slug'] ?? '';
    const clientChatId = req.params['clientChatId'] ?? '';
    if (!isKnownSlug(slug)) {
      sendJsonError(res, 404, 'Unknown agent slug.');
      return;
    }
    const idCheck = clientIdSchema.safeParse(clientChatId);
    if (!idCheck.success) {
      sendJsonError(res, 400, 'clientChatId must be 1-64 characters of A-Z a-z 0-9 _ -');
      return;
    }
    const chat = chatRefFromRequest(slug, clientChatId);
    let rawMessages: unknown[];
    let activeStreamId: string | null;
    try {
      rawMessages = await store.loadMessages(chat);
      activeStreamId = await store.getActiveStreamId(chat);
    } catch (error) {
      logger.error('hydration-store', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        messages: rawMessages,
        hasActiveStream: activeStreamId !== null,
      }),
    );
  });


  const postChat = asyncRoute(async (req: Request, res: Response) => {
    const slug = req.params['slug'] ?? '';
    if (!isKnownSlug(slug)) {
      sendJsonError(res, 404, 'Unknown agent slug.');
      return;
    }
    if (!req.is('application/json')) {
      sendJsonError(res, 415, 'Content-Type must be application/json.');
      return;
    }
    const bodyCheck = chatRequestSchema.safeParse(req.body);
    if (!bodyCheck.success) {
      sendJsonError(res, 400, 'Request body must be exactly { "id": string, "message": newest user message }.');
      return;
    }
    const { id: chatId, message } = bodyCheck.data;

    const headerKey = req.get(IDEMPOTENCY_HEADER) ?? undefined;
    const headerCheck = typeof headerKey === 'string' ? idempotencyKeySchema.safeParse(headerKey) : null;
    if (typeof headerKey !== 'string' || !headerCheck?.success) {
      sendJsonError(res, 400, 'Idempotency-Key header is required and must equal "{chatId}:{messageId}".');
      return;
    }
    if (headerKey !== `${chatId}:${message.id}`) {
      sendJsonError(res, 400, 'Idempotency-Key must equal "{chatId}:{messageId}".');
      return;
    }

    const chat = chatRefFromRequest(slug, chatId);

    // ---- Redis-backed pre-stream setup; any failure releases what it acquired.
    let stored: unknown[];
    try {
      stored = await store.loadMessages(chat);
    } catch (error) {
      logger.error('chat-store-load', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }

    // Fail fast on a duplicate user message ID before anything expensive.
    const duplicate = stored.some(
      (previous) =>
        previous !== null &&
        typeof previous === 'object' &&
        'id' in previous &&
        (previous as { id?: unknown }).id === message.id,
    );
    if (duplicate) {
      sendJsonError(res, 409, 'A message with this id already exists in this chat.');
      return;
    }

    // Validate the complete appended conversation BEFORE anything durable
    // happens: an invalid newest message must acquire no key, append nothing,
    // and brick no later turns. If the whole list fails, classify by
    // validating the stored history alone — it failing means server-side
    // corrupt state (503); it passing means the newest body is invalid (400).
    // Neither path touches the provider.
    const appendedConversation = [...stored, message] as UIMessage[];
    const conversationValid = await validateAndConvertMessages(appendedConversation, agentTools);
    if (conversationValid === null) {
      // Note: validateUIMessages rejects empty lists, so an empty stored
      // history counts as valid-by-vacuity here — only genuinely corrupt
      // entries must 503.
      const storedValid =
        stored.length === 0 ||
        (await validateAndConvertMessages(stored as UIMessage[], agentTools)) !== null;
      if (!storedValid) {
        logger.warn('chat-stored-state-unreadable');
        sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
        return;
      }
      sendJsonError(res, 400, 'Message failed validation for this chat.');
      return;
    }

    // Exactly-once generation guard BEFORE any provider work (ADR-005).
    let acquired = false;
    try {
      acquired = await store.acquireIdempotencyKey(chat, headerKey, IDEMPOTENCY_KEY_TTL_SECONDS);
    } catch (error) {
      logger.error('chat-idempotency-acquire', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    if (!acquired) {
      sendJsonError(res, 409, 'A generation for this message is already in progress or completed. Resume instead.');
      return;
    }

    // Persist the user message BEFORE generation starts: a single atomic
    // append — concurrent turns cannot corrupt each other's list entries.
    const messages = appendedConversation;
    try {
      await store.appendMessage(chat, message as unknown as UIMessage);
    } catch (error) {
      logger.error('chat-store-save', error);
      try {
        await store.releaseIdempotencyKey(chat, headerKey);
      } catch (releaseError) {
        logger.error('chat-idempotency-release', releaseError);
      }
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }

    // Hand off to generation. From here on the key is never released: once the
    // stream has started, retries go through resume instead (ADR-005).
    let turn;
    try {
      turn = await createChatTurnStream({
        chat,
        messages,
        store,
        streamContext,
        background,
        logger,
        model,
      });
    } catch (error) {
      if (error instanceof InvalidStoredChatError) {
        // Generation never started: release the key we acquired.
        try {
          await store.releaseIdempotencyKey(chat, headerKey);
        } catch (releaseError) {
          logger.error('chat-idempotency-release', releaseError);
        }
        sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
        return;
      }
      logger.error('chat-turn-setup', error);
      try {
        await store.releaseIdempotencyKey(chat, headerKey);
      } catch (releaseError) {
        logger.error('chat-idempotency-release', releaseError);
      }
      sendJsonError(res, 502, 'The generation could not be started. Please try again.');
      return;
    }

    try {
      await store.setActiveStreamId(chat, turn.streamId);
    } catch (error) {
      logger.error('chat-active-stream', error);
      // No SSE byte has been sent yet: safe to release and fail cleanly.
      try {
        await store.releaseIdempotencyKey(chat, headerKey);
      } catch (releaseError) {
        logger.error('chat-idempotency-release', releaseError);
      }
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }

    await sendWebResponse(turn.response, res);
  });

  const resumeStream = asyncRoute(async (req: Request, res: Response) => {
    const slug = req.params['slug'] ?? '';
    const clientChatId = req.params['clientChatId'] ?? '';
    if (!isKnownSlug(slug)) {
      sendJsonError(res, 404, 'Unknown agent slug.');
      return;
    }
    const idCheck = clientIdSchema.safeParse(clientChatId);
    if (!idCheck.success) {
      sendJsonError(res, 400, 'clientChatId must be 1-64 characters of A-Z a-z 0-9 _ -');
      return;
    }
    const chat = chatRefFromRequest(slug, clientChatId);

    let activeStreamId: string | null;
    try {
      activeStreamId = await store.getActiveStreamId(chat);
    } catch (error) {
      logger.error('resume-store', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    if (activeStreamId === null) {
      sendWebResponse(new Response(null, { status: 204, headers: NO_STORE_HEADERS }), res);
      return;
    }

    let resumed: ReadableStream<string> | null | undefined;
    try {
      resumed = await streamContext.resumeExistingStream(activeStreamId);
    } catch (error) {
      // Post-crash stale producer: the resumable-stream ack times out because
      // no producer is alive for this checkpoint. The stream is unresumable —
      // best-effort compare-and-delete the marker and let the client fall
      // back to hydration, exactly like a finished stream.
      if (error instanceof Error && error.message === 'Timeout waiting for ack') {
        await clearActiveMarkerBestEffort(chat, activeStreamId);
        sendWebResponse(new Response(null, { status: 204, headers: NO_STORE_HEADERS }), res);
        return;
      }
      logger.error('resume-stream', error);
      sendJsonError(res, 503, 'Stream resume is temporarily unavailable.');
      return;
    }
    // `undefined` = no stream exists at all (crash before checkpointing),
    // `null` = fully done. Either way the marker no longer points at a live
    // stream: compare-and-delete it so the next hydration shows no active
    // stream, then answer 204 (the client falls back to hydration).
    if (resumed === undefined || resumed === null) {
      await clearActiveMarkerBestEffort(chat, activeStreamId);
      sendWebResponse(new Response(null, { status: 204, headers: NO_STORE_HEADERS }), res);
      return;
    }

    const sseResponse = new Response(
      resumed.pipeThrough(new TextEncoderStream()),
      { status: 200, headers: UI_MESSAGE_STREAM_HEADERS },
    );
    sendWebResponse(sseResponse, res);
  });

  return { health, hydration, postChat, resumeStream };
}
