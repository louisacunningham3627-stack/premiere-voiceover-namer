const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const transaction = require('../src/transaction.js');
const core = require('../src/core.js');

function makePremiereMedia(sourcePath, sourceName) {
  const projectItem = {
    name: sourceName,
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
  const trackItem = {
    name: sourceName,
    async getName() { return this.name; },
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
  return { project, projectItem, trackItem };
}

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

  const { project, projectItem, trackItem } = makePremiereMedia(sourcePath, '音频 2_1.wav');

  await transaction.renameAndRelink({
    fs,
    project,
    projectItem,
    trackItems: [trackItem],
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
  assert.equal(trackItem.name, targetName);
});

test('renameAndRelink performs a real C-to-project-volume transfer when two Windows volumes are available', async (t) => {
  const projectRoot = path.resolve(__dirname, '..');
  const sourceRoot = path.parse(os.tmpdir()).root;
  const targetRoot = path.parse(projectRoot).root;
  if (process.platform !== 'win32' || sourceRoot.toLowerCase() === targetRoot.toLowerCase()) {
    t.skip('requires separate Windows source and project volumes');
    return;
  }

  const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'voiceover-source-'));
  const workDirectory = path.join(projectRoot, 'work');
  await fs.mkdir(workDirectory, { recursive: true });
  const targetDirectory = await fs.mkdtemp(path.join(workDirectory, 'cross-volume-'));
  t.after(async () => {
    await fs.rm(sourceDirectory, { recursive: true, force: true });
    await fs.rm(targetDirectory, { recursive: true, force: true });
  });

  const sourceName = '音频 3_1.wav';
  const sourcePath = path.join(sourceDirectory, sourceName);
  const targetName = '跨盘工程-2f6ba83af65c4a578e9f4c58a0e711b2.wav';
  const targetPath = path.join(targetDirectory, targetName);
  const contents = Buffer.alloc(1024 * 1024 + 17, 0x5a);
  await fs.writeFile(sourcePath, contents);
  const { project, projectItem, trackItem } = makePremiereMedia(sourcePath, sourceName);

  const result = await transaction.renameAndRelink({
    fs,
    project,
    projectItem,
    trackItems: [trackItem],
    sourcePath,
    targetPath,
    targetName,
    samePath: core.sameNativePath,
    delay: async () => {},
  });

  assert.equal(result.transferMode, 'copied');
  assert.equal(result.sourceRetained, false);
  await assert.rejects(fs.lstat(sourcePath), (error) => error.code === 'ENOENT');
  assert.deepEqual(await fs.readFile(targetPath), contents);
  assert.equal(projectItem.mediaPath, targetPath);
  assert.equal(projectItem.name, targetName);
  assert.equal(trackItem.name, targetName);
  assert.equal((await fs.readdir(targetDirectory)).some((name) => name.includes('.voiceover-namer-cleanup')), false);
});
