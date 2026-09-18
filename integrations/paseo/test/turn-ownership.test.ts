import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { PaseoApi } from "@getpaseo/client";

import { createBindingsStore, type BindingsStore } from "../server/bindings.ts";
import * as dashi from "../server/dashi-api.ts";
import { canStartTaskDispatch, createTaskMutationLock, dispatchBoundTask } from "../server/dispatch.ts";
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

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "dashi-paseo-turn-ownership-"));
  const module = (await import("../../../server/app.mjs")) as unknown as TestTaskboardModule;
  server = module.createTaskboardServer({
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

async function createBoundTask(bindings: BindingsStore, suffix: string) {
  const project = (await dashi.listProjects(baseUrl)).projects[0];
  const task = (await dashi.createTask(baseUrl, {
    projectId: project.id,
    title: `Turn ownership ${suffix}`,
  })).task;
  await bindings.upsert({
    taskId: task.id,
    taskIdentifier: task.identifier,
    projectId: project.id,
    workspaceId: `workspace-${suffix}`,
    agentId: `agent-${suffix}`,
    provider: "codex/gpt-5.6-sol",
  });
  return task;
}

function lifecycleHarness(bindings: BindingsStore, agentId: string, refreshError: Error | null = null) {
  const hooks = new Map<string, (event: any, context: { paseo: PaseoApi }) => Promise<void>>();
  const mutationLock = createTaskMutationLock();
  let refreshCalls = 0;
  const agent: {
    status: "idle" | "running";
    activeTurn: { turnId: string } | null;
    pendingPermissions: string[];
    refresh: () => Promise<{ agent: Record<string, never> }>;
  } = {
    status: "running" as const,
    activeTurn: null,
    pendingPermissions: [],
    async refresh() {
      refreshCalls += 1;
      if (refreshError) throw refreshError;
      return { agent: {} };
    },
  };
  const paseo = { agents: { ref: () => agent } } as unknown as PaseoApi;
  registerLifecycle({
    on(name: string, handler: (event: any, context: { paseo: PaseoApi }) => Promise<void>) {
      hooks.set(name, handler);
      return () => {};
    },
  } as never, bindings, undefined, mutationLock);
  const eventAgent = {
    id: agentId,
    workspaceId: "workspace-test",
    parentAgentId: null,
    provider: "codex",
    cwd: directory,
    title: null,
  };
  return {
    hooks,
    paseo,
    eventAgent,
    mutationLock,
    setAgentState(next: { status?: "idle" | "running"; activeTurn?: { turnId: string } | null; pendingPermissions?: string[] }) {
      if (next.status !== undefined) agent.status = next.status;
      if (next.activeTurn !== undefined) agent.activeTurn = next.activeTurn;
      if (next.pendingPermissions !== undefined) agent.pendingPermissions = next.pendingPermissions;
    },
    getRefreshCalls: () => refreshCalls,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const completedTimeline = [
  { type: "user_message", text: "开始" },
  { type: "assistant_message", text: "轮次结果" },
];

test("旧 bindings JSON 会在读取时补齐轮次门禁默认值", async () => {
  const filePath = path.join(directory, "legacy-turn-binding.json");
  const now = new Date().toISOString();
  await writeFile(filePath, JSON.stringify({
    byTaskId: {
      legacy: {
        taskId: "legacy",
        taskIdentifier: "LOCAL-LEGACY",
        projectId: "local",
        workspaceId: "workspace-legacy",
        agentId: "agent-legacy",
        provider: "codex/gpt-5.6-sol",
        createdAt: now,
        updatedAt: now,
        lastOutcome: null,
      },
    },
  }), "utf8");

  const bindings = createBindingsStore({ filePath });
  const legacy = await bindings.get("legacy");
  assert.equal(legacy?.dispatchArmed, false);
  assert.equal(legacy?.acceptedTurnId, null);
  assert.ok(await bindings.armDispatch("legacy", "agent-legacy"));
});

test("已有 Agent send 失败会撤销 armed，不阻塞下一次派发", async () => {
  const bindings = createBindingsStore({ filePath: path.join(directory, "send-failure.json") });
  const task = await createBoundTask(bindings, "send-failure");
  const agent = {
    status: "idle" as const,
    activeTurn: null,
    pendingPermissions: [],
    refresh: async () => ({ agent: {} }),
    send: async () => { throw new Error("send rejected"); },
  };
  const paseo = { agents: { ref: () => agent } } as unknown as PaseoApi;

  const result = await dispatchBoundTask(paseo, bindings, task, null, baseUrl);
  assert.equal(result.kind, "failed");
  assert.equal((await bindings.get(task.id))?.dispatchArmed, false);
  assert.equal((await bindings.get(task.id))?.acceptedTurnId, null);
});

test("显式派发的快 turn 不依赖 refresh，并拒绝旧 ended", async () => {
  const bindings = createBindingsStore({ filePath: path.join(directory, "fast-turn.json") });
  const task = await createBoundTask(bindings, "fast-turn");
  await bindings.armDispatch(task.id, "agent-fast-turn");
  const h = lifecycleHarness(bindings, "agent-fast-turn", new Error("refresh must not run"));

  await h.hooks.get("agent.turn_started")!({ agent: h.eventAgent, turnId: "fast-turn" }, { paseo: h.paseo });
  assert.equal(h.getRefreshCalls(), 0);
  assert.equal((await bindings.get(task.id))?.acceptedTurnId, "fast-turn");

  await h.hooks.get("agent.turn_ended")!({
    agent: h.eventAgent,
    turnId: "older-turn",
    outcome: { kind: "completed" },
    timeline: completedTimeline,
  }, { paseo: h.paseo });
  assert.equal((await bindings.get(task.id))?.acceptedTurnId, "fast-turn");
  assert.equal((await dashi.listComments(baseUrl, task.id)).comments.length, 0);

  await h.hooks.get("agent.turn_ended")!({
    agent: h.eventAgent,
    turnId: "fast-turn",
    outcome: { kind: "completed" },
    timeline: completedTimeline,
  }, { paseo: h.paseo });
  assert.equal((await bindings.get(task.id))?.acceptedTurnId, null);
  assert.equal((await dashi.getTask(baseUrl, task.id)).task.status, "in_review");
});

test("nullable turnId 不写回也不会留下 armed 锁", async () => {
  const bindings = createBindingsStore({ filePath: path.join(directory, "nullable-turn.json") });
  const task = await createBoundTask(bindings, "nullable-turn");
  await bindings.armDispatch(task.id, "agent-nullable-turn");
  const h = lifecycleHarness(bindings, "agent-nullable-turn");

  await h.hooks.get("agent.turn_started")!({ agent: h.eventAgent, turnId: null }, { paseo: h.paseo });
  assert.equal((await bindings.get(task.id))?.dispatchArmed, false);
  await h.hooks.get("agent.turn_ended")!({
    agent: h.eventAgent,
    turnId: null,
    outcome: { kind: "completed" },
    timeline: completedTimeline,
  }, { paseo: h.paseo });

  const released = await bindings.get(task.id);
  assert.equal(released?.dispatchArmed, false);
  assert.equal(released?.acceptedTurnId, null);
  assert.equal(released?.lastOutcome, null);
});

test("ended 前的 Dashi GET 失败会留下 pendingWriteback 并释放轮次资格", async () => {
  const bindings = createBindingsStore({ filePath: path.join(directory, "eligibility-failure.json") });
  const task = await createBoundTask(bindings, "eligibility-failure");
  await bindings.armDispatch(task.id, "agent-eligibility-failure");
  const h = lifecycleHarness(bindings, "agent-eligibility-failure");
  await h.hooks.get("agent.turn_started")!({ agent: h.eventAgent, turnId: "eligible-turn" }, { paseo: h.paseo });

  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = async () => { throw new Error("temporary Dashi outage"); };
  console.error = () => {};
  try {
    await h.hooks.get("agent.turn_ended")!({
      agent: h.eventAgent,
      turnId: "eligible-turn",
      outcome: { kind: "completed" },
      timeline: completedTimeline,
    }, { paseo: h.paseo });
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }

  const binding = await bindings.get(task.id);
  assert.equal(binding?.acceptedTurnId, null);
  assert.equal(binding?.pendingWriteback?.outcome.kind, "completed");
  assert.equal(binding?.pendingWriteback?.commentPosted, false);
});

test("reload 后仅在 Agent 明确 idle 时按旧 turn CAS 恢复，迟到 ended 不会归属新 generation", async () => {
  const bindings = createBindingsStore({ filePath: path.join(directory, "reload-stale-turn.json") });
  const task = await createBoundTask(bindings, "reload-stale-turn");
  await bindings.armDispatch(task.id, "agent-reload-stale-turn");
  await bindings.acceptStartedTurn(task.id, "agent-reload-stale-turn", "old-turn", null, false);
  const agent = {
    status: "idle" as const,
    activeTurn: null,
    pendingPermissions: [],
    refresh: async () => ({ agent: {} }),
  };
  const paseo = { agents: { ref: () => agent } } as unknown as PaseoApi;

  const readiness = await canStartTaskDispatch(paseo, bindings, task.id);
  assert.equal(readiness.ok, true);
  assert.equal((await bindings.get(task.id))?.acceptedTurnId, null);
  await bindings.armDispatch(task.id, "agent-reload-stale-turn");
  await bindings.acceptStartedTurn(task.id, "agent-reload-stale-turn", "new-turn", null, false);

  const h = lifecycleHarness(bindings, "agent-reload-stale-turn");
  await h.hooks.get("agent.turn_ended")!({
    agent: h.eventAgent,
    turnId: "old-turn",
    outcome: { kind: "completed" },
    timeline: completedTimeline,
  }, { paseo: h.paseo });

  const current = await bindings.get(task.id);
  assert.equal(current?.acceptedTurnId, "new-turn");
  assert.equal(current?.turnGeneration, 2);
  assert.equal((await dashi.listComments(baseUrl, task.id)).comments.length, 0);
});

test("reload 后 stale armed 仅在明确 idle 且超过启动窗口时释放", async () => {
  const bindings = createBindingsStore({ filePath: path.join(directory, "reload-stale-armed.json") });
  const task = await createBoundTask(bindings, "reload-stale-armed");
  const armed = await bindings.armDispatch(task.id, "agent-reload-stale-armed");
  assert.ok(armed);
  const agent = {
    status: "idle" as "idle" | "running",
    activeTurn: null as { turnId: string } | null,
    pendingPermissions: [] as string[],
    refresh: async () => ({ agent: {} }),
  };
  const paseo = { agents: { ref: () => agent } } as unknown as PaseoApi;

  const fresh = await canStartTaskDispatch(paseo, bindings, task.id, new Date(armed.updatedAt).getTime() + 1_000);
  assert.equal(fresh.ok, false);
  assert.equal((await bindings.get(task.id))?.dispatchArmed, true);

  agent.status = "running";
  agent.pendingPermissions = ["permission"];
  const busy = await canStartTaskDispatch(paseo, bindings, task.id, new Date(armed.updatedAt).getTime() + 60_000);
  assert.equal(busy.ok, false);
  assert.equal((await bindings.get(task.id))?.dispatchArmed, true);

  agent.status = "idle";
  agent.pendingPermissions = [];
  const stale = await canStartTaskDispatch(paseo, bindings, task.id, new Date(armed.updatedAt).getTime() + 60_000);
  assert.equal(stale.ok, true);
  assert.equal((await bindings.get(task.id))?.dispatchArmed, false);
});

test("旧 ended 写回与新派发按 task FIFO 串行，写回期间不提前释放 accepted turn", async () => {
  const bindings = createBindingsStore({ filePath: path.join(directory, "ended-dispatch-race.json") });
  const task = await createBoundTask(bindings, "ended-dispatch-race");
  await bindings.armDispatch(task.id, "agent-ended-dispatch-race");
  await bindings.acceptStartedTurn(task.id, "agent-ended-dispatch-race", "old-turn", null, false);
  const h = lifecycleHarness(bindings, "agent-ended-dispatch-race");
  const commentEntered = deferred();
  const releaseComment = deferred();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "POST" && url.endsWith(`/api/tasks/${task.id}/comments`)) {
      commentEntered.resolve();
      await releaseComment.promise;
    }
    return originalFetch(input, init);
  };
  try {
    const ended = h.hooks.get("agent.turn_ended")!({
      agent: h.eventAgent,
      turnId: "old-turn",
      outcome: { kind: "completed" },
      timeline: completedTimeline,
    }, { paseo: h.paseo });
    await commentEntered.promise;
    assert.equal((await bindings.get(task.id))?.acceptedTurnId, "old-turn");

    let newDispatchEntered = false;
    const newDispatch = h.mutationLock.run(task.id, async () => {
      newDispatchEntered = true;
      const current = (await dashi.getTask(baseUrl, task.id)).task;
      await dashi.moveTask(baseUrl, task.id, { version: current.version, status: "in_progress" });
      await bindings.armDispatch(task.id, "agent-ended-dispatch-race");
      await bindings.acceptStartedTurn(task.id, "agent-ended-dispatch-race", "new-turn", null, false);
    });
    await Promise.resolve();
    assert.equal(newDispatchEntered, false);

    releaseComment.resolve();
    await Promise.all([ended, newDispatch]);
    assert.equal((await dashi.getTask(baseUrl, task.id)).task.status, "in_progress");
    assert.equal((await bindings.get(task.id))?.acceptedTurnId, "new-turn");
  } finally {
    globalThis.fetch = originalFetch;
    releaseComment.resolve();
  }
});

test("旧 ended 写回期间 native started 排队，旧轮完成后仍接管新轮并回写", async () => {
  const bindings = createBindingsStore({ filePath: path.join(directory, "ended-native-race.json") });
  const task = await createBoundTask(bindings, "ended-native-race");
  await dashi.moveTask(baseUrl, task.id, { version: task.version, status: "in_progress" });
  const h = lifecycleHarness(bindings, "agent-ended-native-race");
  h.setAgentState({ status: "running", activeTurn: { turnId: "first-turn" } });
  await h.hooks.get("agent.turn_started")!({ agent: h.eventAgent, turnId: "first-turn" }, { paseo: h.paseo });

  const commentEntered = deferred();
  const releaseComment = deferred();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "POST" && url.endsWith(`/api/tasks/${task.id}/comments`)) {
      commentEntered.resolve();
      await releaseComment.promise;
    }
    return originalFetch(input, init);
  };
  try {
    const ended = h.hooks.get("agent.turn_ended")!({
      agent: h.eventAgent,
      turnId: "first-turn",
      outcome: { kind: "completed" },
      timeline: completedTimeline,
    }, { paseo: h.paseo });
    await commentEntered.promise;
    h.setAgentState({ status: "running", activeTurn: { turnId: "second-turn" } });
    const started = h.hooks.get("agent.turn_started")!({ agent: h.eventAgent, turnId: "second-turn" }, { paseo: h.paseo });
    await Promise.resolve();
    assert.equal((await bindings.get(task.id))?.acceptedTurnId, "first-turn");

    releaseComment.resolve();
    await ended;
    await started;
    assert.equal((await bindings.get(task.id))?.acceptedTurnId, "second-turn");
    h.setAgentState({ status: "idle", activeTurn: null });
    await h.hooks.get("agent.turn_ended")!({
      agent: h.eventAgent,
      turnId: "second-turn",
      outcome: { kind: "completed" },
      timeline: completedTimeline,
    }, { paseo: h.paseo });
    assert.equal((await dashi.getTask(baseUrl, task.id)).task.status, "in_review");
    assert.equal((await dashi.listComments(baseUrl, task.id)).comments.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    releaseComment.resolve();
  }
});
