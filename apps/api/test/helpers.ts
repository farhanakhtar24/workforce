/**
 * Test helpers: start the real Express app with an injected mock model, an
 * in-memory store, and an in-memory stream context. No network, no Redis, no
 * real Ollama — everything that would call out is a mock.
 */
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { LanguageModel, UIMessage } from 'ai';
import express from 'express';
import type { Server } from 'node:http';
import { buildApp } from '../src/app.js';
import { createBackgroundTracker } from '../src/background.js';
import { loadApiConfig, type ApiConfig } from '../src/config.js';
import { createInMemoryChatStore } from '../src/store/memory.js';
import type { MemoryService } from '@workforce/core/memory';
import { createInMemoryStreamContext, type InMemoryStreamContext, type InMemoryStreamState } from '../src/stream-context/memory.js';
import type { StreamContext } from '../src/stream-context/types.js';
import { CHAT_OWNER_ID_PATTERN, type ChatRef, type ChatStore } from '../src/store/types.js';
import type { MemoryRouteDeps } from '../src/memory/routes.js';
import type { HostCapabilityDeps, FetchLike } from '../src/agents/host-capabilities.js';
import { WorkDocService } from '@workforce/core/work-docs';
import { InMemoryWorkDocStore } from '@workforce/core/work-docs';
import { InMemoryDelegationRepository, type DelegationRepository } from '@workforce/core/delegation';
import type { DelegationJobQueue } from '../src/agents/delegation-queue.js';
import type { DataQueryService } from '../src/agents/data-query.js';
import {
  InMemorySchedulerStore,
  SchedulerService,
  type AgentTask,
  type AgentTaskExecution,
  type SchedulerStore,
} from '@workforce/core/scheduler';
import type { SchedulerQueuePort, SchedulerRunBudgets } from '../src/scheduler/types.js';
import { createDelegationRoutes } from '../src/agents/delegation-routes.js';
import type { AppAuthDeps } from '../src/app.js';
import { createDelegationContextSigner, INTERNAL_SCHEDULER_HEADER, internalOwnerHeader, type DelegationContextSigner } from '../src/agents/delegation-context.js';
import type { AuthOwner } from '../src/auth/owner.js';

export const TEST_ORIGINAL_ORIGIN = 'http://localhost:3000';

/**
 * The static TEST owner injected through buildApp deps (`auth: { staticOwner }`)
 * — never a production bypass. Every pre-existing test exercises its behavior
 * as this owner; explicit unauthenticated tests opt into `ownerMode: 'none'`.
 */
export const TEST_OWNER: AuthOwner = {
  userId: 'test-owner-0001',
  email: 'test-owner@example.com',
  emailVerified: true,
};
/** A SECOND owner for cross-owner isolation tests. */
export const TEST_OWNER_B: AuthOwner = {
  userId: 'test-owner-0002',
  email: 'test-owner-b@example.com',
  emailVerified: true,
};

let cachedTestSigner: DelegationContextSigner | null = null;
/** Shared test signer (the SAME secret wiring passes to the app). */
export function testInternalSigner(): DelegationContextSigner {
  if (cachedTestSigner === null) {
    cachedTestSigner = createDelegationContextSigner(Buffer.from(TEST_DELEGATION_SECRET, 'utf8'));
  }
  return cachedTestSigner;
}

/** Signed internal-owner headers for loopback-style test calls. */
export function internalOwnerHeaders(): Record<string, string> {
  return internalOwnerHeader(testInternalSigner(), TEST_OWNER.userId);
}

/**
 * Worker run headers: convention marker + SIGNED `internal-scheduler-run`
 * context bound to the task/execution id — exactly the contract the routes
 * verify (the literal worker header alone is no longer sufficient).
 */
export function schedulerRunHeaders(target: { taskId?: string; executionId?: string }): Record<string, string> {
  return {
    'X-Workforce-Scheduler-Worker': '1',
    [INTERNAL_SCHEDULER_HEADER]: testInternalSigner().sign({
      kind: 'internal-scheduler-run',
      ...(target.taskId !== undefined ? { taskId: target.taskId } : {}),
      ...(target.executionId !== undefined ? { executionId: target.executionId } : {}),
      expiresAt: Date.now() + 300_000,
    }),
  };
}

export function testConfig(
  overrides: Partial<{ port: number; webOrigin: string; blockedModelPrefixes: string; modelPricingJson: string }> = {},
): ApiConfig {
  return loadApiConfig({
    OLLAMA_API_KEY: 'test-key-not-real',
    OLLAMA_BASE_URL: 'https://ollama.invalid/v1',
    OLLAMA_MODEL: 'glm-5.3-flash',
    REDIS_URL: 'redis://127.0.0.1:6379',
    PORT: '3001',
    WEB_ORIGIN: TEST_ORIGINAL_ORIGIN,
    ...(overrides.port !== undefined ? { PORT: String(overrides.port) } : {}),
    ...(overrides.webOrigin !== undefined ? { WEB_ORIGIN: overrides.webOrigin } : {}),
    ...(overrides.blockedModelPrefixes !== undefined
      ? { WORKFORCE_BLOCKED_MODEL_PREFIXES: overrides.blockedModelPrefixes }
      : {}),
    ...(overrides.modelPricingJson !== undefined ? { OLLAMA_MODEL_PRICING_JSON: overrides.modelPricingJson } : {}),
  });
}

/** Minimal valid usage object for mock finish chunks. */
export function mockUsage(): {
  inputTokens: { total: number; noCache: number; cacheRead: number; cacheWrite: number };
  outputTokens: { total: number; text: number; reasoning: number };
} {
  return {
    inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 7, text: 7, reasoning: 0 },
  };
}

const STOP: LanguageModelV3StreamPart = {
  type: 'finish',
  usage: mockUsage(),
  finishReason: { unified: 'stop', raw: undefined },
};

/** One text response: `Hello world!`. */
export function textStep(): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Hello ' },
    { type: 'text-delta', id: 't1', delta: 'world!' },
    { type: 'text-end', id: 't1' },
    STOP,
  ];
}

/** One tool-call response invoking `calculate` with `2+2`. */
export function calculateStep(expression = '2+2'): LanguageModelV3StreamPart[] {
  const input = JSON.stringify({ expression });
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'c1', toolName: 'calculate' },
    { type: 'tool-input-delta', id: 'c1', delta: input },
    { type: 'tool-input-end', id: 'c1' },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'calculate', input },
    {
      type: 'finish',
      usage: mockUsage(),
      finishReason: { unified: 'tool-calls', raw: undefined },
    },
  ];
}

/** One tool-call response invoking an arbitrary tool with a JSON input. */
export function toolCallStep(
  toolName: 'ask_user' | 'delegate_task' | 'write_doc' | 'query_data' | 'search_memory' | 'calculate',
  input: unknown,
  toolCallId = 'c1',
): LanguageModelV3StreamPart[] {
  const encoded = JSON.stringify(input);
  const finish: LanguageModelV3StreamPart = {
    type: 'finish',
    usage: mockUsage(),
    finishReason: { unified: 'tool-calls', raw: undefined },
  };
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: encoded },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: encoded },
    finish,
  ];
}

export interface MockModelSpec {
  /** Steps served one per doStream call. */
  steps: LanguageModelV3StreamPart[][];
  /** Delay in ms between chunks of every step (default 0). */
  chunkDelayMs?: number;
}

export function createMockModel(spec: MockModelSpec): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: spec.steps.map((step) => ({
      stream: simulateReadableStream({
        chunks: step,
        initialDelayInMs: spec.chunkDelayMs ?? 0,
        chunkDelayInMs: spec.chunkDelayMs ?? 0,
      }),
    })),
  });
}

/** Model whose doStream always rejects (provider down). */
export function createFailingModel(): LanguageModel & { callCount(): number } {
  let calls = 0;
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-failing',
    supportedUrls: {},
    async doStream() {
      calls += 1;
      throw new Error('provider unavailable');
    },
  } as unknown as LanguageModel & { callCount(): number };
}

export function userMessage(text: string, id = randomId()): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/**
 * A stored assistant message holding ONE pending `ask_user` tool part
 * (`input-available`) — the shape the stream machinery persists when the
 * execute-less tool ends the turn.
 */
export function assistantMessageWithAskUser(options: {
  id: string;
  question: string;
  toolCallId: string;
}): UIMessage {
  return {
    id: options.id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-ask_user',
        toolCallId: options.toolCallId,
        state: 'input-available',
        input: { question: options.question },
      } as unknown as UIMessage['parts'][number],
    ],
  };
}

export function randomId(): string {
  return `id-${Math.random().toString(36).slice(2, 10)}`;
}

/** Fixed test secret for the internal delegation context (never a real one). */
export const TEST_DELEGATION_SECRET = 'test-secret-for-signature-0123456789abcdef';

/** Seeds chat history through the append-only contract, oldest first. */
export async function seedMessages(
  store: ChatStore,
  chat: ChatRef,
  messages: UIMessage[],
): Promise<void> {
  for (const message of messages) {
    await store.appendMessage(chat, message);
  }
}

export interface TestAppOptions {
  model?: LanguageModel;
  store?: ChatStore;
  streamContext?: StreamContext & { state?: InMemoryStreamState };
  webOrigin?: string;
  /** Called on every tracked background rejection. */
  onBackgroundError?: (error: unknown) => void;
  /**
   * Owner injection mode: `'static'` (default) attaches {@link TEST_OWNER} to
   * every gated request through buildApp deps; `'none'` installs no auth deps
   * at all (fail-closed: every gated route answers the fixed 401).
   */
  ownerMode?: 'static' | 'none';
  /**
   * Explicit auth deps override (e.g. a DIFFERENT static owner for
   * cross-owner isolation tests). Default: static TEST_OWNER, or none.
   */
  auth?: AppAuthDeps;
  /**
   * Pre-Phase 6 model composition (fake catalog + recorded modelFor + the
   * default id). When present, the model/usage/catalog routes mount and the
   * chat POST routes through modelFor. When absent: the single-mock behavior.
   */
  models?: {
    readonly catalog: {
      list(): Promise<{ models: ReadonlyArray<{ id: string; name: string; modifiedAt: string | null; capabilities: ReadonlyArray<string>; parameterSize: string | null; locked: boolean; lockReason: string | null }> }>;
      details(modelId: string): Promise<{ status: 'ok' | 'not-found'; details?:
        { contextLength: number | null; capabilities: readonly string[] | null; parameterSize: string | null; thinking: boolean | null } }>;
    };
    readonly modelFor: (modelId: string) => LanguageModel;
    readonly defaultModelId: string;
  };
  /**
   * Pre-Phase 6 per-user settings service (fake). When present, /api/settings
   * mounts and the personal gate reads it.
   */
  settings?: import('../src/settings/settings.js').SettingsServiceLike;
  /**
   * Pre-Phase 6 opt-in personal memory composition (fake). When present the
   * chat POST gates capture/recall/purge on the settings flag.
   */
  personal?: {
    readonly settings: import('../src/settings/settings.js').SettingsServiceLike;
    readonly memory: MemoryService;
    readonly capture: {
      enqueueCapture(input: {
        ownerId: string;
        scope: string;
        chatId: string;
        slug: string;
        userMessageId: string;
        assistantMessageId: string;
      }): Promise<boolean>;
    };
  };
  /** Phase 3 memory pipeline; when omitted the memory routes are absent. */
  memory?: MemoryRouteDeps;  /** Phase 4 agent runtime fixture (see {@link startAgentsTestApp}). */
  agents?: AgentsFixtures;
  /** Phase 5 scheduler fixture; when present the /api/scheduler routes mount. */
  scheduler?: SchedulerFixtures;
  /** Pre-Phase 6: env-scoped blocked-model prefixes for the test config. */
  blockedModelPrefixes?: string;
  /** Pre-Phase 6: explicit per-million pricing JSON for the test config. */
  modelPricingJson?: string;
}

export interface AgentsFixtures {
  /** Loopback origin substituted for the placeholder at request time. */
  delegationTimeoutMs?: number;
  workDocService?: WorkDocService;
  delegationRepo?: DelegationRepository;
  delegationQueue?: DelegationJobQueue | null;
  /** When false the whole agent runtime is omitted (legacy surface tests). */
  wire?: boolean;
  dataQueryService?: DataQueryService;
  queryRowCap?: number;
}

export interface SchedulerFixtures {
  /** In-memory store for the service; tests seed/assert on it directly. */
  store?: SchedulerStore;
  /** Queue fake override; default records every call and never fails. */
  queue?: SchedulerQueuePort;
  /** Run-budget overrides (shortened in tests; see SchedulerRunBudgets). */
  executionTimeoutMs?: number;
  metadataTimeoutMs?: number;
  staleRunningMs?: number;
}

/**
 * Records every scheduler queue interaction; per-test failure injection via
 * {@link failSync} / {@link failEnqueue}.
 */
export class FakeSchedulerQueue implements SchedulerQueuePort {
  readonly syncCalls: Array<{ taskId: string; isActive: boolean }> = [];
  readonly enqueueCalls: string[] = [];
  private syncFailure: Error | null = null;
  private enqueueFailure: Error | null = null;

  /** Fails the next syncTask calls (null restores healthy behavior). */
  failSync(error: Error | null): void {
    this.syncFailure = error;
  }

  /** Fails the next enqueueExecution calls (null restores healthy behavior). */
  failEnqueue(error: Error | null): void {
    this.enqueueFailure = error;
  }

  async syncTask(task: AgentTask): Promise<{ recurringScheduler: 'none'; onceJob: 'none' }> {
    this.syncCalls.push({ taskId: task.id, isActive: task.isActive });
    if (this.syncFailure !== null) {
      throw this.syncFailure;
    }
    return { recurringScheduler: 'none', onceJob: 'none' };
  }

  async enqueueExecution(execution: Pick<AgentTaskExecution, 'id'>): Promise<boolean> {
    this.enqueueCalls.push(execution.id);
    if (this.enqueueFailure !== null) {
      throw this.enqueueFailure;
    }
    return true;
  }

  async ping(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    return;
  }
}

export const silentLogger = { error: (): void => undefined, warn: (): void => undefined };

export interface TestApp {
  config: ApiConfig;
  store: ChatStore;
  /** Memory impl unless a stub is injected; cast when touching `.state`. */
  streamContext: StreamContext & { state?: InMemoryStreamState };
  background: ReturnType<typeof createBackgroundTracker>;
  server: Server;
  port: number;
  /** Phase 3 memory deps as injected (undefined when omitted). */
  memory?: MemoryRouteDeps;
  /** Phase 4 runtime handles when the agent fixture is wired. */
  agents?: {
    hostDeps: HostCapabilityDeps;
    signer: DelegationContextSigner;
    /** Loopback origin the injected fetchFn rewrites to this port. */
    internalOrigin: string;
    workDocService: WorkDocService | undefined;
    delegationRepo: DelegationRepository | undefined;
    delegationQueue: DelegationJobQueue | null | undefined;
  };
  /** Phase 5 scheduler handles when the scheduler fixture is wired. */
  scheduler?: {
    service: SchedulerService;
    store: SchedulerStore;
    queue: SchedulerQueuePort;
  };
  /** Closes the HTTP server and drains tracked background tasks. */
  close(): Promise<void>;
}

/**
 * Starts the real app on an ephemeral port. Side effects are bounded to
 * `app.listen(0)`; only the provided fakes touch anything else.
 */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const store = options.store ?? createInMemoryChatStore();
  const streamContext = options.streamContext ?? createInMemoryStreamContext();
  const background = createBackgroundTracker({
    onError: options.onBackgroundError ?? (() => undefined),
  });
  const config = testConfig({
    webOrigin: options.webOrigin ?? TEST_ORIGINAL_ORIGIN,
    ...(options.blockedModelPrefixes !== undefined ? { blockedModelPrefixes: options.blockedModelPrefixes } : {}),
    ...(options.modelPricingJson !== undefined ? { modelPricingJson: options.modelPricingJson } : {}),
  });

  // Phase 4 fixtures: the tools/delegations call the SAME REST API through a
  // rewriting fetch — the placeholder origin is substituted with the real
  // ephemeral port once the server is listening, so every child chat, run,
  // work-doc, memory, and query call flows through the one Express app.
  const INTERNAL_ORIGIN = 'http://workforce-test-internal';
  const agentsFixtures = options.agents;
  let livePort = 0;
  const agentFetchFn: FetchLike = (input, init) => {
    const rewritten = typeof input === 'string' ? input.replace(INTERNAL_ORIGIN, `http://127.0.0.1:${livePort}`) : input;
    return fetch(rewritten, init);
  };
  const signer = createDelegationContextSigner(Buffer.from(TEST_DELEGATION_SECRET, 'utf8'));
  const delegationTimeoutMs = agentsFixtures?.delegationTimeoutMs ?? 120_000;
  const hostDeps: HostCapabilityDeps = {
    fetchFn: agentFetchFn,
    baseUrl: INTERNAL_ORIGIN,
    signer,
    delegationTimeoutMs,
  };
  const workDocService =
    agentsFixtures?.workDocService ??
    (agentsFixtures === undefined ? undefined : new WorkDocService({ store: new InMemoryWorkDocStore() }));
  const delegationRepo =
    agentsFixtures?.delegationRepo ??
    (agentsFixtures === undefined ? undefined : new InMemoryDelegationRepository());
  const delegationQueue = agentsFixtures?.delegationQueue ?? null;
  const dataQueryService = agentsFixtures?.dataQueryService;

  // Phase 5 scheduler fixture: the runner posts the isolated chat through the
  // SAME rewriting loopback fetch (one app, one port), the queue is a fake.
  // The run service needs the shared signer: scheduler runs sign their
  // `internal-owner` loopback chat/hydration/resume calls with the owner
  // derived from the execution row (TEST_OWNER by construction here).
  const schedulerFixtures = options.scheduler;
  const schedulerStore = schedulerFixtures?.store ?? new InMemorySchedulerStore();
  const schedulerService = new SchedulerService({ store: schedulerStore });
  const schedulerQueue = schedulerFixtures?.queue ?? new FakeSchedulerQueue();

  const app = buildApp({
    config,
    store,
    streamContext,
    model: options.model as LanguageModel,
    background,
    auth:
      options.auth !== undefined
        ? options.auth
        : (options.ownerMode ?? 'static') === 'none'
          ? undefined
          : { staticOwner: TEST_OWNER },
    models: options.models,
    memory: options.memory,
    settings: options.settings,
    personal: options.personal,
    agents:
      agentsFixtures?.wire === false
        ? undefined
        : {
            hostDeps,
            signer,
            workDocs: agentsFixtures === undefined ? undefined : { service: workDocService as WorkDocService },
            delegations:
              agentsFixtures === undefined
                ? undefined
                : createDelegationRoutes({
                    repo: delegationRepo as DelegationRepository,
                    queue: delegationQueue,
                    chatStore: store,
                    signer,
                    fetchFn: agentFetchFn,
                    baseUrl: INTERNAL_ORIGIN,
                    delegationTimeoutMs,
                    logger: { error: () => undefined, warn: () => undefined },
                  }),
            dataQuery:
              dataQueryService === undefined || agentsFixtures === undefined
                ? undefined
                : { service: dataQueryService, rowCap: agentsFixtures?.queryRowCap ?? 200 },
          },
    scheduler:
      schedulerFixtures === undefined
        ? undefined
        : {
            service: schedulerService,
            queue: schedulerQueue,
            run: {
              fetchFn: agentFetchFn,
              baseUrl: INTERNAL_ORIGIN,
              executionTimeoutMs: schedulerFixtures.executionTimeoutMs ?? 180_000,
              metadataTimeoutMs: schedulerFixtures.metadataTimeoutMs ?? 10_000,
              staleRunningMs: schedulerFixtures.staleRunningMs ?? 30_000,
              signer,
              logger: silentLogger,
            },
            logger: silentLogger,
          },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not get an ephemeral port');
  }
  livePort = address.port;
  return {
    config,
    store,
    streamContext,
    background,
    memory: options.memory,
    agents:
      agentsFixtures === undefined
        ? undefined
        : {
            hostDeps,
            signer,
            internalOrigin: INTERNAL_ORIGIN,
            workDocService,
            delegationRepo,
            delegationQueue,
          },
    scheduler:
      schedulerFixtures === undefined
        ? undefined
        : { service: schedulerService, store: schedulerStore, queue: schedulerQueue },
    server,
    port: address.port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await background.waitForAll(2_000);
    },
  };
}

export interface PostChatOptions {
  port: number;
  body: unknown;
  slug?: string;
  headers?: Record<string, string>;
}

export async function postChat(options: PostChatOptions): Promise<Response> {
  const slug = options.slug ?? 'general';
  return await fetch(`http://127.0.0.1:${options.port}/api/agents/${slug}/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': idempotencyKeyFor(options.body),
      ...options.headers,
    },
    body: JSON.stringify(options.body),
  });
}

/** Builds the canonical `{chatId}:{messageId}` key the client must send. */
export function idempotencyKeyFor(body: unknown): string {
  const { id, message } = body as { id: string; message: { id: string } };
  return `${id}:${message.id}`;
}

export interface GetOptions {
  port: number;
  path: string;
  headers?: Record<string, string>;
}

export async function getJson(options: GetOptions): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(`http://127.0.0.1:${options.port}${options.path}`, {
    headers: options.headers,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as unknown) : null,
    headers: response.headers,
  };
}

/** Parses an SSE body into `{ type, ... }` UI message chunks. */
export async function parseSseChunks(response: Response): Promise<Array<{ type: string }>> {
  if (response.body === null) {
    throw new Error('SSE response has no body');
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const chunks: Array<{ type: string }> = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += value;
    const lines = buffer.split('\n\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const dataLine = line.split('\n').find((candidate) => candidate.startsWith('data: '));
      if (dataLine === undefined || dataLine.includes('[DONE]')) {
        continue;
      }
      chunks.push(JSON.parse(dataLine.slice(6)) as { type: string });
    }
  }
  return chunks;
}
