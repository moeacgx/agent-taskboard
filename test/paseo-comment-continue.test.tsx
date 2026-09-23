import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";
import { createBindingsStore } from "../integrations/paseo/server/bindings.ts";
import { createSettingsStore } from "../integrations/paseo/server/settings.ts";
import { createTaskPlansStore } from "../integrations/paseo/server/task-plans.ts";
import { createTaskDispatchCoordinator, createTaskMutationLock } from "../integrations/paseo/server/dispatch.ts";
import { registerHandlers } from "../integrations/paseo/server/handlers.ts";
import * as contracts from "../integrations/paseo/shared/contracts.ts";
import { TaskDetail } from "../web/src/components/TaskDetail";
import { continuePaseoTaskAfterComment, setCurrentUserActor } from "../web/src/api";
import { TaskboardLanguageProvider } from "../web/src/i18n";
import { taskboardStorage } from "../web/src/storage";

// 服务端按 Node 原生文件路径载入，避免 jsdom 转换 import.meta.url。
const { createTaskboardServer } = createRequire(path.join(process.cwd(), "package.json"))("./server/app.mjs");

// 真实 HTTP、SQLite 和派发回写在 CI 上可能超过默认的一秒 UI 等待。
configure({ asyncUtilTimeout: 10000 });

// 仅替换编辑器 UI，保留真实 TaskDetail 提交、图片转换、HTTP、数据库及派发处理器。
vi.mock("../web/src/components/InlineMediaComposer", async () => {
  const React = await import("react");
  const model = await import("../web/src/documentModel");
  return { InlineMediaComposer: React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({ focus() {}, addFiles() {} }));
    return <div>
      <textarea aria-label={props.ariaLabel} disabled={props.disabled}
        value={model.inlineMediaText(props.segments)}
        onChange={(event) => props.onChange(model.createInlineMediaSegments(event.target.value))}
        onKeyDown={props.onKeyDown} />
      <button type="button" disabled={props.disabled} onClick={() => props.onChange([
        ...props.segments,
        model.imageSegment(new File([new Uint8Array([137, 80, 78, 71])], "本轮.png", { type: "image/png" }), "data:image/png;base64,iVBORw=="),
      ])}>临时验证添加图片</button>
    </div>;
  }) };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function fixture(draft = "请继续修复") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-comment-continue-"));
  const app = createTaskboardServer({ dataDirectory: directory, databasePath: path.join(directory, "db.sqlite"), attachmentsDirectory: path.join(directory, "attachments"), staticDirectory: directory });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const originalUrl = process.env.DASHI_TASKBOARD_URL;
  process.env.DASHI_TASKBOARD_URL = origin;
  const user = { type: "user", id: "comment-test-user", name: "验证用户", avatarUrl: null };
  setCurrentUserActor(user);
  const task = app.database.createTask({ projectId: "local", title: "临时续聊验证", description: "![旧图](api/attachments/old-image/content)", status: "in_review", priority: "none", labels: [], actor: user, assignee: user, threadId: null, developmentContext: null, startDate: null, dueDate: null, recurrence: null });
  const bindings = createBindingsStore({ filePath: path.join(directory, "bindings.json") });
  await bindings.upsert({ taskId: task.id, taskIdentifier: task.identifier, projectId: task.projectId, workspaceId: "mock-workspace", agentId: "mock-agent", provider: "mock" });
  const handlers = new Map();
  registerHandlers({ handle: (contract, handler) => handlers.set(contract.name, handler) }, bindings,
    createSettingsStore({ filePath: path.join(directory, "settings.json") }),
    createTaskPlansStore({ filePath: path.join(directory, "plans.json") }),
    createTaskDispatchCoordinator(), undefined, createTaskMutationLock());
  const events = [];
  let failSend = false;
  let loseReply = false;
  let failSave = false;
  let busy = false;
  let permission = false;
  const send = vi.fn(async (prompt, options) => {
    events.push("send");
    const latest = app.database.listComments(task.id).filter((comment) => comment.authorId === user.id).at(-1);
    expect(prompt).toContain(latest.body);
    expect(prompt).not.toContain("old-image");
    expect(latest.body).not.toContain("<!--taskboard-inline-image:");
    if (failSend) throw new Error("模拟派发失败");
  });
  const createAgent = vi.fn(() => { throw new Error("不应创建新 Agent"); });
  const paseo = { agents: { ref: () => ({
    id: "mock-agent", get status() { return busy ? "running" : "idle"; },
    get pendingPermissions() { return permission ? ["permission"] : []; },
    activeTurn: null, refresh: async () => {}, send,
  }) }, workspaces: { open: vi.fn(() => ({ agents: { create: createAgent } })) } };
  const nativeFetch = globalThis.fetch;
  const base = document.createElement("base");
  base.href = "https://paseo-taskboard.invalid/?host=paseo";
  document.head.append(base);
  vi.stubGlobal("fetch", async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== "https://paseo-taskboard.invalid") return nativeFetch(input, init);
    const method = init.method ?? "GET";
    if (url.pathname.endsWith("/move") && method === "POST") {
      events.push("move");
      const data = JSON.parse(init.body);
      expect(data.status).toBe("in_progress");
      const result = await handlers.get(contracts.moveTaskBoard.name)({ id: task.id, ...data }, { paseo });
      if (loseReply) throw new DOMException("模拟桥超时", "TimeoutError");
      if (result.dispatch === "needs_configuration") return Response.json({ error: { code: "TASK_DISPATCH_NEEDS_CONFIGURATION", message: result.dispatchMessage } }, { status: 409 });
      return Response.json({ task: app.database.getTask(task.id), dispatch: result.dispatch, dispatchMessage: result.dispatchMessage });
    }
    if (url.pathname.endsWith("/comments") && method === "POST") {
      events.push("comment");
      if (failSave) return Response.json({ error: { code: "SAVE_FAILED", message: "模拟保存失败" } }, { status: 500 });
    }
    if (url.pathname.match(/\/comments\/[^/]+$/) && method === "PATCH") events.push("resolve");
    let body = init.body;
    if (body instanceof File) {
      events.push("upload");
      body = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result)); reader.onerror = reject; reader.readAsArrayBuffer(body);
      });
    }
    return nativeFetch(`${origin}${url.pathname}${url.search}`, { ...init, body });
  });
  const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:mock" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  const assignment = { kind: "existing", taskId: task.id, agentId: "mock-agent", workspaceId: "mock-workspace", workspaceName: "临时", workspacePath: directory, provider: "mock", model: null, title: "Mock", status: "idle" };
  const presentation = { agentId: "mock-agent", status: "idle", requiresAttention: false, attentionReason: null, title: "Mock", updatedAt: null };
  taskboardStorage.setItem(`taskboard.comment-draft.${task.id}`, draft);
  const onUpdate = vi.fn();
  const props = {
    task, tasks: [task], referenceTasks: [task], currentUser: user, availableLabels: [],
    developmentScan: { workspacePath: null, contexts: [] }, developmentScanLoading: false, commentsRevision: 0, attachmentsRevision: 0,
    onCreateLabel: vi.fn(), onDeleteLabel: vi.fn(), onUpdate, onOpenTask: vi.fn(), onAddRelation: vi.fn(), onRemoveRelation: vi.fn(),
    onOpenThread: vi.fn(), onOpenLegacyLocalThread: vi.fn(), onOpenInThread: vi.fn(), onCopy: vi.fn(), onCopyIssueLink: vi.fn(), openingThread: false, onError: vi.fn(),
    paseoAssignment: assignment, paseoPresentation: presentation, onContinuePaseoTask: continuePaseoTaskAfterComment,
  };
  const ui = (override = {}) => <TaskboardLanguageProvider language="zh"><TaskDetail {...props} {...override} /></TaskboardLanguageProvider>;
  return { task, app, events, send, createAgent, onUpdate, ui,
    failSend: (value) => { failSend = value; }, loseReply: (value) => { loseReply = value; }, failSave: (value) => { failSave = value; },
    busy: (value) => { busy = value; }, permission: (value) => { permission = value; }, presentation, assignment,
    comments: () => app.database.listComments(task.id).filter((comment) => comment.authorId === user.id),
    async close() {
      cleanup(); vi.unstubAllGlobals(); base.remove();
      if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate); else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke); else Reflect.deleteProperty(URL, "revokeObjectURL");
      if (originalUrl === undefined) delete process.env.DASHI_TASKBOARD_URL; else process.env.DASHI_TASKBOARD_URL = originalUrl;
      await app.close();
      if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("taskboard-comment-continue-")) throw new Error("临时目录不符");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("图片评论先完整保存，再续聊；失败重试不重复评论或附件", async () => {
  const f = await fixture();
  try {
    f.failSend(true);
    const view = render(f.ui());
    expect(view.queryByText("改变状态为-等待认领")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "临时验证添加图片" }));
    const button = view.getByRole("button", { name: "评论并继续处理" });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(view.getByRole("button", { name: "重试已保存评论" }).disabled).toBe(false));
    expect(view.getByRole("status").textContent).toContain("评论已保存，但未成功继续处理");
    expect(f.comments()).toHaveLength(1);
    expect(f.comments()[0].attachments).toHaveLength(1);
    expect(f.events).toEqual(["comment", "upload", "resolve", "move", "send"]);
    expect(f.send.mock.calls[0][1].images).toEqual([{ data: "iVBORw==", mimeType: "image/png" }]);
    f.failSend(false);
    fireEvent.click(view.getByRole("button", { name: "重试已保存评论" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("评论已保存，已继续处理。"));
    expect(f.comments()).toHaveLength(1);
    expect(f.events).toEqual(["comment", "upload", "resolve", "move", "send", "move", "send"]);
    expect(f.createAgent).not.toHaveBeenCalled();
    expect(f.onUpdate).not.toHaveBeenCalled();
    expect(f.app.database.getTask(f.task.id).status).toBe("in_progress");
  } finally { await f.close(); }
}, 60000);

it("派发响应超时明确未确认，不自动重发；重试检查当前状态", async () => {
  const f = await fixture();
  try {
    f.loseReply(true);
    const view = render(f.ui());
    fireEvent.click(view.getByRole("button", { name: "评论并继续处理" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("派发结果未确认"));
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]).toHaveLength(1);
    expect(f.comments()).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "重试已保存评论" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("任务已不在等你确认或遇到阻碍"));
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.comments()).toHaveLength(1);
  } finally { await f.close(); }
}, 60000);

it("运行/权限禁用继续，Ctrl+Enter 只评论；保存失败保留草稿", async () => {
  const f = await fixture("保持纯评论");
  try {
    const view = render(f.ui({ paseoPresentation: { ...f.presentation, status: "running" } }));
    expect(view.getByRole("button", { name: "评论并继续处理" }).disabled).toBe(true);
    expect(view.getByRole("status").textContent).toContain("Agent 正在运行");
    view.rerender(f.ui({ paseoPresentation: { ...f.presentation, requiresAttention: true, attentionReason: "permission" } }));
    expect(view.getByRole("button", { name: "评论并继续处理" }).disabled).toBe(true);
    expect(view.getByRole("button", { name: "评论", exact: true }).disabled).toBe(false);
    fireEvent.keyDown(view.getByLabelText("留下评论"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(view.getByLabelText("留下评论").value).toBe(""));
    await waitFor(() => expect(view.getByLabelText("留下评论").disabled).toBe(false));
    expect(f.comments()).toHaveLength(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.app.database.getTask(f.task.id).status).toBe("in_review");
    view.rerender(f.ui());
    fireEvent.change(view.getByLabelText("留下评论"), { target: { value: "保存失败仍保留" } });
    await waitFor(() => expect(view.getByRole("button", { name: "评论并继续处理" }).disabled).toBe(false));
    f.failSave(true);
    fireEvent.click(view.getByRole("button", { name: "评论并继续处理" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("模拟保存失败"));
    expect(view.getByLabelText("留下评论").value).toBe("保存失败仍保留");
    expect(f.send).not.toHaveBeenCalled();
  } finally { await f.close(); }
}, 60000);

it("服务端 skipped 不伪装成功，解除忙碌后重试只使用已保存评论", async () => {
  const f = await fixture();
  try {
    f.busy(true);
    const view = render(f.ui());
    fireEvent.click(view.getByRole("button", { name: "评论并继续处理" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("评论已保存，但未成功继续处理"));
    expect(f.send).not.toHaveBeenCalled();
    f.busy(false);
    fireEvent.click(view.getByRole("button", { name: "重试已保存评论" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("评论已保存，已继续处理。"));
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.comments()).toHaveLength(1);
  } finally { await f.close(); }
}, 60000);
