import { createAuthClient } from 'better-auth/react';
import { resolveApiBaseUrl } from './api';

/**
 * Official Better Auth React client, pointed at the API's auth mount
 * (`${API_BASE}/api/auth`). Same better-auth version as `@workforce/api`
 * (1.7.27) — mixing versions across client/server is unsupported upstream.
 *
 * Session cookies are httpOnly and set by the API (`credentials: 'include'`
 * everywhere). The client instance drives `useSession`, social sign-in and
 * sign-out; it never sees or logs keys.
 */
export const API_BASE = resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL);
export const AUTH_BASE_URL = `${API_BASE.replace(/\/+$/, '')}/api/auth`;

export const authClient = createAuthClient({
  baseURL: AUTH_BASE_URL,
  fetchOptions: {
    credentials: 'include',
  },
});

export const { useSession, signIn, signOut } = authClient;
