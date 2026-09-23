import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { cleanup, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TaskCard } from "../web/src/components/TaskCard";
import { TaskboardLanguageProvider } from "../web/src/i18n";

// 数据库按 Node 原生路径载入，避免 Vite 打包 node:sqlite。
const { TaskboardDatabase } = createRequire(path.join(process.cwd(), "package.json"))("./server/database.mjs");

it("临时数据库的最新评论贯通 Paseo 卡片默认预览", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "taskboard-latest-card-preview-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const base = document.createElement("base");
  base.href = "https://paseo-taskboard.invalid/?host=paseo";
  document.head.append(base);
  const user = { type: "user", id: "preview-user", name: "用户", avatarUrl: null };
  const agent = { type: "agent", id: "preview-agent", name: "Agent", avatarUrl: null };
  const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:verified-image" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const fetchImage = vi.fn().mockImplementation(async () => new Response(new Blob(["image"]), { status: 200 }));
  vi.stubGlobal("fetch", fetchImage);
  try {
    database.createProject({ id: "latest-preview", name: "预览验证", workspacePath: null });
    const task = database.createTask({
      projectId: "latest-preview", title: "原标题保持", description: "原描述 ![A](api/attachments/image-a/content)",
      status: "todo", priority: "none", labels: [], threadId: null, actor: user, assignee: user,
      developmentContext: null, startDate: null, dueDate: null, recurrence: null,
    });
    const read = () => {
      const listed = database.listTasks({ projectId: task.projectId }).find((item) => item.id === task.id);
      const detail = database.getTask(task.id);
      expect(listed.latestComment).toEqual(detail.latestComment);
      expect(detail.description).toBe(task.description);
      return listed;
    };
    const props = {
      presentation: { conversations: [], unread: false, workspaceDisplay: null, processing: {
        running: false, awaitingPermission: false, completed: null, total: null, startedAt: null,
      } },
      isDragging: false, dragShift: 0, isMoving: false, isSettling: false, isContextMenuOpen: false,
      availableLabels: [], currentUser: user, showCover: true, showBody: false,
      onCreateLabel: vi.fn(), onEdit: vi.fn(), onUpdate: vi.fn(), onContextMenu: vi.fn(),
      onDragStart: vi.fn(), onDragEnd: vi.fn(), onOpenConversation: vi.fn(),
    };
    const card = (current, showBody = false) => (
      <TaskboardLanguageProvider language="zh">
        <TaskCard {...props} task={current} showBody={showBody} />
      </TaskboardLanguageProvider>
    );
    const assertImage = async (id) => {
      await waitFor(() => expect(document.querySelector(".task-card-media img")?.getAttribute("src")).toBe("blob:verified-image"));
      expect(fetchImage.mock.calls.at(-1)[0]).toBe(`https://paseo-taskboard.invalid/api/attachments/${id}/content`);
    };
    const initial = read();
    expect(initial.latestComment).toBeNull();
    const view = render(card(initial));
    expect(view.container.querySelector("h3")?.textContent).toBe(task.title);
    expect(view.container.querySelector(".task-card-description")).toBeNull();
    await assertImage("image-a");
    view.rerender(card(initial, true));
    expect(view.container.querySelector(".task-card-description")?.textContent).toBe("原描述");

    const first = database.createComment(task.id, { body: "人工进展 ![B](api/attachments/image-b/content)", actor: user });
    database.database.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run("2026-09-20T10:00:00Z", first.id);
    view.rerender(card(read()));
    expect(view.container.querySelector(".task-card-description")?.textContent).toBe("最新回复：人工进展");
    await assertImage("image-b");

    const latest = database.createComment(task.id, { body: "Agent 已完成接口", actor: agent });
    database.database.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run("2026-09-21T10:00:00Z", latest.id);
    const textTask = read();
    expect(textTask.latestComment).toEqual({ body: "Agent 已完成接口", imageId: null });
    view.rerender(card(textTask));
    expect(view.container.querySelector(".task-card-description")?.textContent).toBe("最新回复：Agent 已完成接口");
    expect(view.container.querySelector(".task-card-media")).toBeNull();
    expect(view.container.querySelector("h3")?.textContent).toBe(task.title);

    // 编辑旧评论不能改变按创建时间选出的最新评论。
    database.updateComment(first.id, first.version, "旧评论被编辑", undefined, undefined);
    expect(read().latestComment.body).toBe("Agent 已完成接口");
    const edited = database.updateComment(latest.id, latest.version, "", undefined, undefined);
    database.createCommentAttachment(latest.id, {
      id: "image-c", kind: "inline", filename: "c.png", contentType: "image/png", size: 1,
    });
    const imageOnly = read();
    expect(imageOnly.latestComment).toEqual({ body: "", imageId: "image-c" });
    view.rerender(card(imageOnly));
    expect(view.container.querySelector(".task-card-description")).toBeNull();
    await assertImage("image-c");

    database.moveTask(task.id, task.version, "in_review", undefined, undefined, undefined, user);
    expect(read().latestComment).toEqual(imageOnly.latestComment);
    database.deleteComment(latest.id, edited.version);
    view.rerender(card(read()));
    expect(view.container.querySelector(".task-card-description")?.textContent).toBe("最新回复：旧评论被编辑");
    expect(view.container.querySelector(".task-card-media")).toBeNull();

    const tie = database.createComment(task.id, { body: "同时间评论", actor: agent });
    database.database.prepare("UPDATE comments SET created_at = ? WHERE task_id = ?").run("2026-09-22T10:00:00Z", task.id);
    expect(read().latestComment.body).toBe(tie.id > first.id ? tie.body : "旧评论被编辑");

    // 原版宿主收到可选字段时仍保留自己的描述显示开关与封面。
    base.href = "https://taskboard.example/";
    view.rerender(card(textTask));
    expect(view.container.querySelector(".task-card-description")).toBeNull();
    expect(view.container.querySelector(".task-card-media img")?.getAttribute("src")).toBe("https://taskboard.example/api/attachments/image-a/content");
    database.deleteComment(first.id, database.getComment(first.id).version);
    database.deleteComment(tie.id, tie.version);
    expect(read().latestComment).toBeNull();
    console.log("PASS: list/get 一致；人类/Agent 最新评论；默认 body:false 可见；纯文无旧图；空正文同评论图；编辑/删除；createdAt/id；状态活动排除；原版不变。");
  } finally {
    cleanup();
    database.close();
    base.remove();
    vi.unstubAllGlobals();
    if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("taskboard-latest-card-preview-")) throw new Error("临时目录范围不符");
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
