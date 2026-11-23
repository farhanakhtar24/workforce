import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Chat } from '@/components/Chat';
import { fetchChatHydration, isSafeChatId, resolveApiBaseUrl } from '@/lib/api';
import { isAgentMode, isAgentSlug, type WebAgentMode, type WebAgentSlug } from '@/lib/agents';
import type { WorkforceUIMessage } from '@/lib/messages';

export const metadata: Metadata = {
  title: 'Chat',
};

export const dynamic = 'force-dynamic';

/**
 * CANONICAL `/agents/<slug>/chat/<chatId>` — one agent's transcript for one
 * chat id (transcripts are keyed (slug, chatId) server-side). Unknown agent
 * slugs and unsafe chat ids render the safe 404 — nothing is guessed. Mode is
 * optional (`?mode=plan|action`, default `action`); an unknown mode falls
 * back to the default instead of erroring.
 *
 * Hydration fetches with `no-store` (ADR-008: whole-history seeding) for the
 * SAME slug the composer will send to. When the API is unreachable the page
 * still renders with a safe fixed retry hint; `next build` never talks to the
 * API (fully dynamic rendering).
 */
export default async function AgentChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; chatId: string }>;
  searchParams: Promise<{ mode?: string }>;
}): Promise<React.ReactElement> {
  const { slug, chatId } = await params;
  const { mode: modeParam } = await searchParams;
  // Safe boundaries first: unknown slug/id → 404, unknown mode → default.
  if (!isAgentSlug(slug) || !isSafeChatId(chatId)) notFound();
  const agent = slug as WebAgentSlug;
  const mode: WebAgentMode = isAgentMode(modeParam) ? modeParam : 'action';

  const result = await fetchChatHydration({
    apiBaseUrl: resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL),
    chatId,
    slug: agent,
  });

  if (!result.ok) {
    return (
      <Chat
        key={`${agent}:${chatId}:${mode}`}
        chatId={chatId}
        agent={agent}
        mode={mode}
        initialMessages={[]}
        hasActiveStream={false}
        hydrationError={result.error}
      />
    );
  }

  // mapHydration performed the structural checks; the wire format is a
  // UIMessage<…, Phase 4 tool parts>, so this cast only restores the narrowed
  // static-tool keys.
  const initialMessages = result.hydration.messages as unknown as WorkforceUIMessage[];

  return (
    <Chat
      // Keyed by slug+mode: selecting a different agent/mode remounts the
      // client component so useChat re-seeds from that key's hydration result.
      key={`${agent}:${chatId}:${mode}`}
      chatId={chatId}
      agent={agent}
      mode={mode}
      initialMessages={initialMessages}
      hasActiveStream={result.hydration.hasActiveStream}
    />
  );
}
