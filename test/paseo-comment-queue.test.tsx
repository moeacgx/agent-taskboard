import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { TaskDetail } from "../web/src/components/TaskDetail";
import { TaskboardLanguageProvider } from "../web/src/i18n";
import { taskboardStorage } from "../web/src/storage";
import * as api from "../web/src/api";
import type { Comment, Task } from "../web/src/types";
import type { PaseoCommentQueueRequest, PaseoCommentQueueState } from "../web/src/paseo-bridge";

vi.mock("../web/src/api", async (original) => ({
  ...await original<typeof api>(),
  createComment: vi.fn(), uploadCommentAttachment: vi.fn(), updateComment: vi.fn(),
  getTask: vi.fn(), listComments: vi.fn(), listAttachments: vi.fn(), listTaskActivities: vi.fn(),
}));

// 只简化编辑器输入和正文渲染，保存、图片解析与队列交互仍执行真实 TaskDetail。
vi.mock("../web/src/components/InlineMediaComposer", async () => {
  const React = await import("react");
  const model = await import("../web/src/documentModel");
  return { InlineMediaComposer: React.forwardRef((props: any, ref) => {
    React.useImperativeHandle(ref, () => ({ focus() {}, addFiles() {} }));
    return <div>
      <textarea aria-label={props.ariaLabel} disabled={props.disabled}
        value={model.inlineMediaText(props.segments)}
        onChange={(event) => props.onChange(model.createInlineMediaSegments(event.target.value))}
        onKeyDown={props.onKeyDown} />
      <button type="button" disabled={props.disabled} onClick={() => props.onChange([
        ...props.segments,
        model.imageSegment(new File(["image"], "本轮.png", { type: "image/png" }), "data:image/png;base64,aW1hZ2U="),
      ])}>添加测试图片</button>
    </div>;
  }) };
});
vi.mock("../web/src/components/DescriptionDocument", () => ({
  DescriptionDocument: ({ value }: { value: string }) => <span>{value}</span>,
}));

const now = "2026-09-25T00:00:00Z";
const user = { type: "user" as const, id: "queue-user", name: "测试用户", avatarUrl: null };
const task: Task = {
  id: "queue-task", identifier: "QUEUE-1", projectId: "local", title: "队列验证", description: "",
  status: "in_progress", priority: "none", labels: [], sortOrder: 0, threadId: null,
  threadBinding: null, legacyLocalThreadId: null, conversationRefs: [], participants: [user],
  previewImage: null, activityKey: "queue-1", activityUpdatedAt: now,
  creatorType: "user", creatorId: user.id, creatorName: user.name, creatorAvatarUrl: null,
  assignee: user, developmentContext: null, startDate: null, dueDate: null, recurrence: null,
  source: "local", externalUrl: null, archivedAt: null,
  relations: { parent: null, subIssues: [], related: [], blocks: [], blockedBy: [] },
  version: 1, createdAt: now, updatedAt: now,
};
const assignment = {
  kind: "existing" as const, taskId: task.id, agentId: "original-agent", workspaceId: "workspace",
  workspaceName: "测试", workspacePath: "C:/queue-test", provider: "mock", model: null,
  title: "原会话", status: "running" as const,
};
const presentation = {
  agentId: assignment.agentId, status: "running" as const, requiresAttention: false,
  attentionReason: null, title: "原会话", updatedAt: null,
};
const emptyQueue = (): PaseoCommentQueueState => ({ items: [], pauseReason: null, waitingReason: null });
function item(id: string, status: PaseoCommentQueueState["items"][number]["status"] = "queued") {
  return { id, taskId: task.id, commentId: `comment-${id}`, agentId: assignment.agentId,
    body: `排队正文 ${id}`, createdAt: now, status, turnId: null, imageCount: 0 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let base: HTMLBaseElement;
beforeEach(() => {
  vi.resetAllMocks();
  base = document.createElement("base");
  base.href = "https://paseo-taskboard.invalid/?host=paseo";
  document.head.append(base);
  vi.mocked(api.listAttachments).mockResolvedValue([]);
  vi.mocked(api.listTaskActivities).mockResolvedValue([]);
  taskboardStorage.removeItem(`taskboard.comment-draft.${task.id}`);
});
afterEach(() => {
  cleanup();
  base.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(initial = emptyQueue()) {
  const events: string[] = [];
  const comments: Comment[] = [];
  let queue = initial;
  let failEnqueue = false;
  let listOverride: (() => Promise<PaseoCommentQueueState>) | null = null;
  vi.mocked(api.getTask).mockResolvedValue(task);
  vi.mocked(api.listComments).mockImplementation(async () => [...comments]);
  vi.mocked(api.createComment).mockImplementation(async (taskId, body) => {
    events.push("create");
    const comment: Comment = { id: `saved-${comments.length + 1}`, taskId, body,
      authorType: "user", authorId: user.id, authorName: user.name, authorAvatarUrl: null,
      threadId: null, threadBinding: null, legacyLocalThreadId: null, attachments: [],
      version: 1, createdAt: now, updatedAt: now };
    comments.push(comment);
    return comment;
  });
  vi.mocked(api.uploadCommentAttachment).mockImplementation(async (commentId) => {
    events.push("upload");
    const attachment = { id: "saved-image", taskId: task.id, commentId, kind: "inline" as const,
      filename: "本轮.png", contentType: "image/png", size: 5, createdAt: now };
    comments.find((comment) => comment.id === commentId)!.attachments.push(attachment);
    return attachment;
  });
  vi.mocked(api.updateComment).mockImplementation(async (comment, body) => {
    events.push("resolve");
    const saved = { ...comment, body, version: comment.version + 1 };
    comments[comments.findIndex((entry) => entry.id === saved.id)] = saved;
    return saved;
  });
  const request = vi.fn(async (input: PaseoCommentQueueRequest, _signal?: AbortSignal) => {
    if (input.action === "list") return listOverride ? listOverride() : queue;
    events.push(input.action);
    if (input.action === "enqueue") {
      if (failEnqueue) throw new Error("模拟入队响应超时");
      const comment = comments.find((entry) => entry.id === input.commentId)!;
      queue = { ...queue, items: [...queue.items, { ...item(input.commentId),
        commentId: comment.id, body: comment.body, imageCount: comment.attachments.length }] };
    } else if (input.action === "cancel") {
      queue = { ...queue, items: queue.items.map((entry) => entry.id === input.itemId ? { ...entry, body: "", status: "canceled" } : entry) };
    } else if (input.action === "acknowledge") {
      queue = { ...queue, pauseReason: "已移出核对过的项，未重发。请恢复后续队列。",
        items: queue.items.map((entry) => entry.id === input.itemId ? { ...entry, body: "", status: "completed" } : entry) };
    } else if (input.action === "retry") queue = { ...queue, pauseReason: null };
    return queue;
  });
  const resume = vi.fn(async () => ({ task: { ...task, status: "in_progress" as const }, dispatch: "continued" as const, dispatchMessage: null }));
  const openAgent = vi.fn();
  const props: ComponentProps<typeof TaskDetail> = {
    task, tasks: [task], referenceTasks: [task], currentUser: user, availableLabels: [],
    developmentScan: { workspacePath: null, contexts: [] }, developmentScanLoading: false,
    commentsRevision: 0, attachmentsRevision: 0, onCreateLabel: vi.fn(), onDeleteLabel: vi.fn(),
    onUpdate: vi.fn(), onOpenTask: vi.fn(), onAddRelation: vi.fn(), onRemoveRelation: vi.fn(),
    onOpenThread: vi.fn(), onOpenLegacyLocalThread: vi.fn(), onOpenInThread: vi.fn(), onCopy: vi.fn(),
    onCopyIssueLink: vi.fn(), openingThread: false, onError: vi.fn(),
    paseoAssignment: assignment, paseoPresentation: presentation, onContinuePaseoTask: resume,
    onPaseoCommentQueue: request, onOpenPaseoAgent: openAgent,
  };
  const ui = (override: Partial<typeof props> = {}) => <TaskboardLanguageProvider language="zh">
    <TaskDetail key={(override.task ?? task).id} {...props} {...override} />
  </TaskboardLanguageProvider>;
  return { ui, events, comments, request, resume, openAgent,
    failEnqueue: (value: boolean) => { failEnqueue = value; },
    listOverride: (value: typeof listOverride) => { listOverride = value; },
  };
}
async function ready(view: ReturnType<typeof render>, label = "评论并排队") {
  await waitFor(() => expect(view.queryByText("正在读取评论队列…")).toBeNull());
  fireEvent.change(view.getByLabelText("留下评论"), { target: { value: "请继续修复" } });
  await waitFor(() => expect((view.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false));
}

it.each(["in_progress", "in_review", "blocked"] as const)("%s 真实运行时先完整保存图片，再按精确 commentId 入队", async (status) => {
  const f = fixture();
  const view = render(f.ui({ task: { ...task, status } }));
  await ready(view);
  fireEvent.click(view.getByRole("button", { name: "添加测试图片" }));
  fireEvent.click(view.getByRole("button", { name: "评论并排队" }));
  await waitFor(() => expect(view.getByText("待处理 1 条")).toBeTruthy());
  expect(f.events).toEqual(["create", "upload", "resolve", "enqueue"]);
  expect(f.comments[0].body).toContain("api/attachments/saved-image/content");
  expect(f.comments[0].body).not.toContain("<!--taskboard-inline-image:");
  expect(f.request).toHaveBeenCalledWith({ action: "enqueue", taskId: task.id, commentId: "saved-1", agentId: assignment.agentId });
  expect(view.getByText("1 张图片")).toBeTruthy();
  expect(f.resume).not.toHaveBeenCalled();
}, 60000);

it("入队超时后普通评论仍只保存，显式重试复用原 commentId 和附件", async () => {
  const f = fixture();
  f.failEnqueue(true);
  const view = render(f.ui());
  await ready(view);
  fireEvent.click(view.getByRole("button", { name: "添加测试图片" }));
  fireEvent.click(view.getByRole("button", { name: "评论并排队" }));
  await waitFor(() => expect(view.getByText(/评论已保存，入队未确认/)).toBeTruthy());
  fireEvent.change(view.getByLabelText("留下评论"), { target: { value: "单独保存的新评论" } });
  fireEvent.click(view.getByRole("button", { name: "评论", exact: true }));
  await waitFor(() => expect(f.comments).toHaveLength(2));
  await waitFor(() => expect((view.getByLabelText("留下评论") as HTMLTextAreaElement).disabled).toBe(false));
  f.failEnqueue(false);
  fireEvent.click(view.getByRole("button", { name: "重试已保存评论入队" }));
  await waitFor(() => expect(view.getByText("待处理 1 条")).toBeTruthy());
  expect(f.request.mock.calls.filter(([input]) => input.action === "enqueue").map(([input]) => input)).toEqual([
    { action: "enqueue", taskId: task.id, commentId: "saved-1", agentId: assignment.agentId },
    { action: "enqueue", taskId: task.id, commentId: "saved-1", agentId: assignment.agentId },
  ]);
  expect(api.createComment).toHaveBeenCalledTimes(2);
  expect(api.uploadCommentAttachment).toHaveBeenCalledTimes(1);
  expect(api.updateComment).toHaveBeenCalledTimes(1);
}, 60000);

it("普通评论与 Ctrl+Enter 不入队；保存失败保留草稿", async () => {
  const f = fixture();
  const view = render(f.ui());
  await ready(view);
  fireEvent.click(view.getByRole("button", { name: "评论", exact: true }));
  await waitFor(() => expect((view.getByLabelText("留下评论") as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(view.getByLabelText("留下评论"), { target: { value: "快捷键只保存" } });
  fireEvent.keyDown(view.getByLabelText("留下评论"), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(f.comments).toHaveLength(2));
  await waitFor(() => expect((view.getByLabelText("留下评论") as HTMLTextAreaElement).disabled).toBe(false));
  vi.mocked(api.createComment).mockRejectedValueOnce(new Error("模拟保存失败"));
  fireEvent.change(view.getByLabelText("留下评论"), { target: { value: "失败保留草稿" } });
  fireEvent.click(view.getByRole("button", { name: "评论并排队" }));
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("模拟保存失败"));
  expect((view.getByLabelText("留下评论") as HTMLTextAreaElement).value).toBe("失败保留草稿");
  expect(f.request.mock.calls.every(([input]) => input.action === "list")).toBe(true);
  expect(f.resume).not.toHaveBeenCalled();
}, 60000);

it("权限等待可排队；idle 已有队列也追加排队，不走续聊", async () => {
  const f = fixture({ ...emptyQueue(), items: [item("first")] });
  const view = render(f.ui({ paseoAssignment: { ...assignment, status: "idle" },
    paseoPresentation: { ...presentation, status: "idle", requiresAttention: true, attentionReason: "permission" } }));
  await ready(view);
  fireEvent.click(view.getByRole("button", { name: "评论并排队" }));
  await waitFor(() => expect(view.getByText("待处理 2 条")).toBeTruthy());
  view.rerender(f.ui({ paseoAssignment: { ...assignment, status: "idle" }, paseoPresentation: { ...presentation, status: "idle" } }));
  fireEvent.change(view.getByLabelText("留下评论"), { target: { value: "追加第二条" } });
  fireEvent.click(view.getByRole("button", { name: "评论并排队" }));
  await waitFor(() => expect(view.getByText("待处理 3 条")).toBeTruthy());
  expect(f.resume).not.toHaveBeenCalled();
}, 60000);

it("idle 且空队列保留原有评论并继续处理", async () => {
  const f = fixture();
  vi.mocked(api.getTask).mockResolvedValue({ ...task, status: "in_review" });
  const view = render(f.ui({ task: { ...task, status: "in_review" }, paseoAssignment: { ...assignment, status: "idle" }, paseoPresentation: { ...presentation, status: "idle" } }));
  await ready(view, "评论并继续处理");
  fireEvent.click(view.getByRole("button", { name: "评论并继续处理" }));
  await waitFor(() => expect(f.resume).toHaveBeenCalledTimes(1));
  expect(f.request.mock.calls.every(([input]) => input.action === "list")).toBe(true);
}, 60000);

it("列表过滤终态，取消仅作用 queued；uncertain 经确认移出后仍需显式恢复", async () => {
  const f = fixture({ items: [item("first"), item("sending", "sending"), item("sent", "sent"), item("unknown", "uncertain"), item("done", "completed"), item("removed", "canceled")], pauseReason: "发送结果不确定", waitingReason: "等待本轮结束" });
  const view = render(f.ui());
  await waitFor(() => expect(view.getByText("待处理 4 条")).toBeTruthy());
  expect(view.queryByText("排队正文 done")).toBeNull();
  expect(view.queryByText("排队正文 removed")).toBeNull();
  expect(view.getAllByRole("button", { name: "取消排队" })).toHaveLength(1);
  fireEvent.click(view.getByRole("button", { name: "取消排队" }));
  await waitFor(() => expect(view.getByText("待处理 3 条")).toBeTruthy());
  expect(api.updateComment).not.toHaveBeenCalled();
  expect(view.getByText("发送待确认")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "打开原会话" }));
  expect(f.openAgent).toHaveBeenCalledWith(assignment.agentId);
  fireEvent.click(view.getByRole("button", { name: "核对后移出" }));
  expect(view.getByText(/不会重发，也不会自动恢复后续/)).toBeTruthy();
  expect(f.events).toEqual(["cancel"]);
  fireEvent.click(view.getByRole("button", { name: "已核对，仅移出此项" }));
  await waitFor(() => expect(view.getByText("待处理 2 条")).toBeTruthy());
  expect(f.events).toEqual(["cancel", "acknowledge"]);
  expect(view.getByText(/已移出核对过的项/)).toBeTruthy();
}, 60000);

it("暂停原因可见且恢复队列只发 retry", async () => {
  const f = fixture({ ...emptyQueue(), items: [item("first")], pauseReason: "上一轮失败，队列已暂停" });
  const view = render(f.ui({ paseoAssignment: { ...assignment, status: "idle" }, paseoPresentation: { ...presentation, status: "idle" } }));
  await waitFor(() => expect(view.getByText(/上一轮失败，队列已暂停/)).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "恢复队列" }));
  await waitFor(() => expect(view.queryByRole("button", { name: "恢复队列" })).toBeNull());
  expect(f.events).toEqual(["retry"]);
}, 60000);

it("漏收 ended 后 sent 可经二次确认调用 retry，转 uncertain 后须先核对移出", async () => {
  const f = fixture({ ...emptyQueue(), items: [item("last", "sent"), item("next")], waitingReason: "原 Agent 已空闲，请核对后手动恢复" });
  const idle = { paseoAssignment: { ...assignment, status: "idle" as const }, paseoPresentation: { ...presentation, status: "idle" as const } };
  const view = render(f.ui(idle));
  await waitFor(() => expect(view.getByRole("button", { name: "恢复队列" })).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "恢复队列" }));
  expect(f.events).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "打开原会话" }));
  expect(f.openAgent).toHaveBeenCalledWith(assignment.agentId);
  f.request.mockImplementationOnce(async (input) => {
    expect(input).toEqual({ action: "retry", taskId: task.id });
    f.events.push("retry");
    return { ...emptyQueue(), items: [item("last", "uncertain"), item("next")], pauseReason: "请核对发送待确认项" };
  });
  fireEvent.click(view.getByRole("button", { name: "已核对原会话结束，恢复队列" }));
  await waitFor(() => expect(view.getByText("发送待确认")).toBeTruthy());
  expect(f.events).toEqual(["retry"]);
  expect((view.getByRole("button", { name: "恢复队列" }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.getByRole("button", { name: "核对后移出" })).toBeTruthy();
}, 60000);

it("仅 queued 的旧 wait 可直接手动恢复，运行中和权限等待不提供恢复入口", async () => {
  const f = fixture({ ...emptyQueue(), items: [item("next")], waitingReason: "原 Agent 已空闲，请核对后手动恢复" });
  const view = render(f.ui());
  await waitFor(() => expect(view.getByText("待处理 1 条")).toBeTruthy());
  expect(view.queryByRole("button", { name: "恢复队列" })).toBeNull();
  view.rerender(f.ui({ paseoPresentation: { ...presentation, status: "idle", requiresAttention: true, attentionReason: "permission" } }));
  expect(view.queryByRole("button", { name: "恢复队列" })).toBeNull();
  view.rerender(f.ui({ paseoPresentation: { ...presentation, status: "idle" } }));
  fireEvent.click(view.getByRole("button", { name: "恢复队列" }));
  await waitFor(() => expect(f.events).toEqual(["retry"]));
  expect(view.queryByRole("button", { name: "已核对原会话结束，恢复队列" })).toBeNull();
}, 60000);

it("4 秒稳定 ID 轮询不重入、不清草稿，旧 list 不覆盖取消结果", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const f = fixture({ ...emptyQueue(), items: [item("first")] });
  const view = render(f.ui());
  await ready(view);
  const slow = deferred<PaseoCommentQueueState>();
  f.listOverride(() => slow.promise);
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
  expect(f.request.mock.calls.filter(([input]) => input.action === "list")).toHaveLength(2);
  view.rerender(f.ui({ paseoAssignment: { ...assignment } }));
  await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
  expect(f.request.mock.calls.filter(([input]) => input.action === "list")).toHaveLength(2);
  expect(view.getByText("待处理 1 条")).toBeTruthy();
  expect((view.getByLabelText("留下评论") as HTMLTextAreaElement).value).toBe("请继续修复");
  fireEvent.click(view.getByRole("button", { name: "取消排队" }));
  await waitFor(() => expect(view.queryByText("排队正文 first")).toBeNull());
  await act(async () => slow.resolve({ ...emptyQueue(), items: [item("first")] }));
  expect(view.queryByText("排队正文 first")).toBeNull();
}, 60000);

it("切任务取消旧 list，迟到结果不能进入新任务", async () => {
  const f = fixture();
  const slow = deferred<PaseoCommentQueueState>();
  f.listOverride(() => slow.promise);
  const view = render(f.ui());
  const oldSignal = f.request.mock.calls[0][1]!;
  f.listOverride(null);
  view.rerender(f.ui({ task: { ...task, id: "other-task", identifier: "QUEUE-2" }, paseoAssignment: { ...assignment, taskId: "other-task" } }));
  await waitFor(() => expect(f.request).toHaveBeenCalledWith({ action: "list", taskId: "other-task" }, expect.any(AbortSignal)));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => slow.resolve({ ...emptyQueue(), items: [item("old")] }));
  expect(view.queryByText("排队正文 old")).toBeNull();
}, 60000);

it("队列初始化错误明确展示，不伪装空队列或放行 idle 续聊", async () => {
  const f = fixture();
  f.listOverride(async () => { throw new Error("initError: 队列文件读取失败"); });
  const view = render(f.ui({ task: { ...task, status: "in_review" }, paseoAssignment: { ...assignment, status: "idle" }, paseoPresentation: { ...presentation, status: "idle" } }));
  await waitFor(() => expect(within(view.getByRole("alert")).getByText(/initError/)).toBeTruthy());
  expect(view.queryByText("待处理 0 条")).toBeNull();
  fireEvent.change(view.getByLabelText("留下评论"), { target: { value: "保留草稿" } });
  expect((view.getByRole("button", { name: "评论并继续处理" }) as HTMLButtonElement).disabled).toBe(true);
  expect((view.getByRole("button", { name: "评论", exact: true }) as HTMLButtonElement).disabled).toBe(false);
}, 60000);
