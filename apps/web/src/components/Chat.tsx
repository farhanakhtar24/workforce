'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  buildReconnectRequest,
  buildSendRequest,
  describeChatError,
  isSafeChatId,
  resolveApiBaseUrl,
  HYDRATION_ERROR_UNREACHABLE,
} from '@/lib/api';
import {
  AGENT_GUIDANCE,
  WEB_AGENT_SLUGS,
  WEB_AGENT_MODES,
  buildChatUrl,
  buildNewChatUrl,
  modeGuidance,
  modeLabel,
  type AgentSelection,
  type WebAgentMode,
  type WebAgentSlug,
} from '@/lib/agents';
import {
  isWorkDocId,
  workDocPagePath,
} from '@/lib/workdocs';
import { calculateStateLabel, formatCalculateInput, parseCalculateOutput } from '@/lib/calculate';
import {
  formatAskUserInput,
  formatDelegateInput,
  formatGenericToolPart,
  formatQueryDataInput,
  formatSearchMemoryInput,
  formatWriteDocInput,
  findPendingAskUser,
  parseAskUserOutput,
  parseDelegateOutput,
  parseQueryDataOutput,
  parseSearchMemoryOutput,
  parseWriteDocOutput,
  toolStateLabel,
} from '@/lib/tools';
import {
  activitySummaryLabel,
  partitionMessageParts,
  type ActivityItem,
} from '@/lib/parts';
import { createSubmissionGate } from '@/lib/submitgate';
import type {
  AskUserToolPart,
  CalculateToolPart,
  DelegateTaskToolPart,
  QueryDataToolPart,
  SearchMemoryToolPart,
  WorkforceUIMessage,
  WriteDocToolPart,
} from '@/lib/messages';

export interface ChatProps {
  /** Stable chat id, owned by the URL. */
  chatId: string;
  /** Selected agent slug (server-validated; `general` for old URLs). */
  agent: WebAgentSlug;
  /** Selected mode (server-validated; `action` for old URLs). */
  mode: WebAgentMode;
  /** Server-hydrated UIMessages (empty on hydration failure). */
  initialMessages: WorkforceUIMessage[];
  /** Whether the API reported an in-flight stream we should re-attach to. */
  hasActiveStream: boolean;
  /** Set when the hydration fetch itself failed: a safe retry hint is shown. */
  hydrationError?: string;
}

/**
 * Phase 4 chat UI on the Phase 2 streaming core. Agent (slug) and mode
 * (plan/action) live in the URL; changing either re-navigates so the server
 * re-hydrates for that (slug, chatId) key, and the next send is a NEW
 * generation composed for the selection — there is no mid-turn escalation.
 * No stop button: refresh/disconnect must not abort the provider generation
 * (ADR-005), so nothing here calls abort. Mount-time reconnect comes from
 * `useChat({ resume: true })` with the same slug, and the transport keeps its
 * `resumeStreamIsReplay` default — the API replays the full SSE stream and
 * the hook rebuilds the interrupted assistant message exactly once.
 */
export function Chat({
  chatId,
  agent,
  mode,
  initialMessages,
  hasActiveStream,
  hydrationError,
}: ChatProps): React.ReactElement {
  const apiBaseUrl = resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL);
  const router = useRouter();
  const selection: AgentSelection = { agent, mode };

  const transport = useMemo(
    () =>
      new DefaultChatTransport<WorkforceUIMessage>({
        api: `${apiBaseUrl}/api/agents/${agent}/chat`,
        prepareSendMessagesRequest: ({ id, messages }) => {
          // Documented body: exactly `{ id, message, mode }` with only the
          // newest user UIMessage, plus the exact idempotency header (API
          // 400s on any mismatch). No transcript is sent.
          const prepared = buildSendRequest({
            apiBaseUrl,
            chatId: id,
            messages,
            slug: agent,
            mode,
          });
          return { api: prepared.url, body: prepared.body, headers: prepared.headers };
        },
        prepareReconnectToStreamRequest: ({ id }) => {
          // Resume is a GET against the Express stream route for the same
          // slug; a 204 response means idle. Replay handling stays with the
          // transport default.
          const prepared = buildReconnectRequest({ apiBaseUrl, chatId: id, slug: agent });
          return { api: prepared.url };
        },
      }),
    [apiBaseUrl, agent, mode],
  );

  const { messages, sendMessage, status, error, clearError } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
    resume: true,
    experimental_throttle: 50, // Phase 2 fixed design: ~50 ms UI updates.
  });

  const [input, setInput] = useState('');
  const [answerDraft, setAnswerDraft] = useState('');
  const [resumeNotice, setResumeNotice] = useState(hasActiveStream);

  // Synchronous single-flight submission guard. One Enter keypress or Send
  // double-click can invoke submit/submitAnswer twice in the same tick while
  // the `status`/`canSend` closure is still stale (not yet rerendered busy):
  // the guard is acquired BEFORE clearing input or calling sendMessage, so
  // any second immediate invocation is rejected. Released whenever useChat
  // is no longer submitted/streaming (ready/error) or the send promise
  // rejects; a fresh gate is created on agent/mode remount, never a
  // permanent lock. Shared by the normal and the HITL answer paths.
  const submissionGate = useMemo(() => createSubmissionGate(), []);
  useEffect(() => {
    if (status !== 'submitted' && status !== 'streaming') submissionGate.release();
  }, [status, submissionGate]);

  useEffect(() => {
    // The mount-time auto-resume either streams or finds nothing; either way
    // the one-line notice is only worth showing for the initial attempt.
    if (status !== 'submitted') setResumeNotice(false);
  }, [status]);

  const busy = status === 'submitted' || status === 'streaming';
  // HITL: an unanswered ask_user question from the newest assistant message
  // gates the normal composer; the answer form below is the channel instead
  // (its submit travels the same normal user-message path, so the API marks
  // the part output-available and the generation resumes).
  const pendingAsk = useMemo(() => findPendingAskUser(messages), [messages]);
  const inputReady = input.trim().length > 0;
  const answerReady = answerDraft.trim().length > 0;
  const canSend = !busy && pendingAsk === null && inputReady;
  const canAnswer = !busy && answerReady;

  const submit = (): void => {
    if (!submissionGate.tryStart()) return;
    if (!canSend) {
      // Nothing actually goes out (empty input / answer gate active): don't
      // hold the lock so a later valid submission can proceed.
      submissionGate.release();
      return;
    }
    const text = input.trim();
    setInput('');
    void sendMessage({ text }).catch(() => {
      // A failed send must not leave the gate locked.
      submissionGate.release();
    });
  };

  const submitAnswer = (): void => {
    if (!submissionGate.tryStart()) return;
    if (!canAnswer) {
      // Nothing actually goes out: don't hold the lock.
      submissionGate.release();
      return;
    }
    const text = answerDraft.trim();
    setAnswerDraft('');
    void sendMessage({ text }).catch(() => {
      // A failed send must not leave the gate locked.
      submissionGate.release();
    });
  };

  const navigateTo = (next: AgentSelection): void => {
    router.push(buildChatUrl(chatId, next));
  };

  const statusText =
    status === 'submitted'
      ? 'Sending…'
      : status === 'streaming'
        ? 'Responding…'
        : status === 'error'
          ? 'Something interrupted this response. You can send a new message.'
          : 'Ready';

  return (
    <main className="chat-layout">
      <header className="chat-header">
        <h1>Workforce Chat</h1>
        <nav className="chat-nav" aria-label="Workforce pages">
          <a className="chat-new" href="/memory">
            Memory
          </a>
          <a className="chat-new" href={`/work?chatId=${encodeURIComponent(chatId)}&agent=${agent}`}>
            Work
          </a>
          <a
            className="chat-new"
            href={`/delegations?chatId=${encodeURIComponent(chatId)}&agent=${agent}`}
          >
            Delegations
          </a>
          <a className="chat-new" href={buildNewChatUrl(selection)}>
            New chat
          </a>
        </nav>
      </header>

      {hydrationError !== undefined && (
        <div role="status" className="chat-banner chat-banner-warning">
          <p>{hydrationError}</p>
          <p className="chat-muted">
            You can still send a message; earlier history reappears once the service is reachable and you refresh.
          </p>
        </div>
      )}

      <section aria-label="Agent and mode" className="chat-controls">
        <div className="memory-field memory-field-grow">
          <label htmlFor="chat-agent">Agent</label>
          <select
            id="chat-agent"
            name="chat-agent"
            className="memory-input"
            aria-label="Agent"
            value={agent}
            onChange={(event) => {
              const next = event.target.value;
              if (next !== agent && (WEB_AGENT_SLUGS as readonly string[]).includes(next)) {
                navigateTo({ agent: next as WebAgentSlug, mode });
              }
            }}
          >
            {WEB_AGENT_SLUGS.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
          <p className="memory-hint">{AGENT_GUIDANCE[agent]}</p>
        </div>
        <fieldset className="chat-mode-fieldset">
          <legend>Mode for the next reply</legend>
          <div className="chat-mode-options">
            {WEB_AGENT_MODES.map((candidate) => (
              <span key={candidate} className="chat-mode-option">
                <input
                  type="radio"
                  id={`chat-mode-${candidate}`}
                  name="chat-mode"
                  value={candidate}
                  aria-label={`Mode ${modeLabel(candidate)}`}
                  checked={mode === candidate}
                  onChange={() => {
                    if (mode !== candidate) navigateTo({ agent, mode: candidate });
                  }}
                />
                <label htmlFor={`chat-mode-${candidate}`}>{modeLabel(candidate)}</label>
              </span>
            ))}
          </div>
          <p className="memory-hint">{modeGuidance(selection)}</p>
        </fieldset>
      </section>

      <p aria-live="polite" className="chat-status chat-muted">
        Chat {chatId} · agent {agent} · {mode === 'plan' ? 'Plan mode' : 'Action mode'}
      </p>

      {resumeNotice && (
        <p aria-live="polite" className="chat-status chat-muted">
          Reconnecting to your in-progress reply…
        </p>
      )}

      <section aria-label="Messages" aria-live="polite" className="chat-messages">
        <ol className="chat-thread">
          {messages.map((message, messageIndex) => (
            <li key={message.id} className={`chat-turn chat-turn-${message.role}`}>
              <span className="chat-role">{message.role === 'user' ? 'You' : 'Assistant'}</span>
              <div className="chat-parts">
                {message.role === 'assistant' ? (
                  // Assistant turns render as separated regions: Response
                  // (markdown), the pending HITL question top-level, then
                  // collapsed Thinking and Tool activity. No part renders
                  // twice and reasoning/tool results never mix into the text.
                  <AssistantPartsView
                    parts={message.parts}
                    holdsPendingAsk={pendingAsk !== null && messageIndex === messages.length - 1}
                    chatId={chatId}
                  />
                ) : (
                  message.parts.map((part, index) => {
                    if (part.type !== 'text') return null;
                    return (
                      <p key={index} className="chat-text">
                        {part.text}
                      </p>
                    );
                  })
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <p aria-live="polite" className={`chat-status chat-status-${status}`}>
        {statusText}
      </p>

      {error !== undefined && (
        <div role="alert" className="chat-banner chat-banner-error">
          <p>{describeChatError(error)}</p>
          <button type="button" onClick={() => clearError()}>
            Dismiss
          </button>
        </div>
      )}

      {pendingAsk !== null && (
        <form
          className="chat-composer chat-answer-form"
          onSubmit={(event) => {
            event.preventDefault();
            submitAnswer();
          }}
        >
          <label htmlFor="chat-answer">Your answer to the agent's question</label>
          <textarea
            id="chat-answer"
            name="chat-answer"
            aria-label="Answer to the agent's question"
            value={answerDraft}
            onChange={(event) => setAnswerDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter submits the answer; Shift+Enter keeps newlines.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitAnswer();
              }
            }}
            rows={2}
            placeholder="Type your answer here…"
            disabled={busy}
          />
          {pendingAsk.options.length > 0 && (
            <div className="chat-answer-options" role="group" aria-label="Suggested answers">
              {pendingAsk.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="memory-button"
                  aria-label={`Use suggested answer: ${option}`}
                  onClick={() => setAnswerDraft(option)}
                  disabled={busy}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <button type="submit" disabled={!canAnswer}>
            Send answer
          </button>
          <p className="memory-hint">
            The reply is sent as a normal message in this chat; the API records it as the
            question's answer and the agent continues with it.
          </p>
        </form>
      )}

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor="chat-input">Message</label>
        <textarea
          id="chat-input"
          name="chat-input"
          aria-label="Message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // Enter submits; Shift+Enter keeps the textarea newline behavior.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder={
            pendingAsk !== null
              ? "Answer the agent's question in the form above."
              : 'Ask anything, e.g. What is 21+21?'
          }
          disabled={busy || pendingAsk !== null}
        />
        <button type="submit" disabled={!canSend}>
          Send
        </button>
        {pendingAsk !== null && (
          <p className="memory-hint">
            Send is paused because the agent asked you a question above — answer it there.
            The normal message channel resumes as soon as the question is answered.
          </p>
        )}
      </form>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Assistant message regions (Phase 4 formatting fix)                  */
/* ------------------------------------------------------------------ */

/**
 * Assistant markdown region: maintained `react-markdown` + `remark-gfm`.
 * Raw HTML is deliberately NOT enabled — there is no rehype-raw and no
 * `dangerouslySetInnerHTML`; the markdown AST renders through React, which
 * escapes all text. Partial streamed markdown renders as plain prose until
 * the syntax closes, so streaming never crashes.
 */
function MarkdownText({ text, className }: { text: string; className?: string }): React.ReactElement {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

/**
 * One assistant turn as regions (from `partitionMessageParts`, pure + tested):
 * every part renders exactly once — text parts joined in original order as
 * the Response, reasoning in a collapsed-by-default Thinking block, tool
 * parts in a collapsed-by-default Tool activity block with a concise
 * summary, and the pending HITL question top-level (never inside collapsed
 * activity, never duplicated).
 */
function AssistantPartsView({
  parts,
  holdsPendingAsk,
  chatId,
}: {
  parts: WorkforceUIMessage['parts'];
  holdsPendingAsk: boolean;
  chatId: string;
}): React.ReactElement {
  const view = partitionMessageParts(parts, holdsPendingAsk);
  const summary = activitySummaryLabel(view.activity);
  return (
    <>
      {view.response !== null && <MarkdownText text={view.response} className="chat-md chat-md-response" />}
      {view.pendingAsk !== null && view.pendingAsk.type === 'tool-ask_user' && (
        <AskUserPartView part={view.pendingAsk} />
      )}
      {view.reasoning !== null && (
        <details className="chat-region">
          <summary>Thinking</summary>
          <MarkdownText text={view.reasoning} className="chat-md chat-md-thinking" />
        </details>
      )}
      {view.activity.length > 0 && (
        <details className="chat-region">
          <summary>
            Tool activity ({view.activity.length})
            {summary !== null && `: ${summary}`}
          </summary>
          <div className="chat-region-body">
            {view.activity.map((item, index) => (
              <ActivityItemView key={index} item={item} chatId={chatId} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

/**
 * Renders one collapse-region tool part with the same per-tool cards as the
 * pre-region renderer (identity preserved: the part object comes straight
 * from the message).
 */
function ActivityItemView({
  item,
  chatId,
}: {
  item: ActivityItem<WorkforceUIMessage['parts'][number]>;
  chatId: string;
}): React.ReactElement | null {
  const part = item.part;
  if (part.type === 'tool-calculate') {
    return <CalculatePartView part={part} />;
  }
  if (part.type === 'tool-write_doc') {
    return <WriteDocPartView part={part} chatId={chatId} />;
  }
  if (part.type === 'tool-delegate_task') {
    return <DelegatePartView part={part} />;
  }
  if (part.type === 'tool-query_data') {
    return <QueryDataPartView part={part} />;
  }
  if (part.type === 'tool-search_memory') {
    return <SearchMemoryPartView part={part} />;
  }
  if (part.type === 'tool-ask_user') {
    return <AskUserPartView part={part} />;
  }
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
    return (
      <GenericToolPartView view={part as { type: string; state: string; input: unknown; output?: unknown; errorText?: string }} />
    );
  }
  return null;
}

/** Tool output is currently the JSON string `{"result":14}`. Rendered as text. */
function CalculatePartView({ part }: { part: CalculateToolPart }): React.ReactElement {
  const label = calculateStateLabel(part.state);
  const expression = formatCalculateInput(part.input);
  return (
    <div className="chat-tool" data-state={part.state}>
      <span className="chat-tool-name">calculate</span>
      <p className="chat-tool-line">
        {label}
        {expression !== '(pending)' && <span className="chat-tool-expr">: {expression}</span>}
      </p>
      {part.state === 'output-available' && <CalculateResultView output={part.output} />}
      {part.state === 'output-error' && (
        <p className="chat-tool-error">{part.errorText ?? 'The calculation failed.'}</p>
      )}
    </div>
  );
}

function CalculateResultView({ output }: { output: unknown }): React.ReactElement {
  const view = parseCalculateOutput(output);
  if (view.status === 'ok') {
    return (
      <p className="chat-tool-result">
        = <strong>{view.result}</strong>
      </p>
    );
  }
  return <p className="chat-tool-result chat-tool-error">{view.text}</p>;
}

/* ------------------------------------------------------------------ */
/* write_doc                                                           */
/* ------------------------------------------------------------------ */

function WriteDocPartView({ part, chatId }: { part: WriteDocToolPart; chatId: string }): React.ReactElement {
  const inputView = formatWriteDocInput(part.input);
  const outputView = part.state === 'output-available' ? parseWriteDocOutput(part.output) : null;
  const docId =
    inputView.ok && inputView.view.docId !== null
      ? inputView.view.docId
      : outputView?.ok === true && isWorkDocId(outputView.view.documentId)
        ? outputView.view.documentId
        : null;
  return (
    <div className="chat-tool" data-state={part.state}>
      <span className="chat-tool-name">write_doc</span>
      <p className="chat-tool-line">{inputView.ok ? inputView.view.summary : inputView.text}</p>
      {inputView.ok && inputView.view.contentPreview !== null && (
        <p className="chat-tool-detail">{inputView.view.contentPreview}</p>
      )}
      {part.state === 'output-available' && outputView !== null && (
        outputView.ok ? (
          <p className="chat-tool-result">
            Saved as v{outputView.view.version} ({outputView.view.status_text ?? 'unknown status'})
            {docId !== null && isSafeChatId(chatId) && (
              <>
                {' — '}
                <a href={workDocPagePath(docId, chatId)}>open document</a>
              </>
            )}
          </p>
        ) : (
          <p className="chat-tool-result chat-tool-error">{outputView.text ?? 'The document result could not be read.'}</p>
        )
      )}
      {part.state === 'output-error' && (
        <p className="chat-tool-error">{part.errorText ?? 'The document operation failed.'}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* delegate_task                                                       */
/* ------------------------------------------------------------------ */

function DelegatePartView({ part }: { part: DelegateTaskToolPart }): React.ReactElement {
  const inputView = formatDelegateInput(part.input);
  const target = inputView.ok ? (inputView.view.targetAgent ?? '') : '';
  const outputView = part.state === 'output-available' ? parseDelegateOutput(part.output, target) : null;
  return (
    <div className="chat-tool" data-state={part.state}>
      <span className="chat-tool-name">delegate_task</span>
      {inputView.ok ? (
        <>
          <p className="chat-tool-line">
            {inputView.view.mode !== null ? `${inputView.view.mode} → ${inputView.view.targetAgent ?? '?'}` : inputView.view.targetAgent ?? '?'}
          </p>
          <p className="chat-tool-detail">{inputView.view.taskPreview}</p>
        </>
      ) : (
        <p className="chat-tool-line">{inputView.text}</p>
      )}
      {part.state === 'output-available' && outputView !== null && (
        outputView.ok ? (
          <>
            <p className="chat-tool-result">
              Delegation {outputView.view.status ?? 'unknown status'}
              {outputView.view.resultPreview !== null && ` — ${outputView.view.resultPreview}`}
              {outputView.view.errorText !== null && (
                <span className="chat-tool-error"> — {outputView.view.errorText}</span>
              )}
            </p>
            {outputView.view.childChatUrl !== null && (
              <p className="chat-tool-result">
                <a href={outputView.view.childChatUrl}>Open the child chat</a>
              </p>
            )}
          </>
        ) : (
          <p className="chat-tool-result chat-tool-error">The delegation result could not be read.</p>
        )
      )}
      {part.state === 'output-error' && (
        <p className="chat-tool-error">{part.errorText ?? 'The delegation failed.'}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* query_data                                                          */
/* ------------------------------------------------------------------ */

function QueryDataPartView({ part }: { part: QueryDataToolPart }): React.ReactElement {
  const inputView = formatQueryDataInput(part.input);
  const outputView = part.state === 'output-available' ? parseQueryDataOutput(part.output) : null;
  return (
    <div className="chat-tool" data-state={part.state}>
      <span className="chat-tool-name">query_data</span>
      <p className="chat-tool-line">{toolStateLabel(part.state)}</p>
      {inputView.ok && <pre className="chat-tool-sql">{inputView.view.sql}</pre>}
      {part.state === 'output-available' && outputView !== null && (
        outputView.ok ? (
          <>
            <p className="chat-tool-result">
              {outputView.view.rowCount !== null ? `${outputView.view.rowCount} row(s)` : 'Query finished'}
              {outputView.view.displayTruncated && ' — showing the first rows only'}
            </p>
            <div className="chat-tool-tablewrap">
              <table className="chat-tool-table">
                <thead>
                  <tr>
                    {outputView.view.columns.map((column) => (
                      <th key={column} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {outputView.view.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.cells.map((cellText, cellIndex) => (
                        <td key={cellIndex}>{cellText}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="chat-tool-result chat-tool-error">{outputView.text ?? 'The query result could not be read.'}</p>
        )
      )}
      {part.state === 'output-error' && (
        <p className="chat-tool-error">{part.errorText ?? 'The query failed or was rejected.'}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* search_memory                                                       */
/* ------------------------------------------------------------------ */

function SearchMemoryPartView({ part }: { part: SearchMemoryToolPart }): React.ReactElement {
  const inputView = formatSearchMemoryInput(part.input);
  const outputView = part.state === 'output-available' ? parseSearchMemoryOutput(part.output) : null;
  return (
    <div className="chat-tool" data-state={part.state}>
      <span className="chat-tool-name">search_memory</span>
      {inputView.ok ? (
        <p className="chat-tool-line">
          {inputView.view.query}
          {inputView.view.path !== null && ` in ${inputView.view.path}`}
        </p>
      ) : (
        <p className="chat-tool-line">{inputView.text}</p>
      )}
      {part.state === 'output-available' && outputView !== null && (
        outputView.ok ? (
          <>
            <p className="chat-tool-result">
              {outputView.view.results.length} of {outputView.view.total} result(s)
              {outputView.view.displayTruncated && ' — more were found'}
            </p>
            <ul className="chat-tool-list">
              {outputView.view.results.map((result) => (
                <li key={result.id} className="chat-tool-item">
                  <span className="chat-tool-mono">{result.path}</span> · {result.kind} · score{' '}
                  {result.score} (cosine {result.cosine}, recency {result.recency})
                  <p className="chat-tool-detail">{result.contentPreview}</p>
                </li>
              ))}
            </ul>
            <p className="chat-tool-result">
              <a href="/memory">Open the memory workspace</a>
            </p>
          </>
        ) : (
          <p className="chat-tool-result chat-tool-error">{outputView.text ?? 'The search result could not be read.'}</p>
        )
      )}
      {part.state === 'output-error' && (
        <p className="chat-tool-error">{part.errorText ?? 'The memory search failed.'}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ask_user (HITL) — the composer is the answer channel                */
/* ------------------------------------------------------------------ */

function AskUserPartView({ part }: { part: AskUserToolPart }): React.ReactElement {
  const inputView = formatAskUserInput(part.input);
  const answered =
    part.state === 'output-available' ? parseAskUserOutput(part.output) : null;
  return (
    <div className="chat-tool chat-tool-ask" data-state={part.state} role="status" aria-live="polite">
      {part.state === 'input-available' ? (
        <>
          <p className="chat-tool-ask-label" aria-hidden="true">
            The agent asks you
          </p>
          {inputView.ok ? (
            <>
              <p className="chat-tool-ask-question">{inputView.view.question}</p>
              {inputView.view.options.length > 0 && (
                <ul className="chat-tool-list">
                  {inputView.view.options.map((option) => (
                    <li key={option} className="chat-tool-item">
                      {option}
                    </li>
                  ))}
                </ul>
              )}
              <p className="chat-tool-ask-hint">
                Answer in the reply form below — it is sent as a normal message, recorded as this
                question's answer, and the agent continues with it.
              </p>
            </>
          ) : (
            <p className="chat-tool-line">{inputView.text}</p>
          )}
        </>
      ) : part.state === 'output-available' ? (
        <>
          <p className="chat-tool-ask-label" aria-hidden="true">
            Agent question
          </p>
          {inputView.ok && <p className="chat-tool-ask-question">{inputView.view.question}</p>}
          {answered !== null ? (
            answered.ok ? (
              <p className="chat-tool-result">Your answer: {answered.answer}</p>
            ) : (
              <p className="chat-tool-result chat-tool-error">
                {answered.text ?? 'The recorded answer could not be read.'}
              </p>
            )
          ) : (
            <p className="chat-tool-result chat-tool-error">The recorded answer could not be read.</p>
          )}
        </>
      ) : (
        <>
          <span className="chat-tool-name">ask_user</span>
          <p className="chat-tool-line">{toolStateLabel(part.state)}</p>
          {part.state === 'output-error' && (
            <p className="chat-tool-error">{part.errorText ?? 'The question could not be prepared.'}</p>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Generic fallback for unknown tool-* parts                           */
/* ------------------------------------------------------------------ */

function GenericToolPartView({ view }: { view: { type: string; state: string; input: unknown; output?: unknown; errorText?: string } }): React.ReactElement {
  const generic = formatGenericToolPart(view);
  return (
    <div className="chat-tool" data-state={view.state}>
      <span className="chat-tool-name">tool: {generic.name}</span>
      <p className="chat-tool-line">{generic.stateLabel}</p>
      {generic.inputText !== null && <p className="chat-tool-detail">Input: {generic.inputText}</p>}
      {generic.outputText !== null && <p className="chat-tool-detail">Output: {generic.outputText}</p>}
      {generic.errorText !== null && <p className="chat-tool-error">{generic.errorText}</p>}
    </div>
  );
}
