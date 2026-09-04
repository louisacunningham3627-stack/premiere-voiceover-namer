const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

const core = require('../src/core.js');

test('sanitizeSegment handles Chinese text, invalid characters, whitespace, and fallback', () => {
  assert.equal(core.sanitizeSegment('  企划:录音/第 1 轨  ', 'fallback'), '企划_录音_第 1 轨');
  assert.equal(core.sanitizeSegment('甲<>:"/\\|?*\u0001乙', 'fallback'), '甲_乙');
  assert.equal(core.sanitizeSegment('   ...   ', 'fallback'), 'fallback');
  assert.equal(core.sanitizeSegment('', '未命名'), '未命名');
  assert.equal(core.sanitizeSegment('a__b', 'fallback'), 'a_b');
  assert.equal(core.sanitizeSegment('e\u0301', 'fallback'), 'é');
});

test('sanitizeSegment protects Windows reserved names and truncates by Unicode characters', () => {
  assert.equal(core.sanitizeSegment('CON', 'fallback'), '_CON');
  assert.equal(core.sanitizeSegment('con.txt', 'fallback'), '_con.txt');
  assert.equal(core.sanitizeSegment('LPT1.backup', 'fallback'), '_LPT1.backup');
  assert.equal(core.sanitizeSegment('COM0', 'fallback'), 'COM0');
  assert.equal(core.sanitizeSegment('a'.repeat(81), 'fallback').length, 80);
  assert.equal(core.sanitizeSegment('界'.repeat(81), 'fallback'), '界'.repeat(80));
});

test('path and filename helpers respect Windows and POSIX boundaries', () => {
  assert.equal(core.fileNameFromPath('C:\\Captures\\take.wav'), 'take.wav');
  assert.equal(core.fileNameFromPath('/captures/take.wav'), 'take.wav');
  assert.equal(core.extensionOf('C:\\Captures\\take.WAV'), '.WAV');
  assert.equal(core.extensionOf('.profile'), '');
  assert.equal(core.stemOf('take.wav'), 'take');
  assert.equal(core.stemOf('no-extension'), 'no-extension');
  assert.equal(core.projectStem('C:\\Projects\\我的项目.prproj'), '我的项目');
  assert.equal(core.projectStem('untitled'), 'untitled');

  assert.deepEqual(core.splitNativePath('C:\\Captures\\take.wav'), {
    dir: 'C:\\Captures', base: 'take.wav', separator: '\\',
  });
  assert.deepEqual(core.splitNativePath('/captures/take.wav'), {
    dir: '/captures', base: 'take.wav', separator: '/',
  });
  assert.deepEqual(core.splitNativePath('/take.wav'), {
    dir: '/', base: 'take.wav', separator: '/',
  });
  assert.equal(core.joinNativePath('C:\\Captures\\', 'take.wav'), 'C:\\Captures\\take.wav');
  assert.equal(core.joinNativePath('/captures/', 'take.wav'), '/captures/take.wav');
  assert.equal(core.joinNativePath('/', 'take.wav'), '/take.wav');
  assert.equal(core.joinNativePath('', 'take.wav'), 'take.wav');
  assert.equal(core.recordingDirectoryFromProjectPath('D:\\Projects\\节目.prproj'), 'D:\\Projects\\录音');
  assert.equal(core.recordingDirectoryFromProjectPath('\\\\SERVER\\Share\\项目\\节目.prproj'), '\\\\SERVER\\Share\\项目\\录音');
  assert.equal(core.recordingDirectoryFromProjectPath('/Volumes/Edit/项目/节目.prproj'), '/Volumes/Edit/项目/录音');
  assert.equal(core.recordingDirectoryFromProjectPath('/节目.prproj'), '/录音');
  assert.equal(core.recordingDirectoryFromProjectPath('relative/节目.prproj'), '');
  assert.equal(core.recordingDirectoryFromProjectPath(''), '');

  assert.equal(core.sameNativePath('C:\\CAPTURES\\take.wav', 'c:/captures/take.wav'), true);
  assert.equal(core.sameNativePath('/Captures/take.wav', '/captures/take.wav'), false);
  assert.equal(core.nativePathPlatform('/'), 'posix');
  assert.equal(core.normalizePathForComparison('/'), '/');
  assert.equal(core.normalizePathForComparison('/Users/Me/Captures/'), '/Users/Me/Captures');
  assert.equal(core.sameNativePath('/Users/Me/Captures/take.wav', '/users/me/captures/take.wav'), false);
  assert.equal(core.isPathInside('/Users/Me/Captures/take.wav', '/'), true);
  assert.equal(core.isPathInside('/Users/Me/Captures/take.wav', '/Users/Me'), true);
  assert.equal(core.isPathInside('/Users/Media/take.wav', '/Users/Me'), false);
  assert.equal(core.normalizePathForComparison('/Users/Me/./Captures/../take.wav'), '/Users/Me/take.wav');
  assert.equal(core.isPathInside('/Users/Me/../../etc/take.wav', '/Users/Me'), false);
  assert.equal(core.isPathInside('C:\\Captures\\..\\Other\\take.wav', 'C:\\Captures'), false);
  assert.equal(core.sameNativePath('\\\\SERVER\\Share\\Take.wav', '//server/share/take.wav'), true);
  assert.equal(core.isPathInside('\\\\SERVER\\Share\\Nested\\Take.wav', '\\\\server\\share'), true);
  assert.equal(core.isPathInside('\\\\SERVER\\Share2\\Take.wav', '\\\\server\\share'), false);
  assert.equal(core.isPathInside('C:\\Captures\\nested\\take.wav', 'c:\\captures'), true);
  assert.equal(core.isPathInside('C:\\Captures2\\take.wav', 'C:\\Captures'), false);
  assert.equal(core.isPathInside('C:\\Capture', 'C:\\Captures'), false);
  assert.equal(core.isPathInside('C:\\Captures', 'C:\\Captures'), true);
  assert.equal(core.isPathInside('C:\\Captures\\take.wav', ''), false);
  assert.equal(core.isWaveFile('C:\\Captures\\take.WaV'), true);
  assert.equal(core.isWaveFile('C:\\Captures\\take.wav.bak'), false);
});

test('buildRecordingName uses a normalized 128-bit recording ID without a timestamp', () => {
  assert.equal(core.buildRecordingName({
    projectName: 'C:\\Projects\\中文企划.prproj',
    recordingId: '7F3C9A2E-4B1D-48F0-A6C1-E8D2B9F04A77',
  }), '中文企划-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav');
  assert.equal(core.buildRecordingName({
    projectName: '项目', recordingId: '00000000000040008000000000000000',
  }), '项目-00000000000040008000000000000000.wav');
  assert.throws(() => core.buildRecordingName({ projectName: '项目', recordingId: '1234' }), /32 位/);
});

test('only UUID names are normalized identities; legacy numeric names remain upgrade candidates', () => {
  assert.equal(core.isGlobalRecordingName('项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav'), true);
  assert.equal(core.isGlobalRecordingName('项目-000123.wav'), false);
  assert.equal(core.isGlobalRecordingName('项目-A02-003-20260902-140506.wav'), false);
});

test('secure UUIDv4 IDs have the expected bits and remain unique across 10,000 recordings', () => {
  const ids = new Set();
  for (let index = 0; index < 10000; index += 1) {
    const id = core.createRecordingId(webcrypto);
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(id[12], '4');
    assert.match(id[16], /^[89ab]$/);
    ids.add(id);
  }
  assert.equal(ids.size, 10000);
});

test('getRandomValues fallback sets UUIDv4 version and variant bits', () => {
  const source = {
    getRandomValues(bytes) {
      bytes.fill(0xff);
      return bytes;
    },
  };
  assert.equal(core.createRecordingId(source), 'ffffffffffff4fffbfffffffffffffff');
});

test('missing or invalid secure random APIs fail closed', () => {
  assert.equal(core.secureRandomAvailable({}), false);
  assert.equal(core.secureRandomAvailable({ crypto: webcrypto }), true);
  assert.throws(() => core.createRecordingId({}), /不支持安全随机源/);
  assert.throws(() => core.createRecordingId({ randomUUID: () => 'not-a-uuid' }), /无效的 UUIDv4/);
});

test('available recording names retry a local collision without overwriting it', () => {
  const ids = [
    '7f3c9a2e-4b1d-48f0-a6c1-e8d2b9f04a77',
    '2f6ba83a-f65c-4a57-8e9f-4c58a0e711b2',
  ];
  const plan = core.createAvailableRecordingName({
    projectName: '项目.prproj',
    existingNames: ['D:\\录音\\项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav'],
    randomSource: { randomUUID: () => ids.shift() },
  });
  assert.deepEqual(plan, {
    recordingId: '2f6ba83af65c4a578e9f4c58a0e711b2',
    targetName: '项目-2f6ba83af65c4a578e9f4c58a0e711b2.wav',
    attempts: 2,
  });
});

test('independent project copies do not share state to produce different IDs', () => {
  const left = core.createAvailableRecordingName({ projectName: '项目', randomSource: webcrypto });
  const right = core.createAvailableRecordingName({ projectName: '项目', randomSource: webcrypto });
  assert.notEqual(left.recordingId, right.recordingId);
  assert.notEqual(left.targetName, right.targetName);
});

test('managed names parse global IDs and all three legacy formats', () => {
  assert.deepEqual(core.parseManagedName('D:\\录音\\旧项目-7F3C9A2E4B1D48F0A6C1E8D2B9F04A77.WAV', '新项目.prproj'), {
    project: '旧项目', sequence: 0, recordingId: '7f3c9a2e4b1d48f0a6c1e8d2b9f04a77',
    date: '', time: '', format: 'global-id', trackLabel: '',
  });
  assert.deepEqual(core.parseManagedName('D:\\录音\\复杂-企划-000123.WAV'), {
    project: '复杂-企划', sequence: 123, recordingId: '', date: '', time: '',
    format: 'project', trackLabel: '',
  });
  assert.deepEqual(core.parseManagedName('D:\\录音\\复杂-企划-000123-20260902-140506.WAV'), {
    project: '复杂-企划', sequence: 123, recordingId: '', date: '20260902', time: '140506',
    format: 'project-timestamp', trackLabel: '',
  });
  assert.deepEqual(core.parseManagedName('D:\\录音\\复杂-企划-A02-003-20260902-140506.WAV'), {
    project: '复杂-企划', trackLabel: 'A02', sequence: 3, recordingId: '', date: '20260902', time: '140506',
    format: 'legacy-track',
  });
  assert.deepEqual(core.parseManagedName('复杂-企划-000123.wav', '复杂-企划.prproj'), {
    project: '复杂-企划', sequence: 123, recordingId: '', date: '', time: '',
    format: 'project', trackLabel: '',
  });
  assert.equal(core.parseManagedName('复杂-企划-000123.wav', '其它.prproj'), null);
  assert.equal(core.parseManagedName('项目-000003-20260902-140506.mp3'), null);
  assert.equal(core.parseManagedName('项目-A02-003-20260902-140506.mp3'), null);
  assert.equal(core.parseManagedName('项目-000003.mp3'), null);
  assert.equal(core.parseManagedName('unmanaged.wav'), null);
});
