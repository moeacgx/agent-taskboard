import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  compareSemver,
  createPluginUpdateChecker,
  handlePluginUpdateBridge,
} from "../server/plugin-update.ts";

function githubRelease(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v0.2.0",
    name: "0.2.0 Dashboard updates",
    body: "## 新功能\n\n- 仪表盘更新检测\n- 移动议题到其他项目",
    html_url: "https://github.com/moeacgx/agent-taskboard/releases/tag/v0.2.0",
    published_at: "2026-09-20T12:00:00Z",
    draft: false,
    prerelease: false,
    ...overrides,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

test("compareSemver treats v-prefixed later tags as newer", () => {
  assert.ok(compareSemver("v0.2.0", "0.1.0") > 0);
  assert.ok(compareSemver("0.1.0", "v0.1.0") === 0);
  assert.ok(compareSemver("0.1.0", "0.2.0") < 0);
  assert.ok(compareSemver("1.0.0", "0.9.9") > 0);
  assert.ok(compareSemver("0.1.0", "0.1.0-beta") > 0);
});

test("newer GitHub release is reported as an available update", async () => {
  const { fetchImpl, calls } = mockFetch(() => Response.json(githubRelease()));
  const checker = createPluginUpdateChecker({
    currentVersion: "0.1.0",
    fetchImpl,
    now: () => new Date("2026-09-20T13:00:00Z"),
  });

  const result = await checker.check();

  assert.equal(result.status, "update");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.currentVersion, "0.1.0");
  assert.equal(result.latestVersion, "0.2.0");
  assert.equal(result.publishedAt, "2026-09-20T12:00:00Z");
  assert.equal(result.title, "0.2.0 Dashboard updates");
  assert.match(result.notes ?? "", /仪表盘更新检测/);
  assert.equal(result.htmlUrl, "https://github.com/moeacgx/agent-taskboard/releases/tag/v0.2.0");
  assert.match(result.guideUrl, /agent-taskboard/);
  assert.equal(result.checkedAt, "2026-09-20T13:00:00.000Z");
  assert.equal(result.error, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /repos\/moeacgx\/agent-taskboard\/releases\/latest/);
  assert.match(String(new Headers(calls[0].init?.headers).get("user-agent")), /agent-taskboard-plugin\/0\.1\.0/);
});

test("matching latest release is reported as current", async () => {
  const { fetchImpl } = mockFetch(() => Response.json(githubRelease({ tag_name: "v0.1.0", name: "0.1.0" })));
  const result = await createPluginUpdateChecker({ currentVersion: "0.1.0", fetchImpl }).check();
  assert.equal(result.status, "current");
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latestVersion, "0.1.0");
});

test("404 from GitHub latest means no published release and is still current", async () => {
  const { fetchImpl } = mockFetch(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
  const result = await createPluginUpdateChecker({ currentVersion: "0.1.0", fetchImpl }).check();
  assert.equal(result.status, "current");
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latestVersion, null);
  assert.equal(result.error, null);
});

test("network failure does not throw and keeps the dashboard usable", async () => {
  const { fetchImpl } = mockFetch(() => {
    throw new Error("fetch failed");
  });
  const result = await createPluginUpdateChecker({ currentVersion: "0.1.0", fetchImpl }).check();
  assert.equal(result.status, "unavailable");
  assert.equal(result.updateAvailable, false);
  assert.equal(result.currentVersion, "0.1.0");
  assert.ok(result.error);
});

test("cached successful checks are reused until refresh or TTL", async () => {
  let now = new Date("2026-09-20T13:00:00Z");
  const { fetchImpl, calls } = mockFetch(() => Response.json(githubRelease()));
  const checker = createPluginUpdateChecker({
    currentVersion: "0.1.0",
    fetchImpl,
    now: () => now,
    cacheTtlMs: 30 * 60 * 1000,
  });

  await checker.check();
  await checker.check();
  assert.equal(calls.length, 1);

  const refreshed = await checker.check({ refresh: true });
  assert.equal(calls.length, 2);
  assert.equal(refreshed.status, "update");

  now = new Date("2026-09-20T13:31:00Z");
  await checker.check();
  assert.equal(calls.length, 3);
});

test("optional GitHub token is sent as Authorization", async () => {
  const { fetchImpl, calls } = mockFetch(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
  await createPluginUpdateChecker({
    currentVersion: "0.1.0",
    token: "ghs_test-token",
    fetchImpl,
  }).check();
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer ghs_test-token");
});

test("rate-limited GitHub fetch can fall back to gh CLI", async () => {
  const { fetchImpl } = mockFetch(() => new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 }));
  const result = await createPluginUpdateChecker({
    currentVersion: "0.1.0",
    fetchImpl,
    fallback: async () => ({ status: 404, body: JSON.stringify({ message: "Not Found" }) }),
  }).check();
  assert.equal(result.status, "current");
  assert.equal(result.error, null);
});

test("non-update bridge paths return null without running the checker", async () => {
  const ignored = await handlePluginUpdateBridge(
    { method: "GET", path: "/api/client-storage" },
    { check: async () => { throw new Error("checker should not run"); } },
  );
  assert.equal(ignored, null);
});

test("update bridge returns HTTP 200 unavailable instead of throwing", async () => {
  const response = await handlePluginUpdateBridge(
    { method: "GET", path: "/api/plugin-update" },
    { check: async () => { throw new Error("boom"); } },
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.body.kind, "json");
  const value = response.body.value as { status?: string; currentVersion?: string; error?: string | null };
  assert.equal(value.status, "unavailable");
  const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(value.currentVersion, packageVersion);
  assert.match(value.error ?? "", /boom/);
});

test("bridge intercepts GET /api/plugin-update and never forwards to Dashi", async () => {
  const { fetchImpl, calls } = mockFetch(() => Response.json(githubRelease({ tag_name: "v0.3.0" })));
  const checker = createPluginUpdateChecker({ currentVersion: "0.1.0", fetchImpl });

  const ignored = await handlePluginUpdateBridge(
    { method: "PATCH", path: "/api/tasks/abc" },
    checker,
  );
  assert.equal(ignored, null);

  const response = await handlePluginUpdateBridge(
    { method: "GET", path: "/api/plugin-update?refresh=1" },
    checker,
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.body.kind, "json");
  assert.equal((response.body.value as { latestVersion?: string }).latestVersion, "0.3.0");
  assert.equal(calls.length, 1);
});
