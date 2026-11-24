/**
 * Recurrence engine: strict (recurrenceType, recurrenceConfig) pairing,
 * deterministic cron-expression generation, and next-run computation in UTC.
 *
 * ## No hand-rolled cron
 * Cron parsing, range validation, and occurrence finding are delegated to the
 * `croner` dependency — the ONLY cron logic in this package. This module adds:
 * - the Phase 5 structural rules (exactly 5 whitespace-separated fields,
 *   <=200 characters) on top of croner's own validation (`mode: '5-part'`
 *   re-asserts the field count inside croner itself), and
 * - a bounded skip-date iteration: at most {@link MAX_RECURRENCE_ITERATIONS}
 *   occurrences (>= the 366 spec floor) are examined; a skipped candidate
 *   jumps the iterator to the END of that UTC day in ONE step, so even an
 *   every-minute pattern with 366 consecutive skipped days stays inside the
 *   bound. When the bound is reached (or croner reports exhaustion) the next
 *   run is `null`.
 *
 * ## Determinism
 * `computeNextRunAt` is a pure function of (type, config, after, skipDates):
 * same inputs — same output. All computation happens in UTC (`timezone: 'UTC'`
 * is fixed), which makes the whole domain DST-free by construction. `ONCE`
 * returns `null` when `after` has reached `runAt` (inclusive); recurring
 * schedules return the first occurrence strictly AFTER the supplied instant.
 */

import { Cron } from 'croner';

import {
  CRON_FIELD_COUNT,
  MAX_CRON_EXPRESSION_LENGTH,
  MAX_RECURRENCE_ITERATIONS,
  type RecurrenceType,
} from './kinds.js';
import { SchedulerValidationError } from './errors.js';
import type { AgentTaskRecurrenceConfig } from './types.js';

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether `value` is a REAL UTC calendar date (`2026-02-30` is rejected;
 * `2028-02-29` — a leap day — is accepted). Shape is checked by the schema
 * regex; this guard checks the calendar itself.
 */
export function isRealUtcCalendarDate(value: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  );
}

/** `YYYY-MM-DD` key of any instant under UTC (DST-free by construction). */
export function utcDateKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** `23:59:59.999Z` of the candidate's UTC day (bound for skip jumps). */
export function endOfUtcDay(instant: Date): Date {
  const key = utcDateKey(instant);
  const match = CALENDAR_DATE_PATTERN.exec(key);
  if (!match) {
    throw new Error(`internal: invalid UTC date key ${key}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
}

function keysOf(value: unknown): readonly string[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort();
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length) {
    return false;
  }
  return actual.every((key, index) => key === sorted[index]);
}

function isBoundedInteger(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function parseRunAt(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isUniqueIntegers(value: unknown, min: number, max: number): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  const seen = new Set<number>();
  for (const entry of value) {
    if (!isBoundedInteger(entry, min, max)) {
      return false;
    }
    seen.add(entry);
  }
  return seen.size === value.length;
}

/**
 * Whether `config` carries EXACTLY the shape selected by `recurrenceType`
 * (no missing keys, no arbitrary keys). Purely structural: cron expressions
 * are additionally validated by {@link validateCronExpression}.
 */
export function recurrenceConfigMatchesType(
  recurrenceType: RecurrenceType,
  recurrenceConfig: unknown,
): boolean {
  if (typeof recurrenceConfig !== 'object' || recurrenceConfig === null || Array.isArray(recurrenceConfig)) {
    return false;
  }
  const keys = keysOf(recurrenceConfig);
  if (keys === null) {
    return false;
  }
  switch (recurrenceType) {
    case 'ONCE':
      if (!sameKeys(keys, ['runAt'])) {
        return false;
      }
      return parseRunAt((recurrenceConfig as { runAt: unknown }).runAt) !== null;
    case 'DAILY': {
      if (!sameKeys(keys, ['hour', 'minute'])) {
        return false;
      }
      const config = recurrenceConfig as { hour: unknown; minute: unknown };
      return isBoundedInteger(config.hour, 0, 23) && isBoundedInteger(config.minute, 0, 59);
    }
    case 'WEEKLY': {
      if (!sameKeys(keys, ['hour', 'minute', 'weekdays'])) {
        return false;
      }
      const config = recurrenceConfig as { hour: unknown; minute: unknown; weekdays: unknown };
      return (
        isBoundedInteger(config.hour, 0, 23) &&
        isBoundedInteger(config.minute, 0, 59) &&
        isUniqueIntegers(config.weekdays, 0, 6)
      );
    }
    case 'MONTHLY': {
      if (!sameKeys(keys, ['hour', 'minute', 'daysOfMonth'])) {
        return false;
      }
      const config = recurrenceConfig as { hour: unknown; minute: unknown; daysOfMonth: unknown };
      return (
        isBoundedInteger(config.hour, 0, 23) &&
        isBoundedInteger(config.minute, 0, 59) &&
        isUniqueIntegers(config.daysOfMonth, 1, 31)
      );
    }
    case 'CUSTOM_CRON': {
      if (!sameKeys(keys, ['expression'])) {
        return false;
      }
      const expression = (recurrenceConfig as { expression: unknown }).expression;
      return isWellFormedCronExpression(expression);
    }
    default:
      return false;
  }
}

/** Structural cron checks the schema and this engine agree on. */
function isWellFormedCronExpression(value: unknown): boolean {
  // Schema-level content validation is done by croner; see validateCronExpression.
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CRON_EXPRESSION_LENGTH) {
    return false;
  }
  return trimmed.split(/\s+/).length === CRON_FIELD_COUNT;
}

/**
 * Deterministic 5-field cron expression generated from a validated config.
 * `ONCE` has no recurring pattern (null) — its next run is just `runAt`.
 * Lists are sorted ascending so generation is pure: same config, same string.
 * Weekday numbers are cron semantics: 0 = Sunday .. 6 = Saturday.
 */
export function cronExpressionForRecurrence(
  recurrenceType: RecurrenceType,
  recurrenceConfig: AgentTaskRecurrenceConfig,
): string | null {
  // Callers guarantee the config matches the type (assertRecurrencePair /
  // computeNextRunAt); the casts below only recover the per-type shape that
  // the external union parameter cannot narrow.
  switch (recurrenceType) {
    case 'ONCE':
      return null;
    case 'DAILY': {
      const config = recurrenceConfig as { hour: number; minute: number };
      return `${config.minute} ${config.hour} * * *`;
    }
    case 'WEEKLY': {
      const config = recurrenceConfig as { hour: number; minute: number; weekdays: readonly number[] };
      const weekdays = [...config.weekdays].sort((a, b) => a - b);
      return `${config.minute} ${config.hour} * * ${weekdays.join(',')}`;
    }
    case 'MONTHLY': {
      const config = recurrenceConfig as { hour: number; minute: number; daysOfMonth: readonly number[] };
      const days = [...config.daysOfMonth].sort((a, b) => a - b);
      return `${config.minute} ${config.hour} ${days.join(',')} * *`;
    }
    case 'CUSTOM_CRON':
      return (recurrenceConfig as { expression: string }).expression;
    default:
      throw new Error(`no cron mapping for recurrence type ${recurrenceType}`);
  }
}

/**
 * Validate a custom cron expression: 5 whitespace-separated fields, at most
 * {@link MAX_CRON_EXPRESSION_LENGTH} characters, and parseable by croner
 * (`mode: '5-part'` re-asserts the field count). Throws the typed scheduler
 * validation error (400 shape); the message never echoes the expression.
 */
export function validateCronExpression(expression: string): void {
  if (!isWellFormedCronExpression(expression)) {
    throw new SchedulerValidationError(
      `cron expression must have exactly ${CRON_FIELD_COUNT} whitespace-separated fields and be at most ${MAX_CRON_EXPRESSION_LENGTH} characters`,
    );
  }
  try {
    new Cron(expression, { timezone: 'UTC', mode: '5-part' });
  } catch (cause) {
    // croner throws CronError/RangeError/TypeError; wrap ALL of them so
    // routes can only ever see the typed validation error (400).
    throw new SchedulerValidationError('cron expression rejected by the cron engine', { cause });
  }
}

/**
 * Compute the next run AFTER `after` (defaults to now) for a validated
 * recurrence.
 *
 * - `ONCE`: `null` when `after >= runAt` (inclusive — the instant has passed),
 *   else `runAt`.
 * - Recurring schedules: first croner occurrence strictly AFTER `after`
 *   (occurrences are minute-aligned — croner strips milliseconds) whose UTC
 *   calendar day is NOT in `skipDates`. `null` once the bounded
 *   {@link MAX_RECURRENCE_ITERATIONS} examination cap is exhausted or croner
 *   reports no further occurrence.
 * - Invalid cron (shape or engine) throws `Error`; call routes wrap it into
 *   the typed scheduler validation error (the service and both stores do).
 *
 * `skipDates` entries MUST be validated `YYYY-MM-DD` strings upstream (the
 * schema guarantees it; this function only consumes them).
 */
export function computeNextRunAt(options: {
  recurrenceType: RecurrenceType;
  recurrenceConfig: AgentTaskRecurrenceConfig;
  after: Date;
  skipDates: readonly string[];
}): Date | null {
  const { recurrenceType, recurrenceConfig, after, skipDates } = options;
  if (!recurrenceConfigMatchesType(recurrenceType, recurrenceConfig)) {
    throw new SchedulerValidationError('recurrenceConfig shape does not match recurrenceType');
  }
  if (Number.isFinite(after.getTime()) === false) {
    throw new SchedulerValidationError('after must be a finite instant');
  }

  if (recurrenceType === 'ONCE') {
    const config = recurrenceConfig as { runAt: string };
    const runAt = new Date(config.runAt);
    // Inclusive after-edge: a runAt exactly AT the supplied instant is past.
    return after.getTime() >= runAt.getTime() ? null : runAt;
  }

  const expression = cronExpressionForRecurrence(recurrenceType, recurrenceConfig);
  if (expression === null) {
    return null;
  }
  validateCronExpression(expression);

  let schedule: Cron;
  try {
    schedule = new Cron(expression, { timezone: 'UTC', mode: '5-part' });
  } catch (cause) {
    // Unreachable when validateCronExpression passed; defensive typed wrap.
    throw new SchedulerValidationError('cron expression rejected by the cron engine on construction', { cause });
  }

  const skipSet = new Set(skipDates);
  const iterator = schedule.enumerate(after);
  for (let examined = 0; examined < MAX_RECURRENCE_ITERATIONS; examined += 1) {
    const step = iterator.next();
    if (step.done || step.value === undefined) {
      return null;
    }
    const candidate: Date = step.value;
    if (!skipSet.has(utcDateKey(candidate))) {
      return candidate;
    }
    // Skip the candidate's WHOLE UTC day in one jump; the next() call after
    // the reset yields the first run strictly after end-of-day.
    iterator.reset(endOfUtcDay(candidate));
  }
  return null;
}
