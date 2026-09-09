const test = require('node:test');
const assert = require('node:assert/strict');

const coordination = require('../src/coordination.js');

test('recording retry retains its reserved name and refreshes source evidence', async () => {
  const pending = {};
  let calls = 0;
  const createPlan = async () => ({ targetName: `name-${++calls}.wav` });
  const first = await coordination.reserveRecordingPlan(pending, { sourceSignature: 'writing' }, createPlan);
  const candidate = { sourceSignature: 'finalized', trackItems: ['current'] };
  const retry = await coordination.reserveRecordingPlan(pending, candidate, createPlan);
  assert.equal(first, retry);
  assert.equal(calls, 1);
  assert.equal(retry.sourceSignature, 'finalized');
  assert.equal(retry.candidate, candidate);
});

test('another recording reusing a released default path gets its own plan', async () => {
  let calls = 0;
  const createPlan = async () => ({ targetName: `name-${++calls}.wav` });
  const first = await coordination.reserveRecordingPlan({}, {}, createPlan);
  const next = await coordination.reserveRecordingPlan({}, {}, createPlan);
  assert.notEqual(first.targetName, next.targetName);
});

test('reservation failure can be retried without storing an incomplete plan', async () => {
  const pending = {};
  await assert.rejects(coordination.reserveRecordingPlan(pending, {}, async () => { throw new Error('busy'); }), /busy/);
  assert.equal(pending.plan, undefined);
  const plan = await coordination.reserveRecordingPlan(pending, {}, async () => ({ targetName: 'ok.wav' }));
  assert.equal(plan.targetName, 'ok.wav');
});

test('a conflict replacement remains reserved on the next retry', async () => {
  const pending = {};
  const original = await coordination.reserveRecordingPlan(pending, {}, async () => ({ targetName: 'occupied.wav' }));
  Object.assign(original, { targetName: 'replacement.wav' });
  const retry = await coordination.reserveRecordingPlan(pending, {}, async () => { throw new Error('must reuse'); });
  assert.equal(retry.targetName, 'replacement.wav');
});

test('automatic processing passes the reservation into the real transaction path', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const body = source.slice(source.indexOf('async function advancePending('), source.indexOf('async function scanTick('));
  assert.ok(body.indexOf('Coordination.reserveRecordingPlan(') < body.indexOf('MonitoringPolicy.isFileStable('));
  assert.match(body, /reservedPlan\.sourceSignature = candidate\.sourceSignature/);
  assert.match(body, /executeCandidate\(candidate, allEntries, reservedPlan\)/);
  assert.match(body, /if \(!retryableLock\) pending\.stablePolls = 0/);
});

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
