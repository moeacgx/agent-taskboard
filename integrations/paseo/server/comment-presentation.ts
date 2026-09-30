import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { BindingsStore } from "./bindings.ts";
import { assistantMessageTexts } from "../shared/timeline-text.ts";
import { displayCommentBody } from "../shared/agent-comment.ts";

interface CommentText {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  version: number;
}
export interface CommentMessageRange { start: number; end: number }
type TimelinePage = Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>;

/** 只有完整原文与同一用户消息后的可靠消息分组匹配，才返回倒序区间。 */
export function matchedCommentMessageRanges(body: string, groups: readonly string[][]): CommentMessageRange[] | null {
  const visible = displayCommentBody("paseo-agent", body);
  const prefix = body.indexOf(visible);
  if (!visible || prefix < 0) return null;
  for (const messages of groups) {
    if (messages.length < 2) continue;
    const original = messages.join("\n\n");
    if (original.trim() !== visible) continue;
    const trimStart = original.length - original.trimStart().length;
    const trimEnd = trimStart + visible.length;
    let offset = 0;
    const ranges = messages.map((message) => {
      const start = Math.max(offset, trimStart);
      const end = Math.min(offset + message.length, trimEnd);
      offset += message.length + 2;
      return { start: prefix + start - trimStart, end: prefix + end - trimStart };
    }).filter((range) => range.end > range.start);
    return ranges.length > 1 ? ranges.reverse() : null;
  }
  return null;
}

/** 每任务/Agent 复用有界 canonical 历史；4 秒评论轮询不重复拉取或扫描历史。 */
export function createCommentPresentationReader(bindings: BindingsStore) {
  const cache = new Map<string, {
    agentId: string;
    fetchedAt: number;
    groups: string[][];
    pending: Promise<void> | null;
    results: Map<string, CommentMessageRange[] | null>;
  }>();
  return async function decorate<T extends CommentText>(paseo: PaseoApi, taskId: string, comments: T[]): Promise<Array<T & { paseoMessageRanges?: CommentMessageRange[] }>> {
    if (!comments.some((comment) => comment.authorId === "paseo-agent")) return comments;
    const binding = await bindings.get(taskId);
    if (!binding) return comments;
    let entry = cache.get(taskId);
    if (!entry || entry.agentId !== binding.agentId) {
      if (cache.size >= 32) cache.delete(cache.keys().next().value!);
      entry = { agentId: binding.agentId, fetchedAt: 0, groups: [], pending: null, results: new Map() };
      cache.set(taskId, entry);
    }
    const keys = new Set(comments.map((comment) => `${comment.id}:${comment.version}`));
    for (const key of entry.results.keys()) if (!keys.has(key)) entry.results.delete(key);
    const needsHistory = comments.some((comment) => comment.authorId === "paseo-agent"
      && !entry.results.get(`${comment.id}:${comment.version}`));
    if (needsHistory && !entry.pending && Date.now() - entry.fetchedAt >= 60_000) {
      const target = entry;
      target.fetchedAt = Date.now();
      target.pending = (async () => {
        try {
          const timeline = paseo.agents.ref(binding.agentId).timeline;
          const pages: TimelinePage[] = [];
          let cursor: TimelinePage["startCursor"] = null;
          // 只查询本任务绑定 Agent，最多 4 页；找不到完整原文就保留原顺序。
          for (let count = 0; count < 4; count += 1) {
            const page = await timeline.refetch({ projection: "canonical", limit: 500,
              ...(cursor ? { direction: "before" as const, cursor } : {}) });
            if (page.error || page.gap || page.staleCursor || (pages.length && page.epoch !== pages[0].epoch)) return;
            pages.unshift(page);
            if (!page.hasOlder || !page.startCursor) break;
            cursor = page.startCursor;
          }
          const groups: string[][] = [];
          let current: AgentTimelineItem[] | null = null;
          for (const { item } of pages.flatMap((page) => page.entries)) {
            if (item.type === "user_message") {
              if (current) groups.push(assistantMessageTexts(current));
              current = [];
            } else if (current) current.push(item);
          }
          if (current) groups.push(assistantMessageTexts(current));
          target.groups = groups;
          target.results.clear();
        } catch {
          // 无可靠历史时显示原评论，不猜分隔线，也不影响评论/图片主路径。
        }
      })().finally(() => { target.pending = null; });
    }
    await entry.pending;
    return comments.map((comment) => {
      if (comment.authorId !== "paseo-agent") return comment;
      const key = `${comment.id}:${comment.version}`;
      if (!entry.results.has(key)) entry.results.set(key, matchedCommentMessageRanges(comment.body, entry.groups));
      const ranges = entry.results.get(key);
      return ranges ? { ...comment, paseoMessageRanges: ranges } : comment;
    });
  };
}
