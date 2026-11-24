/**
 * Personal memory setting helpers (Farhan's request C) against the
 * authenticated `GET|PATCH /api/settings` routes. The PATCH body is strict
 * `{ personalMemoryEnabled: boolean }` and the row is resolved from the
 * session server-side — a client can never target another user's settings.
 */

import { browserApiFetch, requestAuthError } from './api';

export const SETTINGS_FALLBACK_ERROR = 'User settings are temporarily unavailable.';

export interface WorkspaceSettings {
  personalMemoryEnabled: boolean;
}

export type SettingsResult =
  | { ok: true; settings: WorkspaceSettings }
  | { ok: false; error: string; status: number };

export function settingsEndpoint(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/settings`;
}

export function mapSettings(payload: unknown): SettingsResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: SETTINGS_FALLBACK_ERROR, status: 502 };
  }
  // Real wire shape: `{ settings: { personalMemoryEnabled: boolean } }`. The
  // settings object is REQUIRED; flat/legacy shapes are malformed and fail
  // safely with the existing fixed error — no fallbacks, ever.
  const settings = (payload as Record<string, unknown>)['settings'];
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, error: SETTINGS_FALLBACK_ERROR, status: 502 };
  }
  const enabled = (settings as Record<string, unknown>)['personalMemoryEnabled'];
  if (typeof enabled !== 'boolean') {
    return { ok: false, error: SETTINGS_FALLBACK_ERROR, status: 502 };
  }
  return { ok: true, settings: { personalMemoryEnabled: enabled } };
}

export async function fetchSettings(options: { apiBaseUrl: string }): Promise<SettingsResult> {
  try {
    const response = await browserApiFetch(settingsEndpoint(options.apiBaseUrl), {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      const authError = requestAuthError(response.status ?? 0);
      if (authError !== null) return { ok: false, error: authError, status: response.status ?? 0 };
      return { ok: false, error: SETTINGS_FALLBACK_ERROR, status: response.status ?? 0 };
    }
    return mapSettings(await response.json());
  } catch {
    return { ok: false, error: SETTINGS_FALLBACK_ERROR, status: 0 };
  }
}

export async function patchPersonalMemory(options: {
  apiBaseUrl: string;
  personalMemoryEnabled: boolean;
}): Promise<SettingsResult> {
  try {
    const response = await browserApiFetch(settingsEndpoint(options.apiBaseUrl), {
      method: 'PATCH',
      cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ personalMemoryEnabled: options.personalMemoryEnabled }),
    });
    if (!response.ok) {
      const authError = requestAuthError(response.status ?? 0);
      if (authError !== null) return { ok: false, error: authError, status: response.status ?? 0 };
      return { ok: false, error: SETTINGS_FALLBACK_ERROR, status: response.status ?? 0 };
    }
    return mapSettings(await response.json());
  } catch {
    return { ok: false, error: SETTINGS_FALLBACK_ERROR, status: 0 };
  }
}

/** Exactly the requested copy (concise explanation + scope honesty). */
export const PERSONAL_MEMORY_EXPLANATION =
  'When enabled, Workforce stores durable observations from completed chats and may use up to 3 relevant memories as untrusted context. Off by default.';
export const PERSONAL_MEMORY_SCOPE_NOTE =
  'Applies to completed turns after you enable it — nothing is imported retroactively.';
