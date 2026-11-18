/**
 * Shared contracts for the Workforce CLI.
 *
 * Later tasks (transport, tools, agent loop, REPL) build on these types, so
 * treat them as stable. They model the OpenAI-compatible Chat Completions
 * wire format used by Ollama Cloud, without binding to any SDK.
 */

/** A JSON value, as it may appear inside a tool's JSON Schema. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A JSON Schema object describing the shape of a tool's arguments. */
export type JsonSchemaObject = { readonly [key: string]: JsonValue };

/**
 * A function tool call carried on an assistant message.
 *
 * `function.arguments` is raw JSON text per the wire format; it is validated
 * locally with Zod against the tool schema before execution.
 */
export interface FunctionToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface SystemMessage {
  readonly role: 'system';
  readonly content: string;
}

export interface UserMessage {
  readonly role: 'user';
  readonly content: string;
}

/**
 * Assistant message. `content` is null when the turn consists only of tool
 * calls, matching the wire format.
 */
export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: string | null;
  readonly tool_calls?: readonly FunctionToolCall[];
}

/** Tool result sent back to the model for a previous assistant tool call. */
export interface ToolMessage {
  readonly role: 'tool';
  readonly tool_call_id: string;
  readonly content: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** Declarative description of a function tool, as sent to the model. */
export interface FunctionToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
}

/**
 * A executable tool: its schema plus a run function.
 *
 * `execute` receives the raw (unvalidated) JSON value parsed from the model's
 * arguments string. It may throw; the agent loop is responsible for catching
 * errors and reporting them back to the model as a tool message.
 */
export interface ToolDefinition {
  readonly schema: FunctionToolSchema;
  execute(args: unknown): string | Promise<string>;
}

/** Token accounting returned by the transport when available. */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** Result of one LLM completion: the assistant message plus optional usage. */
export interface LlmResponse {
  readonly message: AssistantMessage;
  readonly usage?: TokenUsage;
}

/**
 * Transport-agnostic LLM client contract. The transport task implements this
 * against the Ollama Cloud OpenAI-compatible endpoint.
 */
export interface LlmClient {
  complete(
    messages: readonly ChatMessage[],
    tools: readonly FunctionToolSchema[],
  ): Promise<LlmResponse>;
}

/** Lookup for registered tools, by name. */
export interface ToolRegistry {
  /** Returns the registered tool, or undefined for an unknown name. */
  get(name: string): ToolDefinition | undefined;
}

/** Final outcome of one agent loop run. */
export interface AgentLoopResult {
  /** Final assistant text produced for the turn. */
  readonly text: string;
  /** Full transcript for the turn, including tool messages. */
  readonly messages: readonly ChatMessage[];
  /** Number of LLM round trips performed. */
  readonly llmCalls: number;
}
