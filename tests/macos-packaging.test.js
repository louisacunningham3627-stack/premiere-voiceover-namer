const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const installScript = fs.readFileSync('scripts/install-user-plugin-macos.sh', 'utf8');
const uninstallScript = fs.readFileSync('scripts/uninstall-user-plugin-macos.sh', 'utf8');
const packageScript = fs.readFileSync('scripts/package-macos.mjs', 'utf8');
const plutilStub = fs.readFileSync('tests/fixtures/plutil-stub.py', 'utf8');

test('macOS source installer defaults to the complete dist while bundled installer uses plugin', () => {
  assert.match(installScript, /DEFAULT_BUILD_PATH="\$PROJECT_ROOT\/dist"/);
  assert.match(installScript, /DEFAULT_BUILD_PATH="\$PROJECT_ROOT\/plugin"/);
  assert.match(installScript, /if \[\[ -d "\$SCRIPT_DIR\/plugin" \]\]/);
  assert.doesNotMatch(installScript, /node\s+-e|node\s+-p/);
  assert.match(installScript, /PLUTIL_BIN/);
  assert.match(installScript, /-extract "\$key_path" raw/);
  assert.doesNotMatch(installScript, /MANIFEST_COMPACT/);
  assert.match(packageScript, /install-user-plugin-macos\.sh/);
});

test('macOS install and uninstall refuse unsafe existing targets', () => {
  for (const script of [installScript, uninstallScript]) {
    assert.match(script, /-e "\$TARGET_PATH".*-L "\$TARGET_PATH"/s);
    assert.match(script, /! -L "\$TARGET_PATH"/);
    assert.match(script, /manifest\.json/);
    assert.match(script, /PLUGIN_ID/);
    assert.match(script, /PLUTIL_BIN/);
    assert.match(script, /manifest_value/);
    assert.doesNotMatch(script, /MANIFEST_COMPACT/);
  }
  assert.match(installScript, /find "\$BUILD_PATH" -type l/);
  assert.match(installScript, /package\.json/);
  assert.doesNotMatch(installScript, /shasum -a 256 -c/);
  assert.match(installScript, /package_file_count/);
  assert.match(installScript, /未列入 SHA-256 清单/);
  assert.match(packageScript, /只允许普通文件和目录/);
});

test('the WSL manifest parser fixture accepts only the plutil extraction contract', () => {
  assert.match(plutilStub, /args\[0\] != "-extract"/);
  assert.match(plutilStub, /args\[2:5\] != \["raw", "-o", "-"\]/);
  assert.match(plutilStub, /args\[1\]\.split\("\."\)/);
});
