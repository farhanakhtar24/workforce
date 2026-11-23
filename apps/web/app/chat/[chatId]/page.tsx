import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Chat } from '@/components/Chat';
import { fetchChatHydration, isSafeChatId, resolveApiBaseUrl } from '@/lib/api';
import type { WorkforceUIMessage } from '@/lib/messages';

export const metadata: Metadata = {
  title: 'Chat',
};

export const dynamic = 'force-dynamic';

/**
 * Server hydrator. Fetches hydration with `no-store` (ADR-008: whole-history
 * seeding) and hands validation-checked UIMessages plus the active-stream
 * flag to the client component. When the API is unreachable the page still
 * renders — a safe fixed retry hint is shown; no internal detail leaks, and
 * `next build` never talks to the API (fully dynamic rendering).
 */
export default async function ChatPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}): Promise<React.ReactElement> {
  const { chatId } = await params;
  if (!isSafeChatId(chatId)) notFound();

  const result = await fetchChatHydration({
    apiBaseUrl: resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL),
    chatId,
  });

  if (!result.ok) {
    return (
      <Chat
        chatId={chatId}
        initialMessages={[]}
        hasActiveStream={false}
        hydrationError={result.error}
      />
    );
  }

  // mapHydration performed the structural checks; the wire format is exactly
  // a UIMessage<…, { calculate }>, so this cast only restores the narrowed
  // static-tool key.
  const initialMessages = result.hydration.messages as unknown as WorkforceUIMessage[];

  return (
    <Chat
      chatId={chatId}
      initialMessages={initialMessages}
      hasActiveStream={result.hydration.hasActiveStream}
    />
  );
}
