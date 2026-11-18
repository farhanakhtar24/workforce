import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTool, registeredTools, toolRegistry } from './index.js';
import { evaluateArithmetic } from './calculate.js';

/** Run the tool's execute with arbitrary (possibly invalid) arguments. */
function exec(args: unknown): string {
  const result = calculateTool.execute(args);
  if (typeof result !== 'string') {
    assert.fail('calculateTool.execute must return a string');
  }
  return result;
}

test('respects precedence: multiplication before addition', () => {
  assert.strictEqual(exec({ expression: '2 + 3 * 4' }), '{"result":14}');
});

test('respects precedence: division before subtraction', () => {
  assert.strictEqual(exec({ expression: '20 - 6 / 3' }), '{"result":18}');
});

test('left associativity for + and -', () => {
  assert.strictEqual(exec({ expression: '8 - 3 - 2' }), '{"result":3}');
  assert.strictEqual(exec({ expression: '10 + 4 - 6' }), '{"result":8}');
});

test('left associativity for * and /', () => {
  assert.strictEqual(exec({ expression: '20 / 2 / 5' }), '{"result":2}');
  assert.strictEqual(exec({ expression: '6 * 2 / 4' }), '{"result":3}');
});

test('parentheses override precedence', () => {
  assert.strictEqual(exec({ expression: '(12 + 8) * 3' }), '{"result":60}');
});

test('nested parentheses', () => {
  assert.strictEqual(exec({ expression: '((1 + 2) * (3 + 4)) / (2 + 5)' }), '{"result":3}');
});

test('unary minus', () => {
  assert.strictEqual(exec({ expression: '-5 + 3' }), '{"result":-2}');
});

test('unary plus', () => {
  assert.strictEqual(exec({ expression: '+7 * -2' }), '{"result":-14}');
});

test('stacked unary signs', () => {
  assert.strictEqual(exec({ expression: '--5' }), '{"result":5}');
  assert.strictEqual(exec({ expression: '-(+4)' }), '{"result":-4}');
});

test('unary before parentheses', () => {
  assert.strictEqual(exec({ expression: '-(2 + 3) * 4' }), '{"result":-20}');
});

test('decimals', () => {
  assert.strictEqual(exec({ expression: '0.5 + 0.25' }), '{"result":0.75}');
  assert.strictEqual(exec({ expression: '.5 + 0.5' }), '{"result":1}');
  assert.strictEqual(exec({ expression: '2.5 * 4' }), '{"result":10}');
});

test('whitespace is ignored', () => {
  assert.strictEqual(exec({ expression: '  1  +   2 ' }), '{"result":3}');
  assert.strictEqual(exec({ expression: '\t9\t-\t4\t' }), '{"result":5}');
  assert.strictEqual(exec({ expression: '1+2' }), '{"result":3}');
});

test('compound expression combining all features', () => {
  assert.strictEqual(exec({ expression: '(12 + 8) * 3 - 10 / 2.5 + +2' }), '{"result":58}');
});

test('does not round normal numeric results', () => {
  assert.strictEqual(exec({ expression: '1 / 3' }), JSON.stringify({ result: 1 / 3 }));
});

test('large but finite results are preserved', () => {
  assert.strictEqual(exec({ expression: '1000000 * 1000000' }), '{"result":1000000000000}');
});

test('returns a plain JSON string', () => {
  const result = exec({ expression: '2 + 2' });
  assert.strictEqual(typeof result, 'string');
  assert.deepStrictEqual(JSON.parse(result), { result: 4 });
});

test('rejects malformed syntax', () => {
  assert.throws(() => exec({ expression: '2 +' }), /expected a number/i);
  assert.throws(() => exec({ expression: '* 3' }), /Unexpected "\*"/);
  assert.throws(() => exec({ expression: '2 3' }), /after a complete expression/i);
  assert.throws(() => exec({ expression: '(2 + 3' }), /Missing closing parenthesis/i);
  assert.throws(() => exec({ expression: '2 + 3)' }), /after a complete expression/i);
});

test('rejects multiple decimal points', () => {
  assert.throws(() => exec({ expression: '1.2.3' }), /only one decimal point/i);
});

test('rejects trailing decimal point without digits', () => {
  assert.throws(() => exec({ expression: '.' }), /Invalid number/i);
});

test('rejects unsupported characters', () => {
  assert.throws(() => exec({ expression: '2 + x' }), /Unsupported character "x"/i);
  assert.throws(() => exec({ expression: '2 ^ 3' }), /Unsupported character "\^"/i);
  assert.throws(() => exec({ expression: 'sqrt(4)' }), /Unsupported character "s"/i);
});

test('rejects whitespace-only expression', () => {
  assert.throws(() => exec({ expression: '   ' }), /empty/i);
});

test('rejects empty expression', () => {
  assert.throws(() => exec({ expression: '' }), /Invalid arguments/i);
});

test('rejects expressions over 500 characters', () => {
  assert.throws(() => exec({ expression: 'x'.repeat(501) }), /at most 500/i);
  assert.strictEqual(typeof exec({ expression: '('.repeat(245) + '1' + ')'.repeat(245) }), 'string');
});

test('rejects invalid argument shapes', () => {
  assert.throws(() => exec(null), /Invalid arguments/i);
  assert.throws(() => exec(undefined), /Invalid arguments/i);
  assert.throws(() => exec('2 + 2'), /Invalid arguments/i);
  assert.throws(() => exec([]), /Invalid arguments/i);
  assert.throws(() => exec({}), /Invalid arguments/i);
  assert.throws(() => exec({ expression: 5 }), /Invalid arguments/i);
  assert.throws(() => exec({ expression: null }), /Invalid arguments/i);
  assert.throws(() => exec({ expression: ['2+2'] }), /Invalid arguments/i);
  assert.throws(() => exec({ expression: '2+2', extra: true }), /Invalid arguments/i);
});

test('rejects division by zero', () => {
  assert.throws(() => exec({ expression: '1 / 0' }), /Division by zero/i);
  assert.throws(() => exec({ expression: '8 / (2 - 2)' }), /Division by zero/i);
  assert.throws(() => exec({ expression: '-1 / 0' }), /Division by zero/i);
});

test('rejects non-finite results', () => {
  // A 320-digit literal overflows to Infinity during tokenization.
  assert.throws(() => exec({ expression: '9'.repeat(320) }), /not a finite number/i);
});

test('evaluateArithmetic returns JSON string', () => {
  assert.strictEqual(evaluateArithmetic('(12 + 8) * 3'), '{"result":60}');
});

test('registry has exactly one tool named calculate', () => {
  assert.strictEqual(registeredTools.length, 1);
  assert.strictEqual(registeredTools[0], calculateTool);
  assert.strictEqual(calculateTool.schema.name, 'calculate');
});

test('schema parameters follow the required JSON Schema contract', () => {
  const { parameters } = calculateTool.schema;
  const properties = parameters.properties as Record<string, unknown>;
  assert.deepStrictEqual(parameters.required, ['expression']);
  assert.strictEqual(parameters.type, 'object');
  assert.strictEqual(properties['additionalProperties_is_absent'], undefined);
  assert.strictEqual(parameters['additionalProperties'], false);
  assert.strictEqual((properties['expression'] as Record<string, unknown>)['type'], 'string');
  assert.match(String(calculateTool.schema.description), /arithmetic/i);
  assert.match(String(calculateTool.schema.description), /\(12 \+ 8\) \* 3/);
});

test('registry.get returns the exact tool for known names', () => {
  assert.strictEqual(toolRegistry.get('calculate'), calculateTool);
});

test('registry.get returns undefined for unknown names', () => {
  assert.strictEqual(toolRegistry.get('no-such-tool'), undefined);
  assert.strictEqual(toolRegistry.get(''), undefined);
  assert.strictEqual(toolRegistry.get('Calculate'), undefined);
});
