import type { PaseoApi } from "@getpaseo/client";

import type { Binding, Comment, ProjectAutomationSettings, Task, TaskExecutionPlan } from "../shared/contracts";
import type { BindingsStore } from "./bindings";
import * as dashi from "./dashi-api.ts";

export interface TaskDispatchResult {
  kind: "started" | "continued" | "skipped" | "needs_configuration" | "failed";
  message: string | null;
  agentId: string | null;
}

export type TaskDispatchConfiguration = Pick<ProjectAutomationSettings, "workspacePath" | "profile">;

export function hasDispatchConfiguration(settings: TaskDispatchConfiguration | null): boolean {
  return Boolean(settings?.workspacePath && settings.profile?.provider);
}

/** Keeps one move-triggered send in flight per task, without serializing unrelated tasks. */
export function createTaskDispatchCoordinator() {
  const active = new Map<string, Promise<unknown>>();
  return {
    run<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
      const existing = active.get(taskId);
      if (existing) return existing as Promise<T>;
      const current = Promise.resolve().then(operation);
      active.set(taskId, current);
      void current.then(
        () => { if (active.get(taskId) === current) active.delete(taskId); },
        () => { if (active.get(taskId) === current) active.delete(taskId); },
      );
      return current;
    },
  };
}
export type TaskDispatchCoordinator = ReturnType<typeof createTaskDispatchCoordinator>;

/** 不共享返回值的逐任务 FIFO 锁；不同操作按顺序各自执行并返回自己的结果。 */
export function createTaskMutationLock() {
  const queues = new Map<string, Promise<unknown>>();
  return {
    run<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
      const previous = queues.get(taskId) ?? Promise.resolve();
      const current = previous.then(operation, operation);
      queues.set(taskId, current);
      void current.finally(() => {
        if (queues.get(taskId) === current) queues.delete(taskId);
      }).catch(() => undefined);
      return current;
    },
  };
}
export type TaskMutationLock = ReturnType<typeof createTaskMutationLock>;
const STALE_DISPATCH_ARM_MS = 30_000;

/**
 * 只保留人工评论：插件回写固定使用 paseo-agent；外部真实 Agent
 * 使用 authorType=agent。两者都是结果记录，不能作为下一轮指令。
 */
export function humanComments(comments: Comment[]): Comment[] {
  return comments
    .filter((comment) => comment.authorId !== dashi.PLUGIN_AGENT_ACTOR.id && comment.authorType !== "agent")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export async function buildTaskPrompt(baseUrl: string, task: Task): Promise<string> {
  const [{ comments }, { readme }] = await Promise.all([
    dashi.listComments(baseUrl, task.id),
    dashi.getProjectReadme(baseUrl, task.projectId),
  ]);
  const supplements = humanComments(comments);
  const latest = supplements.at(-1) ?? null;
  const history = latest ? supplements.slice(0, -1) : [];
  const projectBackground = readme.content.trim();
  return [
    `你正在通过 Paseo 处理 Dashi Taskboard 任务 ${task.identifier}：${task.title}`,
    "",
    "执行优先级：最新人工要求 > 当前任务的具体要求与原始描述 > 项目公共背景。",
    ...(projectBackground
      ? ["", "项目公共背景（低优先级，仅适用于当前项目）：", projectBackground]
      : []),
    "",
    "任务原始描述与具体要求（高于项目公共背景；如与最新人工要求冲突，以最新人工要求为准）：",
    task.description || "（任务没有填写描述）",
    "",
    latest
      ? `最新人工要求（本轮最高优先级）：\n${latest.body}`
      : "最新人工要求：\n（暂无人工补充，按任务原始描述执行）",
    ...(history.length > 0
      ? ["", "较早人工补充（背景，按时间排序）：", ...history.map((comment) => `${comment.createdAt} · ${comment.authorName}\n${comment.body}`)]
      : []),
    "",
    "这是 Paseo 插件托管的任务。不要查找或调用 taskctl，不要读取或伪造 CODEX_THREAD_ID；任务状态与结果由平台生命周期自动写回。",
    "",
    "本轮对话结束时，Paseo 插件会自动把结果写回任务看板：完成进入等你确认，失败进入遇到阻碍，取消只记录评论。",
  ].join("\n");
}

/** 已有会话只补入最新项目背景与本次人工要求，不重复发送整份任务历史。 */
export async function buildTaskContinuationPrompt(baseUrl: string, task: Task, message: string): Promise<string> {
  const { readme } = await dashi.getProjectReadme(baseUrl, task.projectId);
  const projectBackground = readme.content.trim();
  return [
    `继续处理 Dashi Taskboard 任务 ${task.identifier}：${task.title}`,
    "",
    "执行优先级：本次最新人工要求 > 当前任务既有具体要求 > 项目公共背景。",
    ...(projectBackground
      ? ["", "项目公共背景（低优先级，仅适用于当前项目）：", projectBackground]
      : []),
    "",
    "本次最新人工要求（最高优先级）：",
    message,
    "",
    "这是 Paseo 插件托管的任务。不要查找或调用 taskctl，不要读取或伪造 CODEX_THREAD_ID；任务状态与结果由平台生命周期自动写回。",
  ].join("\n");
}

export async function recordDispatchFailure(baseUrl: string, task: Task, message: string): Promise<Task> {
  const body = `❌ 自动启动 Agent 失败，任务已标记为 blocked，可使用重试按钮再次派发。\n错误: ${message}`;
  try {
    await dashi.addComment(baseUrl, task.id, body, dashi.PLUGIN_AGENT_ACTOR);
  } catch (error) {
    console.error("[dashi-taskboard] failed to record dispatch error", error);
  }
  try {
    return (await dashi.moveTask(baseUrl, task.id, { version: task.version, status: "blocked" }, dashi.PLUGIN_AGENT_ACTOR)).task;
  } catch (error) {
    console.error("[dashi-taskboard] failed to mark dispatch failure as blocked", error);
    return task;
  }
}

function isAgentBusy(agent: ReturnType<PaseoApi["agents"]["ref"]>): boolean {
  return agent.status === "running"
    || agent.activeTurn != null
    || (agent.pendingPermissions?.length ?? 0) > 0;
}

/** 在改任务状态前确认旧轮次不会随后覆盖本次用户操作。 */
export async function canStartTaskDispatch(
  paseo: PaseoApi,
  bindings: BindingsStore,
  taskId: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  const binding = await bindings.get(taskId);
  if (!binding) return { ok: true };
  const agent = paseo.agents.ref(binding.agentId);
  try {
    await agent.refresh();
  } catch {
    return { ok: false, message: "无法确认关联 Agent 是否已停止，不能启动或移动到处理中。" };
  }
  if (isAgentBusy(agent)) {
    return { ok: false, message: "该任务的 Agent 正在运行或等待权限，不能重复启动或移动到处理中。" };
  }
  if (binding.acceptedTurnId !== null) {
    const retired = await bindings.retireInactiveAcceptedTurn(taskId, binding.agentId, binding.acceptedTurnId);
    if (!retired) {
      return { ok: false, message: "该任务的旧 Agent 轮次状态已变化，请刷新后重试。" };
    }
  }
  if (binding.dispatchArmed) {
    const armedAt = new Date(binding.updatedAt).getTime();
    if (!Number.isFinite(armedAt) || now - armedAt < STALE_DISPATCH_ARM_MS) {
      return { ok: false, message: "该任务已有一轮 Agent 派发正在等待启动，不能重复派发。" };
    }
    const released = await bindings.cancelDispatchArm(taskId, binding.agentId);
    if (!released) {
      return { ok: false, message: "该任务的 Agent 派发状态已变化，请刷新后重试。" };
    }
  }
  return { ok: true };
}

export async function dispatchBoundTask(
  paseo: PaseoApi,
  bindings: BindingsStore,
  task: Task,
  settings: TaskDispatchConfiguration | TaskExecutionPlan | null,
  baseUrl: string,
  preparedPrompt?: string,
): Promise<TaskDispatchResult> {
  const existing = await bindings.get(task.id);
  if (existing) {
    const agent = paseo.agents.ref(existing.agentId);
    try {
      await agent.refresh();
    } catch (error) {
      return { kind: "failed", message: error instanceof Error ? error.message : String(error), agentId: existing.agentId };
    }
    if (isAgentBusy(agent)) {
      return { kind: "skipped", message: "该任务的 Agent 正在运行或等待权限，本次拖动不会重复派发。", agentId: existing.agentId };
    }
    try {
      const prompt = preparedPrompt ?? await buildTaskPrompt(baseUrl, task);
      if (!await bindings.armDispatch(task.id, existing.agentId)) {
        return { kind: "skipped", message: "该任务已有待确认的 Agent 轮次，本次不会重复派发。", agentId: existing.agentId };
      }
      await agent.send(prompt);
      return { kind: "continued", message: null, agentId: existing.agentId };
    } catch (error) {
      await bindings.cancelDispatchArm(task.id, existing.agentId);
      return { kind: "failed", message: error instanceof Error ? error.message : String(error), agentId: existing.agentId };
    }
  }

  // Worktree 是任务级执行上下文。即使项目默认计划仍指向旧目录，后续新建
  // Agent 也必须打开 daemon 已登记的 Worktree，而不能回退到项目默认 cwd。
  const workspacePath = task.developmentContext?.type === "worktree"
    ? task.developmentContext.path
    : settings?.workspacePath;
  const profile = settings?.profile;
  if (!workspacePath || !profile) {
    return {
      kind: "needs_configuration",
      message: "请先在项目设置中配置默认工作区和 Agent Profile，再把任务拖入处理中。",
      agentId: null,
    };
  }

  let createdAgentId: string | null = null;
  try {
    // 先读取人工评论；失败时不创建/绑定/发送 Agent，避免用旧描述静默执行。
    const prompt = preparedPrompt ?? await buildTaskPrompt(baseUrl, task);
    const workspace = await paseo.workspaces.open(workspacePath);
    const provider = profile.model
      ? `${profile.provider}/${profile.model}`
      : profile.provider;
    const agent = await workspace.agents.create({
      config: {
        provider,
        modeId: profile.modeId,
        thinkingOptionId: profile.thinkingOptionId,
        featureValues: profile.featureValues,
      },
      title: `${task.identifier}: ${task.title}`,
    });
    createdAgentId = agent.id;
    // Persist before sending so a fast turn cannot finish before lifecycle
    // write-back has a task binding to receive it.
    await bindings.upsert({
      taskId: task.id,
      taskIdentifier: task.identifier,
      projectId: task.projectId,
      workspaceId: workspace.id,
      agentId: agent.id,
      provider,
      agentTitle: `${task.identifier}: ${task.title}`,
      agentModel: profile.model,
    });
    if (!await bindings.armDispatch(task.id, agent.id)) {
      await bindings.cancelDispatchArm(task.id, agent.id);
      return { kind: "failed", message: "无法为新 Agent 记录本轮派发资格。", agentId: agent.id };
    }
    await agent.send(prompt);
    return { kind: "started", message: null, agentId: agent.id };
  } catch (error) {
    if (createdAgentId) await bindings.cancelDispatchArm(task.id, createdAgentId).catch(() => undefined);
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
      agentId: createdAgentId,
    };
  }
}

export async function assertAgentCanLeaveProcessing(
  paseo: PaseoApi,
  bindings: BindingsStore,
  taskId: string,
): Promise<void> {
  const binding = await bindings.get(taskId);
  if (!binding) return;
  const agent = paseo.agents.ref(binding.agentId);
  try {
    await agent.refresh();
  } catch {
    throw new Error("无法确认关联 Agent 是否已停止，不能归档、删除或移回等待认领。");
  }
  if (isAgentBusy(agent)) {
    throw new Error("该任务的 Agent 仍在运行或等待权限，不能移回等待认领；请先在 Paseo 中结束或处理它。 ");
  }
}
