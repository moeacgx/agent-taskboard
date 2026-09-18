import type { ActorIdentity } from "../types";
import { isSafeProviderIconUrl } from "../providerIcons";

export function ActorAvatar({
  actor,
  className = "",
}: {
  actor: ActorIdentity;
  className?: string;
}) {
  const agentIcon = actor.type === "agent" && isSafeProviderIconUrl(actor.avatarUrl)
    ? actor.avatarUrl
    : null;
  return (
    <span
      className={`actor-avatar actor-avatar-${actor.type}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      title={actor.name}
    >
      {actor.type === "agent" && actor.id === "codex-agent" ? (
        <img
          className="actor-avatar-image actor-avatar-agent-image"
          src="codex-agent-logo.png"
          alt=""
        />
      ) : actor.type === "agent" && agentIcon ? (
        <img
          className="actor-avatar-image actor-avatar-agent-image"
          src={agentIcon}
          alt=""
        />
      ) : actor.type === "agent" ? (
        actor.name.slice(0, 1)
      ) : actor.avatarUrl ? (
        <img
          className="actor-avatar-image"
          src={actor.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
        />
      ) : actor.name.slice(0, 1)}
    </span>
  );
}
