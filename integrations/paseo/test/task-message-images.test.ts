import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDashiTaskMessageImages } from "../shared/task-message-images.ts";

test("only renders the latest requirement image instead of earlier human history", () => {
  const text = [
    "你正在通过 Paseo 处理 Dashi Taskboard 任务 MAO-1：检查图片",
    "",
    "任务原始描述与具体要求（高于项目公共背景；如与最新人工要求冲突，以最新人工要求为准）：",
    "任务原图：![任务图](api/attachments/task-image/content)",
    "",
    "最新人工要求（本轮最高优先级）：",
    "当前图：![当前图](api/attachments/current-image/content)",
    "",
    "较早人工补充（背景，按时间排序）：",
    "2026-09-23 · 用户\n历史图：![历史图](api/attachments/history-image/content)",
    "",
    "这是 Paseo 插件托管的任务。",
  ].join("\n");

  assert.deepEqual(parseDashiTaskMessageImages(text), {
    images: [{ id: "current-image", filename: "当前图" }],
    text: [
      "你正在通过 Paseo 处理 Dashi Taskboard 任务 MAO-1：检查图片",
      "",
      "任务原始描述与具体要求（高于项目公共背景；如与最新人工要求冲突，以最新人工要求为准）：",
      "任务原图：历史图片：任务图",
      "",
      "最新人工要求（本轮最高优先级）：",
      "当前图：",
      "",
      "较早人工补充（背景，按时间排序）：",
      "2026-09-23 · 用户\n历史图：历史图片：历史图",
      "",
      "这是 Paseo 插件托管的任务。",
    ].join("\n"),
  });
});

test("keeps a text-only latest requirement while replacing historical image markdown", () => {
  const parsed = parseDashiTaskMessageImages([
    "你正在通过 Paseo 处理 Dashi Taskboard 任务 MAO-1：检查图片",
    "",
    "最新人工要求（本轮最高优先级）：",
    "只修改文字。",
    "",
    "较早人工补充（背景，按时间排序）：",
    "2026-09-22 · 用户\n![历史图](api/attachments/history-image/content)",
    "",
    "这是 Paseo 插件托管的任务。",
  ].join("\n"));

  assert.deepEqual(parsed, {
    images: [],
    text: [
      "你正在通过 Paseo 处理 Dashi Taskboard 任务 MAO-1：检查图片",
      "",
      "最新人工要求（本轮最高优先级）：",
      "只修改文字。",
      "",
      "较早人工补充（背景，按时间排序）：",
      "2026-09-22 · 用户\n历史图片：历史图",
      "",
      "这是 Paseo 插件托管的任务。",
    ].join("\n"),
  });
});

test("deduplicates two current images and uses task description only for a first prompt without human requirements", () => {
  const first = parseDashiTaskMessageImages([
    "你正在通过 Paseo 处理 Dashi Taskboard 任务 MAO-1：首次处理",
    "",
    "任务原始描述与具体要求（高于项目公共背景；如与最新人工要求冲突，以最新人工要求为准）：",
    "![手机截图](/api/attachments/mobile_1/content)",
    "![本机截图](http://127.0.0.1:47823/api/attachments/local-2/content)",
    "![重复](https://paseo-taskboard.invalid/api/attachments/mobile_1/content)",
    "",
    "最新人工要求：",
    "（暂无人工补充，按任务原始描述执行）",
  ].join("\n"));

  assert.deepEqual(first?.images, [
    { id: "mobile_1", filename: "手机截图" },
    { id: "local-2", filename: "本机截图" },
  ]);

  const continuation = parseDashiTaskMessageImages([
    "继续处理 Dashi Taskboard 任务 MAO-1：检查图片",
    "",
    "本次最新人工要求（最高优先级）：",
    "![当前一](api/attachments/current-1/content)",
    "![当前二](api/attachments/current-2/content)",
    "",
    "这是 Paseo 插件托管的任务。",
  ].join("\n"));
  assert.deepEqual(continuation?.images, [
    { id: "current-1", filename: "当前一" },
    { id: "current-2", filename: "当前二" },
  ]);
});

test("leaves non-managed messages and messages without trusted current images untouched", () => {
  assert.equal(parseDashiTaskMessageImages(
    "普通用户消息\n![image.png](api/attachments/local/content)",
  ), null);
  assert.equal(parseDashiTaskMessageImages(
    "你正在通过 Paseo 处理 Dashi Taskboard 任务 MAO-1：外链\n![image.png](https://example.com/api/attachments/local/content)",
  ), null);
  assert.equal(parseDashiTaskMessageImages(
    "你正在通过 Paseo 处理 Dashi Taskboard 任务 MAO-1：非法 ID\n![image.png](api/attachments/not%2Flocal/content)",
  ), null);
});
