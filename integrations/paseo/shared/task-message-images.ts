const DASHI_TASK_HEADERS = [
  "你正在通过 Paseo 处理 Dashi Taskboard 任务",
  "继续处理 Dashi Taskboard 任务",
] as const;

const IMAGE_MARKDOWN = /!\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^>\s]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu;
const ATTACHMENT_PATH = /^\/?api\/attachments\/([A-Za-z0-9._~-]+)\/content(?:[?#][^\s]*)?$/u;
const FULL_LATEST_REQUIREMENT = "最新人工要求（本轮最高优先级）：";
const FIRST_TASK_DESCRIPTION = "任务原始描述与具体要求（高于项目公共背景；如与最新人工要求冲突，以最新人工要求为准）：";
const FIRST_NO_REQUIREMENT = "最新人工要求：";
const CONTINUATION_LATEST_REQUIREMENT = "本次最新人工要求（最高优先级）：";
const EARLIER_REQUIREMENTS = "较早人工补充（背景，按时间排序）：";
const MANAGED_NOTICE = "这是 Paseo 插件托管的任务。";

export type DashiTaskMessageImage = {
  id: string;
  filename: string;
};

export type DashiTaskMessageImages = {
  text: string;
  images: DashiTaskMessageImage[];
};

function attachmentId(value: string): string | null {
  const relative = value.match(ATTACHMENT_PATH);
  if (relative) return relative[1];

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "paseo-taskboard.invalid") return null;
    return url.pathname.match(/^\/api\/attachments\/([A-Za-z0-9._~-]+)\/content$/u)?.[1] ?? null;
  } catch {
    return null;
  }
}

function markdownLabel(value: string, id: string): string {
  const label = value.replace(/\\(.)/gu, "$1").trim();
  return label || id;
}

function sectionAfter(text: string, heading: string, endings: string[]): { start: number; end: number } | null {
  const marker = `\n${heading}\n`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = markerIndex + marker.length;
  const endingOffsets = endings
    .map((ending) => text.indexOf(`\n${ending}`, start))
    .filter((index) => index >= 0);
  return { start, end: endingOffsets.length > 0 ? Math.min(...endingOffsets) : text.length };
}

function currentRequirementSection(text: string): { start: number; end: number } | null {
  if (text.startsWith("继续处理 Dashi Taskboard 任务")) {
    return sectionAfter(text, CONTINUATION_LATEST_REQUIREMENT, [MANAGED_NOTICE]);
  }

  const latestRequirement = sectionAfter(text, FULL_LATEST_REQUIREMENT, [EARLIER_REQUIREMENTS, MANAGED_NOTICE]);
  if (latestRequirement) return latestRequirement;
  return sectionAfter(text, FIRST_TASK_DESCRIPTION, [FIRST_NO_REQUIREMENT]);
}

export function parseDashiTaskMessageImages(text: string): DashiTaskMessageImages | null {
  if (!DASHI_TASK_HEADERS.some((header) => text.startsWith(header))) return null;
  const currentSection = currentRequirementSection(text);
  if (!currentSection) return null;

  const images: DashiTaskMessageImage[] = [];
  const seen = new Set<string>();
  let remainingText = "";
  let offset = 0;
  let replacedHistoricalImage = false;

  for (const match of text.matchAll(IMAGE_MARKDOWN)) {
    const id = attachmentId(match[2] ?? match[3] ?? "");
    if (!id || match.index === undefined) continue;
    const end = match.index + match[0].length;
    const filename = markdownLabel(match[1], id);
    remainingText += text.slice(offset, match.index);
    offset = end;
    if (match.index >= currentSection.start && end <= currentSection.end) {
      if (seen.has(id)) continue;
      seen.add(id);
      images.push({ id, filename });
    } else {
      replacedHistoricalImage = true;
      remainingText += `历史图片：${filename}`;
    }
  }

  if (images.length === 0 && !replacedHistoricalImage) return null;
  remainingText += text.slice(offset);
  return { text: remainingText, images };
}
