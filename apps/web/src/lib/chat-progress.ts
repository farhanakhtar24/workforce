/**
 * Live progress derivation for the chat (Farhan's UX request B). Pure so the
 * stage machine, precedence and long-wait copy are testable without a browser.
 * Never claims tool/reasoning activity that did not arrive: a stage requires
 * the corresponding live part on the CURRENT streaming generation.
 */

import type { WorkforceUIMessage } from './messages';

export type ProgressKind = 'sending' | 'waiting' | 'thinking' | 'tool' | 'writing';

export interface ProgressStage {
  kind: ProgressKind;
  /** Lowercased tool name when `kind === 'tool'` (from `tool-<name>`), else null. */
  toolName: string | null;
}

/** Fixed, honest stage copy — no fake percentage, no stop-button implication. */
export const PROGRESS_LABELS: Readonly<Record<ProgressKind, string>> = {
  sending: 'Sending your message',
  waiting: 'Waiting for the model',
  thinking: 'Thinking',
  tool: 'Using tool',
  writing: 'Writing response',
};

export function progressLabel(stage: ProgressStage): string {
  if (stage.kind === 'tool' && stage.toolName !== null) return `Using ${stage.toolName}`;
  return PROGRESS_LABELS[stage.kind];
}

const LIVE_TOOL_STATES = new Set(['input-streaming', 'input-available']);

function toolNameFromType(type: string): string | null {
  return type.startsWith('tool-') ? type.slice(5) : null;
}

/**
 * Derives the visible stage from `useChat` status + the CURRENT latest
 * assistant raw parts (junk/unknown parts are ignored defensively, same as
 * the part partitioner). Precedence while streaming: a tool still awaiting
 * its result is the live activity, then visible text (writing), then live
 * reasoning (thinking), else waiting for the first observable part.
 */
export function deriveProgressStage(input: {
  status: 'submitted' | 'streaming';
  parts: WorkforceUIMessage['parts'] | ReadonlyArray<unknown>;
}): ProgressStage {
  if (input.status === 'submitted') {
    return { kind: 'sending', toolName: null };
  }
  let liveToolName: string | null = null;
  let liveText = false;
  let liveReasoning = false;
  for (const part of input.parts) {
    if (part === null || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    const type = typeof record['type'] === 'string' ? record['type'] : null;
    if (type === null) continue;
    if (type.startsWith('tool-')) {
      const state = typeof record['state'] === 'string' ? record['state'] : '';
      if (liveToolName === null && LIVE_TOOL_STATES.has(state)) {
        liveToolName = toolNameFromType(type);
      }
      continue;
    }
    if (type === 'text') {
      const text = typeof record['text'] === 'string' ? record['text'].trim() : '';
      if (!liveText && text !== '') liveText = true;
      continue;
    }
    if (type === 'reasoning') {
      const text = typeof record['text'] === 'string' ? record['text'].trim() : '';
      if (!liveReasoning && text !== '') liveReasoning = true;
      continue;
    }
  }
  if (liveToolName !== null) return { kind: 'tool', toolName: liveToolName };
  if (liveText) return { kind: 'writing', toolName: null };
  if (liveReasoning) return { kind: 'thinking', toolName: null };
  return { kind: 'waiting', toolName: null };
}

/** The honest long-wait threshold (~12 s): still active, no fake progress. */
export const LONG_WAIT_SECONDS = 12;
export const LONG_WAIT_TEXT =
  'Taking longer than usual. Check your internet connection; the request is still active.';

export function isLongWait(elapsedSeconds: number): boolean {
  return Number.isFinite(elapsedSeconds) && elapsedSeconds >= LONG_WAIT_SECONDS;
}

export function formatElapsed(elapsedSeconds: number): string {
  const bounded = Number.isFinite(elapsedSeconds) ? Math.max(0, Math.floor(elapsedSeconds)) : 0;
  return `${bounded}s`;
}

/* Offline copy: honest about what stays, what may fail, and what does NOT
   happen automatically (no auto-resume promise — ADR-005 semantics). */
export const OFFLINE_TITLE = 'You appear to be offline.';
export const OFFLINE_BODY =
  'Your draft and chat history stay safe. The provider request can fail while offline — reconnect before retrying. Nothing resumes automatically.';
export const OFFLINE_BUSY_BODY =
  'The pending request has no confirmed progress until your connection returns.';
