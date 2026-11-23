/**
 * Pure partitioning of one assistant UIMessage's parts into display regions
 * (Phase 4 chat formatting fix): `Response` (all text parts, joined in their
 * original order with blank lines), `Thinking` (all reasoning parts) and
 * `Tool activity` (every tool part except the pending HITL question, which
 * stays top-level).
 *
 * The helper is total over junk input (null/unknown part shapes, unknown
 * `tool-*` types, wrong-typed fields, empty lists) and never throws: it only
 * reads `type`, `text` and `state` defensively. It does NO rendering and
 * generates no HTML — Chat.tsx maps each region onto components and React
 * escapes every string, so injection is impossible by construction. Unknown
 * part kinds (`step-start`, `file`, `source-*`, `data-*`, junk) are dropped.
 */
import { toolNameFromPartType, toolStateLabel } from './tools';

/** Minimal structural view of any UIMessage part (known or unknown). */
export interface AnyPartLike {
  readonly type: string;
}

/** One collapsed-activity entry: the original part plus a bounded label. */
export interface ActivityItem<P extends AnyPartLike> {
  readonly part: P;
  /** `calculate`, `write_doc`, … or `tool` when the type carries no name. */
  readonly name: string;
  /** Lifecycle label (`Running…`, `Result`, `Failed`, …) from tools.ts. */
  readonly stateLabel: string;
}

export interface PartitionedParts<P extends AnyPartLike> {
  /** Non-empty text parts joined with blank lines, original order; null when none. */
  readonly response: string | null;
  /** Non-empty reasoning parts joined the same way; null when none. */
  readonly reasoning: string | null;
  /**
   * The pending `tool-ask_user` part (same object reference as in `parts`)
   * when `gateActive` says this message holds the transcript's HITL gate.
   * Null otherwise — it then lives in `activity` like any other tool part.
   */
  readonly pendingAsk: P | null;
  /** Every tool part belonging in collapsed tool activity, original order kept. */
  readonly activity: readonly ActivityItem<P>[];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Split one message's parts into the display regions. `gateActive` must be
 * true only for the message that currently holds the unanswered ask_user
 * gate (newest assistant message while the composer is paused); an
 * `input-available` ask_user in any other message stays in activity.
 */
export function partitionMessageParts<P extends AnyPartLike>(
  parts: readonly P[],
  gateActive: boolean = false,
): PartitionedParts<P> {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const activity: ActivityItem<P>[] = [];
  let pendingAsk: P | null = null;

  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    const record = part as unknown as Record<string, unknown>;
    const type = typeof record['type'] === 'string' ? (record['type'] as string) : null;
    if (type === null) continue;

    if (type === 'text') {
      const text = nonEmptyString(record['text']);
      if (text !== null) textParts.push(text);
      continue;
    }
    if (type === 'reasoning') {
      const text = nonEmptyString(record['text']);
      if (text !== null) reasoningParts.push(text);
      continue;
    }
    if (type.startsWith('tool-')) {
      const state = typeof record['state'] === 'string' ? (record['state'] as string) : '';
      if (
        type === 'tool-ask_user' &&
        state === 'input-available' &&
        gateActive &&
        pendingAsk === null
      ) {
        // The prominent HITL question: rendered top-level, never inside
        // collapsed activity and never duplicated there.
        pendingAsk = part;
        continue;
      }
      activity.push({
        part,
        name: toolNameFromPartType(type) ?? 'tool',
        stateLabel: toolStateLabel(state),
      });
      continue;
    }
    // step-start / file / source-* / data-* / anything unknown: ignored.
  }

  return {
    response: textParts.length > 0 ? textParts.join('\n\n') : null,
    reasoning: reasoningParts.length > 0 ? reasoningParts.join('\n\n') : null,
    pendingAsk,
    activity,
  };
}

/**
 * Concise `<summary>` suffix for the tool-activity region: deduplicated tool
 * names in order, capped at 3 (then `+N more`), null when there is no activity.
 */
export function activitySummaryLabel(activity: readonly ActivityItem<AnyPartLike>[]): string | null {
  if (activity.length === 0) return null;
  const names = [...new Set(activity.map((item) => item.name))];
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} +${names.length - 3} more` : shown;
}
