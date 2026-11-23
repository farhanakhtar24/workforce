/**
 * Pure (Prisma-free) helpers shared by the Postgres memory adapter. Kept in a
 * separate module so they are unit-testable without the generated client.
 */

import { MemoryEmbeddingError } from '../errors.js';
import { MEMORY_EMBEDDING_DIMENSIONS } from '../kinds.js';

/**
 * HNSW search effort for the candidate fetch. The pgvector default is
 * `ef_search = 40`, which under-recalls when fetching up to
 * {@link SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT} (100) candidates; 200 gives
 * the fetch room without dominating query latency.
 */
export const SEMANTIC_HNSW_EF_SEARCH = 200 as const;

/**
 * Minimum pgvector extension version that supports `hnsw.iterative_scan`
 * (introduced in pgvector 0.8.0). When the installed extension is older or
 * absent, only `set_config('hnsw.ef_search', ...)` is applied.
 */
export const HNSW_ITERATIVE_SCAN_MIN_EXTVERSION = '0.8.0' as const;

/**
 * Compare dotted extension versions (`0.8.0` vs `0.7.4`) numerically with
 * missing segments treated as `0`. Returns false for unparseable input.
 */
export function compareExtensionVersion(actual: string, minimum: string): boolean {
  const parse = (value: string): readonly number[] | null => {
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }
    const parts = value.trim().split('.');
    if (parts.length === 0 || parts.length > 8) {
      return null;
    }
    const numbers: number[] = [];
    for (const part of parts) {
      if (!/^\d+$/.test(part)) {
        return null;
      }
      numbers.push(Number.parseInt(part, 10));
    }
    return numbers;
  };
  const actualParts = parse(actual);
  const minimumParts = parse(minimum);
  if (!actualParts || !minimumParts) {
    return false;
  }
  const length = Math.max(actualParts.length, minimumParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = actualParts[index] ?? 0;
    const b = minimumParts[index] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

/**
 * Format a 384-value finite float vector as pgvector's text input form
 * (`[1,2,3]`). Used as a bound parameter cast to `::vector` — never spliced
 * into SQL text.
 *
 * Throws {@link MemoryEmbeddingError} unless every value is finite and the
 * length is exactly {@link MEMORY_EMBEDDING_DIMENSIONS}.
 */
export function memoryVectorToPgLiteral(vector: readonly number[]): string {
  if (!Array.isArray(vector) || vector.length !== MEMORY_EMBEDDING_DIMENSIONS) {
    throw new MemoryEmbeddingError(
      `embedding vectors must contain exactly ${MEMORY_EMBEDDING_DIMENSIONS} values, got ` +
        `${Array.isArray(vector) ? vector.length : 'non-array'}`,
    );
  }
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new MemoryEmbeddingError('embedding vectors must contain only finite numbers');
    }
  }
  return `[${vector.map((value) => value.toString()).join(',')}]`;
}

/**
 * Escape a keyword for an ILIKE substring pattern. `%`, `_`, and the escape
 * character `~` are neutralized so user keywords match literally (no wildcard
 * injection). Use with SQL `... ILIKE <pattern> ESCAPE '~'`.
 */
export function escapeIlikePattern(keyword: string): string {
  return keyword.replace(/[\\%_~]/g, (char) => `~${char}`);
}

/** Build the `%escaped%` ILIKE pattern from a raw keyword. */
export function ilikeContainsPattern(keyword: string): string {
  return `%${escapeIlikePattern(keyword)}%`;
}
