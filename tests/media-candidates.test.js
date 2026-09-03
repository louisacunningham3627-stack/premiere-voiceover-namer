const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core.js');
const mediaCandidates = require('../src/media-candidates.js');

function deduplicate(entries) {
  return mediaCandidates.deduplicate(entries, core.normalizePathForComparison);
}

function entry(mediaPath, projectItem, projectItemId = '', trackItems = []) {
  return { mediaPath, projectItem, projectItemId, trackItems };
}

test('the candidate deduplicator is exposed as a pure media-entry helper', () => {
  assert.equal(typeof mediaCandidates.deduplicate, 'function');
});

test('the same ProjectItem used on multiple tracks is returned once without a conflict', () => {
  const projectItem = { wrapper: 'first' };
  const firstTrackItem = { clip: 'first' };
  const secondTrackItem = { clip: 'second' };
  const result = deduplicate([
    entry('C:\\Captures\\take.wav', projectItem, 'item-1', [firstTrackItem]),
    entry('C:\\Captures\\take.wav', { wrapper: 'second' }, 'item-1', [secondTrackItem]),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].projectItem, projectItem);
  assert.equal(result[0].multipleProjectItems, false);
  assert.deepEqual(result[0].trackItems, [firstTrackItem, secondTrackItem]);
});

test('the same path from multiple ProjectItems is deduplicated and marked as a conflict', () => {
  const firstItem = { id: 'item-1' };
  const secondItem = { id: 'item-2' };
  const result = deduplicate([
    entry('C:\\Captures\\take.wav', firstItem, 'item-1'),
    entry('c:/captures/TAKE.wav', secondItem, 'item-2'),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].projectItem, firstItem);
  assert.equal(result[0].multipleProjectItems, true);
});

test('missing ProjectItem IDs with different track wrappers do not create a false conflict', () => {
  const result = deduplicate([
    entry('C:\\Captures\\take.wav', { wrapper: 'track-a' }),
    entry('c:/captures/TAKE.wav', { wrapper: 'track-b' }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].multipleProjectItems, false);
});

test('two distinct known ProjectItem IDs remain a conflict', () => {
  const result = deduplicate([
    entry('C:\\Captures\\take.wav', { wrapper: 'first' }, 'item-1'),
    entry('C:\\Captures\\take.wav', { wrapper: 'second' }, 'item-2'),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].multipleProjectItems, true);
});

test('path deduplication treats Windows slash and case variants as one media path', () => {
  const projectItem = { id: 'item-1' };
  const trackItem = { clip: 'only-once' };
  const result = deduplicate([
    entry('D:\\VO\\voice-01.wav', projectItem, '', [trackItem]),
    entry('d:/vo/VOICE-01.wav', projectItem, '', [trackItem]),
    entry('D:\\VO\\voice-01.wav', projectItem, '', [trackItem]),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].multipleProjectItems, false);
  assert.deepEqual(result[0].trackItems, [trackItem]);
});
