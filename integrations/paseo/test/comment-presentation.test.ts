import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { latestAssistantText, assistantMessageTexts } from "../shared/timeline-text.ts";
import { createBindingsStore } from "../server/bindings.ts";
import { createCommentPresentationReader, matchedCommentMessageRanges } from "../server/comment-presentation.ts";

test("可靠消息倒序，同消息碎片/无 ID 图片仍相邻，内部清单代码和分隔线不拆", { timeout: 60_000 }, () => {
  const progress = "收到\n\n- 第一项\n- 第二项\n\n---\n\n```txt\n甲\n乙\n```";
  const image = "\n![Image](file:///D:/%E5%9B%BE/tok1-desktop.png)";
  const final = "**TOK-1 已完成**\n\n1. 最终一\n2. 最终二";
  const timeline: AgentTimelineItem[] = [
    { type: "user_message", text: "执行" },
    { type: "assistant_message", messageId: "p", text: progress },
    { type: "assistant_message", text: image },
    { type: "assistant_message", messageId: "p", text: "\n同条消息尾部" },
    { type: "assistant_message", messageId: "f", text: final.slice(0, 8) },
    { type: "assistant_message", messageId: "f", text: final.slice(8) },
  ];
  assert.equal(latestAssistantText(timeline), `${final}\n\n${progress}${image}\n同条消息尾部`);
  assert.equal(latestAssistantText([{ type: "assistant_message", text: progress }, { type: "assistant_message", text: image }]), progress + image);
  const long: AgentTimelineItem[] = [
    { type: "assistant_message", messageId: "p", text: "早期进度".repeat(2000) },
    { type: "assistant_message", messageId: "f", text: final },
  ];
  assert.ok(latestAssistantText(long).startsWith(final));
  assert.ok(latestAssistantText(long).endsWith("…（回复过长，已截断）"));
});

test("旧评论只按历史原文精确匹配，返回原文偏移；不猜手写分隔线，旧包装仍定位同张图", { timeout: 60_000 }, () => {
  const messages = ["\n\n---\n\n收到\n![Image](file:///D:/one.png)", "\n\n---\n\n完成\n- A\n- B"];
  const original = messages.join("\n\n").trim();
  const ranges = matchedCommentMessageRanges(original, [messages])!;
  assert.equal(original.slice(ranges[0].start, ranges[0].end), messages[1]);
  assert.equal(original.slice(ranges[1].start, ranges[1].end), messages[0].trimStart());
  const localOffset = original.slice(ranges[1].start, ranges[1].end).indexOf("![Image]");
  assert.equal(ranges[1].start + localOffset, original.indexOf("![Image]"));
  assert.equal(matchedCommentMessageRanges(`${original}\n人工编辑`, [messages]), null);
  assert.equal(matchedCommentMessageRanges(original, [[original]]), null);
  const wrapper = `✅ Agent 本轮运行已完成，请查看当前任务状态并验收。\nAgent: real-agent\n\n${original}\n\n验收通过后请手动将任务移至 done；插件不会自动完成任务。`;
  const wrapped = matchedCommentMessageRanges(wrapper, [messages])!;
  assert.equal(wrapper.slice(wrapped[0].start, wrapped[0].end), messages[1]);
  assert.equal(wrapped[1].start + localOffset, wrapper.indexOf("![Image]"));
});

test("只读匹配指定绑定 Agent 的旧轮，评论轮询复用缓存，手写和新倒序评论不改写", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-comment-order-"));
  try {
    const bindings = createBindingsStore({ filePath: path.join(directory, "bindings.json") });
    await bindings.upsert({ taskId: "task", taskIdentifier: "TOK-1", projectId: "project", workspaceId: "workspace", agentId: "original-agent", provider: "mock" });
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "TOK-1 原轮" },
      { type: "assistant_message", text: "收到", messageId: "m1" },
      { type: "assistant_message", text: "\n![Image](file:///D:/image.png)" },
      { type: "assistant_message", text: "TOK-1 完成", messageId: "m2" },
      { type: "user_message", text: "无关的新轮" },
      { type: "assistant_message", text: "继续新需求", messageId: "new" },
    ];
    const oldBody = assistantMessageTexts(timeline.slice(1, 4)).join("\n\n").trim();
    let fetches = 0;
    const paseo = { agents: { ref: (agentId: string) => {
      assert.equal(agentId, "original-agent");
      return { timeline: { refetch: async (input: any) => {
        assert.equal(input.projection, "canonical"); fetches += 1;
        return { error: null, gap: false, staleCursor: false, epoch: "epoch", hasOlder: false, startCursor: null,
          entries: timeline.map((item) => ({ item })) };
      } } };
    } } } as unknown as PaseoApi;
    const comments = [
      { id: "old", taskId: "task", authorId: "paseo-agent", body: oldBody, version: 1 },
      { id: "hand", taskId: "task", authorId: "user", body: oldBody, version: 1 },
      { id: "new", taskId: "task", authorId: "paseo-agent", body: latestAssistantText(timeline.slice(0, 4)), version: 1 },
    ];
    const before = JSON.stringify(comments);
    const decorate = createCommentPresentationReader(bindings);
    const [result] = await Promise.all([decorate(paseo, "task", comments), decorate(paseo, "task", comments)]);
    for (let index = 0; index < 4; index += 1) await decorate(paseo, "task", comments);
    assert.equal(fetches, 1);
    const first = result[0].paseoMessageRanges![0];
    assert.equal(result[0].body.slice(first.start, first.end), "TOK-1 完成");
    assert.equal(result[1].paseoMessageRanges, undefined);
    assert.equal(result[2].paseoMessageRanges, undefined);
    assert.equal(JSON.stringify(comments), before);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("paseo-comment-order-"));
    await rm(directory, { recursive: true, force: true });
  }
});
