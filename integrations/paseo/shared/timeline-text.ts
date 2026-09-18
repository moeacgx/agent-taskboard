import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

const SUMMARY_MAX_LENGTH = 6000;

/**
 * Joins assistant text emitted after the latest user message, so a
 * write-back comment can carry what the agent actually said instead of just
 * "finished".
 *
 * Assistant text can arrive split across several timeline items while it
 * streams in — the reference docs say as much ("text may span items") — so
 * fragments of the *same* message must be concatenated with no separator or
 * words get split apart mid-sentence. `messageId` is the only protocol
 * signal for "this is a new message" (confirmed in
 * `@getpaseo/protocol/agent-types`); a paragraph break is inserted only when
 * it explicitly changes. There is no other documented way to tell streaming
 * fragments apart from a genuinely new message, so nothing else is guessed.
 */
export function latestAssistantText(timeline: readonly AgentTimelineItem[]): string {
  let lastUserIndex = -1;
  for (let index = 0; index < timeline.length; index += 1) {
    if (timeline[index].type === "user_message") lastUserIndex = index;
  }

  const messages: string[] = [];
  let currentMessageId: string | undefined;
  let current = "";

  for (let index = lastUserIndex + 1; index < timeline.length; index += 1) {
    const item = timeline[index];
    if (item.type !== "assistant_message" || item.text.length === 0) continue;
    const isNewMessage = current.length > 0 && item.messageId !== undefined && item.messageId !== currentMessageId;
    if (isNewMessage) {
      messages.push(current);
      current = item.text;
    } else {
      current += item.text;
    }
    currentMessageId = item.messageId;
  }
  if (current.length > 0) messages.push(current);

  const text = messages.join("\n\n").trim();
  if (text.length <= SUMMARY_MAX_LENGTH) return text;
  return `${text.slice(0, SUMMARY_MAX_LENGTH)}\n\n…（回复过长，已截断）`;
}
