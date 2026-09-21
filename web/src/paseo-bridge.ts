import type { Task } from "./types";

/**
 * Desktop Paseo srcDoc bridge. It intercepts only same-frame /api requests;
 * the parent validates channel, nonce, source and the RPC allowlist before
 * forwarding anything to the local daemon.
 */
interface BridgeRequest {
  type: "paseo-taskboard:request";
  channel: string;
  nonce: string;
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: { kind: "text" | "base64"; value: string } | null;
}

interface BridgeResponse {
  type: "paseo-taskboard:response";
  channel: string;
  nonce: string;
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: { kind: "json"; value: unknown } | { kind: "base64"; value: string };
}

const MAX_BRIDGE_BINARY_BYTES = 25 * 1024 * 1024;

/** 父端只注入真实 Paseo 快照；iframe 不接触 daemon SDK。 */
export interface PaseoAgentProfile {
  id: string;
  name: string;
  /** Paseo profile registry key. It is never treated as a URL by the iframe. */
  icon?: string | null;
  provider: string;
  model: string | null;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export interface PaseoExistingAgent {
  id: string;
  workspaceId: string | null;
  workspaceName: string | null;
  cwd: string;
  title: string | null;
  provider: string;
  model: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
  assignedTaskIdentifier?: string | null;
}

export interface PaseoWorkspaceChoice {
  id: string;
  name: string | null;
  path: string | null;
  projectWorkspace: boolean;
  kind: "project" | "workspace";
}

/** 从 Paseo provider 快照过滤出的可用提供方，不包含禁用或不可用项。 */
export interface PaseoProviderChoice {
  id: string;
  label: string;
  /** Server-sanitized inline SVG data URL. */
  iconDataUrl: string | null;
}

export interface PaseoAssignmentOptions {
  agents: PaseoExistingAgent[];
  workspaces: PaseoWorkspaceChoice[];
  profiles: PaseoAgentProfile[];
  providers: PaseoProviderChoice[];
  /** SDK `listModels` 返回的真实可选模型，保存时会按最终工作区补全 feature 默认值。 */
  models: PaseoAgentProfile[];
  defaultWorkspacePath: string | null;
}

export interface PaseoConfigurationChoice {
  id: string;
  label: string;
  description?: string;
}

export interface PaseoConfigurationOptions {
  provider: string;
  model: string;
  modes: PaseoConfigurationChoice[];
  thinkingOptions: PaseoConfigurationChoice[];
  defaultModeId?: string;
  defaultThinkingOptionId?: string;
  currentModeId?: string;
  currentThinkingOptionId?: string;
  editable: boolean;
}

export interface PaseoConfigurationOptionsRequest {
  provider: string;
  model: string;
  workspacePath?: string | null;
  agentId?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export interface PaseoMergeIdeasRequest {
  requestId: string;
  operationId: string;
  projectId: string;
  sourceTaskIds: string[];
  title: string;
  description?: string;
  workspacePath: string;
  profile: PaseoAgentProfile;
}

export interface PaseoMergeIdeasResult {
  task: Task;
  assignment: Extract<PaseoTaskAssignment, { kind: "planned" }>;
  sourceTaskIds: string[];
  replayed: boolean;
}

export type PaseoCopyRequest =
  | { requestId: string; kind: "text"; text: string }
  | { requestId: string; kind: "issue-link"; projectId: string; identifier: string };

export interface PaseoCopyResponse {
  requestId: string;
  copiedText?: string;
  error?: string;
}

/** Paseo daemon 的 Git 根/分支/Worktree 扫描结果。 */
export interface PaseoWorktreeScan {
  workspacePath: string;
  gitRoot: string | null;
  isGitRoot: boolean;
  head: string | null;
  branches: string[];
  worktrees: Array<{ path: string; branch: string | null }>;
  error: string | null;
}

export interface PaseoCreatedWorktree {
  context: { type: "worktree"; path: string; branch: string };
  workspace: { id: string; path: string; branch: string };
  scan: PaseoWorktreeScan;
}

export type PaseoAutomationIntervalMinutes = 5 | 10 | 15 | 30 | 60;

/** Paseo daemon 持久化的项目自动认领状态；不依赖 Codex 项目身份。 */
export interface PaseoAutomationState {
  projectId: string;
  workspacePath: string | null;
  profile: PaseoAgentProfile | null;
  enabledByUser: boolean;
  intervalMinutes: PaseoAutomationIntervalMinutes;
  quotaAware: boolean;
  status: "ACTIVE" | "PAUSED";
  schedulerReady: boolean;
  quotaAvailable: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}

type PaseoWorktreeOperation = "inspect" | "create";
type PaseoWorktreePayload =
  | { workspacePath: string }
  | { workspacePath: string; branch: string; branchMode: "existing" | "new"; taskId?: string };

export type PaseoTaskAssignment =
  | {
      kind: "existing";
      taskId: string;
      agentId: string;
      workspaceId: string;
      workspaceName: string | null;
      workspacePath: string | null;
      provider: string;
      model: string | null;
      title: string | null;
      status: "initializing" | "idle" | "running" | "error" | "closed" | "unavailable";
    }
  | {
      kind: "planned";
      taskId: string;
      workspacePath: string | null;
      profile: PaseoAgentProfile | null;
    };

function paseoBridgeConfig(): { channel: string; nonce: string } | null {
  const query = new URL(document.baseURI).searchParams;
  if (query.get("host") !== "paseo") return null;
  const channel = query.get("channel") ?? "";
  const nonce = query.get("nonce") ?? "";
  return channel && nonce ? { channel, nonce } : null;
}

/** 沙箱 iframe 不能直接打开新窗口；由父页面校验 GitHub 仓库 URL 后再打开。 */
export function openPaseoExternalUrl(url: string): void {
  const config = paseoBridgeConfig();
  if (!config || window.parent === window) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  window.parent.postMessage({
    type: "taskboard:paseo-open-url",
    challenge: config.nonce,
    payload: { url },
  }, "*");
}

/** 供原版 DOM 使用的 Paseo 专用 RPC；不会退回到客户端 git 或 localhost。 */
export function requestPaseoWorktree<T>(
  operation: PaseoWorktreeOperation,
  payload: PaseoWorktreePayload,
): Promise<T> {
  const config = paseoBridgeConfig();
  if (!config || window.parent === window) {
    return Promise.reject(new Error("当前界面未连接 Paseo Worktree 服务。"));
  }
  const { nonce } = config;
  const requestId = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("Paseo Worktree 请求超时，请刷新后重试。"));
    }, 60_000);
    function receive(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as {
        type?: unknown;
        challenge?: unknown;
        payload?: { requestId?: unknown; ok?: unknown; value?: unknown; error?: unknown };
      };
      if (
        message.type !== "taskboard:paseo-worktree-response"
        || message.challenge !== nonce
        || message.payload?.requestId !== requestId
      ) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
      if (message.payload.ok === true) resolve(message.payload.value as T);
      else reject(new Error(typeof message.payload.error === "string" ? message.payload.error : "Paseo Worktree 请求失败。"));
    }
    window.addEventListener("message", receive);
    window.parent.postMessage({
      type: "taskboard:paseo-worktree-request",
      challenge: nonce,
      payload: { requestId, operation, ...payload },
    }, "*");
  });
}

function base64FromBytes(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function arrayBufferFromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function bridgeBody(body: BodyInit | null | undefined): Promise<BridgeRequest["body"]> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string" || body instanceof URLSearchParams) {
    return { kind: "text", value: body.toString() };
  }
  if (body instanceof FormData) {
    throw new TypeError("Paseo Taskboard bridge does not accept multipart form data.");
  }
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  if (bytes.byteLength > MAX_BRIDGE_BINARY_BYTES) {
    throw new TypeError("Taskboard attachment cannot exceed 25 MiB.");
  }
  return { kind: "base64", value: base64FromBytes(bytes) };
}

export function installPaseoFetchBridge(): void {
  const config = paseoBridgeConfig();
  if (!config || window.parent === window) return;
  const { channel, nonce } = config;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), document.baseURI);
    if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const body = await bridgeBody(init?.body ?? (request ? await request.clone().blob() : null));
    const requestId = crypto.randomUUID();
    return await new Promise<Response>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(new TypeError("Paseo taskboard bridge timed out"));
      }, 20_000);
      function receive(event: MessageEvent) {
        if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
        const message = event.data as Partial<BridgeResponse>;
        if (message.type !== "paseo-taskboard:response" || message.channel !== channel || message.nonce !== nonce || message.requestId !== requestId) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", receive);
        const status = message.status ?? 500;
        const headers = new Headers(message.headers ?? {});
        const body = status === 204 || status === 205
          ? null
          : message.body?.kind === "base64"
            ? arrayBufferFromBase64(message.body.value)
            : message.body === undefined
              ? null
              : JSON.stringify(message.body.value);
        if (message.body?.kind === "json" && !headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
        resolve(new Response(body, {
          status,
          headers,
        }));
      }
      window.addEventListener("message", receive);
      const message: BridgeRequest = {
        type: "paseo-taskboard:request",
        channel,
        nonce,
        requestId,
        method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(headers.entries()),
        body,
      };
      window.parent.postMessage(message, "*");
    });
  };
}
