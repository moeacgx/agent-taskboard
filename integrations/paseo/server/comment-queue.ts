import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { Binding, CommentQueueItem, CommentQueueRequest } from "../shared/contracts.ts";
import type { BindingsStore } from "./bindings.ts";
import { buildTaskContinuationPrompt, sendTaskMessage, type TaskMutationLock } from "./dispatch.ts";
import * as dashi from "./dashi-api.ts";
import { performWriteback } from "./writeback.ts";

const unresolved = (item: CommentQueueItem) => item.status !== "completed" && item.status !== "canceled";
const receipt = (item: CommentQueueItem, status: "completed" | "canceled"): CommentQueueItem => ({
  ...item, status, body: "", prompt: "", images: [],
});
const uncertainReason = "发送结果未确认，未自动重发。请打开原 Agent 会话核对，再确认移出此项并恢复后续队列。";
const busy = (agent: ReturnType<PaseoApi["agents"]["ref"]>) => agent.status === "running"
  || agent.activeTurn != null || (agent.pendingPermissions?.length ?? 0) > 0;

/** 只消费显式入队的评论；任务 FIFO 管认领，SDK send 必须在该锁外执行。 */
export function createCommentQueueRuntime(
  bindings: BindingsStore,
  mutationLock: TaskMutationLock,
  options: { baseUrl?: string; intervalMs?: number; sendTimeoutMs?: number } = {},
) {
  const baseUrl = options.baseUrl ?? dashi.resolveBaseUrl();
  let paseo: PaseoApi | null = null;
  let recovery: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const active = new Map<string, Promise<void>>();
  const confirmationTimers = new Set<ReturnType<typeof setTimeout>>();

  function attach(api: PaseoApi): void {
    paseo = api;
    recovery ??= (async () => {
      // reload 无法证明未收到回复的 send 是否已生效，绝不重发 sending。
      for (const binding of await bindings.list()) {
        if (!binding.commentQueue.some((item) => item.status === "sending")) continue;
        await mutationLock.run(binding.taskId, () => bindings.mutateCommentQueue(binding.taskId, binding.agentId, (current) => current.commentQueue.some((item) => item.status === "sending") ? ({
          ...current,
          commentQueue: current.commentQueue.map((item) => item.status === "sending" ? { ...item, status: "uncertain" } : item),
          commentQueuePauseReason: uncertainReason,
        }) : current));
      }
    })();
    if (!timer && !stopped) {
      timer = setInterval(() => { void tick().catch((error) => console.error("[dashi-taskboard] 评论队列恢复失败", error)); }, options.intervalMs ?? 2_000);
      timer.unref();
    }
  }

  async function pause(taskId: string, agentId: string, reason: string): Promise<void> {
    await bindings.mutateCommentQueue(taskId, agentId, (current) => ({ ...current, commentQueuePauseReason: reason }));
  }

  async function rememberNativeTurn(binding: Binding, agent: ReturnType<PaseoApi["agents"]["ref"]>): Promise<void> {
    const turnId = agent.activeTurn?.turnId;
    if (binding.acceptedTurnId !== null || binding.dispatchArmed || binding.commentQueueWait) return;
    if (!turnId) {
      if (agent.status === "running" || agent.activeTurn != null) await pause(binding.taskId, binding.agentId, "Agent 正在运行，但提供方未返回可追踪的轮次 ID。队列已暂停；请在本轮结束后核对结果，确认空闲再手动恢复。");
      return;
    }
    await bindings.mutateCommentQueue(binding.taskId, binding.agentId, (current) => current.acceptedTurnId !== null
      || current.dispatchArmed || current.commentQueueWait ? current : {
        ...current, commentQueueWait: { turnId, generation: current.turnGeneration },
      });
  }

  async function claim(taskId: string) {
    if (!paseo || stopped) return null;
    let binding = await bindings.get(taskId);
    if (!binding || !binding.commentQueue.some((item) => item.status === "queued")) return null;
    const { task } = await dashi.getTask(baseUrl, taskId);
    if (task.archivedAt !== null || task.status === "done" || task.status === "canceled") {
      await bindings.mutateCommentQueue(taskId, binding.agentId, (current) => ({
        ...current,
        commentQueue: current.commentQueue.map((item) => item.status === "queued" ? receipt(item, "canceled") : item),
        commentQueuePauseReason: "任务已完成、取消或归档，旧队列已停止。",
      }));
      return null;
    }
    if (binding.commentQueuePauseReason || binding.pendingWriteback || binding.acceptedTurnId !== null
      || binding.commentQueueWait || binding.dispatchArmed || binding.commentQueue.some((item) => ["sending", "sent", "uncertain"].includes(item.status))) return null;
    const item = binding.commentQueue.find((entry) => entry.status === "queued")!;
    if (item.agentId !== binding.agentId) return null;
    const agent = paseo.agents.ref(item.agentId);
    await agent.refresh();
    if (busy(agent)) { await rememberNativeTurn(binding, agent); return null; }
    if (agent.status !== "idle" || agent.archivedAt) {
      await pause(taskId, item.agentId, "原 Agent 当前不可执行，请检查会话后手动恢复队列。");
      return null;
    }
    const images = await Promise.all(item.images.map(async (image) => ({
      data: (await dashi.getAttachmentContent(baseUrl, image.attachmentId)).toString("base64"),
      mimeType: image.mimeType,
    })));
    // 读取图片期间可能开始原生轮次；发送前再次确认真实状态与持久轮次。
    await agent.refresh();
    binding = await bindings.get(taskId);
    if (!binding || binding.agentId !== item.agentId) return null;
    if (busy(agent)) { await rememberNativeTurn(binding, agent); return null; }
    if (agent.status !== "idle" || agent.archivedAt) return null;
    let claimed = false;
    await bindings.mutateCommentQueue(taskId, item.agentId, (current) => {
      if (current.acceptedTurnId !== null || current.pendingWriteback || current.dispatchArmed || current.commentQueueWait
        || current.commentQueuePauseReason || current.commentQueue.find(unresolved)?.id !== item.id) return current;
      claimed = true;
      return {
        ...current, dispatchArmed: true, updatedAt: new Date().toISOString(),
        commentQueue: current.commentQueue.map((entry) => entry.id === item.id ? { ...entry, status: "sending" } : entry),
      };
    });
    return claimed ? { item, agent, message: { prompt: item.prompt, images } } : null;
  }

  async function markUncertain(item: CommentQueueItem, reason: string): Promise<void> {
    if (stopped) return;
    await mutationLock.run(item.taskId, () => bindings.mutateCommentQueue(item.taskId, item.agentId, (binding) => {
      // 真实 started/ended 已确认的发送不被迟到的 send 错误覆盖。
      if (stopped || !binding.commentQueue.some((entry) => entry.id === item.id && entry.status === "sending")) return binding;
      return {
        ...binding, commentQueuePauseReason: `${uncertainReason} ${reason}`,
        commentQueue: binding.commentQueue.map((entry) => entry.id === item.id ? { ...entry, status: "uncertain" } : entry),
      };
    }));
  }

  function kick(taskId: string): Promise<void> {
    const existing = active.get(taskId);
    if (existing) return existing;
    const operation = (async () => {
      await recovery;
      let claimed: Awaited<ReturnType<typeof claim>>;
      try { claimed = await mutationLock.run(taskId, () => claim(taskId)); }
      catch (error) {
        const binding = await bindings.get(taskId);
        if (binding) await mutationLock.run(taskId, () => pause(taskId, binding.agentId, `队列已暂停：${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (!claimed) return;
      const { item, agent, message } = claimed;
      if (stopped) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // messageId 便于追踪，不假定宿主提供 exactly-once。
        await Promise.race([
          sendTaskMessage(agent, message, item.id),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("等待发送确认超时。")), options.sendTimeoutMs ?? 20_000);
            confirmationTimers.add(timeout);
            timeout.unref();
          }),
        ]);
        // send(void) 不含 turnId；只有 lifecycle started 才能确认本轮归属。
        const binding = await bindings.get(taskId);
        if (binding?.commentQueue.some((entry) => entry.id === item.id && entry.status === "sending") && !stopped) {
          const confirmation = setTimeout(() => {
            confirmationTimers.delete(confirmation);
            if (!stopped) void markUncertain(item, "未收到可关联的轮次事件。").catch(console.error);
          }, options.sendTimeoutMs ?? 20_000);
          confirmationTimers.add(confirmation);
          confirmation.unref();
        }
      } catch (error) {
        await markUncertain(item, error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timeout);
        if (timeout) confirmationTimers.delete(timeout);
      }
    })();
    active.set(taskId, operation);
    void operation.finally(() => { if (active.get(taskId) === operation) active.delete(taskId); }).catch(console.error);
    return operation;
  }

  async function tick(): Promise<void> {
    await recovery;
    if (stopped || !paseo) return;
    await Promise.all((await bindings.list()).filter((binding) => binding.commentQueue.some((item) => item.status === "queued"))
      .map((binding) => kick(binding.taskId)));
  }

  async function state(taskId: string) {
    const binding = await bindings.get(taskId);
    let waitingReason: string | null = null;
    if (binding?.pendingWriteback) waitingReason = "上一轮结果待写回；请重试恢复队列。";
    else if (binding && (binding.commentQueueWait || binding.acceptedTurnId !== null)) waitingReason = "等待当前轮次结束并完成结果写回。";
    else if (binding?.dispatchArmed) waitingReason = "正在等待 Agent 确认本轮发送。";
    if (binding?.commentQueue.some(unresolved) && paseo) {
      const agent = paseo.agents.ref(binding.agentId);
      await agent.refresh();
      if ((agent.pendingPermissions?.length ?? 0) > 0) waitingReason = "Agent 等待权限，队列保留；请在会话中处理授权。";
      else if (busy(agent) && !waitingReason) waitingReason = "等待当前 Agent 轮次结束。";
      else if (agent.status === "idle" && !binding.pendingWriteback && (binding.commentQueueWait || binding.acceptedTurnId !== null)) {
        waitingReason = "原 Agent 已空闲，正在等待结束事件；若 reload 漏收了事件，请核对会话和结果后手动恢复。";
      }
    }
    return { queue: {
      items: (binding?.commentQueue ?? []).filter(unresolved).map(({ prompt: _prompt, images, ...item }) => ({ ...item, imageCount: images.length })),
      pauseReason: binding?.commentQueuePauseReason ?? null, waitingReason,
    } };
  }

  async function request(input: CommentQueueRequest, api: PaseoApi) {
    attach(api);
    await recovery;
    if (input.action === "list") return state(input.taskId);
    await mutationLock.run(input.taskId, async () => {
      const binding = await bindings.get(input.taskId);
      if (!binding) throw new Error("任务未绑定原 Agent，不能操作队列。");
      if (input.action === "cancel") {
        const item = binding.commentQueue.find((entry) => entry.id === input.itemId);
        if (!item || item.status === "canceled") return;
        if (item.status !== "queued") throw new Error("此项已开始发送，不能取消。请打开 Agent 会话核对。");
        await bindings.mutateCommentQueue(input.taskId, binding.agentId, (current) => ({
          ...current, commentQueue: current.commentQueue.map((entry) => entry.id === input.itemId ? receipt(entry, "canceled") : entry),
        }));
        return;
      }
      const { task } = await dashi.getTask(baseUrl, input.taskId);
      if (task.archivedAt !== null || task.status === "done" || task.status === "canceled") throw new Error("任务已完成、取消或归档，不能继续旧队列。");
      const agent = api.agents.ref(binding.agentId);
      await agent.refresh();
      if (input.action === "enqueue") {
        if (binding.agentId !== input.agentId) throw new Error("任务绑定已改变，请刷新后重新选择评论。");
        if (binding.commentQueue.some((item) => item.commentId === input.commentId)) return;
        const { comments } = await dashi.listComments(baseUrl, input.taskId);
        const comment = comments.find((entry) => entry.id === input.commentId);
        if (!comment) throw new Error("指定评论不存在，尚未入队。");
        if (comment.body.includes("<!--taskboard-inline-image:") || comment.body.includes("<!--taskboard-inline-file:")) throw new Error("评论附件尚未保存完成，不能入队。");
        const item: CommentQueueItem = {
          id: randomUUID(), taskId: input.taskId, commentId: comment.id, agentId: binding.agentId,
          body: comment.body, prompt: await buildTaskContinuationPrompt(baseUrl, task, comment.body),
          images: comment.attachments.filter((image) => image.contentType.startsWith("image/")).map((image) => ({ attachmentId: image.id, mimeType: image.contentType })),
          createdAt: new Date().toISOString(), status: "queued", turnId: null,
        };
        await bindings.mutateCommentQueue(input.taskId, binding.agentId, (current) => ({
          ...current, commentQueue: [...current.commentQueue, item],
          commentQueuePauseReason: current.commentQueue.some(unresolved) ? current.commentQueuePauseReason : (!busy(agent) && current.acceptedTurnId === null
            && (current.lastOutcome?.kind === "failed" || current.lastOutcome?.kind === "canceled")
            ? "上一轮失败或被取消，请手动恢复队列。" : null),
        }));
        await rememberNativeTurn(binding, agent);
        return;
      }
      if (busy(agent) || agent.status !== "idle" || agent.archivedAt) throw new Error("原 Agent 正在运行、等待权限或不可用；请先核对会话。");
      if (input.action === "acknowledge") {
        if (!binding.commentQueue.some((item) => item.id === input.itemId && item.status === "uncertain")) throw new Error("只有发送结果不确定的项需要人工确认。");
        if (binding.pendingWriteback) throw new Error("上一轮结果仍待写回，请先重试写回。 ");
        await bindings.mutateCommentQueue(input.taskId, binding.agentId, (current) => ({
          ...current, dispatchArmed: false, acceptedTurnId: null, commentQueueWait: null,
          commentQueue: current.commentQueue.map((item) => item.id === input.itemId ? receipt(item, "completed") : item),
          commentQueuePauseReason: "已移出核对过的项，未重发。请恢复后续队列。",
        }));
        return;
      }
      if (binding.pendingWriteback) {
        const pending = binding.pendingWriteback;
        if (pending.generation !== binding.turnGeneration) throw new Error("待写回属于旧轮次，请先核对任务结果。");
        await performWriteback(baseUrl, bindings, input.taskId, binding.agentId, pending.outcome, pending.commentBody,
          pending.status, pending.commentPosted, pending.turnId, pending.generation, null);
        if ((await bindings.get(input.taskId))?.pendingWriteback) throw new Error("上一轮结果仍未成功写回，队列保持暂停。");
      }
      if (binding.acceptedTurnId !== null || binding.commentQueueWait) {
        // 只有显式恢复且确认真实 idle 才能处理 reload 遗漏的 ended；未发送项保持 queued。
        if (binding.commentQueue.some((item) => item.status === "sent" || item.status === "sending")) {
          await bindings.mutateCommentQueue(input.taskId, binding.agentId, (current) => ({
            ...current,
            commentQueue: current.commentQueue.map((item) => item.status === "sent" || item.status === "sending"
              ? { ...item, status: "uncertain" } : item),
            commentQueuePauseReason: "原轮已空闲但结束事件未收到。请核对已发送内容和结果写回，再确认移出此项；不会自动重发。",
          }));
          return;
        }
        await bindings.mutateCommentQueue(input.taskId, binding.agentId, (current) => ({
          ...current, acceptedTurnId: null, commentQueueWait: null, dispatchArmed: false,
        }));
      }
      if (binding.commentQueue.some((item) => ["sending", "sent", "uncertain"].includes(item.status))) throw new Error(uncertainReason);
      await bindings.mutateCommentQueue(input.taskId, binding.agentId, (current) => ({ ...current, commentQueuePauseReason: null }));
    });
    if (input.action === "enqueue" || input.action === "retry") void kick(input.taskId).catch(console.error);
    return state(input.taskId);
  }

  /** 在 lifecycle 的同任务锁内调用，只接管入队时记录的确切原生轮次。 */
  async function acceptWaitingEnd(taskId: string, agentId: string, turnId: string): Promise<void> {
    await bindings.mutateCommentQueue(taskId, agentId, (binding) => {
      const wait = binding.commentQueueWait;
      if (!wait || wait.turnId !== turnId || wait.generation !== binding.turnGeneration || binding.acceptedTurnId !== null || binding.dispatchArmed) return binding;
      return { ...binding, commentQueueWait: null, acceptedTurnId: turnId, turnGeneration: binding.turnGeneration + 1 };
    });
  }

  /** 已写回并消费旧轮后更新队列；仍处于 lifecycle 的任务锁内。 */
  async function ended(taskId: string, agentId: string, turnId: string, kind: "completed" | "failed" | "canceled"): Promise<void> {
    await bindings.mutateCommentQueue(taskId, agentId, (binding) => {
      if (!binding.commentQueue.some(unresolved)) return binding;
      return {
      ...binding,
      commentQueueWait: binding.commentQueueWait?.turnId === turnId ? null : binding.commentQueueWait,
      commentQueue: binding.commentQueue.map((item) => item.turnId === turnId ? receipt(item, "completed") : item),
      commentQueuePauseReason: binding.pendingWriteback
        ? "上一轮结果待写回，队列已暂停；请重试恢复。"
        : kind !== "completed" ? "上一轮失败或被取消，队列已暂停；请手动恢复。"
        : binding.commentQueue.some((item) => item.status === "uncertain" && item.turnId === turnId)
          ? null : binding.commentQueuePauseReason,
      };
    });
  }

  return { attach, request, tick, kick, acceptWaitingEnd, ended,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      for (const pending of confirmationTimers) clearTimeout(pending);
      confirmationTimers.clear();
    },
  };
}
export type CommentQueueRuntime = ReturnType<typeof createCommentQueueRuntime>;
