/**
 * `/api/settings` REST routes (authenticated): the per-user opt-in settings
 * surface. `GET` returns the current settings (an absent `UserSettings` row
 * is the safe opt-OUT default); `PATCH` upserts the single flag for the
 * SESSION owner only — a client can never target another user's settings
 * (the owner is resolved by the app-wide `requireOwner` gate and never
 * accepted from the body). Fixed safe 400/415/503 errors; values are never
 * echoed.
 */
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

import type { SettingsServiceLike } from './settings.js';
import { SettingsStoreUnavailableError } from './settings.js';
import type { SafeLogger } from '../logging.js';
import { ownerOf, AUTH_401_MESSAGE } from '../auth/owner.js';

/** Fixed safe 503 body for settings-store failures (no error details). */
export const SETTINGS_UNAVAILABLE_MESSAGE = 'User settings are temporarily unavailable.';

/** `PATCH /api/settings` body: exactly one boolean field. */
const settingsBodySchema = z.strictObject({
  personalMemoryEnabled: z.boolean(),
});

export interface SettingsRouteDeps {
  readonly settings: SettingsServiceLike;
  readonly logger: SafeLogger;
}

export interface SettingsRouteHandlers {
  readonly getSettings: RequestHandler;
  readonly patchSettings: RequestHandler;
}

function json(res: Response, status: number, body: unknown): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Maps a settings-store failure to its safe response; everything else logs. */
const respondToStoreFailure = (res: Response, error: unknown, logger: SafeLogger): void => {
  if (error instanceof SettingsStoreUnavailableError) {
    json(res, 503, { error: SETTINGS_UNAVAILABLE_MESSAGE });
    return;
  }
  logger.error('settings-store-failure', error);
  json(res, 503, { error: SETTINGS_UNAVAILABLE_MESSAGE });
};

export function createSettingsRoutes(deps: SettingsRouteDeps): SettingsRouteHandlers {
  const getSettings: RequestHandler = async (_req: Request, res: Response) => {
    const owner = ownerOf(res);
    if (owner === null) {
      json(res, 401, { error: AUTH_401_MESSAGE });
      return;
    }
    try {
      const settings = await deps.settings.get(owner.userId);
      json(res, 200, { settings: { personalMemoryEnabled: settings.personalMemoryEnabled } });
    } catch (error) {
      respondToStoreFailure(res, error, deps.logger);
    }
  };

  const patchSettings: RequestHandler = async (req: Request, res: Response) => {
    const owner = ownerOf(res);
    if (owner === null) {
      json(res, 401, { error: AUTH_401_MESSAGE });
      return;
    }
    if (!req.is('application/json')) {
      json(res, 415, { error: 'Content-Type must be application/json.' });
      return;
    }
    const body = settingsBodySchema.safeParse(req.body);
    if (!body.success) {
      json(res, 400, { error: 'Settings must be exactly { personalMemoryEnabled: boolean }.' });
      return;
    }
    try {
      const settings = await deps.settings.setPersonalMemoryEnabled(owner.userId, body.data.personalMemoryEnabled);
      json(res, 200, { settings: { personalMemoryEnabled: settings.personalMemoryEnabled } });
    } catch (error) {
      respondToStoreFailure(res, error, deps.logger);
    }
  };

  return { getSettings, patchSettings };
}
