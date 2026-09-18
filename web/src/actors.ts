import type { ActorIdentity, AssigneeTarget } from "./types";

export const CODEX_AGENT_ACTOR: ActorIdentity = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

export function actorKey(actor: ActorIdentity): string {
  return `${actor.type}:${actor.id}`;
}

export function actorForAssigneeTarget(
  target: AssigneeTarget,
  currentUser: ActorIdentity,
): ActorIdentity {
  return target === "codex-agent" ? CODEX_AGENT_ACTOR : currentUser;
}

export function assigneeTargetForActor(
  actor: ActorIdentity,
  currentUser: ActorIdentity,
): AssigneeTarget | undefined {
  // Paseo 的真实会话身份仅存在插件绑定中，绝不能映射成 Dashi 内置 Codex Agent。
  if (actor.id === CODEX_AGENT_ACTOR.id) return "codex-agent";
  return actor.id === currentUser.id ? "current-user" : undefined;
}
