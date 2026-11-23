import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { buildChatUrl, parseAgentSelection } from '@/lib/agents';

export const dynamic = 'force-dynamic';

/**
 * The chat id is stable and lives in the URL: the root creates one fresh
 * identifier per visit and hands it to the canonical agent-scoped chat page.
 * No localStorage involved. A selection carried from "New chat"
 * (`/?agent=…&mode=…`) is validated and forwarded; the default
 * `general`/`action` pair yields the same clean URL as before.
 */
export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const params = (await searchParams) ?? {};
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;
  const selection = parseAgentSelection({ agent: first(params['agent']), mode: first(params['mode']) });
  redirect(buildChatUrl(randomUUID(), selection));
}
