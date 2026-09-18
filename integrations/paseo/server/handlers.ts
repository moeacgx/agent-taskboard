import type { PluginServerContext } from "@getpaseo/plugin/server";
import { execFile as execFileCallback } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import * as contracts from "../shared/contracts.ts";
import type { BindingsStore } from "./bindings.ts";
import * as dashi from "./dashi-api.ts";
import { performWriteback } from "./writeback.ts";
import { assertAgentCanLeaveProcessing, buildTaskContinuationPrompt, buildTaskPrompt, canStartTaskDispatch, createTaskDispatchCoordinator, dispatchBoundTask, hasDispatchConfiguration, recordDispatchFailure, type TaskDispatchCoordinator, type TaskMutationLock } from "./dispatch.ts";
import type { SettingsStore } from "./settings.ts";
import type { TaskPlansStore } from "./task-plans.ts";
import type { PaseoAutomationRuntime } from "./automation.ts";

const PROVIDER_ICON_MAX_CHARS = 16_000;
const OPTIONAL_PROVIDER_READ_TIMEOUT_MS = 5_000;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const execFile = promisify(execFileCallback);

function absolutePath(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || !path.isAbsolute(trimmed)) {
    throw new Error(`${field}必须是有效的绝对路径。`);
  }
  return path.resolve(trimmed);
}

function equalPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], {
    windowsHide: true,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

async function gitRootFor(workspacePath: string): Promise<string | null> {
  try {
    const value = (await git(workspacePath, ["rev-parse", "--show-toplevel"])).trim();
    return value || null;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    // Git 对非仓库/不存在目录以退出码 128 结束；其它错误（如 git 不可用）不能伪装成空仓库。
    if (code === 128 || code === 1) return null;
    throw new Error(`无法验证 Git 仓库：${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseGitWorktrees(output: string): Array<{ path: string; branch: string | null }> {
  const worktrees: Array<{ path: string; branch: string | null }> = [];
  for (const block of output.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const worktree = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!worktree || lines.some((line) => line.startsWith("prunable"))) continue;
    const branchRef = lines.find((line) => line.startsWith("branch refs/heads/"));
    worktrees.push({
      path: path.normalize(worktree),
      branch: branchRef ? branchRef.slice("branch refs/heads/".length) : null,
    });
  }
  return worktrees;
}

/**
 * Provider 快照的 iconSvg 仅作为隔离 img 的 data URL 使用。拒绝脚本、事件、
 * 外部引用和 CSS url，避免把 daemon 返回的任意 SVG 当成可执行 DOM。
 */
function safeProviderIconDataUrl(iconSvg: unknown): string | null {
  if (typeof iconSvg !== "string") return null;
  const svg = iconSvg.trim();
  if (!svg || svg.length > PROVIDER_ICON_MAX_CHARS || !/^<svg(?:\s|>)/i.test(svg)) return null;
  if (/<\/?(?:script|foreignObject|iframe|object|embed|image|use)\b/i.test(svg)) return null;
  if (/\son[\w:-]+\s*=/i.test(svg) || /(?:href|xlink:href)\s*=/i.test(svg) || /url\s*\(/i.test(svg)) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * `listFeatures` 只是配置面板的默认值目录，不是创建 Agent 的前置条件。
 * 部分 provider（已复现 Grok）不会及时答复它，SDK 本身会等待 90 秒；
 * 此处省略未及时取得的 featureValues，让 provider 在真正创建时采用原生默认，
 * 而不是让已创建的任务在 iframe 15 秒 bridge 超时后看似保存失败。
 */
async function optionalProviderRead<T>(operation: Promise<T>): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.catch(() => null),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), OPTIONAL_PROVIDER_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function optionalFeatureDefaults(
  paseo: import("@getpaseo/client").PaseoApi,
  input: Parameters<import("@getpaseo/client").PaseoApi["providers"]["listFeatures"]>[0],
): Promise<Record<string, unknown> | undefined> {
  const result = await optionalProviderRead(paseo.providers.listFeatures(input));
  if (!result || result.error) return undefined;
  return Object.fromEntries((result.features ?? []).map((feature) => [feature.id, feature.value]));
}

/** 保存计划不应等待 provider discovery；菜单选择时已经验证过 provider/model。 */
async function optionalProviderSnapshot(
  paseo: import("@getpaseo/client").PaseoApi,
  workspacePath: string,
): Promise<Awaited<ReturnType<import("@getpaseo/client").PaseoApi["providers"]["snapshot"]>> | null> {
  return optionalProviderRead(paseo.providers.snapshot({ cwd: workspacePath }));
}

/** Registers every `dashi.*` RPC handler. Called once from `index.server.ts`. */
export function registerHandlers(
  server: PluginServerContext,
  bindings: BindingsStore,
  settings: SettingsStore,
  plans: TaskPlansStore,
  coordinator?: TaskDispatchCoordinator,
  automationRuntime?: PaseoAutomationRuntime,
  mutationLock?: TaskMutationLock,
): void {
  const baseUrl = dashi.resolveBaseUrl();
  const dispatchCoordinator = coordinator ?? createTaskDispatchCoordinator();

  function withTaskMutation<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    return mutationLock ? mutationLock.run(taskId, operation) : operation();
  }

  async function inspectWorktree(workspacePathInput: string): Promise<contracts.PaseoWorktreeScan> {
    const workspacePath = absolutePath(workspacePathInput, "仓库目录");
    try {
      const info = await stat(workspacePath);
      if (!info.isDirectory()) {
        return { workspacePath, gitRoot: null, isGitRoot: false, head: null, branches: [], worktrees: [], error: "当前目录不是 Git 仓库。" };
      }
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        return { workspacePath, gitRoot: null, isGitRoot: false, head: null, branches: [], worktrees: [], error: "当前目录不存在，不能创建 Worktree。" };
      }
      throw error;
    }
    const root = await gitRootFor(workspacePath);
    if (!root) {
      return { workspacePath, gitRoot: null, isGitRoot: false, head: null, branches: [], worktrees: [], error: "当前目录不是 Git 仓库。" };
    }
    const [resolvedPath, resolvedRoot] = await Promise.all([realpath(workspacePath), realpath(root)]);
    const isGitRoot = equalPath(resolvedPath, resolvedRoot);
    const [branchesOutput, worktreesOutput, head] = await Promise.all([
      git(resolvedRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
      git(resolvedRoot, ["worktree", "list", "--porcelain"]),
      git(resolvedRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((value) => value.trim() || null).catch(() => null),
    ]);
    return {
      workspacePath: resolvedPath,
      gitRoot: resolvedRoot,
      isGitRoot,
      head,
      branches: branchesOutput.split(/\r?\n/).map((branch) => branch.trim()).filter(Boolean),
      worktrees: parseGitWorktrees(worktreesOutput),
      error: isGitRoot ? null : `只能在 Git 根目录创建 Worktree。Git 根目录：${resolvedRoot}`,
    };
  }

  async function assertWorktreeCompatibleWithTask(
    paseo: import("@getpaseo/client").PaseoApi,
    taskId: string,
    targetPath: string,
  ): Promise<void> {
    const binding = await bindings.get(taskId);
    if (!binding) return;
    let workspace;
    try {
      workspace = await paseo.workspaces.ref(binding.workspaceId).refresh();
    } catch {
      throw new Error("无法确认当前 Paseo Agent 的工作区，不能切换 Worktree；请先重新绑定。 ");
    }
    const currentPath = workspace?.workspaceDirectory;
    if (!currentPath) {
      throw new Error("当前 Paseo Agent 没有可确认的工作区，不能切换 Worktree；请先重新绑定。 ");
    }
    if (!equalPath(currentPath, targetPath)) {
      throw new Error("当前任务已绑定在另一个工作区运行的 Paseo Agent。请先重新绑定 Agent，再切换 Worktree。 ");
    }
  }

  async function assertDevelopmentContextCompatible(
    paseo: import("@getpaseo/client").PaseoApi,
    taskId: string,
    context: contracts.Task["developmentContext"],
  ): Promise<void> {
    if (!context || context.type !== "worktree") return;
    await assertWorktreeCompatibleWithTask(paseo, taskId, context.path);
  }

  /** 只读 daemon 快照；负责人列表绝不创建会话、发送消息或改任务状态。 */
  async function assignmentCatalog(
    paseo: import("@getpaseo/client").PaseoApi,
    projectWorkspacePath: string | null,
  ) {
    const workspaceEntries: import("@getpaseo/client").PaseoWorkspace[] = [];
    let workspaceCursor: string | undefined;
    do {
      const page = await paseo.workspaces.list({
        page: { limit: 200, ...(workspaceCursor ? { cursor: workspaceCursor } : {}) },
      });
      workspaceEntries.push(...page.entries);
      workspaceCursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    } while (workspaceCursor);

    const [agentResult, projectResult, configResult, availability, snapshot] = await Promise.all([
      paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200 } }),
      paseo.projects.list(),
      paseo.config.get(),
      paseo.providers.listAvailable(),
      paseo.providers.waitForReady({ cwd: projectWorkspacePath ?? undefined }),
    ]);
    const workspaceById = new Map(workspaceEntries.map((workspace) => [workspace.id, workspace]));
    const workspaces: contracts.PaseoWorkspaceChoice[] = [];
    const appendUniquePath = (choice: contracts.PaseoWorkspaceChoice) => {
      if (!choice.path || workspaces.some((current) => current.path && equalPath(current.path, choice.path!))) return;
      workspaces.push(choice);
    };
    for (const project of projectResult.projects) {
      if (!project.projectRootPath.trim()) continue;
      appendUniquePath({
        id: `project:${project.projectId}`,
        name: project.projectCustomName ?? project.projectDisplayName,
        path: project.projectRootPath,
        projectWorkspace: Boolean(projectWorkspacePath && equalPath(project.projectRootPath, projectWorkspacePath)),
        kind: "project",
      });
    }
    for (const workspace of workspaceEntries) {
      if (!workspace.workspaceDirectory?.trim()) continue;
      appendUniquePath({
        id: workspace.id,
        name: workspace.name,
        path: workspace.workspaceDirectory,
        projectWorkspace: Boolean(projectWorkspacePath && equalPath(workspace.workspaceDirectory, projectWorkspacePath)),
        kind: "workspace",
      });
    }
    workspaces.sort((left, right) => Number(right.projectWorkspace) - Number(left.projectWorkspace)
      || Number(left.kind === "workspace") - Number(right.kind === "workspace")
      || (left.name ?? left.path ?? left.id).localeCompare(right.name ?? right.path ?? right.id));
    const agents = agentResult.entries
      .filter((entry) => !entry.agent.archivedAt)
      .map((entry) => {
        const agent = entry.agent;
        const workspace = agent.workspaceId ? workspaceById.get(agent.workspaceId) : undefined;
        const pendingPermissions = (agent as { pendingPermissions?: unknown }).pendingPermissions;
        const requiresPermission = Array.isArray(pendingPermissions) && pendingPermissions.length > 0;
        return {
          id: agent.id,
          workspaceId: agent.workspaceId ?? null,
          workspaceName: workspace?.name ?? null,
          cwd: agent.cwd ?? workspace?.workspaceDirectory ?? "",
          title: agent.title ?? null,
          provider: agent.provider,
          model: agent.model ?? null,
          status: agent.status,
          // SDK 的 requiresAttention/attentionReason 不是权限队列本身；列表快照
          // 的 pendingPermissions 非空才表示需要用户处理权限。
          requiresAttention: requiresPermission,
          attentionReason: requiresPermission ? "permission" as const : null,
        };
      })
      .sort((left, right) => Number(right.cwd === projectWorkspacePath) - Number(left.cwd === projectWorkspacePath)
        || (left.workspaceName ?? "").localeCompare(right.workspaceName ?? "")
        || (left.title ?? left.id).localeCompare(right.title ?? right.id));
    const availableById = new Map(availability.providers.map(({ provider, available }) => [provider, available]));
    const providerEntries = snapshot.entries.filter((entry) => (
      entry.enabled && entry.status === "ready" && availableById.get(entry.provider) === true
    ));
    const providers = providerEntries.map((entry) => ({
      id: entry.provider,
      label: entry.label ?? entry.provider,
      iconDataUrl: safeProviderIconDataUrl(entry.iconSvg),
    }));
    const models = (await Promise.all(providerEntries.map(async (entry) => {
      const result = await paseo.providers.listModels(entry.provider, { cwd: projectWorkspacePath ?? undefined });
      if (result.error) throw new Error(`无法读取 ${entry.label ?? entry.provider} 的模型：${result.error}`);
      return (result.models ?? [])
        .filter((model) => model.isSelectable !== false)
        .map((model) => ({
          // 用独立前缀区分 SDK 模型目录与用户保存的 Agent Profile。
          id: `paseo-catalog-model:${entry.provider}:${model.id}`,
          name: `${entry.label ?? entry.provider} · ${model.label}`,
          provider: entry.provider,
          model: model.id,
          ...(entry.defaultModeId ? { modeId: entry.defaultModeId } : {}),
          ...(model.defaultThinkingOptionId
            ? { thinkingOptionId: model.defaultThinkingOptionId }
            : model.thinkingOptions?.find((option) => option.isDefault)?.id
              ? { thinkingOptionId: model.thinkingOptions.find((option) => option.isDefault)!.id }
              : {}),
        }));
    }))).flat();
    return {
      agents,
      workspaces,
      profiles: (configResult.config.agentProfiles ?? []) as contracts.AgentProfileConfig[],
      providers,
      models,
    };
  }

  /** 任务展示只需要绑定 Agent 的当前身份，绝不能等待 provider 模型目录。 */
  async function boundAgentCatalog(paseo: import("@getpaseo/client").PaseoApi) {
    const [agentResult, workspaceResult] = await Promise.all([
      paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200 } }),
      paseo.workspaces.list({ page: { limit: 200 } }),
    ]);
    const workspaceById = new Map(workspaceResult.entries.map((workspace) => [workspace.id, workspace]));
    return new Map(agentResult.entries
      .filter((entry) => !entry.agent.archivedAt)
      .map((entry) => {
        const agent = entry.agent;
        const workspace = agent.workspaceId ? workspaceById.get(agent.workspaceId) : undefined;
        return [agent.id, {
          id: agent.id,
          workspaceId: agent.workspaceId ?? null,
          workspaceName: workspace?.name ?? null,
          cwd: agent.cwd ?? workspace?.workspaceDirectory ?? "",
          title: agent.title ?? null,
          provider: agent.provider,
          model: agent.model ?? null,
          status: agent.status,
          requiresAttention: Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length > 0,
          attentionReason: Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length > 0 ? "permission" as const : null,
        } satisfies contracts.PaseoExistingAgent];
      }));
  }

  /**
   * SDK 模型目录只提供候选项。真正保存计划时再按用户已选工作区读取
   * feature 默认值，避免用其它工作区的 provider 配置伪造当前任务配置。
   */
  async function resolveCatalogModelProfile(
    paseo: import("@getpaseo/client").PaseoApi,
    workspacePath: string,
    profile: contracts.AgentProfileConfig,
  ): Promise<contracts.AgentProfileConfig> {
    if (!profile.id.startsWith("paseo-catalog-model:")) return profile;
    if (!profile.model) throw new Error("所选 Paseo 模型缺少模型标识，请刷新后重试。");

    const snapshot = await optionalProviderSnapshot(paseo, workspacePath);
    const entry = snapshot?.entries.find((candidate) => candidate.provider === profile.provider);
    if (entry && (!entry.enabled || entry.status === "unavailable" || entry.status === "error")) {
      throw new Error("所选 Paseo provider 当前不可用，请刷新负责人列表后重试。");
    }
    const model = entry?.models?.find((candidate) => candidate.id === profile.model && candidate.isSelectable !== false);
    if (entry?.status === "ready" && entry.models && !model) {
      throw new Error("所选 Paseo 模型已不可用，请刷新负责人列表后重新选择。");
    }
    const modeId = profile.modeId
      ?? (entry?.status === "ready" ? entry.defaultModeId ?? undefined : undefined);
    const thinkingOptionId = profile.thinkingOptionId
      ?? model?.defaultThinkingOptionId
      ?? model?.thinkingOptions?.find((option) => option.isDefault)?.id;
    const featureValues = entry?.status === "ready" && model
      ? await optionalFeatureDefaults(paseo, {
        provider: `${profile.provider}/${model.id}`,
        cwd: workspacePath,
        ...(modeId ? { modeId } : {}),
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
      })
      : undefined;
    return {
      // 显式选择的 Mode/Thinking 优先；只有未选择时才补当前 workspace 的 SDK 默认值。
      // 用户已有 Profile 不走此分支，保持原样。
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      model: profile.model,
      ...(modeId ? { modeId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(featureValues ? { featureValues } : {}),
    };
  }

  function existingAssignment(
    binding: contracts.Binding,
    agent: contracts.PaseoExistingAgent | null,
  ): contracts.PaseoTaskAssignment {
    return {
      kind: "existing",
      taskId: binding.taskId,
      agentId: binding.agentId,
      workspaceId: binding.workspaceId,
      workspaceName: agent?.workspaceName ?? null,
      provider: agent?.provider ?? binding.provider,
      model: agent?.model ?? binding.agentModel,
      title: agent?.title ?? binding.agentTitle,
      status: agent?.status ?? "unavailable",
    };
  }

  async function moveAndDispatch(
    paseo: import("@getpaseo/client").PaseoApi,
    input: { id: string; version: number; status: import("../shared/contracts").TaskStatus; sortOrder?: number },
  ) {
    return withTaskMutation(input.id, () => moveAndDispatchUnsafe(paseo, input));
  }

  async function moveAndDispatchUnsafe(
    paseo: import("@getpaseo/client").PaseoApi,
    input: { id: string; version: number; status: import("../shared/contracts").TaskStatus; sortOrder?: number },
  ) {
    const current = await dashi.getTask(baseUrl, input.id);
    const wantsStart = input.status === "in_progress" && current.task.status !== "in_progress";
    const projectSettings = wantsStart
      ? (await plans.get(input.id)) ?? await settings.get(current.task.projectId)
      : null;
    const binding = wantsStart ? await bindings.get(input.id) : null;
    if (wantsStart && !binding && !hasDispatchConfiguration(projectSettings)) {
      return {
        task: current.task,
        dispatch: "needs_configuration" as const,
        dispatchMessage: "请先在项目设置中配置默认工作区和 Agent Profile，再把任务拖入处理中。",
      };
    }
    if (wantsStart) {
      const readiness = await canStartTaskDispatch(paseo, bindings, input.id);
      if (!readiness.ok) {
        return { task: current.task, dispatch: "skipped" as const, dispatchMessage: readiness.message };
      }
    }
    const prompt = wantsStart ? await buildTaskPrompt(baseUrl, current.task) : undefined;
    if (input.status === "todo" || input.status === "backlog" || input.status === "canceled") {
      await assertAgentCanLeaveProcessing(paseo, bindings, input.id);
    }
    let movedTask = (await dashi.moveTask(baseUrl, input.id, {
      version: input.version,
      status: input.status,
      sortOrder: input.sortOrder,
    })).task;
    if (!wantsStart) return { task: movedTask, dispatch: "none" as const, dispatchMessage: null };

    const result = await dispatchCoordinator.run(input.id, () => dispatchBoundTask(paseo, bindings, movedTask, projectSettings, baseUrl, prompt));
    if (result.kind === "failed") movedTask = await recordDispatchFailure(baseUrl, movedTask, result.message ?? "未知错误");
    return { task: movedTask, dispatch: result.kind, dispatchMessage: result.message };
  }

  server.handle(contracts.checkConnection, async (_input, { paseo }) => {
    automationRuntime?.attach(paseo);
    const result = await dashi.checkConnection(baseUrl);
    return { connected: result.connected, baseUrl, error: result.error };
  });

  server.handle(contracts.listProjects, (_input, { paseo }) => {
    automationRuntime?.attach(paseo);
    return dashi.listProjects(baseUrl);
  });
  server.handle(contracts.inspectPaseoWorktree, ({ workspacePath }) => inspectWorktree(workspacePath));

  server.handle(contracts.createPaseoWorktree, async (input, { paseo }) => {
    const scan = await inspectWorktree(input.workspacePath);
    const gitRoot = scan.gitRoot;
    if (!gitRoot) throw new Error(scan.error ?? "当前目录不是 Git 仓库。 ");
    if (!scan.isGitRoot) throw new Error(scan.error ?? "只能在 Git 根目录创建 Worktree。 ");
    if (input.taskId && await bindings.get(input.taskId)) {
      // 新 worktree 的宿主目录尚未生成，已有绑定必然不能安全地视为同 cwd。
      throw new Error("当前任务已绑定 Paseo Agent。请先重新绑定 Agent，再创建并切换 Worktree。 ");
    }
    try {
      await git(gitRoot, ["check-ref-format", "--branch", input.branch]);
    } catch {
      throw new Error("分支名称不合法，请使用 Git 可接受的分支名。 ");
    }
    if (input.branchMode === "existing" && !scan.branches.includes(input.branch)) {
      throw new Error("所选已有分支不存在，请刷新后重试。 ");
    }
    if (input.branchMode === "existing" && scan.worktrees.some((worktree) => worktree.branch === input.branch)) {
      throw new Error("该分支已在现有 Worktree 中检出，请直接选择该 Worktree。 ");
    }
    if (input.branchMode === "new" && scan.branches.includes(input.branch)) {
      throw new Error("该分支已存在；请选择“已有分支”检出，或填写新的分支名。 ");
    }
    if (input.branchMode === "new" && !scan.head) {
      throw new Error("当前 Git HEAD 处于分离状态，不能据此创建新分支。 ");
    }

    const existing = await paseo.workspaces.list({ page: { limit: 200 } });
    const sourceWorkspace = existing.entries.find((workspace) => (
      typeof workspace.workspaceDirectory === "string" && equalPath(workspace.workspaceDirectory, gitRoot)
    ));
    // worktreeSlug 只是 daemon 管理路径的稳定名称，不接受也不解释为用户自定义绝对路径。
    const worktreeSlug = input.branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
    const source = input.branchMode === "new"
      ? {
        kind: "worktree" as const,
        cwd: gitRoot,
        ...(sourceWorkspace?.projectId ? { projectId: sourceWorkspace.projectId } : {}),
        action: "branch-off" as const,
        baseBranch: scan.head!,
        branchName: input.branch,
        worktreeSlug,
      }
      : {
        kind: "worktree" as const,
        cwd: gitRoot,
        ...(sourceWorkspace?.projectId ? { projectId: sourceWorkspace.projectId } : {}),
        action: "checkout" as const,
        refName: input.branch,
        worktreeSlug,
      };
    const handle = await paseo.workspaces.create({ title: `Worktree · ${input.branch}`, source });
    const workspacePath = handle.directory ?? (await handle.refresh())?.workspaceDirectory ?? null;
    if (!workspacePath) {
      throw new Error("Paseo 已创建 Worktree，但未返回工作区目录；请在 Paseo 工作区列表确认后重试。 ");
    }
    const nextScan = await inspectWorktree(gitRoot);
    return {
      context: { type: "worktree" as const, path: workspacePath, branch: input.branch },
      workspace: { id: handle.id, path: workspacePath, branch: input.branch },
      scan: nextScan,
    };
  });

  server.handle(contracts.bridgeRequest, async (input, { paseo }) => {
    automationRuntime?.attach(paseo);
    const path = input.path.split("?", 1)[0];
    const match = /^\/api\/tasks\/([^/]+)(?:\/(archive|restore))?$/.exec(path);
    const taskId = match ? decodeURIComponent(match[1]) : null;
    const forward = async () => {
    if (match && input.method === "PATCH" && input.body?.kind === "text") {
      let body: { status?: unknown; developmentContext?: unknown } | null = null;
      try {
        body = JSON.parse(input.body.value) as { status?: unknown; developmentContext?: unknown };
      } catch {
        // Dashi 仍会为无效 JSON/字段给出原始 API 错误；此处只处理已确认的 worktree 切换。
      }
      if (body && typeof body.status === "string") {
        const current = await dashi.getTask(baseUrl, taskId!);
        if (body.status !== current.task.status) {
          return {
            status: 409,
            headers: { "content-type": "application/json" },
            body: {
              kind: "json" as const,
              value: { error: {
                code: "TASK_STATUS_REQUIRES_MOVE",
                message: "任务状态必须通过移动接口更新，以执行 Paseo Agent 状态与权限门禁。",
              } },
            },
          };
        }
      }
      if (body && "developmentContext" in body) {
        const context = contracts.DevelopmentContextSchema.safeParse(body.developmentContext);
        if (context.success) await assertDevelopmentContextCompatible(paseo, taskId!, context.data);
      }
    }
    // 原版 iframe 也必须经过同一运行态门禁，不能借通用 HTTP 桥绕过归档/删除保护。
    if (match && (input.method === "DELETE" || (input.method === "POST" && match[2] === "archive"))) {
      await assertTaskAgentIdle(paseo, taskId!);
    }
    return dashi.bridgeRequest(baseUrl, input);
    };
    const taskMutation = taskId !== null && (
      input.method === "PATCH"
      || input.method === "DELETE"
      || (input.method === "POST" && (match?.[2] === "archive" || match?.[2] === "restore"))
    );
    return taskMutation ? withTaskMutation(taskId!, forward) : forward();
  });

  server.handle(contracts.listTasks, (input, { paseo }) => {
    automationRuntime?.attach(paseo);
    return dashi.listTasks(baseUrl, input);
  });

  async function assertTaskAgentIdle(paseo: import("@getpaseo/client").PaseoApi, taskId: string) {
    await assertAgentCanLeaveProcessing(paseo, bindings, taskId);
  }

  server.handle(contracts.archiveTask, async ({ id, version }, { paseo }) => {
    return withTaskMutation(id, async () => {
      await assertTaskAgentIdle(paseo, id);
      return dashi.archiveTask(baseUrl, id, version);
    });
  });

  server.handle(contracts.restoreTask, ({ id, version }) => withTaskMutation(id, () => dashi.restoreTask(baseUrl, id, version)));

  server.handle(contracts.deleteTask, async ({ id, version }, { paseo }) => {
    return withTaskMutation(id, async () => {
    await assertTaskAgentIdle(paseo, id);
    const current = await dashi.getTask(baseUrl, id);
    const archived = current.task.archivedAt
      ? current.task
      : (await dashi.archiveTask(baseUrl, id, version)).task;
    await dashi.deleteArchivedTask(baseUrl, id, archived.version);
    return { deleted: true as const };
    });
  });

  server.handle(contracts.getTask, ({ id }) => dashi.getTask(baseUrl, id));

  server.handle(contracts.createTask, (input) => dashi.createTask(baseUrl, input));

  server.handle(contracts.updateTask, ({ id, ...changes }) => dashi.updateTask(baseUrl, id, changes));

  server.handle(contracts.moveTask, async (input, { paseo }) => {
    const result = await moveAndDispatch(paseo, input);
    if (result.dispatch === "needs_configuration" || result.dispatch === "skipped") {
      throw new Error(result.dispatchMessage ?? "当前任务不能移动到处理中。 ");
    }
    return { task: result.task };
  });

  server.handle(contracts.moveTaskBoard, (input, { paseo }) => moveAndDispatch(paseo, input));

  server.handle(contracts.retryTaskDispatch, async ({ id, version }, { paseo }) => {
    return withTaskMutation(id, async () => {
    const current = await dashi.getTask(baseUrl, id);
    const projectSettings = (await plans.get(id)) ?? await settings.get(current.task.projectId);
    const binding = await bindings.get(id);
    if (!binding && !hasDispatchConfiguration(projectSettings)) {
      return { task: current.task, dispatch: "needs_configuration" as const, dispatchMessage: "请先在项目设置中配置默认工作区和 Agent Profile。" };
    }
    const readiness = await canStartTaskDispatch(paseo, bindings, id);
    if (!readiness.ok) {
      return { task: current.task, dispatch: "skipped" as const, dispatchMessage: readiness.message };
    }
    const prompt = await buildTaskPrompt(baseUrl, current.task);
    const moved = current.task.status === "in_progress"
      ? current.task
      : (await dashi.moveTask(baseUrl, id, { version, status: "in_progress" })).task;
    const result = await dispatchCoordinator.run(id, () => dispatchBoundTask(paseo, bindings, moved, projectSettings, baseUrl, prompt));
    const task = result.kind === "failed" ? await recordDispatchFailure(baseUrl, moved, result.message ?? "未知错误") : moved;
    return { task, dispatch: result.kind, dispatchMessage: result.message };
    });
  });

  server.handle(contracts.armTaskTurn, async ({ taskId }, { paseo }) => {
    return withTaskMutation(taskId, async () => {
    const binding = await bindings.get(taskId);
    if (!binding) throw new Error("任务尚未绑定 Paseo Agent。 ");
    const readiness = await canStartTaskDispatch(paseo, bindings, taskId);
    if (!readiness.ok) throw new Error(readiness.message);
    const armed = await bindings.armDispatch(taskId, binding.agentId);
    if (!armed) throw new Error("无法记录本轮 Agent 派发资格。 ");
    return { binding: armed };
    });
  });

  server.handle(contracts.continueTaskAgent, async ({ taskId, message }, { paseo }) => {
    return withTaskMutation(taskId, async () => {
    const binding = await bindings.get(taskId);
    if (!binding) throw new Error("任务尚未绑定 Paseo Agent。 ");
    let { task } = await dashi.getTask(baseUrl, taskId);
    const prompt = message
      ? await buildTaskContinuationPrompt(baseUrl, task, message)
      : await buildTaskPrompt(baseUrl, task);
    const readiness = await canStartTaskDispatch(paseo, bindings, taskId);
    if (!readiness.ok) throw new Error(readiness.message);
    if (task.status !== "in_progress") {
      task = (await dashi.moveTask(baseUrl, taskId, { version: task.version, status: "in_progress" })).task;
    }
    const armed = await bindings.armDispatch(taskId, binding.agentId);
    if (!armed) throw new Error("无法记录本轮 Agent 派发资格。 ");
    try {
      await paseo.agents.ref(binding.agentId).send(prompt);
      return { task, binding: armed };
    } catch (error) {
      await bindings.cancelDispatchArm(taskId, binding.agentId);
      const failed = await recordDispatchFailure(baseUrl, task, error instanceof Error ? error.message : String(error));
      return { task: failed, binding: (await bindings.get(taskId)) ?? armed };
    }
    });
  });

  server.handle(contracts.listComments, ({ taskId }) => dashi.listComments(baseUrl, taskId));

  server.handle(contracts.buildTaskPrompt, async ({ taskId }) => {
    const { task } = await dashi.getTask(baseUrl, taskId);
    return { prompt: await buildTaskPrompt(baseUrl, task) };
  });

  server.handle(contracts.addComment, ({ taskId, body }) => dashi.addComment(baseUrl, taskId, body));

  server.handle(contracts.getBinding, async ({ taskId }) => ({ binding: await bindings.get(taskId) }));

  server.handle(contracts.getProjectSettings, async ({ projectId }) => ({ settings: await settings.get(projectId) }));
  server.handle(contracts.saveProjectSettings, async (input, { paseo }) => {
    automationRuntime?.attach(paseo);
    const save = async () => {
      const current = await settings.get(input.projectId);
      return { settings: await settings.upsert({
        ...input,
        enabledByUser: current?.enabledByUser ?? input.enabledByUser,
        intervalMinutes: current?.intervalMinutes ?? input.intervalMinutes,
        quotaAware: current?.quotaAware ?? input.quotaAware,
        lastRunAt: current?.lastRunAt ?? null,
        lastError: current?.lastError ?? null,
        updatedAt: new Date().toISOString(),
      }) };
    };
    return automationRuntime
      ? automationRuntime.withProjectLock(input.projectId, save)
      : save();
  });

  server.handle(contracts.getPaseoAutomation, async ({ projectId }, { paseo }) => {
    automationRuntime?.attach(paseo);
    const current = await settings.get(projectId);
    return { automation: {
      projectId,
      enabledByUser: current?.enabledByUser ?? false,
      intervalMinutes: current?.intervalMinutes ?? 5,
      quotaAware: false,
      status: current?.enabledByUser ? "ACTIVE" as const : "PAUSED" as const,
      schedulerReady: automationRuntime?.ready() ?? false,
      quotaAvailable: false as const,
      lastRunAt: current?.lastRunAt ?? null,
      lastError: current?.lastError ?? null,
    } };
  });

  server.handle(contracts.savePaseoAutomation, async (input, { paseo }) => {
    automationRuntime?.attach(paseo);
    if (input.quotaAware) throw new Error("当前 Paseo SDK 无法可靠读取 provider 额度，额度开关暂不可用。 ");
    const save = async () => {
      const current = await settings.get(input.projectId);
      const saved = await settings.upsert({
        projectId: input.projectId,
        workspacePath: current?.workspacePath ?? null,
        profile: current?.profile ?? null,
        enabledByUser: input.enabledByUser,
        intervalMinutes: input.intervalMinutes,
        quotaAware: false,
        lastRunAt: input.enabledByUser && !current?.enabledByUser ? null : current?.lastRunAt ?? null,
        lastError: current?.lastError ?? null,
        updatedAt: new Date().toISOString(),
      });
      return { automation: {
        projectId: saved.projectId,
        enabledByUser: saved.enabledByUser,
        intervalMinutes: saved.intervalMinutes,
        quotaAware: false,
        status: saved.enabledByUser ? "ACTIVE" as const : "PAUSED" as const,
        schedulerReady: automationRuntime?.ready() ?? false,
        quotaAvailable: false as const,
        lastRunAt: saved.lastRunAt,
        lastError: saved.lastError,
      } };
    };
    const result = await (automationRuntime
      ? automationRuntime.withProjectLock(input.projectId, save)
      : save());
    if (input.enabledByUser && automationRuntime) {
      void automationRuntime.runNow().catch((error) => {
        console.error("[dashi-taskboard] failed to start enabled automation", error);
      });
    }
    return result;
  });

  server.handle(contracts.listBindings, async () => ({ bindings: await bindings.list() }));

  server.handle(contracts.listPaseoAssignmentOptions, async ({ projectId }, { paseo }) => {
    let defaultWorkspacePath: string | null = null;
    if (projectId) {
      const { projects } = await dashi.listProjects(baseUrl);
      const configured = await settings.get(projectId);
      defaultWorkspacePath = configured?.workspacePath
        ?? projects.find((project) => project.id === projectId)?.workspacePath
        ?? null;
    }
    return { ...(await assignmentCatalog(paseo, defaultWorkspacePath)), defaultWorkspacePath };
  });

  server.handle(contracts.getPaseoConfigurationOptions, async (input, { paseo }) => {
    let provider = input.provider;
    let modelId = input.model;
    let workspacePath = input.workspacePath;
    let currentModeId = input.modeId;
    let currentThinkingOptionId = input.thinkingOptionId;
    let sessionModes: ReadonlyArray<{ id: string; label: string; description?: string }> | null = null;
    const editable = input.agentId === undefined;

    if (input.agentId) {
      const handle = paseo.agents.ref(input.agentId);
      await handle.refresh();
      const agent = handle.current();
      if (!agent || agent.archivedAt) {
        throw new Error("该 Paseo 会话不存在或已归档，请刷新后重试。");
      }
      provider = agent.provider;
      modelId = agent.model ?? input.model;
      workspacePath = agent.cwd || input.workspacePath;
      currentModeId = agent.currentModeId ?? undefined;
      currentThinkingOptionId = agent.thinkingOptionId ?? undefined;
      sessionModes = agent.availableModes;
    }

    const snapshot = await paseo.providers.waitForReady({ cwd: workspacePath });
    const providerEntry = snapshot.entries.find((entry) => entry.provider === provider);
    if (!providerEntry || !providerEntry.enabled || providerEntry.status !== "ready") {
      throw new Error("所选 Paseo provider 当前不可用，请刷新后重试。");
    }

    const [modeResult, modelResult] = await Promise.all([
      editable ? paseo.providers.listModes(provider, { cwd: workspacePath }) : Promise.resolve(null),
      paseo.providers.listModels(provider, { cwd: workspacePath }),
    ]);
    if (modeResult?.error) throw new Error(`无法读取 ${providerEntry.label ?? provider} 的 Mode：${modeResult.error}`);
    if (modelResult.error) throw new Error(`无法读取 ${providerEntry.label ?? provider} 的模型：${modelResult.error}`);

    const model = (modelResult.models ?? []).find((candidate) => (
      candidate.id === modelId && candidate.isSelectable !== false
    ));
    if (!model) throw new Error("所选 Paseo 模型已不可用，请刷新后重新选择。");

    const defaultModeId = providerEntry.defaultModeId ?? undefined;
    const defaultThinkingOptionId = model.defaultThinkingOptionId
      ?? model.thinkingOptions?.find((option) => option.isDefault)?.id;
    if (editable) {
      currentModeId ??= defaultModeId;
      currentThinkingOptionId ??= defaultThinkingOptionId;
    }
    const modes = sessionModes ?? modeResult?.modes ?? [];
    const modeSource = modes.length === 0
      ? "none" as const
      : sessionModes === null
        ? "provider_catalog" as const
        : "agent_session" as const;

    return {
      options: {
        provider,
        model: model.id,
        modes: modes.map((mode) => ({
          id: mode.id,
          label: mode.label,
          ...(mode.description ? { description: mode.description } : {}),
        })),
        thinkingOptions: (model.thinkingOptions ?? []).map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
        ...(defaultModeId ? { defaultModeId } : {}),
        ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
        ...(currentModeId ? { currentModeId } : {}),
        ...(currentThinkingOptionId ? { currentThinkingOptionId } : {}),
        modeSource,
        ...(modeSource === "none"
          ? { modeMessage: "Paseo 未为当前 provider 会话提供可选模式；Mode 使用 provider 默认，权限由 provider 的独立设置控制。" }
          : {}),
        editable,
      },
    };
  });

  server.handle(contracts.bindExistingPaseoAgent, async ({ taskId, agentId }, { paseo }) => {
    return withTaskMutation(taskId, async () => {
    const { task } = await dashi.getTask(baseUrl, taskId);
    if (task.archivedAt !== null) throw new Error("已归档任务不能绑定 Paseo 会话；请先恢复任务。 ");
    const { projects } = await dashi.listProjects(baseUrl);
    const projectWorkspacePath = projects.find((project) => project.id === task.projectId)?.workspacePath ?? null;
    const catalog = await assignmentCatalog(paseo, projectWorkspacePath);
    const agent = catalog.agents.find((item) => item.id === agentId);
    if (!agent) throw new Error("该 Paseo 会话不存在或已归档，不能选择。 ");
    if (!agent.workspaceId) throw new Error("该 Paseo 会话没有关联工作区，不能绑定到任务。 ");
    if (task.developmentContext?.type === "worktree" && !equalPath(agent.cwd, task.developmentContext.path)) {
      throw new Error("该 Paseo Agent 的工作区与任务 Worktree 不一致。请重新绑定同一工作区的 Agent。 ");
    }
    const currentBinding = await bindings.get(task.id);
    if (currentBinding && currentBinding.agentId !== agent.id) {
      await assertTaskAgentIdle(paseo, task.id);
    }
    const occupied = await bindings.findByAgentId(agent.id);
    if (occupied && occupied.taskId !== task.id) {
      throw new Error(`该 Paseo 会话已绑定到任务 ${occupied.taskIdentifier}，不能抢占。`);
    }
    const binding = await bindings.upsert({
      taskId: task.id,
      taskIdentifier: task.identifier,
      projectId: task.projectId,
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      provider: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
      agentTitle: agent.title,
      agentModel: agent.model,
      rejectIfBoundElsewhere: true,
    });
    return { assignment: existingAssignment(binding, agent) };
    });
  });

  server.handle(contracts.saveTaskExecutionPlan, async (input, { paseo }) => {
    const save = () => withTaskMutation(input.taskId, async () => {
    const { task } = await dashi.getTask(baseUrl, input.taskId);
    if (task.archivedAt !== null) throw new Error("已归档任务不能保存新 Agent 计划；请先恢复任务。 ");
    if (task.projectId !== input.projectId) throw new Error("任务所属项目已变化，请刷新后重新选择新 Agent 计划。 ");
    const currentBinding = await bindings.get(task.id);
    if (currentBinding) {
      // 这是用户在详情中显式切换到“新建 Agent”时的替换，不允许让旧运行会话隐形。
      await assertTaskAgentIdle(paseo, task.id);
    }
    const worktreePath = task.developmentContext?.type === "worktree" ? task.developmentContext.path : null;
    if (currentBinding && worktreePath) await assertWorktreeCompatibleWithTask(paseo, task.id, worktreePath);
    // 表单可能仍带项目默认 cwd；任务级 Worktree 是唯一真实执行目录，服务端强制采用它。
    const workspacePath = worktreePath ?? input.workspacePath;
    if (worktreePath) {
      const registered = await paseo.workspaces.list({ page: { limit: 200 } });
      if (!registered.entries.some((workspace) => (
        typeof workspace.workspaceDirectory === "string" && equalPath(workspace.workspaceDirectory, workspacePath)
      ))) {
        throw new Error("所选 Worktree 尚未登记为 Paseo 工作区，不能创建 Agent 计划。 ");
      }
    }
    const profile = await resolveCatalogModelProfile(paseo, workspacePath, input.profile);
    const plan = await plans.upsert({ ...input, workspacePath, profile });
    // 所有可能失败的校验和计划落盘完成后，才替换原绑定；失败必须保留原负责人。
    if (currentBinding) await bindings.remove(task.id);
    return {
      assignment: {
        kind: "planned" as const,
        taskId: plan.taskId,
        workspacePath: plan.workspacePath,
        profile: plan.profile,
      },
    };
    });
    return automationRuntime
      ? automationRuntime.withProjectLock(input.projectId, save)
      : save();
  });

  server.handle(contracts.getPaseoTaskAssignments, async ({ taskIds }, { paseo }) => {
    const [storedBindings, storedPlans] = await Promise.all([bindings.list(), plans.list(taskIds)]);
    const relevantBindings = storedBindings.filter((binding) => taskIds.includes(binding.taskId));
    let agentsById = new Map<string, contracts.PaseoExistingAgent>();
    if (relevantBindings.length > 0) {
      try {
        agentsById = await boundAgentCatalog(paseo);
      } catch {
        // 无法读取实时会话时明确标为 unavailable，绝不伪装成 idle 或可继续运行。
      }
    }
    const byTaskId = new Map(relevantBindings.map((binding) => [
      binding.taskId,
      existingAssignment(binding, agentsById.get(binding.agentId) ?? null),
    ]));
    for (const plan of storedPlans) {
      if (!byTaskId.has(plan.taskId)) {
        byTaskId.set(plan.taskId, {
          kind: "planned",
          taskId: plan.taskId,
          workspacePath: plan.workspacePath,
          profile: plan.profile,
        });
      }
    }
    return { assignments: taskIds.flatMap((taskId) => {
      const assignment = byTaskId.get(taskId);
      return assignment ? [assignment] : [];
    }) };
  });

  server.handle(contracts.clearPaseoTaskAssignment, async ({ taskId }, { paseo }) => {
    return withTaskMutation(taskId, async () => {
      await assertTaskAgentIdle(paseo, taskId);
      await Promise.all([bindings.remove(taskId), plans.remove(taskId)]);
      return { ok: true as const };
    });
  });

  server.handle(contracts.getPaseoPresentations, async ({ taskIds }, { paseo }) => {
    const presentations = await Promise.all(taskIds.map(async (taskId) => {
      const binding = await bindings.get(taskId);
      if (!binding) return null;
      const agent = paseo.agents.ref(binding.agentId);
      try {
        await agent.refresh();
        if (!agent.status) {
          return {
            taskId,
            agentId: binding.agentId,
            status: "unavailable" as const,
            requiresAttention: false,
            attentionReason: null,
            updatedAt: null,
            title: null,
          };
        }
        const pendingPermissions = agent.pendingPermissions?.length ?? 0;
        return {
          taskId,
          agentId: binding.agentId,
          status: agent.status,
          requiresAttention: pendingPermissions > 0,
          attentionReason: pendingPermissions > 0 ? "permission" as const : null,
          updatedAt: null,
          title: null,
        };
      } catch {
        // 无法刷新时不可将 Agent 误报为 idle；由 iframe 明确展示未知状态。
        return {
          taskId,
          agentId: binding.agentId,
          status: "unavailable" as const,
          requiresAttention: false,
          attentionReason: null,
          updatedAt: null,
          title: null,
        };
      }
    }));
    return { presentations: presentations.filter((item): item is NonNullable<typeof item> => item !== null) };
  });

  server.handle(contracts.bindAgent, async (input) => ({ binding: await bindings.upsert(input) }));

  server.handle(contracts.unbindAgent, async ({ taskId }) => {
    await bindings.remove(taskId);
    return { ok: true as const };
  });

  server.handle(contracts.retryWriteback, async ({ taskId }) => withTaskMutation(taskId, async () => {
    const binding = await bindings.get(taskId);
    if (!binding) throw new Error(`No binding for task '${taskId}'.`);
    const pending = binding.pendingWriteback;
    if (!pending) throw new Error("This task has no pending write-back to retry.");
    const pendingGeneration = pending.generation ?? (binding.turnGeneration === 0 ? 0 : null);
    if (pendingGeneration === null || binding.turnGeneration !== pendingGeneration || binding.acceptedTurnId !== null) {
      throw new Error("待写回属于旧 Agent 轮次；任务已开始新轮，拒绝覆盖当前结果。");
    }
    const currentTask = (await dashi.getTask(baseUrl, taskId)).task;
    if (currentTask.archivedAt !== null || currentTask.status === "done" || currentTask.status === "canceled") {
      throw new Error("任务已完成、取消或归档，拒绝重试旧 Agent 写回。");
    }

    await performWriteback(
      baseUrl,
      bindings,
      taskId,
      binding.agentId,
      pending.outcome,
      pending.commentBody,
      pending.status,
      pending.commentPosted,
      pending.turnId ?? null,
      pendingGeneration,
      null,
    );
    const updated = await bindings.get(taskId);
    return { binding: updated ?? binding };
  }));
}
