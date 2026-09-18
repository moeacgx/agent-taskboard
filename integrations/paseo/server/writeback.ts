import type { AgentOutcome, TaskStatus } from "../shared/contracts";
import type { BindingsStore } from "./bindings";
import * as dashi from "./dashi-api.ts";

/**
 * Moves a task to `status` unless it is already there or sitting in a
 * terminal/human-owned state (`done`, `canceled`) that a background hook
 * should not disturb.
 */
async function moveIfAllowed(baseUrl: string, taskId: string, status: TaskStatus): Promise<void> {
  const { task } = await dashi.getTask(baseUrl, taskId);
  if (task.status === "done" || task.status === "canceled" || task.status === status) return;
  await dashi.moveTask(baseUrl, taskId, { version: task.version, status }, dashi.PLUGIN_AGENT_ACTOR);
}

/**
 * Attempts (or resumes) writing an agent turn's result back to dashi: post
 * the comment — unless `alreadyPosted` says an earlier attempt already did
 * — then move the status. Used both for the first attempt from the
 * `agent.turn_ended` hook and for the `dashi.retry-writeback` RPC, so both
 * paths share the same "don't repost a comment that already landed" logic.
 *
 * On success, records the outcome and clears any pending state. On failure,
 * records exactly how far it got (in particular, whether the comment half
 * already succeeded) so a retry resumes instead of duplicating work.
 */
export async function performWriteback(
  baseUrl: string,
  bindings: BindingsStore,
  taskId: string,
  agentId: string,
  outcome: AgentOutcome,
  commentBody: string,
  status: TaskStatus | null,
  alreadyPosted: boolean,
  turnId: string | null = null,
  generation: number | null = null,
  expectedAcceptedTurnId: string | null = null,
): Promise<void> {
  let commentPosted = alreadyPosted;
  const stillCurrent = async (): Promise<boolean> => (
    generation === null
      ? true
      : bindings.isTurnGenerationCurrent(taskId, agentId, generation, expectedAcceptedTurnId)
  );
  try {
    if (!await stillCurrent()) return;
    if (!commentPosted) {
      await dashi.addComment(baseUrl, taskId, commentBody, dashi.PLUGIN_AGENT_ACTOR);
      commentPosted = true;
    }
    if (!await stillCurrent()) return;
    if (status !== null) await moveIfAllowed(baseUrl, taskId, status);
    if (!await stillCurrent()) return;
    await bindings.recordOutcome(taskId, agentId, outcome, generation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[dashi-taskboard] write-back failed; kept as a retryable pending state", message);
    await bindings.recordWritebackError(taskId, agentId, {
      outcome,
      commentBody,
      status,
      error: message,
      commentPosted,
      turnId,
      generation,
    });
  }
}
