/**
 * Host capability registry (ADR-001/ADR-002): the six canonical tools the API
 * serves, built PER GENERATION around a trusted server-side context closure.
 *
 * Hard rules:
 * - Every NEW tool executes through the own REST API via an injectable
 *   `fetch`. Production uses a loopback base URL (`INTERNAL_API_BASE_URL`,
 *   default `http://127.0.0.1:${PORT}`); tests inject a recording fetch. There
 *   is NO shadow Work Doc / delegation / memory implementation inside tools.
 * - The context closure supplies chatId / parentMessageId / slug / scope /
 *   verified depth. Model-provided ids are never used for context.
 * - Delegation create/run REST calls carry the SIGNED internal context header
 *   minted in-process; the routes still verify it (trusted, not assumed).
 * - Tool errors are FIXED safe strings; never URLs, provider bodies, store
 *   errors, content, or secrets.
 * - `ask_user` is composed WITHOUT `execute` (HITL marker; no `stop()`).
 */
import { z } from 'zod';
import {
  calculateCapability,
  defineCapability,
  type Capability,
} from '@workforce/core';
import {
  delegationModeSchema,
  delegationTargetAgentSchema,
  delegationTaskSchema,
} from '@workforce/core/delegation';
import { memoryPathSchema } from '@workforce/core/memory';
import {
  workDocContentSchema,
  workDocTitleSchema,
  workDocVersionNumberSchema,
} from '@workforce/core/work-docs';

import type { DelegationContextPayload, DelegationContextSigner } from './delegation-context.js';
import { DELEGATION_CONTEXT_HEADER, contextWindow, internalOwnerHeader } from './delegation-context.js';

/** Minimal structural fetch (global fetch satisfies it; tests record calls). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Trusted per-generation context closure (all values are SERVER-provided). */
export interface AgentToolContext {
  /** Current agent slug (tool paths use it; children run their own slug). */
  readonly slug: string;
  /** Current chat id — ownership anchor for documents/delegations. */
  readonly chatId: string;
  /** Id of the newest user message that started this generation. */
  readonly parentMessageId: string;
  /** Single-tenant scope (Phase 4: always `default`). */
  readonly scope: 'default';
  /**
   * Pre-Phase 6: the RESOLVED platform owner (Better Auth `User.id`) driving
   * this generation. Every tool REST call carries it in a SIGNED internal
   * header; it is never derived from model output or a request body.
   */
  readonly ownerId: string;
  /** Verified delegation depth of THIS generation (0 for root chats). */
  readonly depth: number;
}

export interface HostCapabilityDeps {
  readonly fetchFn: FetchLike;
  readonly baseUrl: string;
  readonly signer: DelegationContextSigner;
  /** Budget shared by sync delegation runs (`DELEGATION_TIMEOUT_MS`). */
  readonly delegationTimeoutMs: number;
}

/** Per-REST-call abort budget (independent of the generation itself). */
export const TOOL_HTTP_TIMEOUT_MS = 30_000;

/** Fixed safe error thrown by every REST-backed executor. */
export class ToolRestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRestError';
  }
}

// ---------------------------------------------------------------------------
// Schemas — the registry's source of truth for capability input boundaries
// ---------------------------------------------------------------------------

const writeDocCreateSchema = z.strictObject({
  action: z.literal('create'),
  type: z.enum(['report', 'plan', 'analysis']),
  title: workDocTitleSchema,
  content: workDocContentSchema,
});

const writeDocUpdateSchema = z.strictObject({
  action: z.literal('update'),
  docId: z.uuid(),
  expectedVersion: workDocVersionNumberSchema,
  content: workDocContentSchema,
  title: workDocTitleSchema.optional(),
  summary: z.string().trim().min(1).max(500).optional(),
});

const writeDocRollbackSchema = z.strictObject({
  action: z.literal('rollback'),
  docId: z.uuid(),
  expectedVersion: workDocVersionNumberSchema,
  version: workDocVersionNumberSchema,
});

export const writeDocInputSchema = z.discriminatedUnion('action', [
  writeDocCreateSchema,
  writeDocUpdateSchema,
  writeDocRollbackSchema,
]);

export const delegateTaskInputSchema = z.strictObject({
  targetAgent: delegationTargetAgentSchema,
  task: delegationTaskSchema,
  mode: delegationModeSchema,
});

export const queryDataInputSchema = z.strictObject({
  sql: z.string().trim().min(1, 'sql must not be empty').max(20_000, 'sql must be at most 20000 characters'),
});

export const searchMemoryInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(500),
  path: memoryPathSchema.optional(),
  limit: z.number().int().min(1).max(20).optional().default(5),
});

export const askUserInputSchema = z.strictObject({
  question: z.string().trim().min(1, 'question must not be empty').max(500, 'question must be at most 500 characters'),
  options: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
});

export const askUserOutputSchema = z.strictObject({ answer: z.string().min(1) });

export interface DocToolOutput {
  readonly documentId: string;
  readonly version: number;
  readonly title: string;
  readonly status: string;
}

export interface DelegateToolOutput {
  readonly delegationId: string;
  readonly status: string;
  readonly childChatId: string;
  readonly result: string | null;
  readonly error: string | null;
}

const delegateOutputSchema = z.strictObject({
  delegationId: z.string(),
  status: z.string(),
  childChatId: z.string(),
  result: z.string().nullable(),
  error: z.string().nullable(),
});

const docOutputSchema = z.strictObject({
  documentId: z.string(),
  version: z.number().int(),
  title: z.string(),
  status: z.string(),
});

// ---------------------------------------------------------------------------
// REST plumbing
// ---------------------------------------------------------------------------

interface RestResult {
  readonly status: number;
  readonly body: unknown;
}

/** Bounded JSON request; failure text is FIXED — never URL/body/secret. */
async function callRestJson(
  deps: HostCapabilityDeps,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
  timeoutMs: number = TOOL_HTTP_TIMEOUT_MS,
): Promise<RestResult> {
  let response: Response;
  try {
    response = await deps.fetchFn(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(headers ?? {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ToolRestError('Tool backend temporarily unavailable.');
  }
  if (response.status === 400) {
    throw new ToolRestError('The tool input was rejected as invalid (HTTP 400).');
  }
  if (response.status === 403) {
    throw new ToolRestError('This agent is not allowed to use that tool (HTTP 403).');
  }
  if (response.status === 404) {
    throw new ToolRestError('The target of the tool call does not exist (HTTP 404).');
  }
  if (response.status === 409) {
    throw new ToolRestError('The tool hit a version conflict (HTTP 409).');
  }
  if (response.status === 413) {
    throw new ToolRestError('The tool result exceeded its size cap (HTTP 413).');
  }
  if (response.status === 503) {
    throw new ToolRestError('Tool backend temporarily unavailable (HTTP 503).');
  }
  if (!response.ok) {
    throw new ToolRestError(`Tool backend temporarily unavailable (HTTP ${String(response.status)}).`);
  }
  if (response.status === 204) {
    return { status: response.status, body: {} };
  }
  const text = await response.text();
  if (text.length === 0) {
    return { status: response.status, body: {} };
  }
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    throw new ToolRestError('Tool backend returned an unreadable response.');
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  throw new ToolRestError('Tool backend returned an unexpected body shape.');
}

function docSummary(document: unknown): DocToolOutput {
  const doc = requireObject(document);
  const id = doc['id'];
  const version = doc['version'];
  const title = doc['title'];
  const status = doc['status'];
  if (typeof id !== 'string' || typeof version !== 'number' || typeof title !== 'string' || typeof status !== 'string') {
    throw new ToolRestError('Tool backend returned an unexpected document shape.');
  }
  return { documentId: id, version, title, status };
}

function delegationSummary(body: unknown): DelegateToolOutput {
  const delegation = requireObject(requireObject(body)['delegation']);
  const id = delegation['id'];
  const status = delegation['status'];
  const childChatId = delegation['childChatId'];
  const result = delegation['result'];
  const error = delegation['error'];
  if (
    typeof id !== 'string' ||
    typeof status !== 'string' ||
    typeof childChatId !== 'string' ||
    (result !== null && typeof result !== 'string') ||
    (error !== null && typeof error !== 'string')
  ) {
    throw new ToolRestError('Tool backend returned an unexpected delegation shape.');
  }
  return { delegationId: id, status, childChatId, result, error };
}

/**
 * Budgets (B2): ordinary tool REST calls stay at the fixed 30 s; the sync
 * delegation REST path (create, and the rare still-pending/running follow-up
 * run) governs the WHOLE child run, so it gets the configured delegation
 * budget plus the same safety margin the route applies — never the hardwired
 * 30 seconds.
 */
export const TOOL_RUN_MARGIN_MS = 10_000;

export function delegationRestTimeoutMs(delegationTimeoutMs: number): number {
  return delegationTimeoutMs + TOOL_RUN_MARGIN_MS;
}

/**
 * One minter for the internal headers the orchestrator's tools attach to
 * their OWN REST calls. Two layers:
 * - `X-Workforce-Internal-Owner` (kind `internal-owner`) — SIGNED owner for
 *   doc/memory/data calls, so the routes resolve the SAME identity that
 *   started the generation (never a client field).
 * - `X-Workforce-Delegation-Context` (kind `delegation-create`) — the
 *   delegation create/run binding (parent chat + parent depth + owner); the
 *   delegation routes verify it against the delegation row. Delegation calls
 *   carry BOTH headers; the owner middleware requires every signed header on
 *   one request to agree on the SAME owner (a mismatch is a fixed 400).
 */
function signedInternalHeaders(deps: HostCapabilityDeps, ctx: AgentToolContext): Record<string, string> {
  const window = contextWindow(deps.delegationTimeoutMs);
  const delegationPayload: DelegationContextPayload = {
    kind: 'delegation-create',
    parentChatId: ctx.chatId,
    parentDepth: ctx.depth,
    ownerId: ctx.ownerId,
    expiresAt: window.expiresAt,
  };
  return {
    [DELEGATION_CONTEXT_HEADER]: deps.signer.sign(delegationPayload),
    ...internalOwnerHeader(deps.signer, ctx.ownerId),
  };
}

async function delegateExecutor(deps: HostCapabilityDeps, ctx: AgentToolContext, input: unknown): Promise<DelegateToolOutput> {
  const parsed = delegateTaskInputSchema.parse(input);
  const delegationBudgetMs = delegationRestTimeoutMs(deps.delegationTimeoutMs);
  const create = await callRestJson(
    deps,
    'POST',
    `${deps.baseUrl}/api/agents/${encodeURIComponent(ctx.slug)}/delegations`,
    {
      targetAgent: parsed.targetAgent,
      task: parsed.task,
      mode: parsed.mode,
      parentChatId: ctx.chatId,
      parentMessageId: ctx.parentMessageId,
    },
    signedInternalHeaders(deps, ctx),
    delegationBudgetMs,
  );
  const delegation = delegationSummary(create.body);
  if (parsed.mode === 'async') {
    return delegation;
  }
  // Sync create WAITS for the run result (the create route executes through
  // its own run REST and answers with the final row). A redundant POST /run
  // is only needed when the row is somehow still pending/running; a terminal
  // row is returned as-is.
  if (delegation.status !== 'pending' && delegation.status !== 'running') {
    return delegation;
  }
  const run = await callRestJson(
    deps,
    'POST',
    `${deps.baseUrl}/api/agents/${encodeURIComponent(ctx.slug)}/delegations/${encodeURIComponent(delegation.delegationId)}/run`,
    undefined,
    signedInternalHeaders(deps, ctx),
    delegationBudgetMs,
  );
  return delegationSummary(run.body);
}

// ---------------------------------------------------------------------------
// Per-generation capability set
// ---------------------------------------------------------------------------

/** Builds the six host capabilities for ONE generation (ADR-002 closure). */
export function buildHostCapabilities(deps: HostCapabilityDeps, ctx: AgentToolContext): readonly Capability[] {
  return [
    calculateCapability,
    defineCapability(
      {
        name: 'search_memory',
        description:
          'Semantic search across recorded memory blocks (hybrid relevance: semantic similarity plus recency). ' +
          'Use it to recall previously stored facts, decisions, and learning context.',
        inputSchema: searchMemoryInputSchema,
        outputSchema: z.strictObject({
          results: z.array(
            z.strictObject({
              id: z.string(),
              path: z.string(),
              kind: z.string(),
              content: z.string(),
              score: z.number(),
              cosineSimilarity: z.number(),
              recencyScore: z.number(),
            }),
          ),
        }),
        readOnly: true,
        requiresApproval: false,
        approvalReason: null,
      },
      (input: unknown) =>
        (async (): Promise<unknown> => {
          const parsed = searchMemoryInputSchema.parse(input);
          // The search reads THROUGH the owner the signed internal header
          // carries: the route forces scope=userMemoryScope(owner), so this
          // tool call can never see another user's (or legacy) memory.
          const result = await callRestJson(
            deps,
            'POST',
            `${deps.baseUrl}/api/memory/search`,
            {
              query: parsed.query,
              ...(parsed.path !== undefined ? { path: parsed.path } : {}),
              limit: parsed.limit,
            },
            internalOwnerHeader(deps.signer, ctx.ownerId),
          );
          const body = requireObject(result.body);
          const results = body['results'];
          if (!Array.isArray(results)) {
            throw new ToolRestError('Tool backend returned an unexpected search shape.');
          }
          return {
            results: results.slice(0, parsed.limit).map((entry) => {
              const hit = requireObject(entry);
              const block = requireObject(hit['block']);
              return {
                id: String(block['id'] ?? ''),
                path: String(block['path'] ?? ''),
                kind: String(block['kind'] ?? ''),
                content: String(block['content'] ?? ''),
                score: Number(hit['score'] ?? 0),
                cosineSimilarity: Number(hit['cosineSimilarity'] ?? 0),
                recencyScore: Number(hit['recencyScore'] ?? 0),
              };
            }),
          };
        })(),
    ),
    defineCapability(
      {
        name: 'query_data',
        description:
          'Run one read-only SELECT/WITH statement over the project tables and return bounded rows. ' +
          'One statement only, no writes; results are capped and the statement has a fixed timeout.',
        inputSchema: queryDataInputSchema,
        outputSchema: z.strictObject({
          columns: z.array(z.string()),
          rows: z.array(z.array(z.unknown())),
          rowCount: z.number().int(),
        }),
        readOnly: true,
        requiresApproval: false,
        approvalReason: null,
      },
      (input: unknown) =>
        (async (): Promise<unknown> => {
          const parsed = queryDataInputSchema.parse(input);
          // The tool input is `{sql}` (phase contract); the REST route takes
          // `{query, limit?}` — same statement, mapped here at the boundary.
          const result = await callRestJson(
            deps,
            'POST',
            `${deps.baseUrl}/api/agents/${encodeURIComponent(ctx.slug)}/data/query`,
            {
              query: parsed.sql,
            },
            internalOwnerHeader(deps.signer, ctx.ownerId),
          );
          const body = requireObject(result.body);
          const columns = body['columns'];
          const rows = body['rows'];
          if (!Array.isArray(columns) || !Array.isArray(rows)) {
            throw new ToolRestError('Tool backend returned an unexpected query shape.');
          }
          return {
            columns: columns.map((name) => String(name)),
            rows: rows.map((row) => (Array.isArray(row) ? row : [row])),
            rowCount: rows.length,
          };
        })(),
    ),
    defineCapability(
      {
        name: 'write_doc',
        description:
          'Create a work document; replace its content with optimistic version checks (update); or roll it ' +
          'back to a prior version. Update/rollback target documents created in this chat, matching the ' +
          'document\'s current version.',
        inputSchema: writeDocInputSchema,
        outputSchema: docOutputSchema,
        readOnly: false,
        requiresApproval: true,
        approvalReason: 'write_doc mutates durable shared documents',
      },
      (input: unknown) =>
        (async (): Promise<DocToolOutput> => {
          const parsed = writeDocInputSchema.parse(input);
          // Doc routes resolve the owner from this SIGNED internal header
          // (`internal-owner`); a body field can never claim another owner.
          const ownerHeaders = internalOwnerHeader(deps.signer, ctx.ownerId);
          if (parsed.action === 'create') {
            const created = await callRestJson(
              deps,
              'POST',
              `${deps.baseUrl}/api/agents/${encodeURIComponent(ctx.slug)}/work-docs`,
              {
                type: parsed.type,
                title: parsed.title,
                content: parsed.content,
                chatId: ctx.chatId,
              },
              ownerHeaders,
            );
            return docSummary(requireObject(created.body)['document']);
          }
          if (parsed.action === 'update') {
            const updated = await callRestJson(
              deps,
              'POST',
              `${deps.baseUrl}/api/agents/${encodeURIComponent(ctx.slug)}/work-docs/${encodeURIComponent(parsed.docId)}/versions`,
              {
                chatId: ctx.chatId,
                expectedVersion: parsed.expectedVersion,
                content: parsed.content,
                ...(parsed.title !== undefined ? { title: parsed.title } : {}),
                ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
              },
              ownerHeaders,
            );
            return docSummary(requireObject(updated.body)['document']);
          }
          const rolled = await callRestJson(
            deps,
            'POST',
            `${deps.baseUrl}/api/agents/${encodeURIComponent(ctx.slug)}/work-docs/${encodeURIComponent(parsed.docId)}/rollback`,
            {
              chatId: ctx.chatId,
              expectedVersion: parsed.expectedVersion,
              toVersion: parsed.version,
              source: 'agent',
            },
            ownerHeaders,
          );
          return docSummary(requireObject(rolled.body)['document']);
        })(),
    ),
    defineCapability(
      {
        name: 'delegate_task',
        description:
          'Delegate a self-contained task to the analyst or researcher worker. Sync mode blocks until the ' +
          'worker answers; async mode returns a pending delegation id (check its status later). One clear ' +
          'objective per delegation.',
        inputSchema: delegateTaskInputSchema,
        outputSchema: delegateOutputSchema,
        readOnly: false,
        requiresApproval: true,
        approvalReason: 'delegate_task starts a worker agent generation',
      },
      (input: unknown) => (async (): Promise<DelegateToolOutput> => delegateExecutor(deps, ctx, input))(),
    ),
    defineCapability(
      {
        name: 'ask_user',
        description:
          'Ask the human user one short clarifying question and end the turn. The user\'s next reply is ' +
          'delivered back as this tool\'s answer. Use only when blocked on a needed human decision.',
        inputSchema: askUserInputSchema,
        outputSchema: askUserOutputSchema,
        readOnly: true,
        requiresApproval: false,
        approvalReason: null,
      },
      // execute-less overload: only valid for ask_user (HITL marker, no stop()).
      undefined as never,
    ),
  ];
}
