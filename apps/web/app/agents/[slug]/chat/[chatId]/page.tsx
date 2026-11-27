import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Chat } from '@/components/Chat';
import { fetchChatHydration, isSafeChatId } from '@/lib/api';
import { resolveServerApiBaseUrl } from '@/lib/api-proxy';
import {
  parseChatPageMode,
  isAgentSlug,
  type WebAgentMode,
  type WebAgentSlug,
} from '@/lib/agents';
import type { WorkforceUIMessage } from '@/lib/messages';

export const metadata: Metadata = {
  title: 'Chat',
};

export const dynamic = 'force-dynamic';

/**
 * CANONICAL `/agents/<slug>/chat/<chatId>` — one agent's transcript for one
 * chat id (transcripts are keyed (slug, chatId) server-side). Unknown agent
 * slugs and unsafe chat ids render the safe 404 — nothing is guessed. Mode is
 * optional (`?mode=plan|action`, default `DEFAULT_MODE` = plan — new chats
 * start planning); an unknown mode falls back to the DEFAULT instead of
 * erroring, and explicit `?mode=action` is honored verbatim.
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
  // Absent/invalid mode → the web default (plan); explicit values verbatim.
  // Absent/invalid mode → the web default (plan); explicit values verbatim.
  const mode: WebAgentMode = parseChatPageMode(modeParam);

  // Server hydration now forwards the browser's session cookies to the
  // session-authenticated API (never logged). A 401 still lands as the safe
  // hydration error; the client AuthGate redirects to sign-in regardless.
  const headerList = await headers();
  const cookieHeader = headerList.get('cookie') ?? undefined;

  const result = await fetchChatHydration({
    // SSR hydration targets the SERVER-ONLY internal API origin in
    // single-origin Compose (`API_INTERNAL_URL=http://api:3001`); the
    // browser-facing NEXT_PUBLIC origin must NOT be fetched from inside the
    // container. Host dev / direct-API modes fall back to the public base.
    apiBaseUrl: resolveServerApiBaseUrl({
      runtimeInternalUrl: process.env['API_INTERNAL_URL'],
      publicApiUrl: process.env.NEXT_PUBLIC_API_URL,
      isServer: true,
    }),
    chatId,
    slug: agent,
    cookieHeader,
  });

  if (!result.ok) {
    return (
      <Chat
        // Keyed by slug+chatId only: Plan/Action is in-place client state
        // (shallow URL replace) and must never remount/reset useChat.
        key={`${agent}:${chatId}`}
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
      // Keyed by slug+chatId only: agent switches are real navigation (the
      // server re-hydrates that (slug, chatId) transcript) while Plan/Action
      // stays in-place client state — no Chat remount, no useChat reset.
      key={`${agent}:${chatId}`}
      chatId={chatId}
      agent={agent}
      mode={mode}
      initialMessages={initialMessages}
      hasActiveStream={result.hydration.hasActiveStream}
    />
  );
}
