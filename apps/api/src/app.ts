/**
 * Express app factory. Dependency-injected and side-effect-free so tests can
 * start the whole app with a mock model and in-memory store/stream context;
 * `src/server.ts` is the only module that wires real defaults and listens.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { ApiConfig } from './config.js';
import { consoleLogger, type SafeLogger } from './logging.js';
import type { ChatStore } from './store/types.js';
import type { StreamContext } from './stream-context/types.js';
import type { BackgroundTaskTracker } from './background.js';
import type { CreateChatTurnStreamOptions } from './generation.js';
import { createChatRoutes } from './http/routes.js';
import { createChatListRoute } from './http/chat-list.js';
import { createMemoryRoutes, type MemoryRouteDeps } from './memory/routes.js';
import { sendJsonError } from './http/adapter.js';
import { safeErrorStatus } from './errors.js';
import type { WorkDocRouteDeps } from './agents/work-doc-routes.js';
import { createWorkDocRoutes } from './agents/work-doc-routes.js';
import type { DelegationRouteHandlers } from './agents/delegation-routes.js';
import { dataQueryRouteHandler, type DataQueryRouteDeps } from './agents/data-query-routes.js';
import type { DelegationContextSigner } from './agents/delegation-context.js';
import type { HostCapabilityDeps } from './agents/host-capabilities.js';
import type { SchedulerRouteDeps } from './scheduler/routes.js';
import { createSchedulerRoutes } from './scheduler/routes.js';

export interface AppDependencies {
  config: ApiConfig;
  store: ChatStore;
  streamContext: StreamContext;
  model: CreateChatTurnStreamOptions['model'];
  background: BackgroundTaskTracker;
  logger?: SafeLogger;
  /**
   * Phase 3 memory pipeline, injected as { service, queue }. Existing
   * chat-only callers may omit it: the memory routes are then simply absent
   * (404). Production wiring in `src/server.ts` always supplies it.
   */
  memory?: MemoryRouteDeps;
  /**
   * Phase 4 agent runtime (composition + tools + delegation + work docs +
   * query_data). When omitted, only `general` stays servable and the Phase 2
   * surface remains byte-compatible.
   */
  agents?: AgentRuntimeDeps;
  /**
   * Phase 5 scheduler composition (`/api/scheduler`). When omitted, the
   * scheduler routes are absent (404). The API produces/syncs schedules only
   * — the scheduler BullMQ Worker lives in `src/scheduler-worker.ts`.
   */
  scheduler?: SchedulerRouteDeps;
}

export interface AgentRuntimeDeps {
  /** Capability-tool composition deps (fetch/baseUrl/signer/timeout). */
  hostDeps: HostCapabilityDeps;
  /** Verifier/minter for the internal delegation context header. */
  signer: DelegationContextSigner;
  /** Work document routes; absent when omitted (404). */
  workDocs?: WorkDocRouteDeps;
  /** Delegation routes; absent when omitted (404). */
  delegations?: DelegationRouteHandlers;
  /** `query_data` route wiring; absent when omitted (404). */
  dataQuery?: DataQueryRouteDeps;
}

/**
 * CORS for the Next origin (ADR-005): only `config.webOrigin` gets
 * `Access-Control-Allow-Origin`, and `Idempotency-Key` is both allowed as a
 * request header and exposed as a response header. Preflight is answered
 * here. Everything JSON, no wildcard origins.
 */
export function corsMiddleware(config: Pick<ApiConfig, 'webOrigin'>): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin === config.webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
      res.setHeader('Access-Control-Expose-Headers', 'Idempotency-Key');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204);
      res.end();
      return;
    }
    next();
  };
}

export function buildApp(dependencies: AppDependencies): Express {
  const app = express();
  const logger = dependencies.logger ?? consoleLogger;

  // No trust-proxy / compression / cookie middleware: responses stream raw.
  // JSON bodies are bounded; larger payloads are rejected, not queued.
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(corsMiddleware({ webOrigin: dependencies.config.webOrigin }));

  // body-parser failure mapping (M1): express.json forwards errors with a
  // `type` tag — never trust its message/status text, only our fixed strings.
  app.use(
    (
      error: unknown,
      _req: Request,
      res: Response,
      next: NextFunction,
    ): void => {
      if (error !== null && typeof error === 'object' && 'type' in error) {
        if ((error as { type: unknown }).type === 'entity.parse.failed') {
          sendJsonError(res, 400, 'Malformed JSON request body.');
          return;
        }
        if ((error as { type: unknown }).type === 'entity.too.large') {
          sendJsonError(res, 413, 'Request body is too large.');
          return;
        }
      }
      next(error);
    },
  );

  const chatRoutes = createChatRoutes({
    config: dependencies.config,
    store: dependencies.store,
    streamContext: dependencies.streamContext,
    model: dependencies.model,
    background: dependencies.background,
    logger,
    agents:
      dependencies.agents !== undefined
        ? { hostDeps: dependencies.agents.hostDeps, signer: dependencies.agents.signer }
        : undefined,
  });
  const { health, hydration, postChat, resumeStream } = chatRoutes;

  app.get('/health', health);
  app.post('/api/agents/:slug/chat', postChat);
  app.get('/api/agents/:slug/chat/:clientChatId', hydration);
  app.get('/api/agents/:slug/chat/:clientChatId/stream', resumeStream);

  // Recent-chat sidebar history (Phase 6 UX) — mounted with the store every
  // composition provides; legacy chats flow through the store's own
  // bounded discovery. Safe 400/503 handling lives in the route module.
  app.get('/api/chats', createChatListRoute({ store: dependencies.store, logger }).listChats);

  // Phase 3 memory routes, only when memory deps are injected.
  if (dependencies.memory !== undefined) {
    const memoryRoutes = createMemoryRoutes({ ...dependencies.memory, logger });
    app.post('/api/memory/blocks', memoryRoutes.createBlock);
    app.get('/api/memory/blocks', memoryRoutes.listBlocks);
    app.post('/api/memory/search', memoryRoutes.search);
    app.get('/api/memory/blocks/:id/related', memoryRoutes.related);
    app.post('/api/memory/blocks/:id/retry', memoryRoutes.retryEmbedding);
    app.post('/api/memory/compact', memoryRoutes.enqueueCompaction);
  }

  // Phase 4 agent routes — only when the agent runtime is wired.
  const agents = dependencies.agents;
  if (agents !== undefined) {
    if (agents.workDocs !== undefined) {
      const workDocs = createWorkDocRoutes({ ...agents.workDocs, logger });
      app.get('/api/agents/:slug/work-docs', workDocs.list);
      app.post('/api/agents/:slug/work-docs', workDocs.create);
      app.get('/api/agents/:slug/work-docs/:id', workDocs.getDoc);
      app.patch('/api/agents/:slug/work-docs/:id', workDocs.patchDoc);
      app.post('/api/agents/:slug/work-docs/:id/versions', workDocs.postVersion);
      app.get('/api/agents/:slug/work-docs/:id/versions', workDocs.listVersions);
      app.get('/api/agents/:slug/work-docs/:id/versions/:version', workDocs.getVersion);
      app.post('/api/agents/:slug/work-docs/:id/rollback', workDocs.rollback);
      app.get('/api/agents/:slug/work-docs/:id/revisions', workDocs.listRevisions);
      app.post('/api/agents/:slug/work-docs/:id/links', workDocs.addLink);
      app.get('/api/agents/:slug/work-docs/:id/links', workDocs.listLinks);
    }
    if (agents.delegations !== undefined) {
      const delegations = agents.delegations;
      app.post('/api/agents/:slug/delegations', delegations.create);
      app.get('/api/agents/:slug/delegations', delegations.list);
      app.get('/api/agents/:slug/delegations/:delegationId', delegations.detail);
      app.post('/api/agents/:slug/delegations/:delegationId/run', delegations.run);
    }
    if (agents.dataQuery !== undefined) {
      app.post('/api/agents/:slug/data/query', dataQueryRouteHandler(agents.dataQuery));
    }
  }

  // Phase 5 scheduler routes — only when the scheduler composition is wired.
  if (dependencies.scheduler !== undefined) {
    const scheduler = createSchedulerRoutes(dependencies.scheduler);
    app.post('/api/scheduler/tasks', scheduler.createTask);
    app.get('/api/scheduler/tasks', scheduler.listTasks);
    app.get('/api/scheduler/tasks/:id', scheduler.getTask);
    app.patch('/api/scheduler/tasks/:id', scheduler.patchTask);
    app.post('/api/scheduler/tasks/:id/activate', scheduler.activateTask);
    app.post('/api/scheduler/tasks/:id/pause', scheduler.pauseTask);
    app.post('/api/scheduler/tasks/:id/run', scheduler.runTask);
    app.post('/api/scheduler/tasks/:id/run-scheduled', scheduler.runScheduledOccurrence);
    app.get('/api/scheduler/executions', scheduler.listExecutions);
    app.get('/api/scheduler/executions/:id', scheduler.getExecution);
    app.post('/api/scheduler/executions/:id/retry', scheduler.retryExecution);
    app.post('/api/scheduler/executions/:id/run', scheduler.runExecution);
  }

  app.use((req: Request, res: Response) => {
    sendJsonError(res, 404, 'Not found.');
    void req;
  });

  // Final safe error handler: no stacks, no provider output.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, message } = safeErrorStatus(error);
    logger.error('unhandled-request-failure', error);
    sendJsonError(res, status, message);
  });

  return app;
}
