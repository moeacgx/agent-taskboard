import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, open, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { registerHandlers } from "../server/handlers.ts";
import { createBindingsStore } from "../server/bindings.ts";
import { createSettingsStore } from "../server/settings.ts";
import { createTaskPlansStore } from "../server/task-plans.ts";
import * as contracts from "../shared/contracts.ts";
import * as dashi from "../server/dashi-api.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-comment-images-"));
  const { createTaskboardServer } = await import("../../../server/app.mjs") as any;
  const app = createTaskboardServer({ dataDirectory: directory, databasePath: path.join(directory, "db.sqlite"), attachmentsDirectory: path.join(directory, "attachments"), staticDirectory: directory });
  const { port } = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${port}`;
  const previous = process.env.DASHI_TASKBOARD_URL;
  process.env.DASHI_TASKBOARD_URL = baseUrl;
  const handlers = new Map<string, (input: any, context: any) => Promise<any>>();
  registerHandlers({ handle: (contract: any, handler: any) => handlers.set(contract.name, handler) } as never,
    createBindingsStore({ filePath: path.join(directory, "bindings.json") }),
    createSettingsStore({ filePath: path.join(directory, "settings.json") }),
    createTaskPlansStore({ filePath: path.join(directory, "plans.json") }));
  const task = (await dashi.createTask(baseUrl, { projectId: "local", title: "图片回写临时验证" })).task;
  async function imagePath(name: string, bytes: Buffer = png) {
    const filename = path.join(directory, "脚本程序", "开源程序二开", "tokens-pro-tok-1-rename", "output", "playwright", name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
    return pathToFileURL(filename).href;
  }
  async function request(url: string, method = "GET") {
    const input = contracts.bridgeRequest.input.parse({ path: url, method, headers: {}, body: null });
    return handlers.get(contracts.bridgeRequest.name)!(input, { paseo: {} });
  }
  const endpoint = (comment: { id: string; version: number }, offset = 0, taskId = task.id) => `/api/paseo/tasks/${taskId}/comments/${comment.id}/images/${offset}?version=${comment.version}`;
  return { app, task, baseUrl, directory, imagePath, request, endpoint,
    async close() {
      await app.close();
      if (previous === undefined) delete process.env.DASHI_TASKBOARD_URL; else process.env.DASHI_TASKBOARD_URL = previous;
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith("paseo-comment-images-"));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("已保存的三张中文 file 图片经真实 bridge 返回原字节，普通 API 附件保持可读且数据库不变", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const urls = await Promise.all(["tok1-desktop.png", "tok1-mobile.png", "tok1-login-mobile.png"].map((name) => f.imagePath(name)));
    assert.match(urls[0], /%E8%84%9A%E6%9C%AC%E7%A8%8B%E5%BA%8F/);
    const body = `已完成，图片如下：\n${urls.map((url) => `![Image](${url})`).join("\n")}`;
    const comment = (await dashi.addComment(f.baseUrl, f.task.id, body, dashi.PLUGIN_AGENT_ACTOR)).comment;
    const before = await dashi.listComments(f.baseUrl, f.task.id);
    const taskBefore = await dashi.getTask(f.baseUrl, f.task.id);
    for (const match of body.matchAll(/!\[Image\]/g)) {
      const result = await f.request(f.endpoint(comment, match.index));
      assert.equal(result.status, 200);
      assert.equal(result.headers["content-type"], "image/png");
      assert.equal(result.body.kind, "base64");
      assert.deepEqual(Buffer.from(result.body.value, "base64"), png);
    }
    assert.deepEqual(await dashi.listComments(f.baseUrl, f.task.id), before);
    assert.deepEqual(await dashi.getTask(f.baseUrl, f.task.id), taskBefore);
    assert.deepEqual(before.comments[0].attachments, []);
    // 既有上传附件路径继续由原始 Dashi 桥处理。
    const response = await fetch(`${f.baseUrl}/api/tasks/${f.task.id}/attachments`, { method: "POST", headers: {
      "content-type": "image/png", "x-taskboard-filename": "existing.png", "x-taskboard-attachment-kind": "inline",
    }, body: png });
    assert.equal(response.status, 201);
    const { attachment } = await response.json() as any;
    const existing = await f.request(`/api/attachments/${attachment.id}/content`);
    assert.equal(existing.status, 200);
    assert.deepEqual(Buffer.from(existing.body.value, "base64"), png);
  } finally { await f.close(); }
});

test("本机图片读取只接受同任务 Agent 原图引用，并拒绝路径注入、远端、伪图片和超限文件", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const url = await f.imagePath("valid.png");
    const agent = (await dashi.addComment(f.baseUrl, f.task.id, `![Image](${url})`, dashi.PLUGIN_AGENT_ACTOR)).comment;
    const user = (await dashi.addComment(f.baseUrl, f.task.id, `![Image](${url})`)).comment;
    assert.equal((await f.request(f.endpoint(user))).status, 403);
    const other = (await dashi.createTask(f.baseUrl, { projectId: "local", title: "另一任务" })).task;
    assert.equal((await f.request(f.endpoint(agent, 0, other.id))).status, 403);
    assert.equal((await f.request(f.endpoint(agent, 1))).status, 403);
    assert.equal((await f.request(`${f.endpoint(agent)}&path=${encodeURIComponent(url)}`)).status, 400);
    assert.equal((await f.request(f.endpoint({ ...agent, version: agent.version + 1 }))).status, 409);
    assert.equal((await f.request(f.endpoint(agent), "POST")).status, 403);
    for (const reference of ["https://example.invalid/private.png", "file://server/share/image.png", "file:////server/share/image.png"]) {
      const comment = (await dashi.addComment(f.baseUrl, f.task.id, `![Image](${reference})`, dashi.PLUGIN_AGENT_ACTOR)).comment;
      const result = await f.request(f.endpoint(comment));
      assert.ok(result.status >= 400);
      assert.equal(result.body.kind, "json");
    }
    for (const [name, bytes] of [["fake.png", Buffer.from("private text")], ["active.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')]] as const) {
      const file = await f.imagePath(name, bytes);
      const comment = (await dashi.addComment(f.baseUrl, f.task.id, `![Image](${file})`, dashi.PLUGIN_AGENT_ACTOR)).comment;
      assert.equal((await f.request(f.endpoint(comment))).status, 415);
    }
    const largeUrl = await f.imagePath("large.png");
    const large = await open(new URL(largeUrl), "r+");
    try { await large.truncate(25 * 1024 * 1024 + 1); } finally { await large.close(); }
    const largeComment = (await dashi.addComment(f.baseUrl, f.task.id, `![Image](${largeUrl})`, dashi.PLUGIN_AGENT_ACTOR)).comment;
    assert.equal((await f.request(f.endpoint(largeComment))).status, 413);
    const edited = f.app.database.updateComment(agent.id, agent.version, "图片引用已移除", null, null);
    assert.equal((await f.request(f.endpoint(agent))).status, 409);
    assert.equal((await f.request(f.endpoint(edited))).status, 403);
  } finally { await f.close(); }
});
