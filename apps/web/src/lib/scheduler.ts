/**
 * Pure, testable client helpers for the Phase 5 schedule dashboard (`/schedules`).
 *
 * Contract source of truth: `apps/api/src/app.ts` route mounting +
 * `apps/api/src/scheduler/routes.ts` + `packages/core/src/scheduler/`
 * (kinds/schemas/types). The fixed API texts live in
 * `apps/api/src/scheduler/types.ts` and are surfaced verbatim through
 * `{ error }` bodies; everything else collapses to fixed local fallbacks.
 *
 * REST endpoints the dashboard may call (and the two it must NEVER call):
 * - POST   /api/scheduler/tasks                      create (201 { task }; 503 = row
 *          stands, queue sync failed — honest, refresh to see the row)
 * - GET    /api/scheduler/tasks?isActive=&limit=     list ({ tasks } ≤ 100)
 * - GET    /api/scheduler/tasks/:id                  detail ({ task, executions ≤ 10 })
 * - PATCH  /api/scheduler/tasks/:id                  update ({ task }; 503 as above)
 * - POST   /api/scheduler/tasks/:id/activate         setTaskActive(true) ({ task })
 * - POST   /api/scheduler/tasks/:id/pause            setTaskActive(false) ({ task })
 * - POST   /api/scheduler/tasks/:id/run              MANUAL run: NEW execution +
 *          enqueue; 202 { execution } (never calls run-scheduled / executions/:id/run —
 *          both are WORKER-ONLY routes the browser does not mint body metadata for)
 * - GET    /api/scheduler/executions?taskId=&status=&limit=   history ({ executions })
 * - GET    /api/scheduler/executions/:id             one row ({ execution })
 * - POST   /api/scheduler/executions/:id/retry       DEAD_LETTER only: NEW linked
 *          execution + NEW isolated chat; old audit stays immutable. 202
 *          { execution, retryOfExecutionId }.
 * FORBIDDEN for the browser: POST /api/scheduler/tasks/:id/run-scheduled and
 * POST /api/scheduler/executions/:id/run (worker-only; they carry BullMQ
 * occurrence metadata the client never mints). No builder for them exists here.
 *
 * All schedules run in UTC (core literal `timezone: 'UTC'`): minute precision —
 * no seconds, no other timezone. ONCE `runAt` arrives from a `datetime-local`
 * control and is converted to a UTC `Z` ISO instant (the input IS the UTC wall
 * clock; the API rejects any offset and this client never sends one).
 */
import { extractApiErrorMessage, formatDateTime, truncateMemoryText, UUID_PATTERN } from './memory';
import { isSafeChatId } from './api';
import {
  isAgentMode,
  isAgentSlug,
  type WebAgentMode,
  type WebAgentSlug,
} from './agents';

/* ------------------------------------------------------------------ */
/* Vocabulary + bounds (mirrors packages/core/src/scheduler/kinds.ts)  */
/* ------------------------------------------------------------------ */

export const SCHEDULER_RECURRENCE_TYPES = ['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM_CRON'] as const;
export type SchedulerRecurrenceType = (typeof SCHEDULER_RECURRENCE_TYPES)[number];

export const SCHEDULER_EXECUTION_STATUSES = [
  'PENDING',
  'RUNNING',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'DEAD_LETTER',
  'SKIPPED',
] as const;
export type SchedulerExecutionStatus = (typeof SCHEDULER_EXECUTION_STATUSES)[number];

export const SCHEDULER_EXECUTION_TRIGGERS = ['SCHEDULED', 'MANUAL', 'RETRY'] as const;
export type SchedulerExecutionTrigger = (typeof SCHEDULER_EXECUTION_TRIGGERS)[number];

export const SCHEDULER_LIST_LIMIT_MIN = 1;
export const SCHEDULER_LIST_LIMIT_MAX = 100;

export const AGENT_TASK_NAME_MAX = 200;
export const AGENT_TASK_PROMPT_MAX = 10000;
export const AGENT_TASK_SCOPE_MAX = 64;
export const AGENT_TASK_SCOPE_PATTERN = /^[a-z0-9_-]+$/;
export const CRON_FIELD_COUNT = 5;
export const CRON_EXPRESSION_MAX = 200;
export const MAX_SKIP_DATES = 366;
export const MAX_TOKEN_COUNT = 2147483647;

/** On-screen bound for execution error text (the API already caps at 1000). */
export const SCHEDULER_ERROR_DISPLAY_LIMIT = 280;

export function isSchedulerRecurrenceType(value: unknown): value is SchedulerRecurrenceType {
  return typeof value === 'string' && (SCHEDULER_RECURRENCE_TYPES as readonly string[]).includes(value);
}

export function isSchedulerExecutionStatus(value: unknown): value is SchedulerExecutionStatus {
  return typeof value === 'string' && (SCHEDULER_EXECUTION_STATUSES as readonly string[]).includes(value);
}

export function isSchedulerExecutionTrigger(value: unknown): value is SchedulerExecutionTrigger {
  return typeof value === 'string' && (SCHEDULER_EXECUTION_TRIGGERS as readonly string[]).includes(value);
}

/** Task/execution row ids (and `retryOfExecutionId`) are UUIDs. */
export function isSchedulerTaskId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/* ------------------------------------------------------------------ */
/* Structured shapes (client view of the core rows)                    */
/* ------------------------------------------------------------------ */

export interface SchedulerTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type SchedulerRecurrenceConfig =
  | { runAt: string }
  | { hour: number; minute: number }
  | { hour: number; minute: number; weekdays: number[] }
  | { hour: number; minute: number; daysOfMonth: number[] }
  | { expression: string };

export interface SchedulerTask {
  id: string;
  name: string;
  agentSlug: WebAgentSlug;
  mode: WebAgentMode;
  prompt: string;
  scope: string;
  recurrenceType: SchedulerRecurrenceType;
  recurrenceConfig: SchedulerRecurrenceConfig;
  skipDates: string[];
  isActive: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerExecution {
  id: string;
  taskId: string;
  scheduledFor: string;
  trigger: SchedulerExecutionTrigger;
  status: SchedulerExecutionStatus;
  attempt: number;
  maxAttempts: number;
  durationMs: number | null;
  tokenUsage: SchedulerTokenUsage | null;
  error: string | null;
  chatId: string;
  retryOfExecutionId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type SchedulerResult<T> = { ok: true; value: T } | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* Endpoints + page URL                                                 */
/* ------------------------------------------------------------------ */

export function schedulerTasksEndpoint(apiBaseUrl: string, query?: string): string {
  return `${apiBaseUrl}/api/scheduler/tasks${query ?? ''}`;
}

export function schedulerTaskEndpoint(apiBaseUrl: string, taskId: string): string {
  return `${apiBaseUrl}/api/scheduler/tasks/${encodeURIComponent(taskId)}`;
}

/** activate/pause/run actions (the ONLY POST task routes the UI calls). */
export function schedulerTaskActionEndpoint(
  apiBaseUrl: string,
  taskId: string,
  action: 'activate' | 'pause' | 'run',
): string {
  return `${schedulerTaskEndpoint(apiBaseUrl, taskId)}/${action}`;
}

export function schedulerExecutionsEndpoint(apiBaseUrl: string, query?: string): string {
  return `${apiBaseUrl}/api/scheduler/executions${query ?? ''}`;
}

export function schedulerExecutionEndpoint(apiBaseUrl: string, executionId: string): string {
  return `${apiBaseUrl}/api/scheduler/executions/${encodeURIComponent(executionId)}`;
}

export function schedulerExecutionRetryEndpoint(apiBaseUrl: string, executionId: string): string {
  return `${schedulerExecutionEndpoint(apiBaseUrl, executionId)}/retry`;
}

/** The dashboard's own page path (nav links). */
export function scheduleListPagePath(): string {
  return '/schedules';
}

/* ------------------------------------------------------------------ */
/* Query builders                                                       */
/* ------------------------------------------------------------------ */

export interface SchedulerTaskListFilters {
  isActive?: boolean;
  limit?: number;
}

export function buildSchedulerTasksQuery(filters: SchedulerTaskListFilters): string {
  const params = new URLSearchParams();
  if (filters.isActive === true) params.set('isActive', 'true');
  if (filters.isActive === false) params.set('isActive', 'false');
  if (
    typeof filters.limit === 'number' &&
    Number.isInteger(filters.limit) &&
    filters.limit >= SCHEDULER_LIST_LIMIT_MIN &&
    filters.limit <= SCHEDULER_LIST_LIMIT_MAX
  ) {
    params.set('limit', String(filters.limit));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

export interface SchedulerExecutionListFilters {
  taskId?: string;
  status?: string;
  limit?: number;
}

export function buildSchedulerExecutionsQuery(filters: SchedulerExecutionListFilters): string {
  const params = new URLSearchParams();
  if (isSchedulerTaskId(filters.taskId)) params.set('taskId', filters.taskId);
  if (isSchedulerExecutionStatus(filters.status)) params.set('status', filters.status);
  if (
    typeof filters.limit === 'number' &&
    Number.isInteger(filters.limit) &&
    filters.limit >= SCHEDULER_LIST_LIMIT_MIN &&
    filters.limit <= SCHEDULER_LIST_LIMIT_MAX
  ) {
    params.set('limit', String(filters.limit));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

/* ------------------------------------------------------------------ */
/* ONCE datetime-local → UTC ISO                                       */
/* ------------------------------------------------------------------ */

/** `<input type="datetime-local">` shape: date + HH:MM, optional :SS. NO zone suffix. */
const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Converts a datetime-local value into the UTC `Z` ISO instant all schedules
 * use (the control's wall clock IS UTC). Optional seconds are accepted but
 * always land on `:00` — the domain has minute precision. Returns `null` for
 * any other shape, non-real dates (2026-02-30) or out-of-range time parts.
 */
export function utcIsoFromDateTimeLocal(value: string): string | null {
  const match = DATETIME_LOCAL_PATTERN.exec(value);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (hour > 23 || minute > 59) return null;
  if (secondRaw !== undefined && Number(secondRaw) > 59) return null;
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }
  return `${yearRaw}-${monthRaw}-${dayRaw}T${hourRaw}:${minuteRaw}:00.000Z`;
}

/** datetime-local value of a UTC `Z` ISO instant (for the edit form). */
export function dateTimeLocalFromUtcIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  // The stored value IS UTC, so slicing the ISO string is exact.
  return instant.toISOString().slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* Recurrence config from form fields                                   */
/* ------------------------------------------------------------------ */

export interface SchedulerRecurrenceFormInput {
  recurrenceType?: string;
  /** ONCE: datetime-local value (interpreted as UTC). */
  runAt?: string;
  /** DAILY/WEEKLY/MONTHLY clock hour (string or number). */
  hour?: string | number;
  /** DAILY/WEEKLY/MONTHLY clock minute (string or number). */
  minute?: string | number;
  /** WEEKLY: selected weekday numbers 0..6 (strings from checkboxes). */
  weekdays?: readonly (string | number)[];
  /** MONTHLY: selected day-of-month numbers 1..31. */
  daysOfMonth?: readonly (string | number)[];
  /** CUSTOM_CRON: raw 5-field expression. */
  cronExpression?: string;
}

export type SchedulerRecurrenceFormResult =
  | { ok: true; recurrenceType: SchedulerRecurrenceType; recurrenceConfig: SchedulerRecurrenceConfig }
  | { ok: false; error: string };

function intFromField(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  return Number.parseInt(value.trim(), 10);
}

function uniqueNumbers(values: readonly (string | number)[] | undefined, min: number, max: number): number[] | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const seen = new Set<number>();
  for (const entry of values) {
    const parsed = intFromField(entry);
    if (parsed === null || parsed < min || parsed > max || seen.has(parsed)) return null;
    seen.add(parsed);
  }
  return [...seen];
}

/**
 * Builds the (recurrenceType, recurrenceConfig) pair the create/update
 * schemas demand — the config shape must match the type exactly. All fixed
 * safe errors; submitted values are never echoed.
 */
export function buildRecurrenceConfig(input: SchedulerRecurrenceFormInput): SchedulerRecurrenceFormResult {
  const type = input.recurrenceType;
  if (!isSchedulerRecurrenceType(type)) {
    return { ok: false, error: 'Choose a recurrence type.' };
  }
  if (type === 'ONCE') {
    const runAt = utcIsoFromDateTimeLocal(typeof input.runAt === 'string' ? input.runAt : '');
    if (runAt === null) {
      return {
        ok: false,
        error: 'Pick the UTC date and time to run (format YYYY-MM-DDTHH:MM, real calendar date, hour 0–23).',
      };
    }
    return { ok: true, recurrenceType: type, recurrenceConfig: { runAt } };
  }
  if (type === 'DAILY' || type === 'WEEKLY' || type === 'MONTHLY') {
    const hour = intFromField(input.hour);
    const minute = intFromField(input.minute);
    if (hour === null || minute === null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return { ok: false, error: 'Choose a UTC hour (0–23) and minute (0–59).' };
    }
    if (type === 'DAILY') {
      return { ok: true, recurrenceType: type, recurrenceConfig: { hour, minute } };
    }
    if (type === 'WEEKLY') {
      const weekdays = uniqueNumbers(input.weekdays, 0, 6);
      if (weekdays === null) {
        return { ok: false, error: 'Select at least one weekday (0 = Sunday … 6 = Saturday), none repeated.' };
      }
      return { ok: true, recurrenceType: type, recurrenceConfig: { hour, minute, weekdays } };
    }
    const daysOfMonth = uniqueNumbers(input.daysOfMonth, 1, 31);
    if (daysOfMonth === null) {
      return { ok: false, error: 'Select at least one day of the month (1–31), none repeated.' };
    }
    return { ok: true, recurrenceType: type, recurrenceConfig: { hour, minute, daysOfMonth } };
  }
  // CUSTOM_CRON
  const expression = typeof input.cronExpression === 'string' ? input.cronExpression.trim() : '';
  const fields = expression.split(/\s+/).filter((field) => field.length > 0);
  if (
    expression.length === 0 ||
    expression.length > CRON_EXPRESSION_MAX ||
    fields.length !== CRON_FIELD_COUNT
  ) {
    return {
      ok: false,
      error: `Cron expressions need exactly ${CRON_FIELD_COUNT} whitespace-separated fields and at most ${CRON_EXPRESSION_MAX} characters.`,
    };
  }
  return { ok: true, recurrenceType: type, recurrenceConfig: { expression } };
}

/* ------------------------------------------------------------------ */
/* Skip dates (comma/newline editor)                                    */
/* ------------------------------------------------------------------ */

const SKIP_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a REAL UTC calendar date (2026-02-30 is rejected). */
export function isSchedulerSkipDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = SKIP_DATE_PATTERN.exec(value);
  if (!match) return false;
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

export type SkipDatesResult = { ok: true; dates: string[] } | { ok: false; error: string };

/**
 * Parses the textarea value: entries separated by commas and/or new lines,
 * trimmed, empties dropped, deduplicated (first occurrence wins). All-or-
 * nothing: one invalid entry rejects the whole list with a safe fixed error.
 */
export function parseSkipDates(raw: string): SkipDatesResult {
  const entries = raw.split(/[,\n\r]+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const dates: string[] = [];
  for (const entry of entries) {
    if (!isSchedulerSkipDate(entry)) {
      return { ok: false, error: 'Skip dates must be real YYYY-MM-DD UTC calendar dates, separated by commas or new lines.' };
    }
    if (!dates.includes(entry)) dates.push(entry);
  }
  if (dates.length > MAX_SKIP_DATES) {
    return { ok: false, error: `A schedule can skip at most ${MAX_SKIP_DATES} dates.` };
  }
  return { ok: true, dates };
}

/** Textarea value for an existing task (deterministic order). */
export function formatSkipDates(dates: readonly string[]): string {
  return [...dates].sort().join(',\n');
}

function normalizeScope(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (trimmed.length === 0) return 'default';
  if (trimmed.length > AGENT_TASK_SCOPE_MAX || !AGENT_TASK_SCOPE_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/* ------------------------------------------------------------------ */
/* Create/update request bodies                                         */
/* ------------------------------------------------------------------ */

export interface SchedulerTaskFormInput extends SchedulerRecurrenceFormInput {
  name?: string;
  agentSlug?: string;
  mode?: string;
  prompt?: string;
  scope?: string;
  /** Raw textarea value (comma/newline separated). */
  skipDates?: string;
}

export type SchedulerCreateBodyResult =
  | {
      ok: true;
      body: {
        name: string;
        agentSlug: WebAgentSlug;
        mode: WebAgentMode;
        prompt: string;
        scope: string;
        recurrenceType: SchedulerRecurrenceType;
        recurrenceConfig: SchedulerRecurrenceConfig;
        skipDates: string[];
        timezone: 'UTC';
      };
    }
  | { ok: false; error: string };

export type SchedulerCreateBody = Extract<SchedulerCreateBodyResult, { ok: true }>['body'];

/**
 * POST /api/scheduler/tasks body — exactly the createTaskInputSchema fields.
 * `isActive` is NOT part of create (rows start active; activation/pause are
 * the dedicated routes), and `nextRunAt` is computed server-side.
 */
export function buildCreateTaskBody(input: SchedulerTaskFormInput): SchedulerCreateBodyResult {
  const name = (input.name ?? '').trim();
  if (name.length === 0 || name.length > AGENT_TASK_NAME_MAX) {
    return { ok: false, error: `Name must be 1–${AGENT_TASK_NAME_MAX} characters.` };
  }
  if (!isAgentSlug(input.agentSlug)) {
    return { ok: false, error: 'Choose an agent (general, orchestrator, analyst or researcher).' };
  }
  if (!isAgentMode(input.mode)) {
    return { ok: false, error: 'Choose a mode (plan or action).' };
  }
  const prompt = (input.prompt ?? '').trim();
  if (prompt.length === 0 || prompt.length > AGENT_TASK_PROMPT_MAX) {
    return { ok: false, error: `Prompt must be 1–${AGENT_TASK_PROMPT_MAX} characters.` };
  }
  const scope = normalizeScope(input.scope);
  if (scope === null) {
    return {
      ok: false,
      error: `Scope must be 1–${AGENT_TASK_SCOPE_MAX} lowercase letters, digits, underscores or dashes.`,
    };
  }
  const recurrence = buildRecurrenceConfig(input);
  if (!recurrence.ok) return recurrence;
  const skipDates = parseSkipDates(input.skipDates ?? '');
  if (!skipDates.ok) return skipDates;
  return {
    ok: true,
    body: {
      name,
      agentSlug: input.agentSlug,
      mode: input.mode,
      prompt,
      scope,
      recurrenceType: recurrence.recurrenceType,
      recurrenceConfig: recurrence.recurrenceConfig,
      skipDates: skipDates.dates,
      timezone: 'UTC',
    },
  };
}

export type SchedulerUpdateBodyResult =
  | {
      ok: true;
      body: {
        id: string;
        name: string;
        agentSlug: WebAgentSlug;
        mode: WebAgentMode;
        prompt: string;
        scope: string;
        recurrenceType: SchedulerRecurrenceType;
        recurrenceConfig: SchedulerRecurrenceConfig;
        skipDates: string[];
      };
    }
  | { ok: false; error: string };

export type SchedulerUpdateBody = Extract<SchedulerUpdateBodyResult, { ok: true }>['body'];

/**
 * PATCH /api/scheduler/tasks/:id body for the edit form: the full editable
 * field set (recurrenceType + recurrenceConfig always together). `id` comes
 * from the bound path, not the form. `isActive`/`nextRunAt` are never sent —
 * they belong to activate/pause and server-side recomputation.
 */
export function buildUpdateTaskBody(input: SchedulerTaskFormInput & { id: string }): SchedulerUpdateBodyResult {
  if (!isSchedulerTaskId(input.id)) {
    return { ok: false, error: 'A saved task is required to update it.' };
  }
  const created = buildCreateTaskBody(input);
  if (!created.ok) return created;
  const { name, agentSlug, mode, prompt, scope, recurrenceType, recurrenceConfig, skipDates } = created.body;
  return {
    ok: true,
    body: { id: input.id, name, agentSlug, mode, prompt, scope, recurrenceType, recurrenceConfig, skipDates },
  };
}

/* ------------------------------------------------------------------ */
/* Strict mappers                                                       */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reqString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function boundedInt(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** UTC `…Z` ISO instant like the API emits (`z.iso.datetime()`). */
function isUtcIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime());
}

function mapRecurrenceConfig(type: SchedulerRecurrenceType, raw: unknown): SchedulerRecurrenceConfig | null {
  if (!isPlainObject(raw)) return null;
  if (type === 'ONCE') {
    if (!sameKeys(raw, ['runAt']) || !isUtcIsoInstant(raw.runAt)) return null;
    return { runAt: raw.runAt };
  }
  if (type === 'DAILY') {
    if (!sameKeys(raw, ['hour', 'minute'])) return null;
    const hour = boundedInt(raw.hour, 0, 23);
    const minute = boundedInt(raw.minute, 0, 59);
    if (hour === null || minute === null) return null;
    return { hour, minute };
  }
  if (type === 'WEEKLY') {
    if (!sameKeys(raw, ['hour', 'minute', 'weekdays'])) return null;
    const hour = boundedInt(raw.hour, 0, 23);
    const minute = boundedInt(raw.minute, 0, 59);
    const weekdays = uniqueBoundedInts(raw.weekdays, 0, 6);
    if (hour === null || minute === null || weekdays === null) return null;
    return { hour, minute, weekdays };
  }
  if (type === 'MONTHLY') {
    if (!sameKeys(raw, ['hour', 'minute', 'daysOfMonth'])) return null;
    const hour = boundedInt(raw.hour, 0, 23);
    const minute = boundedInt(raw.minute, 0, 59);
    const daysOfMonth = uniqueBoundedInts(raw.daysOfMonth, 1, 31);
    if (hour === null || minute === null || daysOfMonth === null) return null;
    return { hour, minute, daysOfMonth };
  }
  // CUSTOM_CRON
  if (!sameKeys(raw, ['expression'])) return null;
  if (!reqString(raw.expression) || raw.expression.length > CRON_EXPRESSION_MAX) return null;
  const fields = raw.expression.trim().split(/\s+/).filter((field) => field.length > 0).length;
  if (fields !== CRON_FIELD_COUNT) return null;
  return { expression: raw.expression };
}

function sameKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function uniqueBoundedInts(value: unknown, min: number, max: number): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<number>();
  for (const entry of value) {
    const parsed = boundedInt(entry, min, max);
    if (parsed === null || seen.has(parsed)) return null;
    seen.add(parsed);
  }
  return [...seen];
}

/** Fixed safe mapper error (same text everywhere; never echoes payloads). */
export const SCHEDULER_MAP_ERROR = 'The scheduler returned data the dashboard cannot display safely. Refresh to retry.';

export function mapSchedulerTask(raw: unknown): SchedulerResult<SchedulerTask> {
  if (!isPlainObject(raw)) return { ok: false, error: SCHEDULER_MAP_ERROR };
  const recurrenceType = raw.recurrenceType;
  if (
    !isSchedulerTaskId(raw.id) ||
    !reqString(raw.name) ||
    !isAgentSlug(raw.agentSlug) ||
    !isAgentMode(raw.mode) ||
    !reqString(raw.prompt) ||
    raw.prompt.length > AGENT_TASK_PROMPT_MAX ||
    !reqString(raw.scope) ||
    !isSchedulerRecurrenceType(recurrenceType) ||
    raw.timezone !== 'UTC' ||
    typeof raw.isActive !== 'boolean' ||
    !Array.isArray(raw.skipDates) ||
    !raw.skipDates.every((entry) => isSchedulerSkipDate(entry)) ||
    new Set(raw.skipDates as string[]).size !== raw.skipDates.length ||
    !reqString(raw.createdAt) ||
    !reqString(raw.updatedAt) ||
    (raw.nextRunAt !== null && !isUtcIsoInstant(raw.nextRunAt))
  ) {
    return { ok: false, error: SCHEDULER_MAP_ERROR };
  }
  const recurrenceConfig = mapRecurrenceConfig(recurrenceType, raw.recurrenceConfig);
  if (recurrenceConfig === null) return { ok: false, error: SCHEDULER_MAP_ERROR };
  return {
    ok: true,
    value: {
      id: raw.id,
      name: raw.name,
      agentSlug: raw.agentSlug,
      mode: raw.mode,
      prompt: raw.prompt,
      scope: raw.scope,
      recurrenceType,
      recurrenceConfig,
      skipDates: [...(raw.skipDates as string[])],
      isActive: raw.isActive,
      nextRunAt: raw.nextRunAt === null ? null : (raw.nextRunAt as string),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    },
  };
}

export function mapSchedulerExecution(raw: unknown): SchedulerResult<SchedulerExecution> {
  if (!isPlainObject(raw)) return { ok: false, error: SCHEDULER_MAP_ERROR };
  const attempt = boundedInt(raw.attempt, 0, MAX_TOKEN_COUNT);
  const maxAttempts = boundedInt(raw.maxAttempts, 1, MAX_TOKEN_COUNT);
  if (
    !isSchedulerTaskId(raw.id) ||
    !isSchedulerTaskId(raw.taskId) ||
    !isUtcIsoInstant(raw.scheduledFor) ||
    !isSchedulerExecutionTrigger(raw.trigger) ||
    !isSchedulerExecutionStatus(raw.status) ||
    attempt === null ||
    maxAttempts === null ||
    (attempt !== 0 && attempt > maxAttempts) ||
    (raw.durationMs !== null && boundedInt(raw.durationMs, 0, MAX_TOKEN_COUNT) === null) ||
    (raw.error !== null && typeof raw.error !== 'string') ||
    typeof raw.chatId !== 'string' ||
    !isSafeChatId(raw.chatId) ||
    !isUtcIsoInstant(raw.createdAt) ||
    !isUtcIsoInstant(raw.updatedAt) ||
    (raw.finishedAt !== null && !isUtcIsoInstant(raw.finishedAt)) ||
    (raw.retryOfExecutionId !== null && !isSchedulerTaskId(raw.retryOfExecutionId)) ||
    (raw.queueJobId !== null && typeof raw.queueJobId !== 'string') ||
    (raw.repeatJobKey !== null && typeof raw.repeatJobKey !== 'string')
  ) {
    return { ok: false, error: SCHEDULER_MAP_ERROR };
  }
  let tokenUsage: SchedulerTokenUsage | null = null;
  if (raw.tokenUsage !== null) {
    if (!isPlainObject(raw.tokenUsage)) return { ok: false, error: SCHEDULER_MAP_ERROR };
    const usage = raw.tokenUsage;
    const hasTokens =
      usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined;
    if (!hasTokens) return { ok: false, error: SCHEDULER_MAP_ERROR };
    const allowed = ['inputTokens', 'outputTokens', 'totalTokens'];
    const keys = Object.keys(usage);
    for (const key of keys) {
      if (!allowed.includes(key) || boundedInt(usage[key], 0, MAX_TOKEN_COUNT) === null) {
        return { ok: false, error: SCHEDULER_MAP_ERROR };
      }
    }
    tokenUsage = {
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens as number } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens as number } : {}),
      ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens as number } : {}),
    };
  }
  return {
    ok: true,
    value: {
      id: raw.id,
      taskId: raw.taskId,
      scheduledFor: raw.scheduledFor,
      trigger: raw.trigger,
      status: raw.status,
      attempt,
      maxAttempts,
      durationMs: raw.durationMs === null ? null : (raw.durationMs as number),
      tokenUsage,
      error: raw.error === null || typeof raw.error === 'string' ? (raw.error as string | null) : null,
      chatId: raw.chatId,
      retryOfExecutionId: raw.retryOfExecutionId === null ? null : (raw.retryOfExecutionId as string),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      finishedAt: raw.finishedAt,
    },
  };
}

function mapArray<T>(entries: readonly unknown[], item: (raw: unknown) => SchedulerResult<T>): SchedulerResult<T[]> {
  const list: T[] = [];
  for (const entry of entries) {
    const mapped = item(entry);
    if (!mapped.ok) return mapped;
    list.push(mapped.value);
  }
  return { ok: true, value: list };
}

function mapListResponse(
  raw: unknown,
  key: 'tasks' | 'executions',
  item: (raw: unknown) => SchedulerResult<unknown>,
): SchedulerResult<unknown[]> {
  if (!isPlainObject(raw) || !Array.isArray(raw[key])) return { ok: false, error: SCHEDULER_MAP_ERROR };
  return mapArray(raw[key] as unknown[], item as (raw: unknown) => SchedulerResult<unknown>);
}

export function mapSchedulerTaskListResponse(raw: unknown): SchedulerResult<SchedulerTask[]> {
  const mapped = mapListResponse(raw, 'tasks', mapSchedulerTask);
  return mapped.ok ? { ok: true, value: mapped.value as SchedulerTask[] } : mapped;
}

export function mapSchedulerExecutionListResponse(raw: unknown): SchedulerResult<SchedulerExecution[]> {
  const mapped = mapListResponse(raw, 'executions', mapSchedulerExecution);
  return mapped.ok ? { ok: true, value: mapped.value as SchedulerExecution[] } : mapped;
}

/* GET /api/scheduler/tasks/:id → { task, executions } */
export function mapSchedulerTaskDetailResponse(raw: unknown): SchedulerResult<{
  task: SchedulerTask;
  executions: SchedulerExecution[];
}> {
  if (!isPlainObject(raw) || !Array.isArray(raw.executions)) return { ok: false, error: SCHEDULER_MAP_ERROR };
  const task = mapSchedulerTask(raw.task);
  if (!task.ok) return task;
  const executions = mapArray(raw.executions as unknown[], mapSchedulerExecution);
  if (!executions.ok) return executions;
  return { ok: true, value: { task: task.value, executions: executions.value } };
}

/* POST/PATCH task routes → { task } */
export function mapSchedulerTaskMutationResponse(raw: unknown): SchedulerResult<SchedulerTask> {
  if (!isPlainObject(raw)) return { ok: false, error: SCHEDULER_MAP_ERROR };
  return mapSchedulerTask(raw.task);
}

/* POST …/tasks/:id/run (202) → { execution } */
export function mapSchedulerRunResponse(raw: unknown): SchedulerResult<SchedulerExecution> {
  if (!isPlainObject(raw)) return { ok: false, error: SCHEDULER_MAP_ERROR };
  return mapSchedulerExecution(raw.execution);
}

/* POST …/executions/:id/retry (202) → { execution, retryOfExecutionId } */
export function mapSchedulerRetryResponse(raw: unknown): SchedulerResult<{ execution: SchedulerExecution; retryOfExecutionId: string }> {
  if (!isPlainObject(raw) || !isSchedulerTaskId(raw.retryOfExecutionId)) {
    return { ok: false, error: SCHEDULER_MAP_ERROR };
  }
  const execution = mapSchedulerExecution(raw.execution);
  if (!execution.ok) return execution;
  return { ok: true, value: { execution: execution.value, retryOfExecutionId: raw.retryOfExecutionId } };
}

/* ------------------------------------------------------------------ */
/* Safe errors + request plumbing                                       */
/* ------------------------------------------------------------------ */

export const SCHEDULER_LIST_ERROR = 'Schedules are temporarily unavailable. Refresh to retry.';
export const SCHEDULER_TASK_ERROR = 'This schedule is temporarily unavailable. Refresh to retry.';
export const SCHEDULER_EXECUTIONS_ERROR = 'Execution history is temporarily unavailable. Refresh to retry.';
export const SCHEDULER_CREATE_ERROR = 'Schedule could not be created. Refresh and try again.';
export const SCHEDULER_UPDATE_ERROR = 'Schedule could not be updated. Refresh and try again.';
export const SCHEDULER_ACTION_ERROR = 'The task could not be activated or paused. Refresh and try again.';
export const SCHEDULER_RUN_ERROR = 'The run could not be queued. Refresh and try again.';
export const SCHEDULER_RETRY_ERROR = 'The retry could not be queued. Refresh and try again.';

/**
 * Shown next to the API's verbatim 503 text: create/update/activate/pause
 * landed the DB row and only the BullMQ sync failed (the route contract —
 * the row stands and is reconciled at next startup).
 */
export const SCHEDULER_QUEUE_SYNC_HINT =
  'The change was saved, but the queue could not be synced. The task row stands — refresh to check its current state.';

export interface SchedulerFetch {
  (
    input: string,
    init?: {
      method?: 'GET' | 'POST' | 'PATCH';
      cache?: 'no-store';
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
}

export type SchedulerRequestResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string };

/** One JSON request helper: never throws, `no-store`, safe fixed errors. */
export async function requestSchedulerJson(options: {
  url: string;
  method: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  fallbackError: string;
  fetchImpl?: SchedulerFetch;
}): Promise<SchedulerRequestResult> {
  const { url, method, body, fallbackError, fetchImpl = fetch } = options;
  const init: NonNullable<Parameters<SchedulerFetch>[1]> = {
    method,
    cache: 'no-store',
    headers: { accept: 'application/json' },
  };
  if (method !== 'GET' && body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    try {
      init.body = JSON.stringify(body);
    } catch {
      return { ok: false, status: 0, error: fallbackError };
    }
  }
  try {
    const response = await fetchImpl(url, init);
    let raw: unknown = null;
    try {
      raw = await response.json();
    } catch {
      raw = null;
    }
    if (response.ok) return { ok: true, status: response.status ?? 0, body: raw };
    return { ok: false, status: response.status ?? 0, error: extractApiErrorMessage(raw, fallbackError) };
  } catch {
    return { ok: false, status: 0, error: fallbackError };
  }
}

/* ------------------------------------------------------------------ */
/* One-call orchestration per endpoint                                  */
/* ------------------------------------------------------------------ */

export type SchedulerTaskListFetchResult =
  | { ok: true; tasks: SchedulerTask[] }
  | { ok: false; error: string };

export async function fetchSchedulerTasks(options: {
  apiBaseUrl: string;
  filters?: SchedulerTaskListFilters;
  fetchImpl?: SchedulerFetch;
}): Promise<SchedulerTaskListFetchResult> {
  const { apiBaseUrl, fetchImpl } = options;
  const result = await requestSchedulerJson({
    url: schedulerTasksEndpoint(apiBaseUrl, buildSchedulerTasksQuery(options.filters ?? {})),
    method: 'GET',
    fallbackError: SCHEDULER_LIST_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapSchedulerTaskListResponse(result.body);
  return mapped.ok ? { ok: true, tasks: mapped.value } : mapped;
}

export type SchedulerExecutionListFetchResult =
  | { ok: true; executions: SchedulerExecution[] }
  | { ok: false; error: string };

export async function fetchSchedulerExecutions(options: {
  apiBaseUrl: string;
  filters?: SchedulerExecutionListFilters;
  fetchImpl?: SchedulerFetch;
}): Promise<SchedulerExecutionListFetchResult> {
  const { apiBaseUrl, fetchImpl } = options;
  const result = await requestSchedulerJson({
    url: schedulerExecutionsEndpoint(apiBaseUrl, buildSchedulerExecutionsQuery(options.filters ?? {})),
    method: 'GET',
    fallbackError: SCHEDULER_EXECUTIONS_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapSchedulerExecutionListResponse(result.body);
  return mapped.ok ? { ok: true, executions: mapped.value } : mapped;
}

export type SchedulerTaskMutationResult =
  | { ok: true; task: SchedulerTask }
  | { ok: false; status: number; error: string };

export async function createSchedulerTask(options: {
  apiBaseUrl: string;
  body: SchedulerCreateBody;
  fetchImpl?: SchedulerFetch;
}): Promise<SchedulerTaskMutationResult> {
  const { apiBaseUrl, body, fetchImpl } = options;
  const result = await requestSchedulerJson({
    url: schedulerTasksEndpoint(apiBaseUrl),
    method: 'POST',
    body,
    fallbackError: SCHEDULER_CREATE_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapSchedulerTaskMutationResponse(result.body);
  return mapped.ok ? { ok: true, task: mapped.value } : { ok: false, status: result.status, error: mapped.error };
}

export async function updateSchedulerTask(options: {
  apiBaseUrl: string;
  taskId: string;
  body: SchedulerUpdateBody;
  fetchImpl?: SchedulerFetch;
}): Promise<SchedulerTaskMutationResult> {
  const { apiBaseUrl, body, fetchImpl } = options;
  if (!isSchedulerTaskId(options.taskId)) return { ok: false, status: 0, error: SCHEDULER_UPDATE_ERROR };
  const result = await requestSchedulerJson({
    url: schedulerTaskEndpoint(apiBaseUrl, options.taskId),
    method: 'PATCH',
    body,
    fallbackError: SCHEDULER_UPDATE_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapSchedulerTaskMutationResponse(result.body);
  return mapped.ok ? { ok: true, task: mapped.value } : { ok: false, status: result.status, error: mapped.error };
}

export async function setSchedulerTaskActive(options: {
  apiBaseUrl: string;
  taskId: string;
  isActive: boolean;
  fetchImpl?: SchedulerFetch;
}): Promise<SchedulerTaskMutationResult> {
  const { apiBaseUrl, fetchImpl } = options;
  if (!isSchedulerTaskId(options.taskId)) return { ok: false, status: 0, error: SCHEDULER_ACTION_ERROR };
  const result = await requestSchedulerJson({
    url: schedulerTaskActionEndpoint(apiBaseUrl, options.taskId, options.isActive ? 'activate' : 'pause'),
    method: 'POST',
    fallbackError: SCHEDULER_ACTION_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapSchedulerTaskMutationResponse(result.body);
  return mapped.ok ? { ok: true, task: mapped.value } : { ok: false, status: result.status, error: mapped.error };
}

export type SchedulerRunResult =
  | { ok: true; execution: SchedulerExecution }
  | { ok: false; status: number; error: string };

/** MANUAL run through the real 202 route — never a worker-only run route. */
export async function runSchedulerTaskNow(options: {
  apiBaseUrl: string;
  taskId: string;
  fetchImpl?: SchedulerFetch;
}): Promise<SchedulerRunResult> {
  const { apiBaseUrl, fetchImpl } = options;
  if (!isSchedulerTaskId(options.taskId)) return { ok: false, status: 0, error: SCHEDULER_RUN_ERROR };
  const result = await requestSchedulerJson({
    url: schedulerTaskActionEndpoint(apiBaseUrl, options.taskId, 'run'),
    method: 'POST',
    fallbackError: SCHEDULER_RUN_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapSchedulerRunResponse(result.body);
  return mapped.ok ? { ok: true, execution: mapped.value } : { ok: false, status: result.status, error: mapped.error };
}

export type SchedulerRetryResult =
  | { ok: true; execution: SchedulerExecution; retryOfExecutionId: string }
  | { ok: false; status: number; error: string };

/** DEAD_LETTER retry — creates a NEW linked execution in a NEW isolated chat. */
export async function retrySchedulerExecution(options: {
  apiBaseUrl: string;
  executionId: string;
  fetchImpl?: SchedulerFetch;
}): Promise<SchedulerRetryResult> {
  const { apiBaseUrl, fetchImpl } = options;
  if (!isSchedulerTaskId(options.executionId)) return { ok: false, status: 0, error: SCHEDULER_RETRY_ERROR };
  const result = await requestSchedulerJson({
    url: schedulerExecutionRetryEndpoint(apiBaseUrl, options.executionId),
    method: 'POST',
    fallbackError: SCHEDULER_RETRY_ERROR,
    fetchImpl,
  });
  if (!result.ok) return result;
  const mapped = mapSchedulerRetryResponse(result.body);
  return mapped.ok
    ? { ok: true, execution: mapped.value.execution, retryOfExecutionId: mapped.value.retryOfExecutionId }
    : { ok: false, status: result.status, error: mapped.error };
}

/* ------------------------------------------------------------------ */
/* Poll predicate                                                       */
/* ------------------------------------------------------------------ */

/** Statuses that settle asynchronously (the only reason to poll). */
export function isSettlingExecutionStatus(status: SchedulerExecutionStatus): boolean {
  return status === 'PENDING' || status === 'RUNNING' || status === 'RETRYING';
}

/**
 * Poll only while at least one visible execution is PENDING/RUNNING/RETRYING
 * or a just-submitted run is still settling (`settleRuns > 0` counts the runs
 * the dashboard itself triggered this instant; each completed poll tick burns
 * one). Tab visibility / no-overlap / sequence guards live in the component.
 */
export function shouldPollExecutions(executions: readonly SchedulerExecution[], settleRuns = 0): boolean {
  if (settleRuns > 0) return true;
  return executions.some((execution) => isSettlingExecutionStatus(execution.status));
}

/* ------------------------------------------------------------------ */
/* Formatters                                                           */
/* ------------------------------------------------------------------ */

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Human recurrence summary (all times UTC — the only timezone the domain has). */
export function formatRecurrenceSummary(task: {
  recurrenceType: SchedulerRecurrenceType;
  recurrenceConfig: SchedulerRecurrenceConfig;
}): string {
  const { recurrenceType, recurrenceConfig } = task;
  if (recurrenceType === 'ONCE' && 'runAt' in recurrenceConfig) {
    return isUtcIsoInstant(recurrenceConfig.runAt)
      ? `Once at ${formatDateTime(recurrenceConfig.runAt, '(unknown)')}`
      : '(unknown schedule)';
  }
  if (recurrenceType === 'DAILY' && 'hour' in recurrenceConfig) {
    return `Daily at ${formatClock(recurrenceConfig.hour, recurrenceConfig.minute)} UTC`;
  }
  if (recurrenceType === 'WEEKLY' && 'weekdays' in recurrenceConfig) {
    const days = recurrenceConfig.weekdays.map((day) => WEEKDAY_LABELS[day] ?? '?').join(', ');
    return `Weekly at ${formatClock(recurrenceConfig.hour, recurrenceConfig.minute)} UTC on ${days}`;
  }
  if (recurrenceType === 'MONTHLY' && 'daysOfMonth' in recurrenceConfig) {
    const days = recurrenceConfig.daysOfMonth.join(', ');
    return `Monthly at ${formatClock(recurrenceConfig.hour, recurrenceConfig.minute)} UTC on day ${days}`;
  }
  if (recurrenceType === 'CUSTOM_CRON' && 'expression' in recurrenceConfig) {
    return `Cron ${truncateMemoryText(recurrenceConfig.expression, 60)}`;
  }
  return '(unknown schedule)';
}

/** `1/3` on a RUNNING row; PENDING rows show `0/3` (not claimed yet). */
export function formatAttempt(execution: { attempt: number; maxAttempts: number }): string {
  return `${execution.attempt}/${execution.maxAttempts}`;
}

/** `1230 ms` or an em dash — durations are optional server data. */
export function formatDuration(durationMs: number | null): string {
  return durationMs === null ? '—' : `${durationMs} ms`;
}

/** `in 12 · out 34 · total 46`; missing fields (or the whole object) are em dashes. */
export function formatTokenUsage(tokenUsage: SchedulerTokenUsage | null): string {
  if (tokenUsage === null) return 'in — · out — · total —';
  const field = (value: number | undefined): string => (typeof value === 'number' ? String(value) : '—');
  return `in ${field(tokenUsage.inputTokens)} · out ${field(tokenUsage.outputTokens)} · total ${field(tokenUsage.totalTokens)}`;
}

/** Bounded safe error display; em dash when the host supplied none. */
export function formatExecutionError(error: string | null): string {
  if (error === null || error.length === 0) return '—';
  return truncateMemoryText(error, SCHEDULER_ERROR_DISPLAY_LIMIT);
}

export function formatScheduleTime(value: string | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined) return fallback;
  return formatDateTime(value, '(unknown)');
}

/** data-status value for badge CSS (lowercase enum spelling). */
export function schedulerStatusBadge(status: SchedulerExecutionStatus): string {
  return status.toLowerCase();
}

/** Only DEAD_LETTER rows may be retried (the route 409s everything else). */
export function canRetryExecution(execution: { status: SchedulerExecutionStatus }): boolean {
  return execution.status === 'DEAD_LETTER';
}

/* ------------------------------------------------------------------ */
/* Typed links (owning task's agent + mode, isolated chat)              */
/* ------------------------------------------------------------------ */

/**
 * `/agents/<task.agentSlug>/chat/<execution.chatId>?mode=<task.mode>` — the
 * execution's ISOLATED chat under the OWNING task's agent/mode. `null` when
 * the chat id is not a safe id or the task shape is unknown.
 */
export function executionChatLink(
  task: { agentSlug: string; mode: string } | null | undefined,
  execution: { chatId: string },
): { href: string; text: string } | null {
  if (task === null || task === undefined) return null;
  if (!isAgentSlug(task.agentSlug) || !isAgentMode(task.mode)) return null;
  if (!isSafeChatId(execution.chatId)) return null;
  return {
    href: `/agents/${encodeURIComponent(task.agentSlug)}/chat/${encodeURIComponent(execution.chatId)}?mode=${encodeURIComponent(task.mode)}`,
    text: 'Open isolated chat',
  };
}

/**
 * The DEAD_LETTER source of a RETRY row, linked the same way (chatId IS the
 * execution id, and the source belongs to the SAME task — so this task's
 * agent/mode apply). `null` when absent or unsafe.
 */
export function retrySourceChatLink(
  task: { agentSlug: string; mode: string } | null | undefined,
  execution: { retryOfExecutionId: string | null },
): { href: string; text: string } | null {
  if (execution.retryOfExecutionId === null) return null;
  if (task === null || task === undefined) return null;
  if (!isAgentSlug(task.agentSlug) || !isAgentMode(task.mode)) return null;
  if (!isSchedulerTaskId(execution.retryOfExecutionId)) return null;
  return {
    href: `/agents/${encodeURIComponent(task.agentSlug)}/chat/${encodeURIComponent(execution.retryOfExecutionId)}?mode=${encodeURIComponent(task.mode)}`,
    text: 'Open the retried run',
  };
}
