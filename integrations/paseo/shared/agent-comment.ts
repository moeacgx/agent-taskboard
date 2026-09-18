export type AgentCommentKind = "completed" | "failed" | "canceled";

const CURRENT_COMPLETED_HEADER = "✅ Agent 本轮运行已完成，请查看当前任务状态并验收。";
const LEGACY_COMPLETED_HEADER = "✅ Paseo agent 完成一轮运行，任务已置为待验收（in_review）。";
const COMPLETED_FOOTER = "验收通过后请手动将任务移至 done；插件不会自动完成任务。";

/** 只写入可读的 Agent 结果，不再把状态、Agent ID 或验收提示混入评论正文。 */
export function compactAgentComment(
  kind: AgentCommentKind,
  summary: string,
  message?: string,
  code?: string,
): string {
  const reply = summary.trim();
  if (kind === "completed") return reply || "本轮无文本回复";
  if (kind === "canceled") return `已取消：${message ?? "未提供原因"}`;

  const error = [`错误: ${message ?? "未知错误"}`, code ? `错误码: ${code}` : null]
    .filter((line): line is string => line !== null)
    .join("\n");
  return reply ? `${error}\n\n${reply}` : error;
}

function unwrapKnownCompletedComment(body: string, header: string, metadata: string): string | null {
  const prefix = `${header}\n${metadata}\n\n`;
  const suffix = `\n\n${COMPLETED_FOOTER}`;
  if (!body.startsWith(prefix) || !body.endsWith(suffix)) return null;
  return body.slice(prefix.length, -suffix.length);
}

/**
 * 仅处理本插件写入的旧 completed 包装。作者不是 paseo-agent 或模板不完整时，
 * 一律原样返回，避免把人工或实际回复中的 “Agent:” 误删。
 */
export function displayCommentBody(authorId: string, body: string): string {
  if (authorId !== "paseo-agent") return body;

  const current = unwrapKnownCompletedComment(body, CURRENT_COMPLETED_HEADER, "Agent: " + body
    .slice(CURRENT_COMPLETED_HEADER.length + 1)
    .split("\n", 1)[0]
    .slice("Agent: ".length));
  if (current !== null) return current;

  const legacyPrefix = `${LEGACY_COMPLETED_HEADER}\n工作区: `;
  if (!body.startsWith(legacyPrefix)) return body;
  const firstBreak = body.indexOf("\n", legacyPrefix.length);
  if (firstBreak < 0) return body;
  const agentStart = firstBreak + 1;
  const agentEnd = body.indexOf("\n", agentStart);
  if (agentEnd < 0) return body;
  const agentLine = body.slice(agentStart, agentEnd);
  if (!agentLine.startsWith("Agent: ")) return body;
  return unwrapKnownCompletedComment(
    body,
    LEGACY_COMPLETED_HEADER,
    `${body.slice(LEGACY_COMPLETED_HEADER.length + 1, firstBreak)}\n${agentLine}`,
  ) ?? body;
}
