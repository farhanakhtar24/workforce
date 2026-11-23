/**
 * Work-document vocabulary: types, statuses, revision sources, link target
 * types, and the shared numeric bounds pinned by the Phase 4 spec. Constants
 * only — no imports besides nothing — so every other module can depend on it
 * without cycles.
 */

/** Every documented artifact kind a work doc can carry. */
export const workDocTypes = ['report', 'plan', 'analysis'] as const;

export type WorkDocType = (typeof workDocTypes)[number];

/** Lifecycle of a document. */
export const workDocStatuses = ['draft', 'active', 'archived'] as const;

export type WorkDocStatus = (typeof workDocStatuses)[number];

/** Who drove a revision. */
export const workDocRevisionSources = ['agent', 'user'] as const;

export type WorkDocRevisionSource = (typeof workDocRevisionSources)[number];

/** Typed link targets. */
export const workDocLinkTargetTypes = ['memory_block', 'chat', 'delegation'] as const;

export type WorkDocLinkTargetType = (typeof workDocLinkTargetTypes)[number];

export function isWorkDocType(value: unknown): value is WorkDocType {
  return typeof value === 'string' && (workDocTypes as readonly string[]).includes(value);
}

export function isWorkDocStatus(value: unknown): value is WorkDocStatus {
  return typeof value === 'string' && (workDocStatuses as readonly string[]).includes(value);
}

export function isWorkDocRevisionSource(value: unknown): value is WorkDocRevisionSource {
  return typeof value === 'string' && (workDocRevisionSources as readonly string[]).includes(value);
}

export function isWorkDocLinkTargetType(value: unknown): value is WorkDocLinkTargetType {
  return typeof value === 'string' && (workDocLinkTargetTypes as readonly string[]).includes(value);
}

/** Title bound: trimmed 1..200. */
export const WORK_DOC_MAX_TITLE_LENGTH = 200 as const;

/** Content bound: trimmed 1..100000. */
export const WORK_DOC_MAX_CONTENT_LENGTH = 100000 as const;

/** Revision summary bound: trimmed 1..500 when supplied. */
export const WORK_DOC_MAX_SUMMARY_LENGTH = 500 as const;

/** Revision actor / external chat or target id bound: trimmed 1..128. */
export const WORK_DOC_MAX_EXTERNAL_ID_LENGTH = 128 as const;

/** Link label bound: trimmed 1..128 when supplied. */
export const WORK_DOC_MAX_LABEL_LENGTH = 128 as const;

/** Listing page size bound; default set by the schemas. */
export const WORK_DOC_LIST_LIMIT_MAX = 100 as const;

export const WORK_DOC_LIST_LIMIT_DEFAULT = 20 as const;

/** Version/revision listing page size bound (history pages). */
export const WORK_DOC_HISTORY_LIMIT_MAX = 1000 as const;

export const WORK_DOC_HISTORY_LIMIT_DEFAULT = 200 as const;
