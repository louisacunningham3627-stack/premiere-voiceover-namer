import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version;
const outputRoot = path.resolve(process.env.MACOS_OUTPUT_DIR || path.join(projectRoot, "outputs", "macos"));
const packageName = `premiere-voiceover-namer-${version}-macos`;
const packageDirectory = path.join(outputRoot, packageName);
const zipPath = path.join(outputRoot, `${packageName}.zip`);
const zipShaPath = `${zipPath}.sha256`;

async function digest(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
async function exists(filePath) {
  return Boolean(await stat(filePath).catch(() => null));
}
async function filesUnder(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
    else assert.fail(`macOS 包只允许普通文件和目录：${absolute}`);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}
async function verifyChecksumFile(root) {
  const checksumText = await readFile(path.join(root, "SHA256SUMS.txt"), "utf8");
  const lines = checksumText.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 10, `${root} 的 SHA256 清单数量异常`);
  const listedPaths = [];
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/i);
    assert.ok(match, `无效 SHA256 行：${line}`);
    const relative = match[2].replaceAll("/", path.sep);
    assert.equal(relative.split(path.sep).some((part) => part === "." || part === "..") || path.isAbsolute(relative), false, `SHA256 路径越界：${relative}`);
    assert.equal(await digest(path.join(root, relative)), match[1].toLowerCase(), `文件校验失败：${relative}`);
    listedPaths.push(match[2]);
  }
  const actualPaths = (await filesUnder(root)).filter((relative) => relative !== "SHA256SUMS.txt");
  assert.deepEqual(listedPaths.slice().sort((left, right) => left.localeCompare(right, "en")), actualPaths, `${root} 的 SHA256 清单未覆盖全部普通文件`);
  return { text: checksumText, count: lines.length };
}

const expectedEntries = ["plugin", "安装-macOS.sh", "卸载-macOS.sh", "使用说明.md", "SHA256SUMS.txt"];
assert.deepEqual((await readdir(packageDirectory)).sort(), expectedEntries.sort(), "macOS 包结构不完整或混入了额外文件");
assert.equal(await exists(path.join(packageDirectory, "plugin", "manifest.json")), true, "macOS 包缺少 plugin/manifest.json");
assert.equal(await exists(path.join(packageDirectory, "使用说明.md")), true, "macOS 包缺少中文说明");
assert.equal(await exists(path.join(packageDirectory, "SHA256SUMS.txt")), true, "macOS 包缺少 SHA256 清单");
assert.equal(await exists(zipPath), true, "macOS zip 缺失");
assert.equal(await exists(zipShaPath), true, "macOS zip SHA256 清单缺失");

const manifest = JSON.parse(await readFile(path.join(packageDirectory, "plugin", "manifest.json"), "utf8"));
assert.equal(manifest.id, "com.hechao.premiere.voiceover-namer");
assert.equal(manifest.version, version);
const checksums = await verifyChecksumFile(packageDirectory);
const zipShaLine = (await readFile(zipShaPath, "utf8")).trim();
const zipMatch = zipShaLine.match(/^([0-9a-f]{64})  (.+)$/i);
assert.ok(zipMatch, "zip SHA256 清单格式错误");
assert.equal(zipMatch[2], path.basename(zipPath));
assert.equal(await digest(zipPath), zipMatch[1].toLowerCase(), "zip SHA256 校验失败");
const extractionRoot = await mkdtemp(path.join(outputRoot, ".verify-"));
try {
  if (process.platform === "darwin") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("ditto", ["-x", "-k", zipPath, extractionRoot]);
  } else if (process.platform === "win32") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const command = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(extractionRoot)} -Force`;
    await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
  } else {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("unzip", ["-q", "-o", zipPath, "-d", extractionRoot]);
  }
  const extractedPackage = path.join(extractionRoot, packageName);
  assert.deepEqual((await readdir(extractedPackage)).sort(), expectedEntries.sort(), "zip 解压后的 macOS 包结构不完整");
  const extractedChecksums = await verifyChecksumFile(extractedPackage);
  assert.equal(extractedChecksums.text, checksums.text, "zip 内 SHA256 清单与目录不一致");
  const extractedManifest = JSON.parse(await readFile(path.join(extractedPackage, "plugin", "manifest.json"), "utf8"));
  assert.deepEqual(extractedManifest, manifest, "zip 内 manifest 与目录不一致");
} finally {
  await rm(extractionRoot, { recursive: true, force: true });
}
console.log(`已验证 macOS 包：${packageDirectory}`);
console.log(`已验证文件清单：${checksums.count} 项（目录与 zip 解压内容逐项重算）；zip SHA-256：${zipMatch[1].toLowerCase()}`);
