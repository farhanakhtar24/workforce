/**
 * Work Document REST routes (Phase 4). The SAME routes the web UI and the
 * `write_doc` tool use (ADR-002 — one validation/ownership/error surface):
 *
 * - GET  /api/agents/:slug/work-docs                    — list (?scope&chatId&limit&type&status)
 * - POST /api/agents/orchestrator/work-docs             — create (agent-sourced)
 * - GET  /api/agents/:slug/work-docs/:id                — one doc (owner chatId required)
 * - PATCH /api/agents/:slug/work-docs/:id               — USER metadata-only {title,status} via CAS
 * - POST /api/agents/orchestrator/work-docs/:id/versions — agent content/title/status via CAS
 * - GET  /api/agents/:slug/work-docs/:id/versions       — immutable versions
 * - GET  /api/agents/:slug/work-docs/:id/versions/:version — one snapshot
 * - POST /api/agents/:slug/work-docs/:id/rollback       — {expectedVersion,toVersion,summary?} → NEW version
 * - GET  /api/agents/:slug/work-docs/:id/revisions      — audit trail
 * - GET  /api/agents/:slug/work-docs/:id/links          — typed links
 * - POST /api/agents/:slug/work-docs/:id/links          — add typed link
 *
 * Ownership (pre-Phase 6): every doc-scoped read/mutation demands the
 * authenticated owner (`ownerId` — never a client-controllable field) AND the
 * owning `chatId` (query for GET, body otherwise). Core guards
 * (`expectedOwnerId`) match EXACTLY: a foreign or ownerless row reads as
 * fixed 404 — no existence oracle, no cross-tenant leakage. No document
 * content is ever logged; errors are fixed safe strings.
 */
import type { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import {
  WorkDocConflictError,
  WorkDocNotFoundError,
  WorkDocValidationError,
  workDocContentSchema,
  workDocIdSchema,
  workDocStatusSchema,
  workDocSummarySchema,
  workDocTitleSchema,
  workDocTypeSchema,
  workDocVersionNumberSchema,
  type WorkDocService,
} from '@workforce/core/work-docs';

import type { SafeLogger } from '../logging.js';
import { clientIdSchema } from '../validation.js';
import { ownerOf, AUTH_401_MESSAGE } from '../auth/owner.js';

export interface WorkDocRouteDeps {
  readonly service: WorkDocService;
  readonly logger?: SafeLogger;
}

export interface WorkDocRouteHandlers {
  readonly list: RequestHandler;
  readonly create: RequestHandler;
  readonly getDoc: RequestHandler;
  readonly patchDoc: RequestHandler;
  readonly listVersions: RequestHandler;
  readonly getVersion: RequestHandler;
  readonly postVersion: RequestHandler;
  readonly rollback: RequestHandler;
  readonly listRevisions: RequestHandler;
  readonly addLink: RequestHandler;
  readonly listLinks: RequestHandler;
}

export const INVALID_WORKDOC_REQUEST = 'Invalid work document request.';
export const WORKDOC_NOT_FOUND = 'Work document not found.';
export const WORKDOC_CONFLICT = 'Work document version conflict.';
export const WORKDOC_UNAVAILABLE = 'Work document service is temporarily unavailable.';

const INTEGER_STRING = /^\d+$/;

function json(res: Response, status: number, body: unknown): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Core typed errors → fixed statuses; everything else → 503 (never echoed). */
function handleStoreError(error: unknown): { status: number; message: string } {
  if (error instanceof WorkDocValidationError) {
    return { status: 400, message: INVALID_WORKDOC_REQUEST };
  }
  if (error instanceof WorkDocNotFoundError) {
    return { status: 404, message: WORKDOC_NOT_FOUND };
  }
  if (error instanceof WorkDocConflictError) {
    return { status: 409, message: WORKDOC_CONFLICT };
  }
  return { status: 503, message: WORKDOC_UNAVAILABLE };
}

/** Body: `{chatId}` (or query `chatId`) must match the document's owner. */
const chatIdBody = z.strictObject({ chatId: clientIdSchema });

const SLUGS = ['general', 'orchestrator', 'analyst', 'researcher'];

const createBodySchema = z.strictObject({
  chatId: clientIdSchema,
  type: workDocTypeSchema,
  title: workDocTitleSchema,
  content: workDocContentSchema,
});

const patchBodySchema = z
  .strictObject({
    chatId: clientIdSchema,
    expectedVersion: workDocVersionNumberSchema,
    title: workDocTitleSchema.optional(),
    status: workDocStatusSchema.optional(),
  })
  .refine((value) => value.title !== undefined || value.status !== undefined, {
    message: 'patch must change at least one of title or status',
  });

/**
 * Agent version posts (the `write_doc` update path) record provenance HONESTLY:
 * `source` is optional, strictly `'agent'` (tool default, existing behavior) or
 * `'user'` (browser user edits through the same CAS route). No auth claim — the
 * value is what the caller honestly reports, exactly like the rollback route's
 * optional `source`.
 */
const postVersionBodySchema = z
  .strictObject({
    chatId: clientIdSchema,
    expectedVersion: workDocVersionNumberSchema,
    content: workDocContentSchema.optional(),
    title: workDocTitleSchema.optional(),
    status: workDocStatusSchema.optional(),
    summary: workDocSummarySchema.optional(),
    source: z.enum(['agent', 'user']).optional(),
  })
  .refine((value) => value.content !== undefined || value.title !== undefined || value.status !== undefined, {
    message: 'version must change at least one of content, title, or status',
  });

const rollbackBodySchema = z.strictObject({
  chatId: clientIdSchema,
  expectedVersion: workDocVersionNumberSchema,
  toVersion: workDocVersionNumberSchema,
  summary: workDocSummarySchema.optional(),
  source: z.enum(['agent', 'user']).optional(),
});

const addLinkBodySchema = z.strictObject({
  chatId: clientIdSchema,
  targetType: z.enum(['memory_block', 'chat', 'delegation']),
  targetId: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(128).optional(),
});

export function createWorkDocRoutes(deps: WorkDocRouteDeps): WorkDocRouteHandlers {
  const { service } = deps;

  /** Fixed-401 guard (the app-wide owner middleware should precede this). */
  const ownerIdOr401 = (res: Response): string | null => {
    const owner = ownerOf(res);
    if (owner === null) {
      json(res, 401, { error: AUTH_401_MESSAGE });
      return null;
    }
    return owner.userId;
  };

  const list: RequestHandler = async (req, res) => {
    const ownerId = ownerIdOr401(res);
    if (ownerId === null) {
      return;
    }
    const slug = req.params['slug'] ?? '';
    if (!SLUGS.includes(slug)) {
      json(res, 404, { error: 'Unknown agent slug.' });
      return;
    }
    const scope = req.query['scope'];
    const chatId = req.query['chatId'];
    const limitRaw = req.query['limit'];
    const type = req.query['type'];
    const status = req.query['status'];
    const input: Record<string, unknown> = {};
    if (scope !== undefined) input['scope'] = scope;
    if (chatId !== undefined) input['chatId'] = chatId;
    if (type !== undefined) input['type'] = type;
    if (status !== undefined) input['status'] = status;
    if (limitRaw !== undefined) {
      if (typeof limitRaw !== 'string' || !INTEGER_STRING.test(limitRaw)) {
        json(res, 400, { error: INVALID_WORKDOC_REQUEST });
        return;
      }
      input['limit'] = Number(limitRaw);
    }
    // The owner filter is FORCED from the resolved owner: only that user's
    // documents (never ownerless legacy rows) can ever return.
    input['ownerId'] = ownerId;
    try {
      const documents = await service.list(input);
      json(res, 200, { documents });
    } catch (error) {
      const mapped = handleStoreError(error);
      json(res, mapped.status, { error: mapped.message });
    }
  };

  const create: RequestHandler = async (req, res) => {
    const ownerId = ownerIdOr401(res);
    if (ownerId === null) {
      return;
    }
    const slug = req.params['slug'] ?? '';
    // Creation is the orchestrator's own agent-sourced route (fixed path).
    if (slug !== 'orchestrator') {
      json(res, 404, { error: 'Unknown agent slug.' });
      return;
    }
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      json(res, 400, { error: INVALID_WORKDOC_REQUEST });
      return;
    }
    try {
      const document = await service.create({
        scope: 'default',
        chatId: parsed.data.chatId,
        type: parsed.data.type,
        title: parsed.data.title,
        content: parsed.data.content,
        status: 'draft',
        // The owner is the RESOLVED identity, never a body field.
        ownerId,
      });
      json(res, 201, { document });
    } catch (error) {
      const mapped = handleStoreError(error);
      json(res, mapped.status, { error: mapped.message });
    }
  };

  /** Loads a doc and enforces chat + owner ownership (mismatches → fixed 404). */
  const chatIdQuery = (req: Request): string | undefined => {
    const value = req.query['chatId'];
    return typeof value === 'string' ? value : undefined;
  };

  const getOwned = async (id: string, chatId: string | undefined, ownerId: string): Promise<{ ok: true } | { ok: false; status: number }> => {
    if (typeof chatId !== 'string' || chatId.length === 0) {
      return { ok: false, status: 400 };
    }
    const identity = workDocIdSchema.safeParse(id);
    if (!identity.success) {
      return { ok: false, status: 404 };
    }
    // Core owner guard: foreign AND ownerless rows read as null (no oracle).
    const doc = await service.get(id, { expectedOwnerId: ownerId });
    if (doc === null) {
      return { ok: false, status: 404 };
    }
    if (doc.chatId !== chatId) {
      // Cross-chat/cross-scope access must not reveal existence (phase spec).
      return { ok: false, status: 404 };
    }
    return { ok: true };
  };

  const getDoc: RequestHandler = async (req, res) => {
    try {
      const ownerId = ownerIdOr401(res);
      if (ownerId === null) {
        return;
      }
      const slug = req.params['slug'] ?? '';
      if (!SLUGS.includes(slug)) {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      const owned = await getOwned(req.params['id'] ?? '', chatIdQuery(req), ownerId);
      if (!owned.ok) {
        json(res, owned.status, { error: owned.status === 400 ? INVALID_WORKDOC_REQUEST : WORKDOC_NOT_FOUND });
        return;
      }
      const [document, versions, links] = await Promise.all([
        service.get(req.params['id'] ?? '', { expectedOwnerId: ownerId }),
        service.listVersions({ id: req.params['id'] as string, order: 'newest', limit: 5, expectedOwnerId: ownerId }),
        service.listLinks(req.params['id'] as string, { expectedOwnerId: ownerId }),
      ]);
      json(res, 200, { document, recentVersions: versions, links });
    } catch (error) {
      const mapped = handleStoreError(error);
      json(res, mapped.status, { error: mapped.message });
    }
  };

  const patchDoc: RequestHandler = async (req, res) => {
    try {
      const ownerId = ownerIdOr401(res);
      if (ownerId === null) {
        return;
      }
      const slug = req.params['slug'] ?? '';
      if (!SLUGS.includes(slug)) {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      const parsed = patchBodySchema.safeParse(req.body);
      if (!parsed.success) {
        json(res, 400, { error: INVALID_WORKDOC_REQUEST });
        return;
      }
      const owned = await getOwned(req.params['id'] ?? '', parsed.data.chatId, ownerId);
      if (!owned.ok) {
        json(res, owned.status, { error: owned.status === 400 ? INVALID_WORKDOC_REQUEST : WORKDOC_NOT_FOUND });
        return;
      }
      const document = await service.update({
        id: req.params['id'] as string,
        expectedVersion: parsed.data.expectedVersion,
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        source: 'user',
        actorId: parsed.data.chatId,
        expectedScope: 'default',
        expectedChatId: parsed.data.chatId,
        expectedOwnerId: ownerId,
      });
      json(res, 200, { document });
    } catch (error) {
      const mapped = handleStoreError(error);
      json(res, mapped.status, { error: mapped.message });
    }
  };

  const listVersions: RequestHandler = async (req, res) => {
    try {
      const ownerId = ownerIdOr401(res);
      if (ownerId === null) {
        return;
      }
      const slug = req.params['slug'] ?? '';
      if (!SLUGS.includes(slug)) {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      const limitRaw = req.query['limit'];
      const input: { id: string; limit?: number; expectedOwnerId: string } = { id: req.params['id'] ?? '', expectedOwnerId: ownerId };
      if (limitRaw !== undefined) {
        if (typeof limitRaw !== 'string' || !INTEGER_STRING.test(limitRaw)) {
          json(res, 400, { error: INVALID_WORKDOC_REQUEST });
          return;
        }
        input['limit'] = Number(limitRaw);
      }
      const owned = await getOwned(req.params['id'] ?? '', chatIdQuery(req), ownerId);
      if (!owned.ok) {
        json(res, owned.status, { error: owned.status === 400 ? INVALID_WORKDOC_REQUEST : WORKDOC_NOT_FOUND });
        return;
      }
      const versions = await service.listVersions(input);
      json(res, 200, { versions });
    } catch (error) {
      const mapped = handleStoreError(error);
      json(res, mapped.status, { error: mapped.message });
    }
  };

  const getVersion: RequestHandler = async (req, res) => {
    try {
      const ownerId = ownerIdOr401(res);
      if (ownerId === null) {
        return;
      }
      const slug = req.params['slug'] ?? '';
      if (!SLUGS.includes(slug)) {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      const versionRaw = req.params['version'] ?? '';
      if (!INTEGER_STRING.test(versionRaw) || Number(versionRaw) < 1) {
        json(res, 400, { error: INVALID_WORKDOC_REQUEST });
        return;
      }
      const owned = await getOwned(req.params['id'] ?? '', chatIdQuery(req), ownerId);
      if (!owned.ok) {
        json(res, owned.status, { error: owned.status === 400 ? INVALID_WORKDOC_REQUEST : WORKDOC_NOT_FOUND });
        return;
      }
      const versions = await service.listVersions({ id: req.params['id'] as string, limit: 1000, expectedOwnerId: ownerId });
      const version = versions.find((candidate) => candidate.version === Number(versionRaw));
      if (version === undefined) {
        json(res, 404, { error: WORKDOC_NOT_FOUND });
        return;
      }
      json(res, 200, { version });
    } catch (error) {
      const mapped = handleStoreError(error);
      json(res, mapped.status, { error: mapped.message });
    }
  };

  const postVersion: RequestHandler = async (req, res) => {
    try {
      const ownerId = ownerIdOr401(res);
      if (ownerId === null) {
        return;
      }
      const slug = req.params['slug'] ?? '';
      // Agent content updates go through the orchestrator's route (the tool's
      // only writer path); other slugs stay 404.
      if (slug !== 'orchestrator') {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      const parsed = postVersionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        json(res, 400, { error: INVALID_WORKDOC_REQUEST });
        return;
      }
      const owned = await getOwned(req.params['id'] ?? '', parsed.data.chatId, ownerId);
      if (!owned.ok) {
        json(res, owned.status, { error: owned.status === 400 ? INVALID_WORKDOC_REQUEST : WORKDOC_NOT_FOUND });
        return;
      }
      const document = await service.update({
        id: req.params['id'] as string,
        expectedVersion: parsed.data.expectedVersion,
        ...(parsed.data.content !== undefined ? { content: parsed.data.content } : {}),
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        source: parsed.data.source ?? 'agent',
        actorId: parsed.data.chatId,
        ...(parsed.data.summary !== undefined ? { summary: parsed.data.summary } : {}),
        expectedScope: 'default',
        expectedChatId: parsed.data.chatId,
        expectedOwnerId: ownerId,
      });
      json(res, 200, { document });
    } catch (error) {
      const mapped = handleStoreError(error);
      json(res, mapped.status, { error: mapped.message });
    }
  };

  const rollback: RequestHandler = async (req, res) => {
    try {
      const ownerId = ownerIdOr401(res);
      if (ownerId === null) {
        return;
      }
      const slug = req.params['slug'] ?? '';
      if (!SLUGS.includes(slug)) {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      const parsed = rollbackBodySchema.safeParse(req.body);
      if (!parsed.success) {
        json(res, 400, { error: INVALID_WORKDOC_REQUEST });
        return;
      }
      const owned = await getOwned(req.params['id'] ?? '', parsed.data.chatId, ownerId);
      if (!owned.ok) {
        json(res, owned.status, { error: owned.status === 400 ? INVALID_WORKDOC_REQUEST : WORKDOC_NOT_FOUND });
        return;
      }
      const document = await service.rollback({
        id: req.params['id'] as string,
        expectedVersion: parsed.data.expectedVersion,
        toVersion: parsed.data.toVersion,
        source: parsed.data.source ?? 'user',
        actorId: parsed.data.chatId,
        ...(parsed.data.summary !== undefined ? { summary: parsed.data.summary } : {}),
        expectedScope: 'default',
        expectedChatId: parsed.data.chatId,
        expectedOwnerId: ownerId,
      });
      json(res, 200, { document });
    } catch (error) {
      const mapped = handleStoreError(error);
      json(res, mapped.status, { error: mapped.message });
    }
  };

  const listRevisions: RequestHandler = async (req, res) => {
    try {
      const ownerId = ownerIdOr401(res);
      if (ownerId === null) {
        return;
      }
      const slug = req.params['slug'] ?? '';
      if (!SLUGS.includes(slug)) {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      const limitRaw = req.query['limit'];
      const input: { id: string; limit?: number; expectedOwnerId: string } = { id: req.params['id'] ?? '', expectedOwnerId: ownerId };
      if (limitRaw !== undefined) {
        if (typeof limitRaw !== 'string' || !INTEGER_STRING.test(limitRaw)) {
          json(res, 400, { error: INVALID_WORKDOC_REQUEST });
          return;
        }
        input['limit'] = Number(limitRaw);
      }
      const owned = await getOwned(req.params['id'] ?? '', chatIdQuery(req), ownerId);
      if (!owned.ok) {
        json(res, owned.status, { error: owned.status === 400 ? INVALID_WORKDOC_REQUEST : WORKDOC_NOT_FOUND });
        return;
      }
      const revisions = await service.listRevisions(input);
      json(res, 200, { revisions });
    } catch (error) {
      const mapped = handleStoreError(error);
      json(res, mapped.status, { error: mapped.message });
    }
  };

  const addLink: RequestHandler = async (req, res) => {
    try {
      const ownerId = ownerIdOr401(res);
      if (ownerId === null) {
        return;
      }
      const slug = req.params['slug'] ?? '';
      if (!SLUGS.includes(slug)) {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      const parsed = addLinkBodySchema.safeParse(req.body);
      if (!parsed.success) {
        json(res, 400, { error: INVALID_WORKDOC_REQUEST });
        return;
      }
      const owned = await getOwned(req.params['id'] ?? '', parsed.data.chatId, ownerId);
      if (!owned.ok) {
        json(res, owned.status, { error: owned.status === 400 ? INVALID_WORKDOC_REQUEST : WORKDOC_NOT_FOUND });
        return;
      }
      const link = await service.addLink({
        id: req.params['id'] as string,
        targetType: parsed.data.targetType,
        targetId: parsed.data.targetId,
        ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
        expectedScope: 'default',
        expectedChatId: parsed.data.chatId,
        expectedOwnerId: ownerId,
      });
      json(res, 201, { link });
    } catch (error) {
      const mapped = handleStoreError(error);
      json(res, mapped.status, { error: mapped.message });
    }
  };

  const listLinks: RequestHandler = async (req, res) => {
    try {
      const ownerId = ownerIdOr401(res);
      if (ownerId === null) {
        return;
      }
      const slug = req.params['slug'] ?? '';
      if (!SLUGS.includes(slug)) {
        json(res, 404, { error: 'Unknown agent slug.' });
        return;
      }
      const owned = await getOwned(req.params['id'] ?? '', chatIdQuery(req), ownerId);
      if (!owned.ok) {
        json(res, owned.status, { error: owned.status === 400 ? INVALID_WORKDOC_REQUEST : WORKDOC_NOT_FOUND });
        return;
      }
      const links = await service.listLinks(req.params['id'] as string, { expectedOwnerId: ownerId });
      json(res, 200, { links });
    } catch (error) {
      const mapped = handleStoreError(error);
      json(res, mapped.status, { error: mapped.message });
    }
  };

  return { list, create, getDoc, patchDoc, listVersions, getVersion, postVersion, rollback, listRevisions, addLink, listLinks };
}
