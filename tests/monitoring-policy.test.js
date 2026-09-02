const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const core = require('../src/core.js');
const policy = require('../src/monitoring-policy.js');

const normalizePath = core.normalizePathForComparison;
const isPathInside = core.isPathInside;

const captureRoot = 'E:\\Projects\\Adobe Premiere Pro Captured and Generated';
const learnedFolder = captureRoot + '\\插件加载验收-当前版临时副本';
const projectPath = 'E:\\Projects\\插件加载验收-当前版临时副本.prproj';

function trustedOptions(mediaPath, extra = {}) {
  return {
    mediaPath,
    learnedFolder: extra.learnedFolder || '',
    scratchPath: extra.scratchPath || '',
    projectPath: extra.projectPath || projectPath,
    normalizePath,
    isPathInside,
  };
}

function dispositionOf(value) {
  if (typeof value === 'string') return value;
  return value && (value.action || value.disposition || value.kind);
}

test('captureFolderFromMediaPath returns the native parent directory', () => {
  assert.equal(
    policy.captureFolderFromMediaPath(learnedFolder + '\\音频 1.wav'),
    learnedFolder,
  );
  assert.equal(
    policy.captureFolderFromMediaPath('D:/Captures/take.wav'),
    'D:/Captures',
  );
});

test('project identity combines normalized path and guid so copied projects stay distinct', () => {
  const normalize = (value) => String(value).replaceAll('\\', '/').toLowerCase();
  const first = policy.buildProjectIdentity('D:\\Edit\\A.prproj', 'same-guid', normalize);
  const same = policy.buildProjectIdentity('d:/edit/a.prproj', 'same-guid', normalize);
  const copy = policy.buildProjectIdentity('D:\\Edit\\Copy\\A.prproj', 'same-guid', normalize);
  assert.equal(first, same);
  assert.notEqual(first, copy);
});

test('trusted capture paths accept learned and Premiere scratch locations', () => {
  assert.equal(
    policy.isTrustedCapturePath(trustedOptions(learnedFolder + '\\音频 1.wav', {
      learnedFolder,
    })),
    true,
  );
  assert.equal(
    policy.isTrustedCapturePath(trustedOptions(captureRoot + '\\另一个工程\\音频 2.wav', {
      scratchPath: captureRoot,
    })),
    true,
  );
});

test('trusted capture paths recognize the Premiere capture marker without a selected folder', () => {
  assert.equal(
    policy.isTrustedCapturePath(trustedOptions(
      captureRoot + '\\插件加载验收-当前版临时副本\\音频 3.wav',
    )),
    true,
  );
});

test('ordinary WAV files outside capture locations are not trusted', () => {
  assert.equal(
    policy.isTrustedCapturePath(trustedOptions('E:\\Music\\旁白.wav')),
    false,
  );
  assert.equal(
    policy.isTrustedCapturePath(trustedOptions('E:\\Projects\\其他工程\\旁白.wav', {
      learnedFolder,
    })),
    false,
  );
});

test('automatic candidates accept only Premiere native default recording names', () => {
  assert.equal(typeof policy.isNativeDefaultRecordingName, 'function');
  for (const fileName of ['音频 1.wav', '音频 1_1.wav', 'Audio 1.wav']) {
    assert.equal(policy.isNativeDefaultRecordingName(fileName), true, fileName);
  }
  for (const fileName of ['music.wav', 'Audio.wav', '音频 1.mp3', '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav']) {
    assert.equal(policy.isNativeDefaultRecordingName(fileName), false, fileName);
  }
  assert.match(
    fs.readFileSync('src/main.js', 'utf8'),
    /MonitoringPolicy\.isNativeDefaultRecordingName\(candidate\.mediaPath\)/,
  );
});

test('file origin timestamps prefer birthtime and fall back to mtime', () => {
  assert.equal(policy.fileOriginTimestamp({ birthtimeMs: 1200, mtimeMs: 1800 }), 1200);
  assert.equal(policy.fileOriginTimestamp({ mtimeMs: 1800 }), 1800);
  assert.equal(policy.fileOriginTimestamp({}), 0);
});

test('freshness accepts files created just before arming within tolerance', () => {
  assert.equal(
    policy.isFreshFile({ birthtimeMs: 9950 }, 10000, 100),
    true,
  );
  assert.equal(
    policy.isFreshFile({ birthtimeMs: 9800 }, 10000, 100),
    false,
  );
  assert.equal(
    policy.isFreshFile({ mtimeMs: 10050 }, 10000, 100),
    true,
  );
});

test('stability signatures change when either size or mtime changes', () => {
  const first = policy.statSignature({ size: 100, mtimeMs: 1000 });
  assert.equal(first, policy.statSignature({ size: 100, mtimeMs: 1000 }));
  assert.notEqual(first, policy.statSignature({ size: 101, mtimeMs: 1000 }));
  assert.notEqual(first, policy.statSignature({ size: 100, mtimeMs: 1100 }));
});

test('long recordings use the last observed change, not total pending lifetime', () => {
  const first = policy.observeFileStability(null, { size: 1, mtimeMs: 100 }, 0);
  const changed = policy.observeFileStability(first, { size: 2, mtimeMs: 200 }, 70000);
  const settled = policy.observeFileStability(changed, { size: 2, mtimeMs: 200 }, 70400);

  assert.equal(changed.stablePolls, 1);
  assert.equal(changed.lastChangedAt, 70000);
  assert.equal(settled.stablePolls, 2);
  assert.equal(settled.lastChangedAt, 70000);
  assert.equal(
    policy.isFileStable(settled, 70500, { requiredPolls: 2, quietMs: 500 }),
    true,
  );
});

test('a file that keeps changing is not stable even after two observations', () => {
  const first = policy.observeFileStability(null, { size: 1, mtimeMs: 100 }, 1000);
  const changed = policy.observeFileStability(first, { size: 2, mtimeMs: 200 }, 1100);
  assert.equal(
    policy.isFileStable(changed, 1200, { requiredPolls: 2, quietMs: 500 }),
    false,
  );
});

test('production stability requires three polls and 3000ms of quiet time', () => {
  const options = { requiredPolls: 3, quietMs: 3000 };
  const first = policy.observeFileStability(null, { size: 1, mtimeMs: 100 }, 1000);
  const changed = policy.observeFileStability(first, { size: 2, mtimeMs: 200 }, 3000);
  const second = policy.observeFileStability(changed, { size: 2, mtimeMs: 200 }, 4000);
  assert.equal(second.stablePolls, 2);
  assert.equal(policy.isFileStable(second, 5000, options), false);

  const third = policy.observeFileStability(second, { size: 2, mtimeMs: 200 }, 5000);
  assert.equal(third.stablePolls, 3);
  assert.equal(policy.isFileStable(third, 5999, options), false);
  assert.equal(policy.isFileStable(third, 6000, options), true);
});

test('transient filesystem errors are retryable and receive a backoff', () => {
  for (const error of [
    Object.assign(new Error('file is busy'), { code: 'EBUSY' }),
    Object.assign(new Error('access denied'), { code: 'EACCES' }),
    Object.assign(new Error('temporarily missing'), { code: 'ENOENT' }),
    new Error('另一个进程正在占用文件'),
  ]) {
    assert.match(String(dispositionOf(policy.failureDisposition(error))), /^retry/, error.message);
  }

  const firstDelay = policy.retryDelayMs(0, true);
  const laterDelay = policy.retryDelayMs(2, true);
  assert.ok(firstDelay > 0);
  assert.ok(laterDelay >= firstDelay);
});

test('cancellation is not classified as a filesystem retry', () => {
  assert.notEqual(
    dispositionOf(policy.failureDisposition(Object.assign(new Error('面板已关闭'), {
      code: 'VOICEOVER_NAMER_CANCELLED',
    }))),
    'retry',
  );
});

test('panel visibility is explicit across show, hide, destroy, and auto-start checks', () => {
  const mainSource = fs.readFileSync('src/main.js', 'utf8');
  assert.match(mainSource, /var\s+panelVisible\s*=\s*false/);

  const showBody = mainSource.match(/show:\s*function\s*\(\)\s*\{([\s\S]*?)\n\s*\},\s*hide:/);
  const hideBody = mainSource.match(/hide:\s*function\s*\(\)\s*\{([\s\S]*?)\n\s*\},\s*destroy:/);
  const destroyBody = mainSource.match(/destroy:\s*function\s*\(\)\s*\{([\s\S]*?)\n\s*\},\s*\},/);

  assert.ok(showBody, 'panel show lifecycle is missing');
  assert.ok(hideBody, 'panel hide lifecycle is missing');
  assert.ok(destroyBody, 'panel destroy lifecycle is missing');
  const initializeBody = mainSource.match(/function initializePanel\(\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(initializeBody, 'panel initialization lifecycle is missing');
  assert.match(`${showBody[1]}\n${initializeBody[1]}`, /panelVisible\s*=\s*true/);
  assert.match(showBody[1], /initializePanel\s*\(\)/);
  assert.match(hideBody[1], /panelVisible\s*=\s*false/);
  assert.match(destroyBody[1], /panelVisible\s*=\s*false/);
  const startBody = mainSource.match(/async function startMonitoring\([^)]*\)\s*\{([\s\S]*?)\n\s*\}\n\s*function stopMonitoring/);
  assert.ok(startBody, 'startMonitoring lifecycle is missing');
  assert.match(startBody[1], /panelVisible/);
});

test('project media verification merges indexed and recursive matches and preserves raw bin fallback', () => {
  const mainSource = fs.readFileSync('src/main.js', 'utf8');
  const collectStart = mainSource.indexOf('async function collectProjectItemsForMediaPath');
  const ensureStart = mainSource.indexOf('async function ensureUniqueProjectMediaReference', collectStart);
  assert.ok(collectStart >= 0, 'project media collection is missing');
  assert.ok(ensureStart > collectStart, 'project media collection boundary is missing');
  const collectBody = mainSource.slice(collectStart, ensureStart);

  assert.match(mainSource, /function mergeMediaMatches\(primary, secondary\)/);
  assert.match(collectBody, /indexedMatches\s*=\s*await exactMediaMatches/);
  assert.match(collectBody, /recursiveMatches\s*=\s*await exactMediaMatches/);
  assert.match(collectBody, /return mergeMediaMatches\(indexedMatches, recursiveMatches\)/);
  assert.doesNotMatch(collectBody, /if\s*\(indexedMatches\.length\)\s*return indexedMatches/);
  assert.match(collectBody, /rawItem\s*&&\s*typeof rawItem\.getItems\s*===\s*"function"/);
});
