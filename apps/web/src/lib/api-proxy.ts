/**
 * Phase 6 single-origin API proxy helpers (ADR-009) — pure, dependency-free.
 *
 * In production (Railway) the API is PRIVATE: only `web` has a public domain.
 * `next.config.ts` rewrites every browser request for `/api/:path*` to the
 * API's SERVER-ONLY internal URL (`API_INTERNAL_URL`), so the browser, Better
 * Auth cookies and SSE chat streams all travel one public web origin.
 *
 * This is a server-side REWRITE (proxy), never a client redirect: the browser
 * never sees the internal API host. In development the rewrite also exists but
 * is unused: `NEXT_PUBLIC_API_URL` keeps pointing directly at the API
 * (`http://localhost:3001`), so the direct-API local behavior is unchanged.
 *
 * `API_INTERNAL_URL` is read at `next build` time (Next bakes resolved
 * rewrites into `.next/routes-manifest.json`; the standalone runtime serves
 * the baked manifest). It therefore travels as a Docker build arg — it is an
 * internal network URL, NEVER a secret (no credentials ever appear in it).
 */

import { resolveApiBaseUrl } from './api';

/** Local fallback — the dev API on its published loopback port. */
export const API_INTERNAL_URL_DEFAULT = 'http://localhost:3001';

/** Rewrite source: every browser `/api/*` request, including `/api/auth/*` (Better Auth) and SSE stream routes. */
export const API_PROXY_SOURCE = '/api/:path*';

/**
 * Fixed safe config error — thrown when `API_INTERNAL_URL` is set but is not a
 * bounded http(s) origin. It names the shape, never the raw invalid value:
 * build logs and Railway logs must be safe to share.
 */
export const API_PROXY_CONFIG_ERROR =
  'Invalid API_INTERNAL_URL: it must be an http(s) origin only — protocol http/https, a hostname, an optional port, and nothing else (no path, query, hash or credentials). Example shape: http://api.railway.internal:3001';

/**
 * True when `candidate` parses to a bounded http(s) ORIGIN:
 * - protocol exactly `http:` or `https:` (relative/scheme-relative input throws and fails closed);
 * - non-empty hostname (no user/pass);
 * - no path beyond the root (a single trailing `/` is the root itself), no `?query`, no `#hash`.
 * The returned normalization never keeps a trailing slash: use the `URL.origin`.
 */
export function isBoundedHttpOrigin(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.hostname === '') return false;
  if (parsed.pathname !== '/') return false;
  if (parsed.search !== '') return false;
  if (parsed.hash !== '') return false;
  return true;
}

/**
 * Resolve the server-only API origin for the rewrite destination.
 * Empty/absent → `API_INTERNAL_URL_DEFAULT`; a set value must be a bounded
 * http(s) origin (`isBoundedHttpOrigin`) or a fixed safe error is thrown
 * WITHOUT echoing the value. Trailing slash never survives (URL.origin).
 */
export function resolveApiInternalOrigin(envValue: string | undefined): string {
  const trimmed = envValue?.trim();
  const candidate = trimmed === '' || trimmed === undefined ? API_INTERNAL_URL_DEFAULT : trimmed;
  if (!isBoundedHttpOrigin(candidate)) {
    throw new Error(API_PROXY_CONFIG_ERROR);
  }
  const origin = new URL(candidate).origin;
  return origin;
}

/** Runtime env key for the server-only internal API origin (no secret). */
export const API_INTERNAL_URL_ENV = 'API_INTERNAL_URL';

export interface ServerApiBaseUrlInput {
  /** Runtime `API_INTERNAL_URL`, if present (empty/blank = absent). */
  runtimeInternalUrl: string | undefined;
  /** Public NEXT_PUBLIC_API_URL, if present (drives the browser default). */
  publicApiUrl: string | undefined;
  /** Server-side flag: the resolver only runs inside server components. */
  isServer: boolean;
}

export class ServerApiBaseUrlError extends Error {
  constructor() {
    super(API_PROXY_CONFIG_ERROR);
    this.name = 'ServerApiBaseUrlError';
  }
}

/**
 * SERVER-SIDE base-origin resolution for SSR hydration fetches.
 *
 * Why not `NEXT_PUBLIC_API_URL` alone: in single-origin Compose the PUBLIC
 * web origin is `http://localhost:3200`, but inside the web container the
 * public hostname does not resolve — a hydration fetch to it fails. The
 * runtime `API_INTERNAL_URL` (e.g. `http://api:3001`, also baked into the
 * Next rewrite) is the correct server-to-server target in that mode.
 *
 * Resolution order:
 * 1. runtime `API_INTERNAL_URL` is set and non-blank → validate with
 *    `resolveApiInternalOrigin` (bounded http(s) origin, trailing slash
 *    normalized, fixed safe error WITHOUT echoing the value);
 * 2. otherwise fall back to the public `resolveApiBaseUrl(NEXT_PUBLIC_API_URL)`
 *    so host dev / direct-API/`NEXT_PUBLIC_API_URL` modes keep working.
 *
 * The BROWSER never uses the internal URL: `isServer=false` is a hard guard
 * (callers must only invoke this in server components). And when the public
 * API is NOT the localhost default, the fallback keeps that custom public
 * origin — it never silently swaps in `http://localhost:3001`.
 */
export function resolveServerApiBaseUrl(input: ServerApiBaseUrlInput): string {
  if (input.isServer !== true) {
    throw new Error('resolveServerApiBaseUrl is server-only.');
  }
  const internalIsPresent = input.runtimeInternalUrl !== undefined && input.runtimeInternalUrl.trim() !== '';
  if (internalIsPresent) {
    try {
      return resolveApiInternalOrigin(input.runtimeInternalUrl);
    } catch {
      throw new ServerApiBaseUrlError();
    }
  }
  return resolveApiBaseUrl(input.publicApiUrl);
}

/**
 * Build the Next.js rewrites entry for the API proxy. `envValue` is the raw
 * `API_INTERNAL_URL` environment value (validated by
 * `resolveApiInternalOrigin`). Server-side proxy only: destination keeps the
 * `/api/:path*` shape so every chat/auth/memory/schedule route reaches the
 * Express API unchanged.
 */
export function apiProxyRewrites(envValue: string | undefined): Array<{
  source: string;
  destination: string;
}> {
  const origin = resolveApiInternalOrigin(envValue);
  return [{ source: API_PROXY_SOURCE, destination: `${origin}/api/:path*` }];
}
