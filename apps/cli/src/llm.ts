import { z } from 'zod';
import type { Config } from './config.js';
import type {
  AssistantMessage,
  ChatMessage,
  FunctionToolSchema,
  LlmClient,
  LlmResponse,
} from './types.js';

/**
 * Raw-HTTP transport against the Ollama Cloud OpenAI-compatible Chat
 * Completions endpoint. No SDK, no streaming.
 *
 * Security invariants:
 * - The API key appears only in the `Authorization` header. It is never
 *   logged, echoed into an error message, or included in truncated bodies.
 * - Error messages contain the HTTP status and a truncated response body,
 *   never the config or the request headers.
 */

const MAX_ERROR_BODY_CHARS = 500;

/**
 * Replace the API key with `[redacted]` before any response body excerpt is
 * used in an error message: a provider echo (e.g. an upstream proxy error or
 * a JSON dump of the request) must not leak the bearer token.
 */
function redactApiKey(text: string, apiKey: string): string {
  if (apiKey.length === 0) {
    return text;
  }
  return text.split(apiKey).join('[redacted]');
}

/** Truncate a provider response body for inclusion in an error message. */
function truncate(text: string, max = MAX_ERROR_BODY_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Summarize the first few Zod issues without dumping the whole payload. */
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable(),
  tool_calls: z.array(toolCallSchema).optional(),
});

const usageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
});

const completionResponseSchema = z.object({
  choices: z.array(z.object({ message: assistantMessageSchema })).min(1),
  usage: usageSchema.optional(),
});

/**
 * Creates an {@link LlmClient} that talks to Ollama Cloud over raw HTTP.
 *
 * `fetchImpl` is injectable for tests; it defaults to the global `fetch`.
 */
export function createOllamaClient(
  config: Config,
  fetchImpl: typeof fetch = fetch,
): LlmClient {
  return {
    async complete(
      messages: readonly ChatMessage[],
      tools: readonly FunctionToolSchema[],
    ): Promise<LlmResponse> {
      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        stream: false,
      };
      if (tools.length > 0) {
        body.tools = tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
      }

      // tool_choice and response_format are intentionally not sent: Ollama's
      // compatibility endpoint does not support either.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new Error(
              `Ollama Cloud request timed out after ${config.timeoutMs}ms`,
            );
          }
          // Rejected without abort (network error). Re-throwing the original
          // error is safe: the key only ever travels in the header, which
          // fetch errors never include. String rejections are wrapped.
          if (error instanceof Error) {
            throw error;
          }
          throw new Error('Ollama Cloud request failed with a non-Error rejection');
        }

        const raw: string = await response.text();

        if (!response.ok) {
          throw new Error(
            `Ollama Cloud request failed (HTTP ${response.status}): ${truncate(redactApiKey(raw, config.apiKey))}`,
          );
        }

        let json: unknown;
        try {
          json = JSON.parse(raw) as unknown;
        } catch {
          throw new Error(
            `Ollama Cloud returned invalid JSON: ${truncate(redactApiKey(raw, config.apiKey))}`,
          );
        }

        const parsed = completionResponseSchema.safeParse(json);
        if (!parsed.success) {
          throw new Error(
            `Ollama Cloud response failed validation: ${summarizeIssues(parsed.error)}`,
          );
        }

        const choice = parsed.data.choices[0];
        if (!choice) {
          throw new Error('Ollama Cloud returned no choices');
        }

        const rawMessage = choice.message;
        if (
          rawMessage.content === null &&
          (rawMessage.tool_calls === undefined || rawMessage.tool_calls.length === 0)
        ) {
          throw new Error(
            'Ollama Cloud returned an assistant message with no content and no tool calls',
          );
        }

        const message: AssistantMessage = {
          role: 'assistant',
          content: rawMessage.content,
          ...(rawMessage.tool_calls === undefined
            ? {}
            : { tool_calls: rawMessage.tool_calls }),
        };

        const usage = parsed.data.usage;
        return {
          message,
          ...(usage === undefined
            ? {}
            : {
                usage: {
                  promptTokens: usage.prompt_tokens,
                  completionTokens: usage.completion_tokens,
                  totalTokens: usage.total_tokens,
                },
              }),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
