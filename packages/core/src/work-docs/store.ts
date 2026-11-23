/**
 * The store contract behind {@link WorkDocService}. Two implementations ship:
 *
 * - `InMemoryWorkDocStore` (`./stores/in-memory-work-doc-store.js`) — exact
 *   synchronous-critical-section store for fast unit tests.
 * - `PrismaWorkDocStore` (`./postgres/index.js`, subpath
 *   `@workforce/core/work-docs/postgres`) — Prisma/Postgres adapter. Import it
 *   ONLY via the subpath so consumers that don't need Postgres (the CLI, pure
 *   domain tests) never load Prisma.
 *
 * Contract notes (both implementations, tested per store):
 * - Multi-row writes (document row + version snapshot + audit revision; link
 *   insert) are ATOMIC. Postgres runs them inside one interactive transaction
 *   that locks the document row (`FOR UPDATE`) first, so concurrent same-
 *   document updates serialize: one succeeds, stale `expectedVersion` calls
 *   get typed {@link WorkDocConflictError}.
 * - `update` and `rollback` are compare-and-set on `version`. `rollback`
 *   copies the target snapshot INTO A NEW version; history is never deleted,
 *   rewritten, or reordered.
 * - Validation re-runs inside stores (defense in depth): scope normalization
 *   reuses the memory-domain `normalizeScope`, and every mutation re-checks
 *   document existence (404) before any state change.
 * - Dates: stores expose ISO strings on all public types (see `./types.js`).
 */

import type { WorkDocStatus, WorkDocType, WorkDocLinkTargetType, WorkDocRevisionSource } from './kinds.js';
import type { WorkDoc, WorkDocVersion, WorkDocRevision, WorkDocLink } from './types.js';

/** Payload for creating one document (v1 + snapshot + audit written atomically). */
export interface WorkDocStoreCreate {
  /** Optional id for deterministic tests. */
  readonly id?: string;
  readonly scope: string;
  readonly chatId: string;
  readonly type: WorkDocType;
  readonly title: string;
  readonly content: string;
  /** Validated upstream; defaults to `draft`. */
  readonly status?: WorkDocStatus;
  /**
   * Optional creation timestamp override (ISO string or Date). Defaults to
   * the store clock. The v1 snapshot and creation revision share it.
   */
  readonly createdAt?: string | Date;
}

/** Filters for `list`. Absent filters are unconstrained; combined with AND. */
export interface WorkDocListParams {
  readonly scope?: string;
  readonly chatId?: string;
  readonly type?: WorkDocType;
  readonly status?: WorkDocStatus;
  /** `newest` = descending createdAt then id; `oldest` = ascending. */
  readonly order: 'newest' | 'oldest';
  /** 1..100 enforced by schemas; stores trust but bound defensively. */
  readonly limit: number;
}

/** CAS update payload. At least one field of the patch is present. */
export interface WorkDocStoreUpdate {
  readonly id: string;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly content?: string;
  readonly status?: WorkDocStatus;
  /** Who drove the change (revision metadata). */
  readonly source: WorkDocRevisionSource;
  readonly actorId?: string | null;
  /** Overrides the service default audit summary when provided. */
  readonly summary?: string | null;
  /**
   * Ownership guards (optional): when supplied, the document must match BOTH
   * values or the write is rejected as not-found. Lets API callers prove the
   * acting chat/scope owns the document on every mutation.
   */
  readonly expectedScope?: string | null;
  readonly expectedChatId?: string | null;
}

/** Rollback payload: copy version `toVersion`'s snapshot into a NEW version. */
export interface WorkDocStoreRollback {
  readonly id: string;
  readonly expectedVersion: number;
  /** 1 <= toVersion < expectedVersion; the target snapshot must exist. */
  readonly toVersion: number;
  readonly source: WorkDocRevisionSource;
  readonly actorId?: string | null;
  readonly summary?: string | null;
  /** Ownership guards; see {@link WorkDocStoreUpdate}. */
  readonly expectedScope?: string | null;
  readonly expectedChatId?: string | null;
}

/** Options for bounded deterministic history listings. */
export interface WorkDocHistoryListOptions {
  /** Ascending = chronological; descending = latest first. */
  readonly order: 'oldest' | 'newest';
  readonly limit: number;
}

/** Payload for adding one typed link (idempotent per document/target tuple). */
export interface WorkDocLinkInsert {
  readonly documentId: string;
  readonly targetType: WorkDocLinkTargetType;
  readonly targetId: string;
  readonly label?: string | null;
  /** Ownership guards; see {@link WorkDocStoreUpdate}. */
  readonly expectedScope?: string | null;
  readonly expectedChatId?: string | null;
}

export interface WorkDocStore {
  /**
   * Create a document: version 1, its immutable snapshot, and the creation
   * audit revision in ONE atomic write. Validation failures leave no rows.
   */
  create(data: WorkDocStoreCreate): Promise<WorkDoc>;

  get(id: string): Promise<WorkDoc | null>;

  /** Bounded, deterministic listing (createdAt then id tie-break). */
  list(params: WorkDocListParams): Promise<readonly WorkDoc[]>;

  /**
   * CAS update: bump `version` to expected+1, write the new snapshot and the
   * audit revision atomically. Missing -> WorkDocNotFoundError; stale
   * expectedVersion -> WorkDocConflictError (one writer wins).
   */
  update(data: WorkDocStoreUpdate): Promise<WorkDoc>;

  /**
   * CAS rollback: copy version `toVersion`'s snapshot into NEW version
   * expected+1 (status/title/content restored) and record the audit revision.
   * History is append-only: prior versions and revisions stay exactly where
   * they are. Rolling back to the current version is a validation error, not
   * a no-op. Ownership guards apply like on `update`.
   */
  rollback(data: WorkDocStoreRollback): Promise<WorkDoc>;

  /** Immutable history for one document; never includes future versions. */
  listVersions(documentId: string, options: WorkDocHistoryListOptions): Promise<readonly WorkDocVersion[]>;

  /** Audit trail for one document, ordered by `toVersion` (then id). */
  listRevisions(documentId: string, options: WorkDocHistoryListOptions): Promise<readonly WorkDocRevision[]>;

  /**
   * Add one typed link. Idempotent: adding the same (documentId, targetType,
   * targetId) tuple again returns the EXISTING link unchanged. The document
   * must exist (404 otherwise) and must own the guards when supplied.
   */
  addLink(data: WorkDocLinkInsert): Promise<WorkDocLink>;

  /** Links for one document, ordered by createdAt then id. */
  listLinks(documentId: string): Promise<readonly WorkDocLink[]>;
}
