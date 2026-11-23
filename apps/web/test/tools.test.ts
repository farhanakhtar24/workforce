import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_USER_TEXT_LIMIT,
  TOOL_JSON_LIMIT,
  TOOL_LIST_LIMIT,
  TOOL_ROWS_LIMIT,
  TOOL_TEXT_LIMIT,
  findPendingAskUser,
  formatAskUserInput,
  formatDelegateInput,
  formatGenericToolPart,
  formatQueryDataInput,
  formatSearchMemoryInput,
  formatWriteDocInput,
  isKnownToolName,
  parseAskUserOutput,
  parseDelegateOutput,
  parseQueryDataOutput,
  parseSearchMemoryOutput,
  parseWriteDocOutput,
  safeJsonText,
  toolNameFromPartType,
  toolStateLabel,
  truncateToolText,
} from '../src/lib/tools.js';

/**
 * Pure tool-part formatting tests. Shapes pinned against
 * apps/api/src/agents/host-capabilities.ts: write_doc returns
 * `{documentId, version, title, status}`, delegate_task returns
 * `{delegationId, status, childChatId, result, error}`, query_data returns
 * `{columns, rows, rowCount}`, search_memory returns
 * `{results:[{id,path,kind,content,score,cosineSimilarity,recencyScore}]}`,
 * ask_user (execute-less) ends at `input-available` and resolves later to
 * `{answer}`. calculate keeps its dedicated Phase 2 module/tests.
 */

const DOC_UUID = '11111111-2222-4333-8444-555555555555';
const CHILD_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/* ------------------------------------------------------------------ */
/* Generic plumbing                                                    */
/* ------------------------------------------------------------------ */

test('toolNameFromPartType + isKnownToolName', () => {
  assert.equal(toolNameFromPartType('tool-write_doc'), 'write_doc');
  assert.equal(toolNameFromPartType('tool-calculate'), 'calculate');
  assert.equal(toolNameFromPartType('tool-mystery_agent'), 'mystery_agent');
  assert.equal(toolNameFromPartType('tool-'), null);
  assert.equal(toolNameFromPartType('text'), null);
  assert.equal(isKnownToolName('ask_user'), true);
  assert.equal(isKnownToolName('mystery_agent'), false);
});

test('toolStateLabel is total over junk states', () => {
  assert.equal(toolStateLabel('input-streaming'), 'Preparing…');
  assert.equal(toolStateLabel('input-available'), 'Waiting for result…');
  assert.equal(toolStateLabel('output-available'), 'Result');
  assert.equal(toolStateLabel('output-error'), 'Failed');
  assert.equal(toolStateLabel('output-denied'), 'Denied');
  assert.equal(toolStateLabel('approval-requested'), 'State: approval-requested');
  assert.equal(toolStateLabel(''), 'Running…');
});

test('truncateToolText and safeJsonText bound their output', () => {
  const long = 'x'.repeat(TOOL_TEXT_LIMIT + 50);
  assert.equal(truncateToolText(long).length, TOOL_TEXT_LIMIT + 1); // + ellipsis
  assert.equal(truncateToolText(long).endsWith('…'), true);
  const junk = { a: 'y'.repeat(TOOL_JSON_LIMIT + 10) };
  assert.equal(safeJsonText(junk).length <= TOOL_JSON_LIMIT + 1, true);
  assert.equal(safeJsonText(undefined), '');
  // Cyclic / unstringifiable values must not throw.
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.equal(safeJsonText(cyclic).length > 0, true);
});

/* ------------------------------------------------------------------ */
/* write_doc                                                           */
/* ------------------------------------------------------------------ */

test('formatWriteDocInput: create / update / rollback summaries', () => {
  const create = formatWriteDocInput({
    action: 'create',
    type: 'report',
    title: 'Q3 findings',
    content: 'c'.repeat(TOOL_TEXT_LIMIT + 5),
  });
  assert.equal(create.ok, true);
  if (create.ok) {
    assert.equal(create.view.action, 'create');
    assert.equal(create.view.summary, 'Create report: "Q3 findings"');
    assert.equal(create.view.docId, null);
    assert.equal(create.view.contentPreview?.endsWith('…'), true);
  }

  const update = formatWriteDocInput({
    action: 'update',
    docId: DOC_UUID,
    expectedVersion: 3,
    content: 'new body',
  });
  assert.equal(update.ok, true);
  if (update.ok) {
    assert.equal(update.view.action, 'update');
    assert.equal(update.view.summary, 'Update (from v3)');
    assert.equal(update.view.docId, DOC_UUID);
  }

  const rollback = formatWriteDocInput({
    action: 'rollback',
    docId: DOC_UUID,
    expectedVersion: 4,
    version: 2,
  });
  assert.equal(rollback.ok, true);
  if (rollback.ok) {
    assert.equal(rollback.view.summary, 'Roll back to version 2');
    assert.equal(rollback.view.docId, DOC_UUID);
    assert.equal(rollback.view.contentPreview, null);
  }

  for (const junk of [null, 42, 'x', {}, { action: 'unknown' }, { action: 'update' }]) {
    assert.equal(formatWriteDocInput(junk).ok, false);
  }
});

test('parseWriteDocOutput: {documentId, version, title, status}; junk falls back', () => {
  const ok = parseWriteDocOutput({ documentId: DOC_UUID, version: 7, title: 'T', status: 'draft' });
  assert.deepEqual(ok, {
    ok: true,
    view: { status: 'ok', documentId: DOC_UUID, version: 7, title: 'T', status_text: 'draft' },
  });
  const minimal = parseWriteDocOutput({ documentId: DOC_UUID, version: 1 });
  assert.equal(minimal.ok, true);
  assert.equal(parseWriteDocOutput({ documentId: DOC_UUID, version: 0 }).ok, false);
  assert.equal(parseWriteDocOutput('not object').ok, false);
  assert.equal(parseWriteDocOutput(null).ok, false);
  const junkText = parseWriteDocOutput({ weird: true });
  assert.equal(junkText.ok, false);
});

/* ------------------------------------------------------------------ */
/* delegate_task                                                       */
/* ------------------------------------------------------------------ */

test('formatDelegateInput: bounded task; junk falls back', () => {
  const ok = formatDelegateInput({ targetAgent: 'analyst', task: 'k'.repeat(TOOL_TEXT_LIMIT + 1), mode: 'sync' });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.view.targetAgent, 'analyst');
    assert.equal(ok.view.mode, 'sync');
    assert.equal(ok.view.taskPreview.endsWith('…'), true);
  }
  assert.equal(formatDelegateInput({}).ok, false);
  assert.equal(formatDelegateInput('x').ok, false);
});

test('parseDelegateOutput: child link is canonical, worker-slug-gated, safe-id-gated', () => {
  const ok = parseDelegateOutput(
    {
      delegationId: 'd-1',
      status: 'completed',
      childChatId: CHILD_UUID,
      result: 'worker says hi',
      error: null,
    },
    'analyst',
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.view.childChatUrl, `/agents/analyst/chat/${CHILD_UUID}`);
    assert.equal(ok.view.resultPreview, 'worker says hi');
    assert.equal(ok.view.errorText, null);
  }
  const running = parseDelegateOutput({ status: 'running', childChatId: CHILD_UUID }, 'researcher');
  if (running.ok) assert.equal(running.view.childChatUrl, `/agents/researcher/chat/${CHILD_UUID}`);
  // Wrong target slug / unsafe child id → no link at all.
  const wrongTarget = parseDelegateOutput({ childChatId: CHILD_UUID }, 'orchestrator');
  if (wrongTarget.ok) assert.equal(wrongTarget.view.childChatUrl, null);
  const unsafeId = parseDelegateOutput({ childChatId: '../../etc' }, 'analyst');
  if (unsafeId.ok) assert.equal(unsafeId.view.childChatUrl, null);
  assert.equal(parseDelegateOutput('junk').ok, false);
});

/* ------------------------------------------------------------------ */
/* query_data                                                          */
/* ------------------------------------------------------------------ */

test('parseQueryDataOutput: bounded table with rowCount and display-truncation flag', () => {
  const rows = Array.from({ length: TOOL_ROWS_LIMIT + 4 }, (_, i) => [i, `r${i}`]);
  const parsed = parseQueryDataOutput({ columns: ['id', 'name'], rows, rowCount: rows.length });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.view.columns, ['id', 'name']);
    assert.equal(parsed.view.rows.length, TOOL_ROWS_LIMIT);
    assert.equal(parsed.view.displayTruncated, true);
    assert.equal(parsed.view.rowCount, TOOL_ROWS_LIMIT + 4);
  }
  const small = parseQueryDataOutput({ columns: ['n'], rows: [[1], [null]], rowCount: 2 });
  assert.equal(small.ok, true);
  if (small.ok) {
    assert.equal(small.view.displayTruncated, false);
    assert.equal(small.view.rows[1]?.cells[0], '(null)');
  }
  // Non-array rows / objects fall back to bounded text.
  assert.equal(parseQueryDataOutput({ columns: 'no' }).ok, false);
  const junk = parseQueryDataOutput('{"columns":1}');
  assert.equal(junk.ok, false);
  assert.equal(parseQueryDataOutput(null).ok, false);
});

test('formatQueryDataInput: bounded SQL; junk falls back', () => {
  const ok = formatQueryDataInput({ sql: 'SELECT 1' });
  assert.deepEqual(ok, { ok: true, view: { sql: 'SELECT 1' } });
  assert.equal(formatQueryDataInput({}).ok, false);
  assert.equal(formatQueryDataInput('SELECT').ok, false);
  // Long SQL is bounded to 4 × TOOL_TEXT_LIMIT.
  const long = formatQueryDataInput({ sql: 'q'.repeat(TOOL_TEXT_LIMIT * 5) });
  if (long.ok) assert.equal(long.view.sql.length <= TOOL_TEXT_LIMIT * 4 + 1, true);
});

/* ------------------------------------------------------------------ */
/* search_memory                                                       */
/* ------------------------------------------------------------------ */

test('parseSearchMemoryOutput: bounded results with formatted scores', () => {
  const hit = {
    id: 'block-1',
    path: 'research/llm',
    kind: 'learning',
    content: 'c'.repeat(TOOL_TEXT_LIMIT + 4),
    score: 0.9123456,
    cosineSimilarity: 0.88,
    recencyScore: 0.99,
  };
  const parsed = parseSearchMemoryOutput({ results: [hit, ...Array.from({ length: TOOL_LIST_LIMIT + 2 }, (_, i) => hit)] });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.view.results.length, TOOL_LIST_LIMIT);
    assert.equal(parsed.view.total, TOOL_LIST_LIMIT + 3);
    assert.equal(parsed.view.displayTruncated, true);
    assert.equal(parsed.view.results[0]?.score, '0.912');
    assert.equal(parsed.view.results[0]?.cosine, '0.880');
    assert.equal(parsed.view.results[0]?.contentPreview.endsWith('…'), true);
  }
  // Non-numeric scores render as (n/a) instead of crashing.
  const weird = parseSearchMemoryOutput({ results: [{ id: 'x', score: 'high', content: 'c' }] });
  if (weird.ok) {
    assert.equal(weird.view.results[0]?.score, '(n/a)');
    assert.equal(weird.view.results[0]?.id, 'x');
  }
  assert.equal(parseSearchMemoryOutput({ results: 'no' }).ok, false);
  assert.equal(parseSearchMemoryOutput(null).ok, false);
});

test('formatSearchMemoryInput: query required; path/limit optional', () => {
  const ok = formatSearchMemoryInput({ query: 'latency notes', path: 'research', limit: 5 });
  assert.deepEqual(ok, {
    ok: true,
    view: { query: 'latency notes', path: 'research', limit: 5 },
  });
  assert.equal(formatSearchMemoryInput({ query: '' }).ok, false);
  assert.equal(formatSearchMemoryInput('x').ok, false);
});

/* ------------------------------------------------------------------ */
/* ask_user (HITL)                                                     */
/* ------------------------------------------------------------------ */

test('formatAskUserInput: question + bounded options', () => {
  const ok = formatAskUserInput({
    question: 'Which region should we benchmark?',
    options: ['eu-west', 'us-east'],
  });
  assert.deepEqual(ok, {
    ok: true,
    view: { question: 'Which region should we benchmark?', options: ['eu-west', 'us-east'] },
  });
  const bounded = formatAskUserInput({ question: 'q', options: Array.from({ length: 12 }, (_, i) => `o${i}`) });
  if (bounded.ok) assert.equal(bounded.view.options.length, TOOL_LIST_LIMIT);
  assert.equal(formatAskUserInput({}).ok, false);
  assert.equal(formatAskUserInput(null).ok, false);
});

test('parseAskUserOutput: {answer}; junk falls back bounded', () => {
  const long = 'a'.repeat(ASK_USER_TEXT_LIMIT + 10);
  const ok = parseAskUserOutput({ answer: long });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.answer.length <= ASK_USER_TEXT_LIMIT + 1, true);
  assert.equal(parseAskUserOutput({}).ok, false);
  assert.equal(parseAskUserOutput('x').ok, false);
});

test('findPendingAskUser: newest assistant message only; answered parts not pending', () => {
  const pendingPart = { type: 'tool-ask_user', state: 'input-available', input: { question: 'Proceed?', options: ['yes'] } };
  const answeredPart = {
    type: 'tool-ask_user',
    state: 'output-available',
    input: { question: 'Proceed?' },
    output: { answer: 'yes' },
  };

  // Newest assistant message holds the pending question.
  const transcript = [
    { role: 'user', parts: [{ type: 'text' }] },
    { role: 'assistant', parts: [{ type: 'text' }, pendingPart] },
  ];
  const found = findPendingAskUser(transcript);
  assert.deepEqual(found, { question: 'Proceed?', options: ['yes'] });

  // An answered newest message → no gate.
  const answered = findPendingAskUser([
    { role: 'assistant', parts: [answeredPart] },
    { role: 'user', parts: [{ type: 'text' }] },
  ]);
  assert.equal(answered, null);

  // Pending question in an OLDER assistant message is ignored (server only
  // resolves the newest one), and a trailing user message does not reset it.
  const older = findPendingAskUser([
    { role: 'assistant', parts: [pendingPart] },
    { role: 'user', parts: [{ type: 'text' }] },
  ]);
  assert.equal(older, null);

  assert.equal(findPendingAskUser([]), null);
  assert.equal(findPendingAskUser([{ role: 'user', parts: [] }]), null);
});

/* ------------------------------------------------------------------ */
/* Generic fallback                                                    */
/* ------------------------------------------------------------------ */

test('formatGenericToolPart: name-only, state-labeled, bounded, total', () => {
  const view = formatGenericToolPart({
    type: 'tool-mystery_agent',
    state: 'output-available',
    input: { task: 'i'.repeat(TOOL_JSON_LIMIT * 2) },
    output: 'o'.repeat(TOOL_TEXT_LIMIT * 2),
  });
  assert.equal(view.name, 'mystery_agent');
  assert.equal(view.stateLabel, 'Result');
  assert.equal(view.inputText !== null && view.inputText.length <= TOOL_JSON_LIMIT + 1, true);
  assert.equal(view.outputText !== null && view.outputText.length <= TOOL_TEXT_LIMIT + 1, true);
  assert.equal(view.errorText, null);

  const errored = formatGenericToolPart({
    type: 'tool-strange',
    state: 'output-error',
    input: undefined,
    errorText: 'e'.repeat(TOOL_TEXT_LIMIT * 3),
  });
  assert.equal(errored.name, 'strange');
  assert.equal(errored.stateLabel, 'Failed');
  assert.equal(errored.inputText, null);
  assert.equal(errored.errorText !== null && errored.errorText.length <= TOOL_TEXT_LIMIT + 1, true);

  const prefixJunk = formatGenericToolPart({ type: 'not-a-tool', state: 'weird', input: 1 });
  assert.equal(prefixJunk.name, 'tool');
  assert.equal(prefixJunk.stateLabel, 'State: weird');
});
