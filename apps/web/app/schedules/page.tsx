import type { Metadata } from 'next';
import { Schedules } from '@/components/Schedules';
import { resolveApiBaseUrl } from '@/lib/api';

export const metadata: Metadata = {
  title: 'Schedules',
  description: 'Create, browse and manage scheduled agent tasks and their execution history.',
};

export const dynamic = 'force-dynamic';

/**
 * Phase 5 schedule dashboard. Purely dynamic client rendering: the page shell
 * mounts the client `<Schedules>` component against the public API base
 * (build never talks to the API; no secrets reach the browser).
 */
export default function SchedulesPage(): React.ReactElement {
  return <Schedules apiBaseUrl={resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL)} />;
}
