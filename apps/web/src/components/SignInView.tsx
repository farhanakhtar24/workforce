'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, Bot, Loader2, RefreshCw, ShieldX, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  AUTH_DENIED_ERROR,
  absoluteWebCallback,
  fetchAuthProviders,
  resolveApiBaseUrl,
  safeLocalCallback,
} from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { hasSessionUser } from '@/components/AuthGate';

/**
 * The `/sign-in` surface (stands alone — no workspace shell, guarded content
 * stays hidden). Only providers the API actually configured render (public
 * `GET /api/auth/providers` booleans — no fake providers). OAuth uses
 * Better Auth's own social flow: `authClient.signIn.social({ provider,
 * callbackURL })` and Better Auth performs the redirect server-side; the
 * callback is an ABSOLUTE same-origin web URL (relative paths would be
 * resolved against the AUTH base on the API origin, which sent real users to
 * `http://localhost:3001/...`); the route is sanitized by `safeLocalCallback`
 * and the origin is this web app's own `window.location.origin`
 * (`absoluteWebCallback`; `trustedOrigins` double-guards server-side).
 *
 * Errors are fixed and safe: configured-but-failed OAuth / offline / 403 map
 * to honest copy; `?error=` on the callback renders the fixed access-denied
 * presentation. A signed-in visitor is bounced to `next`/`/`.
 */

const VALUE_LINES = [
  'Chat with four agents in plan/action modes.',
  'Memory that persists across sessions, versioned work documents,',
  'delegation to worker agents, and a UTC scheduler for recurring tasks.',
];

type ProviderPhase =
  | { phase: 'loading' }
  | { phase: 'ready'; google: boolean; github: boolean }
  | { phase: 'error'; error: string };

interface ProviderButtonState {
  busy: boolean;
  error: string | null;
}

const PROVIDER_ERROR_FALLBACK =
  'The sign-in provider did not respond. Check your connection and try again.';

export function SignInView(): React.ReactElement {
  const params = useSearchParams();
  const nextPath = safeLocalCallback(params.get('next'));
  const oauthError = params.get('error');

  const [providers, setProviders] = useState<ProviderPhase>({ phase: 'loading' });
  const [google, setGoogle] = useState<ProviderButtonState>({ busy: false, error: null });
  const [github, setGithub] = useState<ProviderButtonState>({ busy: false, error: null });
  const [offline, setOffline] = useState<boolean>(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setOffline(window.navigator.onLine === false);
    const up = (): void => setOffline(false);
    const down = (): void => setOffline(true);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const loadProviders = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    setProviders({ phase: 'loading' });
    const result = await fetchAuthProviders({ apiBaseUrl: resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL) });
    if (seq !== requestSeq.current) return;
    setProviders(
      result.ok
        ? { phase: 'ready', google: result.google, github: result.github }
        : { phase: 'error', error: result.error },
    );
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  // Already signed in: bounce to the intended local route (never external).
  const { data: session, isPending } = authClient.useSession();
  useEffect(() => {
    if (!isPending && hasSessionUser(session)) {
      window.location.assign(nextPath);
    }
  }, [isPending, session, nextPath]);

  const startSocial = useCallback(
    async (provider: 'google' | 'github'): Promise<void> => {
      setGoogle({ busy: provider === 'google', error: null });
      setGithub({ busy: provider === 'github', error: null });
      try {
        // Better Auth performs the server-side redirect; `callbackURL` is the
        // sanitized local web route (trusted origins enforced server-side).
        // Better Auth performs the server-side redirect. The callback MUST be
        // an ABSOLUTE same-origin web URL: relative callback paths are
        // resolved against the AUTH base URL (API origin, port 3001), which
        // sent real users to `http://localhost:3001/...`. The route is still
        // sanitized by `safeLocalCallback`; the origin is this web app's own
        // `window.location.origin` (the input can never change it).
        const result = await authClient.signIn.social({
          provider,
          callbackURL: absoluteWebCallback(
            typeof window !== 'undefined' ? window.location.origin : undefined,
            nextPath,
          ),
        });
        if (
          result !== null &&
          typeof result === 'object' &&
          'error' in result &&
          result.error !== null
        ) {
          if (provider === 'google') setGoogle({ busy: false, error: PROVIDER_ERROR_FALLBACK });
          else setGithub({ busy: false, error: PROVIDER_ERROR_FALLBACK });
        }
      } catch {
        // A social redirect usually navigates the whole page; a caught error
        // with no navigation means the provider request failed.
        if (provider === 'google') setGoogle({ busy: false, error: PROVIDER_ERROR_FALLBACK });
        else setGithub({ busy: false, error: PROVIDER_ERROR_FALLBACK });
      }
    },
    [nextPath],
  );

  const anyBusy = google.busy || github.busy;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
          <Bot size={18} strokeWidth={2.2} />
        </span>
        <span className="text-lg font-medium tracking-tight">Workforce</span>
      </div>

      <Card aria-labelledby="sign-in-heading" className="w-full max-w-md gap-4 px-5 py-6 text-center">
        <h1 id="sign-in-heading" className="m-0 text-[1.35rem] font-medium tracking-tight">
          Sign in to the workspace
        </h1>
        <p className="m-0 text-[0.9rem] leading-relaxed text-muted-foreground">
          {VALUE_LINES[0]}
          <br />
          {VALUE_LINES[1]}
          <br />
          {VALUE_LINES[2]}
        </p>

        {oauthError !== null && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-left text-sm text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
          >
            <ShieldX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="m-0 font-semibold">Access denied</p>
              <p className="m-0 mt-0.5">{AUTH_DENIED_ERROR}</p>
              <p className="m-0 mt-0.5 text-[0.8rem] opacity-90">
                Ask the workspace owner to grant access, then try again.
              </p>
            </div>
          </div>
        )}

        {offline && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-left text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
          >
            <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="m-0">
              You appear to be offline. Reconnect before signing in — the provider redirect cannot
              complete while you are offline, and nothing resumes automatically.
            </p>
          </div>
        )}

        {providers.phase === 'loading' && (
          <p role="status" aria-live="polite" className="m-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading sign-in options…
          </p>
        )}

        {providers.phase === 'error' && (
          <div className="flex flex-col gap-2">
            <p role="alert" className="m-0 text-sm text-muted-foreground">
              {providers.error}
            </p>
            <div className="flex justify-center">
              <Button type="button" variant="outline" size="sm" onClick={() => void loadProviders()}>
                <RefreshCw size={14} aria-hidden="true" />
                Retry
              </Button>
            </div>
          </div>
        )}

        {providers.phase === 'ready' && (
          <div className="flex flex-col gap-2.5" role="group" aria-label="Sign-in providers">
            {providers.google ? (
              <ProviderButton
                label="Continue with Google"
                busy={google.busy}
                disabled={anyBusy}
                onClick={() => void startSocial('google')}
                error={google.error}
              />
            ) : (
              <p className="m-0 text-xs text-muted-foreground">Google sign-in is not configured for this workspace.</p>
            )}
            {providers.github ? (
              <ProviderButton
                label="Continue with GitHub"
                busy={github.busy}
                disabled={anyBusy}
                onClick={() => void startSocial('github')}
                error={github.error}
              />
            ) : (
              <p className="m-0 text-xs text-muted-foreground">GitHub sign-in is not configured for this workspace.</p>
            )}
            {!providers.google && !providers.github && (
              <p role="alert" className="m-0 text-sm text-muted-foreground">
                No sign-in provider is configured for this workspace yet.
              </p>
            )}
          </div>
        )}

        <p className="m-0 text-xs text-muted-foreground">
          After signing in you will land on <code className="rounded bg-muted px-1 py-0.5">{nextPath}</code>. Your
          agent history is never affected by signing in or out.
        </p>
      </Card>
    </div>
  );
}

function ProviderButton({
  label,
  busy,
  disabled,
  onClick,
  error,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  error: string | null;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant="outline" size="lg" onClick={onClick} disabled={busy || disabled}>
        {busy ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <ArrowRight aria-hidden="true" />
        )}
        {label}
      </Button>
      {error !== null && (
        <p role="alert" className="m-0 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

