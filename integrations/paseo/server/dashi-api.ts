import type { Comment, Project, Task, TaskPriority, TaskStatus } from "../shared/contracts";
import { Buffer } from "node:buffer";

/**
 * Thin fetch wrapper around the dashi-taskboard local HTTP API
 * (`server/app.mjs` in the dashi-taskboard repository). This is the only
 * module that knows the API's URL scheme, headers, and error envelope.
 *
 * Service discovery is deliberately simple for this first version: an
 * explicit `DASHI_TASKBOARD_URL` override, or the documented default port.
 * There is no auto-launch; `checkConnection()` reports the exact command to
 * run when nothing answers.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:47823";
const REQUEST_TIMEOUT_MS = 5_000;

export const START_COMMAND_HINT =
  "在 dashi-taskboard 仓库根目录运行 `npm run dev:server`（或 `node server/index.mjs`）启动本地服务，" +
  "默认监听 http://127.0.0.1:47823。若使用其它端口/主机，请设置环境变量 DASHI_TASKBOARD_URL。";

export class DashiApiError extends Error {
  code: string;
  status: number;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "DashiApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class DashiConnectionError extends Error {
  baseUrl: string;

  constructor(baseUrl: string, cause: unknown) {
    super(`无法连接到 dashi-taskboard 服务（${baseUrl}）。${START_COMMAND_HINT}`);
    this.name = "DashiConnectionError";
    this.baseUrl = baseUrl;
    this.cause = cause;
  }
}

export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DASHI_TASKBOARD_URL;
  if (override && override.trim().length > 0) return override.trim().replace(/\/$/, "");
  return DEFAULT_BASE_URL;
}

export interface ActorIdentity {
  id: string;
  name: string;
}

/** Identity used for calls that originate from a human interacting with the plugin UI. */
export const PLUGIN_UI_ACTOR: ActorIdentity = { id: "paseo-plugin", name: "Paseo" };
/** Identity used when the plugin writes back on behalf of a Paseo agent's turn outcome. */
export const PLUGIN_AGENT_ACTOR: ActorIdentity = { id: "paseo-agent", name: "Paseo Agent" };

async function request<T>(
  baseUrl: string,
  method: string,
  path: string,
  options: { body?: unknown; actor?: ActorIdentity } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  const actor = options.actor ?? PLUGIN_UI_ACTOR;
  headers["x-taskboard-user-id"] = actor.id;
  headers["x-taskboard-user-name"] = encodeURIComponent(actor.name);
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { method, headers, body, signal: controller.signal });
  } catch (error) {
    throw new DashiConnectionError(baseUrl, error);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const errorBody = payload?.error;
    throw new DashiApiError(
      response.status,
      errorBody?.code ?? "UNKNOWN_ERROR",
      errorBody?.message ?? `dashi-taskboard 请求失败（HTTP ${response.status}）`,
      errorBody?.details,
    );
  }
  return payload as T;
}

export async function checkConnection(
  baseUrl: string,
): Promise<{ connected: boolean; error: string | null }> {
  try {
    await request(baseUrl, "GET", "/health");
    return { connected: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { connected: false, error: message };
  }
}

export function listProjects(baseUrl: string): Promise<{ projects: Project[] }> {
  return request(baseUrl, "GET", "/api/projects");
}

export interface ProjectReadme {
  projectId: string;
  content: string;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export function getProjectReadme(baseUrl: string, projectId: string): Promise<{ readme: ProjectReadme }> {
  return request(baseUrl, "GET", `/api/projects/${encodeURIComponent(projectId)}/readme`);
}

export function listTasks(
  baseUrl: string,
  filters: { projectId?: string; status?: TaskStatus; archived?: boolean },
): Promise<{ tasks: Task[] }> {
  const params = new URLSearchParams();
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.status) params.set("status", filters.status);
  if (filters.archived !== undefined) params.set("archived", String(filters.archived));
  const query = params.toString();
  return request(baseUrl, "GET", `/api/tasks${query ? `?${query}` : ""}`);
}

export function archiveTask(baseUrl: string, id: string, version: number): Promise<{ task: Task }> {
  return request(baseUrl, "POST", `/api/tasks/${encodeURIComponent(id)}/archive`, { body: { version } });
}

export function restoreTask(baseUrl: string, id: string, version: number): Promise<{ task: Task }> {
  return request(baseUrl, "POST", `/api/tasks/${encodeURIComponent(id)}/restore`, { body: { version } });
}

export function deleteArchivedTask(baseUrl: string, id: string, version: number): Promise<void> {
  return request(baseUrl, "DELETE", `/api/tasks/${encodeURIComponent(id)}`, { body: { version } });
}

const BRIDGE_ROUTES: Array<[string, RegExp]> = [
  ["GET", /^\/api\/(projects|meta|revisions|client-storage)$/],
  ["GET", /^\/api\/projects\/[^/?]+\/(readme|labels|development-contexts)$/],
  ["GET", /^\/api\/local\/jira-connection$/],
  ["GET", /^\/api\/local\/projects\/[^/?]+\/summary$/],
  ["POST", /^\/api\/(projects|tasks)$/],
  ["POST", /^\/api\/local\/jira-connection\/sync$/],
  ["PUT", /^\/api\/local\/jira-connection$/],
  ["GET", /^\/api\/tasks(?:\/[^/?]+(?:\/(comments|activities|attachments))?)?$/],
  ["GET", /^\/api\/attachments\/[^/?]+\/(content|download)$/],
  ["PUT", /^\/api\/projects\/[^/?]+\/readme$/],
  ["PATCH", /^\/api\/tasks\/[^/?]+$/],
  ["PATCH", /^\/api\/comments\/[^/?]+$/],
  ["DELETE", /^\/api\/projects\/[^/?]+$/],
  ["DELETE", /^\/api\/projects\/[^/?]+\/labels$/],
  ["DELETE", /^\/api\/tasks\/[^/?]+$/],
  ["DELETE", /^\/api\/tasks\/[^/?]+\/relations\/[^/?]+\/[^/?]+$/],
  ["DELETE", /^\/api\/comments\/[^/?]+$/],
  ["DELETE", /^\/api\/attachments\/[^/?]+$/],
  ["POST", /^\/api\/tasks\/[^/?]+\/(move|archive|restore|comments)$/],
  ["POST", /^\/api\/projects\/[^/?]+\/labels$/],
  ["POST", /^\/api\/tasks\/[^/?]+\/relations\/[^/?]+\/[^/?]+$/],
  ["POST", /^\/api\/(tasks|comments)\/[^/?]+\/attachments$/],
  ["POST", /^\/api\/projects\/[^/?]+\/readme\/attachments$/],
  ["PATCH", /^\/api\/client-storage$/],
];

/** srcDoc bridge endpoint whitelist, including the Dashi attachment byte stream. */
export async function bridgeRequest(baseUrl: string, input: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: { kind: "text" | "base64"; value: string } | null;
}): Promise<{
  status: number;
  headers: Record<string, string>;
  body: { kind: "json"; value: unknown } | { kind: "base64"; value: string };
}> {
  const url = new URL(input.path, "https://paseo-taskboard.invalid");
  if (!BRIDGE_ROUTES.some(([method, pattern]) => method === input.method && pattern.test(url.pathname))) {
    return {
      status: 403,
      headers: { "content-type": "application/json" },
      body: { kind: "json", value: { error: { code: "BRIDGE_ROUTE_DENIED", message: "Paseo bridge route is not allowed" } } },
    };
  }
  const headers = new Headers(input.headers);
  headers.set("x-taskboard-user-id", PLUGIN_UI_ACTOR.id);
  headers.set("x-taskboard-user-name", encodeURIComponent(PLUGIN_UI_ACTOR.name));
  const response = await fetch(`${baseUrl}${url.pathname}${url.search}`, {
    method: input.method,
    headers,
    body: input.body?.kind === "base64" ? Buffer.from(input.body.value, "base64") : input.body?.value,
  });
  const responseHeaders = Object.fromEntries(response.headers.entries());
  const binaryAttachment = response.ok && /^\/api\/attachments\/[^/?]+\/(content|download)$/.test(url.pathname);
  if (binaryAttachment) {
    return {
      status: response.status,
      headers: responseHeaders,
      body: { kind: "base64", value: Buffer.from(await response.arrayBuffer()).toString("base64") },
    };
  }
  const text = await response.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: { code: "INVALID_RESPONSE", message: text } }; }
  return { status: response.status, headers: responseHeaders, body: { kind: "json", value: body } };
}

export function getTask(baseUrl: string, id: string): Promise<{ task: Task }> {
  return request(baseUrl, "GET", `/api/tasks/${encodeURIComponent(id)}`);
}

export function createTask(
  baseUrl: string,
  input: {
    projectId?: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    labels?: string[];
    status?: TaskStatus;
  },
): Promise<{ task: Task }> {
  return request(baseUrl, "POST", "/api/tasks", { body: input });
}

export function updateTask(
  baseUrl: string,
  id: string,
  input: {
    version: number;
    title?: string;
    description?: string;
    priority?: TaskPriority;
    labels?: string[];
  },
): Promise<{ task: Task }> {
  return request(baseUrl, "PATCH", `/api/tasks/${encodeURIComponent(id)}`, { body: input });
}

export function moveTask(
  baseUrl: string,
  id: string,
  input: {
    version: number;
    status: TaskStatus;
    sortOrder?: number;
    threadId?: string;
    threadBinding?: unknown;
  },
  actor?: ActorIdentity,
): Promise<{ task: Task }> {
  return request(baseUrl, "POST", `/api/tasks/${encodeURIComponent(id)}/move`, { body: input, actor });
}

export function listComments(baseUrl: string, taskId: string): Promise<{ comments: Comment[] }> {
  return request(baseUrl, "GET", `/api/tasks/${encodeURIComponent(taskId)}/comments`);
}

export function addComment(
  baseUrl: string,
  taskId: string,
  body: string,
  actor?: ActorIdentity,
): Promise<{ comment: Comment }> {
  return request(baseUrl, "POST", `/api/tasks/${encodeURIComponent(taskId)}/comments`, {
    body: { body },
    actor,
  });
}
