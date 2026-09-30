import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as dashi from "./dashi-api.ts";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ROUTE = /^\/api\/paseo\/tasks\/([^/?#]+)\/comments\/([^/?#]+)\/images\/(0|[1-9]\d*)$/;

/** 只接受原评论指定位置的内联图片，路径完全来自已保存正文。 */
function referencedLocalImage(body: string, offset: number): string | null {
  const match = /^!\[(?:\\.|[^\]\\])*\]\(\s*(?:<(file:[^<>\r\n]+)>|(file:[^\s)]+))(?:\s+["'][^\r\n]*?["'])?\s*\)/i.exec(body.slice(offset));
  return match?.[1] ?? match?.[2] ?? null;
}

function imageType(bytes: Buffer): string | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
    && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0) return "image/gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
    && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) return "image/webp";
  return null;
}

function reject(status: number, message: string): never {
  throw new dashi.DashiApiError(status, "COMMENT_IMAGE_UNAVAILABLE", message);
}

/** 虚拟图片 GET：复核任务、评论作者和原始引用后只读本机位图，不接受客户端路径。 */
export async function handleCommentImageBridge(
  baseUrl: string,
  input: { method: string; path: string },
): Promise<Awaited<ReturnType<typeof dashi.bridgeRequest>> | null> {
  if (!input.path.startsWith("/api/paseo/tasks/")) return null;
  try {
    const url = new URL(input.path, "https://paseo-taskboard.invalid");
    const match = ROUTE.exec(url.pathname);
    if (input.method !== "GET" || !match || url.hash) reject(403, "不支持的评论图片请求。");
    const version = url.searchParams.get("version");
    if (!version || !/^[1-9]\d*$/.test(version) || [...url.searchParams.keys()].some((key) => key !== "version")) {
      reject(400, "评论图片版本无效。");
    }
    const taskId = decodeURIComponent(match[1]);
    const commentId = decodeURIComponent(match[2]);
    const offset = Number(match[3]);
    const { comments } = await dashi.listComments(baseUrl, taskId);
    const comment = comments.find((entry) => entry.id === commentId && entry.taskId === taskId);
    if (!comment || comment.authorId !== dashi.PLUGIN_AGENT_ACTOR.id) reject(403, "只允许读取此任务中 Paseo Agent 评论声明的图片。");
    if (comment.version !== Number(version)) reject(409, "评论已更新，请刷新图片。");
    if (!Number.isSafeInteger(offset) || offset >= comment.body.length) reject(400, "评论图片引用无效。");
    const reference = referencedLocalImage(comment.body, offset);
    if (!reference) reject(403, "原评论此处没有本机图片引用。");
    const source = new URL(reference);
    if (source.protocol !== "file:" || source.hostname || source.search || source.hash) reject(403, "仅支持本机 file 图片，不读取网络路径。");
    const filename = fileURLToPath(source);
    if (!path.isAbsolute(filename) || filename.includes("\0") || filename.startsWith("\\\\")
      || (process.platform === "win32" && (!/^[A-Za-z]:[\\/]/.test(filename) || filename.slice(2).includes(":")))) {
      reject(403, "图片必须是本机普通文件。");
    }
    const file = await open(filename, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) reject(415, "图片引用不是普通文件。");
      if (stat.size === 0 || stat.size > MAX_IMAGE_BYTES) reject(413, "本机图片必须大于 0 且不超过 25 MiB。");
      // 限长读取，文件在读取期间增长也不能突破桥接大小上限。
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size) reject(409, "图片文件正在变化，请稍后重试。");
      const bytes = buffer.subarray(0, length);
      const contentType = imageType(bytes);
      if (!contentType) reject(415, "仅支持有效的 PNG、JPEG、GIF 或 WebP 位图。");
      return { status: 200, headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" },
        body: { kind: "base64", value: bytes.toString("base64") } };
    } finally { await file.close(); }
  } catch (error) {
    const known = error instanceof dashi.DashiApiError;
    return {
      status: known ? error.status : 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: { kind: "json", value: { error: { code: "COMMENT_IMAGE_UNAVAILABLE", message: known ? error.message : "本机图片不可读取，请确认文件仍在 Paseo 所在设备上。" } } },
    };
  }
}
