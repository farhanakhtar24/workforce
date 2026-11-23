import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactPathInputSchema,
  isBoundedMetadata,
  isValidMemoryPath,
  MAX_METADATA_SERIALIZED_LENGTH,
  MAX_MEMORY_PATH_LENGTH,
  MAX_MEMORY_PATH_SEGMENTS,
  MAX_MEMORY_PATH_SEGMENT_LENGTH,
  MAX_SCOPE_LENGTH,
  normalizeMemoryPath,
  normalizeScope,
  parseMemoryInput,
  queryBlocksInputSchema,
  semanticSearchInputSchema,
  MemoryValidationError,
  writeBlockInputSchema,
} from '../index.js';

// ---------------------------------------------------------------------------
// Path normalization and validation
// ---------------------------------------------------------------------------

test('normalizeMemoryPath lowercases segments and keeps structure', () => {
  assert.strictEqual(normalizeMemoryPath('Projects/Atlas/Notes'), 'projects/atlas/notes');
  assert.strictEqual(normalizeMemoryPath('A-B_2/c'), 'a-b_2/c');
  assert.strictEqual(normalizeMemoryPath('single'), 'single');
});

test('normalizeMemoryPath rejects invalid paths with typed errors', () => {
  assert.throws(() => normalizeMemoryPath('/leading'), MemoryValidationError);
  assert.throws(() => normalizeMemoryPath('trailing/'), MemoryValidationError);
  assert.throws(() => normalizeMemoryPath('a//b'), MemoryValidationError);
  assert.throws(() => normalizeMemoryPath(''), MemoryValidationError);
  assert.throws(() => normalizeMemoryPath(' '), MemoryValidationError);
  assert.throws(() => normalizeMemoryPath('a/b c'), MemoryValidationError);
  assert.throws(() => normalizeMemoryPath('café'), MemoryValidationError);
  assert.throws(() => normalizeMemoryPath('a/2*3'), MemoryValidationError);
  assert.throws(() => normalizeMemoryPath('x'.repeat(MAX_MEMORY_PATH_LENGTH + 1)), MemoryValidationError);
});

test('normalizeMemoryPath enforces segment count and segment length', () => {
  const maxSegments = Array.from({ length: MAX_MEMORY_PATH_SEGMENTS }, (_, i) => `s${i}`).join('/');
  assert.strictEqual(normalizeMemoryPath(maxSegments).split('/').length, MAX_MEMORY_PATH_SEGMENTS);
  assert.throws(
    () => normalizeMemoryPath(`${maxSegments}/one-more`),
    MemoryValidationError,
  );
  const maxSegment = 'x'.repeat(MAX_MEMORY_PATH_SEGMENT_LENGTH);
  assert.strictEqual(normalizeMemoryPath(`a/${maxSegment}`), `a/${maxSegment}`);
  assert.throws(() => normalizeMemoryPath(`a/${'x'.repeat(MAX_MEMORY_PATH_SEGMENT_LENGTH + 1)}`), MemoryValidationError);
});

test('isValidMemoryPath mirrors normalizeMemoryPath acceptance', () => {
  assert.strictEqual(isValidMemoryPath('A/B'), true);
  assert.strictEqual(isValidMemoryPath('a//b'), false);
  assert.strictEqual(isValidMemoryPath('/a'), false);
  assert.strictEqual(isValidMemoryPath('a/'), false);
  assert.strictEqual(isValidMemoryPath('a b'), false);
  assert.strictEqual(isValidMemoryPath('x'.repeat(MAX_MEMORY_PATH_LENGTH + 1)), false);
});

test('normalizeScope validates a single segment shape', () => {
  assert.strictEqual(normalizeScope('Team-1_A'), 'team-1_a');
  assert.strictEqual(normalizeScope('x'.repeat(MAX_SCOPE_LENGTH)), 'x'.repeat(MAX_SCOPE_LENGTH));
  assert.throws(() => normalizeScope('a/b'), MemoryValidationError);
  assert.throws(() => normalizeScope('a b'), MemoryValidationError);
  assert.throws(() => normalizeScope('x'.repeat(MAX_SCOPE_LENGTH + 1)), MemoryValidationError);
  assert.throws(() => normalizeScope(''), MemoryValidationError);
});

// ---------------------------------------------------------------------------
// writeBlockInputSchema
// ---------------------------------------------------------------------------

test('write schema applies defaults: scope "default", confidence 0.8', () => {
  const parsed = writeBlockInputSchema.parse({ path: 'a/b', kind: 'learning', content: 'hello' });
  assert.strictEqual(parsed.scope, 'default');
  assert.strictEqual(parsed.confidence, 0.8);
  assert.strictEqual(parsed.path, 'a/b');
  assert.strictEqual(parsed.content, 'hello');
});

test('write schema normalizes scope and path to lowercase', () => {
  const parsed = writeBlockInputSchema.parse({
    scope: 'Team-1',
    path: 'Projects/Atlas',
    kind: 'decision',
    content: 'x',
  });
  assert.strictEqual(parsed.scope, 'team-1');
  assert.strictEqual(parsed.path, 'projects/atlas');
});

test('write schema trims content before bounds checks', () => {
  const parsed = writeBlockInputSchema.parse({ path: 'a', kind: 'observation', content: '  hi  ' });
  assert.strictEqual(parsed.content, 'hi');
  assert.strictEqual(writeBlockInputSchema.safeParse({ path: 'a', kind: 'learning', content: '    ' }).success, false);
  assert.strictEqual(writeBlockInputSchema.safeParse({ path: 'a', kind: 'learning', content: 'x'.repeat(1000) }).success, true);
  assert.strictEqual(writeBlockInputSchema.safeParse({ path: 'a', kind: 'learning', content: 'x'.repeat(1001) }).success, false);
});

test('write schema bounds confidence and rejects non-finite', () => {
  assert.strictEqual(writeBlockInputSchema.safeParse({ path: 'a', kind: 'learning', content: 'x', confidence: -0.01 }).success, false);
  assert.strictEqual(writeBlockInputSchema.safeParse({ path: 'a', kind: 'learning', content: 'x', confidence: 1.01 }).success, false);
  assert.strictEqual(writeBlockInputSchema.safeParse({ path: 'a', kind: 'learning', content: 'x', confidence: 0 }).success, true);
  assert.strictEqual(writeBlockInputSchema.safeParse({ path: 'a', kind: 'learning', content: 'x', confidence: 1 }).success, true);
  assert.strictEqual(writeBlockInputSchema.safeParse({ path: 'a', kind: 'learning', content: 'x', confidence: Number.NaN }).success, false);
  assert.strictEqual(writeBlockInputSchema.safeParse({ path: 'a', kind: 'learning', content: 'x', confidence: Number.POSITIVE_INFINITY }).success, false);
});

test('write schema validates supersedesId as a uuid and rejects unknown keys', () => {
  const base = { path: 'a', kind: 'correction', content: 'x' };
  assert.strictEqual(
    writeBlockInputSchema.safeParse({ ...base, supersedesId: '3f8c3c02-7e2f-4c8a-9e8f-1c2b3d4e5f60' }).success,
    true,
  );
  assert.strictEqual(writeBlockInputSchema.safeParse({ ...base, supersedesId: 'nope' }).success, false);
  assert.strictEqual(writeBlockInputSchema.safeParse({ ...base, extra: 1 }).success, false);
  assert.strictEqual(writeBlockInputSchema.safeParse({ path: 'a', kind: 'not-a-kind', content: 'x' }).success, false);
});

test('write schema bounds metadata as a JSON object', () => {
  const base = { path: 'a', kind: 'learning', content: 'x' };
  assert.strictEqual(writeBlockInputSchema.safeParse({ ...base, metadata: {} }).success, true);
  assert.strictEqual(writeBlockInputSchema.safeParse({ ...base, metadata: { a: { b: [1, { c: 'x' }] } } }).success, true);
  assert.strictEqual(writeBlockInputSchema.safeParse({ ...base, metadata: [1] }).success, false);
  assert.strictEqual(writeBlockInputSchema.safeParse({ ...base, metadata: 'string' }).success, false);
  assert.strictEqual(writeBlockInputSchema.safeParse({ ...base, metadata: { a: Number.NaN } }).success, false);
  assert.strictEqual(writeBlockInputSchema.safeParse({ ...base, metadata: { a: 10n } }).success, false);
  assert.strictEqual(writeBlockInputSchema.safeParse({ ...base, metadata: { a: 'x'.repeat(1001) } }).success, false);
  assert.strictEqual(writeBlockInputSchema.safeParse({ ...base, metadata: { a: () => 1 } }).success, false);

  // Cyclic metadata fails safely instead of hanging/throwing.
  const cyclic: Record<string, unknown> = { name: 'a' };
  cyclic['self'] = cyclic;
  assert.strictEqual(isBoundedMetadata(cyclic), false);

  // Depth and entry bounds (root object is depth 0; an OBJECT at depth 5 fails
  // while a leaf primitive reached at depth 5 is allowed).
  assert.strictEqual(isBoundedMetadata({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }), false);
  assert.strictEqual(isBoundedMetadata({ a: { b: { c: { d: { e: 1 } } } } }), true);
  assert.strictEqual(isBoundedMetadata({ a: { b: { c: { d: { e: { f: 1 } } } } } }), false);
  assert.strictEqual(isBoundedMetadata({ a: [ [ [ [ [ [ 1 ] ] ] ] ] ] }), false);

  const manyEntries: Record<string, unknown> = {};
  for (let i = 0; i < 101; i += 1) {
    manyEntries[`k${i}`] = i;
  }
  assert.strictEqual(isBoundedMetadata(manyEntries), false);

  const oversize: Record<string, unknown> = { blob: 'x'.repeat(MAX_METADATA_SERIALIZED_LENGTH) };
  assert.strictEqual(isBoundedMetadata(oversize), false);
});

// ---------------------------------------------------------------------------
// queryBlocksInputSchema / semanticSearchInputSchema / compactPathInputSchema
// ---------------------------------------------------------------------------

test('query schema applies defaults and bounds limit to 1..100 ints', () => {
  const parsed = queryBlocksInputSchema.parse({});
  assert.strictEqual(parsed.limit, 20);
  assert.strictEqual(parsed.includeSuperseded, false);
  assert.strictEqual(parsed.scope, undefined);
  assert.strictEqual(queryBlocksInputSchema.safeParse({ limit: 101 }).success, false);
  assert.strictEqual(queryBlocksInputSchema.safeParse({ limit: 0 }).success, false);
  assert.strictEqual(queryBlocksInputSchema.safeParse({ limit: 3.5 }).success, false);
  assert.strictEqual(queryBlocksInputSchema.safeParse({ limit: 100 }).success, true);
});

test('query schema trims keyword and requires 1..500 chars after trim', () => {
  const parsed = queryBlocksInputSchema.parse({ keyword: '  atlas  ', path: 'P' });
  assert.strictEqual(parsed.keyword, 'atlas');
  assert.strictEqual(parsed.path, 'p');
  assert.strictEqual(queryBlocksInputSchema.safeParse({ keyword: '   ' }).success, false);
  assert.strictEqual(queryBlocksInputSchema.safeParse({ keyword: 'x'.repeat(501) }).success, false);
  assert.strictEqual(queryBlocksInputSchema.safeParse({ keyword: 'x'.repeat(500) }).success, true);
});

test('semantic schema requires a trimmed 1..500 query and normalizes filters', () => {
  const parsed = semanticSearchInputSchema.parse({ query: '  how did Atlas deploy?  ', scope: 'Ops', path: 'A/B' });
  assert.strictEqual(parsed.query, 'how did Atlas deploy?');
  assert.strictEqual(parsed.scope, 'ops');
  assert.strictEqual(parsed.path, 'a/b');
  assert.strictEqual(parsed.limit, 20);
  assert.strictEqual(semanticSearchInputSchema.safeParse({ query: '' }).success, false);
  assert.strictEqual(semanticSearchInputSchema.safeParse({ query: '   ' }).success, false);
  assert.strictEqual(semanticSearchInputSchema.safeParse({ query: 'x'.repeat(501) }).success, false);
  // extra keys rejected
  assert.strictEqual(semanticSearchInputSchema.safeParse({ query: 'x', keyword: 'k' }).success, false);
});

test('compact schema requires scope and path', () => {
  const parsed = compactPathInputSchema.parse({ scope: 'Ops', path: 'a/b' });
  assert.strictEqual(parsed.scope, 'ops');
  assert.strictEqual(parsed.path, 'a/b');
  assert.strictEqual(compactPathInputSchema.safeParse({ path: 'a' }).success, false);
  assert.strictEqual(compactPathInputSchema.safeParse({ scope: 'ops' }).success, false);
});

test('parseMemoryInput converts zod failures into typed validation errors', () => {
  try {
    parseMemoryInput(writeBlockInputSchema, { path: 'BAD PATH', kind: 'learning', content: 'x' });
    assert.fail('expected a MemoryValidationError');
  } catch (error) {
    assert.ok(error instanceof MemoryValidationError);
    assert.strictEqual(error.code, 'memory_validation_error');
    assert.ok(error.issues.length > 0);
    assert.ok(error.message.includes('invalid memory input'));
  }
});
