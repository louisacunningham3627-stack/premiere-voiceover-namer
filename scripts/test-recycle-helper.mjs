import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import Auth from '../src/recycle-auth.js';

if (process.platform !== 'win32') {
  console.log('Windows 原生回收测试未执行：当前不是 Windows。');
  process.exit(0);
}
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const work = path.join(root, 'work');
await mkdir(work, { recursive: true });
const directory = await mkdtemp(path.join(work, 'recycle-helper-test-'));
const helper = path.join(directory, 'RecycleHelper.exe');
await copyFile(path.join(root, 'dist/native/windows/RecycleHelper.exe'), helper);
const bridge = path.join(directory, '.bridge');
await mkdir(bridge);
await writeFile(path.join(directory, 'bridge-location.json'), JSON.stringify({ directory: bridge }));
// Test-only capability for this unregistered, isolated helper copy.
const token = 'f'.repeat(64);
await writeFile(path.join(bridge, 'token.txt'), token);
const project = path.join(directory, '回收测试.prproj');
await writeFile(project, 'Synthetic fixture. Not a Premiere project.');
const registry = path.join(directory, '回收测试.voiceover-namer.json.recordings');
const media = path.join(directory, 'Adobe Premiere Pro Captured and Generated');
await mkdir(registry);
await mkdir(media);
const wav = Buffer.alloc(46);
wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24);
wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(2, 40);
const digest = createHash('sha256').update(wav).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = file => stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function fixture() {
  const recordingId = randomUUID().replaceAll('-', '');
  const target = path.join(media, `回收测试-${recordingId}.wav`);
  await writeFile(target, wav);
  const info = await stat(target);
  const recordPath = path.join(registry, recordingId + '.json');
  const record = { schemaVersion: 1, projectIdentity: project + '|test', projectPath: project,
    projectItemId: recordingId, recordingId, targetPath: target, size: info.size, birthtimeMs: Math.floor(info.birthtimeMs), sha256: digest,
    registeredAt: new Date().toISOString() };
  record.mac = Auth.sign(record, token);
  await writeFile(recordPath, JSON.stringify(record));
  const id = randomUUID().replaceAll('-', '');
  const prefix = path.join(bridge, id);
  const request = { version: 1, id, token, expiresAt: Date.now() + 20000, recordPath };
  return { id, prefix, record, recordPath, target, request };
}
function run(id) {
  const child = spawn(helper, ['hechao-voiceover-recycle://job/' + id], { windowsHide: true, stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('测试助手未按期退出')); }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
const checks = [];
async function rejectCase(name, edit, finalize) {
  const value = await fixture();
  await edit(value);
  await writeFile(value.prefix + '.request.json', JSON.stringify(value.request));
  const completion = run(value.id);
  if (finalize) {
    for (let n = 0; n < 100 && !(await exists(value.prefix + '.ready.json')); n++) await pause(50);
    assert.equal(await exists(value.prefix + '.ready.json'), true);
    await writeFile(value.recordPath + '.issued', JSON.stringify({ id: value.id }));
    await writeFile(value.prefix + '.commit.json', JSON.stringify({ id: value.id, token, at: Date.now() - 5000 }));
  }
  assert.notEqual(await completion, 0, name);
  assert.equal(await exists(value.target), true, `${name} 必须保留文件`);
  checks.push(name);
}
await rejectCase('无效助手凭据保留文件', async value => { value.request.token = '0'.repeat(64); });
await rejectCase('过期请求保留文件', async value => { value.request.expiresAt = Date.now() - 1; });
await rejectCase('缺失登记保留文件', async value => { value.request.recordPath += '.missing'; });
await rejectCase('内容变化保留文件', async value => { await writeFile(value.target, Buffer.alloc(wav.length, 1)); });
await rejectCase('伪造登记签名保留文件', async value => {
  value.record.mac = '0'.repeat(64);
  await writeFile(value.recordPath, JSON.stringify(value.record));
});
await rejectCase('非规范路径保留文件', async value => { value.request.recordPath = registry + '\\..\\' + path.basename(value.recordPath); });
await rejectCase('过期最终确认保留文件', async () => {}, true);
await rejectCase('缺少最终确认保留文件', async value => { value.request.expiresAt = Date.now() + 1500; });

const successful = await fixture();
await writeFile(successful.prefix + '.request.json', JSON.stringify(successful.request));
const completion = run(successful.id);
for (let n = 0; n < 100 && !(await exists(successful.prefix + '.ready.json')); n++) await pause(50);
assert.equal(await exists(successful.prefix + '.ready.json'), true);
assert.equal(await exists(successful.target), true, '准备阶段不能移动文件');
await writeFile(successful.recordPath + '.issued', JSON.stringify({ id: successful.id }));
await writeFile(successful.prefix + '.commit.json', JSON.stringify({ id: successful.id, token, at: Date.now() }));
const code = await completion;
const result = JSON.parse(await readFile(successful.prefix + '.result.json', 'utf8'));
assert.equal(code, 0, JSON.stringify(result));
assert.equal(result.status, 'recycled');
assert.equal(await exists(successful.target), false);
assert.notEqual(await run(successful.id), 0, '已执行请求不能重放');
checks.push('准备和最终确认闭环', '重复请求拒绝执行');

const quote = value => `'${value.replaceAll("'", "''")}'`;
const command = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$shell=New-Object -ComObject Shell.Application
$bin=$shell.Namespace(10)
$found=@($bin.Items() | Where-Object { $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq ${quote(media)} -and ($_.Name -eq ${quote(path.basename(successful.target))} -or $_.Name -eq ${quote(path.basename(successful.target, '.wav'))}) })
if($found.Count -ne 1){ throw '未能在系统回收站唯一找到合成测试录音' }
$stream=[IO.File]::OpenRead($found[0].Path)
$sha=[Security.Cryptography.SHA256]::Create()
try { $hash=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose(); $stream.Dispose() }
if($hash -ne ${quote(digest)}){ throw '回收站中录音内容校验不符' }
Write-Output '已在系统回收站核实唯一测试录音和 SHA-256；未修改其它回收项。'`;
const verified = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 20000 });
checks.push('Windows 系统回收站中原文件名、来源目录与 SHA-256 实证');
await writeFile(path.join(directory, '验证结果.json'), JSON.stringify({ checks, count: checks.length, testRecording: successful.target, recycled: true }, null, 2));
console.log(verified.stdout.trim());
console.log(`原生助手 ${checks.length} 项验证通过。证据：${directory}`);
