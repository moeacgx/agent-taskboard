import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { TaskExecutionPlanSchema } from "../shared/contracts.ts";
import type { TaskExecutionPlan } from "../shared/contracts.ts";

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".paseo", "plugin-data", "dashi-taskboard");

interface PlansFile { byTaskId: Record<string, TaskExecutionPlan>; }

/** 任务级新 Agent 计划，独立于 Dashi SQLite；保存计划本身永不触发 Agent。 */
export function createTaskPlansStore(options: { filePath?: string } = {}) {
  const dataDir = process.env.DASHI_TASKBOARD_PLUGIN_DATA_DIR ?? DEFAULT_DATA_DIR;
  const filePath = options.filePath ?? path.join(dataDir, "task-plans.json");
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async function readStore(): Promise<PlansFile> {
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as Partial<PlansFile>;
      return { byTaskId: raw.byTaskId ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { byTaskId: {} };
      throw error;
    }
  }
  async function writeStore(data: PlansFile): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
    await rename(temporary, filePath);
  }
  return {
    get(taskId: string): Promise<TaskExecutionPlan | null> {
      return enqueue(async () => {
        const value = (await readStore()).byTaskId[taskId];
        return value ? TaskExecutionPlanSchema.parse(value) : null;
      });
    },
    list(taskIds?: readonly string[]): Promise<TaskExecutionPlan[]> {
      return enqueue(async () => {
        const values = Object.values((await readStore()).byTaskId);
        return taskIds ? values.filter((plan) => taskIds.includes(plan.taskId)) : values;
      });
    },
    upsert(input: Omit<TaskExecutionPlan, "updatedAt">): Promise<TaskExecutionPlan> {
      return enqueue(async () => {
        const value = TaskExecutionPlanSchema.parse({ ...input, updatedAt: new Date().toISOString() });
        const current = await readStore();
        await writeStore({ byTaskId: { ...current.byTaskId, [value.taskId]: value } });
        return value;
      });
    },
    remove(taskId: string): Promise<void> {
      return enqueue(async () => {
        const current = await readStore();
        if (!(taskId in current.byTaskId)) return;
        const next = { ...current.byTaskId };
        delete next[taskId];
        await writeStore({ byTaskId: next });
      });
    },
  };
}

export type TaskPlansStore = ReturnType<typeof createTaskPlansStore>;
