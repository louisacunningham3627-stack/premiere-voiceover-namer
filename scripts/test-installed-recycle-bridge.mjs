import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, stat, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Auth from '../src/recycle-auth.js';

assert.equal(process.platform, 'win32', '安装后协议测试仅适用于 Windows');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const installed = path.join(process.env.APPDATA, 'Adobe/UXP/Plugins/External/com.hechao.premiere.voiceover-namer');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function inventory(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await inventory(path.join(dir, entry.name), prefix + entry.name + '/'));
    else { assert.ok(entry.isFile()); files.push(prefix + entry.name); }
  }
  return files;
}
const files = await inventory(path.join(root, 'dist'));
for (const file of files) {
  assert.equal(hash(await readFile(path.join(installed, file))), hash(await readFile(path.join(root, 'dist', file))), `安装文件校验失败：${file}`);
}
const location = JSON.parse(await readFile(path.join(installed, 'native/windows/bridge-location.json'), 'utf8'));
const bridge = location.directory;
assert.ok(!bridge.startsWith(installed + path.sep), '通信目录必须在插件代码目录之外');
const token = (await readFile(path.join(bridge, 'token.txt'), 'utf8')).trim();
assert.ok(/^[0-9a-f]{64}$/.test(token), '助手凭据无效');
await mkdir(path.join(root, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'work/installed-bridge-test-'));
const projectPath = path.join(directory, '协议验收.prproj');
await writeFile(projectPath, 'Synthetic protocol-test fixture. Do not open in Premiere.');
const media = path.join(directory, 'Adobe Premiere Pro Captured and Generated');
const registry = path.join(directory, '协议验收.voiceover-namer.json.recordings');
await mkdir(media);
await mkdir(registry);
const recordingId = randomUUID().replaceAll('-', '');
const targetPath = path.join(media, `协议验收-${recordingId}.wav`);
const wav = Buffer.alloc(46);
wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24);
wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(2, 40);
await writeFile(targetPath, wav);
const info = await stat(targetPath);
const record = { schemaVersion: 1, projectIdentity: projectPath + '|test', projectPath, projectItemId: recordingId,
  recordingId, targetPath, size: info.size, birthtimeMs: Math.floor(info.birthtimeMs), sha256: hash(wav), registeredAt: new Date().toISOString() };
record.mac = Auth.sign(record, token);
const recordPath = path.join(registry, recordingId + '.json');
await writeFile(recordPath, JSON.stringify(record));
const id = randomUUID().replaceAll('-', '');
const prefix = path.join(bridge, id);
await writeFile(prefix + '.request.json', JSON.stringify({ version: 1, id, token, recordPath, expiresAt: Date.now() + 25000 }), { flag: 'wx' });
const execute = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "''")}'`;
await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Start-Process -FilePath 'hechao-voiceover-recycle://job/${id}' -WindowStyle Hidden`], { windowsHide: true, timeout: 5000 });
async function waitFor(file) {
  for (let n = 0; n < 100; n++) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('安装后助手未按期响应；未确认成功，不能自动重试');
}
const ready = await waitFor(prefix + '.ready.json');
assert.ok(ready.id === id && ready.token === token, '准备响应身份不匹配');
assert.equal((await stat(targetPath)).size, wav.length, '准备阶段必须保留测试文件');
await writeFile(recordPath + '.issued', JSON.stringify({ id }), { flag: 'wx' });
await writeFile(prefix + '.commit.json', JSON.stringify({ id, token, at: Date.now() }), { flag: 'wx' });
const result = await waitFor(prefix + '.result.json');
assert.ok(result.id === id && result.token === token, '最终响应身份不匹配');
assert.equal(result.status, 'recycled', String(result.message || '系统回收失败'));
await assert.rejects(stat(targetPath), { code: 'ENOENT' });
const verify = `$ErrorActionPreference='Stop'
$shell=New-Object -ComObject Shell.Application
$found=@($shell.Namespace(10).Items() | Where-Object { $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq ${quote(media)} -and ($_.Name -eq ${quote(path.basename(targetPath))} -or $_.Name -eq ${quote(path.basename(targetPath, '.wav'))}) })
if($found.Count -ne 1){ throw 'Recycle Bin fixture not found uniquely' }
$stream=[IO.File]::OpenRead($found[0].Path)
$sha=[Security.Cryptography.SHA256]::Create()
try { $digest=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose(); $stream.Dispose() }
if($digest -ne ${quote(hash(wav))}){ throw 'Recycle Bin content hash mismatch' }`;
await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', verify], { windowsHide: true, timeout: 10000 });
const report = { installedVersion: JSON.parse(await readFile(path.join(installed, 'manifest.json'), 'utf8')).version,
  verifiedFiles: files.length, protocolLaunch: true, twoPhaseConfirmation: true, recycleBinHashVerified: true,
  source: targetPath, at: new Date().toISOString(), premiereInteractionTested: false };
await writeFile(path.join(directory, '验证结果.json'), JSON.stringify(report, null, 2));
console.log(`安装文件 ${files.length}/${files.length} 一致；已安装协议唤起、双阶段确认及系统回收站内容验证通过。`);
console.log(`仅回收 46 字节合成 WAV。证据：${directory}`);
