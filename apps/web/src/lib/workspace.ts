/**
 * Shared workspace-shell presentation helpers (UI refresh).
 *
 * Pure, dependency-free data + functions so the shell and the chat empty
 * state stay testable (`test/workspace.test.ts`) without a browser. Nothing
 * here talks to the API, invents history, or claims capabilities an agent
 * does not have — `chatSuggestions` only names tools each agent's definition
 * really composes (mirrors `AGENT_GUIDANCE` in `agents.ts`).
 */

/** The five routed surface groups the shared navigation covers. */
export const WORKSPACE_NAV_IDS = ['chat', 'memory', 'work', 'delegations', 'schedules'] as const;
export type WorkspaceNavId = (typeof WORKSPACE_NAV_IDS)[number];

export interface WorkspaceNavItem {
  id: WorkspaceNavId;
  label: string;
  href: string;
  /** Path prefixes that belong to this section (detail pages included). */
  prefixes: ReadonlyArray<string>;
}

/**
 * Order below = sidebar order. `/` is an exact-match prefix, so ordering is
 * purely presentational (Chat first, like the product's home surface).
 */
export const WORKSPACE_NAV: ReadonlyArray<WorkspaceNavItem> = [
  {
    id: 'chat',
    label: 'Chat',
    href: '/',
    // `/` matches only the root itself; legacy `/chat/:id` and canonical
    // `/agents/:slug/chat/:id` belong to the chat section too.
    prefixes: ['/', '/agents', '/chat'],
  },
  { id: 'memory', label: 'Memory', href: '/memory', prefixes: ['/memory'] },
  { id: 'work', label: 'Work docs', href: '/work', prefixes: ['/work'] },
  { id: 'delegations', label: 'Delegations', href: '/delegations', prefixes: ['/delegations'] },
  { id: 'schedules', label: 'Schedules', href: '/schedules', prefixes: ['/schedules'] },
];

/**
 * Current section for a pathname. Unknown paths fall back to `chat` (so the
 * sidebar never marks nothing active), which is harmless for unknown routes.
 */
export function activeWorkspaceNavId(
  pathname: string,
  fallback: WorkspaceNavId = 'chat',
): WorkspaceNavId {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  for (const item of WORKSPACE_NAV) {
    const hit = item.prefixes.some((prefix) => {
      if (prefix === '/') return path === '/';
      return path === prefix || path.startsWith(`${prefix}/`);
    });
    if (hit) return item.id;
  }
  return fallback;
}

/** Human label per agent slug (sidebar/empty state identity). */
export const AGENT_LABELS: Readonly<Record<string, string>> = {
  general: 'General',
  orchestrator: 'Orchestrator',
  analyst: 'Analyst',
  researcher: 'Researcher',
};

export function agentLabel(slug: string): string {
  return AGENT_LABELS[slug] ?? slug;
}

/**
 * Empty-state prompt suggestions per agent. Honest by construction: each
 * suggestion only asks for tools that agent actually has (calculate for
 * general; query_data/search_memory/write_doc/delegate_task/ask_user for
 * orchestrator; query_data/search_memory/ask_user for analyst;
 * search_memory/ask_user for researcher) and never promises history or
 * hidden capabilities. Clicking fills the composer — it never auto-sends.
 */
export const CHAT_SUGGESTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  general: [
    'What is 21+21?',
    'What is 15 percent of 240 plus 12?',
    'Compute 128 × 64 − 900 step by step.',
  ],
  orchestrator: [
    'Search memory for what we recorded about small language models',
    'Query the data for the latest benchmark rows',
    "Write a work document summarizing this chat's decisions",
    'Delegate a follow-up research task to the researcher',
  ],
  analyst: [
    'Query the data for the latest rows in a table',
    'Search memory for our recorded benchmark observations',
    'Count the rows matching a condition and explain the result',
  ],
  researcher: [
    'Search memory for recorded research about small language models',
    'Summarize what memory says about a topic we researched',
    'Find our notes on one path and show me the strongest matches',
  ],
};

export function chatSuggestions(slug: string): ReadonlyArray<string> {
  return CHAT_SUGGESTIONS[slug] ?? CHAT_SUGGESTIONS.general;
}
