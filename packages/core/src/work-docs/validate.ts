/**
 * Shared store-level validation for the work-docs domain (defense in depth).
 *
 * The {@link WorkDocService} validates raw input with the Zod schemas; stores
 * call these plain functions to re-validate the STRUCTURED payloads they
 * receive, so a misbehaving caller (or future route) cannot smuggle unbounded
 * content past the service. Both the in-memory store and the Prisma adapter
 * import from here, keeping error codes, bounds, and messages identical.
 *
 * All failures are typed {@link WorkDocValidationError}s (400); messages never
 * echo submitted content, only bounds and shapes.
 */

import { z } from 'zod';

import { normalizeScope } from '../memory/paths.js';
import {
  WORK_DOC_HISTORY_LIMIT_MAX,
  WORK_DOC_LIST_LIMIT_MAX,
  WORK_DOC_MAX_CONTENT_LENGTH,
  WORK_DOC_MAX_EXTERNAL_ID_LENGTH,
  WORK_DOC_MAX_LABEL_LENGTH,
  WORK_DOC_MAX_SUMMARY_LENGTH,
  WORK_DOC_MAX_TITLE_LENGTH,
  isWorkDocLinkTargetType,
  isWorkDocRevisionSource,
  isWorkDocStatus,
  isWorkDocType,
} from './kinds.js';
import { WorkDocValidationError, WorkDocNotFoundError } from './errors.js';
import type {
  WorkDocHistoryListOptions,
  WorkDocLinkInsert,
  WorkDocListParams,
  WorkDocStoreCreate,
  WorkDocStoreRollback,
  WorkDocStoreUpdate,
} from './store.js';
import type { WorkDocStatus, WorkDocType, WorkDocLinkTargetType, WorkDocRevisionSource } from './kinds.js';

const workDocUuidSchema = z.uuid();

/** Document/relation ids must be RFC 9562 UUIDs (protects SQL uuid casts). */
export function validateDocumentId(id: string): string {
  const result = workDocUuidSchema.safeParse(id);
  if (!result.success) {
    throw new WorkDocValidationError('work doc id must be a valid UUID');
  }
  return result.data;
}

export function validateExternalId(value: string, label: string, max: number = WORK_DOC_MAX_EXTERNAL_ID_LENGTH): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkDocValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new WorkDocValidationError(`${label} must be at most ${max} characters`);
  }
  return value;
}

export function validateBounded(value: string, max: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length < 1) {
    throw new WorkDocValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new WorkDocValidationError(`${label} must be at most ${max} characters`);
  }
  return value;
}

function validateVersionNumber(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new WorkDocValidationError(`${label} must be an integer >= 1`);
  }
  return value;
}

function validateSource(source: WorkDocRevisionSource): WorkDocRevisionSource {
  if (!isWorkDocRevisionSource(source)) {
    throw new WorkDocValidationError('work doc revision source must be agent or user');
  }
  return source;
}

function validateOptionalActor(actorId: string | null | undefined): string | null | undefined {
  if (actorId !== undefined && actorId !== null) {
    validateExternalId(actorId, 'actorId');
  }
  return actorId;
}

function validateOptionalSummary(summary: string | null | undefined): string | null | undefined {
  if (summary !== undefined && summary !== null) {
    validateBounded(summary, WORK_DOC_MAX_SUMMARY_LENGTH, 'summary');
  }
  return summary;
}

export interface ValidatedStoreCreate {
  readonly id: string | null;
  readonly scope: string;
  readonly chatId: string;
  readonly type: WorkDocType;
  readonly title: string;
  readonly content: string;
  readonly status: WorkDocStatus;
  readonly ownerId: string | null;
  readonly createdAt: Date | null;
}

export function validateStoreCreate(data: WorkDocStoreCreate): ValidatedStoreCreate {
  if (data.id !== undefined && data.id !== null) {
    validateDocumentId(data.id);
  }
  const scope = normalizeScope(data.scope);
  const chatId = validateExternalId(data.chatId, 'chatId');
  if (!isWorkDocType(data.type)) {
    throw new WorkDocValidationError('work doc type must be one of report, plan, analysis');
  }
  const title = validateBounded(data.title, WORK_DOC_MAX_TITLE_LENGTH, 'title');
  const content = validateBounded(data.content, WORK_DOC_MAX_CONTENT_LENGTH, 'content');
  const status = data.status ?? 'draft';
  if (!isWorkDocStatus(status)) {
    throw new WorkDocValidationError('work doc status must be one of draft, active, archived');
  }
  const ownerId =
    data.ownerId !== undefined && data.ownerId !== null
      ? validateExternalId(data.ownerId, 'ownerId')
      : null;
  let createdAt: Date | null = null;
  if (data.createdAt !== undefined) {
    const asDate = data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt);
    if (!Number.isFinite(asDate.getTime())) {
      throw new WorkDocValidationError('createdAt must be a valid date or ISO string');
    }
    createdAt = asDate;
  }
  return { id: data.id ?? null, scope, chatId, type: data.type, title, content, status, ownerId, createdAt };
}

export interface ValidatedStoreUpdate {
  readonly id: string;
  readonly expectedVersion: number;
  readonly title: string | null;
  readonly content: string | null;
  readonly status: WorkDocStatus | null;
  readonly source: WorkDocRevisionSource;
  readonly actorId: string | null;
  readonly summary: string | null;
  readonly expectedScope: string | null;
  readonly expectedChatId: string | null;
  readonly expectedOwnerId: string | null;
}

function validateOwnershipGuards(
  expectedScope: string | null | undefined,
  expectedChatId: string | null | undefined,
  expectedOwnerId: string | null | undefined,
): { expectedScope: string | null; expectedChatId: string | null; expectedOwnerId: string | null } {
  return {
    expectedScope: expectedScope !== undefined && expectedScope !== null ? normalizeScope(expectedScope) : null,
    expectedChatId:
      expectedChatId !== undefined && expectedChatId !== null ? validateExternalId(expectedChatId, 'expectedChatId') : null,
    expectedOwnerId:
      expectedOwnerId !== undefined && expectedOwnerId !== null
        ? validateExternalId(expectedOwnerId, 'expectedOwnerId')
        : null,
  };
}

export function validateStoreUpdate(data: WorkDocStoreUpdate): ValidatedStoreUpdate {
  const id = validateDocumentId(data.id);
  const expectedVersion = validateVersionNumber(data.expectedVersion, 'expectedVersion');
  const title = data.title !== undefined ? validateBounded(data.title, WORK_DOC_MAX_TITLE_LENGTH, 'title') : null;
  const content = data.content !== undefined ? validateBounded(data.content, WORK_DOC_MAX_CONTENT_LENGTH, 'content') : null;
  const status = data.status ?? null;
  if (status !== null && !isWorkDocStatus(status)) {
    throw new WorkDocValidationError('work doc status must be one of draft, active, archived');
  }
  const source = validateSource(data.source);
  const actorId = validateOptionalActor(data.actorId) ?? null;
  const summary = validateOptionalSummary(data.summary) ?? null;
  const ownership = validateOwnershipGuards(data.expectedScope, data.expectedChatId, data.expectedOwnerId);
  return { id, expectedVersion, title, content, status, source, actorId, summary, ...ownership };
}

export interface ValidatedStoreRollback {
  readonly id: string;
  readonly expectedVersion: number;
  readonly toVersion: number;
  readonly source: WorkDocRevisionSource;
  readonly actorId: string | null;
  readonly summary: string | null;
  readonly expectedScope: string | null;
  readonly expectedChatId: string | null;
  readonly expectedOwnerId: string | null;
}

export function validateStoreRollback(data: WorkDocStoreRollback): ValidatedStoreRollback {
  const id = validateDocumentId(data.id);
  const expectedVersion = validateVersionNumber(data.expectedVersion, 'expectedVersion');
  const toVersion = validateVersionNumber(data.toVersion, 'toVersion');
  const source = validateSource(data.source);
  const actorId = validateOptionalActor(data.actorId) ?? null;
  const summary = validateOptionalSummary(data.summary) ?? null;
  const ownership = validateOwnershipGuards(data.expectedScope, data.expectedChatId, data.expectedOwnerId);
  return { id, expectedVersion, toVersion, source, actorId, summary, ...ownership };
}

/**
 * Enforce "rollback goes to a PRIOR version" at store level: the target must
 * exist in history and be strictly smaller than the current version.
 */
export function validateRollbackTarget(toVersion: number, currentVersion: number): void {
  if (toVersion >= currentVersion) {
    throw new WorkDocValidationError(
      `rollback toVersion must be smaller than the current version (${currentVersion})`,
    );
  }
}

export interface ValidatedLinkInsert {
  readonly documentId: string;
  readonly targetType: WorkDocLinkTargetType;
  readonly targetId: string;
  readonly label: string | null;
  readonly expectedScope: string | null;
  readonly expectedChatId: string | null;
  readonly expectedOwnerId: string | null;
}

export function validateLinkInsert(data: WorkDocLinkInsert): ValidatedLinkInsert {
  const documentId = validateDocumentId(data.documentId);
  if (!isWorkDocLinkTargetType(data.targetType)) {
    throw new WorkDocValidationError('link targetType must be one of memory_block, chat, delegation');
  }
  const targetId = validateExternalId(data.targetId, 'link targetId');
  const label = data.label !== undefined && data.label !== null
    ? validateBounded(data.label, WORK_DOC_MAX_LABEL_LENGTH, 'link label')
    : null;
  const ownership = validateOwnershipGuards(data.expectedScope, data.expectedChatId, data.expectedOwnerId);
  return { documentId, targetType: data.targetType, targetId, label, ...ownership };
}

export interface ValidatedListParams {
  readonly scope: string | null;
  readonly chatId: string | null;
  readonly type: WorkDocType | null;
  readonly status: WorkDocStatus | null;
  readonly ownerId: string | null;
  readonly order: 'newest' | 'oldest';
  readonly limit: number;
}

export function validateListParams(params: WorkDocListParams): ValidatedListParams {
  const scope = params.scope !== undefined && params.scope !== null ? normalizeScope(params.scope) : null;
  const chatId = params.chatId !== undefined && params.chatId !== null
    ? validateExternalId(params.chatId, 'chatId')
    : null;
  const type = params.type ?? null;
  if (type !== null && !isWorkDocType(type)) {
    throw new WorkDocValidationError('work doc type filter must be one of report, plan, analysis');
  }
  const status = params.status ?? null;
  if (status !== null && !isWorkDocStatus(status)) {
    throw new WorkDocValidationError('work doc status filter must be one of draft, active, archived');
  }
  const ownerId = params.ownerId !== undefined && params.ownerId !== null
    ? validateExternalId(params.ownerId, 'ownerId')
    : null;
  if (params.order !== 'newest' && params.order !== 'oldest') {
    throw new WorkDocValidationError('work doc list order must be newest or oldest');
  }
  if (typeof params.limit !== 'number' || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > WORK_DOC_LIST_LIMIT_MAX) {
    throw new WorkDocValidationError(`work doc list limit must be an integer between 1 and ${WORK_DOC_LIST_LIMIT_MAX}`);
  }
  return { scope, chatId, type, status, ownerId, order: params.order, limit: params.limit };
}

export interface ValidatedHistoryOptions {
  readonly order: 'oldest' | 'newest';
  readonly limit: number;
  readonly expectedOwnerId: string | null;
}

/**
 * Enforce scope/chat/owner ownership on a mutation. A mismatch MUST read as
 * not-found: existence is never confirmed for a foreign scope/chat/owner.
 * The owner guard matches EXACTLY — ownerless legacy rows never satisfy any
 * expected owner.
 */
export function enforceOwnership(
  document: { readonly id: string; readonly scope: string; readonly chatId: string; readonly ownerId: string | null },
  expectedScope: string | null,
  expectedChatId: string | null,
  expectedOwnerId: string | null = null,
): void {
  if (expectedScope !== null && document.scope !== expectedScope) {
    throw new WorkDocNotFoundError(`work doc ${document.id} not found in scope ${expectedScope}`);
  }
  if (expectedChatId !== null && document.chatId !== expectedChatId) {
    throw new WorkDocNotFoundError(`work doc ${document.id} not found for chat ${expectedChatId}`);
  }
  enforceOwner(document, expectedOwnerId);
}

/** Owner-only guard for read paths; mismatch reads as not-found (no oracle). */
export function enforceOwner(
  document: { readonly id: string; readonly ownerId: string | null },
  expectedOwnerId: string | null,
): void {
  if (expectedOwnerId !== null && document.ownerId !== expectedOwnerId) {
    throw new WorkDocNotFoundError(`work doc ${document.id} not found for owner`);
  }
}

export function validateHistoryOptions(documentId: string, options: WorkDocHistoryListOptions): ValidatedHistoryOptions {
  validateDocumentId(documentId);
  if (options.order !== 'oldest' && options.order !== 'newest') {
    throw new WorkDocValidationError('history order must be oldest or newest');
  }
  if (typeof options.limit !== 'number' || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > WORK_DOC_HISTORY_LIMIT_MAX) {
    throw new WorkDocValidationError(`history limit must be an integer between 1 and ${WORK_DOC_HISTORY_LIMIT_MAX}`);
  }
  return {
    order: options.order,
    limit: options.limit,
    expectedOwnerId:
      options.expectedOwnerId !== undefined && options.expectedOwnerId !== null
        ? validateExternalId(options.expectedOwnerId, 'expectedOwnerId')
        : null,
  };
}

/** Validate the owner guard on plain read options (`get`, `listLinks`). */
export function validateGetOptions(options?: { readonly expectedOwnerId?: string | null }): {
  readonly expectedOwnerId: string | null;
} {
  const expectedOwnerId =
    options?.expectedOwnerId !== undefined && options?.expectedOwnerId !== null
      ? validateExternalId(options.expectedOwnerId, 'expectedOwnerId')
      : null;
  return { expectedOwnerId };
}
