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
import { z } from 'zod';
import {
  ASK_USER_NO_ANSWER,
  IDEMPOTENCY_KEY_TTL_SECONDS,
  type AskUserAnswerStatus,
  type ChatStore,
  type ChatRef,
} from '../store/types.js';
import type { StreamContext } from '../stream-context/types.js';
import type { ApiConfig } from '../config.js';
import type { CreateChatTurnStreamOptions } from '../generation.js';
import { createChatTurnStream, InvalidStoredChatError } from '../generation.js';
import { agentTools, validateAndConvertMessages } from '../messages.js';
import { sendJsonError, sendWebResponse } from '../http/adapter.js';
import { AUTH_401_MESSAGE, ownerOf, type AuthOwner } from '../auth/owner.js';
import { isBlockedModelId, isModelId, MODEL_LOCK_REASON, ModelCatalogUnavailableError, type ModelCatalogLike } from '../models/catalog.js';
import { summarizeChatUsage } from '../usage/usage.js';
import {
  chatRequestSchema,
  clientIdSchema,
  idempotencyKeySchema,
  isKnownSlug,
  messageIdSchema,
  toUIMessageInput,
  type ChatMode,
} from '../validation.js';
import {
  DELEGATION_CONTEXT_HEADER,
  type DelegationContextSigner,
} from '../agents/delegation-context.js';
import { MAX_DELEGATION_DEPTH } from '@workforce/core';
import type { MemoryService } from '@workforce/core/memory';
import { userMemoryScope } from '@workforce/core/auth';
import type { HostCapabilityDeps } from '../agents/host-capabilities.js';
import { prepareGeneration } from '../agents/toolsets.js';
import type { SettingsServiceLike } from '../settings/settings.js';
import type { PersonalCaptureEnqueuer } from '../memory/personal-capture.js';
import { personalChatPath } from '../memory/personal-capture.js';
import { recallPersonalMemory, type PersonalRecallDeps } from '../memory/personal-recall.js';

const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export interface ChatRoutesDeps {
  config: Pick<ApiConfig, 'webOrigin' | 'blockedModelPrefixes' | 'modelPricing' | 'model'>;
  store: ChatStore;
  streamContext: StreamContext;
  /** Injected model (real Ollama-compatible model in `server.ts`, mock in tests). */
  model: CreateChatTurnStreamOptions['model'];
  background: CreateChatTurnStreamOptions['background'];
  logger: CreateChatTurnStreamOptions['logger'];
  /**
   * Pre-Phase 6 model composition. When absent, `deps.model` is used for every
   * chat (exact legacy behavior; mock-model tests unchanged) and the
   * `/api/models*` + per-chat `/model` routes are absent.
   */
  models?: {
    readonly catalog: ModelCatalogLike;
    readonly modelFor: (modelId: string) => CreateChatTurnStreamOptions['model'];
    readonly defaultModelId: string;
  };
  /**
   * Phase 4 agent runtime. When absent, only `general` is servable and every
   * other slug stays 404 (byte-compatible legacy surface for old callers).
   */
  agents?: {
    /** Capability-tool composition dependencies (fetch/baseUrl/signer/...). */
    hostDeps: HostCapabilityDeps;
    /** Verifier for the internal delegation context header (mint happens in-process). */
    signer: DelegationContextSigner;
  };
  /**
   * Pre-Phase 6 opt-in personal memory. When absent: ZERO capture, ZERO
   * recall, ZERO purge (exact legacy chat behavior). When present, all three
   * are gated per owner by the explicit `personalMemoryEnabled` setting.
   */
  personal?: {
    /** Settings read (per-owner opt-in gate). */
    readonly settings: SettingsServiceLike;
    /** Memory service read/write surfaces used by recall/purge. */
    readonly memory: MemoryService;
    /** Deterministic capture-job enqueuer (checked enablement → 1 job). */
    readonly capture: PersonalCaptureEnqueuer;
  };
}

/** The single model-id contract (server-side; catalog + routes share it). */
const modelIdPatternSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/, 'modelId must be 1-80 characters of A-Z a-z 0-9 . _ : -');

/** POST /model body: strict { modelId } (exactly one field). */
const modelBodySchema = z.strictObject({ modelId: modelIdPatternSchema });

/** POST /branch body: strict { messageId, newChatId }. */
const branchBodySchema = z.strictObject({ messageId: messageIdSchema, newChatId: clientIdSchema });
/** POST /rewind body: strict { messageId }. */
const rewindBodySchema = z.strictObject({ messageId: messageIdSchema });

/** Runs an async handler, forwarding rejections to Express' error handling. */
function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

const NO_STORE_HEADERS: Record<string, string> = { 'Cache-Control': 'no-store' };

function chatRefFromRequest(ownerId: string, slug: string, clientChatId: string): ChatRef {
  return { ownerId, slug, chatId: clientChatId };
}

/** Fixed 401 guard inside every chat handler (defense in depth vs middleware). */
function ownerOr401(res: Response): AuthOwner | null {
  const owner = ownerOf(res);
  if (owner === null) {
    sendJsonError(res, 401, AUTH_401_MESSAGE);
    return null;
  }
  return owner;
}

// ---------------------------------------------------------------------------
// Phase 4: agent composition + trusted depth + HITL ask_user resolution
// ---------------------------------------------------------------------------

interface PendingAskUserPart {
  readonly messageId: string;
  readonly toolCallId: string;
  /** true → newest pending question; receives the actual new user text. */
  readonly newest: boolean;
}

/**
 * Finds ALL pending (`input-available`) ask_user tool parts across stored
 * assistant messages, newest first: the newest pending MESSAGE (even when the
 * latest assistant message itself has none) receives the actual answer, and
 * every OLDER pending question gets the bounded sentinel — so no stale tool
 * call can permanently wedge the conversation.
 */
function findPendingAskUserParts(stored: unknown[]): PendingAskUserPart[] {
  const pendingMessages: PendingAskUserPart[][] = []; // newest message group first
  for (let index = stored.length - 1; index >= 0; index -= 1) {
    const entry = stored[index];
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const message = entry as { role?: unknown; id?: unknown; parts?: unknown };
    if (message.role !== 'assistant' || typeof message.id !== 'string' || !Array.isArray(message.parts)) {
      continue;
    }
    const pending: PendingAskUserPart[] = [];
    for (const part of message.parts) {
      if (
        part !== null && typeof part === 'object' &&
        (part as Record<string, unknown>)['type'] === 'tool-ask_user' &&
        (part as Record<string, unknown>)['state'] === 'input-available' &&
        typeof (part as Record<string, unknown>)['toolCallId'] === 'string'
      ) {
        pending.push({ messageId: message.id, toolCallId: (part as Record<string, unknown>)['toolCallId'] as string, newest: false });
      }
    }
    if (pending.length > 0) {
      pendingMessages.push(pending);
    }
  }
  // The first (newest) pending MESSAGE carries the real answer; every older
  // pending part gets the bounded sentinel at the call site.
  return pendingMessages.flatMap((group, groupIndex) =>
    group.map((part) => ({ messageId: part.messageId, toolCallId: part.toolCallId, newest: groupIndex === 0 })),
  );
}

/** Joined text of the newest user message (the `ask_user` answer payload). */
function newestUserText(message: UIMessage): string {
  const text = message.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  return text.length > 0 ? text : '(no text)';
}

interface ResolvedDelegationContext {
  readonly depth: number;
  readonly deadline: number;
}

type DelegationContextCheck =
  | { ok: true; context: ResolvedDelegationContext | null }
  | { ok: false; status: 400 | 403 };

/**
 * Verifies the internal delegation context header. Absent header = depth 0
 * (root chat). A PRESENT but invalid/expired/forged/misbound header is a
 * fixed 400 — depth can never enter through client body fields — and the
 * same strictness now binds the context's `ownerId`: the payload must name
 * the RESOLVED owner (browser session or the signed internal context the
 * requireOwner middleware accepted), so one user's delegation header can
 * never drive another user's chat. A VALID signature claiming an impossible
 * depth (> MAX_DELEGATION_DEPTH) is a 403.
 */
function resolveDelegationChatContext(
  deps: ChatRoutesDeps,
  headerValue: string | undefined,
  slug: string,
  chatId: string,
  ownerId: string,
): DelegationContextCheck {
  if (headerValue === undefined || headerValue.length === 0) {
    return { ok: true, context: null };
  }
  if (deps.agents === undefined) {
    return { ok: false, status: 400 };
  }
  const expectedTarget = slug === 'analyst' || slug === 'researcher' ? (slug as 'analyst' | 'researcher') : undefined;
  if (expectedTarget === undefined) {
    // Only worker slugs may be delegation targets; a "child orchestrator" or
    // child general context is forged regardless of its signature.
    return { ok: false, status: 400 };
  }
  const verified = deps.agents.signer.verify(headerValue, {
    kind: 'delegation-child-chat',
    childChatId: chatId,
    targetAgent: expectedTarget,
    ownerId,
  });
  if (!verified.ok) {
    return { ok: false, status: 400 };
  }
  const payload = verified.payload;
  if (payload.kind !== 'delegation-child-chat') {
    return { ok: false, status: 400 };
  }
  if (typeof payload.depth !== 'number' || !Number.isInteger(payload.depth) || payload.depth < 1) {
    return { ok: false, status: 400 };
  }
  if (payload.depth > MAX_DELEGATION_DEPTH) {
    // A grandchild (depth 2) + delegation → depth 3: the cap forbids it.
    return { ok: false, status: 403 };
  }
  if (typeof payload.deadline !== 'number' || !Number.isFinite(payload.deadline) || payload.deadline <= Date.now()) {
    return { ok: false, status: 400 };
  }
  return { ok: true, context: { depth: payload.depth, deadline: payload.deadline } };
}

/** Joins text parts of a UIMessage for validate helpers (structural, bounded). */
function toUIMessages(values: readonly unknown[]): UIMessage[] {
  return values as UIMessage[];
}

/**
 * Resolves the chat's effective model id: the STORED selection when present,
 * else the configured DEFAULT. The legacy single-model path (no model
 * composition wired) still resolves the configured default id for metadata.
 */
function resolveDefaultModelId(deps: ChatRoutesDeps): string {
  return deps.models?.defaultModelId ?? deps.config.model;
}

/** Picks the generation model: factory by chat id, or the injected single model (tests). */
function resolveGenerationModel(deps: ChatRoutesDeps, chatModelId: string): CreateChatTurnStreamOptions['model'] {
  return deps.models !== undefined ? deps.models.modelFor(chatModelId) : deps.model;
}

export interface ChatRouteHandlers {
  health: RequestHandler;
  hydration: RequestHandler;
  postChat: RequestHandler;
  resumeStream: RequestHandler;
  /** DELETE the whole owner-scoped chat (destructive). */
  deleteChat: RequestHandler;
  /** POST a branch through a selected message into a NEW chat. */
  branchChat: RequestHandler;
  /** POST a destructive rewind: keep messages through the selection, drop the tail. */
  rewindChat: RequestHandler;
  /** GET the chat's selected (or default) model id. */
  getModel: RequestHandler;
  /** PUT a validated model selection (blocked/absent → fixed 400). */
  setModel: RequestHandler;
  /** GET bounded per-chat token/cost usage (this owner's transcript only). */
  usage: RequestHandler;
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

  // ---------------------------------------------------------------------------
  // Chat mutations (pre-Phase 6 lifecycle): owner-scoped delete / branch /
  // destructive rewind. Fixed safe errors; ids ONLY from the path (and the
  // strict body for branch/rewind); the owner is ONLY the resolved identity.
  // ---------------------------------------------------------------------------

  /** Shared slug+chatId validation for the mutation routes. */
  function parseMutationTarget(req: Request, res: Response): { ownerId: string; slug: string; clientChatId: string } | null {
    const owner = ownerOf(res);
    if (owner === null) {
      sendJsonError(res, 401, AUTH_401_MESSAGE);
      return null;
    }
    const slug = req.params['slug'] ?? '';
    if (!isKnownSlug(slug)) {
      sendJsonError(res, 404, 'Unknown agent slug.');
      return null;
    }
    const clientChatId = req.params['clientChatId'] ?? '';
    const idCheck = clientIdSchema.safeParse(clientChatId);
    if (!idCheck.success) {
      sendJsonError(res, 400, 'clientChatId must be 1-64 characters of A-Z a-z 0-9 _ -');
      return null;
    }
    return { ownerId: owner.userId, slug, clientChatId };
  }

  /** DELETE /api/agents/:slug/chat/:clientChatId — owner-scoped destructive delete. */
  const deleteChat = asyncRoute(async (req: Request, res: Response) => {
    const target = parseMutationTarget(req, res);
    if (target === null) {
      return;
    }
    const chat = chatRefFromRequest(target.ownerId, target.slug, target.clientChatId);
    // Busy precheck BEFORE any derived-memory work: an active generation must
    // cost ZERO purge (the Lua busy check stays authoritative for races).
    let activeStreamId: string | null = null;
    try {
      activeStreamId = await store.getActiveStreamId(chat);
    } catch (error) {
      logger.error('chat-delete-store', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    if (activeStreamId !== null) {
      sendJsonError(res, 409, 'Chat has an active generation. Resume or wait.');
      return;
    }
    // FORGOTTEN CHATS: the derived personal memory is purged BEFORE the
    // destructive Redis delete (explicit post-mutation-independence: a purge
    // failure aborts the delete with the transcript still intact, so the
    // response NEVER claims a deletion it did not perform). The purge is
    // strictly owner-scoped (scope + exact chats/{chatId} path) and touches
    // no other chat's memory.
    let purgedPersonalMemoryBlocks = 0;
    if (deps.personal !== undefined) {
      try {
        purgedPersonalMemoryBlocks = await deps.personal.memory.purgeDerivedChatMemory({
          scope: userMemoryScope(target.ownerId),
          path: personalChatPath(target.clientChatId),
        });
      } catch (error) {
        logger.error('personal-memory-purge-delete', error);
        sendJsonError(res, 503, 'Personal memory cleanup failed. Retry the delete.');
        return;
      }
    }
    // Artifacts survive by contract: WorkDocs, delegation audit rows,
    // AgentTask/execution history, delegated child chats, and every other
    // owner's data are never deleted here (see `store.deleteChat` docs).
    let result;
    try {
      result = await store.deleteChat(chat);
    } catch (error) {
      logger.error('chat-delete-store', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    if (result.status === 'busy') {
      sendJsonError(res, 409, 'Chat has an active generation. Resume or wait.');
      return;
    }
    if (result.status === 'not-found') {
      sendJsonError(res, 404, 'Chat not found.');
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ deleted: true, purgedPersonalMemoryBlocks }));
  });

  /** POST /branch body: strict { messageId, newChatId }. */
  const branchChat = asyncRoute(async (req: Request, res: Response) => {
    const target = parseMutationTarget(req, res);
    if (target === null) {
      return;
    }
    if (!req.is('application/json')) {
      sendJsonError(res, 415, 'Content-Type must be application/json.');
      return;
    }
    const body = branchBodySchema.safeParse(req.body);
    if (!body.success) {
      sendJsonError(res, 400, 'Branch must be exactly { messageId, newChatId }.');
      return;
    }
    const source = chatRefFromRequest(target.ownerId, target.slug, target.clientChatId);
    let result;
    try {
      // No provider call, no source mutation (active-stream marker included);
      // the destination index is written atomically with the copied entries.
      result = await store.branchChat(source, { messageId: body.data.messageId, newChatId: body.data.newChatId });
    } catch (error) {
      logger.error('chat-branch-store', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    if (result.status === 'chat-not-found') {
      sendJsonError(res, 404, 'Chat not found.');
      return;
    }
    if (result.status === 'message-not-found') {
      sendJsonError(res, 404, 'Message not found.');
      return;
    }
    if (result.status === 'destination-conflict') {
      sendJsonError(res, 409, 'Destination chat already exists.');
      return;
    }
    res.status(201);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        branched: true,
        destinationChatId: body.data.newChatId,
        copiedMessages: result.copiedMessages,
      }),
    );
  });

  /** POST /rewind body: strict { messageId }. */
  const rewindChat = asyncRoute(async (req: Request, res: Response) => {
    const target = parseMutationTarget(req, res);
    if (target === null) {
      return;
    }
    if (!req.is('application/json')) {
      sendJsonError(res, 415, 'Content-Type must be application/json.');
      return;
    }
    const body = rewindBodySchema.safeParse(req.body);
    if (!body.success) {
      sendJsonError(res, 400, 'Rewind must be exactly { messageId }.');
      return;
    }
    const chat = chatRefFromRequest(target.ownerId, target.slug, target.clientChatId);
    // Generations must not be rewound mid-flight: the marker is the exact
    // contract, and the destructive trim only ever runs without it.
    let activeStreamId: string | null = null;
    try {
      activeStreamId = await store.getActiveStreamId(chat);
    } catch (error) {
      logger.error('chat-rewind-store', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    if (activeStreamId !== null) {
      sendJsonError(res, 409, 'Chat has an active generation. Resume or wait.');
      return;
    }
    // The removed tail (for the derived-memory purge) is exactly the load
    // BEFORE the trim sliced after the CAS-kept count — the same contract
    // the rewind CAS verifies (any concurrent change stale-fails the rewind).
    // The messageId is pre-checked so an unknown id still answers the fixed
    // 404 WITHOUT any purge.
    let preRewindStored: unknown[] | null = null;
    try {
      preRewindStored = await store.loadMessages(chat);
    } catch (error) {
      logger.error('chat-rewind-preload', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    const messageIdExists =
      preRewindStored.some(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          (entry as { id?: unknown }).id === body.data.messageId,
      );
    if (messageIdExists === false) {
      sendJsonError(res, 404, 'Message not found.');
      return;
    }
    // FORGOTTEN CONTENT: derived personal memory tied to the REMOVED
    // assistant messages is purged BEFORE the destructive trim (explicit
    // post-mutation-independence: a purge failure aborts the rewind with the
    // transcript still intact, so a 200 NEVER claims a rewind whose memory
    // purge failed). The removed tail is everything AFTER the requested
    // message; if the CAS later stale-fails, the removed ids change on the
    // retry and a purge on then-kept ids is the privacy-safe direction
    // (derived memory is always re-derivable on the next completed turn).
    // The purge is strictly owner-scoped.
    let purgedPersonalMemoryBlocks = 0;
    if (deps.personal !== undefined) {
      try {
        const messageIdIndex = preRewindStored.findIndex(
          (entry) =>
            entry !== null &&
            typeof entry === 'object' &&
            (entry as { id?: unknown }).id === body.data.messageId,
        );
        const removedAssistantMessageIds = preRewindStored
          .slice(messageIdIndex + 1)
          .filter(
            (entry) =>
              entry !== null &&
              typeof entry === 'object' &&
              (entry as { role?: unknown }).role === 'assistant' &&
              typeof (entry as { id?: unknown }).id === 'string',
          )
          .map((entry) => String((entry as { id?: unknown }).id))
          .slice(0, 512);
        if (removedAssistantMessageIds.length > 0) {
          purgedPersonalMemoryBlocks = await deps.personal.memory.purgeDerivedChatMemory({
            scope: userMemoryScope(target.ownerId),
            path: personalChatPath(target.clientChatId),
            assistantMessageIds: removedAssistantMessageIds,
          });
        }
      } catch (error) {
        logger.error('personal-memory-purge-rewind', error);
        sendJsonError(res, 503, 'Personal memory cleanup failed. Retry the rewind.');
        return;
      }
    }
    let result;
    try {
      result = await store.rewindChat(chat, body.data.messageId);
    } catch (error) {
      logger.error('chat-rewind-store', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    if (result.status === 'chat-not-found') {
      sendJsonError(res, 404, 'Chat not found.');
      return;
    }
    if (result.status === 'message-not-found') {
      sendJsonError(res, 404, 'Message not found.');
      return;
    }
    if (result.status === 'stale') {
      sendJsonError(res, 409, 'Chat changed during rewind. Retry.');
      return;
    }
    // Branch does NOT copy derived memories by contract (nothing to do).
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        rewound: true,
        kept: result.kept,
        removed: result.removed,
        hasActiveStream: false,
        purgedPersonalMemoryBlocks,
      }),
    );
  });

  const hydration = asyncRoute(async (req: Request, res: Response) => {
    const owner = ownerOr401(res);
    if (owner === null) {
      return;
    }
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
    const chat = chatRefFromRequest(owner.userId, slug, clientChatId);
    // Additive hydration field (model composition wired): the chat's selected
    // model, or the configured default when unset.
    let chatModelField: string | null = null;
    if (deps.models !== undefined) {
      try {
        chatModelField = (await store.getChatModel(chat)) ?? deps.models.defaultModelId;
      } catch (error) {
        logger.error('hydration-model', error);
        sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
        return;
      }
    }
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
        ...(chatModelField !== null ? { modelId: chatModelField } : {}),
      }),
    );
  });


  const postChat = asyncRoute(async (req: Request, res: Response) => {
    const resolved = ownerOr401(res);
    if (resolved === null) {
      return;
    }
    const ownerUserId = resolved.userId;
    const slug = req.params['slug'] ?? '';
    const phase4Agent = isKnownSlug(slug) && slug !== 'general';
    if (!isKnownSlug(slug)) {
      sendJsonError(res, 404, 'Unknown agent slug.');
      return;
    }
    // Phase 4 roster requires the runtime deps; legacy callers without them
    // must keep the exact Phase 2 surface (non-`general` slugs stay 404).
    if (phase4Agent && deps.agents === undefined) {
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
    const { id: chatId, message: newestBodyMessage } = bodyCheck.data;
    const message = toUIMessageInput(newestBodyMessage);

    // Phase 4 modes: optional in the body; default action. NEVER depth.
    const requestedMode: ChatMode = bodyCheck.data.mode ?? 'action';

    // Trusted depth comes ONLY from the verified internal header, which now
    // also binds the RESOLVED owner (browser session or signed internal
    // context): one user's delegation header can never drive another user's
    // chat (fixed 400 on any mismatch).
    const delegationHeader = req.get(DELEGATION_CONTEXT_HEADER);
    const delegationCheck = resolveDelegationChatContext(deps, delegationHeader ?? undefined, slug, chatId, ownerUserId);
    if (!delegationCheck.ok) {
      sendJsonError(res, delegationCheck.status, 'Invalid internal delegation context.');
      return;
    }
    // Child chats always run in action mode (their contexts never carry plan).
    const mode: ChatMode = delegationCheck.context !== null ? 'action' : requestedMode;

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

    const chat = chatRefFromRequest(ownerUserId, slug, chatId);

    // ---- Model resolution + policy revalidation (BEFORE any durable work) --
    // The chat's selected model (or the configured DEFAULT) drives this
    // generation; a model that became BLOCKED after selection is rejected
    // here with the fixed safe 400 (selection revalidation happened at PUT).
    let chatModelId: string;
    try {
      chatModelId = (await store.getChatModel(chat)) ?? resolveDefaultModelId(deps);
    } catch (error) {
      logger.error('chat-model-read', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    if (isBlockedModelId(chatModelId, deps.config.blockedModelPrefixes)) {
      sendJsonError(res, 400, 'Model is not allowed.');
      return;
    }

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

    // Phase 4 composition ONCE per generation (ADR-001): tools + full allowed
    // validation set + system prompt, from slug + mode + VERIFIED depth.
    const prepared =
      deps.agents !== undefined
        ? prepareGeneration(deps.agents.hostDeps, {
            slug,
            mode,
            depth: delegationCheck.context?.depth ?? 0,
            chatId,
            parentMessageId: message.id,
            ownerId: ownerUserId,
          })
        : null;
    const generationTools = prepared !== null ? prepared.tools : agentTools;
    const validationTools = prepared !== null ? prepared.validationTools : agentTools;
    const systemPrompt = prepared !== null ? prepared.systemPrompt : null;

    // Validate the complete appended conversation (with the FULL allowed
    // action toolset, so historical action-mode tool parts stay valid across
    // plan switches) BEFORE anything durable happens. Invalid newest message
    // must acquire no key, append nothing, answer no question. If the whole
    // list fails, classify by validating the stored history alone — it failing
    // means server-side corrupt state (503); it passing means the newest body
    // is invalid (400). Neither path touches the provider NOR mutates state.
    const appendedConversation = [...stored, message] as UIMessage[];
    const conversationValid = await validateAndConvertMessages(appendedConversation, validationTools);
    if (conversationValid === null) {
      const storedValid =
        stored.length === 0 ||
        (await validateAndConvertMessages(toUIMessages(stored), validationTools)) !== null;
      if (!storedValid) {
        logger.warn('chat-stored-state-unreadable');
        sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
        return;
      }
      sendJsonError(res, 400, 'Message failed validation for this chat.');
      return;
    }

    // Exactly-once generation guard BEFORE any provider work or mutations
    // (ADR-005). Acquiring here means only THIS turn can resolve the pending
    // ask_user question / append.
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

    const releaseKeyAndFail = async (logContext: string, error: unknown, status: number, message_: string): Promise<void> => {
      logger.error(logContext, error);
      try {
        await store.releaseIdempotencyKey(chat, headerKey);
      } catch (releaseError) {
        logger.error('chat-idempotency-release', releaseError);
      }
      sendJsonError(res, status, message_);
    };

    // HITL resume (Phase 4): resolve pending ask_user parts to
    // `output-available { answer }` — a targeted, atomic, byte-CAS transcript
    // update. The NEWEST pending question receives the newest user text; every
    // OLDER pending question is resolved with the bounded sentinel so no stale
    // tool call wedges the conversation. This happens BEFORE the newest user
    // message is appended, and AFTER validation/key acquisition, so an invalid
    // new input never mutates the questions and duplicate submits never
    // double-answer ('unchanged' is an idempotent no-op; 'stale' after retries
    // fails the turn safely instead of guessing).
    const pendingAskUser = findPendingAskUserParts(stored);
    const answerText = newestUserText(message);
    if (pendingAskUser.length > 0) {
      try {
        for (const pending of pendingAskUser) {
          const target = pending.newest ? answerText : ASK_USER_NO_ANSWER;
          let outcome = await store.answerPendingAskUser(chat, pending.messageId, pending.toolCallId, target);
          if (outcome === 'stale') {
            // One fresh re-read + retry; the store itself re-reads on each call.
            outcome = await store.answerPendingAskUser(chat, pending.messageId, pending.toolCallId, target);
          }
          if (outcome === 'stale') {
            await releaseKeyAndFail('chat-ask-user-answer-stale', new Error('ask_user CAS stale'), 503, 'Chat state is temporarily unavailable.');
            return;
          }
        }
      } catch (error) {
        await releaseKeyAndFail('chat-ask-user-answer', error, 503, 'Chat state is temporarily unavailable.');
        return;
      }
    }

    // Persist the user message BEFORE generation starts: a single atomic
    // append — concurrent turns cannot corrupt each other's list entries.
    try {
      await store.appendMessage(chat, message as unknown as UIMessage);
    } catch (error) {
      await releaseKeyAndFail('chat-store-save', error, 503, 'Chat state is temporarily unavailable.');
      return;
    }

    // Reload after the (optional) part-state update so the generation sees the
    // ANSWERED transcript; conversion runs against the full validation toolset.
    let storedAfter: unknown[] = stored;
    try {
      storedAfter = pendingAskUser.length > 0 ? await store.loadMessages(chat) : stored;
    } catch (error) {
      await releaseKeyAndFail('chat-store-reload', error, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    const messagesForGeneration = [...storedAfter, message] as UIMessage[];

    // Hand off to generation. From here on the key is never released: once the
    // stream has started, retries go through resume instead (ADR-005).
    // Opt-in personal memory RECALL first (never blocks the turn): bounded
    // untrusted reference context, or plain none on any failure/disabling.
    const personalRecallDeps: PersonalRecallDeps | null =
      deps.personal !== undefined
        ? { memory: deps.personal.memory, settings: deps.personal.settings, logger }
        : null;
    let memoryContext: string | undefined;
    if (personalRecallDeps !== null) {
      memoryContext = (await recallPersonalMemory(personalRecallDeps, { ownerId: ownerUserId, newestUserText: answerText })) ?? undefined;
    }
    // Opt-in personal CAPTURE: one deterministic job per completed assistant
    // turn, gated again at finish and (defense in depth) in the worker.
    const onAssistantFinished: CreateChatTurnStreamOptions['onAssistantFinished'] | undefined =
      deps.personal !== undefined
        ? (finished) => {
            background.track(
              (async () => {
                const gate = await deps.personal?.settings.get(ownerUserId);
                if (gate?.personalMemoryEnabled !== true) {
                  return;
                }
                await deps.personal?.capture.enqueueCapture({
                  ownerId: ownerUserId,
                  scope: userMemoryScope(ownerUserId),
                  chatId,
                  slug,
                  userMessageId: finished.userMessageId,
                  assistantMessageId: finished.assistantMessageId,
                });
              })().catch((error: unknown) => {
                logger.error('personal-capture-enqueue', error);
              }),
            );
          }
        : undefined;
    let turn;
    try {
      turn = await createChatTurnStream({
        chat,
        messages: messagesForGeneration,
        store,
        streamContext,
        background,
        logger,
        model: resolveGenerationModel(deps, chatModelId),
        modelId: chatModelId,
        tools: generationTools,
        validationTools,
        systemPrompt,
        memoryContext,
        onAssistantFinished,
        // Deadline abort for INTERNAL delegated children only: the verified
        // context carries the run deadline. Browser disconnects still never
        // abort generation (no signal is passed for ordinary chats).
        ...(delegationCheck.context !== null
          ? { abortSignal: AbortSignal.timeout(Math.max(0, delegationCheck.context.deadline - Date.now())) }
          : {}),
      });
    } catch (error) {
      if (error instanceof InvalidStoredChatError) {
        // Generation never started: release the key we acquired. The ask_user
        // answer update + user append stand (honest persisted state); a retry
        // is safe and idempotent.
        try {
          await store.releaseIdempotencyKey(chat, headerKey);
        } catch (releaseError) {
          logger.error('chat-idempotency-release', releaseError);
        }
        sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
        return;
      }
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
    const resolved = ownerOr401(res);
    if (resolved === null) {
      return;
    }
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
    const chat = chatRefFromRequest(resolved.userId, slug, clientChatId);

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

  // ---------------------------------------------------------------------------
  // Per-chat MODEL selection + USAGE (pre-Phase 6 model composition)
  // ---------------------------------------------------------------------------

  /** GET /model: the stored selection or the configured default. */
  const getModel: RequestHandler = async (req, res) => {
    const target = parseMutationTarget(req, res);
    if (target === null) {
      return;
    }
    if (deps.models === undefined) {
      sendJsonError(res, 404, 'Unknown route.');
      return;
    }
    const chat = chatRefFromRequest(target.ownerId, target.slug, target.clientChatId);
    let modelId: string;
    try {
      modelId = (await store.getChatModel(chat)) ?? deps.models.defaultModelId;
    } catch (error) {
      logger.error('chat-model-read', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ modelId }));
  };

  /** PUT /model: strict {modelId}; validates pattern, blocked policy, and
   * catalog presence (cached/fresh); applies to the NEXT generation only.
   */
  const setModel = asyncRoute(async (req: Request, res: Response) => {
    const target = parseMutationTarget(req, res);
    if (target === null) {
      return;
    }
    if (deps.models === undefined) {
      sendJsonError(res, 404, 'Unknown route.');
      return;
    }
    if (!req.is('application/json')) {
      sendJsonError(res, 415, 'Content-Type must be application/json.');
      return;
    }
    const body = modelBodySchema.safeParse(req.body);
    if (!body.success) {
      sendJsonError(res, 400, 'modelId must be 1-80 characters of A-Z a-z 0-9 . _ : -');
      return;
    }
    const modelId = body.data.modelId;
    if (isBlockedModelId(modelId, deps.config.blockedModelPrefixes)) {
      sendJsonError(res, 400, MODEL_LOCK_REASON);
      return;
    }
    let available: boolean;
    try {
      const catalog = await deps.models.catalog.list();
      available = catalog.models.some((entry) => entry.id === modelId);
    } catch (error) {
      if (error instanceof ModelCatalogUnavailableError) {
        sendJsonError(res, 503, 'Model catalog is temporarily unavailable.');
      } else {
        logger.error('chat-model-catalog', error);
        sendJsonError(res, 503, 'Model catalog is temporarily unavailable.');
      }
      return;
    }
    if (!available) {
      sendJsonError(res, 400, 'Model is not available.');
      return;
    }
    const chat = chatRefFromRequest(target.ownerId, target.slug, target.clientChatId);
    try {
      // Applies to the NEXT generation: current/running streams keep their
      // started model by contract.
      await store.setChatModel(chat, modelId);
    } catch (error) {
      logger.error('chat-model-write', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ modelId }));
  });

  /** GET /usage: exact token sums + per-model buckets + honest cost. */
  const chatUsage: RequestHandler = async (req, res) => {
    const target = parseMutationTarget(req, res);
    if (target === null) {
      return;
    }
    const chat = chatRefFromRequest(target.ownerId, target.slug, target.clientChatId);
    let stored: unknown[];
    try {
      stored = await store.loadMessages(chat);
    } catch (error) {
      logger.error('chat-usage-store', error);
      sendJsonError(res, 503, 'Chat state is temporarily unavailable.');
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(summarizeChatUsage(stored, deps.config.modelPricing)));
  };

  return {
    health,
    hydration,
    postChat,
    resumeStream,
    deleteChat,
    branchChat,
    rewindChat,
    getModel,
    setModel,
    usage: chatUsage,
  };
}
