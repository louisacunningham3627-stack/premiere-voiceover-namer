import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const name = `premiere-voiceover-namer-${version}-windows`;
const directory = path.join(root, 'outputs/windows', name);
const zip = directory + '.zip';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal((await readFile(zip + '.sha256', 'utf8')).trim(), `${hash(await readFile(zip))}  ${path.basename(zip)}`);
async function inventory(dir, prefix = '') {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isDirectory()) files.push(...await inventory(path.join(dir, item.name), prefix + item.name + '/'));
    else { assert.equal(item.isFile(), true); files.push(prefix + item.name); }
  }
  return files.sort();
}
async function verify(dir) {
  const lines = (await readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/);
  const listed = [];
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert.ok(match);
    assert.ok(!match[2].includes('..') && !match[2].includes('\\') && !path.isAbsolute(match[2]));
    assert.ok(!match[2].includes('.bridge') && !match[2].includes('token.txt') && !match[2].includes('bridge-location.json'));
    assert.equal(hash(await readFile(path.join(dir, match[2]))), match[1]);
    listed.push(match[2]);
  }
  assert.deepEqual((await inventory(dir)).filter(file => file !== 'SHA256SUMS.txt'), listed.sort());
  assert.equal(JSON.parse(await readFile(path.join(dir, 'plugin/manifest.json'), 'utf8')).version, version);
  assert.equal(hash(await readFile(path.join(dir, 'plugin/native/windows/RecycleHelper.exe'))), hash(await readFile(path.join(root, 'dist/native/windows/RecycleHelper.exe'))));
  return listed.length;
}
const count = await verify(directory);
await mkdir(path.join(root, 'work'), { recursive: true });
const extracted = await mkdtemp(path.join(root, 'work/windows-package-readback-'));
const quote = value => `'${value.replaceAll("'", "''")}'`;
await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::ExtractToDirectory(${quote(zip)}, ${quote(extracted)})`], { windowsHide: true });
assert.deepEqual(await readdir(extracted), [name]);
assert.equal(await verify(path.join(extracted, name)), count);
console.log(`Windows 一体安装包 ${count} 项 SHA-256、无凭据检查和 ZIP 解压读回均通过。`);
