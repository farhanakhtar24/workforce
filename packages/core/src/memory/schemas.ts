/**
 * Zod schemas for memory routes. These are the authoritative input contracts
 * for write/query/search/compact endpoints; the {@link MemoryService} methods
 * accept the matching input types (all fields optional/defaults included) and
 * re-validate with these schemas, so raw JSON and pre-parsed objects are both
 * safe to pass.
 *
 * Normalizing behavior (zod 4 executes chained checks in order):
 * - `scope`: optional, defaults to `"default"`; trimmed, 1..64 chars,
 *   ASCII `[a-z0-9_-]`, lowercased.
 * - `path`: 1..800 chars raw, 1..12 segments with the per-segment rules of
 *   `normalizeMemoryPath`, lowercased/normalized on parse.
 * - `content`: trimmed, 1..1000 characters after trim.
 * - `confidence`: finite number 0..1, defaults 0.8.
 * - `query` (semantic search): trimmed, 1..500 chars.
 * - `keyword` (queryBlocks only — it never feeds the semantic formula):
 *   trimmed, 1..500 chars.
 * - `limit`: integer 1..100, defaults 20.
 * - `metadata`: optional bounded JSON object (see `memoryMetadataSchema`).
 * - `includeSuperseded`: boolean, defaults false.
 * - ids: RFC 9562 UUIDs.
 */

import { z } from 'zod';
import { memoryKinds } from './kinds.js';
import {
  isValidMemoryPath,
  MAX_MEMORY_PATH_LENGTH,
  MAX_SCOPE_LENGTH,
  MAX_MEMORY_PATH_SEGMENT_LENGTH,
  normalizeMemoryPath,
  normalizeScope,
} from './paths.js';
import { MemoryValidationError } from './errors.js';

/** RFC 9562 UUID strings used for block/relation ids. */
export const memoryIdSchema = z.uuid();

/** Scope: one path-segment-shaped identifier (defaults applied upstream). */
export const memoryScopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SCOPE_LENGTH)
  .refine(
    (value) => {
      try {
        normalizeScope(value);
        return true;
      } catch {
        return false;
      }
    },
    `scope may only contain ascii letters, digits, "_" and "-" (1..${MAX_SCOPE_LENGTH} chars)`,
  )
  .transform((value) => normalizeScope(value));

/** Full memory path; normalized (`projects/Atlas` -> `projects/atlas`) on parse. */
export const memoryPathSchema = z
  .string()
  .min(1)
  .max(MAX_MEMORY_PATH_LENGTH)
  .refine(isValidMemoryPath, {
    message: `path must be 1..12 slash-separated segments of 1..${MAX_MEMORY_PATH_SEGMENT_LENGTH} ascii [a-z0-9_-] chars with no empty segments`,
  })
  .transform((value) => normalizeMemoryPath(value));

/** Lowercase-validated scope/path for job inputs that bypass route parsing. */
export { normalizeMemoryPath, normalizeScope } from './paths.js';

export const memoryKindSchema = z.enum(memoryKinds);

/** Content: trimmed 1..1000. Trim happens before the bounds checks. */
export const memoryContentSchema = z
  .string()
  .trim()
  .min(1, 'content must not be empty')
  .max(1000, 'content must be at most 1000 characters');

export const memoryConfidenceSchema = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// Bounded metadata JSON
// ---------------------------------------------------------------------------

export const MAX_METADATA_SERIALIZED_LENGTH = 4096;
const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_ENTRIES = 100;
const MAX_METADATA_STRING_LENGTH = 1000;
const MAX_METADATA_KEY_LENGTH = 100;

/**
 * Validate a bounded JSON object: plain object root (no arrays), values limited
 * to string/finite-number/boolean/null/plain-object/array, depth <= 5, at most
 * 100 total entries, individual strings <= 1000 chars, keys <= 100 chars, and a
 * serialized size <= 4096 characters. Cycles fail as oversized/invalid.
 */
export function isBoundedMetadata(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  let entries = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (node === null) {
      return true;
    }
    switch (typeof node) {
      case 'string':
        return node.length <= MAX_METADATA_STRING_LENGTH;
      case 'number':
        return Number.isFinite(node);
      case 'boolean':
        return true;
      case 'object': {
        if (depth >= MAX_METADATA_DEPTH) {
          return false;
        }
        if (Array.isArray(node)) {
          entries += node.length;
          if (entries > MAX_METADATA_ENTRIES) {
            return false;
          }
          return node.every((element) => walk(element, depth + 1));
        }
        const record = node as Record<string, unknown>;
        const keys = Object.keys(record);
        entries += keys.length;
        if (entries > MAX_METADATA_ENTRIES) {
          return false;
        }
        return keys.every(
          (key) => key.length <= MAX_METADATA_KEY_LENGTH && walk(record[key], depth + 1),
        );
      }
      default:
        // undefined, bigint, symbol, function are not JSON values.
        return false;
    }
  };
  if (!walk(value, 0)) {
    return false;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && serialized.length <= MAX_METADATA_SERIALIZED_LENGTH;
  } catch {
    return false;
  }
}

export const memoryMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine(isBoundedMetadata, {
    message: `metadata must be a plain JSON object of at most ${MAX_METADATA_SERIALIZED_LENGTH} serialized characters (strings <= ${MAX_METADATA_STRING_LENGTH} chars, depth <= ${MAX_METADATA_DEPTH}, entries <= ${MAX_METADATA_ENTRIES})`,
  });

// ---------------------------------------------------------------------------
// Route input schemas
// ---------------------------------------------------------------------------

/** Body for POST memory write (or the service's `writeBlock`). */
export const writeBlockInputSchema = z.strictObject({
  scope: memoryScopeSchema.optional().default('default'),
  path: memoryPathSchema,
  kind: memoryKindSchema,
  content: memoryContentSchema,
  confidence: memoryConfidenceSchema.optional().default(0.8),
  /** Id of the block this write supersedes; must live in the same scope. */
  supersedesId: memoryIdSchema.optional(),
  metadata: memoryMetadataSchema.optional(),
});

/** Body for memory list/query endpoints. Path prefix includes descendants. */
export const queryBlocksInputSchema = z.strictObject({
  scope: memoryScopeSchema.optional(),
  path: memoryPathSchema.optional(),
  kind: memoryKindSchema.optional(),
  /** Case-insensitive substring filter on content. Not part of semantic ranking. */
  keyword: z
    .string()
    .trim()
    .min(1)
    .max(500, 'keyword must be at most 500 characters')
    .optional(),
  includeSuperseded: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

/**
 * Body for semantic search. `query` is embedded with the configured provider;
 * `keyword`-style substring matching is intentionally NOT part of the
 * semantic formula.
 */
export const semanticSearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(500, 'query must be at most 500 characters'),
  scope: memoryScopeSchema.optional(),
  path: memoryPathSchema.optional(),
  kind: memoryKindSchema.optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

/** Body for on-demand compaction of an exact (scope, path). */
export const compactPathInputSchema = z.strictObject({
  scope: memoryScopeSchema,
  path: memoryPathSchema,
});

/**
 * Input for `MemoryService.purgeDerivedChatMemory`: exact scope + exact path,
 * with the optional bounded `assistantMessageIds` narrowing (removed-message
 * purge). Ids follow the API message-id contract (`[A-Za-z0-9_-]`, 1..64).
 */
export const purgeDerivedChatInputSchema = z.strictObject({
  scope: memoryScopeSchema,
  path: memoryPathSchema,
  assistantMessageIds: z
    .array(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_-]{1,64}$/, 'assistantMessageIds entries must be 1..64 characters of A-Z a-z 0-9 _ -'),
    )
    .min(1)
    .max(512)
    .optional(),
});

// ---------------------------------------------------------------------------
// Parsed (post-normalization) input types
// ---------------------------------------------------------------------------

export type MemoryWriteBlockInput = z.input<typeof writeBlockInputSchema>;
export type MemoryQueryBlocksInput = z.input<typeof queryBlocksInputSchema>;
export type MemorySemanticSearchInput = z.input<typeof semanticSearchInputSchema>;
export type MemoryCompactPathInput = z.input<typeof compactPathInputSchema>;
export type MemoryPurgeDerivedInput = z.input<typeof purgeDerivedChatInputSchema>;
export type ParsedPurgeDerivedInput = z.output<typeof purgeDerivedChatInputSchema>;

// Output (parsed) shapes with defaults applied.
export type ParsedWriteBlockInput = z.output<typeof writeBlockInputSchema>;
export type ParsedQueryBlocksInput = z.output<typeof queryBlocksInputSchema>;
export type ParsedSemanticSearchInput = z.output<typeof semanticSearchInputSchema>;
export type ParsedCompactPathInput = z.output<typeof compactPathInputSchema>;

/**
 * Parse route/service input against `schema`, converting Zod errors into the
 * typed {@link MemoryValidationError} routes can map to 400. Issue messages
 * never echo submitted values.
 */
export function parseMemoryInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new MemoryValidationError(`invalid memory input (${issues.join('; ')})`, { issues });
  }
  return result.data;
}
