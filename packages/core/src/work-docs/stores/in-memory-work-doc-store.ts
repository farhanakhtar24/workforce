/**
 * {@link WorkDocStore} implementation for fast unit tests — same contract,
 * typed errors, bounds, and ordering guarantees as the Prisma adapter (via the
 * shared `../validate.js` rules), backed by plain Maps.
 *
 * Concurrency model (mirrors `InMemoryMemoryStore`): JavaScript is
 * single-threaded, and every write runs without an intervening `await`
 * between the CAS check and the mutation, so check-then-act is atomic. Two
 * concurrent `update` calls with the same `expectedVersion` therefore
 * serialize: the first succeeds, the second observes the bumped version and
 * fails with `WorkDocConflictError` — exactly one winner, like the Postgres
 * row lock.
 */

import { randomUUID } from 'node:crypto';

import {
  enforceOwnership,
  validateDocumentId,
  validateHistoryOptions,
  validateLinkInsert,
  validateListParams,
  validateRollbackTarget,
  validateStoreCreate,
  validateStoreRollback,
  validateStoreUpdate,
} from '../validate.js';
import { WorkDocConflictError, WorkDocNotFoundError } from '../errors.js';
import type {
  WorkDocHistoryListOptions,
  WorkDocLinkInsert,
  WorkDocListParams,
  WorkDocStore,
  WorkDocStoreCreate,
  WorkDocStoreRollback,
  WorkDocStoreUpdate,
} from '../store.js';
import type { WorkDoc, WorkDocVersion, WorkDocRevision, WorkDocLink } from '../types.js';

function toIso(): string {
  return new Date().toISOString();
}

/** Structured clone keeps internal state safe from caller mutation. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareByCreatedAtThenId(
  direction: 'newest' | 'oldest',
): (a: { id: string; createdAt: string }, b: { id: string; createdAt: string }) => number {
  return (a, b) => {
    const aMs = Date.parse(a.createdAt);
    const bMs = Date.parse(b.createdAt);
    if (aMs !== bMs) {
      return direction === 'newest' ? bMs - aMs : aMs - bMs;
    }
    if (a.id !== b.id) {
      return direction === 'newest' ? (a.id > b.id ? -1 : 1) : a.id < b.id ? -1 : 1;
    }
    return 0;
  };
}

export class InMemoryWorkDocStore implements WorkDocStore {
  private readonly documents = new Map<string, WorkDoc>();
  private readonly versions = new Map<string, WorkDocVersion[]>();
  private readonly revisions = new Map<string, WorkDocRevision[]>();
  private readonly links = new Map<string, WorkDocLink>();

  // -- create/get/list -------------------------------------------------------

  async create(data: WorkDocStoreCreate): Promise<WorkDoc> {
    // One synchronous critical section: no await between check and writes.
    const validated = validateStoreCreate(data);
    const id = validated.id ?? randomUUID();
    if (this.documents.has(id)) {
      throw new WorkDocConflictError(`work doc ${id} already exists`);
    }

    const createdAtIso = validated.createdAt ? validated.createdAt.toISOString() : toIso();

    const document: WorkDoc = {
      id,
      scope: validated.scope,
      chatId: validated.chatId,
      type: validated.type,
      title: validated.title,
      content: validated.content,
      status: validated.status,
      version: 1,
      createdAt: createdAtIso,
      updatedAt: createdAtIso,
    };
    const firstVersion: WorkDocVersion = {
      id: randomUUID(),
      documentId: id,
      version: 1,
      title: validated.title,
      content: validated.content,
      status: validated.status,
      createdAt: createdAtIso,
    };
    const creationRevision: WorkDocRevision = {
      id: randomUUID(),
      documentId: id,
      source: 'agent',
      actorId: null,
      fromVersion: null,
      toVersion: 1,
      summary: 'created',
      createdAt: createdAtIso,
    };

    this.documents.set(id, document);
    this.versions.set(id, [firstVersion]);
    this.revisions.set(id, [creationRevision]);
    return clone(document);
  }

  async get(id: string): Promise<WorkDoc | null> {
    validateDocumentId(id);
    const document = this.documents.get(id);
    return document ? clone(document) : null;
  }

  async list(params: WorkDocListParams): Promise<readonly WorkDoc[]> {
    const validated = validateListParams(params);
    const matches = [...this.documents.values()]
      .filter((document) => {
        if (validated.scope !== null && document.scope !== validated.scope) {
          return false;
        }
        if (validated.chatId !== null && document.chatId !== validated.chatId) {
          return false;
        }
        if (validated.type !== null && document.type !== validated.type) {
          return false;
        }
        if (validated.status !== null && document.status !== validated.status) {
          return false;
        }
        return true;
      })
      .sort(compareByCreatedAtThenId(validated.order))
      .slice(0, validated.limit);

    return matches.map((document) => clone(document));
  }

  // -- CAS mutations ----------------------------------------------------------

  async update(data: WorkDocStoreUpdate): Promise<WorkDoc> {
    return this.updateSync(data);
  }

  private updateSync(data: WorkDocStoreUpdate): WorkDoc {
    const validated = validateStoreUpdate(data);
    const document = this.documents.get(validated.id);
    if (!document) {
      throw new WorkDocNotFoundError(`work doc ${validated.id} not found`);
    }
    enforceOwnership(document, validated.expectedScope, validated.expectedChatId);
    if (document.version !== validated.expectedVersion) {
      throw new WorkDocConflictError(
        `work doc ${validated.id} version is ${document.version}; expectedVersion ${validated.expectedVersion} is stale`,
      );
    }

    const nowIso = toIso();
    const nextVersion = document.version + 1;

    const snapshot: WorkDocVersion = {
      id: randomUUID(),
      documentId: document.id,
      version: nextVersion,
      title: validated.title ?? document.title,
      content: validated.content ?? document.content,
      status: validated.status ?? document.status,
      createdAt: nowIso,
    };
    const revision: WorkDocRevision = {
      id: randomUUID(),
      documentId: document.id,
      source: validated.source,
      actorId: validated.actorId,
      fromVersion: document.version,
      toVersion: nextVersion,
      summary: validated.summary ?? 'updated doc',
      createdAt: nowIso,
    };
    const updated: WorkDoc = {
      ...document,
      title: snapshot.title,
      content: snapshot.content,
      status: snapshot.status,
      version: nextVersion,
      updatedAt: nowIso,
    };

    // Atomic: document row + snapshot + audit in one synchronous section.
    this.documents.set(document.id, updated);
    this.versions.get(document.id)?.push(snapshot);
    this.revisions.get(document.id)?.push(revision);
    return clone(updated);
  }

  async rollback(data: WorkDocStoreRollback): Promise<WorkDoc> {
    return this.rollbackSync(data);
  }

  private rollbackSync(data: WorkDocStoreRollback): WorkDoc {
    const validated = validateStoreRollback(data);
    const document = this.documents.get(validated.id);
    if (!document) {
      throw new WorkDocNotFoundError(`work doc ${validated.id} not found`);
    }
    if (document.version !== validated.expectedVersion) {
      throw new WorkDocConflictError(
        `work doc ${validated.id} version is ${document.version}; expectedVersion ${validated.expectedVersion} is stale`,
      );
    }
    enforceOwnership(document, validated.expectedScope, validated.expectedChatId);
    validateRollbackTarget(validated.toVersion, document.version);

    const history = this.versions.get(validated.id) ?? [];
    const target = history.find((version) => version.version === validated.toVersion);
    if (!target) {
      throw new WorkDocNotFoundError(`work doc ${validated.id} has no version ${validated.toVersion}`);
    }

    const nowIso = toIso();
    const nextVersion = document.version + 1;
    const snapshot: WorkDocVersion = {
      id: randomUUID(),
      documentId: document.id,
      version: nextVersion,
      title: target.title,
      content: target.content,
      status: target.status,
      createdAt: nowIso,
    };
    const revision: WorkDocRevision = {
      id: randomUUID(),
      documentId: document.id,
      source: validated.source,
      actorId: validated.actorId,
      fromVersion: document.version,
      toVersion: nextVersion,
      summary: validated.summary ?? `restored content from version ${validated.toVersion}`,
      createdAt: nowIso,
    };
    const updated: WorkDoc = {
      ...document,
      title: target.title,
      content: target.content,
      status: target.status,
      version: nextVersion,
      updatedAt: nowIso,
    };

    // Append-only: prior versions/revisions stay exactly where they are.
    this.documents.set(document.id, updated);
    this.versions.get(document.id)?.push(snapshot);
    this.revisions.get(document.id)?.push(revision);
    return clone(updated);
  }

  // -- history ---------------------------------------------------------------

  async listVersions(documentId: string, options: WorkDocHistoryListOptions): Promise<readonly WorkDocVersion[]> {
    const validated = validateHistoryOptions(documentId, options);
    if (!this.documents.has(documentId)) {
      throw new WorkDocNotFoundError(`work doc ${documentId} not found`);
    }
    const rows = (this.versions.get(documentId) ?? []).slice();
    rows.sort((a, b) => (validated.order === 'newest' ? b.version - a.version : a.version - b.version));
    return rows.slice(0, validated.limit).map((row) => clone(row));
  }

  async listRevisions(documentId: string, options: WorkDocHistoryListOptions): Promise<readonly WorkDocRevision[]> {
    const validated = validateHistoryOptions(documentId, options);
    if (!this.documents.has(documentId)) {
      throw new WorkDocNotFoundError(`work doc ${documentId} not found`);
    }
    const rows = (this.revisions.get(documentId) ?? []).slice();
    rows.sort((a, b) => {
      const delta = validated.order === 'newest' ? b.toVersion - a.toVersion : a.toVersion - b.toVersion;
      if (delta !== 0) {
        return delta;
      }
      return validated.order === 'newest' ? (a.id > b.id ? -1 : 1) : a.id < b.id ? -1 : 1;
    });
    return rows.slice(0, validated.limit).map((row) => clone(row));
  }

  // -- links -----------------------------------------------------------------

  async addLink(data: WorkDocLinkInsert): Promise<WorkDocLink> {
    return this.addLinkSync(data);
  }

  private addLinkSync(data: WorkDocLinkInsert): WorkDocLink {
    const validated = validateLinkInsert(data);
    const document = this.documents.get(validated.documentId);
    if (!document) {
      throw new WorkDocNotFoundError(`work doc ${validated.documentId} not found`);
    }
    enforceOwnership(document, validated.expectedScope, validated.expectedChatId);

    const key = `${validated.documentId}\u0000${validated.targetType}\u0000${validated.targetId}`;
    const existing = this.links.get(key);
    if (existing) {
      // Idempotent: the tuple already exists; return it unchanged.
      return clone(existing);
    }

    const link: WorkDocLink = {
      id: randomUUID(),
      documentId: validated.documentId,
      targetType: validated.targetType,
      targetId: validated.targetId,
      label: validated.label,
      createdAt: toIso(),
    };
    this.links.set(key, link);
    return clone(link);
  }

  async listLinks(documentId: string): Promise<readonly WorkDocLink[]> {
    validateDocumentId(documentId);
    if (!this.documents.has(documentId)) {
      throw new WorkDocNotFoundError(`work doc ${documentId} not found`);
    }
    const rows = [...this.links.values()]
      .filter((link) => link.documentId === documentId)
      .sort((a, b) => {
        const aMs = Date.parse(a.createdAt);
        const bMs = Date.parse(b.createdAt);
        if (aMs !== bMs) {
          return aMs - bMs;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    return rows.map((row) => clone(row));
  }
}
