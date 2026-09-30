import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TaskCard } from "../web/src/components/TaskCard";
import { TaskboardLanguageProvider } from "../web/src/i18n";
import { taskCardPresentation, type PaseoAgentPresentation } from "../web/src/taskConversations";
import type { Task } from "../web/src/types";

const user = { type: "user" as const, id: "card-user", name: "参与人", avatarUrl: null };
const task: Task = {
  id: "running-card", identifier: "CARD-1", projectId: "local", title: "运行状态验证",
  description: "", status: "blocked", priority: "none", labels: [], sortOrder: 0,
  threadId: null, threadBinding: null, legacyLocalThreadId: null, conversationRefs: [],
  participants: [user], previewImage: null, activityKey: "card-1", activityUpdatedAt: "2026-09-23T00:00:00Z",
  creatorType: "user", creatorId: user.id, creatorName: user.name, creatorAvatarUrl: null,
  assignee: user, developmentContext: null, startDate: null, dueDate: null, recurrence: null,
  source: "local", externalUrl: null, archivedAt: null,
  relations: { parent: null, subIssues: [], related: [], blocks: [], blockedBy: [] },
  version: 1, createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z",
};
const agent: PaseoAgentPresentation = {
  agentId: "mock-agent", status: "running", requiresAttention: false,
  attentionReason: null, title: "运行中的会话", updatedAt: null,
};
let base: HTMLBaseElement;

beforeEach(() => {
  base = document.createElement("base");
  base.href = "https://paseo-taskboard.invalid/?host=paseo";
  document.head.append(base);
});

afterEach(() => { cleanup(); base.remove(); });

function card(current: Task = task, currentAgent = agent) {
  const presentation = taskCardPresentation(current, [], false, null, null, undefined, currentAgent);
  return <TaskboardLanguageProvider language="zh">
    <TaskCard task={current} presentation={presentation}
      isDragging={false} dragShift={0} isMoving={false} isSettling={false} isContextMenuOpen={false}
      availableLabels={[]} currentUser={user} showCover={false} showBody={false}
      onCreateLabel={vi.fn()} onEdit={vi.fn()} onUpdate={vi.fn()} onContextMenu={vi.fn()}
      onDragStart={vi.fn()} onDragEnd={vi.fn()} onOpenConversation={vi.fn()} />
  </TaskboardLanguageProvider>;
}

it("Paseo 旧 blocked 但真实运行时显示动画行并隐藏参与头像", () => {
  const view = render(card());
  expect(view.container.querySelector(".task-card.is-processing-card.is-running-card")).not.toBeNull();
  expect(view.container.querySelector(".task-processing-row.is-running .task-processing-glyph")).not.toBeNull();
  expect(view.container.querySelector(".task-participants")).toBeNull();
  expect(view.getByText("正在处理...")).toBeTruthy();
  expect(task.status).toBe("blocked");
}, 60000);

it("Paseo 旧 in_review 但等待权限时显示授权提示而非运行动画", () => {
  const view = render(card({ ...task, status: "in_review" }, {
    ...agent, requiresAttention: true, attentionReason: "permission",
  }));
  expect(view.container.querySelector(".task-card.is-processing-card")).not.toBeNull();
  expect(view.container.querySelector(".task-processing-row.is-awaiting-permission")).not.toBeNull();
  expect(view.getByText("等待你的授权")).toBeTruthy();
  expect(view.container.querySelector(".task-processing-glyph")).toBeNull();
  expect(view.container.querySelector(".task-participants")).toBeNull();
}, 60000);

it("Paseo 旧 blocked 且空闲时不显示运行外观", () => {
  const view = render(card(task, { ...agent, status: "idle" }));
  expect(view.container.querySelector(".is-processing-card, .task-processing-row, .task-processing-glyph")).toBeNull();
  expect(view.container.querySelector(".task-participants")).not.toBeNull();
}, 60000);

it("原 in_progress 卡片保留运行和暂停外观", () => {
  const current = { ...task, status: "in_progress" as const };
  const view = render(card(current));
  expect(view.container.querySelector(".task-processing-glyph")).not.toBeNull();
  view.rerender(card(current, { ...agent, status: "idle" }));
  expect(view.container.querySelector(".is-processing-card .task-processing-row.is-paused")).not.toBeNull();
  expect(view.getByText("暂停处理")).toBeTruthy();
  expect(view.container.querySelector(".task-processing-glyph")).toBeNull();
}, 60000);

it("非 Paseo 宿主仍仅按持久 in_progress 状态启用处理中外观", () => {
  base.href = "https://taskboard.example/";
  const view = render(card());
  expect(view.container.querySelector(".is-processing-card, .task-processing-glyph")).toBeNull();
  expect(view.container.querySelector(".task-participants")).not.toBeNull();
  view.rerender(card({ ...task, status: "in_progress" }));
  expect(view.container.querySelector(".is-processing-card .task-processing-glyph")).not.toBeNull();
}, 60000);

it("终态和归档卡片不因 Paseo 运行快照重新进入处理中外观", () => {
  for (const current of [
    { ...task, status: "done" as const },
    { ...task, status: "canceled" as const },
    { ...task, archivedAt: "2026-09-23T01:00:00Z" },
  ]) {
    const view = render(card(current));
    expect(view.container.querySelector(".is-processing-card, .task-processing-row, .task-processing-glyph")).toBeNull();
    view.unmount();
  }
}, 60000);
