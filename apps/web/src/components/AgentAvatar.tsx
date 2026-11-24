import { cn } from '@/lib/utils';
import type { WebAgentSlug } from '@/lib/agents';
import { agentLabel } from '@/lib/workspace';

/**
 * Small round identity tile per agent: one initial, a per-agent tint.
 * Decorative (`aria-hidden`) — the surrounding role/label text already names
 * the agent for screen readers. Colors stay in the warm palette; no invented
 * avatars, no fake presence.
 */
const AGENT_TONES: Readonly<Record<WebAgentSlug, string>> = {
  general: 'bg-secondary text-secondary-foreground',
  orchestrator: 'bg-primary text-primary-foreground',
  analyst: 'bg-emerald-100 text-emerald-900',
  researcher: 'bg-amber-100 text-amber-900',
};

export function AgentAvatar({
  agent,
  size = 24,
  className,
}: {
  agent: WebAgentSlug;
  size?: number;
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full leading-none font-bold select-none',
        AGENT_TONES[agent],
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(Math.round(size * 0.44), 10) }}
      aria-hidden="true"
    >
      {agentLabel(agent).slice(0, 1)}
    </span>
  );
}
