/**
 * The host-agnostic capability contract.
 *
 * A capability is the smallest unit an agent composition can hand to a model:
 * a name (a canonical tool name for built-ins), a description, a Zod input
 * schema (validated at the boundary), an optional output schema, read/write
 * and approval metadata, and an `execute` function.
 *
 * ## The ask_user exception (human-in-the-loop)
 * Every ordinary capability MUST carry `execute`. The canonical `ask_user`
 * tool MAY omit it: {@link AskUserCapability} models a question surfaced to a
 * HUMAN — the answer travels back through the conversation channel (chat
 * turn / approval card), never through the capability call path, so core
 * composes it as metadata only. The exception is enforced at BOTH layers:
 * - type level: only `{ name: 'ask_user' }` descriptors are assignable to the
 *   execute-less overload of `defineCapability` (other names fail tsc), and
 * - runtime level: `composeAgentCapabilities` rejects a missing execute for
 *   every canonical tool except `ask_user` (see `./compose.js`).
 * An ask_user capability WITH an execute function stays a perfectly ordinary
 * {@link ExecutableCapability}.
 *
 * Deliberately SDK-INDEPENDENT: no AI-SDK types, no transport types, no
 * queue types. Hosts adapt `Capability` onto whatever tool format their
 * runtime wants (OpenAI-compatible JSON schema, AI SDK `tool()`, ...). The
 * Zod schemas here are the source of truth; `z.toJSONSchema` (zod 4) can
 * derive wire schemas from them.
 */

import type { z } from 'zod';

import { ASK_USER_TOOL_NAME } from './types.js';
import { AgentCompositionError } from './errors.js';

/** Execute signature of an ordinary capability. */
export type CapabilityExecutor = (input: unknown) => unknown | Promise<unknown>;

/** Non-execute fields shared by every capability. */
export interface CapabilityMetadata {
  /** Canonical tool name (see `agentToolNames`); must match what composition requested. */
  readonly name: string;
  /** One-to-three sentence, model-facing description. */
  readonly description: string;
  /** Strict input schema; unknown keys must be rejected by the schema itself. */
  readonly inputSchema: z.ZodType;
  /** Optional schema for the execute result; absent when the result is opaque. */
  readonly outputSchema?: z.ZodType | null;
  /** True when execution never mutates shared state (writes, side effects). */
  readonly readOnly: boolean;
  /** True when a human must approve before execute runs (host-enforced). */
  readonly requiresApproval: boolean;
  /** Why approval is required; null/absent when no approval is needed. */
  readonly approvalReason?: string | null;
}

/** An ordinary capability: validated input in, result (or promise) out. */
export interface ExecutableCapability extends CapabilityMetadata {
  readonly execute: CapabilityExecutor;
}

/**
 * The human-in-the-loop `ask_user` capability: composable WITHOUT execute.
 * The host owns surfacing the question and receiving the answer; core only
 * guarantees the tool is visible to the composed agent with its metadata.
 */
export interface AskUserCapability extends CapabilityMetadata {
  readonly name: 'ask_user';
  readonly execute?: undefined;
}

/** Every capability is executable, or the execute-less ask_user form. */
export type Capability = ExecutableCapability | AskUserCapability;

/** Descriptor (metadata) of an ordinary capability; pass `execute` separately. */
export type CapabilityDescriptor = Omit<ExecutableCapability, 'execute'>;

/** Descriptor of an execute-less ask_user capability. */
export type AskUserCapabilityDescriptor = Omit<AskUserCapability, 'execute'> & {
  readonly execute?: undefined;
};

/** Runtime narrowing: true exactly when `execute` is a function. */
export function isExecutableCapability(capability: Capability): capability is ExecutableCapability {
  return typeof capability.execute === 'function';
}

/**
 * Freeze a capability into a fully immutable {@link Capability}.
 *
 * - With `execute`: returns an {@link ExecutableCapability}.
 * - Without `execute`: ONLY valid for the canonical `ask_user` capability;
   anything else throws typed (mirrors the compile-time restriction).
 */
export function defineCapability(descriptor: CapabilityDescriptor, execute: CapabilityExecutor): ExecutableCapability;
export function defineCapability(descriptor: AskUserCapabilityDescriptor): AskUserCapability;
export function defineCapability(
  descriptor: CapabilityDescriptor | AskUserCapabilityDescriptor,
  execute?: CapabilityExecutor,
): Capability {
  if (execute === undefined) {
    if ((descriptor as { readonly execute?: unknown }).execute !== undefined) {
      // execute-less form must not smuggle an execute through the descriptor.
      throw new AgentCompositionError(
        `pass the execute function as the second argument, not inside the descriptor of ${JSON.stringify(descriptor.name)}`,
      );
    }
    if (descriptor.name !== ASK_USER_TOOL_NAME) {
      throw new AgentCompositionError(
        `only the ${ASK_USER_TOOL_NAME} capability may omit execute; ` +
          `${JSON.stringify(descriptor.name)} requires one`,
      );
    }
    const askUser: AskUserCapability = {
      ...(descriptor as AskUserCapabilityDescriptor),
      outputSchema: descriptor.outputSchema ?? null,
      approvalReason: descriptor.approvalReason ?? null,
      execute: undefined,
    };
    return Object.freeze(askUser);
  }
  const capability: ExecutableCapability = {
    ...(descriptor as CapabilityDescriptor),
    outputSchema: descriptor.outputSchema ?? null,
    approvalReason: descriptor.approvalReason ?? null,
    execute,
  };
  return Object.freeze(capability);
}
