import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BindingSchema, type AgentOutcome, type Binding, type PendingWriteback } from "../shared/contracts.ts";

type PendingWritebackInput = Omit<PendingWriteback, "turnId" | "generation">
  & Partial<Pick<PendingWriteback, "turnId" | "generation">>;

/**
 * Task <-> Paseo workspace/agent bindings, persisted as a plain JSON file
 * owned entirely by this plugin.
 *
 * The v0.8.0 `@getpaseo/plugin` SDK's `registerSettings()` returns `void` (no
 * read/save handle) — confirmed against the installed
 * `node_modules/@getpaseo/plugin/dist/server/contracts.d.ts`, which is newer
 * information than the public docs describing a settings handle. Plain
 * `node:fs` access is available to plugin server code, so this store uses
 * that directly instead. It is deliberately independent of the dashi
 * database and of the user's project data; the path is overridable for
 * tests via `DASHI_TASKBOARD_PLUGIN_DATA_DIR` (see README).
 */
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".paseo", "plugin-data", "dashi-taskboard");

interface BindingsFile {
  byTaskId: Record<string, Binding>;
}

async function readStore(filePath: string): Promise<BindingsFile> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as Partial<BindingsFile> | null;
    const entries = Object.entries(parsed?.byTaskId ?? {}).map(([taskId, binding]) => [
      taskId,
      BindingSchema.parse(binding),
    ] as const);
    return { byTaskId: Object.fromEntries(entries) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { byTaskId: {} };
    throw error;
  }
}

async function writeStore(filePath: string, data: BindingsFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
  await rename(tempPath, filePath);
}

export function createBindingsStore(options: { filePath?: string } = {}) {
  const dataDir = process.env.DASHI_TASKBOARD_PLUGIN_DATA_DIR ?? DEFAULT_DATA_DIR;
  const filePath = options.filePath ?? path.join(dataDir, "bindings.json");

  // Single writer (this plugin subprocess) -> a promise-chain queue around
  // every read and write is enough to avoid interleaved read-modify-write.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function mutate(mutator: (byTaskId: Record<string, Binding>) => Record<string, Binding>): Promise<void> {
    const current = await readStore(filePath);
    await writeStore(filePath, { byTaskId: mutator({ ...current.byTaskId }) });
  }

  return {
    get(taskId: string): Promise<Binding | null> {
      return enqueue(async () => (await readStore(filePath)).byTaskId[taskId] ?? null);
    },

    list(): Promise<Binding[]> {
      return enqueue(async () => Object.values((await readStore(filePath)).byTaskId));
    },

    findByAgentId(agentId: string): Promise<Binding | null> {
      return enqueue(async () => {
        const { byTaskId } = await readStore(filePath);
        return Object.values(byTaskId).find((binding) => binding.agentId === agentId) ?? null;
      });
    },

    /** 任务换项目时只同步归属，不改变 Agent、轮次或派发所有权。 */
    setProjectId(taskId: string, projectId: string): Promise<Binding | null> {
      return enqueue(async () => {
        let updated: Binding | null = null;
        await mutate((byTaskId) => {
          const existing = byTaskId[taskId];
          if (!existing) return byTaskId;
          if (existing.projectId === projectId) {
            updated = existing;
            return byTaskId;
          }
          updated = { ...existing, projectId, updatedAt: new Date().toISOString() };
          return { ...byTaskId, [taskId]: updated };
        });
        return updated;
      });
    },

    upsert(input: {
      taskId: string;
      taskIdentifier: string;
      projectId: string;
      workspaceId: string;
      agentId: string;
      provider: string;
      agentTitle?: string | null;
      agentModel?: string | null;
      /** 已有会话不可被静默从另一任务抢走。 */
      rejectIfBoundElsewhere?: boolean;
    }): Promise<Binding> {
      return enqueue(async () => {
        const now = new Date().toISOString();
        const { rejectIfBoundElsewhere = false, ...bindingInput } = input;
        let saved!: Binding;
        await mutate((byTaskId) => {
          const next = { ...byTaskId };
          // An agent belongs to at most one task binding. If this agent was
          // bound to a *different* task, atomically drop that stale entry
          // first — otherwise findByAgentId could return either one.
          for (const [otherTaskId, otherBinding] of Object.entries(next)) {
            if (otherTaskId !== input.taskId && otherBinding.agentId === input.agentId) {
              if (rejectIfBoundElsewhere) {
                throw new Error(`该 Paseo 会话已绑定到任务 ${otherBinding.taskIdentifier}，不能抢占。`);
              }
              delete next[otherTaskId];
            }
          }
          const existing = next[input.taskId];
          // Only carry the previous outcome/pending state forward when this
          // is really the same agent being re-upserted; a new agent on the
          // same task starts with a clean history.
          const sameAgent = existing?.agentId === input.agentId;
          saved = {
            ...bindingInput,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            agentTitle: bindingInput.agentTitle ?? (sameAgent ? existing?.agentTitle ?? null : null),
            agentModel: bindingInput.agentModel ?? (sameAgent ? existing?.agentModel ?? null : null),
            lastOutcome: sameAgent ? (existing?.lastOutcome ?? null) : null,
            pendingWriteback: sameAgent ? (existing?.pendingWriteback ?? null) : null,
            dispatchArmed: false,
            acceptedTurnId: null,
            turnGeneration: sameAgent ? (existing?.turnGeneration ?? 0) : 0,
          };
          next[input.taskId] = saved;
          return next;
        });
        return saved;
      });
    },

    /**
     * Records a write-back that actually landed in dashi. `agentId` must
     * match the binding's current agent: a turn event for an agent that has
     * since been replaced on this task (unbind + rebind, or a new agent
     * upserted over it) is stale and must not overwrite the newer binding's
     * history. Clears any pending (failed) write-back.
     */
    recordOutcome(taskId: string, agentId: string, outcome: AgentOutcome, generation?: number | null): Promise<Binding | null> {
      return enqueue(async () => {
        let updated: Binding | null = null;
        await mutate((byTaskId) => {
          const existing = byTaskId[taskId];
          if (!existing || existing.agentId !== agentId || (generation != null && existing.turnGeneration !== generation)) return byTaskId;
          updated = { ...existing, lastOutcome: outcome, pendingWriteback: null, updatedAt: outcome.at };
          return { ...byTaskId, [taskId]: updated };
        });
        return updated;
      });
    },

    /**
     * Records that a write-back attempt failed, without touching
     * `lastOutcome` (which only ever reflects a write-back that succeeded).
     * Same `agentId` guard as `recordOutcome`, for the same reason.
     */
    recordWritebackError(taskId: string, agentId: string, pending: PendingWritebackInput): Promise<Binding | null> {
      return enqueue(async () => {
        let updated: Binding | null = null;
        await mutate((byTaskId) => {
          const existing = byTaskId[taskId];
          if (!existing || existing.agentId !== agentId) return byTaskId;
          if (pending.generation != null && existing.turnGeneration !== pending.generation) return byTaskId;
          updated = {
            ...existing,
            pendingWriteback: {
              ...pending,
              turnId: pending.turnId ?? null,
              generation: pending.generation ?? null,
            },
            updatedAt: new Date().toISOString(),
          };
          return { ...byTaskId, [taskId]: updated };
        });
        return updated;
      });
    },

    /** 在任务板显式 send 前武装下一轮；不武装的直接 Paseo 对话不会改 Taskboard。 */
    armDispatch(taskId: string, agentId: string): Promise<Binding | null> {
      return enqueue(async () => {
        let updated: Binding | null = null;
        await mutate((byTaskId) => {
          const existing = byTaskId[taskId];
          if (!existing || existing.agentId !== agentId || existing.acceptedTurnId !== null || existing.dispatchArmed) {
            return byTaskId;
          }
          updated = { ...existing, dispatchArmed: true, updatedAt: new Date().toISOString() };
          return { ...byTaskId, [taskId]: updated };
        });
        return updated;
      });
    },

    /** send 失败且 lifecycle 尚未接管时撤销武装，避免任务永久显示为待启动。 */
    cancelDispatchArm(taskId: string, agentId: string): Promise<Binding | null> {
      return enqueue(async () => {
        let updated: Binding | null = null;
        await mutate((byTaskId) => {
          const existing = byTaskId[taskId];
          if (!existing || existing.agentId !== agentId || !existing.dispatchArmed || existing.acceptedTurnId !== null) {
            return byTaskId;
          }
          updated = { ...existing, dispatchArmed: false, updatedAt: new Date().toISOString() };
          return { ...byTaskId, [taskId]: updated };
        });
        return updated;
      });
    },

    /**
     * 接受显式任务板派发，或正在 processing 且未有已接管轮次的原生续聊。
     * 原生续聊必须用 activeTurnId 复核；任务板显式派发已经在 send 前持久武装，
     * 因此直接采用 lifecycle 的真实 turnId，避免快 turn 在 refresh 前结束而无法接管。
     */
    acceptStartedTurn(
      taskId: string,
      agentId: string,
      turnId: string | null,
      activeTurnId: string | null,
      allowProcessingContinuation: boolean,
    ): Promise<Binding | null> {
      return enqueue(async () => {
        let updated: Binding | null = null;
        await mutate((byTaskId) => {
          const existing = byTaskId[taskId];
          const explicitDispatch = existing?.dispatchArmed === true;
          const nativeContinuation = allowProcessingContinuation
            && existing?.dispatchArmed === false
            && existing?.acceptedTurnId === null;
          if (
            !existing
            || existing.agentId !== agentId
            || !turnId
            || (!explicitDispatch && (!nativeContinuation || activeTurnId !== turnId))
          ) return byTaskId;
          updated = {
            ...existing,
            dispatchArmed: false,
            acceptedTurnId: turnId,
            turnGeneration: (existing.turnGeneration ?? 0) + 1,
            updatedAt: new Date().toISOString(),
          };
          return { ...byTaskId, [taskId]: updated };
        });
        return updated;
      });
    },

    /** 只检查 ended 是否属于当前已接受轮次，不提前消费可重试资格。 */
    matchesEndedTurn(taskId: string, agentId: string, turnId: string | null): Promise<number | null> {
      return enqueue(async () => {
        const existing = (await readStore(filePath)).byTaskId[taskId];
        if (!existing || existing.agentId !== agentId || !turnId || existing.acceptedTurnId !== turnId) return null;
        return existing.turnGeneration;
      });
    },

    /** 检查写回仍属于当前 generation，并精确约束应处于的 accepted turn。 */
    isTurnGenerationCurrent(
      taskId: string,
      agentId: string,
      generation: number,
      acceptedTurnId: string | null,
    ): Promise<boolean> {
      return enqueue(async () => {
        const existing = (await readStore(filePath)).byTaskId[taskId];
        return Boolean(
          existing
          && existing.agentId === agentId
          && existing.turnGeneration === generation
          && existing.acceptedTurnId === acceptedTurnId,
        );
      });
    },

    /** 只允许与 acceptedTurnId 精确相同的 ended 事件写回，并立即消费资格。 */
    consumeEndedTurn(taskId: string, agentId: string, turnId: string | null): Promise<Binding | null> {
      return enqueue(async () => {
        let updated: Binding | null = null;
        await mutate((byTaskId) => {
          const existing = byTaskId[taskId];
          if (!existing || existing.agentId !== agentId || !turnId || existing.acceptedTurnId !== turnId) return byTaskId;
          updated = { ...existing, acceptedTurnId: null, updatedAt: new Date().toISOString() };
          return { ...byTaskId, [taskId]: updated };
        });
        return updated;
      });
    },

    /**
     * SDK 已确认 Agent 无 active turn 时，精确退休 reload 前遗留的 accepted turn。
     * CAS 要求旧 turnId 仍完全一致；迟到 ended 不会被归到下一轮。
     */
    retireInactiveAcceptedTurn(taskId: string, agentId: string, turnId: string): Promise<Binding | null> {
      return enqueue(async () => {
        let updated: Binding | null = null;
        await mutate((byTaskId) => {
          const existing = byTaskId[taskId];
          if (!existing || existing.agentId !== agentId || existing.acceptedTurnId !== turnId || existing.dispatchArmed) {
            return byTaskId;
          }
          updated = { ...existing, acceptedTurnId: null, updatedAt: new Date().toISOString() };
          return { ...byTaskId, [taskId]: updated };
        });
        return updated;
      });
    },

    /** nullable turn 无法安全归属，只释放尚未接受的 armed，不触碰已识别的真实 turn。 */
    releaseUnidentifiedTurn(taskId: string, agentId: string): Promise<Binding | null> {
      return enqueue(async () => {
        let updated: Binding | null = null;
        await mutate((byTaskId) => {
          const existing = byTaskId[taskId];
          if (!existing || existing.agentId !== agentId || !existing.dispatchArmed || existing.acceptedTurnId !== null) {
            return byTaskId;
          }
          updated = {
            ...existing,
            dispatchArmed: false,
            updatedAt: new Date().toISOString(),
          };
          return { ...byTaskId, [taskId]: updated };
        });
        return updated;
      });
    },

    remove(taskId: string): Promise<void> {
      return enqueue(async () => {
        await mutate((byTaskId) => {
          const next = { ...byTaskId };
          delete next[taskId];
          return next;
        });
      });
    },
  };
}

export type BindingsStore = ReturnType<typeof createBindingsStore>;
