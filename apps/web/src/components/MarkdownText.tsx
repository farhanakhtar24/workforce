import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/**
 * One shared safe Markdown renderer (extracted from Chat; same contract):
 * `react-markdown` + `remark-gfm`, raw HTML deliberately NOT enabled — no
 * rehype-raw and no `dangerouslySetInnerHTML` anywhere; the markdown AST
 * renders through React, which escapes all text. Partial/streamed markdown
 * renders as plain prose until the syntax closes, so streaming never crashes.
 * Styled with the audited `.chat-md` typography via `@theme` tokens.
 */
export function MarkdownText({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('chat-md', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

export default MarkdownText;
