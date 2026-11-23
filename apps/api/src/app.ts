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
import { createMemoryRoutes, type MemoryRouteDeps } from './memory/routes.js';
import { sendJsonError } from './http/adapter.js';
import { safeErrorStatus } from './errors.js';

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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  });
  const { health, hydration, postChat, resumeStream } = chatRoutes;

  app.get('/health', health);
  app.post('/api/agents/:slug/chat', postChat);
  app.get('/api/agents/:slug/chat/:clientChatId', hydration);
  app.get('/api/agents/:slug/chat/:clientChatId/stream', resumeStream);

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
