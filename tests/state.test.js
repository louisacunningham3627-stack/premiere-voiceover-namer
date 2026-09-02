const test = require('node:test');
const assert = require('node:assert/strict');

const stateApi = require('../src/state.js');

const V4_KEYS = ['schemaVersion', 'projectIdentity', 'watchFolder', 'autoStart', 'history'];

test('createState returns the v4 project-level defaults without a counter', () => {
  const state = stateApi.createState('project-1');
  assert.deepEqual(state, {
    schemaVersion: 4,
    projectIdentity: 'project-1',
    watchFolder: '',
    autoStart: false,
    history: [],
  });
  assert.deepEqual(Object.keys(state), V4_KEYS);
  assert.equal(Object.hasOwn(state, 'recordingCounter'), false);
  assert.equal(Object.hasOwn(state, 'updatedAt'), false);
});

test('needsMigration identifies only supported pre-v4 schemas', () => {
  assert.equal(stateApi.needsMigration({ schemaVersion: 1 }), true);
  assert.equal(stateApi.needsMigration({ schemaVersion: 2 }), true);
  assert.equal(stateApi.needsMigration({ schemaVersion: 3 }), true);
  assert.equal(stateApi.needsMigration({ schemaVersion: 4 }), false);
  assert.equal(stateApi.needsMigration({ schemaVersion: 99 }), false);
  assert.equal(stateApi.needsMigration(null), false);
});

test('hydrateState rejects invalid schema and foreign project identities', () => {
  assert.deepEqual(
    stateApi.hydrateState({ schemaVersion: 99, projectIdentity: 'project-1' }, 'project-1'),
    stateApi.createState('project-1'),
  );
  assert.deepEqual(
    stateApi.hydrateState({ schemaVersion: 2, projectIdentity: 'other' }, 'project-1'),
    stateApi.createState('project-1'),
  );
});

test('hydrateState migrates schema 1 and retains legacy history fields', () => {
  const raw = {
    schemaVersion: 1,
    projectIdentity: 'project-1',
    watchFolder: 123,
    autoStart: true,
    counters: { good: 4, text: '8' },
    history: [null, 'bad', { sequence: 1, sourcePath: 'old.wav' }, { sequence: 2 }],
    updatedAt: '2026-09-02T10:00:00.000Z',
  };
  const migrated = stateApi.hydrateState(raw, 'project-1');
  assert.deepEqual(Object.keys(migrated), V4_KEYS);
  assert.equal(migrated.watchFolder, '');
  assert.equal(migrated.autoStart, true);
  assert.equal(migrated.history.length, 2);
  assert.equal(migrated.history[0].sequence, 1);
  assert.equal(migrated.history[0].sourcePath, 'old.wav');
  assert.equal(migrated.history[0].recordingId, '');
  assert.equal(migrated.history[0].at, '2026-09-02T10:00:00.000Z');
  assert.equal(migrated.history[1].targetPath, '');
});

test('hydrateState migrates schema 2 and schema 3 to the same v4 shape', () => {
  for (const schemaVersion of [2, 3]) {
    const migrated = stateApi.hydrateState({
      schemaVersion,
      projectIdentity: 'project-1',
      watchFolder: 'C:\\Captures',
      autoSave: false,
      autoStart: true,
      recordingCounter: 8,
      history: [{ sequence: 5, sourcePath: 'source.wav', targetPath: 'target.wav' }],
      updatedAt: '2026-09-02T10:00:00.000Z',
    }, 'project-1');
    assert.deepEqual(Object.keys(migrated), V4_KEYS);
    assert.equal(migrated.schemaVersion, 4);
    assert.equal(migrated.watchFolder, 'C:\\Captures');
    assert.equal(migrated.autoStart, true);
    assert.equal(migrated.history[0].sequence, 5);
    assert.equal(migrated.history[0].recordingId, '');
    assert.equal(Object.hasOwn(migrated, 'recordingCounter'), false);
  }
});

test('v4 history is canonical and does not depend on sequence', () => {
  const hydrated = stateApi.hydrateState({
    schemaVersion: 4,
    projectIdentity: 'p',
    history: [{ sequence: 99, recordingId: '7f3c9a2e4b1d48f0a6c1e8d2b9f04a77', sourcePath: 'a.wav', targetPath: 'b.wav', at: 'when', extra: true }],
  }, 'p');
  assert.deepEqual(hydrated.history, [{
    recordingId: '7f3c9a2e4b1d48f0a6c1e8d2b9f04a77', sourcePath: 'a.wav', targetPath: 'b.wav', at: 'when',
  }]);
  assert.equal(Object.hasOwn(hydrated.history[0], 'sequence'), false);
});

test('history migration and commits enforce the 200-entry limit', () => {
  const history = Array.from({ length: 205 }, (_, index) => ({
    recordingId: `${index.toString(16).padStart(32, '0')}`,
    sourcePath: `source-${index}.wav`,
    targetPath: `target-${index}.wav`,
    at: `time-${index}`,
  }));
  const hydrated = stateApi.hydrateState({ schemaVersion: 4, projectIdentity: 'p', history }, 'p');
  assert.equal(hydrated.history.length, stateApi.HISTORY_LIMIT);
  assert.equal(hydrated.history[0].recordingId, '00000000000000000000000000000005');

  const committed = stateApi.commitRecording(hydrated, {
    recordingId: 'abcdefabcdef4abcdefabcdefabcdefa',
    at: '2026-09-02T10:00:00.000Z',
    sequence: 7,
    sourcePath: 'source.wav',
    targetPath: 'target.wav',
  });
  assert.equal(committed.history.length, stateApi.HISTORY_LIMIT);
  assert.equal(committed.history[0].recordingId, '00000000000000000000000000000006');
  assert.deepEqual(committed.history.at(-1), {
    recordingId: 'abcdefabcdef4abcdefabcdefabcdefa',
    at: '2026-09-02T10:00:00.000Z',
    sourcePath: 'source.wav',
    targetPath: 'target.wav',
  });
  assert.equal(Object.hasOwn(committed.history.at(-1), 'sequence'), false);
  assert.equal(hydrated.history.length, stateApi.HISTORY_LIMIT);
});

test('commitRecording requires a recordingId and does not mutate input state', () => {
  const state = stateApi.createState('p');
  assert.throws(() => stateApi.commitRecording(state, { at: 'when', sourcePath: 'source.wav' }), /合法/);
  const next = stateApi.commitRecording(state, {
    recordingId: '7F3C9A2E-4B1D-48F0-A6C1-E8D2B9F04A77',
    at: 'when', sourcePath: 'source.wav',
  });
  assert.equal(next.history[0].recordingId, '7f3c9a2e4b1d48f0a6c1e8d2b9f04a77');
  assert.equal(next.history[0].sourcePath, 'source.wav');
  assert.equal(next.history[0].targetPath, '');
  assert.equal(next.history[0].at, 'when');
  assert.deepEqual(state.history, []);
  assert.deepEqual(Object.keys(next), V4_KEYS);
});

test('withSettings updates supported settings, accepts the path alias, and returns a clone', () => {
  const state = stateApi.createState('p');
  const next = stateApi.withSettings(state, {
    watchFolder: 'C:\\Captures', watchFolderPath: 'ignored', autoSave: false, autoStart: true,
  });
  assert.equal(next.watchFolder, 'C:\\Captures');
  assert.equal(next.autoStart, true);
  assert.equal(Object.hasOwn(next, 'autoSave'), false);
  assert.notEqual(next, state);
  assert.deepEqual(state, stateApi.createState('p'));

  const aliased = stateApi.withSettings(next, { watchFolderPath: 'D:\\Audio' });
  assert.equal(aliased.watchFolder, 'D:\\Audio');
  assert.equal(aliased.autoStart, true);
});

test('legacy migration is idempotent for the canonical v4 state', () => {
  const legacy = {
    schemaVersion: 1,
    projectIdentity: 'p',
    counters: { low: 6 },
    history: [{ sequence: 17, at: 'when', sourcePath: 'source.wav', targetPath: 'target.wav' }],
  };
  const migrated = stateApi.hydrateState(legacy, 'p');
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(stateApi.hydrateState(migrated, 'p'), {
    ...migrated,
    history: [{
      recordingId: '', sourcePath: 'source.wav', targetPath: 'target.wav', at: 'when',
    }],
  });
  assert.equal(stateApi.needsMigration(migrated), false);
});
