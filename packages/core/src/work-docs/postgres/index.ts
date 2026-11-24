/**
 * Prisma/Postgres store for the work-docs domain. Exported ONLY from the
 * `@workforce/core/work-docs/postgres` subpath: importing this module loads
 * the generated Prisma client, so consumers that don't need Postgres (the
 * CLI, pure domain tests) must use `@workforce/core` or
 * `@workforce/core/work-docs` instead.
 *
 * ## Prisma usage
 * The caller constructs the PrismaClient (from `@workforce/core/generated/prisma`
 * or `@prisma/client` configured to the same generated output) and hands it to
 * {@link PrismaWorkDocStore}. All access is the typed Prisma model API; the
 * only raw SQL is one parameterized row-lock probe:
 *
 * - `update`/`rollback` lock the document row FIRST
 *   (`SELECT ... FOR UPDATE`, id bound as `$1`), then re-read the version, so
 *   concurrent same-document writes serialize: exactly one CAS winner, stale
 *   callers get typed `WorkDocConflictError`s instead of unique-violation
 *   noise.
 * - Every multi-row write (document + version snapshot + audit revision; link
 *   insert) runs inside ONE interactive transaction — partial writes are
 *   impossible.
 * - History is append-only: rollback INSERTS a new version copied from the
 *   target snapshot; no update/delete ever touches `WorkDocVersion` or
 *   `WorkDocRevision` rows.
 * - Links are idempotent per (documentId, targetType, targetId) — the unique
 *   tuple is consulted before insert.
 *
 * ## Typed errors
 * Missing document/version -> WorkDocNotFoundError (404); stale expectedVersion
 * -> WorkDocConflictError (409); malformed input -> WorkDocValidationError
 * (400). No raw errors with content escape: Prisma internals are attached as
 * `cause` only. A raced P2025 (row deleted between the locked re-read and the
 * write) maps to the SAME 404 the in-memory store produces for a missing row.
 *
 * ## Ownership
 * `ownerId` is the platform user (Better Auth `User.id`, TEXT) or null for
 * legacy rows. Owner guards/filters match EXACTLY — an expected owner never
 * matches ownerless or other-user rows, and a mismatch reads as 404/null:
 * no cross-tenant oracle. The authenticated API layer MUST always pass the
 * owner on create and on every owner-scoped read/list/mutation.
 */

import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@workforce/core/generated/prisma';

import {
  enforceOwner,
  enforceOwnership,
  validateGetOptions,
  validateHistoryOptions,
  validateLinkInsert,
  validateListParams,
  validateDocumentId,
  validateRollbackTarget,
  validateStoreCreate,
  validateStoreRollback,
  validateStoreUpdate,
} from '../validate.js';
import { WorkDocConflictError, WorkDocNotFoundError, WorkDocValidationError } from '../errors.js';
import type {
  WorkDocGetOptions,
  WorkDocHistoryListOptions,
  WorkDocLinkInsert,
  WorkDocListParams,
  WorkDocStore,
  WorkDocStoreCreate,
  WorkDocStoreRollback,
  WorkDocStoreUpdate,
} from '../store.js';
import type { WorkDoc, WorkDocVersion, WorkDocRevision, WorkDocLink } from '../types.js';

type RowDoc = Prisma.WorkDocGetPayload<object>;
type RowVersion = Prisma.WorkDocVersionGetPayload<object>;
type RowRevision = Prisma.WorkDocRevisionGetPayload<object>;
type RowLink = Prisma.WorkDocLinkGetPayload<object>;

function mapDoc(row: RowDoc): WorkDoc {
  return {
    id: row.id,
    scope: row.scope,
    chatId: row.chatId,
    type: row.type,
    title: row.title,
    content: row.content,
    status: row.status,
    version: row.version,
    // Normalizes absent fields too (fake rows in tests): never `undefined`.
    ownerId: row.ownerId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapVersion(row: RowVersion): WorkDocVersion {
  return {
    id: row.id,
    documentId: row.documentId,
    version: row.version,
    title: row.title,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapRevision(row: RowRevision): WorkDocRevision {
  return {
    id: row.id,
    documentId: row.documentId,
    source: row.source,
    actorId: row.actorId,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapLink(row: RowLink): WorkDocLink {
  return {
    id: row.id,
    documentId: row.documentId,
    targetType: row.targetType,
    targetId: row.targetId,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Convert a Prisma unique-violation into a typed conflict; rethrow otherwise. */
function asConflictOrOriginal(cause: unknown, message: string): WorkDocConflictError | unknown {
  if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
    return new WorkDocConflictError(message, { cause });
  }
  return cause;
}

/**
 * Map a raced P2025 (row vanished between the locked re-read and the write)
 * into the SAME typed 404 the in-memory store produces for a missing row —
 * identical semantics across adapters.
 */
function asNotFoundOrOriginal(cause: unknown, message: string): WorkDocNotFoundError | unknown {
  if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2025') {
    return new WorkDocNotFoundError(message, { cause });
  }
  return cause;
}

/**
 * Typed mapping for CAS writes that already re-read the row under lock:
 * P2002 -> conflict, P2025 (row vanished between the lock and the write) ->
 * the SAME typed 404 the in-memory store produces, everything else rethrown.
 */
function asNotFoundOrConflict(cause: unknown, conflictMessage: string, notFoundMessage: string): unknown {
  if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2025') {
    return new WorkDocNotFoundError(notFoundMessage, { cause });
  }
  return asConflictOrOriginal(cause, conflictMessage);
}

export class PrismaWorkDocStore implements WorkDocStore {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    if (!prisma) {
      throw new WorkDocValidationError('PrismaWorkDocStore requires an explicit PrismaClient');
    }
    this.prisma = prisma;
  }

  // -- create/get/list -------------------------------------------------------

  async create(data: WorkDocStoreCreate): Promise<WorkDoc> {
    const validated = validateStoreCreate(data);
    const now = new Date();
    const createdAt = validated.createdAt ?? now;
    const id = validated.id ?? undefined;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const document = await tx.workDoc.create({
          data: {
            ...(id !== undefined ? { id } : {}),
            scope: validated.scope,
            chatId: validated.chatId,
            type: validated.type,
            title: validated.title,
            content: validated.content,
            status: validated.status,
            ownerId: validated.ownerId,
            version: 1,
            createdAt,
            updatedAt: createdAt,
          },
        });
        await tx.workDocVersion.create({
          data: {
            id: randomUUID(),
            documentId: document.id,
            version: 1,
            title: validated.title,
            content: validated.content,
            status: validated.status,
            createdAt,
          },
        });
        await tx.workDocRevision.create({
          data: {
            id: randomUUID(),
            documentId: document.id,
            source: 'agent',
            actorId: null,
            fromVersion: null,
            toVersion: 1,
            summary: 'created',
            createdAt,
          },
        });
        return mapDoc(document);
      });
    } catch (cause) {
      throw asConflictOrOriginal(
        cause,
        typeof id === 'string' ? `work doc ${id} already exists` : 'work doc id conflict on create',
      );
    }
  }

  async get(id: string, options?: WorkDocGetOptions): Promise<WorkDoc | null> {
    validateDocumentId(id);
    const validatedOptions = validateGetOptions(options);
    const row = await this.prisma.workDoc.findUnique({ where: { id } });
    if (!row) {
      return null;
    }
    // Owner guard reads foreign/ownerless rows as absent — never an oracle.
    if (validatedOptions.expectedOwnerId !== null && (row.ownerId ?? null) !== validatedOptions.expectedOwnerId) {
      return null;
    }
    return mapDoc(row);
  }

  async list(params: WorkDocListParams): Promise<readonly WorkDoc[]> {
    const validated = validateListParams(params);
    const rows = await this.prisma.workDoc.findMany({
      where: {
        ...(validated.scope !== null ? { scope: validated.scope } : {}),
        ...(validated.chatId !== null ? { chatId: validated.chatId } : {}),
        ...(validated.type !== null ? { type: validated.type } : {}),
        ...(validated.status !== null ? { status: validated.status } : {}),
        ...(validated.ownerId !== null ? { ownerId: validated.ownerId } : {}),
      },
      orderBy: validated.order === 'newest'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : [{ createdAt: 'asc' }, { id: 'asc' }],
      take: validated.limit,
    });
    return rows.map((row) => mapDoc(row));
  }

  // -- CAS mutations ----------------------------------------------------------

  async update(data: WorkDocStoreUpdate): Promise<WorkDoc> {
    const validated = validateStoreUpdate(data);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize concurrent same-document writers on the document row.
        await tx.$queryRaw`SELECT "id" FROM "WorkDoc" WHERE "id" = ${validated.id}::uuid FOR UPDATE`;
        const document = await tx.workDoc.findUnique({ where: { id: validated.id } });
        if (!document) {
          throw new WorkDocNotFoundError(`work doc ${validated.id} not found`);
        }
        enforceOwnership(document, validated.expectedScope, validated.expectedChatId, validated.expectedOwnerId);
        if (document.version !== validated.expectedVersion) {
          throw new WorkDocConflictError(
            `work doc ${validated.id} version is ${document.version}; expectedVersion ${validated.expectedVersion} is stale`,
          );
        }

        const nextVersion = document.version + 1;
        const now = new Date();
        const title = validated.title ?? document.title;
        const content = validated.content ?? document.content;
        const status = validated.status ?? document.status;

        await tx.workDocVersion.create({
          data: {
            id: randomUUID(),
            documentId: document.id,
            version: nextVersion,
            title,
            content,
            status,
            createdAt: now,
          },
        });
        await tx.workDocRevision.create({
          data: {
            id: randomUUID(),
            documentId: document.id,
            source: validated.source,
            actorId: validated.actorId,
            fromVersion: document.version,
            toVersion: nextVersion,
            summary: validated.summary ?? 'updated doc',
            createdAt: now,
          },
        });
        const updated = await tx.workDoc.update({
          where: { id: document.id },
          data: { title, content, status, version: nextVersion, updatedAt: now },
        });
        return mapDoc(updated);
      });
    } catch (cause) {
      throw asNotFoundOrConflict(
        cause,
        `work doc ${validated.id} concurrent write conflict`,
        `work doc ${validated.id} not found`,
      );
    }
  }

  async rollback(data: WorkDocStoreRollback): Promise<WorkDoc> {
    const validated = validateStoreRollback(data);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "WorkDoc" WHERE "id" = ${validated.id}::uuid FOR UPDATE`;
        const document = await tx.workDoc.findUnique({ where: { id: validated.id } });
        if (!document) {
          throw new WorkDocNotFoundError(`work doc ${validated.id} not found`);
        }
        enforceOwnership(document, validated.expectedScope, validated.expectedChatId, validated.expectedOwnerId);
        if (document.version !== validated.expectedVersion) {
          throw new WorkDocConflictError(
            `work doc ${validated.id} version is ${document.version}; expectedVersion ${validated.expectedVersion} is stale`,
          );
        }
        validateRollbackTarget(validated.toVersion, document.version);

        const target = await tx.workDocVersion.findUnique({
          where: { documentId_version: { documentId: document.id, version: validated.toVersion } },
        });
        if (!target) {
          throw new WorkDocNotFoundError(`work doc ${validated.id} has no version ${validated.toVersion}`);
        }

        const nextVersion = document.version + 1;
        const now = new Date();

        await tx.workDocVersion.create({
          data: {
            id: randomUUID(),
            documentId: document.id,
            version: nextVersion,
            title: target.title,
            content: target.content,
            status: target.status,
            createdAt: now,
          },
        });
        await tx.workDocRevision.create({
          data: {
            id: randomUUID(),
            documentId: document.id,
            source: validated.source,
            actorId: validated.actorId,
            fromVersion: document.version,
            toVersion: nextVersion,
            summary: validated.summary ?? `restored content from version ${validated.toVersion}`,
            createdAt: now,
          },
        });
        const updated = await tx.workDoc.update({
          where: { id: document.id },
          data: {
            title: target.title,
            content: target.content,
            status: target.status,
            version: nextVersion,
            updatedAt: now,
          },
        });
        return mapDoc(updated);
      });
    } catch (cause) {
      throw asNotFoundOrConflict(
        cause,
        `work doc ${validated.id} concurrent rollback conflict`,
        `work doc ${validated.id} not found`,
      );
    }
  }

  // -- history ---------------------------------------------------------------

  async listVersions(documentId: string, options: WorkDocHistoryListOptions): Promise<readonly WorkDocVersion[]> {
    const validated = validateHistoryOptions(documentId, options);
    const document = await this.prisma.workDoc.findUnique({ where: { id: documentId } });
    if (!document) {
      throw new WorkDocNotFoundError(`work doc ${documentId} not found`);
    }
    // Owner guard: foreign/ownerless documents read as 404 (no oracle).
    enforceOwner(document, validated.expectedOwnerId);
    const rows = await this.prisma.workDocVersion.findMany({
      where: { documentId },
      orderBy: { version: validated.order === 'newest' ? 'desc' : 'asc' },
      take: validated.limit,
    });
    return rows.map((row) => mapVersion(row));
  }

  async listRevisions(documentId: string, options: WorkDocHistoryListOptions): Promise<readonly WorkDocRevision[]> {
    const validated = validateHistoryOptions(documentId, options);
    const document = await this.prisma.workDoc.findUnique({ where: { id: documentId } });
    if (!document) {
      throw new WorkDocNotFoundError(`work doc ${documentId} not found`);
    }
    enforceOwner(document, validated.expectedOwnerId);
    const rows = await this.prisma.workDocRevision.findMany({
      where: { documentId },
      orderBy: validated.order === 'newest'
        ? [{ toVersion: 'desc' }, { id: 'desc' }]
        : [{ toVersion: 'asc' }, { id: 'asc' }],
      take: validated.limit,
    });
    return rows.map((row) => mapRevision(row));
  }

  // -- links -----------------------------------------------------------------

  async addLink(data: WorkDocLinkInsert): Promise<WorkDocLink> {
    const validated = validateLinkInsert(data);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const document = await tx.workDoc.findUnique({ where: { id: validated.documentId } });
        if (!document) {
          throw new WorkDocNotFoundError(`work doc ${validated.documentId} not found`);
        }
        enforceOwnership(document, validated.expectedScope, validated.expectedChatId, validated.expectedOwnerId);
        const existing = await tx.workDocLink.findUnique({
          where: {
            documentId_targetType_targetId: {
              documentId: validated.documentId,
              targetType: validated.targetType,
              targetId: validated.targetId,
            },
          },
        });
        if (existing) {
          // Idempotent: the tuple already exists; return it unchanged.
          return mapLink(existing);
        }
        const created = await tx.workDocLink.create({
          data: {
            id: randomUUID(),
            documentId: validated.documentId,
            targetType: validated.targetType,
            targetId: validated.targetId,
            label: validated.label,
            createdAt: new Date(),
          },
        });
        return mapLink(created);
      });
    } catch (cause) {
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === 'P2002'
      ) {
        // Concurrent check-then-create lost the unique-tuple race: another
        // transaction inserted the link between our findUnique and create.
        // The interactive transaction above is now REJECTED/aborted, so the
        // P2002 replay MUST be handled OUT HERE: re-read through
        // `this.prisma` (a fresh connection — never inside the aborted
        // transaction) and return the winner idempotently instead of a 409.
        const winner = await this.prisma.workDocLink.findUnique({
          where: {
            documentId_targetType_targetId: {
              documentId: validated.documentId,
              targetType: validated.targetType,
              targetId: validated.targetId,
            },
          },
        });
        if (winner) {
          return mapLink(winner);
        }
        throw new WorkDocConflictError(
          `work doc ${validated.documentId} link ${validated.targetType}/${validated.targetId} raced without a persisted winner`,
          { cause },
        );
      }
      throw asConflictOrOriginal(
        cause,
        `work doc ${validated.documentId} link ${validated.targetType}/${validated.targetId} conflict`,
      );
    }
  }

  async listLinks(documentId: string, options?: WorkDocGetOptions): Promise<readonly WorkDocLink[]> {
    validateDocumentId(documentId);
    const validatedOptions = validateGetOptions(options);
    const document = await this.prisma.workDoc.findUnique({ where: { id: documentId } });
    if (!document) {
      throw new WorkDocNotFoundError(`work doc ${documentId} not found`);
    }
    enforceOwner(document, validatedOptions.expectedOwnerId);
    const rows = await this.prisma.workDocLink.findMany({
      where: { documentId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => mapLink(row));
  }
}

/** Factory kept for symmetry with `createPostgresMemoryStore`. */
export function createPrismaWorkDocStore(prisma: PrismaClient): PrismaWorkDocStore {
  return new PrismaWorkDocStore(prisma);
}
