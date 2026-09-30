import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DescriptionDocument } from "../web/src/components/DescriptionDocument";
import { TaskDetail } from "../web/src/components/TaskDetail";
import { TaskboardLanguageProvider } from "../web/src/i18n";
import { createBindingsStore } from "../integrations/paseo/server/bindings.ts";
import { createSettingsStore } from "../integrations/paseo/server/settings.ts";
import { createTaskPlansStore } from "../integrations/paseo/server/task-plans.ts";
import { registerHandlers } from "../integrations/paseo/server/handlers.ts";
import * as contracts from "../integrations/paseo/shared/contracts.ts";

const { createTaskboardServer } = createRequire(path.join(process.cwd(), "package.json"))("./server/app.mjs");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
const reportedUrl = "file:///D:/%E8%84%9A%E6%9C%AC%E7%A8%8B%E5%BA%8F/%E5%BC%80%E6%BA%90%E7%A8%8B%E5%BA%8F%E4%BA%8C%E5%BC%80/tokens-pro-tok-1-rename/output/playwright/tok1-desktop.png";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("TOK-1 原始 file URL 只生成受控图片请求，普通正文不放行 file", async () => {
  const base = document.createElement("base");
  base.href = "https://paseo-taskboard.invalid/?host=paseo"; document.head.append(base);
  const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:tok1" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  const fetchImage = vi.fn(async () => new Response(png, { headers: { "content-type": "image/png" } }));
  vi.stubGlobal("fetch", fetchImage);
  const urls = [reportedUrl, reportedUrl.replace("tok1-desktop", "tok1-mobile"), reportedUrl.replace("tok1-desktop", "tok1-login-mobile")];
  const body = `已完成：\n${urls.map((url) => `![Image](${url})`).join("\n")}`;
  try {
    const props = { value: body, referenceTasks: [], onOpenTask: vi.fn(), enableImagePreview: true };
    const view = render(<DescriptionDocument {...props} agentCommentImageContext={{ taskId: "d658249f-cd1e-4757-822a-529a3a4a0933", commentId: "8ae23f37-dff8-4244-a900-641710d43784", version: 1 }} />);
    await waitFor(() => expect(view.getAllByRole("img").every((image) => image.getAttribute("src") === "blob:tok1")).toBe(true));
    expect(fetchImage).toHaveBeenCalledTimes(3);
    expect(fetchImage.mock.calls.map(([url]) => String(url))).toEqual([...body.matchAll(/!\[Image\]/g)].map((match) => `https://paseo-taskboard.invalid/api/paseo/tasks/d658249f-cd1e-4757-822a-529a3a4a0933/comments/8ae23f37-dff8-4244-a900-641710d43784/images/${match.index}?version=1`));
    fireEvent.click(view.getAllByRole("img")[0]);
    expect(within(view.getByRole("dialog")).getByRole("img").getAttribute("src")).toBe("blob:tok1");
    fireEvent.click(view.getByRole("button", { name: "Close image preview" }));
    expect(view.queryByRole("dialog")).toBeNull();
    view.unmount(); fetchImage.mockClear();
    const plain = render(<DescriptionDocument {...props} />);
    expect([...plain.container.querySelectorAll("img")].every((image) => !image.getAttribute("src"))).toBe(true);
    expect(fetchImage).not.toHaveBeenCalled(); plain.unmount();
    base.href = "https://ordinary-taskboard.invalid/";
    const ordinary = render(<DescriptionDocument {...props} agentCommentImageContext={{ taskId: "t", commentId: "c", version: 1 }} />);
    expect([...ordinary.container.querySelectorAll("img")].every((image) => !image.getAttribute("src"))).toBe(true);
    expect(fetchImage).not.toHaveBeenCalled();
  } finally {
    cleanup(); base.remove();
    if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate); else Reflect.deleteProperty(URL, "createObjectURL");
    if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke); else Reflect.deleteProperty(URL, "revokeObjectURL");
  }
}, 60000);

it("TaskDetail 精确匹配旧消息后最终结果置顶，三图仍按原偏移加载并打开大图，数据不变", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-comment-images-ui-"));
  const app = createTaskboardServer({ dataDirectory: directory, databasePath: path.join(directory, "db.sqlite"), attachmentsDirectory: path.join(directory, "attachments"), staticDirectory: directory });
  const { port } = await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${port}`;
  const previous = process.env.DASHI_TASKBOARD_URL; process.env.DASHI_TASKBOARD_URL = origin;
  const base = document.createElement("base"); base.href = "https://paseo-taskboard.invalid/?host=paseo"; document.head.append(base);
  const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const nativeFetch = globalThis.fetch;
  const blobs: Blob[] = [];
  const revoked = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => { blobs.push(blob); return `blob:actual-${blobs.length}`; } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoked });
  try {
    const paths = await Promise.all(["tok1-desktop.png", "tok1-mobile.png", "tok1-login-mobile.png"].map(async (name) => {
      const file = path.join(directory, "脚本程序", "开源程序二开", "tokens-pro-tok-1-rename", "output", "playwright", name);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, png); return pathToFileURL(file).href;
    }));
    const user = { type: "user", id: "image-reader", name: "用户", avatarUrl: null };
    const agent = { type: "agent", id: "paseo-agent", name: "Paseo Agent", avatarUrl: null };
    const task = app.database.createTask({ projectId: "local", title: "评论图片贯通", description: "原描述", status: "in_review", priority: "none", labels: [], actor: user, assignee: user, threadId: null, developmentContext: null, startDate: null, dueDate: null, recurrence: null });
    const progress = "收到，先处理\n\n- 第一项\n- 第二项\n\n---\n\n```txt\n第一行\n第二行\n```\n";
    const images = `🖼️ 本轮截图：\n${paths.map((file) => `![Image](${file})`).join("\n")}`;
    const final = "**TOK-1 已完成**\n\n- 最终结果一\n- 最终结果二";
    const body = `${progress}${images}\n\n${final}`;
    const comment = app.database.createComment(task.id, { body, actor: agent, threadId: null });
    const manual = app.database.createComment(task.id, { body: "手写第一段\n\n---\n\n手写第二段", actor: user, threadId: null });
    const before = JSON.stringify({ task: app.database.getTask(task.id), comments: app.database.listComments(task.id) });
    const handlers = new Map();
    const bindings = createBindingsStore({ filePath: path.join(directory, "bindings.json") });
    await bindings.upsert({ taskId: task.id, taskIdentifier: task.identifier, projectId: task.projectId, workspaceId: "workspace", agentId: "original-agent", provider: "mock" });
    const refetch = vi.fn(async () => ({ error: null, gap: false, staleCursor: false, epoch: "epoch", hasOlder: false, startCursor: null, entries: [
      { item: { type: "user_message", text: "原轮" } },
      { item: { type: "assistant_message", text: progress, messageId: "progress" } },
      { item: { type: "assistant_message", text: images } },
      { item: { type: "assistant_message", text: final, messageId: "final" } },
      { item: { type: "user_message", text: "已经开始后续工作" } },
      { item: { type: "assistant_message", text: "新轮不可覆盖旧评论", messageId: "later" } },
    ] }));
    const paseo = { agents: { ref: (id) => { expect(id).toBe("original-agent"); return { timeline: { refetch } }; } } };
    registerHandlers({ handle: (contract, handler) => handlers.set(contract.name, handler) },
      bindings, createSettingsStore({ filePath: path.join(directory, "settings.json") }), createTaskPlansStore({ filePath: path.join(directory, "plans.json") }));
    const imageRequests: string[] = [];
    vi.stubGlobal("fetch", async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin !== "https://paseo-taskboard.invalid") return nativeFetch(input, init);
      if (url.pathname.startsWith("/api/paseo/")) imageRequests.push(url.pathname);
      const result = await handlers.get(contracts.bridgeRequest.name)({ method: init.method ?? "GET", path: url.pathname + url.search, headers: {}, body: null }, { paseo });
      return new Response(result.body.kind === "base64" ? Buffer.from(result.body.value, "base64") : JSON.stringify(result.body.value), { status: result.status, headers: result.headers });
    });
    const view = render(<TaskboardLanguageProvider language="zh"><TaskDetail
      task={task} tasks={[task]} referenceTasks={[task]} currentUser={user} availableLabels={[]}
      developmentScan={{ workspacePath: null, contexts: [] }} developmentScanLoading={false} commentsRevision={0} attachmentsRevision={0}
      onCreateLabel={vi.fn()} onDeleteLabel={vi.fn()} onUpdate={vi.fn()} onOpenTask={vi.fn()} onAddRelation={vi.fn()} onRemoveRelation={vi.fn()}
      onOpenThread={vi.fn()} onOpenLegacyLocalThread={vi.fn()} onOpenInThread={vi.fn()} onCopy={vi.fn()} onCopyIssueLink={vi.fn()} openingThread={false} onError={vi.fn()}
    /></TaskboardLanguageProvider>);
    await waitFor(() => expect(view.getAllByRole("img", { name: "Image" }).every((image) => image.getAttribute("src")?.startsWith("blob:actual-"))).toBe(true), { timeout: 10000 });
    expect(imageRequests).toHaveLength(3); expect(blobs).toHaveLength(3);
    expect(imageRequests).toEqual([...body.matchAll(/!\[Image\]/g)].map((match) => `/api/paseo/tasks/${task.id}/comments/${comment.id}/images/${match.index}`));
    const displayed = view.container.querySelector(`#comment-${comment.id} .comment-body`)!;
    expect(displayed.firstElementChild!.textContent).toContain("TOK-1 已完成");
    expect(displayed.lastElementChild!.textContent).toContain("收到，先处理");
    expect(displayed.querySelector("code")!.textContent).toBe("第一行\n第二行\n");
    const hand = view.container.querySelector(`#comment-${manual.id} .comment-body`)!;
    expect(hand.children).toHaveLength(1);
    expect(hand.textContent!.indexOf("手写第一段")).toBeLessThan(hand.textContent!.indexOf("手写第二段"));
    for (let index = 0; index < 3; index += 1) {
      await handlers.get(contracts.bridgeRequest.name)({ method: "GET", path: `/api/tasks/${task.id}/comments`, headers: {}, body: null }, { paseo });
    }
    expect(refetch).toHaveBeenCalledTimes(1);
    for (const blob of blobs) {
      expect(blob.type).toBe("image/png");
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
      });
      expect(Buffer.from(bytes)).toEqual(png);
    }
    const image = view.getAllByRole("img", { name: "Image" })[0];
    fireEvent.click(image);
    expect(within(view.getByRole("dialog", { name: "Image" })).getByRole("img").getAttribute("src")).toBe(image.getAttribute("src"));
    fireEvent.keyDown(window, { key: "Escape" }); expect(view.queryByRole("dialog", { name: "Image" })).toBeNull();
    expect(JSON.stringify({ task: app.database.getTask(task.id), comments: app.database.listComments(task.id) })).toBe(before);
    expect(app.database.getComment(comment.id).attachments).toEqual([]);
    view.unmount(); expect(revoked).toHaveBeenCalledTimes(3);
  } finally {
    cleanup(); vi.unstubAllGlobals(); base.remove();
    if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate); else Reflect.deleteProperty(URL, "createObjectURL");
    if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke); else Reflect.deleteProperty(URL, "revokeObjectURL");
    if (previous === undefined) delete process.env.DASHI_TASKBOARD_URL; else process.env.DASHI_TASKBOARD_URL = previous;
    await app.close();
    expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir())); expect(path.basename(directory).startsWith("paseo-comment-images-ui-")).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
