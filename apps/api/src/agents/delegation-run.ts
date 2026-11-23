/**
 * Delegation execution (Phase 4 / ADR-004): pending → running → child chat
 * over the SAME REST endpoint humans use → completed | failed | timeout.
 *
 * The child chat is a real `POST /api/agents/{target}/chat` request carrying
 * an `Idempotency-Key` and a server-signed internal delegation context (child
 * chat id + depth + target agent, short TTL). The child's UI SSE stream is
 * consumed with the AI SDK's own `parseJsonEventStream` +
 * `uiMessageChunkSchema` — there is no shadow child runner anywhere.
 *
 * Idempotency: a delegation in `running` or terminal state is returned
 * as-is (no second child generation, ever — retries cannot double-run). The
 * runner NEVER throws for execution failure: every failure maps to the
 * `failed`/`timeout` status with a fixed safe error.
 */
import { parseJsonEventStream, uiMessageChunkSchema } from 'ai';
import type { UIMessageChunk } from 'ai';
import {
  DELEGATION_MAX_RESULT_LENGTH,
  DelegationConflictError,
  type Delegation,
  type DelegationRepository,
} from '@workforce/core/delegation';

import {
  DELEGATION_CONTEXT_HEADER,
  contextWindow,
  type DelegationContextSigner,
  type DelegationContextPayload,
} from './delegation-context.js';
import { TOOL_RUN_MARGIN_MS } from './host-capabilities.js';
import type { FetchLike } from './host-capabilities.js';

export interface DelegationRunDeps {
  readonly signer: DelegationContextSigner;
  readonly fetchFn: FetchLike;
  readonly baseUrl: string;
  /** Bounded child-run budget (`DELEGATION_TIMEOUT_MS`); also the header TTL. */
  readonly delegationTimeoutMs: number;
  readonly repo: DelegationRepository;
}

export interface DelegationRunOutcome {
  readonly delegation: Delegation;
  /** Whether THIS call started a child generation (idempotent no-ops: false). */
  readonly executed: boolean;
}

/** Typed route failure carrying a safe fixed message (no row content). */
export class DelegationRouteError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DelegationRouteError';
    this.status = status;
  }
}

export const INVALID_DELEGATION_CONTEXT = 'Invalid internal delegation context.';
export const DELEGATION_NOT_FOUND = 'Delegation not found.';

/**
 * Verifies the internal create/run header against one delegation row: kind,
 * expiry, and exact binding of parentChatId + parentDepth. The row's depth is
 * the CHILD's depth, so the expected parent depth is `row.depth - 1`.
 */
export function verifyRunHeader(
  deps: DelegationRunDeps,
  headerValue: string | undefined,
  row: Delegation,
): { ok: true } | { ok: false; status: number } {
  if (typeof headerValue !== 'string' || headerValue.length === 0) {
    return { ok: false, status: 400 };
  }
  const verified = deps.signer.verify(headerValue, {
    kind: 'delegation-create',
    parentChatId: row.parentChatId,
    parentDepth: row.depth - 1,
  });
  return verified.ok ? { ok: true } : { ok: false, status: 400 };
}

const CHILD_MESSAGE_MAX_CHARS = 20_000;

/** Extracts the joined text-delta content from the child's UI message stream. */
export async function consumeChildText(
  responseBody: ReadableStream<Uint8Array>,
): Promise<string> {
  const parsedStream = parseJsonEventStream({
    stream: responseBody,
    schema: uiMessageChunkSchema(),
  });
  const reader = parsedStream.getReader();
  const parts: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value.success) {
      throw new Error('child stream parse failure');
    }
    const chunk = value.value as UIMessageChunk;
    if (chunk.type === 'text-delta') {
      parts.push(chunk.delta);
    }
    if (chunk.type === 'error') {
      // The child generation surfaced its safe stream error; treat the run
      // as failed — no partial text is promoted to a result.
      throw new Error('child stream error part');
    }
  }
  const text = parts.join('').trim();
  return text.slice(0, DELEGATION_MAX_RESULT_LENGTH);
}

export interface ChildChatRequestPlan {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
}

/** Pure builder over the public chat contract (tests assert wire shape). */
export function buildChildChatRequest(
  deps: DelegationRunDeps,
  row: Delegation,
): ChildChatRequestPlan {
  // H3: the child user message id is DERIVED from the delegation id (a UUID
  // already inside the API id alphabet), never random — the Idempotency-Key
  // `${childChatId}:${row.id}` is therefore identical on every retry, and a
  // retry racing a previous attempt gets the child's own 409 → durable
  // transcript recovery instead of a second generation.
  const messageId = row.id;
  const window = contextWindow(deps.delegationTimeoutMs);
  const payload: DelegationContextPayload = {
    kind: 'delegation-child-chat',
    parentChatId: row.parentChatId,
    childChatId: row.childChatId,
    targetAgent: row.targetAgent,
    depth: row.depth,
    expiresAt: window.expiresAt,
    deadline: window.deadline,
  };
  const task = row.task.slice(0, CHILD_MESSAGE_MAX_CHARS);
  return {
    url: `${deps.baseUrl}/api/agents/${row.targetAgent}/chat`,
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': `${row.childChatId}:${messageId}`,
      [DELEGATION_CONTEXT_HEADER]: deps.signer.sign(payload),
    },
    body: JSON.stringify({
      id: row.childChatId,
      message: { id: messageId, role: 'user', parts: [{ type: 'text', text: task }] },
      mode: 'action',
    }),
    signal: AbortSignal.timeout(deps.delegationTimeoutMs),
  };
}

/** Marks a delegation terminal with a bounded, safe, fixed error text. */
function safeRunError(outcome: 'failed' | 'timeout'): string {
  return outcome === 'timeout' ? 'The delegated task timed out.' : 'The delegated task failed.';
}

export async function runDelegation(
  deps: DelegationRunDeps,
  headerValue: string | undefined,
  delegationId: string,
): Promise<DelegationRunOutcome> {
  const row = await deps.repo.get(delegationId);
  if (row === null || row === undefined) {
    throw new DelegationRouteError(404, DELEGATION_NOT_FOUND);
  }
  const headerCheck = verifyRunHeader(deps, headerValue, row);
  if (!headerCheck.ok) {
    throw new DelegationRouteError(headerCheck.status, INVALID_DELEGATION_CONTEXT);
  }
  if (row.status === 'running') {
    // H3: a FRESH running row belongs to a live runner that owns the only
    // child generation — leave it be. A STALE one (running longer than the
    // configured run budget; the runner crashed mid-flight) MUST NOT sit
    // forever: recover the finished child from its durable transcript, or
    // transition to failed. No child generation is ever started for a
    // non-pending row.
    return { delegation: await recoverRunningRow(deps, row), executed: false };
  }
  if (row.status !== 'pending') {
    // Terminal rows are immutable (phase contract) and can never regenerate.
    return { delegation: row, executed: false };
  }
  // H1: atomic claim — updateStatus with expectedFrom 'pending' compare-and-
  // sets the transition, so two runners reading 'pending' yield EXACTLY ONE
  // claim and one child generation; losers report the fresh row untouched.
  let running: Delegation;
  try {
    running = await deps.repo.updateStatus({ id: row.id, status: 'running', expectedFrom: 'pending' });
  } catch (error) {
    if (error instanceof DelegationConflictError) {
      const fresh = await deps.repo.get(row.id);
      return { delegation: fresh ?? row, executed: false };
    }
    throw error; // store outage → route maps to 503
  }

  const result = await executeChildChat(deps, running);
  if (result.overall === 'completed') {
    const completed = await deps.repo.updateStatus({ id: running.id, status: 'completed', result: result.text });
    return { delegation: completed, executed: true };
  }
  if (result.overall === 'timeout') {
    const timedOutRow = await deps.repo.updateStatus({
      id: running.id,
      status: 'timeout',
      error: safeRunError('timeout'),
    });
    return { delegation: timedOutRow, executed: true };
  }
  const failedRow = await deps.repo.updateStatus({
    id: running.id,
    status: 'failed',
    error: safeRunError('failed'),
  });
  return { delegation: failedRow, executed: true };
}

/**
 * Stale-running recovery: within the run budget the owner is presumed alive
 * (returns the row untouched); beyond it, the child chat's durable transcript
 * decides — a finished answer is promoted to `completed`, else the row lands
 * `failed` with a fixed safe error (the run itself can no longer be observed).
 *
 * Terminal-write race safety: a live runner past the budget can flip the row
 * `running → failed` (or complete it) between our hydration and our write;
 * our `running → completed` then loses the transition table and a typed
 * DelegationConflictError is thrown. That is NOT a 503-worthy outage: catch
 * ONLY that conflict, re-read and return the fresh row — both runners stay
 * single-writer on the row, no duplicate generation, no lost work. Any OTHER
 * failure propagates (the route maps store outages to 503).
 */
async function recoverRunningRow(deps: DelegationRunDeps, row: Delegation): Promise<Delegation> {
  const updatedAtMs = Date.parse(row.updatedAt);
  const staleMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : Number.POSITIVE_INFINITY;
  if (staleMs < deps.delegationTimeoutMs) {
    return row; // fresh: the live runner owns it (retry/other worker).
  }
  const outcome = await recoverChildResultFromTranscript(deps, row, AbortSignal.timeout(deps.delegationTimeoutMs + TOOL_RUN_MARGIN_MS));
  if (outcome.overall === 'completed') {
    try {
      return await deps.repo.updateStatus({ id: row.id, status: 'completed', result: outcome.text });
    } catch (error) {
      if (error instanceof DelegationConflictError) {
        // Lost the terminal transition to a live runner (e.g. it marked the
        // row failed first): report the fresh row as-is.
        const fresh = await deps.repo.get(row.id);
        return fresh ?? row;
      }
      throw error;
    }
  }
  try {
    return await deps.repo.updateStatus({ id: row.id, status: 'failed', error: safeRunError('failed') });
  } catch (error) {
    if (error instanceof DelegationConflictError) {
      const fresh = await deps.repo.get(row.id);
      return fresh ?? row;
    }
    throw error;
  }
}

interface ChildExecutionResult {
  readonly overall: 'completed' | 'failed' | 'timeout';
  readonly text: string;
}

async function executeChildChat(deps: DelegationRunDeps, row: Delegation): Promise<ChildExecutionResult> {
  const plan = buildChildChatRequest(deps, row);
  let response: Response;
  try {
    response = await deps.fetchFn(plan.url, {
      method: 'POST',
      headers: plan.headers,
      body: plan.body,
      signal: plan.signal,
    });
  } catch (error: unknown) {
    return { overall: timedOut(error, plan.signal) ? 'timeout' : 'failed', text: '' };
  }
  if (response.status === 409) {
    // Child generation already owns this Idempotency-Key (retry after a crash
    // between child completion and the row update): recover the answer from
    // the child chat's durable transcript instead of regenerating.
    return await recoverChildResultFromTranscript(deps, row, plan.signal);
  }
  if (!response.ok || response.body === null) {
    return { overall: 'failed', text: '' };
  }
  try {
    const text = await consumeChildText(response.body);
    if (text.length === 0) {
      return { overall: 'failed', text: '' };
    }
    return { overall: 'completed', text };
  } catch (error: unknown) {
    return { overall: timedOut(error, plan.signal) ? 'timeout' : 'failed', text: '' };
  }
}

function timedOut(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  const name = (error as { name?: unknown } | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError' || name === 'DOMException';
}

interface StoredChatShape {
  id?: unknown;
  role?: unknown;
  parts?: Array<Record<string, unknown>>;
}

/** 409 recovery: read the child's persisted transcript for a final answer. */
async function recoverChildResultFromTranscript(
  deps: DelegationRunDeps,
  row: Delegation,
  signal: AbortSignal,
): Promise<ChildExecutionResult> {  try {
    const hydration = await deps.fetchFn(
      `${deps.baseUrl}/api/agents/${row.targetAgent}/chat/${encodeURIComponent(row.childChatId)}`,
      { method: 'GET', signal },
    );
    if (!hydration.ok) {
      return { overall: 'failed', text: '' };
    }
    const body = (await hydration.json()) as { messages?: unknown };
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index] as StoredChatShape | null;
      if (entry === null || typeof entry !== 'object' || entry.role !== 'assistant') {
        continue;
      }
      const parts = Array.isArray(entry.parts) ? entry.parts : [];
      const textParts = parts
        .map((part) => (part !== null && typeof part === 'object' && part['type'] === 'text' ? part['text'] : undefined))
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (textParts.length > 0) {
        return { overall: 'completed', text: textParts.join('').trim().slice(0, DELEGATION_MAX_RESULT_LENGTH) };
      }
    }
    return { overall: 'failed', text: '' };
  } catch {
    return { overall: 'failed', text: '' };
  }
}
