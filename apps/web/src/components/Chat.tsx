'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { GitBranch, Info, Loader2, Send, Sparkles, Undo2, WifiOff } from 'lucide-react';
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
  isAgentMode,
  modeReplaceHistoryState,
  buildChatUrl,
  buildNewChatUrl,
  modeGuidance,
  modeLabel,
  type AgentSelection,
  type WebAgentMode,
  type WebAgentSlug,
} from '@/lib/agents';
import { browserChatFetch } from '@/lib/api';
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
import { AgentAvatar } from '@/components/AgentAvatar';
import { WorkspaceGate } from '@/components/WorkspaceShell';
import { MarkdownText } from '@/components/MarkdownText';
import { ModelPicker } from '@/components/ModelPicker';
import { SessionRail } from '@/components/SessionRail';
import { agentLabel, chatSuggestions } from '@/lib/workspace';
import {
  LONG_WAIT_TEXT,
  OFFLINE_BODY,
  OFFLINE_BUSY_BODY,
  OFFLINE_TITLE,
  deriveProgressStage,
  formatElapsed,
  isLongWait,
  progressLabel,
} from '@/lib/chat-progress';
import { CHATS_CHANGED_EVENT } from '@/lib/recent-chats';
import { railUsageLatest } from '@/lib/session-rail';
import {
  fetchChatModel,
  fetchModelCatalog,
  fetchModelDetails,
  MODEL_SELECTION_ERROR,
  MODEL_FIELD_UNKNOWN,
  putChatModel,
  type ModelCatalogResult,
  type ModelDetailsInfo,
  type ModelInfo,
} from '@/lib/models';
import {
  fetchChatUsage,
  usageFromMetadata,
  type UsageSummary,
} from '@/lib/chat-usage';
import {
  branchChat,
  branchDestinationHref,
  canTriggerChatMutations,
  CHAT_REWIND_ACTIVE,
  CHAT_REWIND_ERROR,
  CHAT_REWIND_NOT_FOUND,
  messagePreviewText,
  notifyChatsChanged,
  rewindChat,
  rewindLocalSlice,
} from '@/lib/chat-mutations';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
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
  /** Initial mode (server-validated from the URL); Plan is the default. */
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
  // Mode is client-in-place state (Farhan flicker fix): the page passes the
  // initial value; switching Plan/Action updates state + shallow URL without
  // remounting. Agent switches remain real navigation (keyed by slug+chatId).
  const [activeMode, setActiveMode] = useState<WebAgentMode>(mode);
  const activeModeRef = useRef<WebAgentMode>(activeMode);
  useEffect(() => {
    activeModeRef.current = activeMode;
  }, [activeMode]);
  // Genuine navigation (agent switch / deep link) supplies a new initial
  // mode; adopt it. In-place switches keep state untouched.
  useEffect(() => {
    if (mode !== activeModeRef.current && isAgentMode(mode)) {
      setActiveMode(mode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  const selection: AgentSelection = { agent, mode: activeMode };

  const transport = useMemo(
    () =>
      new DefaultChatTransport<WorkforceUIMessage>({
        api: `${apiBaseUrl}/api/agents/${agent}/chat`,
        // Session cookies on every send + resume request (the API is
        // session-authenticated; CORS is credentials-safe).
        fetch: browserChatFetch,
        prepareSendMessagesRequest: ({ id, messages }) => {
          // Documented body: exactly `{ id, message, mode }` with only the
          // newest user UIMessage, plus the exact idempotency header (API
          // 400s on any mismatch). No transcript is sent.
          const prepared = buildSendRequest({
            apiBaseUrl,
            chatId: id,
            messages,
            slug: agent,
            // In-place mode state read at send time; the transport stays
            // stable so useChat never resets across Plan/Action switches.
            mode: activeModeRef.current,
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
    // Note: `mode` is intentionally NOT a dependency — the prepared request
    // body reads the in-place ref, so switching mode never recreates the
    // transport (which would reset useChat state).
    [apiBaseUrl, agent],
  );

  const { messages, sendMessage, setMessages, status, error, clearError } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
    resume: true,
    experimental_throttle: 50, // Phase 2 fixed design: ~50 ms UI updates.
  });

  const [input, setInput] = useState('');
  const [answerDraft, setAnswerDraft] = useState('');
  const [resumeNotice, setResumeNotice] = useState(hasActiveStream);
  // Focus target so an empty-state suggestion can fill the composer without
  // auto-sending and hand focus back to the textarea.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const fillInput = (text: string): void => {
    setInput(text);
    inputRef.current?.focus();
  };

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

  // Transcript scroll triggers (deliberately simple, no scroll listeners):
  // 1) on mount, land at the latest turn of a resumed/long chat;
  // 2) when a send is submitted — the user's own send, or the mount-time
  //    resume re-attaching — catch up to the growing end.
  // There is NO continuous auto-scroll while streaming, so the reading
  // position never moves under the user; the composer and status line stay
  // visible regardless because the dock is pinned below the transcript.
  const transcriptRef = useRef<HTMLElement | null>(null);

  const scrollToBottom = (): void => {
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  // Scroll exactly once when a nonempty transcript FIRST becomes available
  // for this mounted chat (chatId/remount resets the flag). initialMessages
  // can arrive after the first mount, and `messages` updates with the ~50 ms
  // throttle, so the flag makes this both late-safe and cheap: later appends
  // (streaming) are no-ops and never yank the user's reading position.
  // Own sends still catch up via the `status === 'submitted'` effect below.
  const initialScrollDoneRef = useRef(false);

  useEffect(() => {
    if (!initialScrollDoneRef.current && messages.length > 0) {
      initialScrollDoneRef.current = true;
      scrollToBottom();
    }
  }, [messages]);

  useEffect(() => {
    if (status === 'submitted') scrollToBottom();
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

  /**
   * Agent selection is a navigation (server re-hydrates the (slug, chatId)
   * transcript); the current IN-PLACE mode rides along so the URL stays
   * canonical. Mode selection is handled separately by setModeInPlace, never
   * by navigation.
   */
  const navigateTo = (next: AgentSelection): void => {
    if (next.agent === agent) {
      setModeInPlace(next.mode);
      return;
    }
    router.push(buildChatUrl(chatId, { agent: next.agent, mode: activeModeRef.current }));
  };

  /**
   * In-place Plan/Action switch: update state, then a shallow URL
   * replacement that carries the Next.js router state (no RSC fetch, no
   * Chat remount — draft, messages and scroll survive).
   */
  const setModeInPlace = (next: WebAgentMode): void => {
    if (next === activeMode) return;
    setActiveMode(next);
    const url = buildChatUrl(chatId, { agent, mode: next });
    if (typeof window === 'undefined') return;
    window.history.replaceState(modeReplaceHistoryState(window.history.state, url), '', url);
  };

  const statusText =
    status === 'submitted'
      ? 'Sending…'
      : status === 'streaming'
        ? 'Responding…'
        : status === 'error'
          ? 'Something interrupted this response. You can send a new message.'
          : 'Ready';

  // Online/offline awareness: immediate honest warnings, no auto-resume claim.
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setOnline(window.navigator.onLine);
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Busy elapsed clock: starts at the first busy render, resets on settle.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const busyStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (busy) {
      if (busyStartRef.current === null) busyStartRef.current = Date.now();
      const start = busyStartRef.current;
      const tick = (): void =>
        setElapsedSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
      tick();
      const timer = window.setInterval(tick, 1000);
      return () => {
        window.clearInterval(timer);
      };
    }
    if (busyStartRef.current !== null) {
      busyStartRef.current = null;
      setElapsedSeconds(0);
    }
  }, [busy]);

  // The current streaming generation's assistant turn (if any): drives the
  // live stage and the live Thinking panel without touching the reader.
  // Stage parts come from the CURRENT turn only: while the newest message is
  // still the user's fresh submission, no assistant parts apply (pure
  // "Sending/Waiting" copy), so previous turns never fake activity.
  const latestIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'assistant') return index;
    }
    return -1;
  }, [messages]);
  const progress = useMemo(() => {
    if (!busy) return null;
    const latest = messages.length > 0 ? messages[messages.length - 1] : null;
    return deriveProgressStage({
      status: status === 'streaming' ? 'streaming' : 'submitted',
      parts: latest?.role === 'assistant' ? latest.parts : [],
    });
  }, [busy, status, messages]);
  const stageLine =
    busy && progress !== null ? progressLabel(progress) : statusText;


  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const usageSeqRef = useRef(0);
  const usageLoadingRef = useRef(false);

  const loadUsage = useCallback(async (): Promise<void> => {
    if (usageLoadingRef.current) return; // sequence guard: never overlap
    usageLoadingRef.current = true;
    const seq = ++usageSeqRef.current;
    const result = await fetchChatUsage({ apiBaseUrl, slug: agent, chatId });
    if (seq !== usageSeqRef.current) {
      usageLoadingRef.current = false;
      return;
    }
    usageLoadingRef.current = false;
    if (result.ok) {
      setUsage(result.summary);
      setUsageError(null);
    } else {
      // Non-fatal and honest: the panel shows the fixed safe reason.
      setUsageError(result.error);
    }
  }, [apiBaseUrl, agent, chatId]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  // One real-data refresh per settled generation: the history region
  // (RecentChats) listens for this event. Fired once for ready/error settles
  // that left messages — never per token, never on a quiet mount.
  const hadBusyRef = useRef(false);
  useEffect(() => {
    if (busy) {
      hadBusyRef.current = true;
      return;
    }
    if (!hadBusyRef.current) return;
    hadBusyRef.current = false;
    if (messages.length > 0) {
      window.dispatchEvent(new CustomEvent(CHATS_CHANGED_EVENT));
      // Usage refreshes once per settled turn (never per token).
      void loadUsage();
    }
  }, [busy, messages]);

  /* ------------------------------------------------------------------ */
  /* Message mutations (branch / rewind)                                  */
  /* ------------------------------------------------------------------ */

  // Mutations are disabled while busy or HITL-pending (pure helper, tested).
  const mutationsAllowed = canTriggerChatMutations({ busy, pendingAsk: pendingAsk !== null });
  const [mutating, setMutating] = useState(false);
  // The destructive rewind always confirms: who is selected, what stays and
  // what goes, and that raw bytes of kept messages are untouched.
  const [rewindTarget, setRewindTarget] = useState<{ messageIndex: number } | null>(null);
  const rewindDialogRef = useRef<HTMLDialogElement | null>(null);

  const openRewind = useCallback((messageIndex: number): void => {
    setRewindTarget({ messageIndex });
    // The dialog is always mounted, so showModal() is safe synchronously —
    // same as the working RecentChats pattern (rAF was unreliable in the
    // real browser and never opened the confirmation).
    rewindDialogRef.current?.showModal();
  }, []);

  const closeRewind = useCallback((): void => {
    if (mutating) return;
    rewindDialogRef.current?.close();
    setRewindTarget(null);
  }, [mutating]);

  const startBranch = useCallback(
    async (messageIndex: number): Promise<void> => {
      if (!mutationsAllowed || mutating) return;
      const target = messages[messageIndex];
      if (target === undefined) return;
      setMutating(true);
      try {
        // Cryptographically random destination id; the API rejects a
        // destination collision with a fixed 409 copy if it ever collides.
        const newChatId = crypto.randomUUID();
        const result = await branchChat({
          apiBaseUrl,
          slug: agent,
          chatId,
          messageId: target.id,
          newChatId,
        });
        if (result.ok) {
          notifyChatsChanged();
          // Canonical same-agent/same-mode destination; client-side
          // navigation mounts a fresh useChat there (new transcript).
          void router.push(branchDestinationHref(result.destinationChatId, agent, activeMode));
          return;
        }
        // Fixed mutation error surfaced through the existing chat error chip.
        setMutationError(result.error);
      } finally {
        setMutating(false);
      }
    },
    [mutationsAllowed, mutating, messages, apiBaseUrl, agent, chatId, activeMode, router],
  );

  const confirmRewind = useCallback(async (): Promise<void> => {
    if (rewindTarget === null || mutating) return;
    const target = messages[rewindTarget.messageIndex];
    if (target === undefined) return;
    setMutating(true);
    try {
      const result = await rewindChat({
        apiBaseUrl,
        slug: agent,
        chatId,
        messageId: target.id,
      });
      if (result.ok) {
        rewindDialogRef.current?.close();
        setRewindTarget(null);
        // Clean local rebuild: `kept` counts the exact server-side remainder,
        // so trimming local state to the same prefix guarantees useChat never
        // retains deleted messages (raw bytes intact server-side). This is
        // the in-place remount of the SAME chat id — no extra request needed.
        setMessages(rewindLocalSlice(messages, result.kept));
        // The history row's preview/count changed for this chat.
        notifyChatsChanged();
        return;
      }
      setMutationError(result.error);
      if (result.error === CHAT_REWIND_ACTIVE || result.error === CHAT_REWIND_NOT_FOUND || result.error === CHAT_REWIND_ERROR) {
        rewindDialogRef.current?.close();
        setRewindTarget(null);
      }
    } finally {
      setMutating(false);
    }
  }, [rewindTarget, mutating, messages, apiBaseUrl, agent, chatId]);

  const [mutationError, setMutationError] = useState<string | null>(null);
  // Right session-context rail: static column on lg+ screens; labelled toggle
  // opens it as an overlay drawer below that.
  const [railOpen, setRailOpen] = useState(false);
  // Desktop rail (lg+): user-collapsible; default expanded.
  const [railCollapsed, setRailCollapsed] = useState(false);

  /* ------------------------------------------------------------------ */
  /* Model catalog + per-chat model selection                            */
  /* ------------------------------------------------------------------ */

  const [catalog, setCatalog] = useState<ModelCatalogResult | null>(null);
  const [modelsDefaultId, setModelsDefaultId] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const currentModelRef = useRef(0);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [modelSaving, setModelSaving] = useState(false);
  const detailsCacheRef = useRef(new Map<string, ModelDetailsInfo>());
  const detailsSeqRef = useRef(0);
  const [detailModelId, setDetailModelId] = useState<string | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const loadCatalog = useCallback(async (): Promise<void> => {
    const seq = ++currentModelRef.current;
    setCatalogLoading(true);
    const result = await fetchModelCatalog({ apiBaseUrl });
    if (seq !== currentModelRef.current) return;
    setCatalogLoading(false);
    setCatalog(result.ok ? result : { ok: false, error: result.error, status: result.status });
    setModelsDefaultId(result.ok ? result.defaultModelId : null);
  }, [apiBaseUrl]);

  const loadCurrentModel = useCallback(async (): Promise<void> => {
    const result = await fetchChatModel({ apiBaseUrl, slug: agent, chatId });
    if (result.ok) setCurrentModel(result.modelId);
  }, [apiBaseUrl, agent, chatId]);

  useEffect(() => {
    void loadCatalog();
    void loadCurrentModel();
  }, [loadCatalog, loadCurrentModel]);

  const applyModel = useCallback(
    async (modelId: string): Promise<void> => {
      if (modelSaving) return;
      setModelSaving(true);
      try {
        const result = await putChatModel({ apiBaseUrl, slug: agent, chatId, modelId });
        if (result.ok) {
          setCurrentModel(result.modelId);
          loadCurrentModel();
          setModelSaving(false);
          return;
        }
        setMutationError(result.error);
        setCurrentModel(null);
        setModelSaving(false);
        void loadCurrentModel();
      } catch {
        setMutationError(MODEL_SELECTION_ERROR);
        setModelSaving(false);
      }
    },
    [modelSaving, apiBaseUrl, agent, chatId, loadCurrentModel],
  );

  // Lazy details: fetched on hover AND keyboard focus of the model select or
  // the details affordance, cached per model id, request-sequence guarded.
  const ensureModelDetails = useCallback(
    (modelId: string): void => {
      if (detailsCacheRef.current.has(modelId)) {
        setDetailModelId(modelId);
        setDetailsLoading(false);
        return;
      }
      const seq = ++detailsSeqRef.current;
      setDetailModelId(modelId);
      setDetailsLoading(true);
      void fetchModelDetails({ apiBaseUrl, modelId }).then((result) => {
        if (seq !== detailsSeqRef.current) return; // superseded
        if (result.ok) {
          detailsCacheRef.current.set(modelId, result.details);
        } else {
          detailsCacheRef.current.set(modelId, {
            modelId,
            contextLength: null,
            capabilities: null,
            parameterSize: null,
            thinking: null,
            pricing: null,
          });
        }
        setDetailsLoading(false);
      });
    },
    [apiBaseUrl],
  );

  const activeDetails = detailModelId !== null ? (detailsCacheRef.current.get(detailModelId) ?? null) : null;

  // Prefetch details for the CURRENT model so the rail context % is real.
  useEffect(() => {
    if (currentModel !== null && currentModel !== '') ensureModelDetails(currentModel);
  }, [currentModel, ensureModelDetails]);
  const activeModelInfo: ModelInfo | null =
    detailModelId !== null
      ? (catalog?.ok
          ? (catalog.models.find((m) => m.id === detailModelId) ?? null)
          : null)
      : null;

  /* ------------------------------------------------------------------ */
  /* Session usage (exact totals, honest cost)                           */
  /* ------------------------------------------------------------------ */


  const rewindTargetMessage = rewindTarget !== null ? messages[rewindTarget.messageIndex] : undefined;
  const rewindPreview = rewindTargetMessage !== undefined ? messagePreviewText(rewindTargetMessage.parts) : '';



  // Quiet header model label (default or selected id; honest when absent).
  const currentModelLabel =
    currentModel !== null
      ? currentModel
      : catalog?.ok === true && modelsDefaultId !== null
        ? modelsDefaultId
        : null;
  // Details for the rail/context card: the rail's context metric must use
  // the LATEST ASSISTANT'S ACTUAL model, never the selected next-turn model.
  const railUsageMeta = railUsageLatest(messages);
  const railModelId = railUsageMeta?.modelId ?? null;
  const railDetails =
    railModelId !== null ? (detailsCacheRef.current.get(railModelId) ?? null) : null;
  useEffect(() => {
    if (railModelId !== null) ensureModelDetails(railModelId);
  }, [railModelId, ensureModelDetails]);
  // THE single composer instance (ids/aria/handlers unchanged): rendered
  // centered inside the greeting block on an empty transcript, and pinned in
  // the bottom dock once the chat is populated. Exactly one of the two is
  // mounted at any time — never two forms.
  const composerForm = (
    <form
      className="rounded-2xl border border-input bg-card shadow-xs"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Label htmlFor="chat-input" className="sr-only">
        Message
      </Label>
      <Textarea
        id="chat-input"
        name="chat-input"
        aria-label="Message"
        ref={inputRef}
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
        className="min-h-20 rounded-2xl rounded-bl-none rounded-br-none border-x-0 border-t-0 border-b bg-transparent px-3.5 py-3 focus-visible:border-b focus-visible:border-input md:min-h-24"
        placeholder={
          pendingAsk !== null
            ? "Answer the agent's question in the form above."
            : 'Ask anything, e.g. What is 21+21?'
        }
        disabled={busy || pendingAsk !== null}
      />
      {/* Composer control row (Farhan): model picker + agent + Plan/Action.
          Same navigation/PUT semantics as before — moving only changed homes. */}
      <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2">
        <ModelPicker
          models={catalog?.ok ? catalog.models : []}
          catalogError={catalogLoading ? null : catalog?.ok === false ? catalog.error : null}
          loading={catalogLoading}
          value={currentModel}
          disabled={busy || pendingAsk !== null || modelSaving}
          saving={modelSaving}
          detailsLoading={detailsLoading}
          ensureDetails={ensureModelDetails}
          getDetails={(id) => detailsCacheRef.current.get(id) ?? null}
          onSelect={(id) => void applyModel(id)}
        />
        <AgentAvatar agent={agent} size={22} />
        <select
          id="chat-agent"
          name="chat-agent"
          aria-label="Agent"
          title="Agent"
          value={agent}
          disabled={busy || pendingAsk !== null}
          onChange={(event) => {
            const next = event.target.value;
            if (next !== agent && (WEB_AGENT_SLUGS as readonly string[]).includes(next)) {
              navigateTo({ agent: next as WebAgentSlug, mode: activeMode });
            }
          }}
          className="h-8 max-w-[10rem] rounded-md border border-input bg-transparent px-2 text-[0.82rem] text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {WEB_AGENT_SLUGS.map((slug) => (
            <option key={slug} value={slug}>
              {agentLabel(slug)}
            </option>
          ))}
        </select>
        <fieldset className="m-0 inline-flex items-center rounded-full border border-input bg-muted p-0.5">
          <legend className="sr-only">Mode for the next reply</legend>
          <div className="inline-flex gap-0.5">
            {WEB_AGENT_MODES.map((candidate) => (
              <span key={candidate} className="inline-flex">
                <input
                  type="radio"
                  id={`chat-mode-${candidate}`}
                  name="chat-mode"
                  value={candidate}
                  className="peer sr-only"
                  aria-label={`Mode ${modeLabel(candidate)}`}
                  checked={activeMode === candidate}
                  onChange={() => {
                    if (activeMode !== candidate) setModeInPlace(candidate);
                  }}
                />
                <label
                  htmlFor={`chat-mode-${candidate}`}
                  className="cursor-pointer rounded-full px-3 py-0.5 text-[0.8rem] font-medium text-muted-foreground transition-colors peer-checked:bg-background peer-checked:font-semibold peer-checked:text-foreground peer-checked:shadow-xs peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring"
                >
                  {modeLabel(candidate)}
                </label>
              </span>
            ))}
          </div>
        </fieldset>
        <span className="ml-auto" aria-hidden="true" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-border px-2 py-1.5">
        <p className="m-0 pl-1 text-[0.7rem] text-muted-foreground">
          Enter to send · Shift+Enter for a new line
        </p>
        <Button type="submit" size="sm" disabled={!canSend}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
          {busy ? 'Working…' : 'Send'}
        </Button>
      </div>
      {pendingAsk !== null && (
        <p className="m-0 text-xs text-muted-foreground">
          Send is paused because the agent asked you a question above — answer it there.
          The normal message channel resumes as soon as the question is answered.
        </p>
      )}
    </form>
  );

  return (
    <WorkspaceGate
      variant="chat"
      active="chat"
      eyebrow="Agent workspace"
      title={agentLabel(agent)}
      newChatHref={buildNewChatUrl(selection)}
      // Deep links into Work/Delegations keep the old chat-context behavior:
      // the nav carries this chat id + agent so scoped filtering survives.
      contextQuery={`chatId=${encodeURIComponent(chatId)}&agent=${agent}`}
    >
      {/* Three-column workspace: left shell rail (outside), flexible center
          transcript/composer, right Session context rail (lg+ static, below
          lg a labelled-toggle overlay drawer). Center keeps transcript-only
          scrolling with the pinned composer. */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="mx-auto flex min-h-0 w-full max-w-[52.8rem] flex-1 flex-col px-4 pb-3 md:px-4">

      {hydrationError !== undefined && (
        <div
          role="status"
          className="shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-950 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="m-0">{hydrationError}</p>
          <p className="m-0 mt-1 text-[0.85rem] text-amber-800 dark:text-amber-200/80">
            You can still send a message; earlier history reappears once the service is reachable and you refresh.
          </p>
        </div>
      )}

      {/* Quiet center header: identity + right-pane toggle only. All
          composer controls (agent/plan/action/model) live in the control row
          of the single composer; session context lives in the right rail. */}
      <div className="mb-1 flex shrink-0 items-center justify-between gap-2">
        <p
          aria-live="polite"
          className="m-0 min-w-0 truncate text-xs text-muted-foreground"
        >
          {agentLabel(agent)} · {activeMode === 'plan' ? 'Plan mode' : 'Action mode'} · {currentModelLabel ?? 'Model: not selected'}
        </p>
        {/* Two responsive siblings in the same slot: desktop controls the
            collapsible rail (railCollapsed), small screens control the
            drawer (railOpen). Only one renders at any breakpoint, so no
            duplicate button is visible. */}
        <button
          type="button"
          className="hidden size-7 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:inline-flex"
          aria-label={railCollapsed ? 'Show session context panel' : 'Hide session context panel'}
          aria-expanded={railCollapsed ? 'false' : 'true'}
          aria-controls="ws-session-rail-desktop"
          title={railCollapsed ? 'Show session context panel' : 'Hide session context panel'}
          onClick={() => setRailCollapsed((v) => !v)}
        >
          <Info size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
          aria-label={
            railOpen ? 'Close session context panel' : 'Show session context panel'
          }
          aria-expanded={railOpen ? 'true' : 'false'}
          aria-controls="ws-session-rail-drawer"
          title={railOpen ? 'Close session context panel' : 'Show session context panel'}
          onClick={() => setRailOpen((v) => !v)}
        >
          <Info size={14} aria-hidden="true" />
        </button>
      </div>

      {resumeNotice && (
        <p
          aria-live="polite"
          className="m-0 min-h-5 shrink-0 text-xs text-muted-foreground"
        >
          Reconnecting to your in-progress reply…
        </p>
      )}

      {!online && (
        <div
          role="status"
          className="shrink-0 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="m-0 flex items-center gap-1.5 font-semibold">
            <WifiOff className="size-4" aria-hidden="true" />
            {OFFLINE_TITLE}
          </p>
          <p className="m-0 mt-1 text-[0.82rem] leading-snug">{OFFLINE_BODY}</p>
          {busy && <p className="m-0 mt-1 text-[0.82rem] leading-snug">{OFFLINE_BUSY_BODY}</p>}
        </div>
      )}

      <section
        aria-label="Messages"
        aria-live="polite"
        ref={transcriptRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain py-4"
      >
        {messages.length === 0 ? (
          // ChatGPT-calm empty state: centered greeting, THE composer right
          // under it, suggestion chips below. One form instance only.
          <div className="my-auto flex flex-col items-center gap-4 py-8 text-center">
            <h2 className="m-0 text-[1.7rem] leading-tight font-normal tracking-tight">
              What should we accomplish?
            </h2>
            <p className="sr-only">{AGENT_GUIDANCE[agent]}</p>
            <div className="w-full max-w-[40rem]">{composerForm}</div>
            <ul className="m-0 mt-1 flex w-full max-w-[36rem] list-none flex-col items-center gap-2 p-0 sm:flex-row sm:flex-wrap sm:justify-center">
              {chatSuggestions(agent).map((suggestion) => (
                <li key={suggestion} className="sm:max-w-[21rem]">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto justify-start rounded-xl py-2 text-left font-normal text-[0.85rem] hover:border-ring/50 hover:bg-accent"
                    onClick={() => fillInput(suggestion)}
                  >
                    {suggestion}
                  </Button>
                </li>
              ))}
            </ul>
            <p className="m-0 text-[0.72rem] text-muted-foreground">
              A suggestion fills the composer — review it, edit, then send when ready.
            </p>
          </div>
        ) : (
          <>
          <ol className="m-0 flex list-none flex-col gap-5 p-0">
            {messages.map((message, messageIndex) => (
              <li
                key={message.id}
                className={cn(
                  'group/msg min-w-0 flex flex-col',
                  message.role === 'user' && 'items-end',
                )}
              >
                {message.role === 'assistant' ? (
                  <div className="mb-1 flex items-center gap-2">
                    <AgentAvatar agent={agent} size={22} />
                    <span className="text-[0.7rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                      Assistant
                    </span>
                    {(() => {
                      const usage = usageFromMetadata(message.metadata);
                      if (usage === null) return null;
                      return (
                        <details className="ml-auto">
                          <summary
                            className="cursor-pointer list-none rounded-full border px-2 py-0.5 text-[0.62rem] text-muted-foreground"
                            title="Per-message token usage and model"
                          >
                            {usage.modelId !== null ? `${usage.modelId} · ` : ''}
                            {usage.inputTokens.toLocaleString('en-US')} / {usage.outputTokens.toLocaleString('en-US')}
                            {usage.totalTokens !== null ? ` · ${usage.totalTokens.toLocaleString('en-US')}` : ''}
                          </summary>
                          <div className="mt-1 rounded-md border bg-card px-2.5 py-1.5 text-[0.72rem] text-muted-foreground">
                            <p className="m-0">Input: {usage.inputTokens.toLocaleString('en-US')}</p>
                            <p className="m-0">Output: {usage.outputTokens.toLocaleString('en-US')}</p>
                            {usage.totalTokens !== null && (
                              <p className="m-0">Total: {usage.totalTokens.toLocaleString('en-US')}</p>
                            )}
                            {usage.modelId !== null && <p className="m-0">Model: {usage.modelId}</p>}
                            {usage.modelId === null && <p className="m-0">Model not reported</p>}
                          </div>
                        </details>
                      );
                    })()}
                  </div>
                ) : (
                  <span className="mb-1 text-[0.7rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                    You
                  </span>
                )}
                <div className="min-w-0">
                  {message.role === 'assistant' ? (
                    // Assistant turns render as separated regions: Response
                    // (markdown), the pending HITL question top-level, then
                    // collapsed Thinking and Tool activity. No part renders
                    // twice and reasoning/tool results never mix into the text.
                    <AssistantPartsView
                      parts={message.parts}
                      holdsPendingAsk={pendingAsk !== null && messageIndex === messages.length - 1}
                      holdsLiveThinking={
                        busy && messageIndex === latestIndex && messageIndex === messages.length - 1
                      }
                      chatId={chatId}
                    />
                  ) : (
                    <div className="max-w-[85%] rounded-2xl rounded-br-md border border-user-bubble-border bg-user-bubble px-3.5 py-2 sm:max-w-[32rem]">
                      {message.parts.map((part, index) => {
                        if (part.type !== 'text') return null;
                        return (
                          <p key={index} className="m-0 wrap-anywhere whitespace-pre-wrap break-words">
                            {part.text}
                          </p>
                        );
                      })}
                    </div>
                  )}
                </div>
                {/* Compact mutation actions: hover/focus reveal on pointer
                    devices, always reachable (focusable) on touch. Branch is
                    non-destructive; rewind appears on USER messages and is
                    confirmed before destroying anything. */}
                <div
                  className={cn(
                    'mt-1 flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within/msg:opacity-100 sm:group-hover/msg:opacity-100',
                    message.role === 'user' ? 'justify-end' : 'justify-start',
                  )}
                >
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="Branch from here — copies this message and everything before it into a new chat; this chat stays intact."
                    title="Branch from here — new chat, original stays intact"
                    disabled={!mutationsAllowed || mutating}
                    onClick={() => void startBranch(messageIndex)}
                  >
                    <GitBranch size={13} aria-hidden="true" />
                  </button>
                  {message.role === 'user' && (
                    <button
                      type="button"
                      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                      aria-label="Rewind here — keeps this message, deletes everything after it. Asking for confirmation."
                      title="Rewind here — deletes everything after this message"
                      disabled={!mutationsAllowed || mutating}
                      onClick={() => openRewind(messageIndex)}
                    >
                      <Undo2 size={13} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {/* Helper copy for the message-level controls (kept to one line). */}
          <p className="m-0 text-[0.7rem] text-muted-foreground">
            Hover a message for Branch / Rewind — branching copies the transcript into a new chat and
            keeps this one intact; to replace an answer, rewind to its question and send an edited resend.
          </p>
          </>
        )}
        {busy && progress !== null && (
          <div
            aria-hidden="true"
            className="mt-3 flex items-center gap-2 text-[0.85rem] text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            <span>{progressLabel(progress)}</span>
            <span className="tabular-nums">{formatElapsed(elapsedSeconds)}</span>
            <span className="ml-0.5 flex items-center gap-0.5">
              <span className="size-1 animate-pulse rounded-full bg-muted-foreground" />
              <span className="size-1 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: '200ms' }} />
              <span className="size-1 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: '400ms' }} />
            </span>
          </div>
        )}
      </section>

      <p
        aria-live="polite"
        className={cn(
          'm-0 flex min-h-5 shrink-0 items-center gap-2 text-xs text-muted-foreground',
          `chat-status-${status}`,
        )}
      >
        {busy && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}
        <span>{stageLine}</span>
        {/* Elapsed ticks every second: hidden from assistive tech so the
            polite status region does not re-announce the whole line. Stage
            changes still announce as they arrive. */}
        {busy && (
          <span aria-hidden="true" className="shrink-0 tabular-nums">
            {formatElapsed(elapsedSeconds)}
          </span>
        )}
      </p>

      {busy && isLongWait(elapsedSeconds) && (
        <p role="status" className="m-0 shrink-0 text-xs text-amber-800 dark:text-amber-200">
          {LONG_WAIT_TEXT}
        </p>
      )}

      {error !== undefined && (
        <div
          role="alert"
          className="flex shrink-0 items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
        >
          <div className="min-w-0">
            <p className="m-0 font-semibold">Response failed</p>
            <p className="m-0 mt-0.5">{describeChatError(error)}</p>
            <p className="m-0 mt-0.5 text-[0.8rem] text-red-800 dark:text-red-200">
              {online
                ? 'Guidance: check your internet connection, then send a new message.'
                : 'You are offline — reconnect, then send a new message.'}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" className="shrink-0 border-red-300 bg-transparent text-red-900 dark:hover:bg-red-950/60 dark:hover:text-red-200" onClick={() => clearError()}>
            Dismiss
          </Button>
        </div>
      )}

      <div className="mt-auto flex shrink-0 flex-col gap-2.5 border-t bg-background pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {pendingAsk !== null && (
          <form
            className="flex flex-col gap-2 rounded-xl border-[1.5px] border-primary bg-card px-3 py-2.5 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              submitAnswer();
            }}
          >
            <Label htmlFor="chat-answer">Your answer to the agent's question</Label>
            <Textarea
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
              <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested answers">
                {pendingAsk.options.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Use suggested answer: ${option}`}
                    onClick={() => setAnswerDraft(option)}
                    disabled={busy}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            )}
            <Button type="submit" size="sm" className="self-start" disabled={!canAnswer}>
              Send answer
            </Button>
            <p className="m-0 text-xs text-muted-foreground">
              The reply is sent as a normal message in this chat; the API records it as the
              question's answer and the agent continues with it.
            </p>
          </form>
        )}

        {messages.length > 0 && composerForm}
      </div>

      {mutationError !== null && (
        <div
          role="alert"
          className="flex shrink-0 items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="m-0">{mutationError}</p>
          <button
            type="button"
            className="shrink-0 rounded-md border border-amber-400 px-2 py-0.5 text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900/50"
            onClick={() => setMutationError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Accessible native rewind confirmation: names the selected message,
          states keep/remove semantics and the raw-bytes guarantee. */}
      <dialog
        ref={rewindDialogRef}
        aria-labelledby="rewind-title"
        className="m-auto w-[30rem] max-w-[92vw] rounded-xl border border-border bg-card p-5 text-card-foreground shadow-lg backdrop:bg-black/40"
        onClick={(event) => {
          if (event.target === rewindDialogRef.current) closeRewind();
        }}
        onCancel={(event) => {
          event.preventDefault();
          closeRewind();
        }}
      >
        {rewindTarget !== null && rewindTargetMessage !== undefined && (
          <>
            <h2 id="rewind-title" className="m-0 flex items-center gap-2 text-[1rem] font-semibold">
              <Undo2 className="size-4 text-destructive" aria-hidden="true" />
              Rewind the transcript to here?
            </h2>
            <p className="mt-2 mb-0 text-sm leading-snug">
              Selected message ({rewindTargetMessage.role === 'user' ? 'your message' : 'assistant reply'}):
            </p>
            <p className="mt-1 rounded-md border bg-muted px-2.5 py-1.5 text-sm">
              {rewindPreview !== '' ? rewindPreview : '(this message has no visible text)'}
            </p>
            <p className="mt-3 mb-0 text-[0.85rem] leading-snug">
              Keeps this message and everything before it — <strong>everything after it is deleted</strong>.
              Kept messages keep their exact raw content (raw bytes intact). This cannot be undone;
              artifacts like documents, delegations and memory are not affected. To replace a disliked
              answer: rewind at its question, then send an edited resend.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-md border border-input px-3 text-[0.8rem] font-medium hover:bg-accent"
                onClick={closeRewind}
                disabled={mutating}
              >
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive px-3 text-[0.8rem] font-semibold text-destructive-foreground transition-opacity disabled:opacity-60"
                onClick={() => void confirmRewind()}
                disabled={mutating}
              >
                {mutating && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                Rewind here
              </button>
            </div>
          </>
        )}
      </dialog>
        </div>
        </div>
        {/* Static right rail on lg+ (user-collapsible; desktop default
            visible, controlled by the labelled header button). */}
        {!railCollapsed ? (
          <div
            id="ws-session-rail-desktop"
            aria-label="Session context"
            className="hidden min-h-0 w-[330px] shrink-0 flex-col overflow-y-auto overscroll-contain lg:flex"
          >
            <SessionRail
              apiBaseUrl={apiBaseUrl}
              slug={agent}
              chatId={chatId}
              mode={activeMode}
              catalog={catalog}
              currentModel={currentModel}
              details={railDetails}
              usage={usage}
              usageError={usageError}
              onReloadUsage={() => void loadUsage()}
              messages={messages}
            />
          </div>
        ) : (
          <button
            type="button"
            className="hidden lg:inline-flex h-full w-9 shrink-0 flex-col items-center justify-center gap-2 border-l border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Show session context panel"
            aria-expanded="false"
            aria-controls="ws-session-rail-desktop"
            title="Show session context panel"
            onClick={() => setRailCollapsed(false)}
          >
            <Info size={15} aria-hidden="true" />
            <span
              className="text-[0.65rem] font-medium tracking-[0.06em] uppercase"
              style={{ writingMode: 'vertical-rl' }}
            >
              Session
            </span>
          </button>
        )}
        {/* Drawer on <lg (labelled toggle in the center header). */}
        {railOpen && (
          <div
            className="fixed inset-0 z-40 lg:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Session context"
          >
            <button
              type="button"
              className="absolute inset-0 h-full w-full cursor-default bg-black/40"
              aria-label="Close session context panel"
              onClick={() => setRailOpen(false)}
            />
            <div
              id="ws-session-rail-drawer"
              tabIndex={-1}
              className="absolute inset-y-0 right-0 flex w-[21rem] max-w-[92vw] flex-col bg-background shadow-md outline-none"
            >
              <button
                type="button"
                className="self-end m-2 inline-flex size-7 items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-accent"
                aria-label="Close session context panel"
                onClick={() => setRailOpen(false)}
              >
                ×
              </button>
              <SessionRail
                apiBaseUrl={apiBaseUrl}
                slug={agent}
                chatId={chatId}
                mode={activeMode}
                catalog={catalog}
                currentModel={currentModel}
                details={railDetails}
                usage={usage}
                usageError={usageError}
                onReloadUsage={() => void loadUsage()}
                messages={messages}
                className="min-h-0 flex-1 overflow-hidden"
              />
            </div>
          </div>
        )}
      </div>

    </WorkspaceGate>
  );
}

/* ------------------------------------------------------------------ */
/* Assistant message regions (Phase 4 formatting fix)                  */
/* ------------------------------------------------------------------ */

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
  holdsLiveThinking = false,
}: {
  parts: WorkforceUIMessage['parts'];
  holdsPendingAsk: boolean;
  chatId: string;
  /**
   * True only for the CURRENT generation's latest assistant turn while the
   * UI is busy: opens a visible live Thinking panel instead of the collapsed
   * details. The same reasoning text renders exactly once — never duplicated
   * — and once the turn completes (or for historical turns) it stays
   * collapsed, exactly like before.
   */
  holdsLiveThinking?: boolean;
}): React.ReactElement {
  const view = partitionMessageParts(parts, holdsPendingAsk);
  const summary = activitySummaryLabel(view.activity);
  return (
    <>
      {/* Gemini/Claude/GPT order: Thinking (reasoning) FIRST, then the
          Response, then Tool activity. Each renders exactly once; the live
          current-turn Thinking stays open while historical Thinking remains
          collapsed, and the pending HITL question stays top-level. */}
      {view.reasoning !== null &&
        (holdsLiveThinking ? (
          <div className="mb-1 rounded-md border border-user-bubble-border bg-accent px-2.5 py-2" aria-live="polite">
            <p
              className="m-0 mb-1 flex items-center gap-1.5 text-[0.7rem] font-semibold tracking-[0.06em] text-primary uppercase"
              aria-hidden="true"
            >
              <Sparkles className="size-3 animate-pulse" aria-hidden="true" />
              Thinking
            </p>
            <MarkdownText text={view.reasoning} className="chat-md-thinking" />
          </div>
        ) : (
          <details className="chat-region">
            <summary>Thinking</summary>
            <MarkdownText text={view.reasoning} className="chat-md-thinking" />
          </details>
        ))}
      {view.response !== null && <MarkdownText text={view.response} className="chat-md-response" />}
      {view.pendingAsk !== null && view.pendingAsk.type === 'tool-ask_user' && (
        <AskUserPartView part={view.pendingAsk} />
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
      <span className="chat-tool-name">Specialist sub-agent · delegate_task</span>
      {inputView.ok ? (
        <>
          <p className="chat-tool-line flex items-center gap-1.5">
            <span className="font-medium">Orchestrator</span>
            <span aria-hidden="true">→</span>
            <span className="font-medium">{inputView.view.targetAgent ?? '?'}</span>
            {inputView.view.mode !== null && (
              <span className="text-muted-foreground">({inputView.view.mode})</span>
            )}
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
