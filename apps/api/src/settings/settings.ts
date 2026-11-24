/**
 * Per-user settings (pre-Phase 6 opt-in personal memory): one row per user
 * in the `UserSettings` table (pre-Phase-6 auth migration) with an explicit
 * opt-in flag. Absent row => `personalMemoryEnabled: false` (opt-OUT
 * default) — nothing is captured or recalled before the user turns the
 * setting ON via `PATCH /api/settings`.
 *
 * The service is deliberately tiny: it owns ONLY the two operations the API
 * needs (read-current, upsert-flag), validates the owner id shape, and maps
 * store failures to typed availability errors the route maps to the fixed
 * safe 503. Values are never logged or echoed.
 */
import { Prisma } from '@workforce/core/generated/prisma';
import type { PrismaClient } from '@workforce/core/generated/prisma';

/** The app-wide chat-owner id contract (same shape everywhere). */
const OWNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The full authenticated settings surface today. */
export interface UserSettingsData {
  /** Explicit opt-in for personal learning from prior chats (default false). */
  readonly personalMemoryEnabled: boolean;
}

/** Thrown on a settings-store failure (route maps to the fixed safe 503). */
export class SettingsStoreUnavailableError extends Error {
  constructor() {
    super('User settings are temporarily unavailable.');
    this.name = 'SettingsStoreUnavailableError';
  }
}

export interface SettingsServiceLike {
  /** Current settings for the owner; an absent row is the safe default. */
  get(ownerId: string): Promise<UserSettingsData>;
  /** Upserts the single opt-in flag (per-owner only; row created lazily). */
  setPersonalMemoryEnabled(ownerId: string, enabled: boolean): Promise<UserSettingsData>;
}

function assertOwnerId(ownerId: string): string {
  if (typeof ownerId !== 'string' || OWNER_ID_PATTERN.test(ownerId) === false) {
    throw new SettingsStoreUnavailableError();
  }
  return ownerId;
}

export interface PrismaSettingsServiceOptions {
  /** Injectable clock (tests); defaults to `new Date()`. */
  readonly now?: () => Date;
}

export function createPrismaSettingsService(
  prisma: PrismaClient,
  options: PrismaSettingsServiceOptions = {},
): SettingsServiceLike {
  const now = options.now ?? (() => new Date());
  async function get(ownerId: string): Promise<UserSettingsData> {
    const id = assertOwnerId(ownerId);
    try {
      const row = await prisma.userSettings.findUnique({ where: { userId: id }, select: { personalMemoryEnabled: true } });
      return { personalMemoryEnabled: row?.personalMemoryEnabled === true };
    } catch {
      throw new SettingsStoreUnavailableError();
    }
  }
  async function setPersonalMemoryEnabled(ownerId: string, enabled: boolean): Promise<UserSettingsData> {
    const id = assertOwnerId(ownerId);
    if (typeof enabled !== 'boolean') {
      throw new SettingsStoreUnavailableError();
    }
    try {
      await prisma.userSettings.upsert({
        where: { userId: id },
        update: { personalMemoryEnabled: enabled, updatedAt: now() },
        create: { userId: id, personalMemoryEnabled: enabled },
      });
      return { personalMemoryEnabled: enabled };
    } catch (error) {
      // A concurrent upsert race (unique constraint) still lands one row: the
      // outcome equals the upsert either way; only true store faults map to
      // the typed unavailable error.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { personalMemoryEnabled: enabled };
      }
      throw new SettingsStoreUnavailableError();
    }
  }
  return { get, setPersonalMemoryEnabled };
}
