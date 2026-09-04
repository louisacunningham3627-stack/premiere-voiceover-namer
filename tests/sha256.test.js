const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sha256 = require('../src/sha256.js');

function nodeHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('hashHex hashes an empty Uint8Array', () => {
  const bytes = new Uint8Array(0);
  assert.equal(sha256.hashHex(bytes), nodeHash(bytes));
  assert.equal(sha256.hashHex(bytes), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('hashHex accepts an ArrayBuffer and hashes abc', () => {
  const bytes = Uint8Array.from([0x61, 0x62, 0x63]);
  assert.equal(sha256.hashHex(bytes.buffer), nodeHash(bytes));
  assert.equal(sha256.hashHex(bytes.buffer), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('hashHex accepts an ArrayBufferView and hashes Chinese UTF-8', () => {
  const bytes = Buffer.from('工程录音-你好', 'utf8');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(sha256.hashHex(view), nodeHash(bytes));
});

test('createHasher supports repeated updates across block boundaries', () => {
  const bytes = Buffer.from('分块录音/'.repeat(40) + 'finished', 'utf8');
  const boundaries = [0, 1, 7, 63, 64, 65, 129, bytes.length];
  const hasher = sha256.createHasher();

  for (let index = 1; index < boundaries.length; index += 1) {
    const start = boundaries[index - 1];
    const end = boundaries[index];
    const chunk = new Uint8Array(bytes.buffer, bytes.byteOffset + start, end - start);
    assert.equal(hasher.update(chunk), hasher);
  }

  const digest = hasher.digestHex();
  assert.equal(digest, nodeHash(bytes));
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(hasher.digestHex(), digest);
  assert.throws(() => hasher.update(new Uint8Array([1])), /不能继续更新/);
});

test('hashHex matches node:crypto for one million a characters', () => {
  const bytes = new Uint8Array(1000000);
  bytes.fill(0x61);

  const digest = sha256.hashHex(bytes);
  assert.equal(digest, nodeHash(bytes));
  assert.equal(digest, 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('hashHex rejects unsupported input values', () => {
  assert.throws(() => sha256.hashHex('abc'), /Uint8Array/);
  assert.throws(() => sha256.hashHex(null), /Uint8Array/);
});

test('UMD build exposes VoiceoverNamerSha256 in a browser-like context', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sha256.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);

  const digest = vm.runInContext(
    'VoiceoverNamerSha256.hashHex(new Uint8Array([0x61, 0x62, 0x63]))',
    context,
  );
  assert.equal(digest, nodeHash(Buffer.from('abc')));
});
