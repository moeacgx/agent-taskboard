import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, stageRoot] = process.argv.slice(2);
if (!packageRoot || !stageRoot) throw new Error("Usage: node verify-runtime.mjs <package-root> <stage-root>");

const serviceModule = await import(pathToFileURL(path.join(packageRoot, "server", "dashi-service.ts")).href);
const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});
const waitFor = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition timed out");
};

const port = await reservePort();
const dataDirectory = path.join(stageRoot, "managed-data");
const env = {
  ...process.env,
  CODEX_TASKBOARD_PORT: String(port),
  DASHI_TASKBOARD_DATA_DIR: dataDirectory,
};
delete env.DASHI_TASKBOARD_URL;
const manager = serviceModule.createDashiServiceManager({
  env,
  moduleUrl: pathToFileURL(path.join(packageRoot, "index.server.ts")).href,
  nodeExecutable: process.execPath,
  monitorIntervalMs: 200,
  healthTimeoutMs: 1_000,
  startTimeoutMs: 15_000,
});

let externalServer;
try {
  await manager.start();
  const first = manager.status();
  assert.ok(first.ready);
  assert.ok(first.ownedPid);
  assert.equal(path.resolve(first.runtimeRoot), path.resolve(packageRoot, "runtime"));
  assert.equal(path.resolve(first.dataDirectory), path.resolve(dataDirectory));
  await access(path.join(packageRoot, "runtime", "server", "codex-slash-commands-0.139.0.json"));
  await access(path.join(packageRoot, "runtime", "skills", "manage-taskboard", "SKILL.md"));
  const projects = await (await fetch(`${manager.baseUrl}/api/projects`)).json();
  assert.ok(Array.isArray(projects.projects));
  const createResponse = await fetch(`${manager.baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "temp-cold-start", name: "Cold start package" }),
  });
  assert.equal(createResponse.status, 201);
  await access(path.join(dataDirectory, "taskboard.sqlite"));

  const firstPid = first.ownedPid;
  process.kill(firstPid);
  await waitFor(() => manager.status().ownedPid === null);
  await manager.ensureReady();
  const recovered = manager.status();
  assert.ok(recovered.ready);
  assert.ok(recovered.ownedPid);
  assert.notEqual(recovered.ownedPid, firstPid);
  assert.equal((await fetch(`${manager.baseUrl}/health`)).status, 200);
  await manager.stop();
  await waitFor(async () => {
    try {
      await fetch(`${manager.baseUrl}/health`);
      return false;
    } catch {
      return true;
    }
  });

  let validProjects = true;
  externalServer = createHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") return response.end(JSON.stringify({ status: "ok" }));
    if (request.url === "/api/projects") {
      return response.end(JSON.stringify(validProjects ? { projects: [] } : { service: "other" }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve, reject) => {
    externalServer.once("error", reject);
    externalServer.listen(0, "127.0.0.1", resolve);
  });
  const externalAddress = externalServer.address();
  const externalPort = typeof externalAddress === "object" && externalAddress ? externalAddress.port : 0;
  const externalUrl = `http://127.0.0.1:${externalPort}`;
  const external = serviceModule.createDashiServiceManager({
    env: { ...process.env, DASHI_TASKBOARD_URL: externalUrl },
    healthTimeoutMs: 1_000,
  });
  await external.start();
  assert.equal(external.status().ownedPid, null);
  assert.equal(external.status().externalOverride, true);
  await external.stop();
  assert.equal((await fetch(`${externalUrl}/health`)).status, 200);

  validProjects = false;
  const wrongService = serviceModule.createDashiServiceManager({
    env: { ...process.env, DASHI_TASKBOARD_URL: externalUrl },
    healthTimeoutMs: 1_000,
  });
  await assert.rejects(() => wrongService.start(), /外部服务未通过健康检查/);
  assert.equal(wrongService.status().ownedPid, null);
  await wrongService.stop();

  const expectedDefaultData = path.join("C:\\Users\\Example\\AppData\\Local", "DashiPaseo");
  assert.equal(
    serviceModule.defaultDashiDataDirectory({ LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local" }),
    expectedDefaultData,
  );

  console.log(JSON.stringify({
    packageRoot,
    runtimeRoot: first.runtimeRoot,
    dataDirectory,
    firstPid,
    recoveredPid: recovered.ownedPid,
    productionDependencies: ["smol-toml", "ws", "zod"],
    externalServicePreserved: true,
    wrongHealthRejected: true,
  }, null, 2));
} finally {
  await manager.stop();
  if (externalServer) {
    await new Promise((resolve) => externalServer.close(() => resolve()));
  }
}
