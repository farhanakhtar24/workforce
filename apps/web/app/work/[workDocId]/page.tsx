import type { Metadata } from 'next';
import { WorkDocDetailView } from '@/components/WorkDocDetail';
import { isSafeChatId, resolveApiBaseUrl } from '@/lib/api';

export const metadata: Metadata = {
  title: 'Work document',
};

export const dynamic = 'force-dynamic';

/**
 * `/work/:workDocId?chatId=…` — one Work Doc. The owning `chatId` is REQUIRED
 * by every doc-scoped API route (mismatch reads as a fixed 404 — no existence
 * leak), so the page passes the URL value straight through and shows a safe
 * fixed instruction when it is missing or unsafe. The id itself is validated
 * again inside the client helpers (UUID shape) before any fetch happens.
 */
export default async function WorkDocDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workDocId: string }>;
  searchParams: Promise<{ chatId?: string }>;
}): Promise<React.ReactElement> {
  const { workDocId } = await params;
  const { chatId } = await searchParams;
  return (
    <WorkDocDetailView
      apiBaseUrl={resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_URL)}
      workDocId={workDocId}
      chatId={typeof chatId === 'string' && isSafeChatId(chatId) ? chatId : ''}
    />
  );
}
