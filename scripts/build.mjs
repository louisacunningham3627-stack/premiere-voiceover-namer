import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginDirectory = path.join(projectRoot, "plugin");
const sourceDirectory = path.join(projectRoot, "src");
const distDirectory = path.resolve(projectRoot, "dist");

if (path.dirname(distDirectory) !== projectRoot || path.basename(distDirectory) !== "dist") {
  throw new Error(`Refusing to replace unexpected path: ${distDirectory}`);
}

await rm(distDirectory, { recursive: true, force: true });
await mkdir(path.join(distDirectory, "src"), { recursive: true });
await cp(pluginDirectory, distDirectory, { recursive: true });

for (const fileName of ["core.js", "state.js", "panel-state.js", "folder-readiness.js", "media-candidates.js", "monitoring-policy.js", "transaction.js", "coordination.js", "main.js"]) {
  await copyFile(path.join(sourceDirectory, fileName), path.join(distDirectory, "src", fileName));
}

console.log(`Built UXP plugin: ${distDirectory}`);
