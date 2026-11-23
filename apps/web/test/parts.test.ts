import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activitySummaryLabel,
  partitionMessageParts,
  type ActivityItem,
  type AnyPartLike,
} from '../src/lib/parts.js';

/**
 * Pure partitioning tests for the Phase 4 assistant-message regions:
 * Response (text parts joined in original order with blank lines),
 * Thinking (reasoning parts), Tool activity (non-HITL tool parts), and
 * the pending ask_user exclusion that keeps the HITL form top-level.
 * Total over junk: unknown/kinds and wrong-typed shapes never throw and
 * never appear in more than one region (no duplication).
 */

type Part = { type: string; text?: unknown; state?: unknown };

const text = (value: string): Part => ({ type: 'text', text: value });
const reasoning = (value: string): Part => ({ type: 'reasoning', text: value });
const calculatePart = (state: string = 'output-available'): Part => ({
  type: 'tool-calculate',
  state,
});
const memoryPart = (): Part => ({ type: 'tool-search_memory', state: 'input-available' });

function names(activity: readonly ActivityItem<AnyPartLike>[]): string[] {
  return activity.map((item) => item.name);
}

test('partitionMessageParts: reasoning separated from response; both join across tools', () => {
  const view = partitionMessageParts([
    text('Part one around'),
    reasoning('silent deliberation'),
    calculatePart(),
    text('Part two around'),
    reasoning('more deliberation'),
    memoryPart(),
  ]);
  assert.equal(view.response, 'Part one around\n\nPart two around');
  assert.equal(view.reasoning, 'silent deliberation\n\nmore deliberation');
  assert.equal(view.response.includes('deliberation'), false);
  assert.equal(names(view.activity).join(','), 'calculate,search_memory');
  assert.equal(view.pendingAsk, null);
});

test('partitionMessageParts: multiple text parts keep original order around tool parts', () => {
  const view = partitionMessageParts([
    text('first'),
    { type: 'tool-write_doc', state: 'output-available' },
    text('second'),
    { type: 'tool-query_data', state: 'output-available' },
    text('third'),
  ]);
  assert.equal(view.response, 'first\n\nsecond\n\nthird');
  assert.deepEqual(names(view.activity), ['write_doc', 'query_data']);
});

test('partitionMessageParts: tool grouping, labels and count include every non-HITL part once', () => {
  const unique = { type: 'tool-delegate_task', state: 'output-error' };
  const view = partitionMessageParts([
    calculatePart('output-available'),
    calculatePart('input-available'),
    unique,
  ]);
  assert.equal(view.activity.length, 3);
  assert.equal(view.activity[0]?.stateLabel, 'Result');
  assert.equal(view.activity[1]?.stateLabel, 'Waiting for result…');
  assert.equal(view.activity[2]?.stateLabel, 'Failed');
  assert.equal(names(view.activity).join(','), 'calculate,calculate,delegate_task');
  // The same object reference is returned: parts render once, not copies.
  assert.equal(view.activity[2]?.part === (unique as unknown), true);
});

test('activitySummaryLabel: deduplicated names capped at 3, null when empty', () => {
  assert.equal(activitySummaryLabel([]), null);
  const two = activitySummaryLabel([
    { part: { type: 'tool-calculate' }, name: 'calculate', stateLabel: 'Result' },
    { part: { type: 'tool-search_memory' }, name: 'search_memory', stateLabel: 'Result' },
  ]);
  assert.equal(two, 'calculate, search_memory');
  const five = activitySummaryLabel([
    { part: { type: 'tool-calculate' }, name: 'calculate', stateLabel: 'Result' },
    { part: { type: 'tool-search_memory' }, name: 'search_memory', stateLabel: 'Result' },
    { part: { type: 'tool-write_doc' }, name: 'write_doc', stateLabel: 'Result' },
    { part: { type: 'tool-calculate' }, name: 'calculate', stateLabel: 'Result' },
    { part: { type: 'tool-query_data' }, name: 'query_data', stateLabel: 'Result' },
  ]);
  assert.equal(five, 'calculate, search_memory, write_doc +1 more');
});

test('partitionMessageParts: pending ask_user excluded from activity only while gate is active', () => {
  const pending = {
    type: 'tool-ask_user',
    state: 'input-available',
    input: { question: 'Proceed?', options: ['yes'] },
  };
  const answered = { type: 'tool-ask_user', state: 'output-available', output: { answer: 'yes' } };

  // Gate active (this is the newest assistant message): top-level, not in
  // activity, not duplicated.
  const gated = partitionMessageParts([text('before'), pending as Part], true);
  assert.equal(gated.pendingAsk === (pending as unknown), true);
  assert.equal(gated.activity.length, 0);
  assert.equal(gated.response, 'before');
  assert.equal(JSON.stringify(gated).split('tool-ask_user').length - 1, 1);

  // Gate inactive (an older message or a later user reply): ordinary activity.
  const ungated = partitionMessageParts([pending as Part], false);
  assert.equal(ungated.pendingAsk, null);
  assert.deepEqual(names(ungated.activity), ['ask_user']);

  // Answered ask_user never becomes pending; it stays readable in activity.
  const resolved = partitionMessageParts([answered as Part], true);
  assert.equal(resolved.pendingAsk, null);
  assert.deepEqual(names(resolved.activity), ['ask_user']);
  assert.equal(resolved.activity[0]?.stateLabel, 'Result');

  // A second pending ask_user does not duplicate the top-level question.
  const secondPending = { ...pending };
  const double = partitionMessageParts([pending as Part, secondPending as Part], true);
  assert.equal(double.pendingAsk === (pending as unknown), true);
  assert.deepEqual(names(double.activity), ['ask_user']);
});

test('partitionMessageParts: streaming-safe totals — empties, junk and unknown parts dropped', () => {
  // Streaming: empty text/reasoning parts render as no region.
  const streaming = partitionMessageParts([text(''), text('   '), reasoning('')]);
  assert.equal(streaming.response, null);
  assert.equal(streaming.reasoning, null);
  assert.equal(streaming.activity.length, 0);

  const view = partitionMessageParts([
    null,
    undefined,
    42,
    'text',
    {},
    { type: 42 },
    { type: 'step-start' },
    { type: 'file', mediaType: 'text/plain' },
    { type: 'source-url', url: 'https://example.com' },
    { type: 'data-chart', data: { series: [1] } },
    { type: 'tool-' }, // nameless tool prefix
    { type: 'tool-mystery_agent', state: 'weird' },
  ] as unknown as Part[]);

  assert.equal(view.response, null);
  assert.equal(view.reasoning, null);
  assert.equal(view.pendingAsk, null);
  assert.deepEqual(names(view.activity), ['tool', 'mystery_agent']);
  assert.equal(view.activity[0]?.stateLabel, 'Running…');
  assert.equal(view.activity[1]?.stateLabel, 'State: weird');

  const empty = partitionMessageParts([]);
  assert.equal(empty.response, null);
  assert.equal(empty.reasoning, null);
  assert.equal(empty.pendingAsk, null);
  assert.equal(empty.activity.length, 0);
});
