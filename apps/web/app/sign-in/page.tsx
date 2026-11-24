import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignInView } from '@/components/SignInView';

export const metadata: Metadata = {
  title: 'Sign in',
  description:
    'Sign in to the Workforce workspace with Google or GitHub. Your chats, memory and documents are never deleted by signing in or out.',
};

export const dynamic = 'force-dynamic';

/**
 * `/sign-in` — the standalone auth surface (no workspace shell; the guard
 * would redirect signed-out users here anyway). `?next=` carries the
 * intended same-origin local route; `?error=` renders the fixed
 * access-denied presentation. Suspense wraps the client param reader as
 * required by the App Router for `useSearchParams`.
 */
export default function SignInPage(): React.ReactElement {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-background" aria-busy="true" />}>
      <SignInView />
    </Suspense>
  );
}
