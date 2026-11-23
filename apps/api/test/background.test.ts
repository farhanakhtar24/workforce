import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundTracker } from '../src/background.js';

test('tracker: pendingCount is 0 when idle and tracks settled tasks', async () => {
  const tracker = createBackgroundTracker();
  assert.equal(tracker.pendingCount, 0);
  tracker.track(Promise.resolve());
  assert.equal(tracker.pendingCount, 1);
  await tracker.waitForAll(1_000);
  assert.equal(tracker.pendingCount, 0);
});

test('tracker: rejections are contained and reported via onError, never rethrown', async () => {
  const seen: unknown[] = [];
  const tracker = createBackgroundTracker({ onError: (error) => seen.push(error) });
  tracker.track(Promise.reject(new Error('background failure')));
  tracker.track(Promise.resolve('ok'));
  await tracker.waitForAll(1_000);
  assert.equal(seen.length, 1);
  assert.equal(tracker.pendingCount, 0);
});

test('tracker: waitForAll respects the bound and does not hang on slow tasks', async () => {
  const tracker = createBackgroundTracker();
  const started = Date.now();
  tracker.track(
    new Promise((resolve) => {
      // Longer than the bound; must not be awaited.
      setTimeout(resolve, 500);
    }),
  );
  await tracker.waitForAll(50);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `waitForAll exceeded its bound (elapsed ${elapsed}ms)`);
});

test('tracker: onError throwing cannot break housekeeping', async () => {
  const tracker = createBackgroundTracker({
    onError: () => {
      throw new Error('bad handler');
    },
  });
  tracker.track(Promise.reject(new Error('ignored')));
  await tracker.waitForAll(1_000);
  assert.equal(tracker.pendingCount, 0);
});
