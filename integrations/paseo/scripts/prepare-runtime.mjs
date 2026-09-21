import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "..", "..");
const runtimeRoot = path.join(pluginRoot, "runtime");

await mkdir(path.join(runtimeRoot, "skills"), { recursive: true });
for (const directory of ["server", "shared"]) {
  await cp(path.join(repositoryRoot, directory), path.join(runtimeRoot, directory), {
    recursive: true,
    force: true,
    filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
  });
}
await cp(
  path.join(repositoryRoot, "skills", "manage-taskboard"),
  path.join(runtimeRoot, "skills", "manage-taskboard"),
  { recursive: true, force: true },
);

console.log(`Prepared standalone Dashi runtime at ${runtimeRoot}`);
