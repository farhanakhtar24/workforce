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
import {
  AUTH_MOUNT_PATTERN,
  createAuthExpressHandler,
  type ProviderAvailability,
  type WorkforceAuth,
} from './auth/index.js';
import { createRequireOwner, type StaticOwnerInjection } from './auth/owner.js';
import { createModelsRoutes, type ModelsRouteDeps } from './models/routes.js';
import type { ModelCatalogLike } from './models/catalog.js';
import { createSettingsRoutes } from './settings/routes.js';
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
  /**
   * Pre-Phase 6 authentication: real deps (Better Auth instance + allowlist +
   * provider availability) or a test-only static owner injection. ABSENT →
   * every gated route fail-closes to fixed 401 (production wiring always
   * supplies the real form).
   */
  auth?: AppAuthDeps;
  /**
   * Pre-Phase 6 model composition (catalog + runtime factory + default). When
   * absent: every chat generation uses the injected single `model` (exact
   * legacy/mock behavior) and the model/usage/catalog routes are absent.
   */
  models?: {
    readonly catalog: ModelCatalogLike;
    readonly modelFor: (modelId: string) => CreateChatTurnStreamOptions['model'];
    readonly defaultModelId: string;
  };
  /**
   * Pre-Phase 6 per-user settings (`/api/settings`). When absent the routes
   * are absent (404). Production wiring always supplies it.
   */
  settings?: import('./settings/settings.js').SettingsServiceLike;
  /**
   * Pre-Phase 6 opt-in personal memory (capture/recall/purge). When absent:
   * ZERO capture, ZERO recall, ZERO purge; no chat behavior change.
   */
  personal?: import('./http/routes.js').ChatRoutesDeps['personal'];
}

/**
 * Real authentication deps (production `server.ts` wiring) or a test-only
 * static owner injection. `staticOwner` callers inject tests through
 * `buildApp` deps, never through a production bypass.
 */
export interface AuthRouteDeps {
  readonly auth: WorkforceAuth;
  readonly emailAllowlist: readonly string[];
  readonly signer?: DelegationContextSigner;
  /** Safe provider availability (`GET /api/auth/providers` booleans only). */
  readonly providerAvailability: ProviderAvailability;
}

export type AppAuthDeps = AuthRouteDeps | StaticOwnerInjection;

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
 * `Access-Control-Allow-Origin` — NEVER a wildcard, because Better Auth
 * session cookies require `credentials: true` — with
 * `Access-Control-Allow-Credentials: true`, and `Idempotency-Key` is both
 * allowed as a request header and exposed as a response header. Preflight is
 * answered here before the auth handler sees the request.
 */
export function corsMiddleware(config: Pick<ApiConfig, 'webOrigin'>): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin === config.webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
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

  // CORS FIRST: the single Next origin (ADR-005) with credentials enabled
  // (Better Auth session cookies ride on cross-origin XHR) — never a
  // wildcard `*` with credentials. Preflight is answered here, before the
  // auth handler so OPTIONS for /api/auth/* carries the CORS headers.
  app.use(corsMiddleware({ webOrigin: dependencies.config.webOrigin }));

  const chatRoutes = createChatRoutes({
    config: dependencies.config,
    store: dependencies.store,
    streamContext: dependencies.streamContext,
    model: dependencies.model,
    background: dependencies.background,
    logger,
    models: dependencies.models,
    personal: dependencies.personal,
    agents:
      dependencies.agents !== undefined
        ? { hostDeps: dependencies.agents.hostDeps, signer: dependencies.agents.signer }
        : undefined,
  });
  const { health, hydration, postChat, resumeStream, deleteChat, branchChat, rewindChat, getModel, setModel, usage } = chatRoutes;

  // PUBLIC: unauthenticated liveness only.
  app.get('/health', health);

  // -- Pre-Phase 6 authentication mount (BEFORE express.json) --------------
  // The Better Auth handler must read the raw request stream, so it goes
  // above the JSON body parser (official Express integration contract).
  const authDeps = dependencies.auth;
  const realAuth = authDeps !== undefined && 'auth' in authDeps ? (authDeps as AuthRouteDeps) : null;
  const testOwner = authDeps !== undefined && 'staticOwner' in authDeps ? authDeps : null;
  if (realAuth !== null) {
    // PUBLIC: safe booleans only (never credentials, never Ollama usage).
    const availability = realAuth.providerAvailability;
    app.get('/api/auth/providers', (_req: Request, res: Response) => {
      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        JSON.stringify({
          google: availability.google.available === true,
          github: availability.github.available === true,
        }),
      );
    });
    app.all(AUTH_MOUNT_PATTERN, createAuthExpressHandler(realAuth.auth));
  }

  app.use(express.json({ limit: '256kb' }));

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

  // -- WORKER-ONLY scheduler run routes (before the browser owner gate) ----
  // These are NOT browser surfaces: the handlers enforce their OWN stricter
  // internal contract inside routes.ts (worker convention header + SIGNED
  // `internal-scheduler-run` context bound to taskId/executionId; anything
  // forged/missing/unsigned is rejected there). They are mounted AFTER the
  // JSON body parser and BEFORE the requireOwner gate, so REAL signed worker
  // calls never hit the browser-session resolver (a session-less production
  // middleware would 401 them) while the gate keeps covering every browser
  // route.
  const schedulerRoutes = dependencies.scheduler !== undefined ? createSchedulerRoutes(dependencies.scheduler) : null;
  if (schedulerRoutes !== null) {
    app.post('/api/scheduler/tasks/:id/run-scheduled', schedulerRoutes.runScheduledOccurrence);
    app.post('/api/scheduler/executions/:id/run', schedulerRoutes.runExecution);
  }

  // -- Owner gate for every non-public route -------------------------------
  // Fail-closed: real deps resolve sessions (fixed 401/403/400); testOwner
  // injection is buildApp-deps-only; ABSENT deps install a sentinel static
  // owner with an EMPTY user id, which `ownerOf` rejects everywhere — so
  // every gated route still answers the same fixed 401.
  const requireOwner = createRequireOwner(
    realAuth !== null
      ? {
          auth: realAuth.auth,
          emailAllowlist: realAuth.emailAllowlist,
          signer: realAuth.signer,
          logger,
        }
      : { staticOwner: testOwner !== null ? testOwner.staticOwner : { userId: '', email: '', emailVerified: false } },
  );
  app.use(requireOwner);

  app.post('/api/agents/:slug/chat', postChat);
  app.get('/api/agents/:slug/chat/:clientChatId', hydration);
  app.get('/api/agents/:slug/chat/:clientChatId/stream', resumeStream);
  // Owner-scoped chat mutations (pre-Phase 6 lifecycle): all behind the
  // requireOwner gate above; artifact rows (WorkDocs/Delegations/AgentTasks)
  // survive by contract; the destructive rew/indel writes are documented in
  // src/store/redis.ts + README.
  app.delete('/api/agents/:slug/chat/:clientChatId', deleteChat);
  app.post('/api/agents/:slug/chat/:clientChatId/branch', branchChat);
  app.post('/api/agents/:slug/chat/:clientChatId/rewind', rewindChat);
  // Pre-Phase 6 model composition: per-chat model selection (next-generation
  // apply), provenance via hydration, and the authenticated usage/cost read.
  // Catalog routes only when the composition is wired.
  if (dependencies.models !== undefined) {
    const modelRouteDeps: ModelsRouteDeps = {
      catalog: dependencies.models.catalog,
      defaultModelId: dependencies.models.defaultModelId,
      // Details pricing: ONLY the explicitly configured per-million rates.
      modelPricing: dependencies.config.modelPricing,
    };
    const modelsRoutes = createModelsRoutes(modelRouteDeps);
    app.get('/api/models', modelsRoutes.listModels);
    app.get('/api/models/:modelId/details', modelsRoutes.modelDetails);
    app.get('/api/agents/:slug/chat/:clientChatId/model', getModel);
    app.put('/api/agents/:slug/chat/:clientChatId/model', setModel);
  }
  // Token/cost usage needs ONLY the store + config pricing (works with or
  // without the catalog composition).
  app.get('/api/agents/:slug/chat/:clientChatId/usage', usage);

  // Recent-chat sidebar history (Phase 6 UX) — mounted with the store every
  // composition provides; legacy chats flow through the store's own
  // bounded discovery. Safe 400/503 handling lives in the route module.
  app.get('/api/chats', createChatListRoute({ store: dependencies.store, logger }).listChats);

  // Pre-Phase 6 per-user opt-in settings (GET/PATCH /api/settings) — only
  // when the settings service is wired (production always; absent → 404).
  if (dependencies.settings !== undefined) {
    const settingsRoutes = createSettingsRoutes({ settings: dependencies.settings, logger });
    app.get('/api/settings', settingsRoutes.getSettings);
    app.patch('/api/settings', settingsRoutes.patchSettings);
  }

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

  // Phase 5 scheduler routes — only when the scheduler composition is wired
  // (the SAME instance the worker-only run routes use; one run service).
  if (schedulerRoutes !== null) {
    app.post('/api/scheduler/tasks', schedulerRoutes.createTask);
    app.get('/api/scheduler/tasks', schedulerRoutes.listTasks);
    app.get('/api/scheduler/tasks/:id', schedulerRoutes.getTask);
    app.patch('/api/scheduler/tasks/:id', schedulerRoutes.patchTask);
    app.post('/api/scheduler/tasks/:id/activate', schedulerRoutes.activateTask);
    app.post('/api/scheduler/tasks/:id/pause', schedulerRoutes.pauseTask);
    app.post('/api/scheduler/tasks/:id/run', schedulerRoutes.runTask);
    app.get('/api/scheduler/executions', schedulerRoutes.listExecutions);
    app.get('/api/scheduler/executions/:id', schedulerRoutes.getExecution);
    app.post('/api/scheduler/executions/:id/retry', schedulerRoutes.retryExecution);
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
