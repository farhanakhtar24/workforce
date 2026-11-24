/**
 * {@link WorkDocService} — validated façade over a {@link WorkDocStore} for
 * API/agent use.
 *
 * Responsibilities:
 * - Parse every input against the route schemas in `./schemas.js` and convert
 *   Zod issues into typed {@link WorkDocValidationError}s (400), BEFORE the
 *   store is touched. Stores re-validate (defense in depth) but the service is
 *   the boundary where raw JSON becomes structured, normalized input.
 * - Owns mutation ACTOR metadata: every update/rollback names its
 *   {@link WorkDocRevisionSource} ('agent' | 'user') and optional actorId —
 *   the audit trail is never anonymous.
 * - Owns scope/chat OWNERSHIP guards: optional `expectedScope`/
 *   `expectedChatId` on every mutation (update/rollback/link) must match the
 *   document's values or the mutation reads as 404 — no cross-tenant oracle.
 * - Apply documented summary defaults so the audit trail is never empty:
 *   create -> `created`; update -> `updated doc`; rollback ->
 *   `restored content from version N` (all bounded to 1..500 characters).
 * - Never swallows store state: 404/409 typed errors pass through unchanged so
 *   routes map them directly, and no error message echoes document content.
 *
 * Concurrency: the store owns serialization. The service performs no
 * read-modify-write of its own — `update`/`rollback` are pure CAS calls, so
 * one concurrent writer succeeds and stale `expectedVersion` callers receive
 * {@link WorkDocConflictError}.
 */

import {
  rollbackWorkDocInputSchema,
  createWorkDocInputSchema,
  updateWorkDocInputSchema,
  listWorkDocsInputSchema,
  listWorkDocVersionsInputSchema,
  listWorkDocRevisionsInputSchema,
  addWorkDocLinkInputSchema,
  parseWorkDocInput,
  workDocGetOptionsSchema,
  workDocIdSchema,
  type ParsedWorkDocAddLinkInput,
  type ParsedWorkDocCreateInput,
  type ParsedWorkDocGetOptions,
  type ParsedWorkDocListInput,
  type ParsedWorkDocListRevisionsInput,
  type ParsedWorkDocListVersionsInput,
  type ParsedWorkDocRollbackInput,
  type ParsedWorkDocUpdateInput,
  type WorkDocAddLinkInput,
  type WorkDocCreateInput,
  type WorkDocListInput,
  type WorkDocListRevisionsInput,
  type WorkDocListVersionsInput,
  type WorkDocRollbackInput,
  type WorkDocUpdateInput,
} from './schemas.js';
import type { WorkDocGetOptions } from './store.js';
import type {
  WorkDocHistoryListOptions,
  WorkDocStore,
} from './store.js';
import type { WorkDoc, WorkDocVersion, WorkDocRevision, WorkDocLink } from './types.js';
import { WorkDocValidationError } from './errors.js';

export interface WorkDocServiceOptions {
  readonly store: WorkDocStore;
}

/**
 * Public service: everything the API layer needs for work documents. All
 * methods are thin over the store contract (see `./store.js` for semantics:
 * atomic versioned writes, CAS, append-only history, idempotent links).
 */
export class WorkDocService {
  private readonly store: WorkDocStore;

  constructor(options: WorkDocServiceOptions) {
    if (!options?.store) {
      throw new WorkDocValidationError('WorkDocService requires an explicit store; there is no hidden default');
    }
    this.store = options.store;
  }

  /** Create a document: version 1, snapshot, and creation revision in one write. */
  async create(input: WorkDocCreateInput): Promise<WorkDoc> {
    const parsed: ParsedWorkDocCreateInput = parseWorkDocInput(createWorkDocInputSchema, input);
    return this.store.create({
      scope: parsed.scope,
      chatId: parsed.chatId,
      type: parsed.type,
      title: parsed.title,
      content: parsed.content,
      status: parsed.status,
      ownerId: parsed.ownerId ?? null,
    });
  }

  /**
   * Read one document, or null when absent. With `options.expectedOwnerId`
   * (the owner guard authenticated API callers MUST supply), a foreign or
   * ownerless row also reads as null — never an existence oracle.
   */
  async get(id: string, options?: WorkDocGetOptions): Promise<WorkDoc | null> {
    const parsedId = parseWorkDocInput(workDocIdSchema, id);
    const parsedOptions: ParsedWorkDocGetOptions = parseWorkDocInput(workDocGetOptionsSchema, options ?? {});
    return this.store.get(parsedId, parsedOptions);
  }

  /** Bounded deterministic listing filtered by scope/chat/type/status/owner. */
  async list(input: WorkDocListInput): Promise<readonly WorkDoc[]> {
    const parsed: ParsedWorkDocListInput = parseWorkDocInput(listWorkDocsInputSchema, input);
    return this.store.list({
      scope: parsed.scope,
      chatId: parsed.chatId,
      type: parsed.type,
      status: parsed.status,
      ownerId: parsed.ownerId ?? null,
      order: parsed.order,
      limit: parsed.limit,
    });
  }

  /**
   * CAS update: bumps the version, appends the snapshot and audit revision.
   * `source` is required; `summary` defaults to `updated doc`. Optional
   * `expectedScope`/`expectedChatId`/`expectedOwnerId` enforce ownership; a
   * mismatch is a typed 404, never a cross-tenant existence oracle. The
   * authenticated API layer MUST always pass `expectedOwnerId`.
   */
  async update(input: WorkDocUpdateInput): Promise<WorkDoc> {
    const parsed: ParsedWorkDocUpdateInput = parseWorkDocInput(updateWorkDocInputSchema, input);
    return this.store.update({
      id: parsed.id,
      expectedVersion: parsed.expectedVersion,
      title: parsed.title,
      content: parsed.content,
      status: parsed.status,
      source: parsed.source,
      actorId: parsed.actorId,
      summary: parsed.summary,
      expectedScope: parsed.expectedScope,
      expectedChatId: parsed.expectedChatId,
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    });
  }

  /**
   * CAS rollback: copies the target snapshot into a NEW version. `summary`
   * defaults to `restored content from version <toVersion>`. Ownership guards
   * behave like on `update` (mismatch reads as 404, no oracle).
   */
  async rollback(input: WorkDocRollbackInput): Promise<WorkDoc> {
    const parsed: ParsedWorkDocRollbackInput = parseWorkDocInput(rollbackWorkDocInputSchema, input);
    return this.store.rollback({
      id: parsed.id,
      expectedVersion: parsed.expectedVersion,
      toVersion: parsed.toVersion,
      source: parsed.source,
      actorId: parsed.actorId,
      summary: parsed.summary ?? `restored content from version ${parsed.toVersion}`,
      expectedScope: parsed.expectedScope,
      expectedChatId: parsed.expectedChatId,
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    });
  }

  /** Immutable version history (append-only), oldest-first by default. */
  async listVersions(input: WorkDocListVersionsInput): Promise<readonly WorkDocVersion[]> {
    const parsed: ParsedWorkDocListVersionsInput = parseWorkDocInput(listWorkDocVersionsInputSchema, input);
    return this.store.listVersions(parsed.id, this.historyOptions(parsed));
  }

  /** Audit trail ordered by toVersion (then id), oldest-first by default. */
  async listRevisions(input: WorkDocListRevisionsInput): Promise<readonly WorkDocRevision[]> {
    const parsed: ParsedWorkDocListRevisionsInput = parseWorkDocInput(listWorkDocRevisionsInputSchema, input);
    return this.store.listRevisions(parsed.id, this.historyOptions(parsed));
  }

  /** Idempotent per (document, targetType, target) tuple, with ownership guards. */
  async addLink(input: WorkDocAddLinkInput): Promise<WorkDocLink> {
    const parsed: ParsedWorkDocAddLinkInput = parseWorkDocInput(addWorkDocLinkInputSchema, input);
    return this.store.addLink({
      documentId: parsed.id,
      targetType: parsed.targetType,
      targetId: parsed.targetId,
      label: parsed.label,
      expectedScope: parsed.expectedScope,
      expectedChatId: parsed.expectedChatId,
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    });
  }

  /**
   * Links for one document, oldest-first (createdAt then id). With
   * `options.expectedOwnerId` a foreign/ownerless document reads as 404.
   */
  async listLinks(id: string, options?: WorkDocGetOptions): Promise<readonly WorkDocLink[]> {
    const parsedId = parseWorkDocInput(workDocIdSchema, id);
    const parsedOptions: ParsedWorkDocGetOptions = parseWorkDocInput(workDocGetOptionsSchema, options ?? {});
    return this.store.listLinks(parsedId, parsedOptions);
  }

  private historyOptions(
    parsed: ParsedWorkDocListVersionsInput,
  ): WorkDocHistoryListOptions {
    return {
      order: parsed.order,
      limit: parsed.limit,
      expectedOwnerId: parsed.expectedOwnerId ?? null,
    };
  }
}
