import type { PaseoApi } from "@getpaseo/client";

import type { BindingsStore } from "./bindings.ts";
import * as dashi from "./dashi-api.ts";
import {
  buildTaskPrompt,
  canStartTaskDispatch,
  dispatchBoundTask,
  hasTaskDispatchConfiguration,
  recordDispatchFailure,
  type TaskDispatchCoordinator,
} from "./dispatch.ts";
import type { SettingsStore } from "./settings.ts";
import type { TaskPlansStore } from "./task-plans.ts";

const AUTOMATION_TICK_MS = 15_000;

export interface PaseoAutomationRuntime {
  attach(paseo: PaseoApi): void;
  ready(): boolean;
  withProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T>;
  runNow(now?: number): Promise<void>;
  stop(): Promise<void>;
}

/** 只使用 handler/lifecycle 注入的公开 Paseo API；cleanup 等待在途单任务领取完成。 */
export function createPaseoAutomationRuntime(
  settings: SettingsStore,
  plans: TaskPlansStore,
  bindings: BindingsStore,
  coordinator: TaskDispatchCoordinator,
  mutationLock: import("./dispatch.ts").TaskMutationLock,
): PaseoAutomationRuntime {
  let paseo: PaseoApi | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<void> = Promise.resolve();
  const projectQueues = new Map<string, Promise<unknown>>();

  function withProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = projectQueues.get(projectId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    projectQueues.set(projectId, current);
    void current.finally(() => {
      if (projectQueues.get(projectId) === current) projectQueues.delete(projectId);
    }).catch(() => undefined);
    return current;
  }

  async function run(now = Date.now()): Promise<void> {
    const api = paseo;
    if (stopped || !api) return;
    const configured = (await settings.list()).filter((item) => item.enabledByUser);
    if (stopped || configured.length === 0) return;
    const projects = (await dashi.listProjects(dashi.resolveBaseUrl())).projects;
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const projectIds = new Set(projectById.keys());
    await Promise.all(configured
      .filter((item) => projectIds.has(item.projectId))
      .filter((item) => !item.lastRunAt || now - new Date(item.lastRunAt).getTime() >= item.intervalMinutes * 60_000)
      .map((snapshot) => withProjectLock(snapshot.projectId, async () => {
        if (stopped) return;
        const baseUrl = dashi.resolveBaseUrl();
        const tasks = (await dashi.listTasks(baseUrl, { projectId: snapshot.projectId, archived: false })).tasks
          .filter((task) => task.status === "backlog" || task.status === "todo");
        let claimed = 0;
        let lastError: string | null = null;
        for (const listed of tasks) {
          if (stopped || claimed >= 1) break;
          const currentPolicy = await settings.get(snapshot.projectId);
          if (!currentPolicy?.enabledByUser) break;
          await mutationLock.run(listed.id, async () => {
            if (stopped) return;
            const task = (await dashi.getTask(baseUrl, listed.id)).task;
            if (
              task.projectId !== snapshot.projectId
              || task.archivedAt !== null
              || (task.status !== "backlog" && task.status !== "todo")
            ) return;
            const binding = await bindings.get(task.id);
            const plan = await plans.get(task.id);
            const configuration = {
              workspacePath: task.developmentContext?.type === "worktree"
                ? task.developmentContext.path
                : plan?.workspacePath ?? currentPolicy.workspacePath,
              profile: plan?.profile ?? currentPolicy.profile,
            };
            const hasConfiguration = hasTaskDispatchConfiguration(task, configuration);
            if (!binding && !hasConfiguration) {
              lastError = `任务 ${task.identifier} 缺少 Agent 计划或项目默认工作区/Profile，已跳过。`;
              return;
            }
            const readiness = await canStartTaskDispatch(api, bindings, task.id);
            if (!readiness.ok) {
              lastError = readiness.message;
              return;
            }
            const latestPolicy = await settings.get(snapshot.projectId);
            if (stopped || !latestPolicy?.enabledByUser) return;
            const latestPlan = await plans.get(task.id);
            const latestConfiguration = {
              workspacePath: task.developmentContext?.type === "worktree"
                ? task.developmentContext.path
                : latestPlan?.workspacePath ?? latestPolicy.workspacePath,
              profile: latestPlan?.profile ?? latestPolicy.profile,
            };
            const hasLatestConfiguration = hasTaskDispatchConfiguration(task, latestConfiguration);
            if (!binding && !hasLatestConfiguration) {
              lastError = `任务 ${task.identifier} 的 Agent 配置已变化，已跳过。`;
              return;
            }
            const prompt = await buildTaskPrompt(baseUrl, task);

            // 从移动开始视为一个领取事务。关闭会在项目锁后落盘，因此该事务完成；
            // 不再领取下一项，也不取消已经启动的 Agent。
            const moved = (await dashi.moveTask(baseUrl, task.id, {
              version: task.version,
              status: "in_progress",
            })).task;
            claimed += 1;
            const dispatch = await coordinator.run(task.id, () => dispatchBoundTask(api, bindings, moved, latestConfiguration, baseUrl, prompt));
            if (dispatch.kind === "failed") {
              lastError = dispatch.message ?? "自动认领失败";
              await recordDispatchFailure(baseUrl, moved, lastError);
            } else if (dispatch.kind === "skipped" || dispatch.kind === "needs_configuration") {
              lastError = dispatch.message;
            }
          });
        }
        await settings.patchAutomation(snapshot.projectId, {
          lastRunAt: new Date(now).toISOString(),
          lastError,
        });
      })));
  }

  function schedule(): void {
    if (timer || stopped || !paseo) return;
    timer = setInterval(() => {
      if (stopped) return;
      inflight = inflight.then(() => run(), () => run()).catch((error) => {
        console.error("[dashi-taskboard] Paseo automation tick failed", error);
      });
    }, AUTOMATION_TICK_MS);
  }

  return {
    attach(api) {
      if (stopped) return;
      paseo = api;
      schedule();
    },
    ready: () => !stopped && paseo !== null,
    withProjectLock,
    runNow(now) {
      if (stopped) return Promise.resolve();
      const current = inflight.then(() => run(now), () => run(now));
      inflight = current.catch((error) => {
        console.error("[dashi-taskboard] Paseo automation tick failed", error);
      });
      return current;
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await inflight;
    },
  };
}
