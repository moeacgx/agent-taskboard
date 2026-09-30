import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { createBindingsStore } from "../server/bindings.ts";
import { createCommentQueueRuntime } from "../server/comment-queue.ts";
import { createTaskMutationLock } from "../server/dispatch.ts";
import { registerLifecycle } from "../server/lifecycle.ts";
import { registerHandlers } from "../server/handlers.ts";
import { createSettingsStore } from "../server/settings.ts";
import { createTaskPlansStore } from "../server/task-plans.ts";
import * as dashi from "../server/dashi-api.ts";
import { commentQueue, CommentQueueRequestSchema, CommentQueueStateSchema } from "../shared/contracts.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(status: "in_progress" | "blocked" = "in_progress") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-comment-queue-"));
  const { createTaskboardServer } = await import("../../../server/app.mjs") as any;
  const app = createTaskboardServer({ dataDirectory: directory, databasePath: path.join(directory, "db.sqlite"), attachmentsDirectory: path.join(directory, "attachments"), staticDirectory: directory });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previousUrl = process.env.DASHI_TASKBOARD_URL;
  process.env.DASHI_TASKBOARD_URL = baseUrl;
  const task = (await dashi.createTask(baseUrl, { projectId: "local", title: "隔离评论排队验证", description: "旧描述不发送", status })).task;
  const filePath = path.join(directory, "bindings.json");
  let bindings = createBindingsStore({ filePath });
  const bindingInput = { taskId: task.id, taskIdentifier: task.identifier, projectId: task.projectId, workspaceId: "mock-workspace", agentId: "original-agent", provider: "mock" };
  await bindings.upsert(bindingInput);
  const lock = createTaskMutationLock();
  const hooks = new Map<string, (event: any, context: { paseo: PaseoApi }) => Promise<void>>();
  const handlers = new Map<string, (input: any, context: { paseo: PaseoApi }) => Promise<any>>();
  let agentStatus = "running";
  let activeTurnId: string | null = "original-turn";
  let permissions: string[] = [];
  let sendMode: "normal" | "throw" | "hang" | "fast" = "normal";
  let refreshOperation = async () => {};
  const sendGate = deferred();
  const sends: Array<{ id: string; prompt: string; options: any; previousResults: number }> = [];
  const eventAgent = { id: "original-agent", workspaceId: "mock-workspace", parentAgentId: null, provider: "mock", cwd: directory, title: null };
  const agent = {
    id: eventAgent.id,
    get status() { return agentStatus; },
    get activeTurn() { return activeTurnId ? { turnId: activeTurnId } : null; },
    get pendingPermissions() { return permissions; }, archivedAt: null,
    refresh: async () => { await refreshOperation(); },
    send: async (prompt: string, options?: any) => {
      const current = await bindings.get(task.id);
      assert.equal(current?.dispatchArmed, true, "先 durable armed 再 send");
      assert.equal(current?.commentQueue.find((item) => item.id === options.messageId)?.status, "sending");
      sends.push({ id: eventAgent.id, prompt, options, previousResults: (await dashi.listComments(baseUrl, task.id)).comments.filter((comment) => comment.authorId === "paseo-agent").length });
      if (sendMode === "throw") throw new Error("发送回复丢失");
      if (sendMode === "hang") { await sendGate.promise; return; }
      agentStatus = "running";
      activeTurnId = `queued-turn-${sends.length}`;
      await emitStart(activeTurnId);
      if (sendMode === "fast") await end(activeTurnId);
    },
  };
  const paseo = { agents: { ref: (id: string) => { assert.equal(id, eventAgent.id); return agent; } },
    workspaces: { open() { throw new Error("队列不能创建新 Agent"); } } } as unknown as PaseoApi;
  let queue = createCommentQueueRuntime(bindings, lock, { baseUrl, intervalMs: 60_000, sendTimeoutMs: 30 });
  function register() {
    registerLifecycle({ on: (name: string, handler: any) => { hooks.set(name, handler); } } as never,
      bindings, (api) => queue.attach(api), lock, queue);
    registerHandlers({ handle: (contract: any, handler: any) => { handlers.set(contract.name, handler); } } as never,
      bindings, createSettingsStore({ filePath: path.join(directory, "settings.json") }), createTaskPlansStore({ filePath: path.join(directory, "plans.json") }),
      undefined, undefined, lock, queue);
  }
  async function request(input: Record<string, unknown>) {
    const result = await handlers.get(commentQueue.name)!(CommentQueueRequestSchema.parse({ taskId: task.id, ...input }), { paseo });
    CommentQueueStateSchema.parse(result.queue);
    return result.queue;
  }
  async function emitStart(turnId: string) {
    await hooks.get("agent.turn_started")!({ agent: eventAgent, turnId }, { paseo });
  }
  async function end(turnId: string | null, kind: "completed" | "failed" | "canceled" = "completed") {
    agentStatus = "idle"; activeTurnId = null;
    await hooks.get("agent.turn_ended")!({ agent: eventAgent, turnId, timeline: [{ type: "assistant_message", text: `完成 ${turnId}` }],
      outcome: kind === "failed" ? { kind, error: { message: "本轮失败", code: "mock" } } : kind === "canceled" ? { kind, reason: "用户取消" } : { kind } }, { paseo });
  }
  async function comment(body: string, bytes?: number[]) {
    let created = (await dashi.addComment(baseUrl, task.id, body)).comment;
    if (bytes) {
      const response = await fetch(`${baseUrl}/api/comments/${created.id}/attachments`, { method: "POST", headers: {
        "content-type": "image/png", "x-taskboard-filename": "image.png", "x-taskboard-attachment-kind": "inline",
      }, body: new Uint8Array(bytes) });
      assert.equal(response.status, 201);
      const { attachment } = await response.json() as any;
      const changed = await fetch(`${baseUrl}/api/comments/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: created.version, body: `${body}\n![本条图](api/attachments/${attachment.id}/content)` }) });
      assert.equal(changed.status, 200);
      created = (await changed.json() as any).comment;
    }
    return created;
  }
  register();
  await request({ action: "list" });
  return {
    task, baseUrl, bindingInput, lock, sends, request, comment, end, emitStart,
    get bindings() { return bindings; }, get queue() { return queue; },
    setAgent(status: string, turnId: string | null, pending: string[] = []) { agentStatus = status; activeTurnId = turnId; permissions = pending; },
    mode(value: typeof sendMode) { sendMode = value; }, refresh(fn: () => Promise<void>) { refreshOperation = fn; },
    async enqueue(commentId: string) { return request({ action: "enqueue", commentId, agentId: eventAgent.id }); },
    async reload() {
      queue.stop();
      bindings = createBindingsStore({ filePath });
      queue = createCommentQueueRuntime(bindings, lock, { baseUrl, intervalMs: 60_000, sendTimeoutMs: 30 });
      register(); await request({ action: "list" });
    },
    async close() {
      queue.stop(); sendGate.resolve(); await queue.kick(task.id);
      await app.close();
      if (previousUrl === undefined) delete process.env.DASHI_TASKBOARD_URL; else process.env.DASHI_TASKBOARD_URL = previousUrl;
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith("paseo-comment-queue-"));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("busy 显式入队，completed 写回后 FIFO 同 Agent，图片只取每条评论，普通评论不入队", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await f.emitStart("original-turn");
    const a = await f.comment("要求 A", [137, 80, 1]);
    const b = await f.comment("要求 B", [137, 80, 2]);
    await f.enqueue(a.id); await f.enqueue(b.id);
    await f.comment("普通意见不可混入队列", [137, 80, 3]);
    await f.queue.tick(); assert.equal(f.sends.length, 0);
    assert.equal((await f.request({ action: "list" })).items.length, 2);
    await f.end("original-turn"); await f.queue.kick(f.task.id);
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0].previousResults, 1);
    assert.match(f.sends[0].prompt, /要求 A/); assert.doesNotMatch(f.sends[0].prompt, /要求 B|普通意见|旧描述/);
    assert.deepEqual(f.sends[0].options.images, [{ data: Buffer.from([137, 80, 1]).toString("base64"), mimeType: "image/png" }]);
    await f.end("queued-turn-1"); await f.queue.kick(f.task.id);
    assert.equal(f.sends.length, 2); assert.equal(f.sends[1].previousResults, 2);
    assert.deepEqual(f.sends[1].options.images, [{ data: Buffer.from([137, 80, 2]).toString("base64"), mimeType: "image/png" }]);
    await f.end("queued-turn-2"); await f.queue.kick(f.task.id);
    assert.equal((await f.request({ action: "list" })).items.length, 0);
    assert.ok((await f.bindings.get(f.task.id))!.commentQueue.every((item) => !item.prompt && !item.body && !item.images.length));
    await f.enqueue(a.id); await f.queue.tick(); assert.equal(f.sends.length, 2);
  } finally { await f.close(); }
});

test("blocked + 原生 running + 旧 failed，在 reload 后匹配原轮 completed 唤醒，旧事件无效", { timeout: 60_000 }, async () => {
  const f = await fixture("blocked");
  try {
    await f.bindings.recordOutcome(f.task.id, "original-agent", { kind: "failed", at: new Date().toISOString(), message: "旧失败" });
    // 模拟 reload 前已发生且未收到的 started；入队时仍能看到真实 activeTurn。
    assert.equal((await f.bindings.get(f.task.id))!.acceptedTurnId, null);
    await f.enqueue((await f.comment("本轮真实要求")).id);
    assert.deepEqual((await f.bindings.get(f.task.id))!.commentQueueWait, { turnId: "original-turn", generation: 0 });
    await f.reload(); await f.queue.tick(); assert.equal(f.sends.length, 0);
    await f.end("old-turn"); await f.queue.kick(f.task.id); assert.equal(f.sends.length, 0);
    await f.end("original-turn"); await f.queue.kick(f.task.id);
    assert.equal(f.sends.length, 1); assert.match(f.sends[0].prompt, /本轮真实要求/);
    assert.equal(f.sends[0].options.images, undefined);
  } finally { await f.close(); }
});

test("取消与重复 enqueue 幂等，等待权限不发送，未排队评论不发送", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    f.setAgent("running", "original-turn", ["permission"]);
    const a = await f.comment("取消这条"); const b = await f.comment("保留这条");
    await Promise.all([f.enqueue(a.id), f.enqueue(a.id)]);
    await f.enqueue(b.id); await f.queue.tick(); assert.equal(f.sends.length, 0);
    const before = await f.request({ action: "list" }); assert.equal(before.items.length, 2);
    await f.request({ action: "cancel", itemId: before.items[0].id });
    await f.enqueue(a.id); await f.queue.tick(); assert.equal(f.sends.length, 0);
    await f.end("original-turn"); await f.queue.kick(f.task.id);
    assert.equal(f.sends.length, 0, "completed 仍有待处理权限时不得发送");
    assert.match((await f.request({ action: "list" })).waitingReason, /等待权限/);
    f.setAgent("idle", null, []); await f.queue.tick();
    assert.equal(f.sends.length, 1); assert.match(f.sends[0].prompt, /保留这条/);
  } finally { await f.close(); }
});

test("failed/canceled 暂停，显式 retry 恢复，不能因轮询无限重试", { timeout: 60_000 }, async () => {
  for (const kind of ["failed", "canceled"] as const) {
    const f = await fixture();
    try {
      await f.emitStart("original-turn"); await f.enqueue((await f.comment("失败后保留")).id);
      await f.end("original-turn", kind); await f.queue.tick(); await f.queue.tick();
      assert.equal(f.sends.length, 0); assert.match((await f.request({ action: "list" })).pauseReason, /暂停/);
      await f.request({ action: "retry" }); await f.queue.kick(f.task.id); assert.equal(f.sends.length, 1);
    } finally { await f.close(); }
  }
});

test("无队列时 failed 不遗留暂停；新原生 running 首次 enqueue 后 completed 正常发送", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await f.emitStart("original-turn"); await f.end("original-turn", "failed");
    assert.equal((await f.bindings.get(f.task.id))!.commentQueuePauseReason, null);
    f.setAgent("running", "new-native");
    await f.enqueue((await f.comment("新轮结束后继续")).id);
    assert.equal((await f.bindings.get(f.task.id))!.commentQueueWait?.turnId, "new-native");
    await f.emitStart("new-native");
    assert.equal((await f.bindings.get(f.task.id))!.acceptedTurnId, "new-native");
    assert.equal((await f.request({ action: "list" })).pauseReason, null);
    await f.end("new-native"); await f.queue.kick(f.task.id);
    assert.equal((await f.bindings.get(f.task.id))!.commentQueueWait, null);
    assert.equal(f.sends.length, 1); assert.match(f.sends[0].prompt, /新轮结束后继续/);
  } finally { await f.close(); }
});

test("旧 provider running 无 turnId：暂停且不猜上一轮结果，idle 后仅显式 retry 继续", { timeout: 60_000 }, async () => {
  const f = await fixture("blocked");
  try {
    f.setAgent("running", null);
    await f.enqueue((await f.comment("无法追踪旧轮仍保留这条")).id);
    assert.match((await f.request({ action: "list" })).pauseReason, /未返回可追踪的轮次 ID/);
    assert.equal((await f.bindings.get(f.task.id))!.commentQueueWait, null);
    await f.end(null, "failed"); await f.queue.tick(); await f.reload(); await f.queue.tick();
    assert.equal(f.sends.length, 0);
    assert.equal((await f.request({ action: "list" })).items[0].status, "queued");
    await f.request({ action: "retry" }); await f.queue.kick(f.task.id);
    assert.equal(f.sends.length, 1); assert.match(f.sends[0].prompt, /无法追踪旧轮仍保留这条/);
  } finally { await f.close(); }
});

test("发送回复不确定与 reload 均不重发，只能人工核对后移出并恢复后项", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.comment("结果不确定项"); const b = await f.comment("后续项");
    await f.enqueue(a.id); await f.enqueue(b.id); f.mode("throw");
    await f.end("original-turn"); await f.queue.kick(f.task.id);
    assert.equal(f.sends.length, 1);
    await f.reload(); await f.queue.tick();
    const state = await f.request({ action: "list" }); assert.equal(state.items[0].status, "uncertain");
    await assert.rejects(f.request({ action: "retry" }), /未确认/); assert.equal(f.sends.length, 1);
    await f.request({ action: "acknowledge", itemId: state.items[0].id }); f.mode("normal");
    await f.request({ action: "retry" }); await f.queue.kick(f.task.id);
    assert.equal(f.sends.length, 2); assert.match(f.sends[1].prompt, /后续项/);
  } finally { await f.close(); }
});

test("send 超时后迟到 started/ended 可消费，不重复发送；sameAgent upsert 保持 sending 关联", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await f.enqueue((await f.comment("只发送一次")).id); f.mode("hang");
    await f.end("original-turn"); await f.queue.kick(f.task.id);
    assert.equal(f.sends.length, 1);
    assert.equal((await f.request({ action: "list" })).items[0].status, "uncertain");
    await f.bindings.upsert(f.bindingInput);
    assert.equal((await f.bindings.get(f.task.id))!.dispatchArmed, true);
    f.setAgent("running", "late-start"); await f.emitStart("late-start");
    await f.bindings.upsert(f.bindingInput);
    assert.equal((await f.bindings.get(f.task.id))!.acceptedTurnId, "late-start");
    await f.end("late-start"); await f.queue.tick();
    assert.equal(f.sends.length, 1); assert.equal((await f.request({ action: "list" })).items.length, 0);
  } finally { await f.close(); }
});

test("reload 漏 ended：queued 原样保留，用户确认 idle 后恢复；sent 先 uncertain 再人工核对", { timeout: 60_000 }, async () => {
  const f = await fixture("blocked");
  try {
    await f.enqueue((await f.comment("不能丢掉的第一条")).id);
    f.setAgent("idle", null); await f.reload();
    assert.equal((await f.request({ action: "list" })).items[0].status, "queued");
    await f.queue.tick(); assert.equal(f.sends.length, 0);
    await f.request({ action: "retry" }); await f.queue.kick(f.task.id);
    assert.equal(f.sends.length, 1); assert.match(f.sends[0].prompt, /不能丢掉/);
    await f.enqueue((await f.comment("第二条保留")).id);
    f.setAgent("idle", null); await f.reload();
    await f.request({ action: "retry" });
    const state = await f.request({ action: "list" });
    assert.deepEqual(state.items.map((item: any) => item.status), ["uncertain", "queued"]);
    await f.request({ action: "acknowledge", itemId: state.items[0].id });
    await f.request({ action: "retry" }); await f.queue.kick(f.task.id);
    assert.equal(f.sends.length, 2); assert.match(f.sends[1].prompt, /第二条保留/);
  } finally { await f.close(); }
});

test("lifecycle eligibility GET 失败仍暂停/消费 sent，retry 先写回再发送后项", { timeout: 60_000 }, async () => {
  const f = await fixture(); const nativeFetch = globalThis.fetch;
  try {
    await f.enqueue((await f.comment("第一条")).id); await f.enqueue((await f.comment("第二条")).id);
    await f.end("original-turn"); await f.queue.kick(f.task.id); assert.equal(f.sends.length, 1);
    let failOnce = true;
    globalThis.fetch = async (input: any, init?: any) => {
      if (failOnce && String(input) === `${f.baseUrl}/api/tasks/${f.task.id}` && (!init?.method || init.method === "GET")) {
        failOnce = false; return Response.json({ error: { message: "模拟写回前 GET 失败" } }, { status: 503 });
      }
      return nativeFetch(input, init);
    };
    await f.end("queued-turn-1"); globalThis.fetch = nativeFetch;
    await f.queue.tick(); assert.equal(f.sends.length, 1);
    assert.ok((await f.bindings.get(f.task.id))!.pendingWriteback);
    assert.equal((await f.request({ action: "list" })).items[0].status, "queued");
    await f.request({ action: "retry" }); await f.queue.kick(f.task.id);
    assert.equal(f.sends.length, 2); assert.equal(f.sends[1].previousResults, 2);
    assert.equal((await f.bindings.get(f.task.id))!.pendingWriteback, null);
  } finally { globalThis.fetch = nativeFetch; await f.close(); }
});

test("enqueue 与 ended 同锁串行，快速 started/ended 回调不死锁；stop 阻止 await 后发送", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await f.emitStart("original-turn"); const c = await f.comment("竞态要求"); f.mode("fast");
    await Promise.all([f.enqueue(c.id), f.end("original-turn")]); await f.queue.kick(f.task.id); await f.queue.tick();
    assert.equal(f.sends.length, 1); assert.equal((await f.request({ action: "list" })).items.length, 0);
    f.setAgent("running", "another-native"); await f.enqueue((await f.comment("停止后不可发送")).id);
    const gate = deferred(); const entered = deferred();
    f.refresh(async () => { entered.resolve(); await gate.promise; });
    const ended = f.end("another-native"); await ended;
    const draining = f.queue.kick(f.task.id); await entered.promise;
    f.queue.stop(); gate.resolve(); await draining; assert.equal(f.sends.length, 1);
  } finally { await f.close(); }
});

test("终态和换绑定不继续旧队列", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await f.enqueue((await f.comment("旧绑定要求")).id);
    await f.bindings.upsert({ ...f.bindingInput, agentId: "replacement-agent" });
    await f.queue.tick(); assert.equal(f.sends.length, 0);
    assert.equal((await f.bindings.get(f.task.id))!.commentQueue.length, 0);
    await f.bindings.upsert(f.bindingInput);
    await f.enqueue((await f.comment("终态不发送")).id);
    const current = (await dashi.getTask(f.baseUrl, f.task.id)).task;
    await dashi.moveTask(f.baseUrl, f.task.id, { version: current.version, status: "done" });
    f.setAgent("idle", null); await f.queue.tick();
    assert.equal(f.sends.length, 0); assert.equal((await f.request({ action: "list" })).items.length, 0);
  } finally { await f.close(); }
});
