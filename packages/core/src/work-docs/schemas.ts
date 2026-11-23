/**
 * Zod schemas for work-doc routes. These are the authoritative input contracts
 * for the {@link WorkDocService}; raw JSON and pre-parsed objects are both safe
 * to pass because the service re-validates with these schemas.
 *
 * Normalizing behavior (zod 4 executes chained checks in order):
 * - `scope`: optional, defaults to `"default"`; memory-domain scope rules
 *   (1..64 lowercase `[a-z0-9_-]`), normalized on parse.
 * - `chatId` / `targetId`: trimmed, 1..128 chars.
 * - `title`: trimmed, 1..200 characters.
 * - `content`: trimmed, 1..100000 characters.
 * - `summary`: trimmed, 1..500 characters, optional (service applies defaults).
 * - `source` (revision metadata): required on every mutation — 'agent'|'user'.
 * - `expectedVersion` / `toVersion` / `version`: integers >= 1.
 * - `limit`: integer 1..100 (list) / 1..1000 (history), defaults 20 / 200.
 * - document ids: RFC 9562 UUIDs; `actorId`/`label`: trimmed 1..128 chars.
 */

import { z } from 'zod';

import { memoryScopeSchema } from '../memory/schemas.js';
import {
  WORK_DOC_HISTORY_LIMIT_DEFAULT,
  WORK_DOC_HISTORY_LIMIT_MAX,
  WORK_DOC_LIST_LIMIT_DEFAULT,
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
  workDocLinkTargetTypes,
  workDocRevisionSources,
  workDocStatuses,
  workDocTypes,
} from './kinds.js';
import { WorkDocValidationError } from './errors.js';

/** Document/version/revision/link ids: RFC 9562 UUIDs. */
export const workDocIdSchema = z.uuid();

/** External identifiers (chats, targets, actors): opaque, bounded strings. */
export const workDocExternalIdSchema = z
  .string()
  .trim()
  .min(1, 'external id must not be empty')
  .max(WORK_DOC_MAX_EXTERNAL_ID_LENGTH, `external id must be at most ${WORK_DOC_MAX_EXTERNAL_ID_LENGTH} characters`);

export const workDocTypeSchema = z.enum(workDocTypes);

export const workDocStatusSchema = z.enum(workDocStatuses);

export const workDocRevisionSourceSchema = z.enum(workDocRevisionSources);

export const workDocLinkTargetTypeSchema = z.enum(workDocLinkTargetTypes);

export const workDocTitleSchema = z
  .string()
  .trim()
  .min(1, 'title must not be empty')
  .max(WORK_DOC_MAX_TITLE_LENGTH, `title must be at most ${WORK_DOC_MAX_TITLE_LENGTH} characters`);

export const workDocContentSchema = z
  .string()
  .trim()
  .min(1, 'content must not be empty')
  .max(WORK_DOC_MAX_CONTENT_LENGTH, `content must be at most ${WORK_DOC_MAX_CONTENT_LENGTH} characters`);

export const workDocSummarySchema = z
  .string()
  .trim()
  .min(1, 'summary must not be empty')
  .max(WORK_DOC_MAX_SUMMARY_LENGTH, `summary must be at most ${WORK_DOC_MAX_SUMMARY_LENGTH} characters`);

export const workDocActorIdSchema = workDocExternalIdSchema;

export const workDocLabelSchema = z
  .string()
  .trim()
  .min(1, 'label must not be empty')
  .max(WORK_DOC_MAX_LABEL_LENGTH, `label must be at most ${WORK_DOC_MAX_LABEL_LENGTH} characters`);

export const workDocVersionNumberSchema = z.number().int().min(1);

// ---------------------------------------------------------------------------
// Route/service input schemas
// ---------------------------------------------------------------------------

/** Body for creating a document (starts an immutable version + revision). */
export const createWorkDocInputSchema = z.strictObject({
  scope: memoryScopeSchema.optional().default('default'),
  chatId: workDocExternalIdSchema,
  type: workDocTypeSchema,
  title: workDocTitleSchema,
  content: workDocContentSchema,
  status: workDocStatusSchema.optional().default('draft'),
});

/**
 * Body for a CAS update. At least one of `title`/`content`/`status` must be
 * present: no-op updates would pollute the immutable history. The optional
 * `expectedScope`/`expectedChatId` guards let API callers prove the acting
 * chat/scope owns the document on EVERY mutation (mismatch reads as 404).
 */
export const updateWorkDocInputSchema = z
  .strictObject({
    id: workDocIdSchema,
    expectedVersion: workDocVersionNumberSchema,
    title: workDocTitleSchema.optional(),
    content: workDocContentSchema.optional(),
    status: workDocStatusSchema.optional(),
    source: workDocRevisionSourceSchema,
    actorId: workDocActorIdSchema.optional(),
    summary: workDocSummarySchema.optional(),
    expectedScope: memoryScopeSchema.optional(),
    expectedChatId: workDocExternalIdSchema.optional(),
  })
  .refine((value) => value.title !== undefined || value.content !== undefined || value.status !== undefined, {
    message: 'update must change at least one of title, content, or status',
  });

/** Body for rolling a document back to a prior version's snapshot. */
export const rollbackWorkDocInputSchema = z.strictObject({
  id: workDocIdSchema,
  expectedVersion: workDocVersionNumberSchema,
  toVersion: workDocVersionNumberSchema,
  source: workDocRevisionSourceSchema,
  actorId: workDocActorIdSchema.optional(),
  summary: workDocSummarySchema.optional(),
  expectedScope: memoryScopeSchema.optional(),
  expectedChatId: workDocExternalIdSchema.optional(),
});

/** Filters + pagination for listing documents. Combined filters are ANDed. */
export const listWorkDocsInputSchema = z.strictObject({
  scope: memoryScopeSchema.optional(),
  chatId: workDocExternalIdSchema.optional(),
  type: workDocTypeSchema.optional(),
  status: workDocStatusSchema.optional(),
  order: z.enum(['newest', 'oldest']).optional().default('newest'),
  limit: z.number().int().min(1).max(WORK_DOC_LIST_LIMIT_MAX).optional().default(WORK_DOC_LIST_LIMIT_DEFAULT),
});

/** Bounded history listings; a page never exceeds the documented maximums. */
export const listWorkDocVersionsInputSchema = z.strictObject({
  id: workDocIdSchema,
  order: z.enum(['oldest', 'newest']).optional().default('oldest'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(WORK_DOC_HISTORY_LIMIT_MAX)
    .optional()
    .default(WORK_DOC_HISTORY_LIMIT_DEFAULT),
});

export const listWorkDocRevisionsInputSchema = listWorkDocVersionsInputSchema;

/** Body for adding one typed link (idempotent per document/target tuple). */
export const addWorkDocLinkInputSchema = z.strictObject({
  id: workDocIdSchema,
  targetType: workDocLinkTargetTypeSchema,
  targetId: workDocExternalIdSchema,
  label: workDocLabelSchema.optional(),
  expectedScope: memoryScopeSchema.optional(),
  expectedChatId: workDocExternalIdSchema.optional(),
});

// ---------------------------------------------------------------------------
// Parsed (post-normalization) input types
// ---------------------------------------------------------------------------

export type WorkDocCreateInput = z.input<typeof createWorkDocInputSchema>;
export type WorkDocUpdateInput = z.input<typeof updateWorkDocInputSchema>;
export type WorkDocRollbackInput = z.input<typeof rollbackWorkDocInputSchema>;
export type WorkDocListInput = z.input<typeof listWorkDocsInputSchema>;
export type WorkDocListVersionsInput = z.input<typeof listWorkDocVersionsInputSchema>;
export type WorkDocListRevisionsInput = z.input<typeof listWorkDocRevisionsInputSchema>;
export type WorkDocAddLinkInput = z.input<typeof addWorkDocLinkInputSchema>;

// Output (parsed) shapes with defaults applied.
export type ParsedWorkDocCreateInput = z.output<typeof createWorkDocInputSchema>;
export type ParsedWorkDocUpdateInput = z.output<typeof updateWorkDocInputSchema>;
export type ParsedWorkDocRollbackInput = z.output<typeof rollbackWorkDocInputSchema>;
export type ParsedWorkDocListInput = z.output<typeof listWorkDocsInputSchema>;
export type ParsedWorkDocListVersionsInput = z.output<typeof listWorkDocVersionsInputSchema>;
export type ParsedWorkDocListRevisionsInput = z.output<typeof listWorkDocRevisionsInputSchema>;
export type ParsedWorkDocAddLinkInput = z.output<typeof addWorkDocLinkInputSchema>;

/**
 * Parse route/service input against `schema`, converting Zod errors into the
 * typed {@link WorkDocValidationError} routes can map to 400. Issue messages
 * never echo submitted values.
 */
export function parseWorkDocInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new WorkDocValidationError(`invalid work doc input (${issues.join('; ')})`, { issues });
  }
  return result.data;
}

/** Identity helpers (mirroring the memory kinds module) for defensive stores. */
export const workDocIdentityChecks = {
  isType: isWorkDocType,
  isStatus: isWorkDocStatus,
  isRevisionSource: isWorkDocRevisionSource,
  isLinkTargetType: isWorkDocLinkTargetType,
} as const;
