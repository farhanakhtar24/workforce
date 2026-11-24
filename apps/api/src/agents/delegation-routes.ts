/**
 * Delegation REST routes (Phase 4 / ADR-004):
 * - POST /api/agents/orchestrator/delegations     — create (track + start)
 * - GET  /api/agents/:slug/delegations?parentChatId&limit — list, newest first
 * - GET  /api/agents/:slug/delegations/:delegationId      — status detail
 * - POST /api/agents/:slug/delegations/:delegationId/run  — execute via the
 *   SAME REST surface (sync tool, create-wait, and async worker all land here)
 *
 * Depth can only enter through the server-signed internal context header.
 * Create additionally verifies the parent exists (parent chat has messages and
 * the referenced parent user message id is stored). Errors are fixed safe
 * strings; task/result text never appears in responses or logs.
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DELEGATION_LIST_LIMIT_MAX,
  createDelegationInputSchema,
  delegationIdSchema,
  delegationModeSchema,
  delegationTaskSchema,
  isDelegationTargetAgent,
  type Delegation,
  type DelegationRepository,
  DelegationConflictError,
  DelegationValidationError,
} from '@workforce/core/delegation';
import { MAX_DELEGATION_DEPTH } from '@workforce/core';

import type { ChatStore } from '../store/types.js';
import type { SafeLogger } from '../logging.js';
import type { FetchLike } from './host-capabilities.js';
import type { AuthOwner } from '../auth/owner.js';
import { ownerOf } from '../auth/owner.js';
import {
  DELEGATION_CONTEXT_HEADER,
  contextWindow,
  internalOwnerHeader,
  type DelegationContextSigner,
} from './delegation-context.js';
import type { DelegationJobQueue } from './delegation-queue.js';
import { delegationRestTimeoutMs } from './host-capabilities.js';
import {
  DELEGATION_NOT_FOUND,
  INVALID_DELEGATION_CONTEXT,
  DelegationRouteError,
  runDelegation,
  verifyRunHeader,
  type DelegationRunDeps,
} from './delegation-run.js';

export interface DelegationRouteDeps {
  readonly repo: DelegationRepository;
  /** Async create queue; `null`/absent keeps async creates at 503 honestly. */
  readonly queue?: DelegationJobQueue | null;
  /** Parent-existence checks (chat transcript ownership). */
  readonly chatStore?: ChatStore;
  readonly signer: DelegationContextSigner;
  readonly fetchFn: FetchLike;
  readonly baseUrl: string;
  readonly delegationTimeoutMs: number;
  readonly logger: SafeLogger;
}

export interface DelegationRouteHandlers {
  readonly create: (req: Request, res: Response, next: (error?: unknown) => void) => Promise<void>;
  readonly list: (req: Request, res: Response, next: (error?: unknown) => void) => Promise<void>;
  readonly detail: (req: Request, res: Response, next: (error?: unknown) => void) => Promise<void>;
  readonly run: (req: Request, res: Response, next: (error?: unknown) => void) => Promise<void>;
}

const INTEGER_STRING = /^\d+$/;

export const INVALID_DELEGATION_REQUEST = 'Invalid delegation request.';
export const PARENT_NOT_FOUND = 'Parent chat or message not found.';
export const DELEGATION_QUEUE_UNAVAILABLE = 'Delegation queue is temporarily unavailable.';
export const DELEGATION_STORE_UNAVAILABLE = 'Delegation service is temporarily unavailable.';
export const DELEGATION_DEPTH_CAP = 'Delegation depth cap exceeded.';

/** Create body per the phase spec: `target` (tool sends `targetAgent` too). */
const createBodySchema = z
  .strictObject({
    parentChatId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    parentMessageId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    target: z.string().optional(),
    targetAgent: z.string().optional(),
    task: delegationTaskSchema,
    mode: delegationModeSchema,
  })
  .refine((value) => value.target !== undefined || value.targetAgent !== undefined, {
    message: 'target is required',
  });

function json(res: Response, status: number, body: unknown): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function createDelegationRoutes(deps: DelegationRouteDeps): DelegationRouteHandlers {
  const runDeps: DelegationRunDeps = {
    signer: deps.signer,
    fetchFn: deps.fetchFn,
    baseUrl: deps.baseUrl,
    delegationTimeoutMs: deps.delegationTimeoutMs,
    repo: deps.repo,
    // Model inheritance: the child chat copies the parent's selected model.
    chatStore: deps.chatStore,
  };

  /** Mints the internal create/run header bound to one row's parent+owner. */
  const mintCreateHeader = (row: Delegation): Record<string, string> => {
    if (row.ownerId === null || row.ownerId.length === 0) {
      // Ownerless rows cannot run: refuse to mint a header for them.
      throw new Error('cannot mint a run header for an ownerless delegation');
    }
    const window = contextWindow(deps.delegationTimeoutMs);
    return {
      [DELEGATION_CONTEXT_HEADER]: deps.signer.sign({
        kind: 'delegation-create',
        parentChatId: row.parentChatId,
        parentDepth: row.depth - 1,
        ownerId: row.ownerId,
        expiresAt: window.expiresAt,
      }),
      ...internalOwnerHeader(deps.signer, row.ownerId),
    };
  };

  const create = async (req: Request, res: Response, next: (error?: unknown) => void): Promise<void> => {
    try {
      const resolvedOwner: AuthOwner | null = ownerOf(res);
      if (resolvedOwner === null) {
        json(res, 401, { error: 'Authentication required.' });
        return;
      }
      const ownerId: string = resolvedOwner.userId;
      const slug = req.params['slug'] ?? '';
      // Delegations are the orchestrator's path ONLY (fixed route per spec).
      if (slug !== 'orchestrator') {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      const parsedBody = createBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        json(res, 400, { error: INVALID_DELEGATION_REQUEST });
        return;
      }
      const body = parsedBody.data;
      const target = body.targetAgent ?? body.target ?? '';
      if (body.targetAgent !== undefined && body.target !== undefined && body.targetAgent !== body.target) {
        json(res, 400, { error: INVALID_DELEGATION_REQUEST });
        return;
      }
      if (!isDelegationTargetAgent(target)) {
        json(res, 400, { error: INVALID_DELEGATION_REQUEST });
        return;
      }

      // Trusted depth ONLY from the verified signed context; the CHILD depth
      // is parentDepth + 1 and must stay within the cap (3+ → 403).
      const header = req.get(DELEGATION_CONTEXT_HEADER) ?? undefined;
      if (typeof header !== 'string' || header.length === 0) {
        json(res, 400, { error: INVALID_DELEGATION_CONTEXT });
        return;
      }
      // parentDepth is unknown before the row exists, so verify the context
      // WITHOUT depth binding first, then enforce the cap on the parsed value.
      // The context must also carry THIS resolved owner — a header minted for
      // another user is a fixed 400 (never a cross-tenant delegation).
      const verified = deps.signer.verify(header, { kind: 'delegation-create', ownerId });
      if (!verified.ok || verified.payload.kind !== 'delegation-create') {
        json(res, 400, { error: INVALID_DELEGATION_CONTEXT });
        return;
      }
      const parentDepth = verified.payload.parentDepth;
      if (
        typeof parentDepth !== 'number' ||
        !Number.isInteger(parentDepth) ||
        parentDepth < 0
      ) {
        json(res, 400, { error: INVALID_DELEGATION_CONTEXT });
        return;
      }
      if (verified.payload.parentChatId !== body.parentChatId) {
        json(res, 400, { error: INVALID_DELEGATION_CONTEXT });
        return;
      }
      const childDepth = parentDepth + 1;
      if (childDepth > MAX_DELEGATION_DEPTH) {
        json(res, 403, { error: DELEGATION_DEPTH_CAP });
        return;
      }

      // Parent existence: the chat must have messages and the parent user
      // message id must be among them (append-only store, exact match). The
      // chat read is OWNER-SCOPED — another user's identical chat id can
      // never satisfy a parent check.
      if (deps.chatStore !== undefined) {
        let stored: unknown[];
        try {
          stored = await deps.chatStore.loadMessages({ ownerId, slug: 'orchestrator', chatId: body.parentChatId });
        } catch {
          json(res, 503, { error: 'Chat state is temporarily unavailable.' });
          return;
        }
        const parentFound = stored.some(
          (entry) =>
            entry !== null &&
            typeof entry === 'object' &&
            (entry as { role?: unknown }).role === 'user' &&
            (entry as { id?: unknown }).id === body.parentMessageId,
        );
        if (!parentFound) {
          json(res, 404, { error: PARENT_NOT_FOUND });
          return;
        }
      }

      // Persist the pending row BEFORE any execution (child chat id is
      // assigned up front and stable even for async runs). The owner is the
      // RESOLVED identity, never a client field.
      const parsedCreate = createDelegationInputSchema.safeParse({
        id: randomUUID(),
        parentChatId: body.parentChatId,
        childChatId: randomUUID(),
        parentMessageId: body.parentMessageId,
        targetAgent: target,
        mode: body.mode,
        task: body.task,
        depth: childDepth,
        ownerId,
      });
      if (!parsedCreate.success) {
        json(res, 400, { error: INVALID_DELEGATION_REQUEST });
        return;
      }
      let delegation: Delegation;
      try {
        // Persist the pending row BEFORE any execution (the child chat id is
        // assigned up front and stays stable even for async runs).
        delegation = await deps.repo.create(parsedCreate.data);
      } catch (error) {
        if (error instanceof DelegationConflictError) {
          json(res, 409, { error: 'Delegation conflict.' });
          return;
        }
        if (error instanceof DelegationValidationError) {
          json(res, 400, { error: INVALID_DELEGATION_REQUEST });
          return;
        }
        json(res, 503, { error: DELEGATION_STORE_UNAVAILABLE });
        return;
      }

      if (delegation.mode === 'async') {
        if (deps.queue === undefined || deps.queue === null) {
          // No queue wired: an async delegation could never run — say so
          // instead of leaving a row that waits forever.
          json(res, 503, { error: DELEGATION_QUEUE_UNAVAILABLE });
          return;
        }
        try {
          await deps.queue.enqueue(delegation.id, 'orchestrator', ownerId);
        } catch {
          json(res, 503, { error: DELEGATION_QUEUE_UNAVAILABLE });
          return;
        }
        json(res, 202, { delegation, childChatId: delegation.childChatId, status: 'pending' });
        return;
      }

      // Sync create WAITS for the same run result: execute through the OWN
      // run REST surface with a minted internal header (same as the worker).
      try {
        const runUrl = `${deps.baseUrl}/api/agents/orchestrator/delegations/${encodeURIComponent(delegation.id)}/run`;
        const runResponse = await deps.fetchFn(runUrl, {
          method: 'POST',
          headers: mintCreateHeader(delegation),
          // Child runs can take the full delegation budget; the loopback call
          // shares the tool-side budget helper so margins never drift.
          signal: AbortSignal.timeout(delegationRestTimeoutMs(deps.delegationTimeoutMs)),
        });
        if (!runResponse.ok) {
          json(res, 503, { error: DELEGATION_STORE_UNAVAILABLE });
          return;
        }
        const runBody = (await runResponse.json()) as { delegation?: Delegation };
        if (runBody.delegation === undefined) {
          json(res, 503, { error: DELEGATION_STORE_UNAVAILABLE });
          return;
        }
        json(res, 201, { delegation: runBody.delegation, childChatId: runBody.delegation.childChatId });
      } catch {
        json(res, 503, { error: DELEGATION_STORE_UNAVAILABLE });
      }
      return;
    } catch (error) {
      next(error);
    }
  };

  const list = async (req: Request, res: Response, next: (error?: unknown) => void): Promise<void> => {
    try {
      const resolvedOwner: AuthOwner | null = ownerOf(res);
      if (resolvedOwner === null) {
        json(res, 401, { error: 'Authentication required.' });
        return;
      }
      const ownerId: string = resolvedOwner.userId;
      const slug = req.params['slug'] ?? '';
      if (!['general', 'orchestrator', 'analyst', 'researcher'].includes(slug)) {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      const parentChatId = req.query['parentChatId'];
      const limitRaw = req.query['limit'];
      if (typeof parentChatId !== 'string' || parentChatId.length === 0) {
        json(res, 400, { error: INVALID_DELEGATION_REQUEST });
        return;
      }
      if (parentChatId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(parentChatId)) {
        json(res, 400, { error: INVALID_DELEGATION_REQUEST });
        return;
      }
      let limit: number | undefined;
      if (limitRaw !== undefined) {
        if (typeof limitRaw !== 'string' || !INTEGER_STRING.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > DELEGATION_LIST_LIMIT_MAX) {
          json(res, 400, { error: INVALID_DELEGATION_REQUEST });
          return;
        }
        limit = Number(limitRaw);
      }
      // Owner-filtered: only THIS user's delegations for the parent chat.
      // Ownerless legacy rows never match the exact filter.
      const rows = await deps.repo.listByParent({
        parentChatId,
        ownerId,
        ...(limit !== undefined ? { limit } : {}),
      });
      json(res, 200, { delegations: rows });
    } catch {
      json(res, 503, { error: DELEGATION_STORE_UNAVAILABLE });
    }
  };

  const detail = async (req: Request, res: Response, next: (error?: unknown) => void): Promise<void> => {
    try {
      const resolvedOwner: AuthOwner | null = ownerOf(res);
      if (resolvedOwner === null) {
        json(res, 401, { error: 'Authentication required.' });
        return;
      }
      const ownerId: string = resolvedOwner.userId;
      const slug = req.params['slug'] ?? '';
      const delegationId = req.params['delegationId'] ?? '';
      if (!['general', 'orchestrator', 'analyst', 'researcher'].includes(slug)) {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      if (!delegationIdSchema.safeParse(delegationId).success) {
        json(res, 404, { error: DELEGATION_NOT_FOUND });
        return;
      }
      // Owner guard: foreign/ownerless rows read as null (no existence oracle).
      const row = await deps.repo.get(delegationId, { expectedOwnerId: ownerId });
      if (row === null || row === undefined) {
        json(res, 404, { error: DELEGATION_NOT_FOUND });
        return;
      }
      json(res, 200, { delegation: row, childChatId: row.childChatId });
    } catch {
      json(res, 503, { error: DELEGATION_STORE_UNAVAILABLE });
    }
  };

  const run = async (req: Request, res: Response, next: (error?: unknown) => void): Promise<void> => {
    try {
      const resolvedOwner: AuthOwner | null = ownerOf(res);
      if (resolvedOwner === null) {
        json(res, 401, { error: 'Authentication required.' });
        return;
      }
      const ownerId: string = resolvedOwner.userId;
      const slug = req.params['slug'] ?? '';
      const delegationId = req.params['delegationId'] ?? '';
      if (slug !== 'orchestrator') {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      if (!delegationIdSchema.safeParse(delegationId).success) {
        json(res, 404, { error: DELEGATION_NOT_FOUND });
        return;
      }

      // Run is an INTERNAL surface: the signed create/run context is
      // mandatory, bound to the row (parent chat + parent depth + owner).
      // External callers without a valid header are rejected even at depth 1,
      // and the row read is owner-guarded first (fixed 404 for foreign rows).
      const header = req.get(DELEGATION_CONTEXT_HEADER) ?? undefined;
      const row = await deps.repo.get(delegationId, { expectedOwnerId: ownerId });
      if (row === null || row === undefined) {
        json(res, 404, { error: DELEGATION_NOT_FOUND });
        return;
      }
      const headerCheck = verifyRunHeader(runDeps, header, row);
      if (!headerCheck.ok) {
        json(res, 400, { error: INVALID_DELEGATION_CONTEXT });
        return;
      }
      const outcome = await runDelegation(runDeps, header, delegationId, ownerId);
      json(res, 200, { delegation: outcome.delegation, childChatId: outcome.delegation.childChatId, executed: outcome.executed });
    } catch (error) {
      if (error instanceof DelegationRouteError) {
        json(res, error.status, { error: error.message });
        return;
      }
      json(res, 503, { error: DELEGATION_STORE_UNAVAILABLE });
    }
  };

  return { create, list, detail, run };
}
