import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

const SUMMARY_MAX_LENGTH = 6000;

/** 仅用 messageId 区分独立回复；无 ID 的流片段和图片留在相邻消息中。 */
export function assistantMessageTexts(timeline: readonly AgentTimelineItem[]): string[] {
  const messages: string[] = [];
  let currentMessageId: string | undefined;
  let current = "";

  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index];
    if (item.type !== "assistant_message" || item.text.length === 0) continue;
    const isNewMessage = current.length > 0 && item.messageId !== undefined && item.messageId !== currentMessageId;
    if (isNewMessage) {
      messages.push(current);
      current = item.text;
    } else {
      current += item.text;
    }
    currentMessageId = item.messageId ?? currentMessageId;
  }
  if (current.length > 0) messages.push(current);

  return messages;
}

/** 本轮最终回复优先；消息内部的段落、代码、清单和图片顺序保持不变。 */
export function latestAssistantText(timeline: readonly AgentTimelineItem[]): string {
  let lastUserIndex = -1;
  for (let index = 0; index < timeline.length; index += 1) {
    if (timeline[index].type === "user_message") lastUserIndex = index;
  }
  const text = assistantMessageTexts(timeline.slice(lastUserIndex + 1)).reverse().join("\n\n").trim();
  if (text.length <= SUMMARY_MAX_LENGTH) return text;
  return `${text.slice(0, SUMMARY_MAX_LENGTH)}\n\n…（回复过长，已截断）`;
}
