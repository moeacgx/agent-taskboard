import type { PluginServerContext } from "@getpaseo/plugin/server";

import type { AgentOutcome, TaskStatus } from "../shared/contracts.ts";
import { compactAgentComment } from "../shared/agent-comment.ts";
import { latestAssistantText } from "../shared/timeline-text.ts";
import type { BindingsStore } from "./bindings.ts";
import * as dashi from "./dashi-api.ts";
import type { TaskMutationLock } from "./dispatch.ts";
import { performWriteback } from "./writeback.ts";

/** 已完成、已取消或归档任务不得被迟到的 Agent 事件重新写回。 */
async function taskAcceptsLifecycleWriteback(baseUrl: string, taskId: string): Promise<boolean> {
  const { task } = await dashi.getTask(baseUrl, taskId);
  return task.status !== "done" && task.status !== "canceled" && task.archivedAt === null;
}

/** Moves a task to `status` unless already there or it rejects lifecycle write-back. */
async function moveIfAllowed(baseUrl: string, taskId: string, status: TaskStatus): Promise<void> {
  const { task } = await dashi.getTask(baseUrl, taskId);
  if (task.status === "done" || task.status === "canceled" || task.archivedAt !== null || task.status === status) return;
  await dashi.moveTask(baseUrl, taskId, { version: task.version, status }, dashi.PLUGIN_AGENT_ACTOR);
}

/**
 * Guaranteed write-back path: whenever a Paseo agent's turn ends, if that
 * agent is bound to a dashi task, record the outcome as a comment and move
 * the task's status. This runs regardless of whether the agent itself knows
 * the task system exists, so a binding never silently loses its result.
 *
 * The comment text deliberately never *asserts* a resulting status ("已置为
 * in_review") — the status move is a separate step that can fail
 * independently (version conflict, task already done/canceled, dashi
 * unreachable), and a comment claiming a status that was never actually
 * reached would be a false record. It only describes what the agent did;
 * the reader checks the task's actual current status themselves.
 *
 * `lastOutcome` is only ever set AFTER the write-back actually lands in
 * dashi (see `./writeback.ts`) — the agent finishing successfully and the
 * write-back succeeding are different facts. A failed attempt is kept as
 * `pendingWriteback` (visible in the UI, retryable via `dashi.retry-writeback`,
 * and resumable without reposting a comment that already went through)
 * instead of being logged and lost.
 *
 * Status policy (never automatic "done" — see DESIGN.md):
 *   turn started -> move to "in_progress" (visible on the board while it runs)
 *   completed    -> comment + move to "in_review" (pending human acceptance)
 *   failed       -> comment + move to "blocked"
 *   canceled     -> comment only, task status untouched
 */
export function registerLifecycle(
  server: PluginServerContext,
  bindings: BindingsStore,
  onPaseo?: (paseo: import("@getpaseo/client").PaseoApi) => void,
  mutationLock?: TaskMutationLock,
): void {
  const baseUrl = dashi.resolveBaseUrl();
  const withTaskMutation = <T>(taskId: string, operation: () => Promise<T>): Promise<T> => (
    mutationLock ? mutationLock.run(taskId, operation) : operation()
  );

  server.on("agent.turn_started", async (event, { paseo }) => {
    onPaseo?.(paseo);
    const binding = await bindings.findByAgentId(event.agent.id);
    if (!binding) return;
    // 旧 provider 可以合法省略 turnId；没有真实 ID 时不写回，也不伪造。
    // 立即释放 armed，运行期间仍由真实 Agent busy 状态阻止重复派发。
    if (!event.turnId) {
      await bindings.releaseUnidentifiedTurn(binding.taskId, event.agent.id);
      return;
    }
    const acceptStarted = async (currentBinding: typeof binding): Promise<void> => {
      const accepted = await bindings.acceptStartedTurn(
        currentBinding.taskId,
        event.agent.id,
        event.turnId,
        null,
        false,
      );
      if (!accepted) return;
      try {
        await moveIfAllowed(baseUrl, currentBinding.taskId, "in_progress");
      } catch (error) {
        // 轮次身份已持久接管；ended 时会把瞬时 Dashi 故障保存为 pendingWriteback。
        console.error("[dashi-taskboard] failed to move task to in_progress on turn start", error);
      }
    };

    // 显式任务板派发已在 send 前 armed；这里不能等待 task FIFO，避免
    // 宿主 send 等待 lifecycle 回调而形成环。原生续聊则排队，确保旧
    // ended 写回/idle stale 恢复期间不会把新 started 静默丢掉。
    if (binding.dispatchArmed) {
      await acceptStarted(binding);
      return;
    }

    await withTaskMutation(binding.taskId, async () => {
      const currentBinding = await bindings.get(binding.taskId);
      if (!currentBinding) return;
      if (currentBinding.dispatchArmed) {
        await acceptStarted(currentBinding);
        return;
      }
    try {
      const { task } = await dashi.getTask(baseUrl, binding.taskId);
      if (task.status === "done" || task.status === "canceled" || task.archivedAt !== null) return;
      const agent = paseo.agents.ref(event.agent.id);
      await agent.refresh();
      const accepted = await bindings.acceptStartedTurn(
        currentBinding.taskId,
        event.agent.id,
        event.turnId,
        agent.activeTurn?.turnId ?? null,
        task.status === "in_progress" || task.status === "in_review",
      );
      if (!accepted) return;
      await moveIfAllowed(baseUrl, currentBinding.taskId, "in_progress");
    } catch (error) {
      console.error("[dashi-taskboard] failed to move task to in_progress on turn start", error);
    }
    });
  });

  server.on("agent.turn_ended", async (event, { paseo }) => {
    onPaseo?.(paseo);
    const binding = await bindings.findByAgentId(event.agent.id);
    if (!binding) return;
    if (!event.turnId) {
      await bindings.releaseUnidentifiedTurn(binding.taskId, event.agent.id);
      return;
    }
    await withTaskMutation(binding.taskId, async () => {
    const generation = await bindings.matchesEndedTurn(binding.taskId, event.agent.id, event.turnId);
    if (generation === null) return;

    const at = new Date().toISOString();
    let outcome: AgentOutcome;
    let commentBody: string;
    let nextStatus: TaskStatus | null;

    const summary = latestAssistantText(event.timeline);

    if (event.outcome.kind === "completed") {
      outcome = { kind: "completed", at, message: null };
      commentBody = compactAgentComment("completed", summary);
      nextStatus = "in_review";
    } else if (event.outcome.kind === "failed") {
      outcome = { kind: "failed", at, message: event.outcome.error.message };
      commentBody = compactAgentComment("failed", summary, event.outcome.error.message, event.outcome.error.code);
      nextStatus = "blocked";
    } else {
      outcome = { kind: "canceled", at, message: event.outcome.reason };
      commentBody = compactAgentComment("canceled", summary, event.outcome.reason);
      nextStatus = null;
    }

    try {
      if (!await taskAcceptsLifecycleWriteback(baseUrl, binding.taskId)) {
        await bindings.consumeEndedTurn(binding.taskId, event.agent.id, event.turnId);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
        const pending = await bindings.recordWritebackError(binding.taskId, event.agent.id, {
          outcome,
          commentBody,
          status: nextStatus,
          error: message,
          commentPosted: false,
          turnId: event.turnId,
          generation,
        });
      if (pending) await bindings.consumeEndedTurn(binding.taskId, event.agent.id, event.turnId);
      console.error("[dashi-taskboard] failed to confirm task lifecycle eligibility; write-back kept pending", error);
      return;
    }

    // 写回期间保留 acceptedTurnId，防止 Paseo 原生 started 插入旧轮次中间；
    // 手动/自动派发则由同一个 task FIFO 串行。
    await performWriteback(
      baseUrl,
      bindings,
      binding.taskId,
      event.agent.id,
      outcome,
      commentBody,
      nextStatus,
      false,
      event.turnId,
      generation,
      event.turnId,
    );
    await bindings.consumeEndedTurn(binding.taskId, event.agent.id, event.turnId);
    });
  });
}
