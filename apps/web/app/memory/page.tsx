import type { Metadata } from 'next';
import { Memory } from '@/components/Memory';

/**
 * Phase 3 memory workspace. Purely dynamic client rendering: the page shell
 * is a server component that mounts the client `<Memory>` component — the
 * build never talks to the API and no secrets reach the browser (embedding
 * models stay server-side in the API process).
 */
export const metadata: Metadata = {
  title: 'Memory',
  description:
    'Create, browse, search, relate, retry and compact Workforce memory blocks.',
};

export const dynamic = 'force-dynamic';

export default function MemoryPage(): React.ReactElement {
  return <Memory />;
}
