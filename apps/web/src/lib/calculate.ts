/**
 * Pure formatting helpers for `calculate` tool parts.
 *
 * The tool's execute returns a JSON *string* like `{"result":14}` (see
 * `packages/core/src/capabilities/calculate`). All helpers are total: they
 * never throw and never produce HTML — output is always rendered as plain
 * text by React, so injection is impossible by construction.
 */

/** Rendered labels for a tool part in each of its lifecycle states. */
export type CalculateStateLabel = string;

export function calculateStateLabel(state: string): CalculateStateLabel {
  switch (state) {
    case 'input-streaming':
      return 'Preparing calculation…';
    case 'input-available':
      return 'Calculating…';
    case 'output-available':
      return 'Result';
    case 'output-error':
      return 'Calculation failed';
    default:
      return 'Calculation';
  }
}

/** Hard cap for any echoed tool text; bounded render area, bounded tokens. */
export const CALCULATE_TEXT_LIMIT = 200;

export function truncateText(value: string, limit = CALCULATE_TEXT_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export interface CalculateOutputSuccess {
  status: 'ok';
  /** Finite resulting number from the tool. */
  result: number;
}

export interface CalculateOutputFailure {
  status: 'fallback';
  /** Safe plain-text fallback (JSON.stringify of whatever arrived, truncated). */
  text: string;
}

export type CalculateOutputView = CalculateOutputSuccess | CalculateOutputFailure;

/**
 * The tool output may currently be the string `'{"result":14}'` (execute
 * returns a JSON string) or, defensively, a plain number or object. Anything
 * else becomes a truncated, plain-text fallback.
 */
export function parseCalculateOutput(output: unknown): CalculateOutputView {
  const parse = (candidate: unknown): number | null => {
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string') {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (typeof parsed === 'number') return parsed;
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof (parsed as Record<string, unknown>).result === 'number'
        ) {
          return (parsed as { result: number }).result;
        }
      } catch {
        return null;
      }
    }
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof (candidate as Record<string, unknown>).result === 'number'
    ) {
      return (candidate as { result: number }).result;
    }
    return null;
  };

  const result = parse(output);
  if (result !== null && Number.isFinite(result)) {
    return { status: 'ok', result };
  }
  const text =
    typeof output === 'string' ? output : JSON.stringify(output) ?? String(output);
  return { status: 'fallback', text: truncateText(text || '(no output)') };
}

/** Format the tool input (currently `{ expression: string }`) as safe text. */
export function formatCalculateInput(input: unknown): string {
  if (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as Record<string, unknown>).expression === 'string'
  ) {
    return truncateText((input as { expression: string }).expression);
  }
  if (input === undefined) return '(pending)';
  try {
    return truncateText(JSON.stringify(input));
  } catch {
    return '(pending)';
  }
}
