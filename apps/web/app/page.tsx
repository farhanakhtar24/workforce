import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * The chat id is stable and lives in the URL: the root creates one fresh
 * identifier per visit and hands it to /chat/:id. No localStorage involved.
 */
export default function Home(): never {
  redirect(`/chat/${randomUUID()}`);
}
