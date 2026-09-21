import { access, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const EXPECTED_PACKAGE_NAME = "dashi-taskboard-paseo-plugin";
const installationRoot = await realpath(process.cwd());
const packageJsonPath = path.join(installationRoot, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
if (packageJson.name !== EXPECTED_PACKAGE_NAME) {
  throw new Error(`安装准备目录不是 ${EXPECTED_PACKAGE_NAME}：${installationRoot}`);
}
if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
  throw new Error("插件 package.json 缺少有效版本号。");
}

const runtimeRoot = path.join(installationRoot, "runtime");
await Promise.all([
  access(path.join(runtimeRoot, "server", "index.mjs")),
  access(path.join(runtimeRoot, "shared", "domain.mjs")),
]);

const generated = [
  "// 由 scripts/prepare-installation.mjs 在 Paseo 安装目录生成。",
  `export const PLUGIN_INSTALLATION_ROOT = ${JSON.stringify(installationRoot)};`,
  `export const PLUGIN_RUNTIME_ROOT = ${JSON.stringify(runtimeRoot)};`,
  `export const PLUGIN_PACKAGE_VERSION = ${JSON.stringify(packageJson.version.trim())};`,
  "",
].join("\n");
await writeFile(path.join(installationRoot, "server", "plugin-installation.generated.ts"), generated, "utf8");
console.log(`Prepared Paseo plugin installation metadata for ${installationRoot}`);
