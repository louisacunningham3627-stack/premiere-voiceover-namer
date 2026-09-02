const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const transaction = require('../src/transaction.js');
const core = require('../src/core.js');

test('renameAndRelink performs a real Unicode filesystem rename', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'premiere-voiceover-namer-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const sourcePath = path.join(directory, '音频 2_1.wav');
  const targetName = '318最终版-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav';
  const targetPath = path.join(directory, targetName);
  const contents = Buffer.from('RIFF-test-payload');
  await fs.writeFile(sourcePath, contents);

  const projectItem = {
    name: '音频 2_1.wav',
    mediaPath: sourcePath,
    async canChangeMediaPath() { return true; },
    async changeMediaFilePath(nextPath) { this.mediaPath = nextPath; return true; },
    async refreshMedia() {},
    async getMediaFilePath() { return this.mediaPath; },
    async isOffline() { return false; },
    createSetNameAction(nextName) {
      return () => { this.name = nextName; };
    },
  };
  const project = {
    lockedAccess(callback) { callback(); },
    executeTransaction(callback) {
      callback({ addAction(action) { action(); } });
      return true;
    },
  };

  await transaction.renameAndRelink({
    fs,
    project,
    projectItem,
    sourcePath,
    targetPath,
    targetName,
    samePath: core.sameNativePath,
    delay: async () => {},
  });

  await assert.rejects(fs.lstat(sourcePath));
  assert.deepEqual(await fs.readFile(targetPath), contents);
  assert.equal(projectItem.mediaPath, targetPath);
  assert.equal(projectItem.name, targetName);
});
