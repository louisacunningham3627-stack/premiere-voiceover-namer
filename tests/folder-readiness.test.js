const test = require('node:test');
const assert = require('node:assert/strict');

const folderReadiness = require('../src/folder-readiness.js');

test('folder readiness keeps an unselected path incomplete without an error', async () => {
  const result = await folderReadiness.inspect({}, '');
  assert.deepEqual(result, { valid: false, problem: '' });
});

test('folder readiness accepts a directory', async () => {
  const result = await folderReadiness.inspect({
    lstat: async () => ({ isDirectory: () => true }),
  }, 'D:\\Captured Audio');
  assert.deepEqual(result, { valid: true, problem: '' });
});

test('folder readiness rejects a file path with a specific recovery message', async () => {
  const result = await folderReadiness.inspect({
    lstat: async () => ({ isDirectory: () => false }),
  }, 'D:\\Captured Audio\\recording.wav');
  assert.equal(result.valid, false);
  assert.match(result.problem, /文件/);
  assert.match(result.problem, /重新选择/);
});

test('folder readiness rejects missing or inaccessible directories', async () => {
  const result = await folderReadiness.inspect({
    lstat: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  }, 'D:\\Missing');
  assert.equal(result.valid, false);
  assert.match(result.problem, /不存在或无法访问/);
});

test('folder readiness fails closed when filesystem metadata cannot identify a directory', async () => {
  const result = await folderReadiness.inspect({
    lstat: async () => ({}),
  }, 'D:\\Unknown');
  assert.equal(result.valid, false);
  assert.match(result.problem, /无法确认/);
});

test('folder readiness creates and verifies a missing project recording directory', async () => {
  let present = false;
  const calls = [];
  const result = await folderReadiness.ensure({
    async lstat(path) {
      calls.push(['lstat', path]);
      if (!present) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return { isDirectory: () => true };
    },
    async mkdir(path) {
      calls.push(['mkdir', path]);
      present = true;
    },
  }, 'E:\\节目\\Adobe Premiere Pro Captured and Generated');

  assert.deepEqual(result, { valid: true, created: true, problem: '' });
  assert.deepEqual(calls, [
    ['lstat', 'E:\\节目\\Adobe Premiere Pro Captured and Generated'],
    ['mkdir', 'E:\\节目\\Adobe Premiere Pro Captured and Generated'],
    ['lstat', 'E:\\节目\\Adobe Premiere Pro Captured and Generated'],
  ]);
});

test('folder readiness reuses an existing project recording directory without mkdir', async () => {
  let mkdirCalls = 0;
  const result = await folderReadiness.ensure({
    async lstat() { return { isDirectory: () => true }; },
    async mkdir() { mkdirCalls += 1; },
  }, '/Volumes/Edit/节目/Adobe Premiere Pro Captured and Generated');

  assert.deepEqual(result, { valid: true, created: false, problem: '' });
  assert.equal(mkdirCalls, 0);
});

test('folder readiness reports a project recording directory creation failure', async () => {
  const result = await folderReadiness.ensure({
    async lstat() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    async mkdir() {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  }, 'E:\\节目\\Adobe Premiere Pro Captured and Generated');

  assert.equal(result.valid, false);
  assert.equal(result.created, false);
  assert.match(result.problem, /无法创建工程媒体目录/);
  assert.match(result.problem, /没有写入权限/);
  assert.doesNotMatch(result.problem, /permission denied/i);
});
