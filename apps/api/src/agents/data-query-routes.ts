/**
 * `query_data` REST route (Phase 4): `POST /api/agents/:slug/data/query` with
 * `{ query, limit? }`.
 *
 * - Served ONLY for the slugs whose composition includes `query_data`
 *   (orchestrator, analyst); every other slug 404s like an unknown agent.
 * - One SELECT/WITH statement, read-only transaction, statement timeout, row
 *   cap (`cap + 1` detection → fixed 400), optional client-side `limit`
 *   truncation reported as `truncated: true`.
 * - Errors are fixed safe strings: no SQL, no Postgres errors, no connection
 *   details ever reach the response body or logs.
 */
import type { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { dataQueryErrorStatus, type DataQueryService } from './data-query.js';

export const INVALID_DATA_QUERY = 'Invalid data query.';

/** Slugs whose composed toolset contains `query_data`. */
export const DATA_QUERY_SLUGS: readonly string[] = ['orchestrator', 'analyst'];

const bodySchema = z.strictObject({
  query: z
    .string({ message: 'query must be a string' })
    .min(1, 'query must not be empty')
    .max(20_000, 'query must be at most 20000 characters'),
  limit: z
    .number({ message: 'limit must be an integer between 1 and the row cap' })
    .int('limit must be an integer')
    .min(1, 'limit must be at least 1')
    .optional(),
});

export interface DataQueryRouteDeps {
  service: DataQueryService;
  /** Maximum `limit` the body may request (mirrors the service row cap). */
  rowCap: number;
}

export function dataQueryRouteHandler(deps: DataQueryRouteDeps): RequestHandler {
  return async (req: Request, res: Response, next: (error?: unknown) => void): Promise<void> => {
    try {
      const slug = req.params['slug'] ?? '';
      if (!DATA_QUERY_SLUGS.includes(slug)) {
        res.status(404);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Unknown agent slug.' }));
        return;
      }
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success || (parsed.data.limit !== undefined && parsed.data.limit > deps.rowCap)) {
        res.status(400);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: INVALID_DATA_QUERY }));
        return;
      }
      const { query, limit } = parsed.data;
      let result;
      try {
        result = await deps.service.query(query, limit);
      } catch (error) {
        const mapped = dataQueryErrorStatus(error);
        res.status(mapped.status);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: mapped.message }));
        return;
      }
      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated }));
    } catch (error: unknown) {
      next(error);
    }
  };
}
