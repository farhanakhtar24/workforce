import type { UITool, UIMessage } from 'ai';

/**
 * The UI-level tool registry: Phase 2 has exactly one static tool,
 * `calculate` (from @workforce/core, executed server-side). Typing it as a
 * named key makes `tool-calculate` a concrete literal type in `message.parts`,
 * so narrowing is exact instead of template-literal-wide.
 */
export type WorkforceUITools = { calculate: UITool };

export type WorkforceUIMessage = UIMessage<unknown, never, WorkforceUITools>;

/** Extract the concrete `tool-calculate` part (lifecycle-state union). */
export type CalculateToolPart = Extract<
  WorkforceUIMessage['parts'][number],
  { type: 'tool-calculate' }
>;
