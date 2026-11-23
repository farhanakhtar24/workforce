import type { UITool, UIMessage } from 'ai';

/**
 * The UI-level tool registry: the Phase 4 canonical tool names that can appear
 * as static tool parts in a stored UIMessage transcript. Typing them as named
 * keys makes each `tool-<name>` a concrete literal type in `message.parts`,
 * so narrowing is exact instead of template-literal-wide. Every entry stays
 * `UITool` (unknown input/output): the UI renders defensively — output shapes
 * are parsed by `src/lib/tools.ts`, never trusted blindly.
 */
export type WorkforceUITools = {
  calculate: UITool;
  write_doc: UITool;
  delegate_task: UITool;
  query_data: UITool;
  search_memory: UITool;
  ask_user: UITool;
};

export type WorkforceUIMessage = UIMessage<unknown, never, WorkforceUITools>;

/** Extract one concrete `tool-<name>` part (lifecycle-state union). */
export type CalculateToolPart = Extract<
  WorkforceUIMessage['parts'][number],
  { type: 'tool-calculate' }
>;
export type WriteDocToolPart = Extract<
  WorkforceUIMessage['parts'][number],
  { type: 'tool-write_doc' }
>;
export type DelegateTaskToolPart = Extract<
  WorkforceUIMessage['parts'][number],
  { type: 'tool-delegate_task' }
>;
export type QueryDataToolPart = Extract<
  WorkforceUIMessage['parts'][number],
  { type: 'tool-query_data' }
>;
export type SearchMemoryToolPart = Extract<
  WorkforceUIMessage['parts'][number],
  { type: 'tool-search_memory' }
>;
export type AskUserToolPart = Extract<
  WorkforceUIMessage['parts'][number],
  { type: 'tool-ask_user' }
>;

/**
 * Generic lifecycle view of any tool part (known or unknown `tool-*` type).
 * The AI SDK part states are: input-streaming → input-available →
 * output-available | output-error (plus approval states Phase 4 never
 * produces — they render through the same generic view).
 */
export interface AnyToolPartView {
  readonly type: string;
  readonly state: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly errorText?: string;
}
