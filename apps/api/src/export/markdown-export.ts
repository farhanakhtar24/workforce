/**
 * Pure Markdown exporter for one stored UIMessage transcript (pre-Phase 6
 * sidebar EXPORT action).
 *
 * Data discipline:
 * - COMPLETE: every stored message renders (never truncated globally);
 *   headings per turn, ALL visible user/assistant text, reasoning in a
 *   clearly-labelled section when present.
 * - Tool parts render as a labelled section with their INPUT/OUTPUT as
 *   complete JSON in a fenced block — only the fence delimiter selection is
 *   computed so tool content can never break the document structure. Nothing
 *   inside a payload is trimmed by design.
 * - NO metadata, vectors, embeddings, usage, model ids, auth/session/owner
 *   identifiers, or any other server-side secrets ever reach the document —
 *   only the exact stored message `id`, role, and parts.
 * - The document is deterministic for the same transcript (pure function).
 */

/** Bounded, deterministic header block. */
export function exportHeader(input: { chatId: string; agent: string; exportedAt: string }): string[] {
  return [
    `# Chat export — ${input.agent} / ${input.chatId}`,
    '',
    `_Exported: ${input.exportedAt}_`,
    '',
    '---',
  ];
}

/** One turn (message): heading + visible sections, deterministic. */
export function renderMessage(message: unknown): string[] {
  const lines: string[] = [];
  if (message === null || typeof message !== 'object') {
    return lines;
  }
  const record = message as {
    id?: unknown;
    role?: unknown;
    parts?: unknown;
  };
  const role = record.role === 'assistant' ? 'Assistant' : record.role === 'user' ? 'User' : String(record.role ?? 'Unknown');
  lines.push(`### ${role}`, '');
  if (typeof record.id === 'string' && record.id.length > 0) {
    lines.push(`_Message id: ${record.id}_`, '');
  }
  const parts = Array.isArray(record.parts) ? record.parts : [];
  let sawText = false;
  let sawReasoning = false;
  let sawTool = false;
  for (const part of parts) {
    if (part === null || typeof part !== 'object') {
      continue;
    }
    const partRecord = part as { type?: unknown; text?: unknown; toolCallId?: unknown };
    if (partRecord.type === 'text' && typeof partRecord.text === 'string' && partRecord.text.length > 0) {
      if (sawText || sawReasoning || sawTool) {
        lines.push('');
      }
      lines.push(...partRecord.text.split('\n'));
      sawText = true;
      continue;
    }
    if (partRecord.type === 'reasoning' && typeof partRecord.text === 'string' && partRecord.text.length > 0) {
      lines.push('', '**Reasoning**', '', ...fencedContent(partRecord.text).lines);
      sawReasoning = true;
      continue;
    }
    if (typeof partRecord.type === 'string' && partRecord.type.startsWith('tool-') && partRecord.type !== 'tool-step-start') {
      const toolName = partRecord.type.slice('tool-'.length);
      const toolCallId = typeof partRecord.toolCallId === 'string' ? partRecord.toolCallId : 'unknown';
      const payload: unknown = { input: (part as { input?: unknown }).input, output: (part as { output?: unknown }).output };
      const rendered = JSON.stringify(payload, null, 2);
      lines.push('', `**Tool: ${toolName}** (_toolCallId: ${toolCallId}_)`, '', ...fencedJson(rendered).lines);
      sawTool = true;
      continue;
    }
    // Step markers / unknown shapes: skip (structural, not transcript text).
  }
  if (sawText === false && sawReasoning === false && sawTool === false) {
    lines.push('_(no visible content)_');
  }
  return lines;
}

/**
 * Picks a fenced-block delimiter that CANNOT close early: the fence is one
 * tick longer than the longest ``` or ￣ run in the content. Delimiter runs
 * at the START of a line would close a plain fence, so the chosen fence is
 * always longer than anything present.
 */
export function fencedContent(content: string): { lines: string[] } {
  let maxRun = 0;
  const run = /`{3,}|~{3,}/g;
  for (const match of content.matchAll(run)) {
    maxRun = Math.max(maxRun, match[0]?.length ?? 0);
  }
  maxRun = Math.max(maxRun, 3);
  const delimiter = content.includes('``' ) || maxRun > 3 ? '``'.repeat(maxRun + 1) : '```';
  return {
    lines: [delimiter, ...content.split('\n'), delimiter],
  };
}

/** JSON variant of {@link fencedContent} with the fixed `json` info suffix. */
export function fencedJson(content: string): { lines: string[] } {
  const inner = fencedContent(content).lines;
  return { lines: [`${inner[0]}json`, ...inner.slice(1)] };
}

/**
 * Full-document renderer: header + one block per message with separators.
 * Content never truncates; the ONLY bounds are the tool payload fence
 * selection (structural) above.
 */
export function renderChatExport(input: {
  chatId: string;
  agent: string;
  exportedAt: string;
  messages: readonly unknown[];
}): string {
  const lines: string[] = [...exportHeader(input), ''];
  for (const message of input.messages) {
    if (lines.length > 0 && lines[lines.length - 1] === '' && lines.length > 5) {
      lines.push('---', '');
    }
    lines.push(...renderMessage(message), '');
  }
  if (input.messages.length === 0) {
    lines.push('_(no messages)_');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Content-Disposition-safe filename (bounded, alnum/dash/dot only). */
export function exportFilename(chatId: string, exportedAt: string): string {
  const safe = chatId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
  const day = exportedAt.slice(0, 10).replace(/[^0-9-]/g, '') || 'export';
  return `chat-${safe.length > 0 ? safe : 'export'}-${day}.md`;
}
