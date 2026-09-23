import { createElement, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText as copyTextToClipboard } from "@getpaseo/plugin/client/react-native";

import * as contracts from "../shared/contracts";
import type { Task } from "../shared/contracts";
import { ORIGINAL_APP_SRCDOC_TEMPLATE } from "./original-app.generated";
import { BOARD_COLUMN_LABELS, BOARD_COLUMNS, boardColumnForStatus } from "./board";
import { PRIORITY_LABELS } from "./format";
import type { PluginLayout } from "./types";
import type { BoardTaskAction } from "./TaskList";

declare const window: {
  location: { href: string };
  open(url: string, target?: string, features?: string): unknown;
  addEventListener(type: "message", listener: (event: any) => void): void;
  removeEventListener(type: "message", listener: (event: any) => void): void;
};

const PRIVATE_ROUTE_PARAMS = ["channel", "nonce", "token", "access_token", "challenge"] as const;

function readHostIssueRoute(): { projectId: string | null; issueIdentifier: string | null } {
  try {
    const url = new URL(window.location.href);
    return {
      projectId: url.searchParams.get("project")?.trim() || null,
      issueIdentifier: url.searchParams.get("issue")?.trim().toUpperCase() || null,
    };
  } catch {
    return { projectId: null, issueIdentifier: null };
  }
}

function buildHostIssueLink(projectId: string, identifier: string): string {
  const url = new URL(window.location.href);
  if (url.protocol === "about:" || url.hostname === "paseo-taskboard.invalid") {
    throw new Error("当前 Paseo 宿主没有可重新打开的页面链接。");
  }
  url.username = "";
  url.password = "";
  for (const key of PRIVATE_ROUTE_PARAMS) url.searchParams.delete(key);
  url.searchParams.set("project", projectId);
  url.searchParams.set("issue", identifier.toUpperCase());
  return url.toString();
}

/** 为 srcDoc 会话生成不可预测的消息通道和挑战值。 */
function secureFrameToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Paseo 0.8 的 PluginTheme 未暴露 appearance，只能从表面色推断明暗。 */
function isAllowedPluginReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && (url.pathname === "/moeacgx/agent-taskboard" || url.pathname.startsWith("/moeacgx/agent-taskboard/"));
  } catch {
    return false;
  }
}

function originalAppTheme(surface: string): "light" | "dark" {
  const hex = surface.trim().replace(/^#/, "");
  if (!/^[\da-f]{3}(?:[\da-f]{3})?$/i.test(hex)) return "light";
  const expanded = hex.length === 3 ? hex.split("").map((part) => `${part}${part}`).join("") : hex;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722 < 128 ? "dark" : "light";
}

interface WebBoardProps {
  theme: PluginTheme;
  layout: PluginLayout;
  tasks: Task[];
  movingId: string | null;
  onSelectTask: (id: string) => void;
  onDrop: (task: Task, column: (typeof BOARD_COLUMNS)[number], index: number) => void;
  onRetry: (task: Task) => void;
  onAction: (task: Task, action: BoardTaskAction) => void;
  onCreateTask?: (status: "todo") => void;
}

export function WebBoard(props: WebBoardProps) {
  if (Platform.OS !== "web") return null;
  const { theme, layout, tasks, movingId, onSelectTask, onDrop, onRetry, onAction } = props;
  const h = createElement as any;
  const muted = theme.colors.foregroundMuted;
  const columnAccents: Record<(typeof BOARD_COLUMNS)[number], string> = { ideas: "#8b5cf6", processing: "#22a06b", review: "#3b82f6" };
  let draggedId: string | null = null;
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  const getDropIndex = (event: any, columnTasks: Task[], sourceTaskId: string | null) => {
    const cards: any[] = (Array.from(event.currentTarget.querySelectorAll?.("[data-board-task-id]") ?? []) as any[])
      .filter((card: any) => card.getAttribute?.("data-board-task-id") !== sourceTaskId);
    for (let index = 0; index < cards.length; index += 1) {
      const rect = cards[index].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) return index;
    }
    return columnTasks.length;
  };
  const columns = BOARD_COLUMNS.map((column) => {
    const columnTasks = tasks.filter((task) => boardColumnForStatus(task.status) === column);
    const cards = columnTasks.map((task) => {
      const labels = task.labels.slice(0, 3).map((label) => h("span", { key: label, style: { padding: "2px 6px", borderRadius: 999, background: theme.colors.surface2 } }, label));
      const properties = h("div", { style: { display: "flex", gap: 5, flexWrap: "wrap", color: theme.colors.foregroundMuted, fontSize: 11 } },
        h("span", null, PRIORITY_LABELS[task.priority]),
        ...labels,
        task.status === "in_progress" ? h("span", { key: "running", "aria-label": "Agent 运行中" }, "● 运行中") : null,
      );
      const open = h("button", {
        type: "button",
        "aria-label": `打开 ${task.identifier}: ${task.title}`,
        "data-testid": `open-task-${task.id}`,
        onClick: (event: any) => { event.stopPropagation(); onSelectTask(task.id); },
        style: { all: "unset", display: "block", width: "100%", cursor: "inherit" },
      }, h("div", { style: { color: theme.colors.foregroundMuted, fontSize: 11, marginBottom: 6 } }, `ID: ${task.identifier}`), h("h3", { style: { color: theme.colors.foreground, fontSize: 14, margin: "0 0 8px", fontWeight: 650 } }, task.title), properties);
      const retry = task.status === "blocked" ? h("button", {
        type: "button",
        "aria-label": `重试 ${task.identifier}`,
        "data-testid": `retry-task-${task.id}`,
        onClick: (event: any) => { event.stopPropagation(); onRetry(task); },
        style: { marginTop: 8, border: 0, background: "transparent", color: theme.colors.accent, padding: 0, cursor: "pointer" },
      }, "重试 Agent") : null;
      const menu = menuTaskId === task.id ? h("div", { role: "menu", style: { position: "absolute", right: 8, top: 42, zIndex: 2, display: "flex", flexDirection: "column", gap: 4, padding: 8, borderRadius: 7, background: theme.colors.surface1, border: `1px solid ${theme.colors.border}`, boxShadow: "0 8px 24px rgba(15, 23, 42, .18)" } },
        h("button", { type: "button", role: "menuitem", onClick: (event: any) => { event.stopPropagation(); onAction(task, { kind: "open" }); } }, "打开详情"),
        h("button", { type: "button", role: "menuitem", onClick: (event: any) => { event.stopPropagation(); onAction(task, { kind: "move", status: "todo" }); } }, "移动到等待认领"),
        h("button", { type: "button", role: "menuitem", onClick: (event: any) => { event.stopPropagation(); onAction(task, { kind: "move", status: "in_progress" }); } }, "移动到处理中"),
        h("button", { type: "button", role: "menuitem", onClick: (event: any) => { event.stopPropagation(); onAction(task, { kind: "move", status: "in_review" }); } }, "移动到等你确认"),
        h("button", { type: "button", role: "menuitem", onClick: (event: any) => { event.stopPropagation(); onAction(task, { kind: "move", status: "done" }); } }, "标记完成"),
        h("button", { type: "button", role: "menuitem", onClick: (event: any) => { event.stopPropagation(); onAction(task, { kind: "archive" }); } }, "归档"),
        boardColumnForStatus(task.status) === "ideas" ? h("button", { type: "button", role: "menuitem", onClick: (event: any) => { event.stopPropagation(); onAction(task, { kind: "delete" }); } }, "删除") : null,
      ) : null;
      const menuButton = h("button", { type: "button", "aria-label": `打开 ${task.identifier} 操作菜单`, "data-testid": `task-menu-${task.id}`, onClick: (event: any) => { event.stopPropagation(); setMenuTaskId(menuTaskId === task.id ? null : task.id); }, style: { position: "absolute", top: 8, right: 8, border: 0, background: "transparent", color: muted, fontSize: 18, cursor: "pointer" } }, "…");
      return h("article", {
        key: task.id,
        "data-board-task-id": task.id,
        "data-testid": `task-card-${task.id}`,
        draggable: movingId !== task.id,
        onDragStart: (event: any) => { draggedId = task.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-taskboard-task", task.id); event.dataTransfer.setData("text/plain", task.id); },
        onDragEnd: () => { draggedId = null; },
        onClick: () => onSelectTask(task.id),
        onContextMenu: (event: any) => { event.preventDefault(); setMenuTaskId(task.id); },
        style: { position: "relative", padding: 12, borderRadius: 8, background: theme.colors.surface1, border: `1px solid ${theme.colors.border}`, boxShadow: "0 1px 2px rgba(15, 23, 42, .06)", cursor: movingId === task.id ? "wait" : "grab" },
      }, open, retry, menuButton, menu);
    });
    if (columnTasks.length === 0) cards.push(h("div", { key: "empty", style: { color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center", padding: 28 } }, "拖到此处"));
    return h("section", {
      key: column,
      "data-testid": `board-column-${column}`,
      "aria-label": BOARD_COLUMN_LABELS[column],
      onDragOver: (event: any) => event.preventDefault(),
      onDrop: (event: any) => { event.preventDefault(); const sourceTaskId = draggedId ?? event.dataTransfer?.getData("application/x-taskboard-task") ?? null; const task = tasks.find((item) => item.id === sourceTaskId); if (task) onDrop(task, column, getDropIndex(event, columnTasks, sourceTaskId)); draggedId = null; },
      style: { flex: "1 0 280px", minWidth: 280, maxWidth: 520, background: theme.colors.surface2, borderRadius: 9, padding: 8 },
    }, h("header", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderRadius: 7, background: `color-mix(in srgb, ${columnAccents[column]} 14%, ${theme.colors.surface1})`, border: `1px solid ${theme.colors.border}`, borderLeft: `4px solid ${columnAccents[column]}`, color: columnAccents[column] } }, h("strong", null, BOARD_COLUMN_LABELS[column]), h("span", { "aria-label": `${columnTasks.length} 个任务`, style: { color: theme.colors.foregroundMuted } }, columnTasks.length), column === "ideas" && props.onCreateTask ? h("button", { type: "button", "aria-label": "在等待认领中新建任务", "data-testid": "create-task-ideas", onClick: (event: any) => { event.stopPropagation(); props.onCreateTask?.("todo"); }, style: { border: 0, background: "transparent", color: columnAccents[column], fontSize: 18, lineHeight: 1, cursor: "pointer" } }, "+") : null), h("div", { style: { display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, minHeight: 160 } }, ...cards));
  });
  return h("div", { "data-testid": "web-board", "aria-label": "三列任务看板", style: { display: "flex", flexDirection: "row", gap: 14, overflowX: "auto", padding: layout.compact ? 10 : 16, background: theme.colors.surface0, flex: 1 } }, ...columns);
}

/** Desktop-only original DOM application, isolated from Paseo by srcDoc RPC. */
export function OriginalTaskboardFrame(props: { theme: PluginTheme; layout: PluginLayout; navigation: import("./types").PluginNavigation }) {
  if (Platform.OS !== "web") return null;
  const bridgeRequest = useRpc(contracts.bridgeRequest);
  const getTask = useRpc(contracts.getTask);
  const moveTaskBoard = useRpc(contracts.moveTaskBoard);
  const getBinding = useRpc(contracts.getBinding);
  const getPaseoPresentations = useRpc(contracts.getPaseoPresentations);
  const listPaseoAssignmentOptions = useRpc(contracts.listPaseoAssignmentOptions);
  const getPaseoConfigurationOptions = useRpc(contracts.getPaseoConfigurationOptions);
  const listBindings = useRpc(contracts.listBindings);
  const bindExistingPaseoAgent = useRpc(contracts.bindExistingPaseoAgent);
  const saveTaskExecutionPlan = useRpc(contracts.saveTaskExecutionPlan);
  const mergePaseoIdeas = useRpc(contracts.mergePaseoIdeas);
  const getPaseoTaskAssignments = useRpc(contracts.getPaseoTaskAssignments);
  const clearPaseoTaskAssignment = useRpc(contracts.clearPaseoTaskAssignment);
  const inspectPaseoWorktree = useRpc(contracts.inspectPaseoWorktree);
  const createPaseoWorktree = useRpc(contracts.createPaseoWorktree);
  const getPaseoAutomation = useRpc(contracts.getPaseoAutomation);
  const savePaseoAutomation = useRpc(contracts.savePaseoAutomation);
  const savePaseoProjectDefaults = useRpc(contracts.savePaseoProjectDefaults);
  const frameRef = useRef<any>(null);
  const startingTaskIds = useRef(new Set<string>());
  const presentationRequestSequence = useRef(0);
  const [channel] = useState(() => `paseo-${secureFrameToken()}`);
  const [nonce] = useState(secureFrameToken);
  const hostTheme = originalAppTheme(props.theme.colors.surface0);
  const source = ORIGINAL_APP_SRCDOC_TEMPLATE
    .replaceAll("__PASEO_CHANNEL__", encodeURIComponent(channel))
    .replaceAll("__PASEO_NONCE__", encodeURIComponent(nonce));

  useEffect(() => {
    function post(message: Record<string, unknown>) {
      frameRef.current?.contentWindow?.postMessage({ ...message, challenge: nonce }, "*");
    }
    function sendHostContext() {
      post({
        type: "taskboard:host-context",
        payload: {
          user: { type: "user", id: "paseo-plugin", name: "Paseo", avatarUrl: null },
          theme: hostTheme,
          language: "zh-CN",
          projectId: null,
          projects: [],
          route: readHostIssueRoute(),
        },
      });
    }
    async function startBoundTask(taskId: string) {
      if (startingTaskIds.current.has(taskId)) return;
      startingTaskIds.current.add(taskId);
      try {
        const { task } = await getTask({ id: taskId });
        const result = task.status === "in_progress"
          ? { task, dispatch: "skipped" as const, dispatchMessage: null }
          : await moveTaskBoard({ id: task.id, version: task.version, status: "in_progress" });
        if (result.dispatch === "needs_configuration" || result.dispatch === "failed") {
          throw new Error(result.dispatchMessage ?? "无法启动此任务的 Paseo Agent。");
        }
        const { binding } = await getBinding({ taskId });
        if (!binding) throw new Error(result.dispatchMessage ?? "任务尚未绑定 Paseo Agent。");
        const navigation = props.navigation;
        if (!navigation?.openAgent) throw new Error("当前 Paseo 客户端无法打开 Agent 会话。");
        navigation.openAgent({ agentId: binding.agentId });
        post({ type: "taskboard:thread-prepared", payload: { taskId, agentId: binding.agentId } });
      } catch (error) {
        post({
          type: "taskboard:thread-create-error",
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        startingTaskIds.current.delete(taskId);
      }
    }
    async function moveTaskThroughBoard(message: Record<string, unknown>) {
      const requestId = message.requestId as string;
      try {
        const path = (message.path as string).split("?", 1)[0];
        const parts = path.split("/");
        const taskId = parts[1] === "api" && parts[2] === "tasks"
          && ((parts.length === 5 && parts[4] === "move") || parts.length === 4)
          ? decodeURIComponent(parts[3])
          : null;
        const rawBody = message.body as { kind?: unknown; value?: unknown } | null;
        if (!taskId || rawBody?.kind !== "text" || typeof rawBody.value !== "string") {
          throw new Error("无效的任务看板移动请求。");
        }
        const input = JSON.parse(rawBody.value) as { version?: unknown; status?: unknown; sortOrder?: unknown };
        if (typeof input.version !== "number" || typeof input.status !== "string" || (input.sortOrder !== undefined && typeof input.sortOrder !== "number")) {
          throw new Error("任务看板移动参数无效。");
        }
        const result = await moveTaskBoard({
          id: taskId,
          version: input.version,
          status: input.status as Task["status"],
          sortOrder: input.sortOrder,
        });
        if (result.dispatch === "needs_configuration") {
          post({
            type: "paseo-taskboard:response",
            channel,
            nonce,
            requestId,
            status: 409,
            headers: { "content-type": "application/json" },
            body: { kind: "json", value: { error: { code: "TASK_DISPATCH_NEEDS_CONFIGURATION", message: result.dispatchMessage } } },
          });
          return;
        }
        // `moveTaskBoard` 的 RPC schema 只包含看板字段；原版 React 状态还需要
        // participants、relations、attachments 等完整 Dashi task。移动成功后重新
        // 通过白名单 GET 读取原始响应，不能把收窄对象回填到原版状态。
        const refreshed = await bridgeRequest({
          method: "GET",
          path: `/api/tasks/${encodeURIComponent(taskId)}`,
          headers: {},
          body: null,
        });
        if (refreshed.body.kind === "json" && refreshed.body.value
          && typeof refreshed.body.value === "object" && !Array.isArray(refreshed.body.value)) {
          refreshed.body.value = {
            ...refreshed.body.value,
            dispatch: result.dispatch,
            dispatchMessage: result.dispatchMessage,
          };
        }
        post({ type: "paseo-taskboard:response", channel, nonce, requestId, ...refreshed });
      } catch (error) {
        post({
          type: "paseo-taskboard:response",
          channel,
          nonce,
          requestId,
          status: 502,
          headers: { "content-type": "application/json" },
          body: { kind: "json", value: { error: { code: "BRIDGE_FAILURE", message: error instanceof Error ? error.message : String(error) } } },
        });
      }
    }
    function receive(event: any) {
      const message = event.data as Record<string, unknown> | null;
      if (event.source !== frameRef.current?.contentWindow || !message) return;
      if (message.type === "taskboard:frame-awaiting-challenge") {
        post({ type: "taskboard:frame-challenge", payload: { challenge: nonce } });
        return;
      }
      if (message.type === "taskboard:ready" && message.challenge === nonce) {
        sendHostContext();
        return;
      }
      if (message.type === "taskboard:create-thread" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        if (typeof payload?.taskId === "string") void startBoundTask(payload.taskId);
        return;
      }
      if (message.type === "taskboard:open-paseo-agent" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        const navigation = props.navigation;
        if (typeof payload?.agentId !== "string" || !navigation?.openAgent) {
          post({ type: "taskboard:thread-open-error", payload: { error: "当前 Paseo 客户端无法打开 Agent 会话。" } });
        } else {
          navigation.openAgent({ agentId: payload.agentId });
        }
        return;
      }
      if (message.type === "taskboard:paseo-open-url" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        if (typeof payload?.url !== "string" || !isAllowedPluginReleaseUrl(payload.url)) return;
        window.open(payload.url, "_blank", "noopener,noreferrer");
        return;
      }
      if (message.type === "taskboard:paseo-copy-request" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        const requestId = payload?.requestId;
        if (typeof requestId !== "string") return;
        void (async () => {
          try {
            let copiedText: string;
            if (payload?.kind === "text" && typeof payload.text === "string" && payload.text.length > 0) {
              copiedText = payload.text;
            } else if (
              payload?.kind === "issue-link"
              && typeof payload.projectId === "string"
              && payload.projectId.trim().length > 0
              && typeof payload.identifier === "string"
              && payload.identifier.trim().length > 0
            ) {
              copiedText = buildHostIssueLink(payload.projectId.trim(), payload.identifier.trim());
            } else {
              throw new Error("无效的复制请求。");
            }
            await copyTextToClipboard(copiedText);
            post({ type: "taskboard:paseo-copy-response", payload: { requestId, copiedText } });
          } catch (error) {
            post({ type: "taskboard:paseo-copy-response", payload: { requestId, error: error instanceof Error ? error.message : String(error) } });
          }
        })();
        return;
      }
      if (message.type === "taskboard:paseo-presentations-request" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        const taskIds = Array.isArray(payload?.taskIds)
          ? payload.taskIds.filter((taskId): taskId is string => typeof taskId === "string").slice(0, 200)
          : [];
        const sequence = ++presentationRequestSequence.current;
        void getPaseoPresentations({ taskIds }).then(
          (result) => {
            if (sequence === presentationRequestSequence.current) {
              post({ type: "taskboard:paseo-presentations", payload: result });
            }
          },
          () => {
            if (sequence === presentationRequestSequence.current) {
              post({ type: "taskboard:paseo-presentations", payload: { presentations: [] } });
            }
          },
        );
        return;
      }
      if (message.type === "taskboard:paseo-assignment-options-request" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        const requestId = payload?.requestId;
        const projectId = payload?.projectId;
        if (typeof requestId !== "number" || (typeof projectId !== "string" && projectId !== null)) return;
        void Promise.all([
          listPaseoAssignmentOptions({ projectId: projectId ?? null }),
          listBindings({}),
        ]).then(
          ([options, bindingResult]) => {
            const assignedTaskByAgentId = new Map(bindingResult.bindings.map((binding) => [binding.agentId, binding.taskIdentifier]));
            post({
              type: "taskboard:paseo-assignment-options",
              payload: {
                requestId,
                options: {
                  ...options,
                  agents: options.agents.map((agent) => ({
                    ...agent,
                    assignedTaskIdentifier: assignedTaskByAgentId.get(agent.id) ?? null,
                  })),
                },
              },
            });
          },
          (error: unknown) => post({ type: "taskboard:paseo-assignment-options", payload: { requestId, error: error instanceof Error ? error.message : String(error) } }),
        );
        return;
      }
      if (message.type === "taskboard:paseo-configuration-options-request" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        const requestId = payload?.requestId;
        const provider = payload?.provider;
        const model = payload?.model;
        const workspacePath = payload?.workspacePath;
        if (
          typeof requestId !== "string"
          || typeof provider !== "string"
          || typeof model !== "string"
          || (workspacePath !== undefined && workspacePath !== null && typeof workspacePath !== "string")
        ) return;
        void getPaseoConfigurationOptions({
          provider,
          model,
          ...(workspacePath === undefined ? {} : { workspacePath: workspacePath as string | null }),
          ...(typeof payload?.agentId === "string" ? { agentId: payload.agentId } : {}),
          ...(typeof payload?.modeId === "string" ? { modeId: payload.modeId } : {}),
          ...(typeof payload?.thinkingOptionId === "string" ? { thinkingOptionId: payload.thinkingOptionId } : {}),
        }).then(
          (result) => post({ type: "taskboard:paseo-configuration-options", payload: { requestId, options: result.options } }),
          (error: unknown) => post({ type: "taskboard:paseo-configuration-options", payload: { requestId, error: error instanceof Error ? error.message : String(error) } }),
        );
        return;
      }
      if (message.type === "taskboard:paseo-task-assignments-request" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        const taskIds = Array.isArray(payload?.taskIds)
          ? payload.taskIds.filter((taskId): taskId is string => typeof taskId === "string").slice(0, 200)
          : [];
        void getPaseoTaskAssignments({ taskIds }).then(
          (result) => post({ type: "taskboard:paseo-task-assignments", payload: result }),
          () => post({ type: "taskboard:paseo-task-assignments", payload: { assignments: [] } }),
        );
        return;
      }
      if (message.type === "taskboard:paseo-worktree-request" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        const requestId = payload?.requestId;
        const operation = payload?.operation;
        if (typeof requestId !== "string") return;
        const request = operation === "inspect" && typeof payload?.workspacePath === "string"
          ? inspectPaseoWorktree({ workspacePath: payload.workspacePath })
          : operation === "create"
            && typeof payload?.workspacePath === "string"
            && typeof payload?.branch === "string"
            && (payload?.branchMode === "existing" || payload?.branchMode === "new")
            ? createPaseoWorktree({
              workspacePath: payload.workspacePath,
              branch: payload.branch,
              branchMode: payload.branchMode,
              ...(typeof payload?.taskId === "string" ? { taskId: payload.taskId } : {}),
            })
            : null;
        if (!request) {
          post({ type: "taskboard:paseo-worktree-response", challenge: nonce, payload: { requestId, ok: false, error: "无效的 Paseo Worktree 请求。" } });
          return;
        }
        void request.then(
          (value) => post({ type: "taskboard:paseo-worktree-response", challenge: nonce, payload: { requestId, ok: true, value } }),
          (error: unknown) => post({ type: "taskboard:paseo-worktree-response", challenge: nonce, payload: { requestId, ok: false, error: error instanceof Error ? error.message : String(error) } }),
        );
        return;
      }
      if (message.type === "taskboard:paseo-automation-request" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        const requestId = payload?.requestId;
        const operation = payload?.operation;
        const projectId = payload?.projectId;
        const hasWorkspacePath = Boolean(payload && Object.hasOwn(payload, "workspacePath"));
        const hasProfile = Boolean(payload && Object.hasOwn(payload, "profile"));
        if (typeof requestId !== "string" || typeof projectId !== "string") return;
        const request = operation === "get"
          ? getPaseoAutomation({ projectId })
          : operation === "save"
            && typeof payload?.enabledByUser === "boolean"
            && typeof payload?.intervalMinutes === "number"
            && typeof payload?.quotaAware === "boolean"
            && hasWorkspacePath === hasProfile
            ? savePaseoAutomation({
              projectId,
              enabledByUser: payload.enabledByUser,
              intervalMinutes: payload.intervalMinutes as 5 | 10 | 15 | 30 | 60,
              quotaAware: payload.quotaAware,
              ...(hasWorkspacePath && hasProfile
                ? {
                  workspacePath: typeof payload.workspacePath === "string" ? payload.workspacePath : null,
                  profile: payload.profile && typeof payload.profile === "object" ? payload.profile as never : null,
                }
                : {}),
            })
            : null;
        if (!request) {
          post({ type: "taskboard:paseo-automation-response", challenge: nonce, payload: { requestId, error: "无效的 Paseo 自动化请求。" } });
          return;
        }
        void request.then(
          (result) => post({ type: "taskboard:paseo-automation-response", challenge: nonce, payload: { requestId, automation: result.automation } }),
          (error: unknown) => post({ type: "taskboard:paseo-automation-response", challenge: nonce, payload: { requestId, error: error instanceof Error ? error.message : String(error) } }),
        );
        return;
      }
      if (message.type === "taskboard:paseo-project-defaults-save" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        const requestId = payload?.requestId;
        const projectId = payload?.projectId;
        const workspacePath = payload?.workspacePath;
        const profile = payload?.profile;
        if (
          typeof requestId !== "string"
          || typeof projectId !== "string"
          || (workspacePath !== null && typeof workspacePath !== "string")
          || (profile !== null && (typeof profile !== "object" || !profile))
        ) return;
        void savePaseoProjectDefaults({
          projectId,
          workspacePath,
          profile: profile as never,
        }).then(
          (result) => post({
            type: "taskboard:paseo-project-defaults-saved",
            challenge: nonce,
            payload: { requestId, projectId: result.projectId, automation: result.automation },
          }),
          (error: unknown) => post({
            type: "taskboard:paseo-project-defaults-saved",
            challenge: nonce,
            payload: { requestId, projectId, error: error instanceof Error ? error.message : String(error) },
          }),
        );
        return;
      }
      if (message.type === "taskboard:paseo-assignment-save" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        const requestId = payload?.requestId;
        const taskId = payload?.taskId;
        const projectId = payload?.projectId;
        const choice = payload?.choice as Record<string, unknown> | null;
        if (typeof requestId !== "string" || typeof taskId !== "string" || typeof projectId !== "string" || !choice || typeof choice.kind !== "string") return;
        const save = choice.kind === "existing" && typeof choice.agentId === "string"
          ? bindExistingPaseoAgent({ taskId, agentId: choice.agentId })
          : choice.kind === "planned"
            && (choice.workspacePath === null || typeof choice.workspacePath === "string")
            && (choice.profile === null || (choice.profile && typeof choice.profile === "object"))
            ? saveTaskExecutionPlan({
              taskId,
              projectId,
              workspacePath: choice.workspacePath as string | null,
              profile: choice.profile as never,
              ...(choice.replaceWorkspace === true ? { replaceWorkspace: true } : {}),
            })
            : clearPaseoTaskAssignment({ taskId }).then(() => ({ assignment: null }));
        void (async () => {
          try {
            const result = await save;
            let fullTask: unknown = null;
            if ("task" in result) {
              const refreshed = await bridgeRequest({
                method: "GET",
                path: `/api/tasks/${encodeURIComponent(taskId)}`,
                headers: {},
                body: null,
              });
              const value = refreshed.body.kind === "json" ? refreshed.body.value : null;
              fullTask = value && typeof value === "object" && "task" in value
                ? (value as { task: unknown }).task
                : null;
              if (refreshed.status < 200 || refreshed.status >= 300 || !fullTask) {
                throw new Error("执行配置已保存，但无法读取任务的完整数据；请刷新看板。");
              }
            }
            post({
              type: "taskboard:paseo-assignment-saved",
              payload: { requestId, taskId, assignment: result.assignment, ...(fullTask ? { task: fullTask } : {}) },
            });
          } catch (error) {
            post({ type: "taskboard:paseo-assignment-saved", payload: { requestId, taskId, error: error instanceof Error ? error.message : String(error) } });
          }
        })();
        return;
      }
      if (message.type === "taskboard:paseo-merge-ideas-request" && message.challenge === nonce) {
        const payload = message.payload as Record<string, unknown> | null;
        const requestId = payload?.requestId;
        const operationId = payload?.operationId;
        const projectId = payload?.projectId;
        const sourceTaskIds = payload?.sourceTaskIds;
        const title = payload?.title;
        const workspacePath = payload?.workspacePath;
        const profile = payload?.profile;
        if (
          typeof requestId !== "string"
          || typeof operationId !== "string"
          || typeof projectId !== "string"
          || !Array.isArray(sourceTaskIds)
          || !sourceTaskIds.every((taskId) => typeof taskId === "string")
          || typeof title !== "string"
          || typeof workspacePath !== "string"
          || !profile
          || typeof profile !== "object"
        ) return;
        void (async () => {
          try {
            const result = await mergePaseoIdeas({
              operationId,
              projectId,
              sourceTaskIds: sourceTaskIds as string[],
              title,
              ...(typeof payload?.description === "string" ? { description: payload.description } : {}),
              workspacePath,
              profile: profile as never,
            });
            // RPC 的 TaskSchema 只覆盖插件所需字段；原版 React 状态还需要
            // participants、relations、attachments 等完整 Dashi task。
            const refreshed = await bridgeRequest({
              method: "GET",
              path: `/api/tasks/${encodeURIComponent(result.task.id)}`,
              headers: {},
              body: null,
            });
            const value = refreshed.body.kind === "json" ? refreshed.body.value : null;
            const fullTask = value && typeof value === "object" && "task" in value
              ? (value as { task: unknown }).task
              : null;
            if (refreshed.status < 200 || refreshed.status >= 300 || !fullTask) {
              throw new Error("合并已完成，但无法读取新任务的完整数据；请刷新看板。");
            }
            post({
              type: "taskboard:paseo-merge-ideas",
              payload: { requestId, ...result, task: fullTask },
            });
          } catch (error) {
            post({ type: "taskboard:paseo-merge-ideas", payload: { requestId, error: error instanceof Error ? error.message : String(error) } });
          }
        })();
        return;
      }
      if (message.type !== "paseo-taskboard:request" || message.channel !== channel || message.nonce !== nonce || typeof message.requestId !== "string" || typeof message.method !== "string" || typeof message.path !== "string") return;
      const requestPath = message.path.split("?", 1)[0];
      const isBoardMove = message.method === "POST" && requestPath.endsWith("/move");
      // 完整属性 PATCH 也会携带 status（原版保存 draft 的方式）。它必须原样
      // 走 Dashi PATCH，尤其不能丢 developmentContext、relations 等属性。
      if (isBoardMove) {
        void moveTaskThroughBoard(message);
        return;
      }
      void bridgeRequest({
        method: message.method as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
        path: message.path,
        headers: typeof message.headers === "object" && message.headers ? message.headers as Record<string, string> : {},
        body: typeof message.body === "object" && message.body
          ? message.body as { kind: "text" | "base64"; value: string }
          : null,
      }).then(
        (result) => post({ type: "paseo-taskboard:response", channel, nonce, requestId: message.requestId, ...result }),
        (error: unknown) => {
          const messageText = error instanceof Error ? error.message : String(error);
          if (message.method === "GET" && requestPath === "/api/plugin-update") {
            post({
              type: "paseo-taskboard:response",
              channel,
              nonce,
              requestId: message.requestId,
              status: 200,
              headers: { "content-type": "application/json" },
              body: {
                kind: "json",
                value: {
                  status: "unavailable",
                  updateAvailable: false,
                  currentVersion: "0.1.0",
                  latestVersion: null,
                  publishedAt: null,
                  title: null,
                  notes: null,
                  htmlUrl: "https://github.com/moeacgx/agent-taskboard/releases",
                  guideUrl: "https://github.com/moeacgx/agent-taskboard/blob/HEAD/integrations/paseo/README.md",
                  checkedAt: new Date().toISOString(),
                  error: messageText,
                },
              },
            });
            return;
          }
          post({
            type: "paseo-taskboard:response",
            channel,
            nonce,
            requestId: message.requestId,
            status: 502,
            headers: { "content-type": "application/json" },
            body: { kind: "json", value: { error: { code: "BRIDGE_FAILURE", message: messageText } } },
          });
        },
      );
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [bindExistingPaseoAgent, bridgeRequest, channel, clearPaseoTaskAssignment, createPaseoWorktree, getBinding, getPaseoAutomation, getPaseoConfigurationOptions, getPaseoPresentations, getPaseoTaskAssignments, getTask, hostTheme, inspectPaseoWorktree, listBindings, listPaseoAssignmentOptions, mergePaseoIdeas, moveTaskBoard, nonce, props.navigation, savePaseoAutomation, savePaseoProjectDefaults, saveTaskExecutionPlan]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "taskboard:theme", theme: hostTheme }, "*");
  }, [hostTheme]);

  return createElement("iframe", {
    ref: frameRef,
    title: "原版任务看板",
    // 原版创建/编辑对话框使用 React form onSubmit；只放开表单事件，不授予同源权限。
    sandbox: "allow-scripts allow-forms",
    srcDoc: source,
    "data-testid": "original-taskboard-frame",
    style: { flex: 1, width: "100%", height: "100%", border: 0, background: props.theme.colors.surface0 },
    onLoad: () => {
      frameRef.current?.contentWindow?.postMessage({ type: "taskboard:frame-challenge", payload: { challenge: nonce } }, "*");
    },
  });
}
