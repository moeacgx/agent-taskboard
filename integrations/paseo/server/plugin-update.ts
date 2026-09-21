import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { PLUGIN_PACKAGE_VERSION } from "./plugin-installation.generated.ts";

const execFile = promisify(execFileCallback);

export const PLUGIN_UPDATE_REPOSITORY = "moeacgx/agent-taskboard";
export const PLUGIN_UPDATE_GUIDE_URL =
  `https://github.com/${PLUGIN_UPDATE_REPOSITORY}/blob/HEAD/integrations/paseo/README.md`;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;

export type PluginUpdateStatusKind = "update" | "current" | "unavailable";

export interface PluginUpdateStatus {
  status: PluginUpdateStatusKind;
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  publishedAt: string | null;
  title: string | null;
  notes: string | null;
  htmlUrl: string | null;
  guideUrl: string;
  checkedAt: string;
  error: string | null;
}

export interface PluginUpdateChecker {
  check(options?: { refresh?: boolean }): Promise<PluginUpdateStatus>;
}

export interface PluginUpdateBridgeResponse {
  status: number;
  headers: Record<string, string>;
  body: { kind: "json"; value: PluginUpdateStatus };
}

interface ParsedVersion {
  parts: [number, number, number];
  prerelease: string | null;
}

interface CachedCheck {
  value: PluginUpdateStatus;
  expiresAt: number;
}

interface GithubReleasePayload {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

export const PLUGIN_DISPLAY_VERSION = PLUGIN_PACKAGE_VERSION;

export function readPluginVersion(): string {
  return PLUGIN_PACKAGE_VERSION;
}

export function compareSemver(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return 0;
  for (let index = 0; index < 3; index += 1) {
    const delta = parsedLeft.parts[index] - parsedRight.parts[index];
    if (delta !== 0) return delta;
  }
  if (parsedLeft.prerelease === parsedRight.prerelease) return 0;
  if (!parsedLeft.prerelease) return 1;
  if (!parsedRight.prerelease) return -1;
  return parsedLeft.prerelease.localeCompare(parsedRight.prerelease);
}

function parseVersion(value: string): ParsedVersion | null {
  const trimmed = value.trim().replace(/^v/i, "");
  if (!trimmed) return null;
  const dash = trimmed.indexOf("-");
  const core = dash === -1 ? trimmed : trimmed.slice(0, dash);
  const prerelease = dash === -1 ? null : trimmed.slice(dash + 1) || null;
  if (!/^\d+(?:\.\d+){0,3}$/.test(core)) return null;
  const numbers = core.split(".").map((part) => Number(part));
  while (numbers.length < 3) numbers.push(0);
  return {
    parts: [numbers[0], numbers[1], numbers[2]],
    prerelease,
  };
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^v/i, "");
}

async function githubCliFallback(
  repository: string,
  timeoutMs: number,
): Promise<{ status: number; body: string } | null> {
  try {
    const result = await execFile("gh", ["api", `repos/${repository}/releases/latest`], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return { status: 200, body: result.stdout };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    const body = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (body.includes("Not Found") || body.includes("HTTP 404")) {
      return { status: 404, body: body || JSON.stringify({ message: "Not Found" }) };
    }
    return null;
  }
}

export function createPluginUpdateChecker(options: {
  currentVersion: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  cacheTtlMs?: number;
  timeoutMs?: number;
  repository?: string;
  guideUrl?: string;
  token?: string;
  fallback?: () => Promise<{ status: number; body: string } | null>;
}): PluginUpdateChecker {
  const currentVersion = options.currentVersion.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const repository = options.repository ?? PLUGIN_UPDATE_REPOSITORY;
  const guideUrl = options.guideUrl ?? PLUGIN_UPDATE_GUIDE_URL;
  const token = options.token?.trim()
    || process.env.UPDATE_GITHUB_TOKEN?.trim()
    || process.env.GITHUB_TOKEN?.trim()
    || process.env.GH_TOKEN?.trim()
    || "";
  const fallback = options.fallback ?? (() => githubCliFallback(repository, timeoutMs));
  const latestUrl = `https://api.github.com/repos/${repository}/releases/latest`;
  let cache: CachedCheck | null = null;

  return {
    async check(input = {}) {
      const checkedAt = now();
      const checkedAtIso = checkedAt.toISOString();
      if (!input.refresh && cache && cache.expiresAt > checkedAt.getTime()) {
        return { ...cache.value, checkedAt: cache.value.checkedAt };
      }

      const base: PluginUpdateStatus = {
        status: "unavailable",
        updateAvailable: false,
        currentVersion,
        latestVersion: null,
        publishedAt: null,
        title: null,
        notes: null,
        htmlUrl: `https://github.com/${repository}/releases`,
        guideUrl,
        checkedAt: checkedAtIso,
        error: null,
      };

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const headers: Record<string, string> = {
          accept: "application/vnd.github+json",
          "user-agent": `agent-taskboard-plugin/${currentVersion}`,
          "x-github-api-version": "2022-11-28",
        };
        if (token) headers.authorization = `Bearer ${token}`;
        let response: Response;
        try {
          response = await fetchImpl(latestUrl, {
            method: "GET",
            headers,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        let status = response.status;
        let payloadText = "";
        if (status === 403 || status === 429) {
          const fallbackResult = await fallback();
          if (fallbackResult) {
            status = fallbackResult.status;
            payloadText = fallbackResult.body;
          }
        }
        if (!payloadText && status !== 204) {
          payloadText = await response.text();
        }

        if (status === 404) {
          const value = { ...base, status: "current" as const, error: null };
          cache = { value, expiresAt: checkedAt.getTime() + cacheTtlMs };
          return value;
        }

        if (status < 200 || status >= 300) {
          let detail = `GitHub Releases 返回 HTTP ${status}`;
          try {
            const errorBody = JSON.parse(payloadText) as { message?: unknown };
            if (typeof errorBody.message === "string" && errorBody.message.trim()) {
              detail = errorBody.message.trim();
            }
          } catch {
            // Keep the HTTP status fallback when GitHub's error body is not JSON.
          }
          return { ...base, error: detail };
        }

        const payload = (payloadText ? JSON.parse(payloadText) : {}) as GithubReleasePayload;
        const tag = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
        if (!tag || !parseVersion(tag)) {
          return { ...base, error: "GitHub Release 缺少可比较的版本号。" };
        }

        const latestVersion = normalizeTag(tag);
        const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
        const value: PluginUpdateStatus = {
          ...base,
          status: updateAvailable ? "update" : "current",
          updateAvailable,
          latestVersion,
          publishedAt: typeof payload.published_at === "string" ? payload.published_at : null,
          title: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : latestVersion,
          notes: typeof payload.body === "string" && payload.body.trim() ? payload.body.trim() : null,
          htmlUrl: typeof payload.html_url === "string" && payload.html_url.trim()
            ? payload.html_url.trim()
            : `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
          error: null,
        };
        cache = { value, expiresAt: checkedAt.getTime() + cacheTtlMs };
        return value;
      } catch (error) {
        const message = error instanceof Error && error.name === "AbortError"
          ? "检查更新超时。"
          : error instanceof Error
            ? error.message
            : String(error);
        return { ...base, error: message || "检查更新失败。" };
      }
    },
  };
}

let defaultChecker: PluginUpdateChecker | null = null;

export function defaultPluginUpdateChecker(): PluginUpdateChecker {
  return defaultChecker ??= createPluginUpdateChecker({
    currentVersion: readPluginVersion(),
  });
}

function unavailableStatus(error: unknown): PluginUpdateStatus {
  return {
    status: "unavailable",
    updateAvailable: false,
    currentVersion: readPluginVersion(),
    latestVersion: null,
    publishedAt: null,
    title: null,
    notes: null,
    htmlUrl: `https://github.com/${PLUGIN_UPDATE_REPOSITORY}/releases`,
    guideUrl: PLUGIN_UPDATE_GUIDE_URL,
    checkedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function handlePluginUpdateBridge(
  input: { method: string; path: string },
  checker?: PluginUpdateChecker,
): Promise<PluginUpdateBridgeResponse | null> {
  const pathname = input.path.split("?", 1)[0];
  if (input.method !== "GET" || pathname !== "/api/plugin-update") return null;
  try {
    const url = new URL(input.path, "https://paseo-taskboard.invalid");
    const active = checker ?? defaultPluginUpdateChecker();
    const value = await active.check({ refresh: url.searchParams.get("refresh") === "1" });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { kind: "json", value },
    };
  } catch (error) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { kind: "json", value: unavailableStatus(error) },
    };
  }
}
