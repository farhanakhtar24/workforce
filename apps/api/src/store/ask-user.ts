/**
 * Byte-exact `ask_user` answer patching for stored UIMessage list entries.
 *
 * The stored entry is the raw JSON written by `appendMessage` (Node's
 * `JSON.stringify`). The old Redis path round-tripped the WHOLE message
 * through Lua `cjson` decode/encode, which corrupts data: cjson cannot tell
 * an empty ARRAY from an empty OBJECT (`options:[]` becomes `{}`), and numeric
 * literals outside double precision lose digits on the decode/encode
 * round-trip.
 *
 * This module fixes that: the ONLY bytes replaced are the matched part's
 * `state` value (and an inserted `"output":{...}`). Everything co-located —
 * key order, `options:[]`, large numeric literals, unicode escapes — stays
 * byte-identical because we never re-serialize what we do not touch:
 *
 * 1. A string-aware scan locates every `"toolCallId"` KEY occurrence outside
 *    JSON strings (content text containing the literal is skipped).
 * 2. The enclosing object is isolated by a string-aware brace walk; the slice
 *    must parse to the matching pending `tool-ask_user` part.
 * 3. The part's TOP-LEVEL `"state"` value must be exactly `"input-available"`
 *    (pending) — otherwise no patch (idempotent no-op).
 * 4. The new raw = original with the state value swapped and
 *    `,"output":{"answer":…}` inserted right after it. All inserted bytes are
 *    authored here; the answer is JSON.stringify'd (a plain string).
 */

export const ASK_USER_PART_TYPE = 'tool-ask_user';
export const ASK_USER_PENDING_STATE = 'input-available';
export const ASK_USER_ANSWERED_STATE = 'output-available';

/** Sentinel for older pending questions that were never actually answered. */
export const ASK_USER_NO_ANSWER = '(no answer given)';

interface StringScanner {
  /** Returns the index just past the string starting at `openQuote`, or -1. */
  endOfString(raw: string, openQuote: number): number;
  /** Walks back from any `"` to ITS opening quote, -1 when unbalanced. */
  startOfString(raw: string, closeQuote: number): number;
  /** Matching `}`/`]`/`>`-aware end for the bracket opened at `open`. */
  matchingClose(raw: string, open: number, closeChar: '}' | ']'): number;
  /** Indices where `needle` occurs OUTSIDE any JSON string. */
  unquotedOccurrences(raw: string, needle: string): number[];
}

const scanner: StringScanner = {
  endOfString(raw, openQuote) {
    let i = openQuote + 1;
    while (i < raw.length) {
      const char = raw[i];
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === '"') {
        return i + 1;
      }
      i += 1;
    }
    return -1;
  },
  startOfString(raw, closeQuote) {
    // Walk back from just before the closing quote; a quote is the OPENING
    // one only when its preceding backslash run is even-length.
    let i = closeQuote - 1;
    while (i >= 0) {
      if (raw[i] === '"' && !isEscapedQuote(raw, i)) {
        return i;
      }
      i -= 1;
    }
    return -1;
  },
  matchingClose(raw, open, closeChar) {
    // The bracket at `open` is counted first, so its match is the first
    // `closeChar` that brings depth back from 1 to 0.
    let depth = 0;
    let i = open;
    while (i < raw.length) {
      const char = raw[i];
      if (char === '"') {
        const end = scanner.endOfString(raw, i);
        if (end === -1) {
          return -1;
        }
        i = end;
        continue;
      }
      if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === closeChar && depth === 1) {
        return i;
      } else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth < 0) {
          return -1; // mismatched close at our level
        }
      }
      i += 1;
    }
    return -1;
  },
  unquotedOccurrences(raw, needle) {
    const hits: number[] = [];
    let i = 0;
    while (i < raw.length) {
      const char = raw[i];
      if (char === '"') {
        if (raw.startsWith(needle, i)) {
          hits.push(i);
        }
        const end = scanner.endOfString(raw, i);
        i = end === -1 ? i + 1 : end;
        continue;
      }
      i += 1;
    }
    return hits;
  },
};

/** True when the quote at `index` is escaped (odd-length backslash run before it). */
function isEscapedQuote(raw: string, index: number): boolean {
  let backslashes = 0;
  let j = index - 1;
  while (j >= 0 && raw[j] === '\\') {
    backslashes += 1;
    j -= 1;
  }
  return backslashes % 2 === 1;
}

/** Skips whitespace after `from`; returns the index of the first non-ws char. */
function skipWhitespace(raw: string, from: number): number {
  let i = from;
  while (i < raw.length && /\s/.test(raw[i] ?? '')) {
    i += 1;
  }
  return i;
}

interface PartPatch {
  readonly nextRaw: string;
}

/**
 * Finds the FIRST usable candidate part and returns the patched whole-entry
 * raw. `null` means: no pending matching part (wrong id, answered already, or
 * malformed entry) — the caller treats that as an idempotent no-op.
 */
export function buildAskUserAnswerPatch(
  raw: string,
  assistantMessageId: string,
  toolCallId: string,
  answer: string,
): PartPatch | null {
  if (typeof raw !== 'string' || raw.length === 0 || !raw.includes('"toolCallId"')) {
    return null;
  }
  // Structural validation ONLY (ids/status are strings; numeric fields that a
  // double-precision parse would distort are never re-serialized from here).
  let parsedMessage: { id?: unknown; role?: unknown; parts?: unknown };
  try {
    parsedMessage = JSON.parse(raw) as typeof parsedMessage;
  } catch {
    return null;
  }
  if (
    parsedMessage['role'] !== 'assistant' ||
    parsedMessage['id'] !== assistantMessageId ||
    !Array.isArray(parsedMessage['parts'])
  ) {
    return null;
  }
  const pendingCount = (parsedMessage['parts'] as unknown[]).filter(
    (part) =>
      part !== null &&
      typeof part === 'object' &&
      (part as Record<string, unknown>)['type'] === ASK_USER_PART_TYPE &&
      (part as Record<string, unknown>)['toolCallId'] === toolCallId &&
      (part as Record<string, unknown>)['state'] === ASK_USER_PENDING_STATE,
  ).length;
  if (pendingCount !== 1) {
    return null; // 0 → already answered/absent; >1 → undefined transcript, never patch blindly
  }

  for (const keyIndex of scanner.unquotedOccurrences(raw, '"toolCallId"')) {
    // The occurrence must be a KEY: followed by ':' then a JSON string value.
    const colonIndex = skipWhitespace(raw, scanner.endOfString(raw, keyIndex));
    if (raw[colonIndex] !== ':') {
      continue;
    }
    const valueStart = skipWhitespace(raw, colonIndex + 1);
    if (raw[valueStart] !== '"') {
      continue;
    }
    const valueEnd = scanner.endOfString(raw, valueStart);
    if (valueEnd === -1) {
      continue;
    }
    let parsedId: unknown;
    try {
      parsedId = JSON.parse(raw.slice(valueStart, valueEnd));
    } catch {
      continue;
    }
    if (parsedId !== toolCallId) {
      continue;
    }
    const partStart = backwardEnclosingObjectStart(raw, keyIndex);
    if (partStart === -1) {
      continue;
    }
    const partEnd = scanner.matchingClose(raw, partStart, '}');
    if (partEnd === -1 || partEnd <= partStart) {
      continue;
    }
    const slice = raw.slice(partStart, partEnd + 1);
    let sliceObject: Record<string, unknown>;
    try {
      sliceObject = JSON.parse(slice) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      sliceObject['type'] !== ASK_USER_PART_TYPE ||
      sliceObject['toolCallId'] !== toolCallId ||
      sliceObject['state'] !== ASK_USER_PENDING_STATE
    ) {
      continue;
    }
    const stateSpan = findTopLevelStateValue(slice);
    if (stateSpan === null) {
      continue;
    }
    const outputJson = JSON.stringify({ answer });
    const nextSlice =
      slice.slice(0, stateSpan.valueStart) +
      JSON.stringify(ASK_USER_ANSWERED_STATE) +
      `,"output":${outputJson}` +
      slice.slice(stateSpan.valueEnd);
    const nextRaw = raw.slice(0, partStart) + nextSlice + raw.slice(partEnd + 1);
    try {
      JSON.parse(nextRaw); // safety: the spliced entry must stay valid JSON
    } catch {
      continue;
    }
    return { nextRaw };
  }
  return null;
}

/**
 * String-aware backward walk to the `{` of the object enclosing the position
 * that starts the `"toolCallId"` key.
 */
function backwardEnclosingObjectStart(raw: string, from: number): number {
  let depth = 0;
  // `from` is the START of a key token (its opening quote): walk from the
  // byte before it. Invariant while walking backward: any quote met is a
  // string's closing quote (its opening lies earlier), so jump over the
  // whole string.
  let i = from - 1;
  while (i >= 0) {
    const char = raw[i];
    if (char === '"') {
      const start = scanner.startOfString(raw, i);
      if (start === -1) {
        return -1;
      }
      i = start - 1;
      continue;
    }
    if (char === '}' || char === ']') {
      depth += 1;
      i -= 1;
      continue;
    }
    if (char === '{' || char === '[') {
      if (char === '{' && depth === 0) {
        return i;
      }
      depth -= 1;
      i -= 1;
      continue;
    }
    i -= 1;
  }
  return -1;
}

interface StateSpan {
  readonly valueStart: number;
  readonly valueEnd: number; // exclusive, just past the closing quote
}

/**
 * Within a part-object slice: the `[start, end)` span of the TOP-LEVEL
 * `"state"` string value, only when it is exactly `"input-available"`.
 */
function findTopLevelStateValue(slice: string): StateSpan | null {
  for (const keyIndex of scanner.unquotedOccurrences(slice, '"state"')) {
    const colonIndex = skipWhitespace(slice, scanner.endOfString(slice, keyIndex));
    if (slice[colonIndex] !== ':') {
      continue;
    }
    // ONLY a top-level key of the part object: its enclosing object is the
    // slice itself.
    const enclosing = backwardEnclosingObjectStart(slice, keyIndex);
    if (enclosing !== 0) {
      continue;
    }
    const valueStart = skipWhitespace(slice, colonIndex + 1);
    if (slice[valueStart] !== '"') {
      continue;
    }
    const valueEnd = scanner.endOfString(slice, valueStart);
    if (valueEnd === -1) {
      continue;
    }
    const value = slice.slice(valueStart, valueEnd);
    if (value === JSON.stringify(ASK_USER_PENDING_STATE)) {
      return { valueStart, valueEnd };
    }
    // Any other state value: not pending.
    return null;
  }
  return null;
}

/**
 * Shared algorithm for both stores: load the raw list entries fresh, patch the
 * matching entry, CAS-write it. `cas` returns false when the entry changed
 * between read and write (another writer) — the store re-reads and retries
 * within the bounded budget, then reports 'stale'. No whole-list rewrite ever
 * happens — only ONE entry is ever LSET/replaced, and only on an exact
 * expected-bytes match.
 */
export async function applyAskUserAnswer(
  loadRawEntries: () => Promise<string[]>,
  cas: (entryIndex: number, expectedRaw: string, nextRaw: string) => Promise<boolean>,
  assistantMessageId: string,
  toolCallId: string,
  answer: string,
  attempts = 3,
): Promise<'applied' | 'unchanged' | 'stale'> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const entries = await loadRawEntries();
    let targetIndex = -1;
    for (let index = 0; index < entries.length; index += 1) {
      const raw = entries[index];
      if (raw === undefined || !raw.includes('"toolCallId"')) {
        continue;
      }
      const match = entryIsAssistantWithId(raw, assistantMessageId);
      if (match) {
        targetIndex = index;
        break;
      }
    }
    if (targetIndex === -1) {
      return 'unchanged';
    }
    const patch = buildAskUserAnswerPatch(entries[targetIndex] as string, assistantMessageId, toolCallId, answer);
    if (patch === null) {
      // The matched assistant entry has NO pending matching part: answered
      // already, never had it, or a malformed transcript — idempotent no-op.
      return 'unchanged';
    }
    const won = await cas(targetIndex, entries[targetIndex] as string, patch.nextRaw);
    if (won) {
      return 'applied';
    }
    // CAS lost to a concurrent writer: fresh re-read on the next attempt.
  }
  return 'stale';
}

/** Parse guard: the entry is the assistant message with exactly this id. */
function entryIsAssistantWithId(raw: string, assistantMessageId: string): boolean {
  let parsed: { id?: unknown; role?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return false;
  }
  return parsed['role'] === 'assistant' && parsed['id'] === assistantMessageId;
}
