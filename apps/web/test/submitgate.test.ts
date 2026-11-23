import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmissionGate } from '../src/lib/submitgate.js';

/**
 * Pure submission-gate tests for the duplicate-submission fix. The component
 * wiring (which handler calls tryStart/release when) is browser-verified —
 * these tests pin the synchronous lock semantics the fix relies on: first
 * caller wins within the same tick, late callers in stale closures are
 * rejected, release always re-enables, instances are independent per mount.
 */

test('tryStart: first call wins; stale-closure second calls rejected', () => {
  const gate = createSubmissionGate();
  assert.equal(gate.isLocked(), false);
  assert.equal(gate.tryStart(), true); // Enter keydown / first Send click
  assert.equal(gate.isLocked(), true);
  assert.equal(gate.tryStart(), false); // same-tick form onSubmit
  assert.equal(gate.tryStart(), false); // Send double-click
  assert.equal(gate.tryStart(), false); // HITL answer form racing the same tick
});

test('gates are independent per creation (agent/mode remount starts unlocked)', () => {
  const first = createSubmissionGate();
  assert.equal(first.tryStart(), true);
  const second = createSubmissionGate();
  assert.equal(second.isLocked(), false);
  assert.equal(second.tryStart(), true);
  first.release();
  assert.equal(second.isLocked(), true);
});

test('release: ready/error/send-failure unlock, next message and answer proceed', () => {
  const gate = createSubmissionGate();
  assert.equal(gate.tryStart(), true);
  gate.release(); // status left submitted/streaming → ready
  assert.equal(gate.isLocked(), false);
  assert.equal(gate.tryStart(), true); // next normal message
  gate.release(); // turn errored
  assert.equal(gate.tryStart(), true); // next HITL answer
  gate.release(); // send promise rejected
  assert.equal(gate.tryStart(), true);
});

test('release is idempotent when already unlocked', () => {
  const gate = createSubmissionGate();
  assert.equal(gate.tryStart(), true);
  gate.release();
  gate.release();
  gate.release();
  assert.equal(gate.isLocked(), false);
  assert.equal(gate.tryStart(), true);
});
