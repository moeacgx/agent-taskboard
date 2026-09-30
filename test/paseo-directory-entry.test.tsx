import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TaskDetail } from "../web/src/components/TaskDetail";
import { TaskboardLanguageProvider } from "../web/src/i18n";
import type { Task } from "../web/src/types";
import * as api from "../web/src/api";

vi.mock("../web/src/api", async (original) => ({
  ...await original<typeof api>(),
  listComments: vi.fn(async () => []), listAttachments: vi.fn(async () => []), listTaskActivities: vi.fn(async () => []),
  inspectPaseoWorktree: vi.fn(), createPaseoWorktree: vi.fn(),
}));
// 本测试只操作目录入口；保留真实 TaskDetail、Worktree 选择器及保存路径。
vi.mock("../web/src/components/InlineMediaComposer", async () => {
  const React = await import("react");
  return { InlineMediaComposer: React.forwardRef((_props, ref) => {
    React.useImperativeHandle(ref, () => ({ focus() {} }));
    return null;
  }) };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("已有目录入口打开本地模式并保存所选目录，Worktree 入口仍打开新建模式", async () => {
  const base = document.createElement("base");
  base.href = "https://paseo-taskboard.invalid/?host=paseo"; document.head.append(base);
  const user = { type: "user" as const, id: "directory-user", name: "用户", avatarUrl: null };
  const now = "2026-09-30T00:00:00Z";
  const task: Task = {
    id: "directory-task", identifier: "DIR-1", projectId: "local", title: "目录入口验证", description: "",
    status: "todo", priority: "none", labels: [], sortOrder: 0, threadId: null,
    threadBinding: null, legacyLocalThreadId: null, conversationRefs: [], participants: [user],
    previewImage: null, activityKey: "directory-1", activityUpdatedAt: now,
    creatorType: "user", creatorId: user.id, creatorName: user.name, creatorAvatarUrl: null,
    assignee: user, developmentContext: null, startDate: null, dueDate: null, recurrence: null,
    source: "local", externalUrl: null, archivedAt: null,
    relations: { parent: null, subIssues: [], related: [], blocks: [], blockedBy: [] },
    version: 1, createdAt: now, updatedAt: now,
  };
  const openExecution = vi.fn();
  const saveDirectory = vi.fn(async () => {});
  const onCreated = vi.fn();
  const refresh = vi.fn();
  vi.mocked(api.inspectPaseoWorktree).mockResolvedValue({ workspacePath: "C:/existing-one", gitRoot: "C:/existing-one",
    isGitRoot: true, head: "main", defaultBranch: "refs/heads/main", branches: ["main"], remoteBranches: [], worktrees: [], error: null });
  const props: ComponentProps<typeof TaskDetail> = {
    task, tasks: [task], referenceTasks: [task], currentUser: user, availableLabels: [],
    developmentScan: { workspacePath: null, contexts: [] }, developmentScanLoading: false, commentsRevision: 0, attachmentsRevision: 0,
    onCreateLabel: vi.fn(), onDeleteLabel: vi.fn(), onUpdate: vi.fn(), onOpenTask: vi.fn(), onAddRelation: vi.fn(), onRemoveRelation: vi.fn(),
    onOpenThread: vi.fn(), onOpenLegacyLocalThread: vi.fn(), onOpenInThread: vi.fn(), onCopy: vi.fn(), onCopyIssueLink: vi.fn(), openingThread: false, onError: vi.fn(),
    paseoAssignment: { kind: "planned", taskId: task.id, workspacePath: "C:/existing-one", profile: null },
    paseoExecutionConfig: { onOpen: openExecution },
    paseoWorktree: { workspaces: [
      { id: "one", name: "项目一", path: "C:/existing-one", kind: "project", projectWorkspace: true },
      { id: "two", name: "项目二", path: "C:/existing-two", kind: "project", projectWorkspace: true },
    ], onRefresh: refresh, onCreated, onSaveDirectory: saveDirectory },
  };
  try {
    const view = render(<TaskboardLanguageProvider language="zh"><TaskDetail {...props} /></TaskboardLanguageProvider>);
    fireEvent.click(view.getByRole("button", { name: "选择已有代码目录" }));
    expect(openExecution).not.toHaveBeenCalled();
    expect(view.getByRole("button", { name: "工作目录方式" }).textContent).toBe("本地");
    expect(api.inspectPaseoWorktree).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "代码项目" }));
    fireEvent.click(view.getByRole("option", { name: /项目二/ }));
    fireEvent.click(view.getByRole("button", { name: "保存目录" }));
    await waitFor(() => expect(saveDirectory).toHaveBeenCalledWith("C:/existing-two"));
    await waitFor(() => expect(view.queryByRole("button", { name: "保存目录" })).toBeNull());
    expect(api.createPaseoWorktree).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "本地 / 新建 Worktree" }));
    expect(view.getByRole("button", { name: "工作目录方式" }).textContent).toBe("新建 worktree");
    await waitFor(() => expect(api.inspectPaseoWorktree).toHaveBeenCalledWith("C:/existing-one"));
    // 选择器已经打开时切回已有目录，仍以本地模式打开，不继承上一次 Worktree 模式。
    fireEvent.click(view.getByRole("button", { name: "选择已有代码目录" }));
    expect(view.getByRole("button", { name: "工作目录方式" }).textContent).toBe("本地");
    expect(openExecution).not.toHaveBeenCalled();
    expect(api.createPaseoWorktree).not.toHaveBeenCalled();
  } finally { cleanup(); base.remove(); }
}, 60000);
