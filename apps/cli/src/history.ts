/**
 * In-memory multi-turn conversation history for the Workforce CLI.
 *
 * Holds the full transcript (system + user + assistant + tool messages) for
 * the life of the process. No summarization or compaction in Phase 1: the
 * snapshot sent to the model is always the entire transcript.
 */

import type {
  AssistantMessage,
  ChatMessage,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from './types.js';

export class ConversationHistory {
  private readonly messages: ChatMessage[] = [];

  /** The transcript starts with exactly this system message. */
  constructor(systemPrompt: string) {
    const system: SystemMessage = { role: 'system', content: systemPrompt };
    this.messages.push(system);
  }

  /** Append a user turn and return the message for convenience. */
  addUser(content: string): UserMessage {
    const message: UserMessage = { role: 'user', content };
    this.messages.push(message);
    return message;
  }

  /** Append a message produced during the agent loop (assistant or tool). */
  append(message: AssistantMessage | ToolMessage): void {
    this.messages.push(message);
  }

  /**
   * Shallow copy of the full transcript. Callers may not mutate the internal
   * array; message objects are shared and treated as immutable.
   */
  snapshot(): readonly ChatMessage[] {
    return [...this.messages];
  }

  /** Number of messages currently in the transcript. */
  get length(): number {
    return this.messages.length;
  }
}
