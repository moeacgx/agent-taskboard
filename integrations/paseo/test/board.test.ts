import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOARD_COLUMNS,
  boardColumnForStatus,
  calculateDropSortOrder,
  isMainBoardStatus,
  orderBoardTasks,
} from "../client/board.ts";
import { compactAgentComment, displayCommentBody } from "../shared/agent-comment.ts";
import type { Task } from "../shared/contracts.ts";

function task(id: string, status: Task["status"], sortOrder: number): Task {
  return {
    id,
    identifier: id,
    projectId: "project",
    title: id,
    description: "",
    status,
    priority: "none",
    labels: [],
    sortOrder,
    creatorType: "user",
    creatorId: "user",
    creatorName: "User",
    assignee: { type: "user", id: "user", name: "User", avatarUrl: null },
    developmentContext: null,
    source: "local",
    archivedAt: null,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("maps all persisted statuses into the three board columns", () => {
  assert.equal(BOARD_COLUMNS.length, 3);
  assert.equal(boardColumnForStatus("backlog"), "ideas");
  assert.equal(boardColumnForStatus("todo"), "ideas");
  assert.equal(boardColumnForStatus("in_progress"), "processing");
  assert.equal(boardColumnForStatus("blocked"), "processing");
  assert.equal(boardColumnForStatus("in_review"), "review");
  assert.equal(boardColumnForStatus("done"), null);
  assert.equal(boardColumnForStatus("canceled"), null);
  assert.equal(isMainBoardStatus("done"), false);
  assert.equal(isMainBoardStatus("canceled"), false);
});

test("calculates API sortOrder for top, middle, bottom, and empty drops", () => {
  assert.equal(calculateDropSortOrder([], 0), 1000);
  assert.equal(calculateDropSortOrder([task("a", "todo", 1000)], 0), 0);
  assert.equal(calculateDropSortOrder([task("a", "todo", 1000), task("b", "todo", 3000)], 1), 2000);
  assert.equal(calculateDropSortOrder([task("a", "todo", 1000)], 1), 2000);
});

test("orders tasks by column then persisted sortOrder", () => {
  const result = orderBoardTasks([
    task("review", "in_review", 1),
    task("idea", "todo", 3),
    task("processing", "in_progress", 2),
  ]);
  assert.deepEqual(result.map((item) => item.id), ["idea", "processing", "review"]);
});

test("agent comments retain only the actual reply and strictly unwrap known legacy envelopes", () => {
  assert.equal(compactAgentComment("completed", "你好"), "你好");
  assert.equal(compactAgentComment("completed", ""), "本轮无文本回复");
  assert.equal(compactAgentComment("failed", "部分实际回复", "请求被拒绝"), "错误: 请求被拒绝\n\n部分实际回复");

  const current = [
    "✅ Agent 本轮运行已完成，请查看当前任务状态并验收。",
    "Agent: agent-id（codex/gpt-5.6-sol）",
    "",
    "你好",
    "",
    "验收通过后请手动将任务移至 done；插件不会自动完成任务。",
  ].join("\n");
  assert.equal(displayCommentBody("paseo-agent", current), "你好");

  const legacy = [
    "✅ Paseo agent 完成一轮运行，任务已置为待验收（in_review）。",
    "工作区: workspace-id",
    "Agent: agent-id（codex/gpt-5.6-sol）",
    "",
    "你好",
    "",
    "验收通过后请手动将任务移至 done；插件不会自动完成任务。",
  ].join("\n");
  assert.equal(displayCommentBody("paseo-agent", legacy), "你好");
  assert.equal(displayCommentBody("paseo-plugin", current), current, "人工评论必须原样保留");
  assert.equal(displayCommentBody("paseo-agent", "Agent: 这是实际回复"), "Agent: 这是实际回复");
});
