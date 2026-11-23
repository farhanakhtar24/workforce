import type { Metadata } from 'next';
import { DelegationsView } from '@/components/Delegations';
import { isSafeChatId, resolveApiBaseUrl } from '@/lib/api';
import { isAgentSlug } from '@/lib/agents';

export const metadata: Metadata = {
  title: 'Delegations',
};

export const dynamic = 'force-dynamic';

/**
 * `/delegations?chatId=…` — one parent chat's delegations (the route itself
 * requires `parentChatId`). Without a safe `chatId` the page shows a fixed
 * instruction instead of guessing a scope — no cross-chat existence leaks.
 * `?agent=` (optional) only steers the "Back to chat" link.
 */
export default async function DelegationsPage({
  searchParams,
}: {
  searchParams: Promise<{ chatId?: string; agent?: string }>;
}): Promise<React.ReactElement> {
  const { chatId, agent } = await searchParams;
  return (
    <DelegationsView
      apiBaseUrl={resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL)}
      chatId={typeof chatId === 'string' && isSafeChatId(chatId) ? chatId : ''}
      agent={isAgentSlug(agent) ? agent : 'general'}
    />
  );
}
