/**
 * Core work-document domain types shared by the service, stores, routes, and
 * adapters.
 *
 * ## Date representation (documented choice, mirrors the memory domain)
 * Every timestamp is an ISO 8601 UTC string at the public boundary, keeping
 * documents JSON-serializable without a normalization layer. Stores convert
 * to their native representation.
 *
 * ## History is immutable
 * {@link WorkDocVersion} is an append-only snapshot: a create/update/rollback
 * never deletes, rewrites, or reorders history — versions only gain entries
 * with strictly increasing `version` numbers. {@link WorkDocRevision} is the
 * audit trail saying WHO (source/actorId) moved the document from
 * `fromVersion` to `toVersion` and why (`summary`).
 *
 * ## Scope conventions
 * Scopes reuse the memory-domain vocabulary exactly (`normalizeScope`):
 * 1..64 chars of `[a-z0-9_-]`, lowercased. `chatId` and link `targetId` are
 * bounded opaque identifiers (1..128 chars, trimmed) — the API layer owns
 * their format.
 */

import type { WorkDocLinkTargetType, WorkDocRevisionSource, WorkDocStatus, WorkDocType } from './kinds.js';

export interface WorkDoc {
  readonly id: string;
  readonly scope: string;
  readonly chatId: string;
  readonly type: WorkDocType;
  /** Trimmed, 1..200 characters. */
  readonly title: string;
  /** Trimmed, 1..100000 characters. */
  readonly content: string;
  readonly status: WorkDocStatus;
  /** Optimistic-concurrency counter; starts at 1 and only increments. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One immutable historical snapshot of a document. Never mutated. */
export interface WorkDocVersion {
  readonly id: string;
  readonly documentId: string;
  readonly version: number;
  readonly title: string;
  readonly content: string;
  readonly status: WorkDocStatus;
  /** When this snapshot became the document's current state. */
  readonly createdAt: string;
}

export interface WorkDocRevision {
  readonly id: string;
  readonly documentId: string;
  /** Who drove the change; `actorId` refines it when the host knows. */
  readonly source: WorkDocRevisionSource;
  readonly actorId: string | null;
  /** Version the document moved FROM; null only for the initial creation. */
  readonly fromVersion: number | null;
  /** Version the document moved TO. */
  readonly toVersion: number;
  /** Trimmed, 1..500 characters. */
  readonly summary: string;
  readonly createdAt: string;
}

export interface WorkDocLink {
  readonly id: string;
  readonly documentId: string;
  readonly targetType: WorkDocLinkTargetType;
  readonly targetId: string;
  /** Trimmed, 1..128 characters when supplied. */
  readonly label: string | null;
  readonly createdAt: string;
}
