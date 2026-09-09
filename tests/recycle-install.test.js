const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

test('isolated helper setup keeps writable data outside the plugin and preserves its key', { skip: process.platform !== 'win32' }, async () => {
  const root = path.resolve(__dirname, '..');
  const work = path.join(root, 'work');
  await fs.mkdir(work, { recursive: true });
  const run = await fs.mkdtemp(path.join(work, 'recycle-install-test-'));
  const plugin = path.join(run, 'UXP/Plugins/External/com.hechao.premiere.voiceover-namer');
  await fs.mkdir(path.join(plugin, 'native/windows'), { recursive: true });
  await fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ id: 'com.hechao.premiere.voiceover-namer' }));
  // Setup validates presence; this fixture is never launched or registered as a protocol handler.
  await fs.writeFile(path.join(plugin, 'native/windows/RecycleHelper.exe'), 'test-only');
  const script = path.join(root, 'scripts/configure-recycle-bridge.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-PluginPath', plugin, '-SkipProtocol'];
  await execFile('powershell.exe', args, { windowsHide: true });
  const location = JSON.parse(await fs.readFile(path.join(plugin, 'native/windows/bridge-location.json'), 'utf8'));
  assert.equal(location.directory, path.join(run, 'UXP/VoiceoverNamerData/Bridge'));
  assert.equal(location.directory.startsWith(plugin + path.sep), false);
  const key = await fs.readFile(path.join(location.directory, 'token.txt'), 'utf8');
  assert.match(key, /^[0-9a-f]{64}$/);
  await execFile('powershell.exe', args, { windowsHide: true });
  assert.equal(await fs.readFile(path.join(location.directory, 'token.txt'), 'utf8'), key);
});
