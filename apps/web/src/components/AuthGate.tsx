'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { Loader2, ShieldX } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { redirectToSignIn, safeLocalCallback } from '@/lib/api';

/**
 * Shared client auth boundary for every authenticated workspace surface.
 *
 * - `isPending`: renders one quiet loading skeleton (never a layout flash).
 * - Unauthenticated: redirects to `/sign-in?next=<intended local route>`
 *   (same-origin `safeLocalCallback`; never an arbitrary external URL —
 *   server-side `trustedOrigins` additionally guards OAuth redirects).
 * - Access denied (403 / `?error=` on the sign-in callback) renders the
 *   fixed access-denied presentation — no bypass, no internal details.
 *
 * `?error=` query param semantics come strictly from the sign-in flow; this
 * component only reacts to session state.
 */

export interface AuthGateUser {
  name: string | null;
  email: string;
  image: string | null;
}

export const ACCESS_DENIED_TITLE = 'Access denied';
export const ACCESS_DENIED_BODY =
  'Your account is not authorized for this workspace. If you believe this is wrong, ask the workspace owner to grant you access.';

/** True when a Better Auth session carries a usable identity row. */
export function hasSessionUser(
  session: unknown,
): session is { user: AuthGateUser } {
  return (
    typeof session === 'object' &&
    session !== null &&
    typeof (session as { user?: unknown }).user === 'object'
  );
}

export function AuthGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const { data: session, isPending, error } = authClient.useSession();
  const pathname = usePathname() ?? '/';

  useEffect(() => {
    if (!isPending && !hasSessionUser(session)) {
      redirectToSignIn(safeLocalCallback(pathname));
    }
  }, [isPending, session, pathname]);

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background" aria-busy="true">
        <p
          role="status"
          aria-live="polite"
          className="m-0 flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          Loading workspace…
        </p>
      </div>
    );
  }

  // Not signed in: the redirect effect has fired; show nothing but honest
  // status so no workspace content flashes before navigation.
  if (!hasSessionUser(session)) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <p role="status" aria-live="polite" className="m-0 text-sm text-muted-foreground">
          Redirecting to sign-in…
        </p>
      </div>
    );
  }

  // Session fetch itself failed (e.g. network): keep the workspace hidden and
  // present the fixed denial copy — never internals, never a silent bypass.
  if (error !== null && !hasSessionUser(session)) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4">
        <div
          role="alert"
          className="flex w-full max-w-md flex-col gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
        >
          <p className="m-0 flex items-center gap-2 font-semibold">
            <ShieldX className="size-4" aria-hidden="true" />
            {ACCESS_DENIED_TITLE}
          </p>
          <p className="m-0">{ACCESS_DENIED_BODY}</p>
          <p className="m-0 text-[0.8rem] opacity-90">
            Check your internet connection, then refresh the page.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export default AuthGate;
