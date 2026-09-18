import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ProjectAutomationSettingsSchema } from "../shared/contracts.ts";
import type { ProjectAutomationSettings } from "../shared/contracts.ts";
import type { z } from "zod";

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".paseo", "plugin-data", "dashi-taskboard");

interface SettingsFile { byProjectId: Record<string, ProjectAutomationSettings>; }
type ProjectAutomationSettingsInput = z.input<typeof ProjectAutomationSettingsSchema>;

export function createSettingsStore(options: { filePath?: string } = {}) {
  const dataDir = process.env.DASHI_TASKBOARD_PLUGIN_DATA_DIR ?? DEFAULT_DATA_DIR;
  const filePath = options.filePath ?? path.join(dataDir, "settings.json");
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async function readStore(): Promise<SettingsFile> {
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as Partial<SettingsFile>;
      return { byProjectId: raw.byProjectId ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { byProjectId: {} };
      throw error;
    }
  }
  async function writeStore(data: SettingsFile): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2), "utf8");
    await rename(temp, filePath);
  }
  return {
    get(projectId: string): Promise<ProjectAutomationSettings | null> {
      return enqueue(async () => {
        const value = (await readStore()).byProjectId[projectId];
        return value ? ProjectAutomationSettingsSchema.parse(value) : null;
      });
    },
    list(): Promise<ProjectAutomationSettings[]> {
      return enqueue(async () => Object.values((await readStore()).byProjectId)
        .map((value) => ProjectAutomationSettingsSchema.parse(value)));
    },
    patchAutomation(projectId: string, patch: Pick<ProjectAutomationSettings, "lastRunAt" | "lastError">): Promise<ProjectAutomationSettings | null> {
      return enqueue(async () => {
        const current = (await readStore()).byProjectId[projectId];
        if (!current) return null;
        const value = ProjectAutomationSettingsSchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() });
        const store = await readStore();
        await writeStore({ byProjectId: { ...store.byProjectId, [projectId]: value } });
        return value;
      });
    },
    upsert(input: ProjectAutomationSettingsInput): Promise<ProjectAutomationSettings> {
      return enqueue(async () => {
        const value = ProjectAutomationSettingsSchema.parse({ ...input, updatedAt: new Date().toISOString() });
        const current = await readStore();
        await writeStore({ byProjectId: { ...current.byProjectId, [value.projectId]: value } });
        return value;
      });
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
