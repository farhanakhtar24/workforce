import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LONG_WAIT_SECONDS,
  LONG_WAIT_TEXT,
  OFFLINE_BODY,
  OFFLINE_BUSY_BODY,
  OFFLINE_TITLE,
  deriveProgressStage,
  formatElapsed,
  isLongWait,
  progressLabel,
} from '../src/lib/chat-progress.js';

function parts(...list: Array<Record<string, unknown>>): Array<unknown> {
  return list;
}

test('submitted stages as Sending your message, regardless of parts', () => {
  for (const p of [
    [],
    parts({ type: 'text', text: 'hello' }),
    parts({ type: 'tool-calculate', state: 'input-available' }),
  ]) {
    assert.deepEqual(deriveProgressStage({ status: 'submitted', parts: p }), {
      kind: 'sending',
      toolName: null,
    });
    assert.equal(progressLabel(deriveProgressStage({ status: 'submitted', parts: p })), 'Sending your message');
  }
});

test('streaming with empty or junk parts waits for the first observable part', () => {
  const junk: Array<unknown> = [
    null,
    'string',
    41,
    {},
    parts({ type: 5 }),
    parts({ type: 'step-start' }),
    parts({ type: 'text', text: '   ' }),
    parts({ type: 'reasoning', text: '' }),
    parts({ type: 'tool-calculate', state: 'weird-state' }),
  ];
  for (const p of [[], junk]) {
    assert.deepEqual(deriveProgressStage({ status: 'streaming', parts: p as never }), {
      kind: 'waiting',
      toolName: null,
    });
    assert.equal(progressLabel(deriveProgressStage({ status: 'streaming', parts: p as never })), 'Waiting for the model');
  }
});

test('thinking ONLY when a live reasoning part exists (and nothing louder)', () => {
  const stage = deriveProgressStage({
    status: 'streaming',
    parts: parts({ type: 'reasoning', text: 'I should check the data' }) as never,
  });
  assert.deepEqual(stage, { kind: 'thinking', toolName: null });
  assert.equal(progressLabel(stage), 'Thinking');

  // Whitespace-only reasoning does not count as arrived activity.
  assert.deepEqual(
    deriveProgressStage({ status: 'streaming', parts: parts({ type: 'reasoning', text: '  ' }) as never }),
    { kind: 'waiting', toolName: null },
  );
});

test('a current tool awaiting its result becomes Using <tool name>', () => {
  for (const state of ['input-streaming', 'input-available']) {
    const stage = deriveProgressStage({
      status: 'streaming',
      parts: parts({ type: 'tool-write_doc', state }) as never,
    });
    assert.deepEqual(stage, { kind: 'tool', toolName: 'write_doc' });
    assert.equal(progressLabel(stage), 'Using write_doc');
  }
  // Finished tool parts are history, not current activity.
  assert.deepEqual(
    deriveProgressStage({
      status: 'streaming',
      parts: parts({ type: 'tool-calculate', state: 'output-available' }) as never,
    }),
    { kind: 'waiting', toolName: null },
  );
});

test('visible live text becomes Writing response', () => {
  const stage = deriveProgressStage({
    status: 'streaming',
    parts: parts({ type: 'text', text: 'Working on it…' }) as never,
  });
  assert.deepEqual(stage, { kind: 'writing', toolName: null });
  assert.equal(progressLabel(stage), 'Writing response');
});

test('precedence: tool await > text; text > reasoning; reasoning-only > waiting', () => {
  const both = deriveProgressStage({
    status: 'streaming',
    parts: parts(
      { type: 'tool-query_data', state: 'input-available' },
      { type: 'text', text: 'earlier words' },
    ) as never,
  });
  assert.deepEqual(both, { kind: 'tool', toolName: 'query_data' });

  const textAndReasoning = deriveProgressStage({
    status: 'streaming',
    parts: parts(
      { type: 'reasoning', text: 'done reasoning' },
      { type: 'text', text: 'started answering' },
    ) as never,
  });
  assert.deepEqual(textAndReasoning, { kind: 'writing', toolName: null });

  const reasoningAndTool = deriveProgressStage({
    status: 'streaming',
    parts: parts(
      { type: 'reasoning', text: 'considering' },
      { type: 'tool-calculate', state: 'input-available' },
    ) as never,
  });
  assert.deepEqual(reasoningAndTool, { kind: 'tool', toolName: 'calculate' });

  // First pending tool wins by arrival order.
  const twoTools = deriveProgressStage({
    status: 'streaming',
    parts: parts(
      { type: 'tool-search_memory', state: 'output-available' },
      { type: 'tool-calculate', state: 'input-available' },
    ) as never,
  });
  assert.deepEqual(twoTools, { kind: 'tool', toolName: 'calculate' });
});

test('long-wait helper: threshold is honest (>=12s), text never promises resume', () => {
  assert.equal(LONG_WAIT_SECONDS, 12);
  assert.equal(isLongWait(11), false);
  assert.equal(isLongWait(12), true);
  assert.equal(isLongWait(90), true);
  assert.equal(isLongWait(-1), false);
  assert.equal(isLongWait(Number.NaN), false);
  assert.ok(LONG_WAIT_TEXT.includes('still active'));
  assert.ok(!/auto(matically )?resum/i.test(LONG_WAIT_TEXT));
});

test('elapsed formatting floors and clamps to 0s', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(12), '12s');
  assert.equal(formatElapsed(12.7), '12s');
  assert.equal(formatElapsed(-5), '0s');
  assert.equal(formatElapsed(Number.NaN), '0s');
});

test('offline copy is honest: keeps draft/history, may fail, no auto-resume promise', () => {
  assert.ok(OFFLINE_TITLE.length > 0);
  assert.ok(OFFLINE_BODY.includes('draft'));
  assert.ok(OFFLINE_BODY.includes('history'));
  assert.ok(OFFLINE_BODY.includes('reconnect'));
  assert.ok(!/auto(matically )?resum/i.test(OFFLINE_BODY));
  assert.ok(/no confirmed progress/i.test(OFFLINE_BUSY_BODY));
});
