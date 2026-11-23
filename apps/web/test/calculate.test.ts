import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALCULATE_TEXT_LIMIT,
  calculateStateLabel,
  formatCalculateInput,
  parseCalculateOutput,
  truncateText,
} from '../src/lib/calculate.js';

/**
 * Pure formatting tests for `calculate` tool parts. The tool's execute
 * currently returns a JSON *string* like `{"result":14}` (see
 * packages/core/src/capabilities/calculate), so that shape is pinned here.
 */

test('parseCalculateOutput: parses the JSON-string {"result":<number>} shape', () => {
  for (const [raw, expected] of [
    ['{"result":14}', 14],
    ['{"result":-2}', -2],
    ['{"result":0.75}', 0.75],
    ['42', 42],
    ["'not json'" as string, null],
  ] as [string, number | null][]) {
    const view = parseCalculateOutput(raw);
    if (expected === null) {
      assert.equal(view.status, 'fallback');
    } else {
      assert.deepEqual(view, { status: 'ok', result: expected });
    }
  }
});

test('parseCalculateOutput: also accepts defensively-shaped number and object output', () => {
  assert.deepEqual(parseCalculateOutput(14), { status: 'ok', result: 14 });
  assert.deepEqual(parseCalculateOutput({ result: 14 }), { status: 'ok', result: 14 });
  // Non-finite numbers are not results.
  const infinite = parseCalculateOutput({ result: Infinity });
  assert.equal(infinite.status, 'fallback');
});

test('parseCalculateOutput: never echoes hostile content as HTML, only as truncated text', () => {
  const injection = '{"result"' + ',"payload":"<img src=x onerror=alert(1)>' + '"' + '}';
  const view = parseCalculateOutput(injection);
  // No valid numeric result in that text → fallback path.
  assert.equal(view.status, 'fallback');
  if (view.status === 'fallback') {
    assert.equal(view.text.includes('<img'), true);
    assert.equal(view.text.length <= CALCULATE_TEXT_LIMIT + 1, true);
    // The renderer outputs plain text nodes; the helper itself holds no markup.
    assert.equal(view.text.startsWith('{'), true);
  }
});

test('parseCalculateOutput: truncated fallback for oversized and missing output', () => {
  const huge = 'x'.repeat(CALCULATE_TEXT_LIMIT + 500);
  const view = parseCalculateOutput(huge);
  assert.equal(view.status, 'fallback');
  if (view.status === 'fallback') {
    assert.equal(view.text.length, CALCULATE_TEXT_LIMIT + 1); // truncation ellipsis
    assert.equal(view.text.endsWith('…'), true);
  }
  assert.equal(parseCalculateOutput(undefined).status, 'fallback');
  assert.equal(parseCalculateOutput(null).status, 'fallback');
  assert.equal(parseCalculateOutput({ nope: true }).status, 'fallback');
});

test('calculateStateLabel: every lifecycle state has a visible label', () => {
  assert.equal(calculateStateLabel('input-streaming'), 'Preparing calculation…');
  assert.equal(calculateStateLabel('input-available'), 'Calculating…');
  assert.equal(calculateStateLabel('output-available'), 'Result');
  assert.equal(calculateStateLabel('output-error'), 'Calculation failed');
  // Unknown future states stay visible instead of disappearing.
  assert.equal(calculateStateLabel('approval-requested'), 'Calculation');
});

test('formatCalculateInput: shows the expression, bounded and safe', () => {
  assert.equal(formatCalculateInput({ expression: '2 + 3 * 4' }), '2 + 3 * 4');
  assert.equal(formatCalculateInput(undefined), '(pending)');
  assert.equal(formatCalculateInput('just a string'), '"just a string"');
  const long = '1 + '.repeat(100); // 400 chars
  assert.equal(formatCalculateInput({ expression: long }).length, CALCULATE_TEXT_LIMIT + 1);
});

test('truncateText: hard cap with ellipsis, untouched under limit', () => {
  assert.equal(truncateText('short'), 'short');
  assert.equal(truncateText('a'.repeat(10), 5), 'aaaaa…');
  assert.equal(truncateText('', 5), '');
});
