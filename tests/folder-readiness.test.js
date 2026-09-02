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
