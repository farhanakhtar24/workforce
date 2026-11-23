import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateParametersSchema,
  calculateToolDescription,
  calculateToolName,
  executeCalculate,
} from '@workforce/core';
import { calculateTool, registeredTools, toolRegistry } from './index.js';

test('registry has exactly one tool named calculate', () => {
  assert.strictEqual(registeredTools.length, 1);
  assert.strictEqual(registeredTools[0], calculateTool);
  assert.strictEqual(calculateTool.schema.name, calculateToolName);
  assert.strictEqual(calculateTool.schema.name, 'calculate');
});

test('adapter uses the core name, description, and JSON Schema', () => {
  assert.strictEqual(calculateTool.schema.description, calculateToolDescription);
  assert.strictEqual(calculateTool.schema.parameters, calculateParametersSchema);
  assert.match(String(calculateTool.schema.description), /arithmetic/i);
  assert.match(String(calculateTool.schema.description), /\(12 \+ 8\) \* 3/);
});

test('adapter delegates execution to the core executeCalculate', () => {
  const args = { expression: '(12 + 8) * 3' };
  assert.strictEqual(calculateTool.execute(args), executeCalculate(args));
  assert.throws(() => calculateTool.execute({ expression: '1 / 0' }), /Division by zero/i);
  assert.throws(() => calculateTool.execute({ expression: '' }), /Invalid arguments/i);
});

test('registry.get returns the exact tool for known names', () => {
  assert.strictEqual(toolRegistry.get('calculate'), calculateTool);
});

test('registry.get returns undefined for unknown names', () => {
  assert.strictEqual(toolRegistry.get('no-such-tool'), undefined);
  assert.strictEqual(toolRegistry.get(''), undefined);
  assert.strictEqual(toolRegistry.get('Calculate'), undefined);
});
