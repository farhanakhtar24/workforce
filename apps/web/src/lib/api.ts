/**
 * Pure, testable request/response helpers for the @workforce/web client.
 *
 * Contract source of truth: `apps/api/src/http/routes.ts` and `apps/api/src/validation.ts`.
 * - POST /api/agents/:slug/chat              body exactly `{ id, message }` with the
 *   newest user `UIMessage` (plus the optional Phase 4 `mode`), header
 *   `Idempotency-Key` must equal `${chatId}:${message.id}` (400 otherwise).
 * - GET  /api/agents/:slug/chat/:chatId          hydration: `{ messages, hasActiveStream }`,
 *   Cache-Control no-store.
 * - GET  /api/agents/:slug/chat/:chatId/stream  resume; 204 when idle; full SSE
 *   replay (`resumeStreamIsReplay` stays at its `true` default — see ADR-008).
 *
 * The slug is part of every chat URL: transcript hydration/resume keys are
 * (slug, chatId), so the SAME slug must be used for send/hydrate/resume of a
 * conversation. All builders default to `general`, which keeps every Phase 2
 * call site and test byte-identical.
 */
import type { UIMessage } from 'ai';

/** The Phase 2 slug — still the default for every endpoint builder. */
export const AGENT_SLUG = 'general';

/** Default browser-facing API base; overridden via NEXT_PUBLIC_API_URL. */
export const API_BASE_URL_DEFAULT = 'http://localhost:3001';

/** Same alphabet the API enforces for chat/message/stream ids (1–64 chars). */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeChatId(id: string): boolean {
  return SAFE_ID_PATTERN.test(id);
}

/**
 * Resolve the public API base URL. Never reads secrets: only this public
 * NEXT_PUBLIC_ variable is exposed to the browser bundle.
 */
export function resolveApiBaseUrl(envValue: string | undefined): string {
  const trimmed = envValue?.trim();
  if (!trimmed) return API_BASE_URL_DEFAULT;
  return trimmed.replace(/\/+$/, '');
}

export function sendMessagesEndpoint(apiBaseUrl: string, slug: string = AGENT_SLUG): string {
  return `${apiBaseUrl}/api/agents/${encodeURIComponent(slug)}/chat`;
}

export function hydrationEndpoint(apiBaseUrl: string, chatId: string, slug: string = AGENT_SLUG): string {
  return `${apiBaseUrl}/api/agents/${encodeURIComponent(slug)}/chat/${encodeURIComponent(chatId)}`;
}

export function resumeStreamEndpoint(apiBaseUrl: string, chatId: string, slug: string = AGENT_SLUG): string {
  return `${apiBaseUrl}/api/agents/${encodeURIComponent(slug)}/chat/${encodeURIComponent(chatId)}/stream`;
}

/** The API requires the key to be exactly `${chatId}:${messageId}`. */
export function idempotencyKey(chatId: string, messageId: string): string {
  return `${chatId}:${messageId}`;
}

/**
 * Newest user message: the last message in the array with role `user` (the AI
 * SDK appends the just-submitted user message at the end).
 */
export function newestUserMessage(messages: readonly UIMessage[]): UIMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message;
  }
  return null;
}

export interface PreparedSendRequest {
  /** Full URL for DefaultChatTransport's prepared `api`. */
  url: string;
  /**
   * Exactly `{ id, message }` — plus `mode` only when a selection is passed
   * (Phase 4 `mode?: 'plan' | 'action'`; the API 400s on unknown keys).
   */
  body: { id: string; message: UIMessage; mode?: 'plan' | 'action' };
  headers: { 'Idempotency-Key': string };
}

/**
 * Builds the documented POST for the newest user message. Throws when no user
 * message exists (the API requires one); the hook surfaces the rejection as
 * chat error state. `slug` selects the agent's send route (default `general`);
 * `mode` — when provided — travels in the body as the Phase 4
 * plan/action selection; the header contract is untouched.
 */
export function buildSendRequest(options: {
  apiBaseUrl: string;
  chatId: string;
  messages: readonly UIMessage[];
  slug?: string;
  mode?: 'plan' | 'action';
}): PreparedSendRequest {
  const { apiBaseUrl, slug, mode } = options;
  const message = newestUserMessage(options.messages);
  if (!message) {
    throw new Error('A user message is required to start a chat turn.');
  }
  return {
    url: sendMessagesEndpoint(apiBaseUrl, slug),
    body: {
      id: options.chatId,
      message,
      ...(mode !== undefined ? { mode } : {}),
    },
    headers: { 'Idempotency-Key': idempotencyKey(options.chatId, message.id) },
  };
}

export interface PreparedReconnectRequest {
  /** Full Express resume URL for DefaultChatTransport's prepared `api`. */
  url: string;
}

/**
 * Reconnect (resume) request: a GET against the Express stream route. The
 * replays/delta behavior is decided by the transport default
 * (`resumeStreamIsReplay: true`), which we never disable. Resume streams are
 * keyed (slug, chatId), so the selected slug must be passed here too.
 */
export function buildReconnectRequest(options: {
  apiBaseUrl: string;
  chatId: string;
  slug?: string;
}): PreparedReconnectRequest {
  const { apiBaseUrl } = options;
  return { url: resumeStreamEndpoint(apiBaseUrl, options.chatId, options.slug) };
}

/**
 * Chat-service failures are always safe JSON `{"error": "<fixed message>"}`.
 * Extract that fixed message; anything else (raw network errors, non-JSON
 * bodies) collapses to a fixed fallback. Never surfaces stacks or internals.
 */
export const CHAT_ERROR_FALLBACK = 'Something went wrong. Please try again.';

export function describeChatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    try {
      const parsed: unknown = JSON.parse(error.message);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'error' in parsed &&
        typeof (parsed as { error: unknown }).error === 'string' &&
        (parsed as { error: string }).error.length > 0
      ) {
        return (parsed as { error: string }).error;
      }
    } catch {
      // Not JSON — fall through to the fixed message below.
    }
  }
  return CHAT_ERROR_FALLBACK;
}

export interface ChatHydration {
  messages: UIMessage[];
  hasActiveStream: boolean;
}

export type HydrationResult =
  | { ok: true; hydration: ChatHydration }
  | { ok: false; error: string };

export const HYDRATION_ERROR_UNREACHABLE =
  'Chat history is temporarily unavailable. Refresh to retry.';
export const HYDRATION_ERROR_INVALID =
  'Chat history is temporarily unavailable. Refresh to retry.';

/**
 * Map a hydration response body to `{ messages, hasActiveStream }` with a
 * shallow structural check. Returns a safe fixed error for anything else —
 * no raw payload, no stack, no internal detail.
 */
export function mapHydration(raw: unknown): HydrationResult {
  if (raw === null || typeof raw !== 'object') return { ok: false, error: HYDRATION_ERROR_INVALID };
  const record = raw as Record<string, unknown>;
  const { messages, hasActiveStream } = record;
  if (!Array.isArray(messages)) return { ok: false, error: HYDRATION_ERROR_INVALID };
  const wellFormed = messages.every(
    (message) =>
      message !== null &&
      typeof message === 'object' &&
      typeof (message as Record<string, unknown>).id === 'string' &&
      typeof (message as Record<string, unknown>).role === 'string' &&
      Array.isArray((message as Record<string, unknown>).parts),
  );
  if (!wellFormed) return { ok: false, error: HYDRATION_ERROR_INVALID };
  return {
    ok: true,
    hydration: {
      messages: messages as UIMessage[],
      hasActiveStream: hasActiveStream === true,
    },
  };
}

/**
 * Minimal fetch surface used by hydration — deliberately independent of DOM /
 * undici typings so the same code typechecks in the web app and under the
 * root project's ES2022-only lib. A real browser `fetch` satisfies it.
 */
export interface FetchLike {
  (
    input: string,
    init?: {
      method?: 'GET';
      cache?: 'no-store';
      headers?: Record<string, string>;
    },
  ): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

/**
 * Fetch hydration for a chat page. Never throws: every failure (network,
 * non-OK, malformed body) becomes a safe fixed message. `no-store` is
 * mandatory — hydration must always reflect live server state.
 *
 * Auth: server-side hydration (Next server → API) forwards the browser's
 * incoming `Cookie` header when one is provided (never logged), so the
 * session-authenticated API answers with the same transcript the client
 * could see.
 */
export async function fetchChatHydration(options: {
  apiBaseUrl: string;
  chatId: string;
  /** Agent slug of the conversation (default `general`). */
  slug?: string;
  /** Incoming request `Cookie` header value forwarded verbatim (no-store). */
  cookieHeader?: string;
  fetchImpl?: FetchLike;
}): Promise<HydrationResult> {
  const { apiBaseUrl, slug, fetchImpl = browserApiFetch } = options;
  if (!isSafeChatId(options.chatId)) {
    return { ok: false, error: HYDRATION_ERROR_INVALID };
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.cookieHeader !== undefined && options.cookieHeader !== '') {
    headers.cookie = options.cookieHeader;
  }
  try {
    const response = await fetchImpl(hydrationEndpoint(apiBaseUrl, options.chatId, slug), {
      method: 'GET',
      cache: 'no-store',
      headers,
    });
    if (!response.ok) {
      return { ok: false, error: HYDRATION_ERROR_UNREACHABLE };
    }
    return mapHydration(await response.json());
  } catch {
    return { ok: false, error: HYDRATION_ERROR_UNREACHABLE };
  }
}

/* ------------------------------------------------------------------ */
/* Auth (Better Auth sessions) + credentials-aware browser requests     */
/* ------------------------------------------------------------------ */

/**
 * The signed-in workspace uses Better Auth session cookies served by the API
 * under `/api/auth/*`. Every browser→API request must carry
 * `credentials: 'include'` (CORS is credentials-safe on the API side).
 */
export const API_FETCH_CREDENTIALS = 'include' as const;

/** Fixed copy — 403 access denial. */
export const AUTH_DENIED_ERROR = 'You do not have access to this workspace.';
/** Fixed copy — 401 session expiry; the fetcher also redirects to /sign-in. */
export const SESSION_EXPIRED_ERROR = 'Your session expired. Redirecting to sign-in…';

/**
 * Restricts a `?next=`/callback to a SAME-ORIGIN local web route. Absolute
 * URLs, scheme-relative (`//evil`), backslash tricks and empty values all
 * fall back; Better Auth additionally validates trusted origins server-side.
 */
export function safeLocalCallback(
  raw: string | null | undefined,
  fallback: string = '/',
): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (trimmed === '' || !trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return fallback;
  }
  return trimmed;
}

/**
 * Sends the browser to `/sign-in?next=<safe local route>` (session expiry).
 * Only callable in a browser (client fetchers); never logs anything.
 */
export function redirectToSignIn(currentPath: string = '/'): void {
  if (typeof window === 'undefined') return;
  const next = safeLocalCallback(currentPath);
  window.location.assign(`/sign-in?next=${encodeURIComponent(next)}`);
}

/**
 * Maps a non-OK API status to fixed auth copy: 401 → session-expired (and
 * triggers the /sign-in redirect), 403 → access denied, anything else → null
 * (keep the domain's own fallback error).
 */
export function authErrorForStatus(status: number, currentPath: string): string | null {
  if (status === 401) {
    redirectToSignIn(currentPath);
    return SESSION_EXPIRED_ERROR;
  }
  if (status === 403) return AUTH_DENIED_ERROR;
  return null;
}

/** Public availability endpoint: which OAuth providers are configured. */
export function authProvidersEndpoint(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/auth/providers`;
}

export type AuthProvidersResult =
  | { ok: true; google: boolean; github: boolean }
  | { ok: false; error: string };

export const AUTH_PROVIDERS_ERROR =
  'Provider availability could not be read. Check your connection and try again.';

/** Structural mapping of `GET /api/auth/providers` — booleans only. */
export function mapAuthProviders(payload: unknown): AuthProvidersResult {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: AUTH_PROVIDERS_ERROR };
  }
  const record = payload as Record<string, unknown>;
  const google = record['google'];
  const github = record['github'];
  if (typeof google !== 'boolean' || typeof github !== 'boolean') {
    return { ok: false, error: AUTH_PROVIDERS_ERROR };
  }
  return { ok: true, google, github };
}

export async function fetchAuthProviders(options: {
  apiBaseUrl: string;
  signal?: AbortSignal;
}): Promise<AuthProvidersResult> {
  try {
    const response = await fetch(authProvidersEndpoint(options.apiBaseUrl), {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: API_FETCH_CREDENTIALS,
      signal: options.signal,
    });
    if (!response.ok) {
      return { ok: false, error: AUTH_PROVIDERS_ERROR };
    }
    return mapAuthProviders(await response.json());
  } catch {
    return { ok: false, error: AUTH_PROVIDERS_ERROR };
  }
}

/**
 * Browser fetch wrapper for API calls: always sends cookies
 * (`credentials: 'include'`) so the session-authenticated API accepts the
 * request. Structurally satisfies every domain `*Fetch` interface, so libs
 * swap their default `fetch` for this without changing their call contracts.
 */
export async function browserApiFetch(
  input: string,
  init?: {
    method?: string;
    cache?: 'no-store';
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<Response> {
  return fetch(input, { ...init, credentials: API_FETCH_CREDENTIALS } as RequestInit);
}

/**
 * Auth status → error mapping for domain request helpers: 401 redirects to
 * /sign-in (client only) and reports the fixed session-expired copy; 403
 * reports fixed access-denied copy; other statuses return null so the
 * caller keeps its own domain fallback.
 */
/**
 * Adapter for AI SDK chat transports (send + resume): standard fetch
 * signature with cookies always included, so `DefaultChatTransport`'s
 * `fetch` option satisfies its expected `(RequestInfo|URL, RequestInit)` type.
 */
export async function browserChatFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, { ...init, credentials: API_FETCH_CREDENTIALS });
}

export function requestAuthError(status: number): string | null {
  const path = typeof window !== 'undefined' && window.location !== undefined ? window.location.pathname : '/';
  return authErrorForStatus(status, path);
}

/**
 * OAuth post-auth application return URL (Farhan bug: the browser landed on
 * API3001). Better Auth resolves a RELATIVE `callbackURL` against the auth
 * base URL (`API_ORIGIN/api/auth`, port 3001), so the sign-in flow must pass
 * an ABSOLUTE same-origin WEB url.
 *
 * `absoluteWebCallback` sanitizes the intended local route and prefixes it
 * with the given web origin ONLY when that origin is a genuine http(s) URL
 * with non-empty hostname. The caller passes `window.location.origin` (the
 * real web origin, e.g. `http://localhost:3000`). A hostile `next` (absolute
 * URL, scheme-relative, backslash tricks, empty/garbage) never becomes an
 * origin — it collapses to the origin's `/`; the supplied origin can never be
 * replaced by the input, so the result can never target the API port or an
 * evil origin. No open redirect: the route part is still path-optional input
 * validated by `safeLocalCallback` (never protocol-relative), and the final
 * origin is either the caller-supplied real web origin or the safe fallback.
 */
export function absoluteWebCallback(
  webOrigin: string | null | undefined,
  next: string | null | undefined,
): string {
  let normalizedOrigin: string;
  try {
    const parsed = new URL(String(webOrigin ?? ''));
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== '') {
      normalizedOrigin = parsed.origin;
    } else {
      normalizedOrigin = '';
    }
  } catch {
    normalizedOrigin = '';
  }
  const route = safeLocalCallback(next, '/');
  // `route` always starts with '/'; an unusable origin degrades to the
  // relative route rather than inventing a host.
  return normalizedOrigin === '' ? route : `${normalizedOrigin}${route}`;
}
