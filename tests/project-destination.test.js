const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const mainSource = readFileSync('src/main.js', 'utf8');

function functionBody(name, nextName) {
  const start = mainSource.indexOf(`function ${name}`);
  const end = mainSource.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0, `${name} is missing`);
  assert.ok(end > start, `${name} boundary is missing`);
  return mainSource.slice(start, end);
}

test('target planning always uses the saved Premiere project recording directory', () => {
  const body = functionBody('targetPlanFor', 'executeCandidate');
  assert.match(body, /recordingFolderForCandidate\(candidate\)/);
  assert.match(body, /FolderReadiness\.ensure\(fs, targetDirectory, uxp\.storage\.localFileSystem\)/);
  assert.match(body, /Core\.joinNativePath\(targetDirectory, targetName, targetSeparator\)/);
  assert.doesNotMatch(body, /Core\.joinNativePath\(sourceParts\.dir/);
});

test('an existing UUID recording outside the project folder remains eligible for an explicit move', () => {
  const body = functionBody('isNormalizedRecording', 'resetWatchFolderValidation');
  assert.match(body, /Core\.isGlobalRecordingName\(candidate\.mediaPath\)/);
  assert.match(body, /Core\.sameNativePath\(Core\.splitNativePath\(candidate\.mediaPath\)\.dir, recordingFolder\)/);
});

test('cross-volume cleanup warnings are surfaced without undoing the verified project link', () => {
  const body = functionBody('executeCandidate', 'synchronizeNormalizedRecordingNames');
  assert.match(body, /plan\.sourceRetained = transactionResult\.sourceRetained/);
  assert.match(body, /addLog\("warn", plan\.cleanupWarning\)/);
  assert.match(body, /已移入工程媒体目录并同步 Premiere/);
});
