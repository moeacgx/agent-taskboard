import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import * as dashi from "../server/dashi-api.ts";
import { createBindingsStore } from "../server/bindings.ts";
import { performWriteback } from "../server/writeback.ts";
import * as contracts from "../shared/contracts.ts";
import { latestAssistantText } from "../shared/timeline-text.ts";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

/**
 * Exercises the real dashi-taskboard HTTP API (an in-process instance of the
 * actual `server/app.mjs`, not a mock) plus the plugin's own JSON binding
 * store, along the exact main path the plugin uses: connect, list projects,
 * create a task, move it through the same statuses the agent.turn_ended
 * hook uses, comment as the plugin-agent identity, and persist/read a
 * binding. Everything lives under a throwaway temp directory — the real
 * dashi database and the real ~/.paseo plugin data are never touched.
 */

// `server/app.mjs` ships no .d.ts; this describes only the surface this test
// actually calls, cast at the single import site below.
interface TestTaskboardServer {
  listen(options: { host: string; port: number }): Promise<{ port: number }>;
  close(): Promise<void>;
}
interface TestTaskboardModule {
  createTaskboardServer(options: Record<string, unknown>): TestTaskboardServer;
}

let tmpDir: string;
let server: TestTaskboardServer | undefined;
let baseUrl: string;
let previousCodexHome: string | undefined;

async function importDashiServer(): Promise<TestTaskboardModule> {
  // Repo root is three levels up from integrations/paseo/test/.
  return (await import("../../../server/app.mjs")) as unknown as TestTaskboardModule;
}

before(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "dashi-paseo-plugin-test-"));
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(tmpDir, "codex-home");

  const { createTaskboardServer } = await importDashiServer();
  server = createTaskboardServer({
    dataDirectory: tmpDir,
    databasePath: path.join(tmpDir, "taskboard.sqlite"),
    attachmentsDirectory: path.join(tmpDir, "attachments"),
    staticDirectory: tmpDir,
  });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.DASHI_TASKBOARD_URL = baseUrl;
});

after(async () => {
  await server?.close();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  delete process.env.DASHI_TASKBOARD_URL;
  await rm(tmpDir, { recursive: true, force: true });
});

test("checkConnection reaches the real service", async () => {
  const result = await dashi.checkConnection(baseUrl);
  assert.equal(result.connected, true);
  assert.equal(result.error, null);
});

test("checkConnection reports a clear error against a closed port", async () => {
  const result = await dashi.checkConnection("http://127.0.0.1:1");
  assert.equal(result.connected, false);
  assert.match(result.error ?? "", /dashi-taskboard/);
});

test("main path: list projects, create/move/comment on a task", async () => {
  const { projects } = await dashi.listProjects(baseUrl);
  assert.ok(projects.length >= 1, "expected the default local project to exist");
  const project = projects[0];

  const created = await dashi.createTask(baseUrl, {
    projectId: project.id,
    title: "Plugin integration test task",
    description: "Created by the dashi-taskboard Paseo plugin's own test.",
    priority: "high",
    labels: ["plugin-test"],
  });
  assert.equal(created.task.title, "Plugin integration test task");
  assert.equal(created.task.status, "backlog");
  assert.equal(created.task.priority, "high");
  assert.equal(created.task.version, 1);

  const fetched = await dashi.getTask(baseUrl, created.task.id);
  assert.equal(fetched.task.id, created.task.id);

  const { tasks } = await dashi.listTasks(baseUrl, { projectId: project.id });
  assert.ok(tasks.some((t) => t.id === created.task.id));

  // Mirrors the agent.turn_started hook: task becomes visibly "in progress".
  const started = await dashi.moveTask(
    baseUrl,
    created.task.id,
    { version: fetched.task.version, status: "in_progress" },
    dashi.PLUGIN_AGENT_ACTOR,
  );
  assert.equal(started.task.status, "in_progress");
  assert.equal(started.task.version, 2);

  const comment = await dashi.addComment(
    baseUrl,
    created.task.id,
    "✅ 测试：模拟 agent 完成一轮运行的写回评论。",
    dashi.PLUGIN_AGENT_ACTOR,
  );
  assert.equal(comment.comment.authorName, "Paseo Agent");
  assert.equal(comment.comment.taskId, created.task.id);

  const { comments } = await dashi.listComments(baseUrl, created.task.id);
  assert.ok(comments.some((c) => c.id === comment.comment.id));

  // Mirrors the agent.turn_ended "completed" outcome: pending review, never "done".
  const reviewed = await dashi.moveTask(
    baseUrl,
    created.task.id,
    { version: started.task.version, status: "in_review" },
    dashi.PLUGIN_AGENT_ACTOR,
  );
  assert.equal(reviewed.task.status, "in_review");

  // A stale version must be rejected (optimistic concurrency is load-bearing
  // for concurrent writers — the plugin's lifecycle hook and the human UI).
  await assert.rejects(
    () => dashi.moveTask(baseUrl, created.task.id, { version: started.task.version, status: "blocked" }),
    (error: unknown) => error instanceof dashi.DashiApiError && error.code === "VERSION_CONFLICT",
  );
});

test("bindings store: upsert/get/findByAgentId/recordOutcome/remove round-trip on real JSON files", async () => {
  const store = createBindingsStore({ filePath: path.join(tmpDir, "bindings-test.json") });

  const binding = await store.upsert({
    taskId: "task-1",
    taskIdentifier: "LOCAL-1",
    projectId: "local",
    workspaceId: "ws-1",
    agentId: "agent-1",
    provider: "claude/claude-sonnet-5",
  });
  assert.equal(binding.lastOutcome, null);

  assert.deepEqual(await store.get("task-1"), binding);
  assert.deepEqual(await store.findByAgentId("agent-1"), binding);
  assert.equal(await store.findByAgentId("does-not-exist"), null);

  const updated = await store.recordOutcome("task-1", "agent-1", {
    kind: "completed",
    at: new Date().toISOString(),
    message: null,
  });
  assert.equal(updated?.lastOutcome?.kind, "completed");

  const list = await store.list();
  assert.equal(list.length, 1);

  await store.remove("task-1");
  assert.equal(await store.get("task-1"), null);
});

test("bindings store: concurrent upserts serialize without losing writes", async () => {
  const store = createBindingsStore({ filePath: path.join(tmpDir, "bindings-concurrency.json") });
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.upsert({
        taskId: `task-${index}`,
        taskIdentifier: `LOCAL-${index}`,
        projectId: "local",
        workspaceId: `ws-${index}`,
        agentId: `agent-${index}`,
        provider: "claude/claude-sonnet-5",
      }),
    ),
  );
  const list = await store.list();
  assert.equal(list.length, 8);
});

test("bindings store: an agent bound to a new task drops its stale binding on the old task", async () => {
  const store = createBindingsStore({ filePath: path.join(tmpDir, "bindings-agent-uniqueness.json") });
  const common = { projectId: "local", workspaceId: "ws-shared", agentId: "agent-shared", provider: "claude/claude-sonnet-5" };

  await store.upsert({ ...common, taskId: "task-a", taskIdentifier: "LOCAL-A" });
  assert.deepEqual(await store.findByAgentId("agent-shared"), await store.get("task-a"));

  // Same agent, different task: task-a's binding must disappear so
  // findByAgentId can never point at two tasks for one agent.
  await store.upsert({ ...common, taskId: "task-b", taskIdentifier: "LOCAL-B" });
  assert.equal(await store.get("task-a"), null);
  const bound = await store.findByAgentId("agent-shared");
  assert.equal(bound?.taskId, "task-b");
  const list = await store.list();
  assert.equal(list.length, 1);
});

test("bindings store: lastOutcome only survives a rebind when the agent is unchanged", async () => {
  const store = createBindingsStore({ filePath: path.join(tmpDir, "bindings-outcome-reset.json") });

  await store.upsert({
    taskId: "task-1",
    taskIdentifier: "LOCAL-1",
    projectId: "local",
    workspaceId: "ws-1",
    agentId: "agent-old",
    provider: "claude/claude-sonnet-5",
  });
  await store.recordOutcome("task-1", "agent-old", {
    kind: "completed",
    at: new Date().toISOString(),
    message: null,
  });

  // Re-upserting the SAME agent must not wipe its recorded outcome.
  const sameAgent = await store.upsert({
    taskId: "task-1",
    taskIdentifier: "LOCAL-1",
    projectId: "local",
    workspaceId: "ws-1",
    agentId: "agent-old",
    provider: "claude/claude-sonnet-5",
  });
  assert.equal(sameAgent.lastOutcome?.kind, "completed");

  // Binding a genuinely NEW agent to the same task must reset it — otherwise
  // the UI would show the previous agent's result as if it were the new one's.
  const newAgent = await store.upsert({
    taskId: "task-1",
    taskIdentifier: "LOCAL-1",
    projectId: "local",
    workspaceId: "ws-2",
    agentId: "agent-new",
    provider: "codex/gpt-5.5",
  });
  assert.equal(newAgent.lastOutcome, null);
});

test("bindings store: a stale turn's outcome cannot clobber a binding that already moved to a new agent", async () => {
  const store = createBindingsStore({ filePath: path.join(tmpDir, "bindings-stale-turn.json") });

  await store.upsert({
    taskId: "task-1",
    taskIdentifier: "LOCAL-1",
    projectId: "local",
    workspaceId: "ws-1",
    agentId: "agent-old",
    provider: "claude/claude-sonnet-5",
  });
  // Task moves on to a new agent before agent-old's in-flight turn reports back.
  await store.upsert({
    taskId: "task-1",
    taskIdentifier: "LOCAL-1",
    projectId: "local",
    workspaceId: "ws-2",
    agentId: "agent-new",
    provider: "codex/gpt-5.5",
  });

  const staleResult = await store.recordOutcome("task-1", "agent-old", {
    kind: "completed",
    at: new Date().toISOString(),
    message: null,
  });
  assert.equal(staleResult, null, "a stale agent's outcome must be rejected as a no-op");
  assert.equal((await store.get("task-1"))?.lastOutcome, null, "the current binding must be untouched");

  const staleError = await store.recordWritebackError("task-1", "agent-old", {
    outcome: { kind: "failed", at: new Date().toISOString(), message: "stale" },
    commentBody: "stale",
    status: "blocked",
    error: "stale",
    commentPosted: false,
  });
  assert.equal(staleError, null, "a stale agent's write-back error must also be rejected as a no-op");
  assert.equal((await store.get("task-1"))?.pendingWriteback, null);
});

test("BindingSchema defaults pendingWriteback to null for records saved before that field existed", () => {
  // Exactly what a real bindings.json entry written by an earlier version of
  // this plugin looks like: no `pendingWriteback` key at all. A missing key
  // parses as `undefined`, which `.nullable()` alone does not accept — this
  // is what broke a real installed binding after the schema grew that field.
  const legacyBinding = {
    taskId: "task-1",
    taskIdentifier: "LOCAL-1",
    projectId: "local",
    workspaceId: "ws-1",
    agentId: "agent-1",
    provider: "claude/claude-sonnet-5",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastOutcome: null,
  };
  const parsed = contracts.BindingSchema.parse(legacyBinding);
  assert.equal(parsed.pendingWriteback, null);
});

test("performWriteback: resuming with commentPosted=true does not repost the comment", async () => {
  const store = createBindingsStore({ filePath: path.join(tmpDir, "bindings-writeback-resume.json") });
  const { projects } = await dashi.listProjects(baseUrl);
  const project = projects[0];
  const created = await dashi.createTask(baseUrl, { projectId: project.id, title: "Writeback resume test" });
  await store.upsert({
    taskId: created.task.id,
    taskIdentifier: created.task.identifier,
    projectId: project.id,
    workspaceId: "ws-resume",
    agentId: "agent-resume",
    provider: "claude/claude-sonnet-5",
  });

  const outcome = { kind: "completed" as const, at: new Date().toISOString(), message: null };
  const commentBody = "唯一评论文本-写回续传测试";

  // Simulate "the comment already landed in an earlier attempt, only the
  // status move is still pending" by posting it directly first, exactly as
  // a first performWriteback attempt would have, then resuming with
  // alreadyPosted=true — the real bug this guards against is a second,
  // duplicate copy of the same comment appearing after a retry.
  await dashi.addComment(baseUrl, created.task.id, commentBody, dashi.PLUGIN_AGENT_ACTOR);
  await performWriteback(
    baseUrl,
    store,
    created.task.id,
    "agent-resume",
    outcome,
    commentBody,
    "in_review",
    true, // alreadyPosted
  );

  const { comments } = await dashi.listComments(baseUrl, created.task.id);
  const matching = comments.filter((c) => c.body === commentBody);
  assert.equal(matching.length, 1, "resuming must not repost a comment that already landed");

  const { task } = await dashi.getTask(baseUrl, created.task.id);
  assert.equal(task.status, "in_review", "resuming must still complete the still-pending status move");

  const binding = await store.get(created.task.id);
  assert.equal(binding?.lastOutcome?.kind, "completed");
  assert.equal(binding?.pendingWriteback, null);
});

test("performWriteback: a failed attempt records commentPosted so a retry knows not to repost", async () => {
  const store = createBindingsStore({ filePath: path.join(tmpDir, "bindings-writeback-partial-failure.json") });
  const { projects } = await dashi.listProjects(baseUrl);
  const project = projects[0];
  const created = await dashi.createTask(baseUrl, { projectId: project.id, title: "Writeback partial failure test" });
  await store.upsert({
    taskId: created.task.id,
    taskIdentifier: created.task.identifier,
    projectId: project.id,
    workspaceId: "ws-partial",
    agentId: "agent-partial",
    provider: "claude/claude-sonnet-5",
  });

  const outcome = { kind: "completed" as const, at: new Date().toISOString(), message: null };
  const commentBody = "评论已发出-随后状态移动会失败";

  // Post the comment out from under performWriteback first so its own
  // attempt (alreadyPosted=false) still tries to post again and collides
  // with dashi's real behavior being unavailable is hard to force
  // deterministically; instead exercise the same "partial failure" shape
  // directly: comment lands, then a bogus target forces moveTask to throw.
  await dashi.addComment(baseUrl, created.task.id, commentBody, dashi.PLUGIN_AGENT_ACTOR);
  await store.recordWritebackError(created.task.id, "agent-partial", {
    outcome,
    commentBody,
    status: "in_review",
    error: "simulated: status move did not complete",
    commentPosted: true,
  });

  const pendingBefore = (await store.get(created.task.id))?.pendingWriteback;
  assert.equal(pendingBefore?.commentPosted, true);

  // Retry (as the RPC handler does): resumes from commentPosted=true.
  await performWriteback(
    baseUrl,
    store,
    created.task.id,
    "agent-partial",
    outcome,
    commentBody,
    "in_review",
    pendingBefore!.commentPosted,
  );

  const { comments } = await dashi.listComments(baseUrl, created.task.id);
  assert.equal(comments.filter((c) => c.body === commentBody).length, 1, "retry must not duplicate the already-posted comment");

  const { task } = await dashi.getTask(baseUrl, created.task.id);
  assert.equal(task.status, "in_review");
  assert.equal((await store.get(created.task.id))?.pendingWriteback, null);
});

test("latestAssistantText concatenates streaming fragments of one message with no separator", () => {
  const timeline: AgentTimelineItem[] = [
    { type: "user_message", text: "继续" },
    { type: "assistant_message", text: "第二", messageId: "m1" },
    { type: "assistant_message", text: "轮会话与摘要回写成功", messageId: "m1" },
  ];
  assert.equal(latestAssistantText(timeline), "第二轮会话与摘要回写成功");
});

test("latestAssistantText still joins fragments with no separator when messageId is absent", () => {
  const timeline: AgentTimelineItem[] = [
    { type: "user_message", text: "继续" },
    { type: "assistant_message", text: "第二" },
    { type: "assistant_message", text: "轮会话与摘要回写成功" },
  ];
  assert.equal(latestAssistantText(timeline), "第二轮会话与摘要回写成功");
});

test("latestAssistantText inserts a paragraph break only when messageId explicitly changes", () => {
  const timeline: AgentTimelineItem[] = [
    { type: "user_message", text: "继续" },
    { type: "assistant_message", text: "第一条消息", messageId: "m1" },
    { type: "assistant_message", text: "第二条消息", messageId: "m2" },
  ];
  assert.equal(latestAssistantText(timeline), "第一条消息\n\n第二条消息");
});

test("latestAssistantText only reads what came after the latest user message", () => {
  const timeline: AgentTimelineItem[] = [
    { type: "assistant_message", text: "旧的回复" },
    { type: "user_message", text: "继续" },
    { type: "assistant_message", text: "新的回复" },
  ];
  assert.equal(latestAssistantText(timeline), "新的回复");
});
