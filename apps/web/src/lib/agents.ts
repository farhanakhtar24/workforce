/**
 * Agent + mode vocabulary and URL helpers for the Phase 4 chat UI.
 *
 * Contract source of truth: `apps/api/src/validation.ts` +
 * `packages/core/src/agents/types.ts`. Values here are a local, dependency-free
 * copy of that roster so @workforce/web stays free of a @workforce/core
 * dependency.
 *
 * URL scheme: canonical chat URLs are `/agents/<slug>/chat/<chatId>` with an
 * optional `?mode=` (plan only — action is the default and omitted). Legacy
 * `/chat/<chatId>` pages redirect to the `general` agent (the Phase 2 slug),
 * honoring a valid `?agent=`/`?mode=` so old links never lose context.
 * Unknown URL values never crash: they fall back to the defaults.
 */
import { isSafeChatId } from './api';

/** The four servable agent slugs (order = UI picker order). */
export const WEB_AGENT_SLUGS = ['general', 'orchestrator', 'analyst', 'researcher'] as const;
export type WebAgentSlug = (typeof WEB_AGENT_SLUGS)[number];

/** Plan drafting (no write/delegation tools) versus action execution. */
export const WEB_AGENT_MODES = ['plan', 'action'] as const;
export type WebAgentMode = (typeof WEB_AGENT_MODES)[number];

/** Defaults preserve every pre-Phase-4 URL (`/chat/:id` meant general/action). */
export const DEFAULT_AGENT: WebAgentSlug = 'general';
export const DEFAULT_MODE: WebAgentMode = 'action';

export interface AgentSelection {
  agent: WebAgentSlug;
  mode: WebAgentMode;
}

export function isAgentSlug(value: unknown): value is WebAgentSlug {
  return typeof value === 'string' && (WEB_AGENT_SLUGS as readonly string[]).includes(value);
}

export function isAgentMode(value: unknown): value is WebAgentMode {
  return typeof value === 'string' && (WEB_AGENT_MODES as readonly string[]).includes(value);
}

/**
 * One concise, honest capability line per agent. It names only the tools the
 * agent's definition actually composes — it never claims hidden tools and
 * never promises behavior beyond the roster.
 */
export const AGENT_GUIDANCE: Readonly<Record<WebAgentSlug, string>> = {
  general:
    'Answers a single task directly. Reads nothing and writes nothing: only the calculate tool for arithmetic.',
  orchestrator:
    'Coordinates work: query_data and search_memory to read, write_doc for versioned work documents, delegate_task to analyst/researcher, and ask_user to pause for your answer.',
  analyst:
    'Answers data questions with read-only SQL (query_data), searches memory (search_memory), and can pause to ask you a question (ask_user). No document writes, no delegation.',
  researcher:
    'Answers research questions from recorded memory (search_memory) and can pause to ask you a question (ask_user). No SQL, no document writes, no delegation.',
};

/** Whether Plan/Action is a meaningful choice for the agent (spec: orchestrator). */
export function isPlanActionMeaningful(agent: WebAgentSlug): boolean {
  return agent === 'orchestrator';
}

/**
 * Mode-line shown under the controls. Plan is labeled as a next-generation
 * choice, never as a mid-turn escalation.
 */
export function modeGuidance(selection: AgentSelection): string {
  if (selection.mode === 'plan') {
    const note = isPlanActionMeaningful(selection.agent)
      ? ''
      : " This agent's toolset has no write or delegation tools, so plan and action compose the same tools.";
    return `Plan mode for the next reply: read-only drafting — write_doc and delegate_task are withheld for that generation.${note}`;
  }
  return "Action mode for the next reply: this agent's full toolset is available (writes and delegation stay behind each agent's definition).";
}

/** Human label for mode radio buttons. */
export function modeLabel(mode: WebAgentMode): string {
  return mode === 'plan' ? 'Plan' : 'Action';
}

/**
 * Parses `?agent=` / `?mode=` search param values. Unknown, empty or missing
 * values silently fall back to the defaults — old URLs and hand-typed
 * queries never break.
 */
export function parseAgentSelection(params: {
  agent?: string | null;
  mode?: string | null;
}): AgentSelection {
  return {
    agent: isAgentSlug(params.agent) ? params.agent : DEFAULT_AGENT,
    mode: isAgentMode(params.mode) ? params.mode : DEFAULT_MODE,
  };
}

/** `true` when the selection equals the defaults old URLs leave out. */
export function isDefaultSelection(selection: AgentSelection): boolean {
  return selection.agent === DEFAULT_AGENT && selection.mode === DEFAULT_MODE;
}

/**
 * Canonical chat URL for an agent. Mode is included only when non-default
 * (`plan`), so `general/action` chats keep clean URLs. The caller owns chat
 * id validity (chat pages notFound on unsafe ids).
 */
export function buildChatUrl(chatId: string, selection?: Partial<AgentSelection>): string {
  const agent = isAgentSlug(selection?.agent) ? selection.agent : DEFAULT_AGENT;
  const mode = isAgentMode(selection?.mode) ? selection.mode : DEFAULT_MODE;
  const query = mode !== DEFAULT_MODE ? `?mode=${mode}` : '';
  return `/agents/${encodeURIComponent(agent)}/chat/${encodeURIComponent(chatId)}${query}`;
}

/** `/` — lets the server mint a fresh chat id carrying this selection. */
export function buildNewChatUrl(selection?: Partial<AgentSelection>): string {
  const agent = isAgentSlug(selection?.agent) ? selection.agent : DEFAULT_AGENT;
  const mode = isAgentMode(selection?.mode) ? selection.mode : DEFAULT_MODE;
  const params = new URLSearchParams();
  if (agent !== DEFAULT_AGENT) params.set('agent', agent);
  if (mode !== DEFAULT_MODE) params.set('mode', mode);
  const query = params.toString();
  return `/${query.length > 0 ? `?${query}` : ''}`;
}

/** Chat URL for a delegated child chat (the child runs under its own slug). */
export function childChatUrl(childChatId: string, targetAgent: string): string | null {
  // Delegation children only ever run as analyst/researcher; anything else
  // gets no link rather than a wrong one. Unsafe ids get no link either.
  if (targetAgent !== 'analyst' && targetAgent !== 'researcher') return null;
  if (!isSafeChatId(childChatId)) return null;
  return buildChatUrl(childChatId, { agent: targetAgent });
}

/**
 * Where a Work-Doc / chat-related "back to chat" link should point. An
 * explicit agent wins; without one the legacy redirect target (`general`)
 * is used — matching what `/chat/:id` redirects to.
 */
export function backToChatUrl(chatId: string, agent: string | undefined): string {
  const agentSlug = isAgentSlug(agent) ? agent : DEFAULT_AGENT;
  return buildChatUrl(chatId, { agent: agentSlug });
}
