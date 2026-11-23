import { test } from 'node:test';
import assert from 'node:assert/strict';

import { z } from 'zod';

import {
  MAX_DELEGATION_DEPTH,
  ROOT_AGENT_DEPTH,
  ASK_USER_TOOL_NAME,
  AgentCompositionError,
  MapAgentRegistry,
  agentDefinitions,
  agentModes,
  agentSlugs,
  agentToolNames,
  allowsDelegation,
  builtinAgentRegistry,
  calculateCapability,
  childDepth,
  composeAgentCapabilities,
  composeAllowedToolNames,
  composeWritePotential,
  defineCapability,
  isExecutableCapability,
  DELEGATION_TOOL_NAME,
  WRITE_DOC_TOOL_NAME,
  type AgentMode,
  type AgentRegistry,
  type AgentSlug,
  type Capability,
} from './index.js';

// ---------------------------------------------------------------------------
// Test fakes: deterministic capabilities for every canonical tool
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS: readonly string[] = ['calculate', 'query_data', 'search_memory', 'ask_user'];

function fakeCapability(name: string): Capability {
  return defineCapability(
    {
      name,
      description: `fake ${name} capability`,
      inputSchema: z.object({}).strict(),
      outputSchema: null,
      readOnly: READ_ONLY_TOOLS.includes(name),
      requiresApproval: !READ_ONLY_TOOLS.includes(name),
      approvalReason: READ_ONLY_TOOLS.includes(name) ? null : `fake ${name} mutates shared state`,
    },
    (input: unknown) => input,
  );
}

function makeFullRegistry(): MapAgentRegistry {
  return new MapAgentRegistry(agentToolNames.map((name) => fakeCapability(name)));
}

function makeEmptyRegistry(): AgentRegistry {
  return { get: () => undefined };
}

const WRITE_DOC = 'write_doc';
const DELEGATE = 'delegate_task';

/** Expected composed toolName sets for the complete slug x mode x depth matrix. */
function expectedToolNames(agent: AgentSlug, mode: AgentMode, depth: number): readonly string[] {
  const read = {
    general: ['calculate'],
    orchestrator: ['calculate', 'query_data', 'search_memory', 'ask_user'],
    analyst: ['calculate', 'query_data', 'search_memory', 'ask_user'],
    researcher: ['calculate', 'search_memory', 'ask_user'],
  }[agent];
  const write = {
    general: [],
    orchestrator: [WRITE_DOC, DELEGATE],
    analyst: [],
    researcher: [],
  }[agent];
  if (mode === 'plan') {
    return read;
  }
  const effectiveWrite = write.filter((tool) => !(tool === DELEGATE && !allowsDelegation(depth)));
  return [...read, ...effectiveWrite];
}

// ---------------------------------------------------------------------------
// The complete slug x mode x depth matrix
// ---------------------------------------------------------------------------

test('composition selects exactly the definition tools for every slug x mode x depth combination', () => {
  const registry = makeFullRegistry();
  for (const agent of agentSlugs) {
    for (const mode of agentModes) {
      for (let depth = ROOT_AGENT_DEPTH; depth <= MAX_DELEGATION_DEPTH; depth += 1) {
        const composed = composeAgentCapabilities({ agent, mode, depth, registry });
        assert.deepEqual(
          [...composed.toolNames],
          expectedToolNames(agent, mode, depth),
          `${agent}/${mode}/depth${depth} tool set mismatch`,
        );
        assert.equal(composed.agent, agent);
        assert.equal(composed.mode, mode);
        assert.equal(composed.depth, depth);
        assert.equal(
          composed.definition,
          agentDefinitions[agent],
          'composed definition must be the frozen static definition',
        );
      }
    }
  }
});

test('plan mode omits write_doc and delegate_task entirely even with a full registry', () => {
  const registry = makeFullRegistry();
  for (const agent of agentSlugs) {
    for (let depth = ROOT_AGENT_DEPTH; depth <= MAX_DELEGATION_DEPTH; depth += 1) {
      const composed = composeAgentCapabilities({ agent, mode: 'plan', depth, registry });
      assert.ok(!composed.toolNames.includes(WRITE_DOC), `plan/${agent}/${depth} must not carry write_doc`);
      assert.ok(!composed.toolNames.includes(DELEGATE), `plan/${agent}/${depth} must not carry delegate_task`);
      assert.equal(composed.writeCapabilities.length, 0);
      assert.deepEqual(composeWritePotential(agent, 'plan', depth), []);
    }
  }
});

test('worker agents and general never receive write tools in action mode at any depth', () => {
  const registry = makeFullRegistry();
  for (const agent of ['general', 'analyst', 'researcher'] as const) {
    for (const mode of agentModes) {
      for (let depth = ROOT_AGENT_DEPTH; depth <= MAX_DELEGATION_DEPTH; depth += 1) {
        const composed = composeAgentCapabilities({ agent, mode, depth, registry });
        assert.ok(!composed.toolNames.includes(WRITE_DOC), `${agent}/${mode}/${depth} must not carry write_doc`);
        assert.ok(!composed.toolNames.includes(DELEGATE), `${agent}/${mode}/${depth} must not carry delegate_task`);
        assert.equal(composed.allowsDelegation, false);
      }
    }
  }
});

test('delegation disappears at the depth cap while write_doc survives on the orchestrator', () => {
  const registry = makeFullRegistry();
  const grandchild = composeAgentCapabilities({ agent: 'orchestrator', mode: 'action', depth: MAX_DELEGATION_DEPTH, registry });
  assert.ok(!grandchild.toolNames.includes(DELEGATE));
  assert.ok(grandchild.toolNames.includes(WRITE_DOC));
  assert.equal(grandchild.allowsDelegation, false);

  const child = composeAgentCapabilities({ agent: 'orchestrator', mode: 'action', depth: 1, registry });
  assert.ok(child.toolNames.includes(DELEGATE));
  assert.equal(child.allowsDelegation, true);
  assert.deepEqual(composeWritePotential('orchestrator', 'action', 1), [WRITE_DOC, DELEGATE]);
  assert.deepEqual(composeWritePotential('orchestrator', 'action', MAX_DELEGATION_DEPTH), [WRITE_DOC]);
});

test('composeAllowedToolNames matches the composed tool sets (metadata view)', () => {
  assert.deepEqual(composeAllowedToolNames('orchestrator', 'plan', 0), [
    'calculate',
    'query_data',
    'search_memory',
    'ask_user',
  ]);
  assert.deepEqual(composeAllowedToolNames('orchestrator', 'action', 0), [
    ...composeAllowedToolNames('orchestrator', 'plan', 0),
    WRITE_DOC,
    DELEGATE,
  ]);
  assert.deepEqual(composeAllowedToolNames('orchestrator', 'action', 2), [
    ...composeAllowedToolNames('orchestrator', 'plan', 0),
    WRITE_DOC,
  ]);
  assert.deepEqual(composeAllowedToolNames('general', 'action', 0), ['calculate']);
  assert.deepEqual(composeAllowedToolNames('researcher', 'action', 2), ['calculate', 'search_memory', 'ask_user']);
});

// ---------------------------------------------------------------------------
// Registry semantics: supply-side, filtered, never trusted
// ---------------------------------------------------------------------------

test('the built-in registry exposes only calculate and composition omits the rest', () => {
  const composed = composeAgentCapabilities({ agent: 'orchestrator', mode: 'action', depth: 0 });
  assert.deepEqual([...composed.toolNames], ['calculate']);
  const empty = composeAgentCapabilities({ agent: 'orchestrator', mode: 'action', depth: 0, registry: makeEmptyRegistry() });
  assert.equal(empty.capabilities.length, 0);
  assert.equal(empty.toolNames.length, 0);
});

test('a malicious registry cannot substitute capabilities with mismatched names', () => {
  const impostor = fakeCapability('calculate'); // named calculate, asked as write_doc
  const registry: AgentRegistry = {
    get: (name: string) => (name === WRITE_DOC ? impostor : undefined),
  };
  assert.throws(
    () => composeAgentCapabilities({ agent: 'orchestrator', mode: 'action', depth: 0, registry }),
    (error: unknown) => error instanceof AgentCompositionError,
  );
});

test('a registry with extra rogue capabilities cannot smuggle tools past composition', () => {
  const rogue = fakeCapability('wipe_all_memory');
  const registry = new MapAgentRegistry([rogue, ...agentToolNames.map((name) => fakeCapability(name))]);
  const composed = composeAgentCapabilities({ agent: 'researcher', mode: 'action', depth: 0, registry });
  assert.ok(!(composed.toolNames as readonly string[]).includes('wipe_all_memory'));
  assert.deepEqual([...composed.toolNames], expectedToolNames('researcher', 'action', 0));
  // Registry iteration order never matters: composition queries canonical names.
});

test('plan-mode requests for write tools stay absent even when the registry is hostile', () => {
  const registry = new MapAgentRegistry([fakeCapability(WRITE_DOC), fakeCapability(DELEGATE), calculateCapability]);
  const composed = composeAgentCapabilities({ agent: 'orchestrator', mode: 'plan', depth: 0, registry });
  assert.deepEqual([...composed.toolNames], ['calculate']);
  assert.ok(!composed.toolNames.includes(WRITE_DOC));
});

// ---------------------------------------------------------------------------
// Freezing / immutability / metadata preservation / prompt independence
// ---------------------------------------------------------------------------

test('composed agents, static definitions, and their tool arrays are frozen', () => {
  const composed = composeAgentCapabilities({ agent: 'orchestrator', mode: 'action', depth: 0, registry: makeFullRegistry() });
  assert.equal(Object.isFrozen(composed), true);
  assert.equal(Object.isFrozen(composed.capabilities), true);
  assert.equal(Object.isFrozen(composed.readOnlyCapabilities), true);
  assert.equal(Object.isFrozen(composed.writeCapabilities), true);
  assert.equal(Object.isFrozen(composed.toolNames), true);
  for (const slug of agentSlugs) {
    const definition = agentDefinitions[slug];
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.readOnlyTools), true);
    assert.equal(Object.isFrozen(definition.writeTools), true);
  }
  assert.throws(() => {
    'use strict';
    (agentDefinitions.general.systemPrompt as unknown as string) = 'pwned';
  }, TypeError);
});

test('schema and approval metadata pass through composition unchanged', () => {
  const writeDocFake = fakeCapability(WRITE_DOC);
  const registry = new MapAgentRegistry([
    writeDocFake,
    ...agentToolNames.filter((name) => name !== WRITE_DOC).map((name) => fakeCapability(name)),
  ]);
  const composed = composeAgentCapabilities({ agent: 'orchestrator', mode: 'action', depth: 0, registry });
  const writeDoc = composed.capabilities.find((capability) => capability.name === WRITE_DOC);
  const calculate = composed.capabilities.find((capability) => capability.name === 'calculate');
  assert.ok(writeDoc);
  assert.ok(calculate);
  assert.equal(calculate.readOnly, true);
  assert.equal(calculate.requiresApproval, false);
  assert.equal(calculate.approvalReason, null);
  assert.equal(writeDoc.readOnly, false);
  assert.equal(writeDoc.requiresApproval, true);
  assert.equal(writeDoc.approvalReason, 'fake write_doc mutates shared state');
  // Reference identity: the registry object is handed over, not copied.
  assert.equal(writeDoc, registry.get(WRITE_DOC));
  assert.equal(calculate, registry.get('calculate'));
});

test('calculate capability executes through the pure calculator', async () => {
  const result = await calculateCapability.execute({ expression: '(12 + 8) * 3' });
  assert.deepEqual(result, { result: 60, json: '{"result":60}' });
  assert.equal(calculateCapability.readOnly, true);
  assert.equal(calculateCapability.requiresApproval, false);
  assert.ok(calculateCapability.inputSchema);
  assert.throws(() => calculateCapability.execute({ expression: '1/0' }), /Division by zero/);
});

test('prompts are never consulted for tool selection (structure-only authorization)', () => {
  // Definition prompts are frozen plain strings; selection relies solely on
  // the tool arrays. An empty registry composes to zero capabilities even
  // though every prompt TALKS about tools.
  for (const slug of agentSlugs) {
    const definition = agentDefinitions[slug];
    assert.equal(typeof definition.systemPrompt, 'string');
    assert.ok(definition.systemPrompt.length > 0);
    const composed = composeAgentCapabilities({ agent: slug, mode: 'action', depth: 0, registry: makeEmptyRegistry() });
    assert.equal(composed.capabilities.length, 0);
    assert.equal(composed.definition.systemPrompt, definition.systemPrompt);
  }
});

// ---------------------------------------------------------------------------
// Depth helpers and invalid-input rejection
// ---------------------------------------------------------------------------

test('depth helpers follow the root=0 child=1 grandchild=2 hierarchy', () => {
  assert.equal(allowsDelegation(0), true);
  assert.equal(allowsDelegation(1), true);
  assert.equal(allowsDelegation(2), false);
  assert.equal(allowsDelegation(3), false);
  assert.equal(allowsDelegation(-1), false);
  assert.equal(allowsDelegation(1.5), false);
  assert.equal(allowsDelegation(Number.NaN), false);
  assert.equal(childDepth(0), 1);
  assert.equal(childDepth(1), 2);
  assert.throws(() => childDepth(2), (error: unknown) => error instanceof AgentCompositionError);
  assert.throws(() => childDepth(-1), AgentCompositionError);
  assert.throws(() => childDepth(0.5), AgentCompositionError);
});

test('invalid slugs, modes, depths, and registries are rejected with typed errors', () => {
  assert.throws(
    () => composeAgentCapabilities({ agent: 'ninja' as AgentSlug, mode: 'action', depth: 0 }),
    (error: unknown) => error instanceof AgentCompositionError && error.code === 'agent_composition_error',
  );
  assert.throws(
    () => composeAgentCapabilities({ agent: 'general', mode: 'sprint' as AgentMode, depth: 0 }),
    AgentCompositionError,
  );
  for (const depth of [-1, 3, 1.5, Number.NaN]) {
    assert.throws(
      () => composeAgentCapabilities({ agent: 'general', mode: 'action', depth }),
      AgentCompositionError,
      `depth ${String(depth)} must be rejected`,
    );
  }
  assert.throws(
    () => composeAgentCapabilities({ agent: 'general', mode: 'action', depth: 0, registry: {} as AgentRegistry }),
    AgentCompositionError,
  );
  assert.throws(() => new MapAgentRegistry([{ ...fakeCapability('calculate'), name: '' } as unknown as Capability]), AgentCompositionError);
});

test('defineCapability freezes the capability and normalizes optional metadata', async () => {
  const capability = defineCapability(
    { name: 'probe', description: 'probe tool', inputSchema: z.object({}).strict(), readOnly: true, requiresApproval: false },
    () => 'ok',
  );
  assert.equal(Object.isFrozen(capability), true);
  assert.equal(capability.outputSchema, null);
  assert.equal(capability.approvalReason, null);
  assert.equal(await capability.execute({}), 'ok');
});

// Delegation tool/document name constants stay in sync with the canonical list.
test('canonical tool name constants match the agent definitions', () => {
  assert.equal(DELEGATION_TOOL_NAME, 'delegate_task');
  assert.equal(WRITE_DOC_TOOL_NAME, 'write_doc');
  assert.equal(ASK_USER_TOOL_NAME, 'ask_user');
  assert.ok((agentToolNames as readonly string[]).includes(DELEGATION_TOOL_NAME));
  assert.ok((agentToolNames as readonly string[]).includes(WRITE_DOC_TOOL_NAME));
  assert.ok((agentToolNames as readonly string[]).includes(ASK_USER_TOOL_NAME));
});

// ---------------------------------------------------------------------------
// Human-in-the-loop: ask_user composes WITHOUT an execute function
// ---------------------------------------------------------------------------

function askUserCapability(): Capability {
  return defineCapability({
    name: ASK_USER_TOOL_NAME,
    description: 'Ask the human operator a question and wait for their answer.',
    inputSchema: z.object({ question: z.string().min(1).max(1000) }).strict(),
    outputSchema: null,
    readOnly: true,
    requiresApproval: false,
    approvalReason: null,
  });
}

test('an execute-less ask_user survives composition in every definition that lists it', () => {
  const askUser = askUserCapability();
  assert.equal(isExecutableCapability(askUser), false);
  assert.equal(askUser.execute, undefined);
  assert.equal(Object.isFrozen(askUser), true);

  for (const agent of ['orchestrator', 'analyst', 'researcher'] as const) {
    for (const mode of agentModes) {
      for (let depth = ROOT_AGENT_DEPTH; depth <= MAX_DELEGATION_DEPTH; depth += 1) {
        const composed = composeAgentCapabilities({
          agent,
          mode,
          depth,
          registry: new MapAgentRegistry([askUser]),
        });
        assert.deepEqual([...composed.toolNames], [ASK_USER_TOOL_NAME]);
        const composedAsk = composed.capabilities[0]!;
        assert.equal(composedAsk, askUser, 'composition hands over the registry object');
        assert.equal(composedAsk.execute, undefined);
        assert.equal(composedAsk.readOnly, true);
        assert.equal(composedAsk.name, ASK_USER_TOOL_NAME);
        assert.equal(composedAsk.description, 'Ask the human operator a question and wait for their answer.');
        assert.equal(Object.isFrozen(composedAsk), true);
      }
    }
  }

  // general does not list ask_user: a host providing it still composes to zero tools.
  const general = composeAgentCapabilities({
    agent: 'general',
    mode: 'action',
    depth: 0,
    registry: new MapAgentRegistry([askUserCapability()]),
  });
  assert.equal(general.capabilities.length, 0);
});

test('ask_user WITH an execute function stays an ordinary executable capability', async () => {
  const executableAskUser = defineCapability(
    {
      name: ASK_USER_TOOL_NAME,
      description: 'Ask the human operator a question.',
      inputSchema: z.object({ question: z.string() }).strict(),
      readOnly: true,
      requiresApproval: false,
    },
    () => 'the human said yes',
  );
  assert.equal(isExecutableCapability(executableAskUser), true);
  assert.equal(await executableAskUser.execute({ question: 'Proceed?' }), 'the human said yes');

  const composed = composeAgentCapabilities({
    agent: 'analyst',
    mode: 'plan',
    depth: 1,
    registry: new MapAgentRegistry([executableAskUser]),
  });
  assert.deepEqual([...composed.toolNames], [ASK_USER_TOOL_NAME]);
  assert.equal(composed.capabilities[0]!.execute === undefined, false);
});

test('a missing execute stays a typed composition error for every other canonical tool', () => {
  const executeless = (name: string): Capability =>
    ({
      name,
      description: `execute-less ${name}`,
      inputSchema: z.object({}).strict(),
      outputSchema: null,
      readOnly: false,
      requiresApproval: true,
      approvalReason: 'mutates shared state',
    }) as unknown as Capability;

  for (const tool of agentToolNames) {
    if (tool === ASK_USER_TOOL_NAME) {
      continue;
    }
    const registry = new MapAgentRegistry([executeless(tool), askUserCapability()]);
    // The orchestrator in action mode at the root lists every canonical tool,
    // so each execute-less entry is actually queried.
    assert.throws(
      () => composeAgentCapabilities({ agent: 'orchestrator', mode: 'action', depth: 0, registry }),
      (error: unknown) =>
        error instanceof AgentCompositionError && error.code === 'agent_composition_error',
      `${tool} without execute must be rejected by composition`,
    );
  }

  // The rule also holds for read-only paths: calculate without execute on the
  // general agent is rejected, not silently composed.
  const generalRegistry = new MapAgentRegistry([executeless('calculate')]);
  assert.throws(
    () => composeAgentCapabilities({ agent: 'general', mode: 'action', depth: 0, registry: generalRegistry }),
    AgentCompositionError,
  );
});

test('defineCapability without execute is type-forbidden outside ask_user and throws at runtime', () => {
  assert.throws(() => {
    defineCapability({
      // @ts-expect-error: only { name: 'ask_user' } descriptors may omit execute;
      // this compile error doubles as the human-in-the-loop contract test.
      name: 'write_doc',
      description: 'Write a work document.',
      inputSchema: z.object({}).strict(),
      readOnly: false,
      requiresApproval: true,
    });
  }, AgentCompositionError);
  // Passing execute inside the descriptor instead of as an argument is also
  // rejected (prevents a dummy throwing executor disguised as metadata).
  assert.throws(
    () =>
      defineCapability({
        name: ASK_USER_TOOL_NAME,
        description: 'd',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        requiresApproval: false,
        // @ts-expect-error: descriptor-carried execute functions do not satisfy the contract.
        execute: () => 'nope',
      }),
    AgentCompositionError,
  );
});
