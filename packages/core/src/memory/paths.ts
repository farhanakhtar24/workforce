/**
 * Path addressing for the memory tree.
 *
 * A memory path is a slash-separated sequence of segments:
 *
 *   scope-independent, 1..12 segments, each 1..64 chars of
 *   `[a-z0-9_-]` (ASCII lowercase letters, digits, underscore, hyphen).
 *
 * - No empty segments, no leading/trailing slash, no `//`.
 * - Normalization lowercases segments (ASCII-only, `A-Z` -> `a-z`) so callers
 *   may pass mixed-case paths; storage is always canonical lowercase.
 * - The full path is bounded by 12 * 64 + 11 = 779 characters; the schemas
 *   accept up to 800 characters of raw input headroom.
 *
 * These functions are the single source of truth for path rules. The Zod
 * schemas in `./schemas.js` refine against them, and stores re-validate on
 * write for defense in depth.
 */

import { MemoryValidationError } from './errors.js';

export const MAX_MEMORY_PATH_SEGMENTS = 12;
export const MAX_MEMORY_PATH_SEGMENT_LENGTH = 64;
export const MAX_MEMORY_PATH_LENGTH = 800;
export const MAX_SCOPE_LENGTH = 64;

const PATH_SEGMENT_PATTERN = /^[a-z0-9_-]{1,64}$/;

/** ASCII-only lowercase so locale rules (e.g. Turkish I) cannot leak in. */
function asciiLowercase(value: string): string {
  let result = '';
  for (const char of value) {
    result += char >= 'A' && char <= 'Z' ? String.fromCharCode(char.charCodeAt(0) + 32) : char;
  }
  return result;
}

function isValidSegment(segment: string): boolean {
  return PATH_SEGMENT_PATTERN.test(segment);
}

/**
 * Validate a raw path string WITHOUT normalizing case. Returns true when
 * `normalizeMemoryPath` would accept it.
 */
export function isValidMemoryPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_MEMORY_PATH_LENGTH) {
    return false;
  }
  const segments = value.split('/');
  if (segments.length > MAX_MEMORY_PATH_SEGMENTS) {
    return false;
  }
  return segments.every((segment) => {
    if (segment.length === 0 || segment.length > MAX_MEMORY_PATH_SEGMENT_LENGTH) {
      return false;
    }
    return isValidSegment(asciiLowercase(segment));
  });
}

/**
 * Normalize and validate a memory path. Lowercases each segment, validates
 * segment count/charset/length, and returns the canonical `a/b/c` form.
 * Throws {@link MemoryValidationError} on invalid input.
 */
export function normalizeMemoryPath(value: string): string {
  if (value.length === 0 || value.length > MAX_MEMORY_PATH_LENGTH) {
    throw new MemoryValidationError(
      `memory path must be between 1 and ${MAX_MEMORY_PATH_LENGTH} characters`,
    );
  }
  const segments = value.split('/').map((segment) => asciiLowercase(segment));
  if (segments.length > MAX_MEMORY_PATH_SEGMENTS) {
    throw new MemoryValidationError(
      `memory path must have at most ${MAX_MEMORY_PATH_SEGMENTS} segments`,
    );
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new MemoryValidationError('memory path segments must not be empty (no leading/trailing slash or "//")');
    }
    if (segment.length > MAX_MEMORY_PATH_SEGMENT_LENGTH) {
      throw new MemoryValidationError(
        `memory path segments must be at most ${MAX_MEMORY_PATH_SEGMENT_LENGTH} characters`,
      );
    }
    if (!isValidSegment(segment)) {
      throw new MemoryValidationError(
        'memory path segments may only contain lowercase ascii letters, digits, "_" and "-"',
      );
    }
  }
  return segments.join('/');
}

/**
 * Validate and normalize a scope identifier (a single path segment shape).
 * Throws {@link MemoryValidationError} on invalid input.
 */
export function normalizeScope(value: string): string {
  const lowered = asciiLowercase(value);
  if (lowered.length === 0 || lowered.length > MAX_SCOPE_LENGTH) {
    throw new MemoryValidationError(
      `memory scope must be between 1 and ${MAX_SCOPE_LENGTH} characters`,
    );
  }
  if (!PATH_SEGMENT_PATTERN.test(lowered)) {
    throw new MemoryValidationError(
      'memory scope may only contain lowercase ascii letters, digits, "_" and "-"',
    );
  }
  return lowered;
}

/**
 * True when `candidate` is the exact path `prefix` or a descendant of it
 * (`prefix` itself matches, `prefix/child` matches, `prefixsibling` does not).
 * Both inputs must already be normalized.
 */
export function isPathWithin(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(prefix + '/');
}
