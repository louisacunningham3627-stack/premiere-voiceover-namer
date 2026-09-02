const test = require('node:test');
const assert = require('node:assert/strict');

const coordination = require('../src/coordination.js');

test('operation queue serializes automatic and manual work in call order', async () => {
  const queue = coordination.createOperationQueue();
  const events = [];
  let releaseAutomatic;
  const automaticGate = new Promise((resolve) => { releaseAutomatic = resolve; });

  const automatic = queue.run(async () => {
    events.push('automatic:start');
    await automaticGate;
    events.push('automatic:end');
  });
  const manual = queue.run(async () => {
    events.push('manual:start');
    events.push('manual:end');
  });

  await Promise.resolve();
  assert.deepEqual(events, ['automatic:start']);
  releaseAutomatic();
  await Promise.all([automatic, manual]);
  assert.deepEqual(events, ['automatic:start', 'automatic:end', 'manual:start', 'manual:end']);
});

test('operation queue releases the next operation after a failure', async () => {
  const queue = coordination.createOperationQueue();
  const first = queue.run(async () => { throw new Error('expected'); });
  const second = queue.run(async () => 'completed');
  await assert.rejects(first, /expected/);
  assert.equal(await second, 'completed');
});

test('generation guard invalidates captured monitor generations', () => {
  const guard = coordination.createGenerationGuard();
  const initial = guard.current();
  assert.equal(guard.isCurrent(initial), true);
  const active = guard.bump();
  assert.equal(guard.isCurrent(initial), false);
  assert.equal(guard.isCurrent(active), true);
  guard.bump();
  assert.equal(guard.isCurrent(active), false);
});

test('a queued operation can reject a stale panel lifecycle before doing work', async () => {
  const queue = coordination.createOperationQueue();
  const guard = coordination.createGenerationGuard();
  const captured = guard.current();
  let releaseBlocker;
  const blockerGate = new Promise((resolve) => { releaseBlocker = resolve; });
  const events = [];

  const blocker = queue.run(async () => blockerGate);
  const queued = queue.run(async () => {
    if (!guard.isCurrent(captured)) throw new Error('panel closed');
    events.push('mutated');
  });
  guard.bump();
  releaseBlocker();

  await blocker;
  await assert.rejects(queued, /panel closed/);
  assert.deepEqual(events, []);
});

test('operation-complete filtering accepts only missing state or explicit success', () => {
  assert.equal(coordination.shouldHandleOperationComplete(undefined, 0), true);
  assert.equal(coordination.shouldHandleOperationComplete({}, 0), true);
  assert.equal(coordination.shouldHandleOperationComplete({ state: 0 }, 0), true);
  assert.equal(coordination.shouldHandleOperationComplete({ state: 1 }, 0), false);
  assert.equal(coordination.shouldHandleOperationComplete({ state: 2 }, 0), false);
  assert.equal(coordination.shouldHandleOperationComplete({ state: 0 }, null), false);
});

test('a processed rename releases the old default path for filename reuse', () => {
  const source = 'C:\\Captured Audio\\音频 2_1.wav';
  const target = 'C:\\Captured Audio\\项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav';
  const normalize = (value) => value.toLowerCase().replaceAll('\\', '/');
  const sourceKey = normalize(source);
  const targetKey = normalize(target);
  const collections = {
    seenPaths: new Set([sourceKey]),
    watchedFolderBaseline: new Set([sourceKey]),
    unmatchedFolderFiles: new Map([[sourceKey, { firstSeenAt: 1 }]]),
    pendingFiles: new Map([[sourceKey, { stablePolls: 2 }]]),
  };

  assert.deepEqual(
    coordination.markProcessedPath(collections, source, target, normalize),
    { sourceKey, targetKey },
  );
  assert.equal(collections.seenPaths.has(sourceKey), false);
  assert.equal(collections.watchedFolderBaseline.has(sourceKey), false);
  assert.equal(collections.seenPaths.has(targetKey), true);
  assert.equal(collections.watchedFolderBaseline.has(targetKey), true);
  assert.equal(collections.unmatchedFolderFiles.has(sourceKey), false);
  assert.equal(collections.pendingFiles.has(sourceKey), false);
});
