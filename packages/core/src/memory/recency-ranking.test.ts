import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampCosine,
  MEMORY_RECENCY_HALF_LIFE_DAYS,
  MEMORY_RECENCY_HALF_LIFE_DAYS as HALF_LIVES,
  memoryKinds,
  MemoryValidationError,
  rankMemoryCandidates,
  recencyDecay,
  SEMANTIC_WEIGHT,
  RECENCY_WEIGHT,
  type MemoryBlock,
  type MemoryRankCandidate,
} from '../index.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const DAY_MS = 86_400_000;

function blockAt(overrides: Partial<MemoryBlock> & { id?: string; createdAt?: string }): MemoryBlock {
  return {
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    scope: 'test',
    path: 'a/b',
    kind: overrides.kind ?? 'learning',
    content: overrides.content ?? 'body',
    confidence: 0.8,
    embeddingStatus: 'ready',
    embeddingModel: null,
    accessCount: 0,
    supersededById: null,
    metadata: {},
    createdAt: overrides.createdAt ?? '2026-11-19T12:00:00.000Z',
    updatedAt: overrides.createdAt ?? '2026-11-19T12:00:00.000Z',
    embeddedAt: null,
    lastAccessedAt: null,
  } as MemoryBlock;
}

// ---------------------------------------------------------------------------
// recencyDecay + half-lives
// ---------------------------------------------------------------------------

test('half-life table matches the spec exactly', () => {
  assert.deepStrictEqual(HALF_LIVES, {
    learning: 30,
    correction: 90,
    changelog: 180,
    observation: 14,
    decision: 180,
    preference: 90,
  });
});

test('recencyDecay is 1 at age zero and 0.5 at one half-life', () => {
  for (const kind of memoryKinds) {
    assert.strictEqual(recencyDecay(kind, NOW, NOW), 1);
    const atHalfLife = new Date(NOW.getTime() + MEMORY_RECENCY_HALF_LIFE_DAYS[kind] * DAY_MS);
    assert.ok(Math.abs(recencyDecay(kind, NOW, atHalfLife) - 0.5) < 1e-12);
  }
});

test('recencyDecay follows 0.5^(ageDays/halfLife) for every kind', () => {
  const cases: Array<[typeof memoryKinds[number], number]> = [
    ['learning', 60],
    ['correction', 270],
    ['changelog', 540],
    ['observation', 42],
    ['decision', 360],
    ['preference', 45],
  ];
  for (const [kind, days] of cases) {
    const expected = Math.pow(0.5, days / MEMORY_RECENCY_HALF_LIFE_DAYS[kind]);
    const actual = recencyDecay(kind, NOW, new Date(NOW.getTime() + days * DAY_MS));
    assert.ok(Math.abs(actual - expected) < 1e-12, `${kind}@${days}d`);
  }
  assert.ok(Math.abs(recencyDecay('learning', NOW, new Date(NOW.getTime() + 60 * DAY_MS)) - 0.25) < 1e-12);
  assert.ok(Math.abs(recencyDecay('observation', NOW, new Date(NOW.getTime() + 28 * DAY_MS)) - 0.25) < 1e-12);
});

test('recencyDecay accepts ISO strings and treats future createdAt as age 0', () => {
  const later = '2027-01-01T00:00:00.000Z';
  assert.strictEqual(recencyDecay('learning', later, NOW), 1);
  assert.ok(Math.abs(recencyDecay('learning', NOW.toISOString(), NOW.toISOString()) - 1) < 1e-15);
  assert.strictEqual(recencyDecay('learning', NOW.toISOString(), NOW), 1);
});

test('recencyDecay is monotonically non-increasing with age', () => {
  let previous = 1;
  for (let days = 0; days <= 400; days += 5) {
    const value = recencyDecay('observation', NOW, new Date(NOW.getTime() + days * DAY_MS));
    assert.ok(value <= previous + 1e-15);
    previous = value;
  }
});

test('recencyDecay guards: unknown kind throws, invalid dates collapse to 0', () => {
  assert.throws(() => recencyDecay('gossip' as never, NOW, NOW), MemoryValidationError);
  assert.strictEqual(recencyDecay('learning', 'not-a-date', NOW), 0);
  assert.strictEqual(recencyDecay('learning', NOW, Number.NaN as never), 0);
});

// ---------------------------------------------------------------------------
// clampCosine + rankMemoryCandidates
// ---------------------------------------------------------------------------

test('clampCosine clamps to [-1,1] and collapses non-finite to 0', () => {
  assert.strictEqual(clampCosine(2), 1);
  assert.strictEqual(clampCosine(-3), -1);
  assert.strictEqual(clampCosine(0.42), 0.42);
  assert.strictEqual(clampCosine(Number.NaN), 0);
  // +/-Infinity count as non-finite guards (never a ranking top signal).
  assert.strictEqual(clampCosine(Number.POSITIVE_INFINITY), 0);
  assert.strictEqual(clampCosine(Number.NEGATIVE_INFINITY), 0);
});

test('rankMemoryCandidates applies the exact 0.8*cos + 0.2*recency formula', () => {
  // learning block, age 0 -> recency 1.
  const result = rankMemoryCandidates(
    [{ block: blockAt({}), cosineSimilarity: 0.5 }],
    NOW,
    10,
  );
  assert.strictEqual(result.length, 1);
  const expected = SEMANTIC_WEIGHT * 0.5 + RECENCY_WEIGHT * 1;
  assert.ok(Math.abs(result[0]!.score - expected) < 1e-12);
  assert.ok(Math.abs(result[0]!.recencyScore - 1) < 1e-12);
  assert.strictEqual(result[0]!.cosineSimilarity, 0.5);
});

test('rankMemoryCandidates orders by score, then recency, then id (deterministic)', () => {
  const older = blockAt({ id: '00000000-0000-4000-8000-00000000000a', createdAt: '2026-01-01T00:00:00.000Z' });
  const newer = blockAt({ id: '00000000-0000-4000-8000-00000000000b', createdAt: NOW.toISOString() });
  const candidates: MemoryRankCandidate[] = [
    { block: older, cosineSimilarity: 1 },
    { block: newer, cosineSimilarity: 1 },
  ];
  // Same cosine; older learning block (30d half-life) decays more -> newer first.
  const ranked = rankMemoryCandidates(candidates, NOW, 10);
  assert.strictEqual(ranked[0]!.block.id, newer.id);
  assert.strictEqual(ranked[1]!.block.id, older.id);

  // Full tie (same createdAt and cosine) breaks by ascending id.
  const idLow = blockAt({ id: '00000000-0000-4000-8000-000000000001' });
  const idHigh = blockAt({ id: '00000000-0000-4000-8000-000000000002' });
  const tied = rankMemoryCandidates(
    [
      { block: idHigh, cosineSimilarity: 0.9 },
      { block: idLow, cosineSimilarity: 0.9 },
    ],
    NOW,
    10,
  );
  assert.strictEqual(tied[0]!.block.id, idLow.id);
  assert.strictEqual(tied[1]!.block.id, idHigh.id);
});

test('rankMemoryCandidates: recency can outrank identical cosine; cosine dominates scale', () => {
  const fresh = blockAt({ createdAt: NOW.toISOString() });
  const stale = blockAt({ createdAt: '2020-01-01T00:00:00.000Z' });
  const ranked = rankMemoryCandidates(
    [
      { block: stale, cosineSimilarity: 1 },
      { block: fresh, cosineSimilarity: 1 },
    ],
    NOW,
    10,
  );
  assert.ok(ranked[0]!.score > ranked[1]!.score);

  // High cosine vs low cosine, same recency: ordering purely cosine.
  const a = blockAt({ id: '00000000-0000-4000-8000-00000000000a' });
  const b = blockAt({ id: '00000000-0000-4000-8000-00000000000b' });
  const byCos = rankMemoryCandidates(
    [
      { block: a, cosineSimilarity: 0.2 },
      { block: b, cosineSimilarity: 0.9 },
    ],
    NOW,
    10,
  );
  assert.strictEqual(byCos[0]!.block.id, b.id);
});

test('rankMemoryCandidates respects limit and guards (finite, <=0, NaN)', () => {
  const candidates: MemoryRankCandidate[] = [1, 2, 3, 4].map((i) => ({
    block: blockAt({ id: `00000000-0000-4000-8000-00000000000${i}` }),
    cosineSimilarity: i / 4,
  }));
  assert.strictEqual(rankMemoryCandidates(candidates, NOW, 2).length, 2);
  assert.strictEqual(rankMemoryCandidates(candidates, NOW, 0).length, 0);
  assert.strictEqual(rankMemoryCandidates(candidates, NOW, -5).length, 0);
  assert.strictEqual(rankMemoryCandidates(candidates, NOW, Number.NaN).length, 0);
  assert.strictEqual(rankMemoryCandidates(candidates, NOW, 2.9).length, 2);
});

test('rankMemoryCandidates applies finite guards and clamping to cosine', () => {
  const ranked = rankMemoryCandidates(
    [
      { block: blockAt({ id: '00000000-0000-4000-8000-00000000000a' }), cosineSimilarity: 2 },
      { block: blockAt({ id: '00000000-0000-4000-8000-00000000000b' }), cosineSimilarity: -3 },
      { block: blockAt({ id: '00000000-0000-4000-8000-00000000000c' }), cosineSimilarity: Number.NaN },
    ],
    NOW,
    10,
  );
  // All blocks share createdAt -> order purely by score:
  // cos 1 -> ~1.0, NaN -> 0 (collapses to 0.2*recency), cos -1 -> negative.
  assert.ok(Math.abs(ranked[0]!.cosineSimilarity - 1) < 1e-15);
  assert.strictEqual(ranked[1]!.cosineSimilarity, 0); // NaN collapsed to 0
  assert.strictEqual(ranked[2]!.cosineSimilarity, -1);
  assert.ok(Math.abs(ranked[0]!.score - (SEMANTIC_WEIGHT * 1 + RECENCY_WEIGHT * 1)) < 1e-12);
  assert.ok(Math.abs(ranked[2]!.score - (SEMANTIC_WEIGHT * -1 + RECENCY_WEIGHT * 1)) < 1e-12);
});

test('rankMemoryCandidates is deterministic across runs and does not mutate input', () => {
  const candidates: MemoryRankCandidate[] = [
    { block: blockAt({ id: '00000000-0000-4000-8000-00000000000b' }), cosineSimilarity: 0.4 },
    { block: blockAt({ id: '00000000-0000-4000-8000-00000000000a' }), cosineSimilarity: 0.8 },
  ];
  const inputOrder = candidates.map((candidate) => candidate.block.id);
  const first = rankMemoryCandidates(candidates, NOW, 10);
  const second = rankMemoryCandidates(candidates, NOW, 10);
  assert.deepStrictEqual(
    first.map((candidate) => candidate.block.id),
    second.map((candidate) => candidate.block.id),
  );
  assert.deepStrictEqual(candidates.map((candidate) => candidate.block.id), inputOrder);
});

test('rankMemoryCandidates requires a finite `now`', () => {
  assert.throws(() => rankMemoryCandidates([], 'not-a-date' as never, 5), MemoryValidationError);
});
