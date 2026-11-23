/**
 * Pure formatting for chat tool parts (Phase 4 + Phase 2 `calculate`).
 *
 * Every helper is total: it never throws and returns plain-text views only.
 * There is deliberately NO HTML generation anywhere in this module — React
 * renders the returned strings as escaped text, so injection is impossible by
 * construction. Large content is bounded by fixed limits before it ever
 * reaches the component tree.
 */
import { formatScore } from './memory';
import { isSafeChatId } from './api';
import { childChatUrl } from './agents';

/** Hard cap for any echoed tool text. */
export const TOOL_TEXT_LIMIT = 240;
/** Bounded table: at most this many rendered rows (plus a truncation note). */
export const TOOL_ROWS_LIMIT = 8;
/** Bounded list: at most this many search results / options rendered. */
export const TOOL_LIST_LIMIT = 5;
/** Bounded fallback JSON blobs. */
export const TOOL_JSON_LIMIT = 400;
/** Ask-user questions are short by schema (≤500 chars) but still bounded. */
export const ASK_USER_TEXT_LIMIT = 500;

const KNOWN_TOOL_NAMES = [
  'calculate',
  'write_doc',
  'delegate_task',
  'query_data',
  'search_memory',
  'ask_user',
] as const;

export type KnownToolName = (typeof KNOWN_TOOL_NAMES)[number];

export function truncateToolText(value: string, limit: number = TOOL_TEXT_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** `tool-write_doc` → `write_doc`; anything without the prefix is dropped. */
export function toolNameFromPartType(partType: string): string | null {
  if (typeof partType !== 'string' || !partType.startsWith('tool-')) return null;
  return partType.slice('tool-'.length) || null;
}

export function isKnownToolName(value: string | null): value is KnownToolName {
  return (
    value !== null && (KNOWN_TOOL_NAMES as readonly string[]).includes(value)
  );
}

/** Generic lifecycle label for any tool part state (total over junk). */
export function toolStateLabel(state: string): string {
  switch (state) {
    case 'input-streaming':
      return 'Preparing…';
    case 'input-available':
      return 'Waiting for result…';
    case 'output-available':
      return 'Result';
    case 'output-error':
      return 'Failed';
    case 'output-denied':
      return 'Denied';
    default:
      // approval-requested / approval-responded never occur in Phase 4 flows.
      return state ? `State: ${truncateToolText(state, 64)}` : 'Running…';
  }
}

/** Defensive JSON stringify, truncated. Never throws, never emits HTML. */
export function safeJsonText(value: unknown, limit: number = TOOL_JSON_LIMIT): string {
  if (value === undefined) return '';
  try {
    const text = JSON.stringify(value) ?? String(value);
    return truncateToolText(text, limit);
  } catch {
    return truncateToolText(String(value), limit);
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/* ------------------------------------------------------------------ */
/* write_doc                                                           */
/* ------------------------------------------------------------------ */

export interface WriteDocInputView {
  kind: 'ok';
  action: 'create' | 'update' | 'rollback';
  /** First line of the card: e.g. `Create "Report"` / `Update → v5`. */
  summary: string;
  docId: string | null;
  /** Bounded content preview (create/update). */
  contentPreview: string | null;
}

export type WriteDocInputResult =
  | { ok: true; view: WriteDocInputView }
  | { ok: false; text: string };

/**
 * Input shapes (host-capabilities.ts):
 * create  `{ action:'create', type, title, content }`
 * update  `{ action:'update', docId, expectedVersion, content, title?, summary? }`
 * rollback `{ action:'rollback', docId, expectedVersion, version }`
 */
export function formatWriteDocInput(input: unknown): WriteDocInputResult {
  if (input === null || typeof input !== 'object') {
    return { ok: false, text: '(input not available yet)' };
  }
  const record = input as Record<string, unknown>;
  const action = str(record.action);
  if (action === 'create') {
    const docType = str(record.type) ?? 'report';
    const title = str(record.title) ?? '(untitled)';
    const content = str(record.content) ?? '';
    return {
      ok: true,
      view: {
        kind: 'ok',
        action: 'create',
        summary: `Create ${docType}: "${truncateToolText(title)}"`,
        docId: null,
        contentPreview: content ? truncateToolText(content) : null,
      },
    };
  }
  if (action === 'update') {
    const docId = str(record.docId);
    if (docId === null) return { ok: false, text: '(update input incomplete)' };
    const title = str(record.title);
    const version = record.expectedVersion;
    const toVersion = typeof version === 'number' && Number.isInteger(version) ? version : null;
    const content = str(record.content) ?? '';
    const lead = title === null ? 'Update' : `Update: "${truncateToolText(title)}"`;
    const summary = toVersion === null ? lead : `${lead} (from v${toVersion})`;
    return {
      ok: true,
      view: {
        kind: 'ok',
        action: 'update',
        summary,
        docId,
        contentPreview: content ? truncateToolText(content) : null,
      },
    };
  }
  if (action === 'rollback') {
    const docId = str(record.docId);
    const toVersion = record.version;
    if (docId === null || typeof toVersion !== 'number' || !Number.isInteger(toVersion)) {
      return { ok: false, text: '(rollback input incomplete)' };
    }
    return {
      ok: true,
      view: {
        kind: 'ok',
        action: 'rollback',
        summary: `Roll back to version ${toVersion}`,
        docId,
        contentPreview: null,
      },
    };
  }
  return { ok: false, text: '(input not recognized)' };
}

export interface WriteDocOutputView {
  status: 'ok';
  documentId: string;
  version: number;
  title: string | null;
  status_text: string | null;
}

export type WriteDocOutputResult =
  | { ok: true; view: WriteDocOutputView }
  | { ok: false; text: string | null };

/** Output shape: `{ documentId, version, title, status }` (host-capabilities). */
export function parseWriteDocOutput(output: unknown): WriteDocOutputResult {
  if (output === null || typeof output !== 'object') {
    return { ok: false, text: null };
  }
  const record = output as Record<string, unknown>;
  const documentId = str(record.documentId);
  const version = record.version;
  if (documentId === null || typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, text: safeJsonText(output) };
  }
  return {
    ok: true,
    view: {
      status: 'ok',
      documentId,
      version,
      title: str(record.title),
      status_text: str(record.status),
    },
  };
}

/* ------------------------------------------------------------------ */
/* delegate_task                                                       */
/* ------------------------------------------------------------------ */

export interface DelegateInputView {
  targetAgent: string | null;
  taskPreview: string;
  mode: string | null;
}

export type DelegateInputResult =
  | { ok: true; view: DelegateInputView }
  | { ok: false; text: string };

/** Input shape: `{ targetAgent, task, mode }`. */
export function formatDelegateInput(input: unknown): DelegateInputResult {
  if (input === null || typeof input !== 'object') {
    return { ok: false, text: '(input not available yet)' };
  }
  const record = input as Record<string, unknown>;
  const task = str(record.task);
  if (task === null) return { ok: false, text: '(delegation input incomplete)' };
  return {
    ok: true,
    view: {
      targetAgent: str(record.targetAgent),
      taskPreview: truncateToolText(task),
      mode: str(record.mode),
    },
  };
}

export interface DelegateOutputView {
  delegationId: string | null;
  status: string | null;
  /** Child chat URL when the id is safe (target slug comes from the input). */
  childChatUrl: string | null;
  resultPreview: string | null;
  errorText: string | null;
}

export type DelegateOutputResult =
  | { ok: true; view: DelegateOutputView }
  | { ok: false; text: string | null };

/**
 * Output shape: `{ delegationId, status, childChatId, result, error }`. The
 * child agent slug is not part of the output — the caller passes the tool's
 * own `targetAgent` input so the link lands on the right transcript.
 */
export function parseDelegateOutput(output: unknown, targetAgent?: string): DelegateOutputResult {
  if (output === null || typeof output !== 'object') {
    return { ok: false, text: null };
  }
  const record = output as Record<string, unknown>;
  const childChatId = str(record.childChatId);
  const target = typeof targetAgent === 'string' ? targetAgent : '';
  return {
    ok: true,
    view: {
      delegationId: str(record.delegationId),
      status: str(record.status),
      childChatUrl:
        childChatId !== null && isSafeChatId(childChatId) ? childChatUrl(childChatId, target) : null,
      resultPreview: str(record.result) !== null ? truncateToolText(record.result as string) : null,
      errorText: str(record.error) !== null ? truncateToolText(record.error as string) : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* query_data                                                          */
/* ------------------------------------------------------------------ */

export interface QueryDataInputView {
  sql: string;
}

export type QueryDataInputResult =
  | { ok: true; view: QueryDataInputView }
  | { ok: false; text: string };

/** Input shape: `{ sql }`. */
export function formatQueryDataInput(input: unknown): QueryDataInputResult {
  if (input === null || typeof input !== 'object') {
    return { ok: false, text: '(input not available yet)' };
  }
  const sql = str((input as Record<string, unknown>).sql);
  if (sql === null) return { ok: false, text: '(SQL input incomplete)' };
  return { ok: true, view: { sql: truncateToolText(sql, TOOL_TEXT_LIMIT * 4) } };
}

export interface QueryDataRowView {
  cells: readonly string[];
}

export interface QueryDataOutputView {
  columns: readonly string[];
  rows: readonly QueryDataRowView[];
  rowCount: number | null;
  /** True when rows had to be cut for display (never an API truncation claim). */
  displayTruncated: boolean;
}

export type QueryDataOutputResult =
  | { ok: true; view: QueryDataOutputView }
  | { ok: false; text: string | null };

/** Output shape: `{ columns: string[], rows: unknown[][], rowCount: number }`. */
export function parseQueryDataOutput(output: unknown): QueryDataOutputResult {
  if (output === null || typeof output !== 'object') {
    return { ok: false, text: null };
  }
  const record = output as Record<string, unknown>;
  const rawColumns = record.columns;
  const rawRows = record.rows;
  if (!Array.isArray(rawColumns) || !Array.isArray(rawRows)) {
    return { ok: false, text: safeJsonText(output) };
  }
  const cell = (value: unknown): string =>
    value === null || value === undefined
      ? '(null)'
      : truncateToolText(
          typeof value === 'string' ? value : safeJsonText(value, 80),
          80,
        );
  const columns = rawColumns.slice(0, 20).map((name) => (typeof name === 'string' ? name : String(name)));
  const allRows = rawRows
    .slice(0, TOOL_ROWS_LIMIT)
    .map((row) => ({ cells: (Array.isArray(row) ? row : [row]).slice(0, 20).map(cell) }));
  return {
    ok: true,
    view: {
      columns,
      rows: allRows,
      rowCount: typeof record.rowCount === 'number' && Number.isInteger(record.rowCount) ? record.rowCount : null,
      displayTruncated: rawRows.length > TOOL_ROWS_LIMIT,
    },
  };
}

/* ------------------------------------------------------------------ */
/* search_memory                                                       */
/* ------------------------------------------------------------------ */

export interface SearchMemoryInputView {
  query: string;
  path: string | null;
  limit: number | null;
}

export type SearchMemoryInputResult =
  | { ok: true; view: SearchMemoryInputView }
  | { ok: false; text: string };

/** Input shape: `{ query, path?, limit? }`. */
export function formatSearchMemoryInput(input: unknown): SearchMemoryInputResult {
  if (input === null || typeof input !== 'object') {
    return { ok: false, text: '(input not available yet)' };
  }
  const record = input as Record<string, unknown>;
  const query = str(record.query);
  if (query === null) return { ok: false, text: '(search input incomplete)' };
  const limit = record.limit;
  return {
    ok: true,
    view: {
      query: truncateToolText(query),
      path: str(record.path),
      limit: typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : null,
    },
  };
}

export interface SearchMemoryResultView {
  id: string;
  path: string;
  kind: string;
  contentPreview: string;
  score: string;
  cosine: string;
  recency: string;
}

export interface SearchMemoryOutputView {
  results: readonly SearchMemoryResultView[];
  total: number;
  displayTruncated: boolean;
}

export type SearchMemoryOutputResult =
  | { ok: true; view: SearchMemoryOutputView }
  | { ok: false; text: string | null };

/** Output shape: `{ results: [{ id, path, kind, content, score, cosineSimilarity, recencyScore }] }`. */
export function parseSearchMemoryOutput(output: unknown): SearchMemoryOutputResult {
  if (output === null || typeof output !== 'object') {
    return { ok: false, text: null };
  }
  const results = (output as Record<string, unknown>).results;
  if (!Array.isArray(results)) return { ok: false, text: safeJsonText(output) };
  const numberOr = (value: unknown): string =>
    typeof value === 'number' && Number.isFinite(value) ? formatScore(value) : '(n/a)';
  const views: SearchMemoryResultView[] = results.slice(0, TOOL_LIST_LIMIT).map((entry) => {
    const record = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    return {
      id: str(record.id) ?? '(unknown id)',
      path: str(record.path) ?? '(no path)',
      kind: str(record.kind) ?? '(no kind)',
      contentPreview: truncateToolText(str(record.content) ?? '(no content)'),
      score: numberOr(record.score),
      cosine: numberOr(record.cosineSimilarity),
      recency: numberOr(record.recencyScore),
    };
  });
  return {
    ok: true,
    view: { results: views, total: results.length, displayTruncated: results.length > TOOL_LIST_LIMIT },
  };
}

/* ------------------------------------------------------------------ */
/* ask_user                                                            */
/* ------------------------------------------------------------------ */

export interface AskUserInputView {
  question: string;
  options: readonly string[];
}

export type AskUserInputResult =
  | { ok: true; view: AskUserInputView }
  | { ok: false; text: string };

/** Input shape: `{ question, options? }`. */
export function formatAskUserInput(input: unknown): AskUserInputResult {
  if (input === null || typeof input !== 'object') {
    return { ok: false, text: '(input not available yet)' };
  }
  const record = input as Record<string, unknown>;
  const question = str(record.question);
  if (question === null) return { ok: false, text: "(the agent's question is not available yet)" };
  const rawOptions = record.options;
  const options = Array.isArray(rawOptions)
    ? rawOptions.slice(0, TOOL_LIST_LIMIT).map((option) => truncateToolText(str(option) ?? '(option)', 100))
    : [];
  return { ok: true, view: { question: truncateToolText(question, ASK_USER_TEXT_LIMIT), options } };
}

export type AskUserOutputResult = { ok: true; answer: string } | { ok: false; text: string | null };

/** Output shape: `{ answer }` (the user's replied text). */
export function parseAskUserOutput(output: unknown): AskUserOutputResult {
  if (output === null || typeof output !== 'object') {
    return { ok: false, text: null };
  }
  const answer = str((output as Record<string, unknown>).answer);
  if (answer === null) return { ok: false, text: safeJsonText(output) };
  return { ok: true, answer: truncateToolText(answer, ASK_USER_TEXT_LIMIT) };
}

/**
 * The unanswered HITL question gating the composer right now, if any: the
 * LATEST message must be an assistant message holding an `input-available`
 * `ask_user` part. A newer user message means the answer is already on its
 * way through the normal chat path, so the gate lifts. (The API resolves the
 * pending part of the latest assistant message on that next POST.) Returns
 * `null` whenever the composer is the normal channel again.
 */
export function findPendingAskUser(
  messages: readonly {
    role: string;
    parts: readonly { type: string; state?: string }[];
  }[],
): { question: string | null; options: readonly string[] } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === 'user') return null; // a reply already follows the question
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.type !== 'tool-ask_user' || part.state !== 'input-available') continue;
      const view = formatAskUserInput((part as { input?: unknown }).input);
      return view.ok ? { question: view.view.question, options: view.view.options } : null;
    }
    // This is the newest message overall and it asks nothing pending.
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Generic fallback for unknown `tool-*` parts                         */
/* ------------------------------------------------------------------ */

export interface GenericToolView {
  name: string;
  stateLabel: string;
  inputText: string | null;
  outputText: string | null;
  errorText: string | null;
}

/**
 * Bounded, name-only view of an unknown tool part. Input/output render as
 * truncated JSON text; nothing is interpreted, linked, or executed.
 */
export function formatGenericToolPart(view: {
  type: string;
  state: string;
  input: unknown;
  output?: unknown;
  errorText?: string;
}): GenericToolView {
  const name = toolNameFromPartType(view.type);
  const inputText = view.input === undefined ? null : safeJsonText(view.input);
  const outputCandidate = view.output;
  const outputText =
    outputCandidate === undefined
      ? null
      : typeof outputCandidate === 'string' && outputCandidate.length > 0
        ? truncateToolText(outputCandidate)
        : safeJsonText(outputCandidate);
  return {
    name: name === null ? 'tool' : name,
    stateLabel: toolStateLabel(view.state),
    inputText,
    outputText,
    errorText: typeof view.errorText === 'string' && view.errorText.length > 0 ? truncateToolText(view.errorText) : null,
  };
}
