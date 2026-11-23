import { notFound, redirect } from 'next/navigation';
import { isSafeChatId } from '@/lib/api';
import { buildChatUrl, parseAgentSelection } from '@/lib/agents';

export const dynamic = 'force-dynamic';

/**
 * LEGACY `/chat/:chatId` — the pre-Phase-4 chat URL. It meant the `general`
 * agent, so it redirects to the canonical agent-scoped page. A valid
 * `?agent=`/`?mode=` on the legacy URL is honored (so old hand-built links
 * keep their selection); anything else falls back to the `general`/`action`
 * defaults. Invalid ids render the safe 404, never an error page.
 */
export default async function LegacyChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ chatId: string }>;
  searchParams: Promise<{ agent?: string; mode?: string }>;
}): Promise<never> {
  const { chatId } = await params;
  if (!isSafeChatId(chatId)) notFound();
  const selection = parseAgentSelection(await searchParams);
  redirect(buildChatUrl(chatId, selection));
}
