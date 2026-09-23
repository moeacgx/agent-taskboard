import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import type { PaseoApi } from "@getpaseo/client";
import type { Comment } from "../shared/contracts.ts";
import * as contracts from "../shared/contracts.ts";
import * as dashi from "../server/dashi-api.ts";
import { createBindingsStore } from "../server/bindings.ts";
import { createPaseoAutomationRuntime } from "../server/automation.ts";
import { createTaskDispatchCoordinator, createTaskMutationLock } from "../server/dispatch.ts";
import { registerHandlers } from "../server/handlers.ts";
import { createSettingsStore } from "../server/settings.ts";
import { createTaskPlansStore } from "../server/task-plans.ts";

interface TestTaskboardServer { listen(options: { host: string; port: number }): Promise<{ port: number }>; close(): Promise<void>; }
interface TestTaskboardModule { createTaskboardServer(options: Record<string, unknown>): TestTaskboardServer; }
type Handler = (input: any, context: { paseo: PaseoApi }) => Promise<any>;
const execFile = promisify(execFileCallback);

let directory: string;
let server: TestTaskboardServer;
let baseUrl: string;
let previousUrl: string | undefined;
const automationRuntimes: Array<{ stop(): Promise<void> }> = [];

async function importDashiServer(): Promise<TestTaskboardModule> {
  return (await import("../../../server/app.mjs")) as unknown as TestTaskboardModule;
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "dashi-paseo-board-handler-"));
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
  await Promise.all(automationRuntimes.map((runtime) => runtime.stop()));
  await server.close();
  if (previousUrl === undefined) delete process.env.DASHI_TASKBOARD_URL;
  else process.env.DASHI_TASKBOARD_URL = previousUrl;
  await rm(directory, { recursive: true, force: true });
});

async function harness() {
  const bindings = createBindingsStore({ filePath: path.join(directory, `${Math.random()}.bindings.json`) });
  const settings = createSettingsStore({ filePath: path.join(directory, `${Math.random()}.settings.json`) });
  const plans = createTaskPlansStore({ filePath: path.join(directory, `${Math.random()}.plans.json`) });
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    handle(contract: { name: string }, handler: Handler) { handlers.set(contract.name, handler); },
    on() { return () => {}; },
    before() { return () => {}; },
  };
  const coordinator = createTaskDispatchCoordinator();
  const mutationLock = createTaskMutationLock();
  const automation = createPaseoAutomationRuntime(settings, plans, bindings, coordinator, mutationLock);
  automationRuntimes.push(automation);
  let agentStatus: "idle" | "running" = "idle";
  let pendingPermissions: string[] = [];
  let sendOperation: () => Promise<void> = async () => {};
  const agent = {
    id: "agent-handler-test",
    get status() { return agentStatus; },
    get pendingPermissions() { return pendingPermissions; },
    refresh: async () => ({ agent: {} }),
    send: async (prompt: string) => { sends += 1; sentPrompts.push(prompt); await sendOperation(); },
  };
  let sends = 0;
  const sentPrompts: string[] = [];
  let creates = 0;
  let failCreate = false;
  let providerSnapshot = {
    entries: [{
      provider: "grok",
      enabled: true,
      status: "ready",
      defaultModeId: "auto-review",
      models: [{
        id: "grok-4.6",
        label: "Example Grok",
        isSelectable: true,
        defaultThinkingOptionId: "xhigh",
      }],
    }],
  };
  let readFeatures: () => Promise<unknown> = async () => ({
    features: [{ id: "auto_accept", value: false }],
  });
  const projectEntries: Array<{
    projectId: string;
    projectDisplayName: string;
    projectCustomName?: string | null;
    projectRootPath: string;
    projectKind: "directory" | "git" | "non_git";
  }> = [];
  const workspaceEntries: Array<{ id: string; projectId?: string; workspaceDirectory?: string; name?: string | null }> = [];
  const workspaceListCursors: Array<string | null> = [];
  const createdWorkspaceSources: Array<{
    cwd: string;
    projectId?: string;
    action: "branch-off" | "checkout";
    branchName?: string;
    refName?: string;
    baseBranch?: string;
  }> = [];
  const openedWorkspacePaths: string[] = [];
  const createdAgentConfigs: Array<{ provider: string; modeId?: string; thinkingOptionId?: string }> = [];
  let createdWorkspace = 0;
  const paseo = {
    projects: {
      list: async () => ({ projects: projectEntries }),
    },
    workspaces: {
      open: async (workspacePath: string) => {
        openedWorkspacePaths.push(workspacePath);
        return {
          id: "workspace-handler-test",
          agents: {
            create: async ({ config }: { config: { provider: string; modeId?: string; thinkingOptionId?: string } }) => {
              creates += 1;
              createdAgentConfigs.push(config);
              if (failCreate) throw new Error("模拟 Agent 创建失败");
              return agent;
            },
          },
        };
      },
      list: async (options?: { page?: { limit?: number; cursor?: string } }) => {
        const offset = Number(options?.page?.cursor ?? 0);
        const limit = options?.page?.limit ?? 200;
        const nextOffset = Math.min(offset + limit, workspaceEntries.length);
        workspaceListCursors.push(options?.page?.cursor ?? null);
        return {
          entries: workspaceEntries.slice(offset, nextOffset),
          pageInfo: {
            hasMore: nextOffset < workspaceEntries.length,
            nextCursor: nextOffset < workspaceEntries.length ? String(nextOffset) : null,
          },
        };
      },
      ref: (id: string) => ({ refresh: async () => workspaceEntries.find((workspace) => workspace.id === id) ?? null }),
      create: async ({ source, title }: { source: { cwd: string; projectId?: string; action: "branch-off" | "checkout"; branchName?: string; refName?: string; baseBranch?: string }; title?: string }) => {
        createdWorkspaceSources.push(source);
        const branch = source.action === "branch-off" ? source.branchName! : source.refName!;
        const target = path.join(path.dirname(source.cwd), `.paseo-handler-${createdWorkspace += 1}-${randomUUID()}-${branch.replace(/[^a-zA-Z0-9._-]+/g, "-")}`);
        const args = source.action === "branch-off"
          ? ["-C", source.cwd, "worktree", "add", "-b", branch, target, source.baseBranch ?? "HEAD"]
          : ["-C", source.cwd, "worktree", "add", target, branch];
        await execFile("git", args, { windowsHide: true });
        const workspace = { id: `workspace-worktree-${createdWorkspace}`, workspaceDirectory: target, name: title ?? null };
        workspaceEntries.push(workspace);
        return {
          id: workspace.id,
          directory: workspace.workspaceDirectory,
          refresh: async () => workspace,
        };
      },
    },
    agents: { ref: () => agent, list: async () => ({ entries: [] }) },
    providers: {
      snapshot: async () => providerSnapshot,
      listFeatures: async () => readFeatures(),
    },
  } as unknown as PaseoApi;
  registerHandlers(fakeServer as never, bindings, settings, plans, coordinator, automation, mutationLock);
  return {
    bindings,
    settings,
    plans,
    handlers,
    paseo,
    projectEntries,
    workspaceEntries,
    workspaceListCursors,
    createdWorkspaceSources,
    openedWorkspacePaths,
    createdAgentConfigs,
    setFailCreate: (value: boolean) => { failCreate = value; },
    setAgentStatus: (value: "idle" | "running") => { agentStatus = value; },
    setPendingPermissions: (value: string[]) => { pendingPermissions = value; },
    setSendOperation: (value: () => Promise<void>) => { sendOperation = value; },
    setProviderSnapshot: (value: typeof providerSnapshot) => { providerSnapshot = value; },
    setFeatureReader: (value: () => Promise<unknown>) => { readFeatures = value; },
    getSends: () => sends,
    getCreates: () => creates,
    automation,
    mutationLock,
    sentPrompts,
  };
}

async function projectId(): Promise<string> {
  return (await dashi.listProjects(baseUrl)).projects[0].id;
}

async function createFixtureProject(name: string): Promise<string> {
  const id = `automation-${randomUUID()}`;
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name, workspacePath: directory }),
  });
  assert.equal(response.status, 201);
  return id;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function initializeGitRepository(): Promise<string> {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "dashi-paseo-worktree-test-"));
  const repository = path.join(fixture, "repository");
  await execFile("git", ["init", repository], { windowsHide: true });
  await execFile("git", ["-C", repository, "config", "user.email", "paseo-test@example.invalid"], { windowsHide: true });
  await execFile("git", ["-C", repository, "config", "user.name", "Paseo Worktree Test"], { windowsHide: true });
  await writeFile(path.join(repository, "README.md"), "worktree fixture\n", "utf8");
  await execFile("git", ["-C", repository, "add", "README.md"], { windowsHide: true });
  await execFile("git", ["-C", repository, "commit", "-m", "initial"], { windowsHide: true });
  await execFile("git", ["-C", repository, "branch", "-M", "main"], { windowsHide: true });
  return repository;
}

test("真实 move-task-board handler: 缺配置不移动，保存后派发一次，同列不重派", async () => {
  const h = await harness();
  const project = await projectId();
  const created = await dashi.createTask(baseUrl, { projectId: project, title: "Handler board path" });
  const move = h.handlers.get(contracts.moveTaskBoard.name)!;

  const missing = await move({ id: created.task.id, version: created.task.version, status: "in_progress" }, { paseo: h.paseo });
  assert.equal(missing.dispatch, "needs_configuration");
  assert.equal((await dashi.getTask(baseUrl, created.task.id)).task.status, "backlog");

  await h.settings.upsert({
    projectId: project,
    workspacePath: directory,
    profile: { id: "qa-tester", name: "QA tester", provider: "codex", model: "gpt-5.6-sol", modeId: "full-access", thinkingOptionId: "high", featureValues: {} },
    updatedAt: new Date().toISOString(),
  });
  const started = await move({ id: created.task.id, version: created.task.version, status: "in_progress" }, { paseo: h.paseo });
  assert.equal(started.dispatch, "started");
  assert.equal(h.getSends(), 1);

  const sameColumn = await move({ id: created.task.id, version: started.task.version, status: "in_progress", sortOrder: 2000 }, { paseo: h.paseo });
  assert.equal(sameColumn.dispatch, "none");
  assert.equal(h.getSends(), 1);
});

test("真实 handler: stale version rejects before dispatch and create failure becomes blocked with comment", async () => {
  const h = await harness();
  const project = await projectId();
  const stale = await dashi.createTask(baseUrl, { projectId: project, title: "Handler stale version" });
  await h.settings.upsert({
    projectId: project,
    workspacePath: directory,
    profile: { id: "qa-tester", name: "QA tester", provider: "codex", model: "gpt-5.6-sol", modeId: "full-access", thinkingOptionId: "high", featureValues: {} },
    updatedAt: new Date().toISOString(),
  });
  const move = h.handlers.get(contracts.moveTaskBoard.name)!;
  await dashi.moveTask(baseUrl, stale.task.id, { version: stale.task.version, status: "todo" });
  await assert.rejects(() => move({ id: stale.task.id, version: stale.task.version, status: "in_progress" }, { paseo: h.paseo }), (error: unknown) => error instanceof dashi.DashiApiError && error.code === "VERSION_CONFLICT");
  assert.equal(h.getSends(), 0);
  assert.equal((await dashi.getTask(baseUrl, stale.task.id)).task.status, "todo");

  const failed = await dashi.createTask(baseUrl, { projectId: project, title: "Handler create failure" });
  h.setFailCreate(true);
  const result = await move({ id: failed.task.id, version: failed.task.version, status: "in_progress" }, { paseo: h.paseo });
  assert.equal(result.dispatch, "failed");
  assert.equal(result.task.status, "blocked");
  const current = await dashi.getTask(baseUrl, failed.task.id);
  assert.equal(current.task.status, "blocked");
  const comments = await dashi.listComments(baseUrl, failed.task.id);
  assert.match(comments.comments.at(-1)?.body ?? "", /模拟 Agent 创建失败/);
});

test("归档/恢复使用返回版本、保留绑定；运行中归档被阻止；归档任务可删除", async () => {
  const h = await harness();
  const project = await projectId();
  const created = await dashi.createTask(baseUrl, { projectId: project, title: "Archive lifecycle" });
  await h.bindings.upsert({
    taskId: created.task.id,
    taskIdentifier: created.task.identifier,
    projectId: project,
    workspaceId: "workspace-archive",
    agentId: "agent-handler-test",
    provider: "codex/gpt-5.6-sol",
  });
  const archive = h.handlers.get(contracts.archiveTask.name)!;
  const restore = h.handlers.get(contracts.restoreTask.name)!;
  const remove = h.handlers.get(contracts.deleteTask.name)!;

  h.setAgentStatus("running");
  await assert.rejects(() => archive({ id: created.task.id, version: created.task.version }, { paseo: h.paseo }), /仍在运行或等待权限/);
  assert.equal((await dashi.getTask(baseUrl, created.task.id)).task.archivedAt, null);
  h.setAgentStatus("idle");

  const archived = await archive({ id: created.task.id, version: created.task.version }, { paseo: h.paseo });
  assert.ok(archived.task.archivedAt);
  assert.equal((await h.bindings.get(created.task.id))?.agentId, "agent-handler-test");
  await assert.rejects(() => restore({ id: created.task.id, version: created.task.version }, { paseo: h.paseo }), (error: unknown) => error instanceof dashi.DashiApiError && error.code === "VERSION_CONFLICT");

  const restored = await restore({ id: created.task.id, version: archived.task.version }, { paseo: h.paseo });
  assert.equal(restored.task.archivedAt, null);
  const archivedAgain = await archive({ id: created.task.id, version: restored.task.version }, { paseo: h.paseo });
  assert.deepEqual(await remove({ id: created.task.id, version: archivedAgain.task.version }, { paseo: h.paseo }), { deleted: true });
  await assert.rejects(() => dashi.getTask(baseUrl, created.task.id), (error: unknown) => error instanceof dashi.DashiApiError && error.code === "TASK_NOT_FOUND");
  assert.equal((await h.bindings.get(created.task.id))?.agentId, "agent-handler-test");
});

test("首次与返工 send 使用最新人工评论，过滤 Paseo 与真实 Agent 回写", async () => {
  const h = await harness();
  const project = await projectId();
  const task = (await dashi.createTask(baseUrl, {
    projectId: project,
    title: "评论驱动提示词",
    description: "旧描述：只回复通过",
  })).task;
  const configuration = {
    projectId: project,
    workspacePath: directory,
    profile: { id: "qa-tester", name: "QA tester", provider: "codex", model: "gpt-5.6-sol", modeId: "full-access", thinkingOptionId: "high", featureValues: {} },
    updatedAt: new Date().toISOString(),
  };
  await dashi.addComment(baseUrl, task.id, "旧人工背景", dashi.PLUGIN_UI_ACTOR);
  await dashi.addComment(baseUrl, task.id, "说你好", dashi.PLUGIN_UI_ACTOR);
  await dashi.addComment(baseUrl, task.id, "三列拖拽自动执行通过", dashi.PLUGIN_AGENT_ACTOR);

  const first = await import("../server/dispatch.ts").then(({ dispatchBoundTask }) =>
    dispatchBoundTask(h.paseo, h.bindings, task, configuration, baseUrl),
  );
  assert.equal(first.kind, "started");
  assert.equal(h.sentPrompts.length, 1);
  assert.match(h.sentPrompts[0], /最新人工要求[\s\S]*说你好/);
  assert.match(h.sentPrompts[0], /旧描述：只回复通过/);
  assert.match(h.sentPrompts[0], /不要查找或调用 taskctl[\s\S]*不要读取或伪造 CODEX_THREAD_ID/);
  assert.doesNotMatch(h.sentPrompts[0], /三列拖拽自动执行通过/);

  // 本轮已经收到 started/ended；没有模拟结束就再次 send 现在应被 P1 门禁拒绝。
  await h.bindings.acceptStartedTurn(task.id, "agent-handler-test", "first-turn", "first-turn", false);
  await h.bindings.consumeEndedTurn(task.id, "agent-handler-test", "first-turn");

  await dashi.addComment(baseUrl, task.id, "返工时也只说你好", dashi.PLUGIN_UI_ACTOR);
  const rework = await import("../server/dispatch.ts").then(({ dispatchBoundTask }) =>
    dispatchBoundTask(h.paseo, h.bindings, task, configuration, baseUrl),
  );
  assert.equal(rework.kind, "continued");
  assert.equal(h.sentPrompts.length, 2);
  assert.match(h.sentPrompts[1], /最新人工要求[\s\S]*返工时也只说你好/);
  assert.doesNotMatch(h.sentPrompts[1], /三列拖拽自动执行通过/);
});

test("评论读取失败时不创建也不发送 Agent", async () => {
  const h = await harness();
  const project = await projectId();
  const task = (await dashi.createTask(baseUrl, { projectId: project, title: "评论读取失败" })).task;
  const configuration = {
    projectId: project,
    workspacePath: directory,
    profile: { id: "qa-tester", name: "QA tester", provider: "codex", model: "gpt-5.6-sol", modeId: "full-access", thinkingOptionId: "high", featureValues: {} },
    updatedAt: new Date().toISOString(),
  };
  const result = await import("../server/dispatch.ts").then(({ dispatchBoundTask }) =>
    dispatchBoundTask(h.paseo, h.bindings, task, configuration, "http://127.0.0.1:1"),
  );
  assert.equal(result.kind, "failed");
  assert.equal(h.getCreates(), 0);
  assert.equal(h.getSends(), 0);
});

test("保存计划不会被 Grok 慢 feature 读取阻塞；已知无效模型拒绝；重复保存不创建第二个任务", async () => {
  const h = await harness();
  const project = await projectId();
  const before = (await dashi.listTasks(baseUrl, { projectId: project })).tasks.length;
  const task = (await dashi.createTask(baseUrl, { projectId: project, title: "Grok 计划保存" })).task;
  const savePlan = h.handlers.get(contracts.saveTaskExecutionPlan.name)!;
  h.setFeatureReader(() => new Promise(() => {}));

  const input = {
    taskId: task.id,
    projectId: project,
    workspacePath: directory,
    profile: {
      id: "paseo-catalog-model:grok:grok-4.6",
      name: "Grok · Example Grok",
      provider: "grok",
      model: "grok-4.6",
    },
  };
  const startedAt = Date.now();
  const first = await savePlan(input, { paseo: h.paseo });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 4_000 && elapsed < 8_000, `慢 feature 应在保存桥 15 秒前结束，实际 ${elapsed}ms`);
  assert.equal(first.assignment.kind, "planned");
  assert.equal(first.assignment.profile.modeId, "auto-review");
  assert.equal(first.assignment.profile.thinkingOptionId, "xhigh");
  assert.equal(first.assignment.profile.featureValues, undefined);

  await savePlan(input, { paseo: h.paseo });
  assert.equal((await h.plans.list()).length, 1);
  assert.equal((await dashi.listTasks(baseUrl, { projectId: project })).tasks.length, before + 1);

  const invalid = (await dashi.createTask(baseUrl, { projectId: project, title: "无效模型" })).task;
  await assert.rejects(() => savePlan({
    ...input,
    taskId: invalid.id,
    profile: { ...input.profile, model: "grok-removed" },
  }, { paseo: h.paseo }), /模型已不可用/);
  assert.equal(await h.plans.get(invalid.id), null);
});

test("提示词过滤 authorType=agent 的真实 Agent 评论，而不误过滤 Paseo 人工评论", async () => {
  const { humanComments } = await import("../server/dispatch.ts");
  const base = {
    taskId: "task", attachments: [], version: 1, createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
  };
  const comments: Comment[] = [
    { ...base, id: "human", body: "说你好", authorType: "user", authorId: "paseo-plugin", authorName: "Paseo" },
    { ...base, id: "real-agent", body: "不要作为指令", authorType: "agent", authorId: "external-agent", authorName: "真实 Agent" },
    { ...base, id: "plugin-agent", body: "不要作为指令", authorType: "user", authorId: "paseo-agent", authorName: "Paseo Agent" },
  ];
  assert.deepEqual(humanComments(comments).map((comment) => comment.id), ["human"]);
});

test("Paseo Worktree：仅 Git 根可创建、daemon 登记返回目录、已检出分支拒绝且计划使用 Worktree cwd", async () => {
  const h = await harness();
  const repository = await initializeGitRepository();
  const nonGitDirectory = await mkdtemp(path.join(os.tmpdir(), "dashi-paseo-not-git-"));
  try {
    h.projectEntries.push({
      projectId: "project-worktree-source",
      projectDisplayName: "Worktree source",
      projectRootPath: repository,
      projectKind: "git",
    });
    for (let index = 0; index < 200; index += 1) {
      h.workspaceEntries.push({
        id: `workspace-before-source-${index}`,
        projectId: `project-before-source-${index}`,
        workspaceDirectory: path.join(repository, `.unused-${index}`),
      });
    }
    h.workspaceEntries.push({
      id: "workspace-source-on-second-page",
      projectId: "workspace-project-fallback",
      workspaceDirectory: repository,
    });
    const inspect = h.handlers.get(contracts.inspectPaseoWorktree.name)!;
    const create = h.handlers.get(contracts.createPaseoWorktree.name)!;
    const nonGit = await inspect({ workspacePath: nonGitDirectory }, { paseo: h.paseo });
    assert.equal(nonGit.gitRoot, null);
    assert.match(nonGit.error ?? "", /不是 Git 仓库/);
    await assert.rejects(() => create({
      workspacePath: nonGitDirectory,
      branch: "feature/non-git",
      branchMode: "new",
    }, { paseo: h.paseo }), /不是 Git 仓库/);

    const created = await create({
      workspacePath: repository,
      branch: "feature/worktree-qa",
      branchMode: "new",
    }, { paseo: h.paseo });
    assert.equal(created.context.type, "worktree");
    assert.equal(created.context.path, created.workspace.path);
    assert.equal(created.workspace.branch, "feature/worktree-qa");
    assert.equal(h.createdWorkspaceSources.at(-1)?.projectId, "project-worktree-source");
    assert.deepEqual(h.workspaceListCursors.slice(0, 2), [null, "200"]);
    assert.equal((await execFile("git", ["-C", created.workspace.path, "branch", "--show-current"], { windowsHide: true })).stdout.trim(), "feature/worktree-qa");
    assert.ok(created.scan.worktrees.some((worktree: { path: string }) => worktree.path === created.workspace.path));
    await assert.rejects(() => create({
      workspacePath: repository,
      branch: "feature/worktree-qa",
      branchMode: "existing",
    }, { paseo: h.paseo }), /已在现有 Worktree 中检出/);

    const project = await projectId();
    const task = (await dashi.createTask(baseUrl, { projectId: project, title: "Worktree cwd" })).task;
    const updateResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-taskboard-user-id": "paseo-plugin",
        "x-taskboard-user-name": "Paseo",
      },
      body: JSON.stringify({ version: task.version, developmentContext: created.context }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = (await updateResponse.json() as { task: contracts.Task }).task;
    const savePlan = h.handlers.get(contracts.saveTaskExecutionPlan.name)!;
    const result = await savePlan({
      taskId: updated.id,
      projectId: project,
      workspacePath: repository,
      profile: { id: "profile", name: "QA", provider: "codex", model: "gpt-5.6-luna" },
    }, { paseo: h.paseo });
    assert.equal(result.assignment.kind, "planned");
    assert.equal(result.assignment.workspacePath, created.workspace.path);
    assert.equal((await h.plans.get(updated.id))?.workspacePath, created.workspace.path);

    await h.bindings.upsert({
      taskId: updated.id,
      taskIdentifier: updated.identifier,
      projectId: updated.projectId,
      workspaceId: created.workspace.id,
      agentId: "agent-handler-test",
      provider: "codex/gpt-5.6-luna",
    });
    await assert.rejects(() => savePlan({
      taskId: updated.id,
      projectId: project,
      workspacePath: repository,
      profile: { id: "paseo-catalog-model:grok:grok-removed", name: "Bad", provider: "grok", model: "grok-removed" },
    }, { paseo: h.paseo }), /模型已不可用/);
    assert.equal((await h.bindings.get(updated.id))?.agentId, "agent-handler-test");
  } finally {
    await rm(path.dirname(repository), { recursive: true, force: true });
    await rm(nonGitDirectory, { recursive: true, force: true });
  }
});

test("完整属性 PATCH 含 status 时仍保留 developmentContext 与完整 Dashi 任务响应", async () => {
  const h = await harness();
  const project = await projectId();
  const task = (await dashi.createTask(baseUrl, { projectId: project, title: "属性 PATCH 不能截断" })).task;
  const bridge = h.handlers.get(contracts.bridgeRequest.name)!;
  const response = await bridge({
    method: "PATCH",
    path: `/api/tasks/${task.id}`,
    headers: { "content-type": "application/json" },
    body: {
      kind: "text",
      value: JSON.stringify({
        version: task.version,
        status: task.status,
        developmentContext: { type: "worktree", path: directory, branch: "main" },
      }),
    },
  }, { paseo: h.paseo });
  assert.equal(response.status, 200);
  assert.equal(response.body.kind, "json");
  const body = response.body.value as { task: { developmentContext?: { type?: string; path?: string }; participants?: unknown } };
  assert.equal(body.task.developmentContext?.type, "worktree");
  assert.equal(body.task.developmentContext?.path, directory);
  assert.ok(Array.isArray(body.task.participants));
});

test("完整属性 PATCH 不得绕过处理中派发与权限门禁", async () => {
  const h = await harness();
  const project = await projectId();
  const task = (await dashi.createTask(baseUrl, { projectId: project, title: "状态 PATCH 门禁", status: "todo" })).task;
  const bridge = h.handlers.get(contracts.bridgeRequest.name)!;
  const response = await bridge({
    method: "PATCH",
    path: `/api/tasks/${task.id}`,
    headers: { "content-type": "application/json" },
    body: {
      kind: "text",
      value: JSON.stringify({
        version: task.version,
        status: "in_progress",
        title: task.title,
        developmentContext: null,
      }),
    },
  }, { paseo: h.paseo });

  assert.equal(response.status, 409);
  assert.equal(response.body.kind, "json");
  assert.equal((response.body.value as { error?: { code?: string } }).error?.code, "TASK_STATUS_REQUIRES_MOVE");
  assert.equal((await dashi.getTask(baseUrl, task.id)).task.status, "todo");
  assert.equal(h.getSends(), 0);
});

test("跨项目 PATCH 同步计划与绑定，并让无计划任务继承目标项目默认配置", async () => {
  const h = await harness();
  const sourceProjectId = await createFixtureProject("Move source fixture");
  const targetProjectId = await createFixtureProject("Move target fixture");
  const profile = { id: "target-default", name: "Target default", provider: "grok", model: "grok-4.6" };
  await h.settings.upsert({
    projectId: targetProjectId,
    workspacePath: directory,
    profile,
    updatedAt: new Date().toISOString(),
  });
  const bridge = h.handlers.get(contracts.bridgeRequest.name)!;

  const inherited = (await dashi.createTask(baseUrl, {
    projectId: sourceProjectId,
    title: "Move then inherit target defaults",
    status: "todo",
  })).task;
  const movedWithoutPlan = await bridge({
    method: "PATCH",
    path: `/api/tasks/${inherited.id}`,
    headers: { "content-type": "application/json" },
    body: { kind: "text", value: JSON.stringify({ version: inherited.version, projectId: targetProjectId }) },
  }, { paseo: h.paseo });
  assert.equal(movedWithoutPlan.status, 200);
  assert.equal((await dashi.getTask(baseUrl, inherited.id)).task.projectId, targetProjectId);
  assert.equal(await h.plans.get(inherited.id), null);
  assert.equal(await h.bindings.get(inherited.id), null);
  assert.equal(h.getCreates(), 0);
  assert.equal(h.getSends(), 0);

  const movedTask = (await dashi.getTask(baseUrl, inherited.id)).task;
  const started = await h.handlers.get(contracts.moveTaskBoard.name)!({
    id: movedTask.id,
    version: movedTask.version,
    status: "in_progress",
  }, { paseo: h.paseo });
  assert.equal(started.dispatch, "started");
  assert.equal(h.openedWorkspacePaths.at(-1), directory);
  assert.equal(h.createdAgentConfigs.at(-1)?.provider, "grok/grok-4.6");

  const explicitResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: sourceProjectId,
      title: "Preserve explicit Paseo metadata",
      status: "todo",
      developmentContext: { type: "worktree", path: directory, branch: "main" },
    }),
  });
  assert.equal(explicitResponse.status, 201);
  const explicit = (await explicitResponse.json() as { task: contracts.Task }).task;
  const explicitProfile = { id: "explicit", name: "Explicit", provider: "codex", model: "gpt-5.6-sol", modeId: "auto-review", thinkingOptionId: "low" };
  await h.plans.upsert({
    taskId: explicit.id,
    projectId: sourceProjectId,
    workspacePath: directory,
    profile: explicitProfile,
  });
  await h.bindings.upsert({
    taskId: explicit.id,
    taskIdentifier: explicit.identifier,
    projectId: sourceProjectId,
    workspaceId: "workspace-existing",
    agentId: "agent-handler-test",
    provider: "codex/gpt-5.6-sol",
    agentTitle: "Existing agent",
    agentModel: "gpt-5.6-sol",
  });
  await h.bindings.armDispatch(explicit.id, "agent-handler-test");
  await h.bindings.acceptStartedTurn(explicit.id, "agent-handler-test", "owned-turn", "owned-turn", false);
  const bindingBefore = (await h.bindings.get(explicit.id))!;

  const movedExplicit = await bridge({
    method: "PATCH",
    path: `/api/tasks/${explicit.id}`,
    headers: { "content-type": "application/json" },
    body: { kind: "text", value: JSON.stringify({ version: explicit.version, projectId: targetProjectId }) },
  }, { paseo: h.paseo });
  assert.equal(movedExplicit.status, 200);
  const movedExplicitTask = (await dashi.getTask(baseUrl, explicit.id)).task;
  assert.equal(movedExplicitTask.projectId, targetProjectId);
  assert.deepEqual(movedExplicitTask.developmentContext, explicit.developmentContext);
  assert.deepEqual(await h.plans.get(explicit.id), {
    ...(await h.plans.get(explicit.id))!,
    projectId: targetProjectId,
    workspacePath: directory,
    profile: explicitProfile,
  });
  const bindingAfter = (await h.bindings.get(explicit.id))!;
  assert.equal(bindingAfter.projectId, targetProjectId);
  for (const field of ["taskId", "taskIdentifier", "workspaceId", "agentId", "provider", "agentTitle", "agentModel", "lastOutcome", "pendingWriteback", "dispatchArmed", "acceptedTurnId", "turnGeneration"] as const) {
    assert.deepEqual(bindingAfter[field], bindingBefore[field]);
  }

  h.setPendingPermissions(["permission"]);
  const rejected = await bridge({
    method: "PATCH",
    path: `/api/tasks/${explicit.id}`,
    headers: { "content-type": "application/json" },
    body: { kind: "text", value: JSON.stringify({ version: movedExplicitTask.version, projectId: sourceProjectId }) },
  }, { paseo: h.paseo });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.kind, "json");
  assert.equal((rejected.body.value as { error?: { code?: string } }).error?.code, "TASK_AGENT_BUSY");
  assert.equal((await dashi.getTask(baseUrl, explicit.id)).task.projectId, targetProjectId);
  assert.equal((await h.plans.get(explicit.id))?.projectId, targetProjectId);
  assert.equal((await h.bindings.get(explicit.id))?.projectId, targetProjectId);

  const related = (await dashi.createTask(baseUrl, { projectId: sourceProjectId, title: "Related move source", status: "todo" })).task;
  const peer = (await dashi.createTask(baseUrl, { projectId: sourceProjectId, title: "Related move peer", status: "todo" })).task;
  await h.plans.upsert({
    taskId: related.id,
    projectId: sourceProjectId,
    workspacePath: directory,
    profile: explicitProfile,
  });
  const relationResponse = await fetch(`${baseUrl}/api/tasks/${related.id}/relations/related/${peer.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: related.version }),
  });
  assert.equal(relationResponse.status, 200);
  const relatedCurrent = (await dashi.getTask(baseUrl, related.id)).task;
  const relationBlocked = await bridge({
    method: "PATCH",
    path: `/api/tasks/${related.id}`,
    headers: { "content-type": "application/json" },
    body: { kind: "text", value: JSON.stringify({ version: relatedCurrent.version, projectId: targetProjectId }) },
  }, { paseo: h.paseo });
  assert.equal(relationBlocked.status, 409);
  assert.equal(relationBlocked.body.kind, "json");
  const relationError = (relationBlocked.body.value as { error?: { code?: string; message?: string } }).error;
  assert.equal(relationError?.code, "CROSS_PROJECT_RELATION");
  assert.match(relationError?.message ?? "", /先移除关联关系/);
  assert.equal((await dashi.getTask(baseUrl, related.id)).task.projectId, sourceProjectId);
  assert.equal((await h.plans.get(related.id))?.projectId, sourceProjectId);
});

test("跨项目 PATCH 响应丢失后按真实任务归属保留目标 metadata", async () => {
  const h = await harness();
  const sourceProjectId = await createFixtureProject("Lost response source");
  const targetProjectId = await createFixtureProject("Lost response target");
  const task = (await dashi.createTask(baseUrl, { projectId: sourceProjectId, title: "Lost PATCH response", status: "todo" })).task;
  await h.plans.upsert({
    taskId: task.id,
    projectId: sourceProjectId,
    workspacePath: directory,
    profile: { id: "lost-response", name: "Lost response", provider: "grok", model: "grok-4.6" },
  });
  const bridge = h.handlers.get(contracts.bridgeRequest.name)!;
  const originalFetch = globalThis.fetch;
  let dropped = false;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const method = args[1]?.method ?? "GET";
    if (!dropped && method === "PATCH" && String(args[0]).includes(`/api/tasks/${task.id}`)) {
      dropped = true;
      await response.arrayBuffer();
      throw new Error("模拟 PATCH 已落盘但响应丢失");
    }
    return response;
  };
  try {
    const response = await bridge({
      method: "PATCH",
      path: `/api/tasks/${task.id}`,
      headers: { "content-type": "application/json" },
      body: { kind: "text", value: JSON.stringify({ version: task.version, projectId: targetProjectId }) },
    }, { paseo: h.paseo });
    assert.equal(dropped, true);
    assert.equal(response.status, 200);
    assert.equal(response.body.kind, "json");
    assert.equal((response.body.value as { task?: { projectId?: string } }).task?.projectId, targetProjectId);
    assert.equal((await dashi.getTask(baseUrl, task.id)).task.projectId, targetProjectId);
    assert.equal((await h.plans.get(task.id))?.projectId, targetProjectId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("自动化取得任务锁后跳过已经移到其他项目的候选", async () => {
  const h = await harness();
  const sourceProjectId = await createFixtureProject("Automation move source");
  const targetProjectId = await createFixtureProject("Automation move target");
  await h.settings.upsert({
    projectId: sourceProjectId,
    workspacePath: directory,
    profile: { id: "source-auto", name: "Source auto", provider: "grok", model: "grok-4.6" },
    enabledByUser: true,
    intervalMinutes: 5,
    quotaAware: false,
    lastRunAt: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  });
  const task = (await dashi.createTask(baseUrl, { projectId: sourceProjectId, title: "Move while automation waits", status: "todo" })).task;
  await h.handlers.get(contracts.checkConnection.name)!({}, { paseo: h.paseo });

  const releaseMove = deferred();
  const moveStarted = deferred();
  const moving = h.mutationLock.run(task.id, async () => {
    moveStarted.resolve();
    await releaseMove.promise;
    await dashi.updateTask(baseUrl, task.id, { version: task.version, projectId: targetProjectId });
  });
  await moveStarted.promise;

  const listed = deferred();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).includes(`/api/tasks?projectId=${sourceProjectId}`)) listed.resolve();
    return response;
  };
  try {
    const run = h.automation.runNow(Date.now());
    await listed.promise;
    await new Promise((resolve) => setImmediate(resolve));
    releaseMove.resolve();
    await Promise.all([moving, run]);
  } finally {
    globalThis.fetch = originalFetch;
    releaseMove.resolve();
  }
  assert.equal((await dashi.getTask(baseUrl, task.id)).task.projectId, targetProjectId);
  assert.equal((await dashi.getTask(baseUrl, task.id)).task.status, "todo");
  assert.equal(h.getCreates(), 0);
  assert.equal(h.getSends(), 0);
});

test("旧 generation 的 pendingWriteback 在新轮开始后不能覆盖任务", async () => {
  const h = await harness();
  const project = await projectId();
  const task = (await dashi.createTask(baseUrl, { projectId: project, title: "旧 pending 写回", status: "in_progress" })).task;
  await h.bindings.upsert({
    taskId: task.id,
    taskIdentifier: task.identifier,
    projectId: project,
    workspaceId: "workspace-handler-test",
    agentId: "agent-handler-test",
    provider: "codex/gpt-5.6-sol",
  });
  await h.bindings.armDispatch(task.id, "agent-handler-test");
  const oldTurn = await h.bindings.acceptStartedTurn(task.id, "agent-handler-test", "old-turn", null, false);
  assert.ok(oldTurn);
  await h.bindings.recordWritebackError(task.id, "agent-handler-test", {
    outcome: { kind: "completed", at: new Date().toISOString(), message: null },
    commentBody: "旧轮次结果",
    status: "in_review",
    error: "temporary outage",
    commentPosted: false,
    turnId: "old-turn",
    generation: oldTurn.turnGeneration,
  });
  await h.bindings.consumeEndedTurn(task.id, "agent-handler-test", "old-turn");
  await h.bindings.armDispatch(task.id, "agent-handler-test");
  await h.bindings.acceptStartedTurn(task.id, "agent-handler-test", "new-turn", null, false);

  const retry = h.handlers.get(contracts.retryWriteback.name)!;
  await assert.rejects(() => retry({ taskId: task.id }, { paseo: h.paseo }), /旧 Agent 轮次/);
  assert.equal((await dashi.getTask(baseUrl, task.id)).task.status, "in_progress");
  assert.equal((await dashi.listComments(baseUrl, task.id)).comments.length, 0);
  assert.equal((await h.bindings.get(task.id))?.acceptedTurnId, "new-turn");
});

test("retryWriteback 在终态或归档任务上不追加旧评论、不清 pending", async () => {
  const h = await harness();
  const project = await projectId();
  const retry = h.handlers.get(contracts.retryWriteback.name)!;
  for (const terminalStatus of ["done", "canceled"] as const) {
    const created = (await dashi.createTask(baseUrl, { projectId: project, title: `终态旧写回 ${terminalStatus}`, status: "in_progress" })).task;
    await h.bindings.upsert({
      taskId: created.id,
      taskIdentifier: created.identifier,
      projectId: project,
      workspaceId: "workspace-handler-test",
      agentId: `agent-terminal-${terminalStatus}`,
      provider: "codex/gpt-5.6-sol",
    });
    await h.bindings.recordWritebackError(created.id, `agent-terminal-${terminalStatus}`, {
      outcome: { kind: "completed", at: new Date().toISOString(), message: null },
      commentBody: "不应追加",
      status: "in_review",
      error: "pending",
      commentPosted: false,
      turnId: "old-turn",
      generation: 0,
    });
    const terminal = (await dashi.moveTask(baseUrl, created.id, { version: created.version, status: terminalStatus })).task;
    await assert.rejects(() => retry({ taskId: created.id }, { paseo: h.paseo }), /完成、取消或归档/);
    assert.equal((await dashi.listComments(baseUrl, created.id)).comments.length, 0);
    assert.ok((await h.bindings.get(created.id))?.pendingWriteback);
    assert.equal((await dashi.getTask(baseUrl, created.id)).task.version, terminal.version);
  }

  const archived = (await dashi.createTask(baseUrl, { projectId: project, title: "归档旧写回", status: "todo" })).task;
  await h.bindings.upsert({
    taskId: archived.id,
    taskIdentifier: archived.identifier,
    projectId: project,
    workspaceId: "workspace-handler-test",
    agentId: "agent-terminal-archived",
    provider: "codex/gpt-5.6-sol",
  });
  await h.bindings.recordWritebackError(archived.id, "agent-terminal-archived", {
    outcome: { kind: "completed", at: new Date().toISOString(), message: null },
    commentBody: "不应追加",
    status: "in_review",
    error: "pending",
    commentPosted: false,
    turnId: "old-turn",
    generation: 0,
  });
  const archivedResult = await dashi.archiveTask(baseUrl, archived.id, archived.version);
  await assert.rejects(() => retry({ taskId: archived.id }, { paseo: h.paseo }), /完成、取消或归档/);
  assert.equal((await dashi.listComments(baseUrl, archived.id)).comments.length, 0);
  assert.ok((await h.bindings.get(archived.id))?.pendingWriteback);
  assert.equal((await dashi.getTask(baseUrl, archived.id)).task.version, archivedResult.task.version);
});

test("Paseo 自动化默认关闭；启用每 tick 仅领取一项，关闭在途事务后真实落盘且不继续领取", async (context) => {
  const h = await harness();
  context.after(() => h.automation.stop());
  const project = await createFixtureProject("Automation fixture");
  const first = (await dashi.createTask(baseUrl, { projectId: project, title: "Auto first", status: "todo" })).task;
  const second = (await dashi.createTask(baseUrl, { projectId: project, title: "Auto second", status: "todo" })).task;
  const profile = { id: "auto-profile", name: "Auto profile", provider: "codex", model: "gpt-5.6-sol" };
  await h.plans.upsert({ taskId: first.id, projectId: project, workspacePath: directory, profile });
  await h.plans.upsert({ taskId: second.id, projectId: project, workspacePath: directory, profile });
  h.automation.attach(h.paseo);

  await h.automation.runNow(Date.now());
  assert.equal((await dashi.getTask(baseUrl, first.id)).task.status, "todo");
  assert.equal(h.getSends(), 0);

  const enteredSend = deferred();
  const releaseSend = deferred();
  h.setSendOperation(async () => { enteredSend.resolve(); await releaseSend.promise; });
  const saveAutomation = h.handlers.get(contracts.savePaseoAutomation.name)!;
  await saveAutomation({ projectId: project, enabledByUser: true, intervalMinutes: 5, quotaAware: false }, { paseo: h.paseo });
  await enteredSend.promise;
  const firstDuring = (await dashi.getTask(baseUrl, first.id)).task;
  const secondDuring = (await dashi.getTask(baseUrl, second.id)).task;
  const claimed = firstDuring.status === "in_progress" ? first : second;
  const waiting = claimed.id === first.id ? second : first;

  const close = saveAutomation({ projectId: project, enabledByUser: false, intervalMinutes: 5, quotaAware: false }, { paseo: h.paseo });
  const manualMove = h.handlers.get(contracts.moveTaskBoard.name)!({
    id: claimed.id,
    version: claimed.version,
    status: "in_progress",
  }, { paseo: h.paseo }).then(
    (value: { dispatch?: unknown }) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  releaseSend.resolve();
  const closed = await close;
  assert.equal(closed.automation.enabledByUser, false);
  const manual = await manualMove;
  if (manual.ok) assert.equal(manual.value.dispatch, "none");
  else assert.ok(manual.error instanceof dashi.DashiApiError && manual.error.code === "VERSION_CONFLICT");
  assert.equal(h.getSends(), 1);
  assert.equal((await dashi.getTask(baseUrl, claimed.id)).task.status, "in_progress");
  assert.equal((await dashi.getTask(baseUrl, waiting.id)).task.status, "todo");

  await h.automation.runNow(Date.now() + 12 * 60_000);
  assert.equal(h.getSends(), 1);
  assert.equal((await dashi.getTask(baseUrl, waiting.id)).task.status, "todo");
});

test("项目 defaults 独立保存：允许未知项目与单字段配置，不启用自动化或写任务计划", async () => {
  const h = await harness();
  const saveDefaults = h.handlers.get(contracts.savePaseoProjectDefaults.name)!;
  const pendingProjectId = `pending-project-${randomUUID()}`;
  const projectId = await createFixtureProject("Project defaults fixture");
  const profile = { id: "defaults-profile", name: "Defaults profile", provider: "codex", model: "gpt-5.6-sol" };

  const profileOnly = await saveDefaults({ projectId: pendingProjectId, workspacePath: null, profile }, { paseo: h.paseo });
  assert.equal(profileOnly.projectId, pendingProjectId);
  assert.equal(profileOnly.automation.enabledByUser, false);
  assert.equal(profileOnly.automation.workspacePath, null);
  assert.deepEqual(profileOnly.automation.profile, profile);
  assert.deepEqual(await h.plans.list(), []);

  const knownWorkspace = path.join(directory, "defaults-workspace");
  h.workspaceEntries.push({ id: "defaults-workspace", workspaceDirectory: knownWorkspace, name: "Defaults workspace" });
  const workspaceOnly = await saveDefaults({ projectId, workspacePath: knownWorkspace, profile: null }, { paseo: h.paseo });
  assert.equal(workspaceOnly.automation.enabledByUser, false);
  assert.equal(workspaceOnly.automation.workspacePath, knownWorkspace);
  assert.equal(workspaceOnly.automation.profile, null);
  assert.deepEqual(await h.plans.list(), []);

  await saveDefaults({ projectId, workspacePath: null, profile }, { paseo: h.paseo });
  const inherited = (await dashi.createTask(baseUrl, { projectId, title: "Inherit defaults by field", status: "todo" })).task;
  await h.plans.upsert({
    taskId: inherited.id,
    projectId,
    workspacePath: knownWorkspace,
    profile: null,
  });
  const move = h.handlers.get(contracts.moveTaskBoard.name)!;
  const started = await move({ id: inherited.id, version: inherited.version, status: "in_progress" }, { paseo: h.paseo });
  assert.equal(started.dispatch, "started");
  assert.equal(h.openedWorkspacePaths.at(-1), knownWorkspace);
  assert.equal(h.createdAgentConfigs.at(-1)?.provider, "codex/gpt-5.6-sol");

  const taskProfile = { id: "task-profile", name: "Task profile", provider: "grok", model: "grok-4.6" };
  await saveDefaults({ projectId, workspacePath: knownWorkspace, profile }, { paseo: h.paseo });
  const profileOverride = (await dashi.createTask(baseUrl, { projectId, title: "Task profile override", status: "todo" })).task;
  await h.plans.upsert({
    taskId: profileOverride.id,
    projectId,
    workspacePath: null,
    profile: taskProfile,
  });
  const profileStarted = await move({ id: profileOverride.id, version: profileOverride.version, status: "in_progress" }, { paseo: h.paseo });
  assert.equal(profileStarted.dispatch, "started");
  assert.equal(h.openedWorkspacePaths.at(-1), knownWorkspace);
  assert.equal(h.createdAgentConfigs.at(-1)?.provider, "grok/grok-4.6");

  await saveDefaults({ projectId, workspacePath: null, profile: null }, { paseo: h.paseo });
  const freeTask = (await dashi.createTask(baseUrl, { projectId, title: "Explicitly free project", status: "todo" })).task;
  const missing = await move({ id: freeTask.id, version: freeTask.version, status: "in_progress" }, { paseo: h.paseo });
  assert.equal(missing.dispatch, "needs_configuration");
  assert.equal(missing.task.status, "todo");
});

test("取消轮次消费后可移回 todo 再派发新 generation，等待权限仍保持门禁", async () => {
  const h = await harness();
  const project = await createFixtureProject("Canceled retry fixture");
  const task = (await dashi.createTask(baseUrl, { projectId: project, title: "Canceled retry", status: "in_progress" })).task;
  await h.bindings.upsert({
    taskId: task.id,
    taskIdentifier: task.identifier,
    projectId: project,
    workspaceId: "workspace-handler-test",
    agentId: "agent-handler-test",
    provider: "codex/gpt-5.6-sol",
  });
  await h.bindings.armDispatch(task.id, "agent-handler-test");
  await h.bindings.acceptStartedTurn(task.id, "agent-handler-test", "canceled-turn", null, false);
  await h.bindings.consumeEndedTurn(task.id, "agent-handler-test", "canceled-turn");
  await h.bindings.recordOutcome(task.id, "agent-handler-test", {
    kind: "canceled",
    at: new Date().toISOString(),
    message: "Interrupted",
  });
  const move = h.handlers.get(contracts.moveTaskBoard.name)!;
  const todo = await move({ id: task.id, version: task.version, status: "todo" }, { paseo: h.paseo });
  const started = await move({ id: task.id, version: todo.task.version, status: "in_progress" }, { paseo: h.paseo });
  assert.equal(started.dispatch, "continued");
  assert.equal(h.getSends(), 1);

  await h.bindings.acceptStartedTurn(task.id, "agent-handler-test", "new-turn", null, false);
  h.setAgentStatus("running");
  h.setPendingPermissions(["permission"]);
  const presentation = await h.handlers.get(contracts.getPaseoPresentations.name)!({ taskIds: [task.id] }, { paseo: h.paseo });
  assert.equal(presentation.presentations[0]?.requiresAttention, true);
  assert.equal(presentation.presentations[0]?.attentionReason, "permission");
  await assert.rejects(
    () => move({ id: task.id, version: started.task.version, status: "todo" }, { paseo: h.paseo }),
    /运行或等待权限/,
  );
  assert.equal(h.getSends(), 1);
});
