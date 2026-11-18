/**
 * Tests for the raw agent loop and conversation history.
 *
 * Uses a queued fake LlmClient: no real network, no API key. The fake records
 * every request's messages and tools so tests can assert exactly what the
 * model saw on each round trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConversationHistory } from './history.js';
import { runAgentTurn, DEFAULT_MAX_STEPS, type AgentLoopEvent } from './loop.js';
import { registeredTools } from './tools/index.js';
import type {
  ChatMessage,
  FunctionToolCall,
  FunctionToolSchema,
  LlmClient,
  LlmResponse,
  ToolDefinition,
  ToolMessage,
  TokenUsage,
} from './types.js';

const SYSTEM_PROMPT = 'You are Workforce, a terse test assistant.';

interface RecordedCall {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly FunctionToolSchema[];
}

class FakeLlmClient implements LlmClient {
  readonly calls: RecordedCall[] = [];
  private readonly queue: LlmResponse[];

  constructor(responses: readonly LlmResponse[]) {
    this.queue = [...responses];
  }

  async complete(
    messages: readonly ChatMessage[],
    tools: readonly FunctionToolSchema[],
  ): Promise<LlmResponse> {
    this.calls.push({ messages, tools });
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error('FakeLlmClient queue exhausted');
    }
    return next;
  }
}

function textResponse(content: string, usage?: TokenUsage): LlmResponse {
  return {
    message: { role: 'assistant', content },
    ...(usage === undefined ? {} : { usage }),
  };
}

function callsResponse(calls: readonly FunctionToolCall[]): LlmResponse {
  return { message: { role: 'assistant', content: null, tool_calls: calls } };
}

function toolCall(id: string, name: string, rawArguments: string): FunctionToolCall {
  return { id, type: 'function', function: { name, arguments: rawArguments } };
}

function makeHistory(): ConversationHistory {
  return new ConversationHistory(SYSTEM_PROMPT);
}

function toolMessagesOf(messages: readonly ChatMessage[]): ToolMessage[] {
  return messages.filter((message): message is ToolMessage => message.role === 'tool');
}

/** Assert an event's type and return it narrowed, for property access. */
function assertType<T extends AgentLoopEvent['type']>(
  event: AgentLoopEvent,
  type: T,
): Extract<AgentLoopEvent, { type: T }> {
  assert.strictEqual(event.type, type);
  return event as Extract<AgentLoopEvent, { type: T }>;
}

/** A tool that always throws synchronously. */
const boomTool: ToolDefinition = {
  schema: { name: 'boom', description: 'Always throws.', parameters: {} },
  execute() {
    throw new Error('kaboom');
  },
};

/** A tool that always rejects asynchronously. */
const flakyTool: ToolDefinition = {
  schema: { name: 'flaky', description: 'Rejects asynchronously.', parameters: {} },
  async execute() {
    throw new Error('async failure');
  },
};

test('no-tool response: one LLM call and final text', async () => {
  const llm = new FakeLlmClient([textResponse('Hello there.')]);
  const history = makeHistory();

  const result = await runAgentTurn({ input: 'Hi', history, llm });

  assert.strictEqual(result.text, 'Hello there.');
  assert.strictEqual(result.llmCalls, 1);
  assert.deepStrictEqual(result.messages, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello there.' },
  ]);
  assert.strictEqual(llm.calls.length, 1);
  const first = llm.calls[0] as RecordedCall;
  assert.deepStrictEqual(first.messages, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Hi' },
  ]);
  assert.deepStrictEqual(first.tools, registeredTools.map((tool) => tool.schema));
});

test('one calculate call: result appended and second request sees it', async () => {
  const llm = new FakeLlmClient([
    callsResponse([toolCall('call_1', 'calculate', '{"expression":"2 + 3 * 4"}')]),
    textResponse('The answer is 14.'),
  ]);
  const history = makeHistory();

  const result = await runAgentTurn({ input: 'What is 2 + 3 * 4?', history, llm });

  assert.strictEqual(result.text, 'The answer is 14.');
  assert.strictEqual(result.llmCalls, 2);
  assert.strictEqual(llm.calls.length, 2);
  const second = llm.calls[1] as RecordedCall;
  assert.deepStrictEqual(second.messages, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'What is 2 + 3 * 4?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call_1', 'calculate', '{"expression":"2 + 3 * 4"}')],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"result":14}' },
  ]);
});

test('multiple calls in one response: all results appended in order', async () => {
  const llm = new FakeLlmClient([
    callsResponse([
      toolCall('call_1', 'calculate', '{"expression":"1 + 1"}'),
      toolCall('call_2', 'calculate', '{"expression":"20 / 4"}'),
    ]),
    textResponse('2 and 5.'),
  ]);
  const history = makeHistory();

  const result = await runAgentTurn({ input: 'Compute two things', history, llm });

  assert.strictEqual(result.text, '2 and 5.');
  assert.strictEqual(result.llmCalls, 2);
  const second = llm.calls[1] as RecordedCall;
  assert.deepStrictEqual(toolMessagesOf(second.messages), [
    { role: 'tool', tool_call_id: 'call_1', content: '{"result":2}' },
    { role: 'tool', tool_call_id: 'call_2', content: '{"result":5}' },
  ]);
});

test('sequential calls across model responses', async () => {
  const llm = new FakeLlmClient([
    callsResponse([toolCall('call_a', 'calculate', '{"expression":"1 + 2"}')]),
    callsResponse([toolCall('call_b', 'calculate', '{"expression":"3 * 4"}')]),
    textResponse('3 then 12.'),
  ]);
  const history = makeHistory();

  const result = await runAgentTurn({ input: 'Two steps', history, llm });

  assert.strictEqual(result.text, '3 then 12.');
  assert.strictEqual(result.llmCalls, 3);
  const third = llm.calls[2] as RecordedCall;
  assert.deepStrictEqual(third.messages, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Two steps' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call_a', 'calculate', '{"expression":"1 + 2"}')],
    },
    { role: 'tool', tool_call_id: 'call_a', content: '{"result":3}' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call_b', 'calculate', '{"expression":"3 * 4"}')],
    },
    { role: 'tool', tool_call_id: 'call_b', content: '{"result":12}' },
  ]);
});

test('thrown tool error is fed back and the model can recover', async () => {
  const llm = new FakeLlmClient([
    callsResponse([toolCall('call_err', 'boom', '{}')]),
    textResponse('Recovered from the failure.'),
  ]);
  const history = makeHistory();

  const result = await runAgentTurn({ input: 'Use boom', history, llm, tools: [boomTool] });

  assert.strictEqual(result.text, 'Recovered from the failure.');
  assert.strictEqual(result.llmCalls, 2);
  const second = llm.calls[1] as RecordedCall;
  const [toolMessage] = toolMessagesOf(second.messages);
  assert.ok(toolMessage);
  assert.strictEqual(toolMessage.tool_call_id, 'call_err');
  assert.strictEqual(
    toolMessage.content,
    JSON.stringify({ error: 'tool_error', message: 'Tool "boom" failed: kaboom' }),
  );
});

test('asynchronously rejected tool error is contained too', async () => {
  const llm = new FakeLlmClient([
    callsResponse([toolCall('call_async', 'flaky', '{}')]),
    textResponse('Recovered again.'),
  ]);
  const history = makeHistory();

  const result = await runAgentTurn({ input: 'Use flaky', history, llm, tools: [flakyTool] });

  assert.strictEqual(result.text, 'Recovered again.');
  const second = llm.calls[1] as RecordedCall;
  const [toolMessage] = toolMessagesOf(second.messages);
  assert.ok(toolMessage);
  const payload = JSON.parse(toolMessage.content) as { error: string; message: string };
  assert.strictEqual(payload.error, 'tool_error');
  assert.ok(payload.message.includes('async failure'));
});

test('unknown/hallucinated tool is fed back without crashing', async () => {
  const llm = new FakeLlmClient([
    callsResponse([toolCall('call_x', 'multiply', '{"a":2,"b":3}')]),
    textResponse('Understood, I will stick to calculate.'),
  ]);
  const history = makeHistory();

  const result = await runAgentTurn({ input: 'Multiply', history, llm });

  assert.strictEqual(result.text, 'Understood, I will stick to calculate.');
  assert.strictEqual(result.llmCalls, 2);
  const second = llm.calls[1] as RecordedCall;
  const [toolMessage] = toolMessagesOf(second.messages);
  assert.ok(toolMessage);
  assert.strictEqual(toolMessage.tool_call_id, 'call_x');
  assert.strictEqual(
    toolMessage.content,
    JSON.stringify({
      error: 'unknown_tool',
      message: 'No tool named "multiply" is registered.',
    }),
  );
});

test('malformed JSON arguments are contained as invalid_arguments', async () => {
  const llm = new FakeLlmClient([
    callsResponse([toolCall('call_bad', 'calculate', '{expression: "1 + 1"}')]),
    textResponse('Let me retry with valid JSON.'),
  ]);
  const history = makeHistory();

  const result = await runAgentTurn({ input: 'Broken args', history, llm });

  assert.strictEqual(result.text, 'Let me retry with valid JSON.');
  const second = llm.calls[1] as RecordedCall;
  const [toolMessage] = toolMessagesOf(second.messages);
  assert.ok(toolMessage);
  const payload = JSON.parse(toolMessage.content) as { error: string; message: string };
  assert.strictEqual(payload.error, 'invalid_arguments');
  assert.ok(payload.message.includes('calculate'));
});

test('schema-invalid arguments are contained as tool_error', async () => {
  const llm = new FakeLlmClient([
    callsResponse([toolCall('call_z', 'calculate', '{"expression":123}')]),
    textResponse('Corrected.'),
  ]);
  const history = makeHistory();

  const result = await runAgentTurn({ input: 'Wrong types', history, llm });

  assert.strictEqual(result.text, 'Corrected.');
  const second = llm.calls[1] as RecordedCall;
  const [toolMessage] = toolMessagesOf(second.messages);
  assert.ok(toolMessage);
  const payload = JSON.parse(toolMessage.content) as { error: string; message: string };
  assert.strictEqual(payload.error, 'tool_error');
  assert.ok(payload.message.includes('Invalid arguments for the calculate tool'));
});

test('10-step cap: no 11th call, results recorded, counter resets next turn', async () => {
  const responses: LlmResponse[] = [];
  for (let index = 1; index <= DEFAULT_MAX_STEPS; index += 1) {
    responses.push(
      callsResponse([toolCall(`call_${index}`, 'calculate', `{"expression":"${index} + 0"}`)]),
    );
  }
  responses.push(textResponse('Done at last.'));
  const llm = new FakeLlmClient(responses);
  const history = makeHistory();

  const firstTurn = await runAgentTurn({ input: 'Loop please', history, llm });

  assert.strictEqual(firstTurn.llmCalls, DEFAULT_MAX_STEPS);
  assert.strictEqual(llm.calls.length, DEFAULT_MAX_STEPS);
  assert.ok(firstTurn.text.includes('maximum of 10 LLM calls'));
  assert.strictEqual(toolMessagesOf(firstTurn.messages).length, DEFAULT_MAX_STEPS);

  const secondTurn = await runAgentTurn({ input: 'Again', history, llm });

  assert.strictEqual(secondTurn.llmCalls, 1);
  assert.strictEqual(llm.calls.length, DEFAULT_MAX_STEPS + 1);
  assert.strictEqual(secondTurn.text, 'Done at last.');
});

test('two user turns preserve earlier user/assistant messages', async () => {
  const llm = new FakeLlmClient([textResponse('First answer.'), textResponse('Second answer.')]);
  const history = makeHistory();

  const first = await runAgentTurn({ input: 'Hello', history, llm });
  const second = await runAgentTurn({ input: 'Continue', history, llm });

  assert.strictEqual(first.text, 'First answer.');
  assert.strictEqual(second.text, 'Second answer.');
  const secondCall = llm.calls[1] as RecordedCall;
  assert.deepStrictEqual(secondCall.messages, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'First answer.' },
    { role: 'user', content: 'Continue' },
  ]);
});

test('snapshot cannot mutate the internal transcript array', () => {
  const history = makeHistory();
  history.addUser('Hi');
  const snapshot = history.snapshot();
  assert.strictEqual(snapshot.length, 2);

  (snapshot as ChatMessage[]).push({ role: 'user', content: 'Injected' });

  assert.strictEqual(snapshot.length, 3);
  assert.strictEqual(history.snapshot().length, 2);
});

test('event ordering: model_input, model_output, tool_call, tool_result per step', async () => {
  const events: AgentLoopEvent[] = [];
  const llm = new FakeLlmClient([
    callsResponse([toolCall('call_9', 'calculate', '{"expression":"6 * 7"}')]),
    textResponse('42.', { promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
  ]);
  const history = makeHistory();

  await runAgentTurn({
    input: 'Six times seven?',
    history,
    llm,
    onEvent: (event) => events.push(event),
  });

  assert.deepStrictEqual(
    events.map((event) => event.type),
    ['model_input', 'model_output', 'tool_call', 'tool_result', 'model_input', 'model_output'],
  );

  const input1 = assertType(events[0] as AgentLoopEvent, 'model_input');
  const output1 = assertType(events[1] as AgentLoopEvent, 'model_output');
  const callEvent = assertType(events[2] as AgentLoopEvent, 'tool_call');
  const resultEvent = assertType(events[3] as AgentLoopEvent, 'tool_result');
  const input2 = assertType(events[4] as AgentLoopEvent, 'model_input');
  const output2 = assertType(events[5] as AgentLoopEvent, 'model_output');

  assert.strictEqual(input1.step, 1);
  assert.deepStrictEqual(input1.messages, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Six times seven?' },
  ]);

  assert.strictEqual(output1.step, 1);
  assert.deepStrictEqual(output1.message, {
    role: 'assistant',
    content: null,
    tool_calls: [toolCall('call_9', 'calculate', '{"expression":"6 * 7"}')],
  });
  assert.strictEqual(output1.usage, undefined);

  assert.strictEqual(callEvent.step, 1);
  assert.deepStrictEqual(callEvent.call, toolCall('call_9', 'calculate', '{"expression":"6 * 7"}'));

  assert.strictEqual(resultEvent.status, 'success');

  assert.strictEqual(input2.step, 2);
  assert.strictEqual(input2.messages.length, 4);

  assert.strictEqual(output2.step, 2);
  assert.deepStrictEqual(output2.message, { role: 'assistant', content: '42.' });
  assert.deepStrictEqual(output2.usage, {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });
});
