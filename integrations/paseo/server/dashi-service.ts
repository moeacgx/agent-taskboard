import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_PORT = 47_823;
const HEALTH_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 20_000;
const MONITOR_INTERVAL_MS = 3_000;
const OUTPUT_TAIL_LIMIT = 8_192;

export interface DashiServiceStatus {
  baseUrl: string;
  dataDirectory: string;
  runtimeRoot: string | null;
  nodeExecutable: string | null;
  ownedPid: number | null;
  externalOverride: boolean;
  ready: boolean;
  lastError: string | null;
}

export interface DashiServiceManager {
  readonly baseUrl: string;
  start(): Promise<void>;
  ensureReady(): Promise<void>;
  status(): DashiServiceStatus;
  stop(): Promise<void>;
}

interface DashiServiceOptions {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
  runtimeRoot?: string;
  dataDirectory?: string;
  nodeExecutable?: string;
  healthTimeoutMs?: number;
  startTimeoutMs?: number;
  monitorIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/$/, "");
}

function managedBaseUrl(env: NodeJS.ProcessEnv): { baseUrl: string; externalOverride: boolean } {
  const override = env.DASHI_TASKBOARD_URL?.trim();
  if (override) return { baseUrl: trimTrailingSlash(override), externalOverride: true };
  const port = Number(env.CODEX_TASKBOARD_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CODEX_TASKBOARD_PORT 必须是 1 到 65535 之间的整数。");
  }
  return { baseUrl: `http://127.0.0.1:${port}`, externalOverride: false };
}

export function defaultDashiDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DASHI_TASKBOARD_DATA_DIR?.trim() || env.CODEX_TASKBOARD_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    return path.join(localAppData ? path.resolve(localAppData) : path.join(os.homedir(), "AppData", "Local"), "DashiPaseo");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "DashiPaseo");
  return path.join(env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share"), "DashiPaseo");
}

async function isFile(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function validRuntimeRoot(root: string): Promise<boolean> {
  return isFile(path.join(root, "server", "index.mjs"))
    .then(async (hasEntry) => hasEntry && await isFile(path.join(root, "shared", "domain.mjs")));
}

function ancestors(start: string, limit = 8): string[] {
  const values: string[] = [];
  let current = path.resolve(start);
  for (let index = 0; index < limit; index += 1) {
    values.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return values;
}

export async function resolveDashiRuntimeRoot(options: {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
  runtimeRoot?: string;
} = {}): Promise<string> {
  const env = options.env ?? process.env;
  const explicitCandidates = [options.runtimeRoot, env.DASHI_TASKBOARD_SOURCE_DIR?.trim()]
    .filter((value): value is string => Boolean(value));
  const moduleStarts: string[] = [];
  try {
    moduleStarts.push(path.dirname(fileURLToPath(options.moduleUrl ?? import.meta.url)));
  } catch {
    // 非 file: bundle 仍可通过 cwd 或显式环境变量定位。
  }
  const candidates: string[] = [...explicitCandidates];
  for (const start of moduleStarts) {
    for (const current of ancestors(start)) {
      candidates.push(current);
    }
  }
  for (const start of moduleStarts) {
    for (const current of ancestors(start)) candidates.push(path.join(current, "runtime"));
  }
  for (const current of ancestors(process.cwd())) candidates.push(current);
  for (const current of ancestors(process.cwd())) candidates.push(path.join(current, "runtime"));

  for (const candidate of [...new Set(candidates.map((value) => path.resolve(value)))]) {
    if (await validRuntimeRoot(candidate)) return candidate;
  }
  throw new Error(
    "未找到可启动的 Dashi 后端。源码安装需包含仓库 server/shared，独立插件安装需包含 runtime/server 与 runtime/shared；也可设置 DASHI_TASKBOARD_SOURCE_DIR。",
  );
}

function parseNodeVersion(value: string): [number, number] | null {
  const match = /^v?(\d+)\.(\d+)/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

async function validNodeExecutable(executable: string): Promise<boolean> {
  try {
    const result = await execFile(executable, ["--version"], { timeout: 3_000, windowsHide: true });
    const version = parseNodeVersion(result.stdout);
    return Boolean(version && (version[0] > 22 || (version[0] === 22 && version[1] >= 5)));
  } catch {
    return false;
  }
}

async function pathNodeCandidates(): Promise<string[]> {
  try {
    if (process.platform === "win32") {
      const result = await execFile("where.exe", ["node.exe"], { timeout: 3_000, windowsHide: true });
      return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    }
    const result = await execFile("which", ["node"], { timeout: 3_000 });
    return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function resolveNodeExecutable(options: {
  env?: NodeJS.ProcessEnv;
  executable?: string;
} = {}): Promise<string> {
  const env = options.env ?? process.env;
  const candidates = [
    options.executable,
    env.DASHI_TASKBOARD_NODE?.trim(),
    path.basename(process.execPath).toLowerCase() === (process.platform === "win32" ? "node.exe" : "node")
      ? process.execPath
      : undefined,
    ...await pathNodeCandidates(),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of [...new Set(candidates)]) {
    if (await validNodeExecutable(candidate)) return candidate;
  }
  throw new Error("未找到 Node.js 22.5 或更高版本。请安装 Node.js，或设置 DASHI_TASKBOARD_NODE 为 node 可执行文件绝对路径。");
}

function outputTail(previous: string, chunk: unknown): string {
  const value = `${previous}${String(chunk)}`;
  return value.length > OUTPUT_TAIL_LIMIT ? value.slice(-OUTPUT_TAIL_LIMIT) : value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export function createDashiServiceManager(options: DashiServiceOptions = {}): DashiServiceManager {
  const env = options.env ?? process.env;
  const { baseUrl, externalOverride } = managedBaseUrl(env);
  const dataDirectory = path.resolve(options.dataDirectory ?? defaultDashiDataDirectory(env));
  const healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const monitorIntervalMs = options.monitorIntervalMs ?? MONITOR_INTERVAL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let runtimeRoot: string | null = null;
  let nodeExecutable: string | null = null;
  let ownedChild: ChildProcess | null = null;
  let startPromise: Promise<void> | null = null;
  let monitor: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let ready = false;
  let lastError: string | null = null;
  let stdoutTail = "";
  let stderrTail = "";

  async function healthy(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), healthTimeoutMs);
    try {
      const healthResponse = await fetchImpl(`${baseUrl}/health`, { signal: controller.signal });
      if (!healthResponse.ok) return false;
      const health = await healthResponse.json() as { status?: unknown };
      if (health.status !== "ok") return false;
      const projectsResponse = await fetchImpl(`${baseUrl}/api/projects`, { signal: controller.signal });
      if (!projectsResponse.ok) return false;
      const projects = await projectsResponse.json() as { projects?: unknown };
      return Array.isArray(projects.projects);
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  function childFailureMessage(prefix: string): string {
    const detail = stderrTail.trim() || stdoutTail.trim();
    return detail ? `${prefix}\n${detail}` : prefix;
  }

  function watchChild(child: ChildProcess): void {
    child.stdout?.on("data", (chunk) => { stdoutTail = outputTail(stdoutTail, chunk); });
    child.stderr?.on("data", (chunk) => { stderrTail = outputTail(stderrTail, chunk); });
    child.once("error", (error) => {
      if (ownedChild === child) lastError = `Dashi 子进程启动失败：${error.message}`;
    });
    child.once("exit", (code, signal) => {
      if (ownedChild !== child) return;
      ownedChild = null;
      ready = false;
      if (!stopped) {
        lastError = childFailureMessage(`Dashi 子进程异常退出（code=${code ?? "null"}, signal=${signal ?? "null"}）。`);
      }
    });
  }

  async function waitUntilHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + startTimeoutMs;
    while (!stopped && Date.now() < deadline) {
      if (await healthy()) {
        ready = true;
        lastError = null;
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(childFailureMessage(`Dashi 子进程在健康检查前退出（code=${child.exitCode ?? "null"}）。`));
      }
      await delay(200);
    }
    throw new Error(childFailureMessage(`Dashi 在 ${Math.round(startTimeoutMs / 1_000)} 秒内未通过健康检查。`));
  }

  async function terminateOwnedChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    if (await waitForExit(child, 5_000)) return;
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }

  async function launch(): Promise<void> {
    if (stopped) throw new Error("Dashi 服务管理器已停止。");
    if (await healthy()) {
      ready = true;
      lastError = null;
      return;
    }
    ready = false;
    if (externalOverride) {
      throw new Error(`DASHI_TASKBOARD_URL 指向的外部服务未通过健康检查：${baseUrl}。插件不会自动启动或接管外部服务。`);
    }

    const previousChild = ownedChild;
    if (previousChild && previousChild.exitCode === null && previousChild.signalCode === null) {
      try {
        await waitUntilHealthy(previousChild);
        return;
      } catch {
        if (stopped) throw new Error("Dashi 服务管理器已停止。");
        await terminateOwnedChild(previousChild);
        if (ownedChild === previousChild) ownedChild = null;
      }
    }

    runtimeRoot = await resolveDashiRuntimeRoot({
      env,
      moduleUrl: options.moduleUrl,
      runtimeRoot: options.runtimeRoot,
    });
    if (stopped) throw new Error("Dashi 服务管理器已停止。");
    nodeExecutable = await resolveNodeExecutable({ env, executable: options.nodeExecutable });
    if (stopped) throw new Error("Dashi 服务管理器已停止。");
    const target = new URL(baseUrl);
    const childEnv = { ...env };
    delete childEnv.DASHI_TASKBOARD_URL;
    delete childEnv.CODEX_TASKBOARD_INSTANCE_TOKEN;
    delete childEnv.CODEX_TASKBOARD_INSTANCE_SECRET;
    delete childEnv.CODEX_TASKBOARD_LISTEN_FD;
    childEnv.CODEX_TASKBOARD_DATA_DIR = dataDirectory;
    childEnv.DASHI_TASKBOARD_DATA_DIR = dataDirectory;
    childEnv.CODEX_TASKBOARD_HOST = "127.0.0.1";
    childEnv.CODEX_TASKBOARD_PORT = target.port || String(DEFAULT_PORT);

    stdoutTail = "";
    stderrTail = "";
    const child = spawn(nodeExecutable, [path.join(runtimeRoot, "server", "index.mjs")], {
      cwd: runtimeRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    ownedChild = child;
    watchChild(child);
    try {
      await waitUntilHealthy(child);
    } catch (error) {
      if (ownedChild === child) {
        await terminateOwnedChild(child);
        if (ownedChild === child) ownedChild = null;
      }
      throw error;
    }
  }

  async function ensureReady(): Promise<void> {
    if (stopped) throw new Error("Dashi 服务管理器已停止。");
    if (ready && await healthy()) return;
    if (startPromise) return startPromise;
    startPromise = launch().catch((error) => {
      ready = false;
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  function scheduleMonitor(): void {
    if (externalOverride || monitor || stopped) return;
    monitor = setInterval(() => {
      if (stopped || startPromise) return;
      void ensureReady().catch((error) => {
        console.error("[dashi-taskboard] 自动恢复 Dashi 服务失败", error);
      });
    }, monitorIntervalMs);
    monitor.unref?.();
  }

  return {
    baseUrl,
    async start() {
      scheduleMonitor();
      await ensureReady();
    },
    ensureReady,
    status: () => ({
      baseUrl,
      dataDirectory,
      runtimeRoot,
      nodeExecutable,
      ownedPid: ownedChild?.pid ?? null,
      externalOverride,
      ready,
      lastError,
    }),
    async stop() {
      if (stopped) return;
      stopped = true;
      ready = false;
      if (monitor) clearInterval(monitor);
      monitor = null;
      await startPromise?.catch(() => undefined);
      const child = ownedChild;
      ownedChild = null;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      await terminateOwnedChild(child);
    },
  };
}
