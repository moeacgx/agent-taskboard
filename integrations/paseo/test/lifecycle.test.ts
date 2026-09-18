import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { PaseoApi } from "@getpaseo/client";

import { createBindingsStore } from "../server/bindings.ts";
import { canStartTaskDispatch, createTaskMutationLock } from "../server/dispatch.ts";
import * as dashi from "../server/dashi-api.ts";
import { registerLifecycle } from "../server/lifecycle.ts";

interface TestTaskboardServer {
  listen(options: { host: string; port: number }): Promise<{ port: number }>;
  close(): Promise<void>;
}
interface TestTaskboardModule {
  createTaskboardServer(options: Record<string, unknown>): TestTaskboardServer;
}

let directory: string;
let server: TestTaskboardServer;
let baseUrl: string;
let previousUrl: string | undefined;

async function importDashiServer(): Promise<TestTaskboardModule> {
  return (await import("../../../server/app.mjs")) as unknown as TestTaskboardModule;
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "dashi-paseo-lifecycle-"));
  server = (await importDashiServer()).createTaskboardServer({
    dataDirectory: directory,
    databasePath: path.join(directory, "taskboard.sqlite"),
    attachmentsDirectory: path.join(directory, "attachments"),
    staticDirectory: directory,
  });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${address.port}`;
  previousUrl = process.env.DASHI_TASKBOARD_URL;
  process.env.DASHI_TASKBOARD_URL = baseUrl;
});

after(async () => {
  await server.close();
  if (previousUrl === undefined) delete process.env.DASHI_TASKBOARD_URL;
  else process.env.DASHI_TASKBOARD_URL = previousUrl;
  await rm(directory, { recursive: true, force: true });
});

async function lifecycleHarness() {
  const bindings = createBindingsStore({ filePath: path.join(directory, `${Math.random()}.bindings.json`) });
  const hooks = new Map<string, (event: any, context: { paseo: PaseoApi }) => Promise<void>>();
  const fakeServer = {
    on(name: string, handler: (event: any, context: { paseo: PaseoApi }) => Promise<void>) {
      hooks.set(name, handler);
      return () => {};
    },
  };
  registerLifecycle(fakeServer as never, bindings, undefined, createTaskMutationLock());
  let status: "idle" | "running" = "idle";
  let activeTurnId: string | null = null;
  let pendingPermissions: string[] = [];
  const agent = {
    get status() { return status; },
    get activeTurn() { return activeTurnId ? { turnId: activeTurnId, startedAt: null } : null; },
    get pendingPermissions() { return pendingPermissions; },
    refresh: async () => ({ agent: {} }),
  };
  const paseo = { agents: { ref: () => agent } } as unknown as PaseoApi;
  return {
    bindings,
    hooks,
    paseo,
    setAgent(next: { status?: "idle" | "running"; activeTurnId?: string | null; pendingPermissions?: string[] }) {
      if (next.status !== undefined) status = next.status;
      if (next.activeTurnId !== undefined) activeTurnId = next.activeTurnId;
      if (next.pendingPermissions !== undefined) pendingPermissions = next.pendingPermissions;
    },
  };
}

async function createBoundTask(h: Awaited<ReturnType<typeof lifecycleHarness>>) {
  const project = (await dashi.listProjects(baseUrl)).projects[0];
  const task = (await dashi.createTask(baseUrl, { projectId: project.id, title: "Lifecycle ownership" })).task;
  await h.bindings.upsert({
    taskId: task.id,
    taskIdentifier: task.identifier,
    projectId: project.id,
    workspaceId: "workspace-lifecycle",
    agentId: "agent-lifecycle",
    provider: "codex/gpt-5.6-sol",
  });
  return task;
}

function agentEvent() {
  return { id: "agent-lifecycle", workspaceId: "workspace-lifecycle", parentAgentId: null, provider: "codex", cwd: directory, title: null };
}
const completedTimeline = [{ type: "user_message", text: "开始" }, { type: "assistant_message", text: "本轮真实回复" }];

test("done 任务的原生 direct turn 不改变状态、评论或绑定 outcome", async () => {
  const h = await lifecycleHarness();
  const created = await createBoundTask(h);
  const done = (await dashi.moveTask(baseUrl, created.id, { version: created.version, status: "done" })).task;

  h.setAgent({ activeTurnId: "native-done" });
  await h.hooks.get("agent.turn_started")!({ agent: agentEvent(), turnId: "native-done" }, { paseo: h.paseo });
  await h.hooks.get("agent.turn_ended")!({ agent: agentEvent(), turnId: "native-done", outcome: { kind: "completed" }, timeline: completedTimeline }, { paseo: h.paseo });

  assert.equal((await dashi.getTask(baseUrl, created.id)).task.status, "done");
  assert.equal((await dashi.listComments(baseUrl, created.id)).comments.length, 0);
  assert.equal((await h.bindings.get(created.id))?.lastOutcome, null);
  assert.equal(done.archivedAt, null);
});

test("已接受旧 turn 的 busy/权限状态会在返工状态移动前被阻止", async () => {
  const h = await lifecycleHarness();
  const task = await createBoundTask(h);
  await h.bindings.armDispatch(task.id, "agent-lifecycle");
  h.setAgent({ status: "running", activeTurnId: "old-turn", pendingPermissions: ["permission"] });
  await h.hooks.get("agent.turn_started")!({ agent: agentEvent(), turnId: "old-turn" }, { paseo: h.paseo });

  const readiness = await canStartTaskDispatch(h.paseo, h.bindings, task.id);
  assert.equal(readiness.ok, false);
  assert.equal((await h.bindings.get(task.id))?.acceptedTurnId, "old-turn");
  assert.equal((await dashi.getTask(baseUrl, task.id)).task.status, "in_progress");
});

test("processing 中无已接管 turn 的原生续聊按真实 active turn 接管并回写", async () => {
  const h = await lifecycleHarness();
  const created = await createBoundTask(h);
  await dashi.moveTask(baseUrl, created.id, { version: created.version, status: "in_progress" });

  h.setAgent({ status: "running", activeTurnId: "native-processing", pendingPermissions: [] });
  await h.hooks.get("agent.turn_started")!({ agent: agentEvent(), turnId: "native-processing" }, { paseo: h.paseo });
  h.setAgent({ status: "idle", activeTurnId: null });
  await h.hooks.get("agent.turn_ended")!({ agent: agentEvent(), turnId: "native-processing", outcome: { kind: "completed" }, timeline: completedTimeline }, { paseo: h.paseo });

  assert.equal((await dashi.getTask(baseUrl, created.id)).task.status, "in_review");
  assert.equal((await dashi.listComments(baseUrl, created.id)).comments.at(-1)?.body, "本轮真实回复");
  assert.equal((await h.bindings.get(created.id))?.lastOutcome?.kind, "completed");
});
