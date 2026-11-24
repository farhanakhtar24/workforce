'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AGENT_TASK_NAME_MAX,
  AGENT_TASK_PROMPT_MAX,
  AGENT_TASK_SCOPE_MAX,
  SCHEDULER_EXECUTION_STATUSES,
  SCHEDULER_QUEUE_SYNC_HINT,
  SCHEDULER_RECURRENCE_TYPES,
  buildCreateTaskBody,
  buildUpdateTaskBody,
  canRetryExecution,
  createSchedulerTask,
  dateTimeLocalFromUtcIso,
  executionChatLink,
  fetchSchedulerExecutions,
  fetchSchedulerTasks,
  formatAttempt,
  formatExecutionError,
  formatRecurrenceSummary,
  formatScheduleTime,
  formatSkipDates,
  formatTokenUsage,
  retrySchedulerExecution,
  retrySourceChatLink,
  runSchedulerTaskNow,
  schedulerStatusBadge,
  setSchedulerTaskActive,
  shouldPollExecutions,
  updateSchedulerTask,
  type SchedulerExecution,
  type SchedulerRecurrenceType,
  type SchedulerTask,
} from '@/lib/scheduler';
import { WEB_AGENT_MODES, WEB_AGENT_SLUGS } from '@/lib/agents';

const POLL_INTERVAL_MS = 2000;
/** Poll cycles a just-submitted run/retry keeps the loop alive while the row settles in. */
const SETTLE_CYCLES = 3;

const WEEKDAY_OPTIONS = [
  { value: '0', label: 'Sun' },
  { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
];
const MONTH_DAY_OPTIONS = Array.from({ length: 31 }, (_, index) => String(index + 1));

interface Notice {
  kind: 'ok' | 'error' | 'warn';
  text: string;
}

interface ScheduleFormState {
  name: string;
  agentSlug: string;
  mode: string;
  prompt: string;
  scope: string;
  recurrenceType: SchedulerRecurrenceType;
  /** ONCE: datetime-local value (the UTC wall clock). */
  runAt: string;
  hour: string;
  minute: string;
  weekdays: string[];
  daysOfMonth: string[];
  cronExpression: string;
  skipDates: string;
}

const EMPTY_FORM: ScheduleFormState = {
  name: '',
  agentSlug: 'general',
  mode: 'action',
  prompt: '',
  scope: 'default',
  recurrenceType: 'ONCE',
  runAt: '',
  hour: '9',
  minute: '0',
  weekdays: ['1'],
  daysOfMonth: ['1'],
  cronExpression: '',
  skipDates: '',
};

function formFromTask(task: SchedulerTask): ScheduleFormState {
  const config = task.recurrenceConfig;
  const weekdays = 'weekdays' in config ? config.weekdays.map(String).sort() : ['1'];
  const daysOfMonth = 'daysOfMonth' in config ? config.daysOfMonth.map(String).sort((a, b) => Number(a) - Number(b)) : ['1'];
  const hour = 'hour' in config ? String(config.hour) : '9';
  const minute = 'minute' in config ? String(config.minute) : '0';
  return {
    name: task.name,
    agentSlug: task.agentSlug,
    mode: task.mode,
    prompt: task.prompt,
    scope: task.scope,
    recurrenceType: task.recurrenceType,
    runAt: 'runAt' in config ? (dateTimeLocalFromUtcIso(config.runAt) ?? '') : '',
    hour,
    minute,
    weekdays,
    daysOfMonth,
    cronExpression: 'expression' in config ? config.expression : '',
    skipDates: formatSkipDates(task.skipDates),
  };
}

function toggle(selection: string[], value: string): string[] {
  return selection.includes(value) ? selection.filter((entry) => entry !== value) : [...selection, value].sort();
}

/**
 * `/schedules` — the Phase 5 schedule dashboard. Tasks and execution history
 * come from the real `/api/scheduler` REST routes; create/edit/activate/pause
 * sync the task through create/PATCH/activate/pause, "Run now" uses the 202
 * MANUAL run route and dead-letter rows get the retry route. The browser
 * never calls the WORKER-ONLY run-scheduled / executions/:id/run routes.
 * Polling follows the /memory and /delegations pattern: 2 s only while a
 * visible execution is PENDING/RUNNING/RETRYING (or a just-submitted run is
 * settling), tab-visibility gated, never overlapping, sequence-guarded, and
 * it stops on the first error behind a manual Refresh. All schedule times
 * are UTC — minute precision, no seconds, no other timezone.
 */
export function Schedules({ apiBaseUrl }: { apiBaseUrl: string }): React.ReactElement {
  return (
    <SchedulesLoaded apiBaseUrl={apiBaseUrl} />
  );
}

function SchedulesLoaded({ apiBaseUrl }: { apiBaseUrl: string }): React.ReactElement {
  const [tasks, setTasks] = useState<ReadonlyArray<SchedulerTask>>([]);
  const [executions, setExecutions] = useState<ReadonlyArray<SchedulerExecution>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [taskFilter, setTaskFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // Create/edit form
  const [form, setForm] = useState<ScheduleFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formNotice, setFormNotice] = useState<Notice | null>(null);

  // Row actions: `${kind}:${id}` while one POST is in flight.
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [settleRuns, setSettleRuns] = useState(0);

  // Non-overlapping, sequence-guarded, visibility-gated polling.
  const requestSeq = useRef(0);
  const pollInFlight = useRef(false);
  const filtersRef = useRef({ taskFilter: '', statusFilter: '' });
  filtersRef.current = { taskFilter, statusFilter };

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const filters = filtersRef.current;
    const [tasksResult, executionsResult] = await Promise.all([
      fetchSchedulerTasks({ apiBaseUrl, filters: { limit: 100 } }),
      fetchSchedulerExecutions({
        apiBaseUrl,
        filters: { ...(filters.taskFilter !== '' ? { taskId: filters.taskFilter } : {}), ...(filters.statusFilter !== '' ? { status: filters.statusFilter } : {}), limit: 100 },
      }),
    ]);
    if (seq !== requestSeq.current) return;
    setLoading(false);
    if (!tasksResult.ok) {
      setError(tasksResult.error);
      setNotice(null);
      return; // an error also stops automatic polling
    }
    if (!executionsResult.ok) {
      setError(executionsResult.error);
      setNotice(null);
      return;
    }
    setError(null);
    setTasks(tasksResult.tasks);
    setExecutions(executionsResult.executions);
  }, [apiBaseUrl]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refreshRef.current();
  }, [taskFilter, statusFilter]);

  const visibleExecutions = executions.filter((execution) => {
    if (statusFilter !== '' && execution.status !== statusFilter) return false;
    if (taskFilter !== '' && execution.taskId !== taskFilter) return false;
    return true;
  });
  const pollActive = error === null && shouldPollExecutions(visibleExecutions, settleRuns);

  useEffect(() => {
    if (!pollActive) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (pollInFlight.current) return; // never overlap requests
      pollInFlight.current = true;
      setSettleRuns((runs) => (runs > 0 ? runs - 1 : 0));
      void refreshRef.current().finally(() => {
        pollInFlight.current = false;
      });
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      pollInFlight.current = false;
    };
  }, [pollActive]);

  /** One row action with busy guard; 503 answers keep the saved-row hint honest. */
  const runAction = async (kind: 'activate' | 'pause' | 'run' | 'retry', action: () => Promise<{ ok: boolean; status?: number; error?: string }>): Promise<void> => {
    if (actionBusy !== null) return;
    setActionBusy(kind);
    setNotice(null);
    const result = await action();
    setActionBusy(null);
    if (!result.ok) {
      const text = result.error ?? 'The action failed. Refresh and try again.';
      if (result.status === 503) {
        // Honest queue-sync failure: the DB row stands (route contract) — say it
        // and refresh the task state so the truth is visible.
        setNotice({ kind: 'warn', text: `${text} ${SCHEDULER_QUEUE_SYNC_HINT}` });
        await refreshRef.current();
        return;
      }
      setNotice({ kind: 'error', text });
      return;
    }
    if (kind === 'run' || kind === 'retry') setSettleRuns(SETTLE_CYCLES);
    setNotice(
      kind === 'activate'
        ? { kind: 'ok', text: 'Task activated — occurrences are scheduled again.' }
        : kind === 'pause'
          ? { kind: 'ok', text: 'Task paused — no new occurrences are scheduled until you activate it.' }
          : kind === 'run'
            ? { kind: 'ok', text: 'Run queued (202). It starts as PENDING below and settles through the visible chat link.' }
            : {
                kind: 'ok',
                text: 'Retry queued (202). A NEW linked execution was created in a NEW isolated chat; the dead-lettered run stays unchanged.',
              },
    );
    await refreshRef.current();
  };

  const submitForm = async (): Promise<void> => {
    if (formBusy) return;
    setFormBusy(true);
    setFormNotice(null);
    if (editingId !== null) {
      const body = buildUpdateTaskBody({ ...form, id: editingId });
      if (!body.ok) {
        setFormBusy(false);
        setFormNotice({ kind: 'error', text: body.error });
        return;
      }
      const result = await updateSchedulerTask({ apiBaseUrl, taskId: editingId, body: body.body });
      setFormBusy(false);
      if (!result.ok) {
        if (result.status === 503) {
          // The update row stands; only the queue sync failed.
          setFormNotice({ kind: 'warn', text: `${result.error} ${SCHEDULER_QUEUE_SYNC_HINT}` });
          await refreshRef.current();
          return;
        }
        setFormNotice({ kind: 'error', text: result.error });
        return;
      }
      setFormNotice({ kind: 'ok', text: 'Schedule updated.' });
      await refreshRef.current();
      return;
    }
    const body = buildCreateTaskBody(form);
    if (!body.ok) {
      setFormBusy(false);
      setFormNotice({ kind: 'error', text: body.error });
      return;
    }
    const result = await createSchedulerTask({ apiBaseUrl, body: body.body });
    setFormBusy(false);
    if (!result.ok) {
      if (result.status === 503) {
        // The created row stands; only the queue sync failed.
        setFormNotice({ kind: 'warn', text: `${result.error} ${SCHEDULER_QUEUE_SYNC_HINT}` });
        await refreshRef.current();
        return;
      }
      setFormNotice({ kind: 'error', text: result.error });
      return;
    }
    setFormNotice({ kind: 'ok', text: 'Schedule created. It starts active — pause it below to hold occurrences.' });
    setForm(EMPTY_FORM);
    setEditingId(null);
    await refreshRef.current();
  };

  const taskById = new Map(tasks.map((task) => [task.id, task]));

  return (
    <main className="chat-layout">
      <header className="chat-header">
        <h1>Schedules</h1>
        <nav className="chat-nav" aria-label="Workforce pages">
          <a className="chat-new" href="/">New chat</a>
          <a className="chat-new" href="/memory">Memory</a>
          <a className="chat-new" href="/work">Work</a>
        </nav>
      </header>

      <p className="memory-hint" role="note">
        All schedules run in UTC — minute precision only, no seconds and no other timezone. A task&apos;s
        <code>nextRunAt</code> is computed and kept by the API; activation/pause are separate actions.
      </p>

      <ScheduleFormSection
        apiBaseUrl={apiBaseUrl}
        form={form}
        setForm={setForm}
        editingId={editingId}
        editingName={editingId !== null ? (taskById.get(editingId)?.name ?? null) : null}
        formBusy={formBusy}
        formNotice={formNotice}
        onSubmit={() => void submitForm()}
        onCancelEdit={() => {
          setEditingId(null);
          setForm(EMPTY_FORM);
          setFormNotice(null);
        }}
      />

      {error !== null && (
        <div role="alert" className="chat-banner chat-banner-error">
          <p>{error}</p>
          <button type="button" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      )}
      {notice !== null && (
        <div role={notice.kind === 'ok' ? 'status' : 'alert'} className={`memory-notice ${notice.kind === 'ok' ? 'memory-notice-ok' : 'memory-notice-error'}`}>
          <p>{notice.text}</p>
        </div>
      )}
      <p aria-live="polite" className="memory-status">
        {loading && error === null ? 'Loading…' : ''}
      </p>

      <section className="memory-section" aria-labelledby="schedules-tasks-heading">
        <h2 id="schedules-tasks-heading">Tasks ({tasks.length})</h2>
        {tasks.length === 0 ? (
          <p className="memory-muted">{loading ? 'Loading tasks…' : 'No scheduled tasks yet — create one above.'}</p>
        ) : (
          <>
            <div className="sched-desktop-only sched-tablewrap">
              <table className="sched-table">
                <caption className="memory-hint">Scheduled tasks — every time shown in UTC.</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Agent / mode</th>
                    <th scope="col">Schedule</th>
                    <th scope="col">State</th>
                    <th scope="col">Next run (UTC)</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.id}>
                      <th scope="row" className="sched-cell-name">
                        {task.name}
                        <span className="memory-meta">scope {task.scope}</span>
                      </th>
                      <td>
                        <span className="memory-badge" data-kind={task.agentSlug}>{task.agentSlug}</span>{' '}
                        <span className="memory-badge">{task.mode}</span>
                      </td>
                      <td>
                        {formatRecurrenceSummary(task)}
                        {task.skipDates.length > 0 && (
                          <span className="memory-meta"> skips {task.skipDates.length} date(s)</span>
                        )}
                      </td>
                      <td>
                        <span className="sched-badge" data-active={task.isActive ? 'true' : 'false'}>
                          {task.isActive ? 'Active' : 'Paused'}
                        </span>
                      </td>
                      <td>{formatScheduleTime(task.nextRunAt, '— (none pending)')}</td>
                      <td>
                        <TaskActions
                          task={task}
                          busy={actionBusy}
                          onEdit={() => {
                            setEditingId(task.id);
                            setForm(formFromTask(task));
                            setFormNotice(null);
                          }}
                          onActivate={() => void runAction('activate', () => setSchedulerTaskActive({ apiBaseUrl, taskId: task.id, isActive: true }))}
                          onPause={() => void runAction('pause', () => setSchedulerTaskActive({ apiBaseUrl, taskId: task.id, isActive: false }))}
                          onRun={() => void runAction('run', () => runSchedulerTaskNow({ apiBaseUrl, taskId: task.id }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="memory-cards sched-mobile-only">
              {tasks.map((task) => (
                <li key={task.id} className="memory-card">
                  <p className="memory-card-title">{task.name}</p>
                  <div className="memory-card-head">
                    <span className="memory-badge" data-kind={task.agentSlug}>{task.agentSlug}</span>
                    <span className="memory-badge">{task.mode}</span>
                    <span className="sched-badge" data-active={task.isActive ? 'true' : 'false'}>
                      {task.isActive ? 'Active' : 'Paused'}
                    </span>
                  </div>
                  <p className="memory-card-content">{formatRecurrenceSummary(task)}</p>
                  <p className="memory-meta">
                    scope {task.scope}
                    {task.skipDates.length > 0 ? ` · skips ${task.skipDates.length} date(s)` : ''} · next run{' '}
                    {formatScheduleTime(task.nextRunAt, '— (none pending)')}
                  </p>
                  <TaskActions
                    task={task}
                    busy={actionBusy}
                    onEdit={() => {
                      setEditingId(task.id);
                      setForm(formFromTask(task));
                      setFormNotice(null);
                    }}
                    onActivate={() => void runAction('activate', () => setSchedulerTaskActive({ apiBaseUrl, taskId: task.id, isActive: true }))}
                    onPause={() => void runAction('pause', () => setSchedulerTaskActive({ apiBaseUrl, taskId: task.id, isActive: false }))}
                    onRun={() => void runAction('run', () => runSchedulerTaskNow({ apiBaseUrl, taskId: task.id }))}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="memory-section" aria-labelledby="schedules-executions-heading">
        <h2 id="schedules-executions-heading">Execution history ({visibleExecutions.length})</h2>
        <div className="memory-fieldrow">
          <div className="memory-field">
            <label htmlFor="schedules-exec-task-filter">Filter by task</label>
            <select
              id="schedules-exec-task-filter"
              className="memory-input"
              aria-label="Filter executions by task"
              value={taskFilter}
              onChange={(event) => setTaskFilter(event.target.value)}
            >
              <option value="">All tasks</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>{task.name}</option>
              ))}
            </select>
          </div>
          <div className="memory-field">
            <label htmlFor="schedules-exec-status-filter">Filter by status</label>
            <select
              id="schedules-exec-status-filter"
              className="memory-input"
              aria-label="Filter executions by status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">All statuses</option>
              {SCHEDULER_EXECUTION_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="memory-actions">
          <button
            type="button"
            className="memory-button"
            aria-label="Refresh tasks and execution history"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
        {pollActive && (
          <p aria-live="polite" className="memory-muted">
            Refreshing every {POLL_INTERVAL_MS / 1000}s while an execution is pending, running or retrying (or a just-submitted run settles) — it stops on error.
          </p>
        )}
        {visibleExecutions.length === 0 ? (
          <p className="memory-muted">{loading ? 'Loading executions…' : 'No executions match — run a task or clear the filters.'}</p>
        ) : (
          <>
            <div className="sched-desktop-only sched-tablewrap">
              <table className="sched-table">
                <caption className="memory-hint">Runs of the tasks above; chat links open the execution&apos;s isolated chat.</caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Task</th>
                    <th scope="col">Scheduled for (UTC)</th>
                    <th scope="col">Attempt</th>
                    <th scope="col">Duration</th>
                    <th scope="col">Tokens</th>
                    <th scope="col">Error</th>
                    <th scope="col">Chat</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleExecutions.map((execution) => (
                    <ExecutionRow
                      key={execution.id}
                      execution={execution}
                      task={taskById.get(execution.taskId) ?? null}
                      busy={actionBusy}
                      onRetry={() => void runAction('retry', () => retrySchedulerExecution({ apiBaseUrl, executionId: execution.id }))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="memory-cards sched-mobile-only">
              {visibleExecutions.map((execution) => (
                <ExecutionCard
                  key={execution.id}
                  execution={execution}
                  task={taskById.get(execution.taskId) ?? null}
                  busy={actionBusy}
                  onRetry={() => void runAction('retry', () => retrySchedulerExecution({ apiBaseUrl, executionId: execution.id }))}
                />
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Task actions (shared by table row and card)                          */
/* ------------------------------------------------------------------ */

function TaskActions({
  task,
  busy,
  onEdit,
  onActivate,
  onPause,
  onRun,
}: {
  task: SchedulerTask;
  busy: string | null;
  onEdit: () => void;
  onActivate: () => void;
  onPause: () => void;
  onRun: () => void;
}): React.ReactElement {
  return (
    <div className="sched-actions">
      <button
        type="button"
        className="memory-button"
        aria-label={`Edit ${task.name}`}
        disabled={busy !== null}
        onClick={onEdit}
      >
        Edit
      </button>
      <button
        type="button"
        className="memory-button"
        aria-label={task.isActive ? `Pause ${task.name}` : `Activate ${task.name}`}
        disabled={busy !== null}
        onClick={task.isActive ? onPause : onActivate}
      >
        {task.isActive ? 'Pause' : 'Activate'}
      </button>
      <button
        type="button"
        className="memory-button"
        aria-label={`Run ${task.name} now`}
        disabled={busy !== null}
        onClick={onRun}
      >
        Run now
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Execution rows (table + card)                                        */
/* ------------------------------------------------------------------ */

function ExecutionActionCell({
  execution,
  task,
  busy,
  onRetry,
}: {
  execution: SchedulerExecution;
  task: SchedulerTask | null;
  busy: string | null;
  onRetry: () => void;
}): React.ReactElement | null {
  if (!canRetryExecution(execution)) {
    return execution.retryOfExecutionId !== null && task !== null ? (
      <RetrySourceLinkCell task={task} execution={execution} />
    ) : null;
  }
  return (
    <details className="sched-retry-details">
      <summary>Create a NEW linked execution and a NEW isolated chat for this dead-lettered run. The old execution&apos;s history stays unchanged.</summary>
      <button
        type="button"
        className="memory-button"
        aria-label="Retry dead-lettered execution"
        disabled={busy !== null}
        onClick={onRetry}
      >
        Retry
      </button>
    </details>
  );
}

function RetrySourceLinkCell({
  task,
  execution,
}: {
  task: SchedulerTask;
  execution: SchedulerExecution;
}): React.ReactElement | null {
  const link = retrySourceChatLink(task, execution);
  if (link === null) return null;
  return <a className="work-link" href={link.href}>{`↩ ${link.text}`}</a>;
}

function ExecutionRow({
  execution,
  task,
  busy,
  onRetry,
}: {
  execution: SchedulerExecution;
  task: SchedulerTask | null;
  busy: string | null;
  onRetry: () => void;
}): React.ReactElement {
  const chatLink = executionChatLink(task, execution);
  return (
    <tr>
      <th scope="row">
        <span className="sched-badge" data-status={schedulerStatusBadge(execution.status)}>{execution.status}</span>
        <span className="memory-meta">{execution.trigger}</span>
      </th>
      <td>{task !== null ? task.name : <span className="memory-mono">{execution.taskId}</span>}</td>
      <td>{formatScheduleTime(execution.scheduledFor)}</td>
      <td className="sched-num">{formatAttempt(execution)}</td>
      <td className="sched-num">{execution.durationMs === null ? '—' : `${execution.durationMs} ms`}</td>
      <td>{formatTokenUsage(execution.tokenUsage)}</td>
      <td className="sched-cell-error">{formatExecutionError(execution.error)}</td>
      <td>
        {chatLink !== null ? (
          <a className="work-link" href={chatLink.href}>{chatLink.text}</a>
        ) : (
          '—'
        )}
      </td>
      <td>
        <ExecutionActionCell execution={execution} task={task} busy={busy} onRetry={onRetry} />
      </td>
    </tr>
  );
}

function ExecutionCard({
  execution,
  task,
  busy,
  onRetry,
}: {
  execution: SchedulerExecution;
  task: SchedulerTask | null;
  busy: string | null;
  onRetry: () => void;
}): React.ReactElement {
  const chatLink = executionChatLink(task, execution);
  const retryLink = retrySourceChatLink(task, execution);
  return (
    <li className="memory-card">
      <div className="memory-card-head">
        <span className="sched-badge" data-status={schedulerStatusBadge(execution.status)}>{execution.status}</span>
        <span className="memory-badge">{execution.trigger}</span>
        <span className="memory-badge">{formatAttempt(execution)}</span>
      </div>
      <p className="memory-card-title">{task !== null ? task.name : execution.taskId}</p>
      <p className="memory-meta">
        scheduled {formatScheduleTime(execution.scheduledFor)} · duration{' '}
        {execution.durationMs === null ? '—' : `${execution.durationMs} ms`} · tokens {formatTokenUsage(execution.tokenUsage)}
      </p>
      <p className="memory-card-content sched-cell-error">{formatExecutionError(execution.error)}</p>
      <div className="memory-actions">
        {chatLink !== null && (
          <a className="work-link" href={chatLink.href}>{chatLink.text}</a>
        )}
        {retryLink !== null && (
          <a className="work-link" href={retryLink.href}>{retryLink.text}</a>
        )}
      </div>
      {canRetryExecution(execution) && (
        <div className="memory-actions">
          <details className="sched-retry-details">
            <summary>Creates a NEW linked execution in a NEW isolated chat. The old audit stays unchanged.</summary>
            <button
              type="button"
              className="memory-button"
              aria-label="Retry dead-lettered execution"
              disabled={busy !== null}
              onClick={onRetry}
            >
              Retry
            </button>
          </details>
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Create / edit form                                                   */
/* ------------------------------------------------------------------ */

const FORM_HEADING_CREATE = 'Create a scheduled task';
const FORM_HEADING_EDIT = 'Edit scheduled task';

function ScheduleFormSection({
  form,
  setForm,
  editingId,
  editingName,
  formBusy,
  formNotice,
  onSubmit,
  onCancelEdit,
}: {
  apiBaseUrl: string;
  form: ScheduleFormState;
  setForm: (next: ScheduleFormState) => void;
  editingId: string | null;
  editingName: string | null;
  formBusy: boolean;
  formNotice: Notice | null;
  onSubmit: () => void;
  onCancelEdit: () => void;
}): React.ReactElement {
  const set = <K extends keyof ScheduleFormState>(key: K, value: ScheduleFormState[K]): void => {
    setForm({ ...form, [key]: value });
  };
  const headingId = 'schedules-form-heading';
  const heading = editingId !== null ? FORM_HEADING_EDIT : FORM_HEADING_CREATE;
  return (
    <section className="memory-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{heading}{editingId !== null && editingName !== null ? ` — ${editingName}` : ''}</h2>
      <form
        className="memory-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="memory-fieldrow">
          <div className="memory-field memory-field-grow">
            <label htmlFor="schedules-name">Name</label>
            <input
              id="schedules-name"
              className="memory-input"
              aria-label="Task name"
              value={form.name}
              onChange={(event) => set('name', event.target.value)}
              required
              maxLength={AGENT_TASK_NAME_MAX}
            />
          </div>
          <div className="memory-field">
            <label htmlFor="schedules-agent">Agent</label>
            <select
              id="schedules-agent"
              className="memory-input"
              aria-label="Agent that runs the task"
              value={form.agentSlug}
              onChange={(event) => set('agentSlug', event.target.value)}
            >
              {WEB_AGENT_SLUGS.map((slug) => (
                <option key={slug} value={slug}>{slug}</option>
              ))}
            </select>
          </div>
          <div className="memory-field">
            <label htmlFor="schedules-mode">Mode</label>
            <select
              id="schedules-mode"
              className="memory-input"
              aria-label="Plan or action mode"
              value={form.mode}
              onChange={(event) => set('mode', event.target.value)}
            >
              {WEB_AGENT_MODES.map((mode) => (
                <option key={mode} value={mode}>{mode}</option>
              ))}
            </select>
          </div>
          <div className="memory-field">
            <label htmlFor="schedules-scope">Scope</label>
            <input
              id="schedules-scope"
              className="memory-input"
              aria-label="Memory scope"
              value={form.scope}
              onChange={(event) => set('scope', event.target.value)}
              required
              maxLength={AGENT_TASK_SCOPE_MAX}
            />
          </div>
        </div>
        <div className="memory-field">
          <label htmlFor="schedules-prompt">Prompt</label>
          <textarea
            id="schedules-prompt"
            className="memory-input"
            aria-label="Prompt the agent runs"
            value={form.prompt}
            onChange={(event) => set('prompt', event.target.value)}
            required
            rows={4}
            maxLength={AGENT_TASK_PROMPT_MAX}
          />
        </div>

        <div className="memory-fieldrow">
          <div className="memory-field">
            <label htmlFor="schedules-recurrence">Recurrence</label>
            <select
              id="schedules-recurrence"
              className="memory-input"
              aria-label="Recurrence type"
              value={form.recurrenceType}
              onChange={(event) => set('recurrenceType', event.target.value as SchedulerRecurrenceType)}
            >
              {SCHEDULER_RECURRENCE_TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
          <RecurrenceFields form={form} set={set} />
        </div>

        <div className="memory-field">
          <label htmlFor="schedules-skip-dates">Skip dates (UTC, comma or newline separated YYYY-MM-DD)</label>
          <textarea
            id="schedules-skip-dates"
            className="memory-input"
            aria-label="Skip dates, comma or newline separated YYYY-MM-DD"
            value={form.skipDates}
            onChange={(event) => set('skipDates', event.target.value)}
            rows={2}
            placeholder="2026-12-24, 2026-12-25"
          />
          <span className="memory-hint">
            Optional. Duplicates and invalid calendar dates are rejected. Skip counts toward at most 366 dates.
          </span>
        </div>

        <p className="memory-hint" role="note">
          Every schedule — including the value you type for a one-off run — is interpreted as UTC. Minutes only: no
          seconds, no other timezone. {form.recurrenceType === 'ONCE' ? 'The one-off time below is the UTC clock time.' : ''}
        </p>

        {formNotice !== null && (
          <div role={formNotice.kind === 'ok' ? 'status' : 'alert'} className={`memory-notice ${formNotice.kind === 'ok' ? 'memory-notice-ok' : 'memory-notice-error'}`}>
            <p>{formNotice.text}</p>
          </div>
        )}

        <div className="memory-actions">
          <button type="submit" className="memory-button-primary" disabled={formBusy}>
            {editingId !== null ? 'Save changes' : 'Create task'}
          </button>
          {editingId !== null && (
            <button type="button" className="memory-button" aria-label="Cancel editing" disabled={formBusy} onClick={onCancelEdit}>
              Cancel edit
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

/** Dynamic controls per recurrence type (all UTC, minute precision). */
function RecurrenceFields({
  form,
  set,
}: {
  form: ScheduleFormState;
  set: <K extends keyof ScheduleFormState>(key: K, value: ScheduleFormState[K]) => void;
}): React.ReactElement | null {
  if (form.recurrenceType === 'ONCE') {
    return (
      <div className="memory-field">
        <label htmlFor="schedules-runat">Run at (UTC)</label>
        <input
          id="schedules-runat"
          className="memory-input"
          type="datetime-local"
          aria-label="Run at, UTC date and time"
          value={form.runAt}
          onChange={(event) => set('runAt', event.target.value)}
          step={60}
        />
        <span className="memory-hint">Sent as a UTC instant; seconds are never stored.</span>
      </div>
    );
  }
  if (form.recurrenceType === 'CUSTOM_CRON') {
    return (
      <div className="memory-field memory-field-grow">
        <label htmlFor="schedules-cron">Cron expression (5 fields)</label>
        <input
          id="schedules-cron"
          className="memory-input"
          aria-label="Custom cron expression, exactly 5 fields"
          value={form.cronExpression}
          onChange={(event) => set('cronExpression', event.target.value)}
          placeholder="*/15 * * * *"
        />
        <span className="memory-hint">Exactly 5 whitespace-separated fields (minute hour day month weekday), at most 200 characters — evaluated in UTC.</span>
      </div>
    );
  }
  const daily = form.recurrenceType === 'DAILY' || form.recurrenceType === 'WEEKLY' || form.recurrenceType === 'MONTHLY';
  if (!daily) return null;
  return (
    <>
      <div className="memory-field">
        <label htmlFor="schedules-hour">Hour (UTC 0–23)</label>
        <input
          id="schedules-hour"
          className="memory-input"
          type="number"
          inputMode="numeric"
          min={0}
          max={23}
          step={1}
          aria-label="Hour of day, UTC 0 to 23"
          value={form.hour}
          onChange={(event) => set('hour', event.target.value)}
        />
      </div>
      <div className="memory-field">
        <label htmlFor="schedules-minute">Minute (0–59)</label>
        <input
          id="schedules-minute"
          className="memory-input"
          type="number"
          inputMode="numeric"
          min={0}
          max={59}
          step={1}
          aria-label="Minute of hour, 0 to 59"
          value={form.minute}
          onChange={(event) => set('minute', event.target.value)}
        />
      </div>
      {form.recurrenceType === 'WEEKLY' && (
        <fieldset className="chat-mode-fieldset sched-dayset-fieldset" aria-label="Weekdays to run (UTC days)">
          <legend>Weekdays</legend>
          <div className="sched-dayset">
            {WEEKDAY_OPTIONS.map((option) => (
              <label key={option.value} className="sched-dayset-option">
                <input
                  type="checkbox"
                  className="sched-dayset-input"
                  aria-label={`Run on ${option.label} weekday ${option.value}`}
                  checked={form.weekdays.includes(option.value)}
                  onChange={() => set('weekdays', toggle(form.weekdays, option.value))}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <span className="memory-hint">0 = Sunday … 6 = Saturday. At least one day, none repeated.</span>
        </fieldset>
      )}
      {form.recurrenceType === 'MONTHLY' && (
        <fieldset className="chat-mode-fieldset sched-dayset-fieldset" aria-label="Days of month to run (UTC days)">
          <legend>Days of month</legend>
          <div className="sched-dayset">
            {MONTH_DAY_OPTIONS.map((day) => (
              <label key={day} className="sched-dayset-option">
                <input
                  type="checkbox"
                  className="sched-dayset-input"
                  aria-label={`Run on day ${day} of the month`}
                  checked={form.daysOfMonth.includes(day)}
                  onChange={() => set('daysOfMonth', toggle(form.daysOfMonth, day))}
                />
                <span>{day}</span>
              </label>
            ))}
          </div>
          <span className="memory-hint">1–31; short months skip absent days. At least one day, none repeated.</span>
        </fieldset>
      )}
    </>
  );
}

