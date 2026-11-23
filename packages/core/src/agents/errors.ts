/**
 * Typed errors for agent composition. Mirrors the memory-domain error style:
 * stable machine `code` first, human message without echoing registry internals.
 *
 * - `agent_composition_error` -> 400 (bad slug/mode/depth, registry returning
 *   a capability whose name does not match the requested canonical tool)
 */

export type AgentErrorCode = 'agent_composition_error';

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentError';
    this.code = code;
  }
}

export class AgentCompositionError extends AgentError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('agent_composition_error', message, options);
    this.name = 'AgentCompositionError';
  }
}
