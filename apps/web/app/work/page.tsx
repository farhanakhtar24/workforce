import type { Metadata } from 'next';
import { WorkDocsList } from '@/components/WorkDocs';
import { isSafeChatId, resolveApiBaseUrl } from '@/lib/api';
import { isAgentSlug } from '@/lib/agents';

export const metadata: Metadata = {
  title: 'Work documents',
};

export const dynamic = 'force-dynamic';

/**
 * `/work` — Work Docs library shell. `?chatId=` (a safe chat id) scopes the
 * list to one chat's documents and enables creation through the real
 * orchestrator create route; absent or unsafe values just clear that filter —
 * never an error page. `?agent=` (optional) only steers the "Back to chat"
 * link. Build never depends on a running API (fully dynamic).
 */
export default async function WorkPage({
  searchParams,
}: {
  searchParams: Promise<{ chatId?: string; scope?: string; agent?: string }>;
}): Promise<React.ReactElement> {
  const { chatId, scope, agent } = await searchParams;
  return (
    <WorkDocsList
      apiBaseUrl={resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL)}
      initialChatId={typeof chatId === 'string' && isSafeChatId(chatId) ? chatId : ''}
      initialAgent={isAgentSlug(agent) ? agent : 'general'}
      initialScope={typeof scope === 'string' ? scope.slice(0, 64) : 'default'}
    />
  );
}
