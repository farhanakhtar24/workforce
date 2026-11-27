/**
 * `GET /api/usage/hourly` (authenticated): the caller's OWN rolling 60-minute
 * budget window — request/cost counters, remaining values (clamped at 0),
 * next rolling expiry, per-model buckets, and honest settlement state. No
 * account-wide/shared-key spend, no secrets, no other user's data.
 */
import type { RequestHandler } from 'express';

import type { HourlyBudgetService } from './hourly-budget.js';
import { ownerOf } from '../auth/owner.js';

export const HOURLY_USAGE_UNAVAILABLE = 'Hourly usage is temporarily unavailable.';

export interface HourlyUsageRouteDeps {
  readonly budget: HourlyBudgetService;
  readonly logger: { error(message: string, error?: unknown): void };
}

export interface HourlyUsageRouteHandlers {
  readonly getHourlyUsage: RequestHandler;
}

export function createHourlyUsageRoutes(deps: HourlyUsageRouteDeps): HourlyUsageRouteHandlers {
  const getHourlyUsage: RequestHandler = async (_req, res) => {
    const owner = ownerOf(res);
    if (owner === null) {
      res.status(401);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Authentication required.' }));
      return;
    }
    try {
      const summary = await deps.budget.summarize(owner.userId);
      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(summary));
    } catch (error) {
      deps.logger.error('hourly-usage-read', error);
      res.status(503);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: HOURLY_USAGE_UNAVAILABLE }));
    }
  };

  return { getHourlyUsage };
}
