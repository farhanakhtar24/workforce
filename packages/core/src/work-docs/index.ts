/**
 * Public API of the Phase 4 work-document domain: `@workforce/core/work-docs`.
 *
 * Pure domain + service only. The Prisma/Postgres adapter is exported ONLY
 * from the `@workforce/core/work-docs/postgres` subpath, so importing this
 * module never loads Prisma (the CLI stays Prisma-free).
 */

export {
  workDocTypes,
  workDocStatuses,
  workDocRevisionSources,
  workDocLinkTargetTypes,
  isWorkDocType,
  isWorkDocStatus,
  isWorkDocRevisionSource,
  isWorkDocLinkTargetType,
  WORK_DOC_MAX_TITLE_LENGTH,
  WORK_DOC_MAX_CONTENT_LENGTH,
  WORK_DOC_MAX_SUMMARY_LENGTH,
  WORK_DOC_MAX_EXTERNAL_ID_LENGTH,
  WORK_DOC_MAX_LABEL_LENGTH,
  WORK_DOC_LIST_LIMIT_MAX,
  WORK_DOC_LIST_LIMIT_DEFAULT,
  WORK_DOC_HISTORY_LIMIT_MAX,
  WORK_DOC_HISTORY_LIMIT_DEFAULT,
  type WorkDocType,
  type WorkDocStatus,
  type WorkDocRevisionSource,
  type WorkDocLinkTargetType,
} from './kinds.js';

export {
  WorkDocError,
  WorkDocValidationError,
  WorkDocNotFoundError,
  WorkDocConflictError,
  type WorkDocErrorCode,
} from './errors.js';

export {
  workDocIdSchema,
  workDocExternalIdSchema,
  workDocTypeSchema,
  workDocStatusSchema,
  workDocRevisionSourceSchema,
  workDocLinkTargetTypeSchema,
  workDocTitleSchema,
  workDocContentSchema,
  workDocSummarySchema,
  workDocActorIdSchema,
  workDocLabelSchema,
  workDocVersionNumberSchema,
  createWorkDocInputSchema,
  updateWorkDocInputSchema,
  rollbackWorkDocInputSchema,
  listWorkDocsInputSchema,
  listWorkDocVersionsInputSchema,
  listWorkDocRevisionsInputSchema,
  addWorkDocLinkInputSchema,
  parseWorkDocInput,
  workDocIdentityChecks,
  type WorkDocCreateInput,
  type WorkDocUpdateInput,
  type WorkDocRollbackInput,
  type WorkDocListInput,
  type WorkDocListVersionsInput,
  type WorkDocListRevisionsInput,
  type WorkDocAddLinkInput,
  type ParsedWorkDocCreateInput,
  type ParsedWorkDocUpdateInput,
  type ParsedWorkDocRollbackInput,
  type ParsedWorkDocListInput,
  type ParsedWorkDocListVersionsInput,
  type ParsedWorkDocListRevisionsInput,
  type ParsedWorkDocAddLinkInput,
} from './schemas.js';

export type {
  WorkDoc,
  WorkDocVersion,
  WorkDocRevision,
  WorkDocLink,
} from './types.js';

export type {
  WorkDocStore,
  WorkDocStoreCreate,
  WorkDocStoreUpdate,
  WorkDocStoreRollback,
  WorkDocListParams,
  WorkDocHistoryListOptions,
  WorkDocLinkInsert,
} from './store.js';

export { WorkDocService, type WorkDocServiceOptions } from './service.js';

export { InMemoryWorkDocStore } from './stores/in-memory-work-doc-store.js';
