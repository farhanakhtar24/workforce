'use client';

import { useEffect, useMemo, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import {
  buildReconnectRequest,
  buildSendRequest,
  describeChatError,
  resolveApiBaseUrl,
  HYDRATION_ERROR_UNREACHABLE,
} from '@/lib/api';
import { calculateStateLabel, formatCalculateInput, parseCalculateOutput } from '@/lib/calculate';
import type { CalculateToolPart, WorkforceUIMessage } from '@/lib/messages';

export interface ChatProps {
  /** Stable chat id, owned by the URL. */
  chatId: string;
  /** Server-hydrated UIMessages (empty on hydration failure). */
  initialMessages: WorkforceUIMessage[];
  /** Whether the API reported an in-flight stream we should re-attach to. */
  hasActiveStream: boolean;
  /** Set when the hydration fetch itself failed: a safe retry hint is shown. */
  hydrationError?: string;
}

/**
 * Phase 2 chat UI. No stop button: refresh/disconnect must not abort the
 * provider generation (ADR-005), so nothing here calls abort. Mount-time
 * reconnect comes from `useChat({ resume: true })`, and the transport keeps
 * its `resumeStreamIsReplay` default — the API replays the full SSE stream
 * and the hook rebuilds the interrupted assistant message exactly once.
 */
export function Chat({
  chatId,
  initialMessages,
  hasActiveStream,
  hydrationError,
}: ChatProps): React.ReactElement {
  const apiBaseUrl = resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<WorkforceUIMessage>({
        api: `${apiBaseUrl}/api/agents/general/chat`,
        prepareSendMessagesRequest: ({ id, messages }) => {
          // Documented body: exactly `{ id, message }` with only the newest
          // user UIMessage, plus the exact idempotency header (API 400s on
          // any mismatch). No transcript is sent.
          const prepared = buildSendRequest({ apiBaseUrl, chatId: id, messages });
          return { api: prepared.url, body: prepared.body, headers: prepared.headers };
        },
        prepareReconnectToStreamRequest: ({ id }) => {
          // Resume is a GET against the Express stream route; a 204 response
          // means idle. Replay handling stays with the transport default.
          const prepared = buildReconnectRequest({ apiBaseUrl, chatId: id });
          return { api: prepared.url };
        },
      }),
    [apiBaseUrl],
  );

  const { messages, sendMessage, status, error, clearError } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
    resume: true,
    experimental_throttle: 50, // Phase 2 fixed design: ~50 ms UI updates.
  });

  const [input, setInput] = useState('');
  const [resumeNotice, setResumeNotice] = useState(hasActiveStream);

  useEffect(() => {
    // The mount-time auto-resume either streams or finds nothing; either way
    // the one-line notice is only worth showing for the initial attempt.
    if (status !== 'submitted') setResumeNotice(false);
  }, [status]);

  const busy = status === 'submitted' || status === 'streaming';
  const canSend = !busy && input.trim().length > 0;

  const submit = (): void => {
    if (!canSend) return;
    const text = input.trim();
    setInput('');
    void sendMessage({ text });
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
          <a className="chat-new" href="/">
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

      {resumeNotice && (
        <p aria-live="polite" className="chat-status chat-muted">
          Reconnecting to your in-progress reply…
        </p>
      )}

      <section aria-label="Messages" aria-live="polite" className="chat-messages">
        <ol className="chat-thread">
          {messages.map((message) => (
            <li key={message.id} className={`chat-turn chat-turn-${message.role}`}>
              <span className="chat-role">{message.role === 'user' ? 'You' : 'Assistant'}</span>
              <div className="chat-parts">
                {message.parts.map((part, index) => {
                  if (part.type === 'text') {
                    return (
                      <p key={index} className="chat-text">
                        {part.text}
                      </p>
                    );
                  }
                  if (part.type === 'tool-calculate') {
                    return <CalculatePartView key={index} part={part} />;
                  }
                  return null;
                })}
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
          placeholder="Ask about math, e.g. What is 21+21?"
          disabled={busy}
        />
        <button type="submit" disabled={!canSend}>
          Send
        </button>
      </form>
    </main>
  );
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
