import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import type { PaseoWorkspace } from "@getpaseo/client";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

/**
 * How often the detail view re-polls while a task has a bound agent. Kept
 * short enough to feel live, long enough not to hammer the daemon or dashi.
 * `useAgent`/`useWorkspace` (host-subscribed, no polling) are NOT used here:
 * on the installed 0.8.0 host they throw "Plugin state hooks must run inside
 * a workspace panel" from a plain sidebar surface — confirmed by a real
 * reload against the live app, not just the type declarations.
 */
const AGENT_POLL_INTERVAL_MS = 4000;

import * as contracts from "../shared/contracts";
import type { Binding, Task, TaskStatus } from "../shared/contracts";
import { useRpcQuery } from "./hooks";
import type { PluginLayout, PluginNavigation } from "./types";

interface ModelOption {
  id: string;
  label: string;
}

function describeState(
  theme: PluginTheme,
  liveStatus: string | null,
  lastOutcome: Binding["lastOutcome"],
  taskStatus: TaskStatus,
): { label: string; color: string } {
  if (liveStatus === "running") return { label: "运行中…", color: theme.colors.statusWarning };
  if (taskStatus === "done") return { label: "已完成", color: theme.colors.statusSuccess };
  if (taskStatus === "canceled") return { label: "已取消", color: theme.colors.foregroundMuted };
  if (lastOutcome?.kind === "completed") return { label: "已完成一轮，待验收", color: theme.colors.statusSuccess };
  if (lastOutcome?.kind === "failed") {
    return { label: `失败：${lastOutcome.message ?? "未知错误"}`, color: theme.colors.statusDanger };
  }
  if (lastOutcome?.kind === "canceled") {
    return { label: `已取消：${lastOutcome.message ?? ""}`, color: theme.colors.foregroundMuted };
  }
  if (liveStatus === "error") return { label: "Agent 出错，请刷新状态查看详情", color: theme.colors.statusDanger };
  return { label: "尚未运行", color: theme.colors.foregroundMuted };
}

export function AgentPanel(props: {
  theme: PluginTheme;
  layout: PluginLayout;
  navigation: PluginNavigation;
  task: Task;
  binding: Binding | null;
  /** Refetch the task, its comments, and the binding — call after anything that may have changed them. */
  onNeedsRefresh: () => void;
}) {
  const { theme, layout, navigation, task, binding, onNeedsRefresh } = props;
  const paseo = usePaseo();
  const listProjects = useRpc(contracts.listProjects);
  const projectsQuery = useRpcQuery(listProjects, {});
  const bindAgentRpc = useRpc(contracts.bindAgent);
  const continueTaskAgentRpc = useRpc(contracts.continueTaskAgent);
  const unbindAgentRpc = useRpc(contracts.unbindAgent);
  const retryWritebackRpc = useRpc(contracts.retryWriteback);

  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedModeId, setSelectedModeId] = useState<string | undefined>(undefined);
  const [selectedThinkingOptionId, setSelectedThinkingOptionId] = useState<string | undefined>(undefined);
  const [selectedFeatureValues, setSelectedFeatureValues] = useState<Record<string, unknown> | undefined>(undefined);
  const [existingWorkspaces, setExistingWorkspaces] = useState<PaseoWorkspace[]>([]);
  const [manualCwd, setManualCwd] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [liveStatus, setLiveStatus] = useState<string | null>(null);

  function resolveCwd(): string | null {
    if (manualCwd) return manualCwd;
    if (task.developmentContext?.type === "worktree") return task.developmentContext.path;
    const project = projectsQuery.data?.projects.find((entry) => entry.id === task.projectId);
    return project?.workspacePath ?? null;
  }
  const cwd = resolveCwd();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await paseo.providers.listAvailable();
        if (cancelled) return;
        const list = result.providers.filter((entry) => entry.available).map((entry) => entry.provider);
        setAvailableProviders(list);
        setSelectedProvider((current) => current ?? list[0] ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      try {
        const { config } = await paseo.config.get();
        if (!cancelled) setProfiles(config.agentProfiles ?? []);
      } catch {
        // profile shortcuts are a best-effort enhancement; manual selection still works
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedProvider) {
      setModels([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await paseo.providers.listModels(selectedProvider);
        if (cancelled) return;
        const list = (result.models ?? []).map((model) => ({ id: model.id, label: model.label }));
        setModels(list);
        setSelectedModel((current) => (current && list.some((m) => m.id === current) ? current : (list[0]?.id ?? null)));
      } catch {
        if (!cancelled) setModels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider]);

  useEffect(() => {
    if (binding || cwd) return; // only needed for the "no workspace resolved" fallback picker
    let cancelled = false;
    (async () => {
      try {
        const result = await paseo.workspaces.list();
        if (!cancelled) setExistingWorkspaces(result.entries);
      } catch {
        // leave the list empty; the user can still be told nothing is available
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding, cwd]);

  // The dashi-side write-back (comment + status move) happens on the daemon
  // as soon as the turn ends, independent of whether this panel is open. An
  // already-open panel only learns about it by asking again, so poll the
  // agent's live status and the task/comments/binding together while a
  // binding exists. Stops the moment the binding is removed or the panel
  // unmounts; does not touch `followUp` or any other input state.
  useEffect(() => {
    if (!binding) {
      setLiveStatus(null);
      return;
    }
    let cancelled = false;
    const agentId = binding.agentId;

    async function poll() {
      try {
        const ref = paseo.agents.ref(agentId);
        await ref.refresh();
        if (!cancelled) setLiveStatus(ref.status);
      } catch {
        // agent may be archived or unreachable; keep the last known status
      }
      if (!cancelled) onNeedsRefresh();
    }

    void poll();
    const timer = setInterval(() => void poll(), AGENT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding?.agentId]);

  const styles = useMemo(
    () => ({
      section: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        gap: 10,
      },
      sectionTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      chip: (active: boolean) => ({
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 999,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
      }),
      chipText: (active: boolean) => ({
        color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted,
        fontSize: 12,
        fontWeight: "600" as const,
      }),
      button: {
        alignSelf: "flex-start" as const,
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
        opacity: busy ? 0.6 : 1,
      },
      secondaryButton: {
        alignSelf: "flex-start" as const,
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      buttonText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
      secondaryButtonText: { color: theme.colors.foreground, fontWeight: "600" as const },
      errorText: { color: theme.colors.statusDanger, fontSize: 12 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        minHeight: 40,
      },
      statusDot: (color: string) => ({ width: 8, height: 8, borderRadius: 4, backgroundColor: color }),
      statusRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    }),
    [theme, busy],
  );

  function applyProfile(profile: AgentProfile) {
    setSelectedProvider(profile.provider);
    setSelectedModel(profile.model ?? null);
    setSelectedModeId(profile.modeId);
    setSelectedThinkingOptionId(profile.thinkingOptionId);
    setSelectedFeatureValues(profile.featureValues);
  }

  async function handleCreateAndBind() {
    if (!selectedProvider) {
      setError("请先选择 provider");
      return;
    }
    if (!cwd) {
      setError("请先选择一个工作区。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const workspace = await paseo.workspaces.open(cwd);
      const providerModel = selectedModel ? `${selectedProvider}/${selectedModel}` : selectedProvider;
      // Create without a prompt, persist the binding, THEN send the first
      // message — otherwise a fast first turn could end (and fire
      // agent.turn_ended) before the binding exists to receive the write-back.
      const agent = await workspace.agents.create({
        config: {
          provider: providerModel,
          modeId: selectedModeId,
          thinkingOptionId: selectedThinkingOptionId,
          featureValues: selectedFeatureValues,
        },
        title: `${task.identifier}: ${task.title}`,
      });
      await bindAgentRpc({
        taskId: task.id,
        taskIdentifier: task.identifier,
        projectId: task.projectId,
        workspaceId: workspace.id,
        agentId: agent.id,
        provider: providerModel,
      });
      // 服务端在移动、武装和发送之前读取最新项目文档与人工评论并构造首轮提示词。
      await continueTaskAgentRpc({ taskId: task.id });
      onNeedsRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSendFollowUp() {
    if (!binding || !followUp.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await continueTaskAgentRpc({ taskId: task.id, message: followUp.trim() });
      setFollowUp("");
      // The daemon's agent.turn_started hook moves the task to in_progress;
      // refresh now so that shows up without waiting for the turn to end.
      onNeedsRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnbind() {
    setBusy(true);
    setError(null);
    try {
      await unbindAgentRpc({ taskId: task.id });
      onNeedsRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRetryWriteback() {
    setBusy(true);
    setError(null);
    try {
      await retryWritebackRpc({ taskId: task.id });
      onNeedsRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!binding) {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>执行 Agent</Text>
        {error && <Text style={styles.errorText}>{error}</Text>}

        {!cwd && (
          <View>
            <Text style={styles.label}>
              该任务所属项目没有配置工作区路径，且任务未绑定 worktree。请选择一个已有的 Paseo 工作区来关联：
            </Text>
            <View style={styles.row}>
              {existingWorkspaces.map((workspace) => (
                <Pressable
                  key={workspace.id}
                  style={styles.chip(manualCwd === workspace.workspaceDirectory)}
                  onPress={() => setManualCwd(workspace.workspaceDirectory ?? null)}
                >
                  <Text style={styles.chipText(manualCwd === workspace.workspaceDirectory)}>
                    {workspace.name}
                    {workspace.workspaceDirectory ? ` (${workspace.workspaceDirectory})` : ""}
                  </Text>
                </Pressable>
              ))}
              {existingWorkspaces.length === 0 && (
                <Text style={styles.label}>没有找到可用的工作区，请先在 Paseo 中打开一个工作区。</Text>
              )}
            </View>
          </View>
        )}

        {profiles.length > 0 && (
          <View>
            <Text style={styles.label}>Profile（可选，优先使用）</Text>
            <View style={styles.row}>
              {profiles.map((profile) => (
                <Pressable
                  key={profile.id}
                  style={styles.chip(selectedProvider === profile.provider && selectedModel === (profile.model ?? null))}
                  onPress={() => applyProfile(profile)}
                >
                  <Text style={styles.chipText(false)}>{profile.name}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        <View>
          <Text style={styles.label}>Provider</Text>
          <View style={styles.row}>
            {availableProviders.map((provider) => (
              <Pressable key={provider} style={styles.chip(selectedProvider === provider)} onPress={() => setSelectedProvider(provider)}>
                <Text style={styles.chipText(selectedProvider === provider)}>{provider}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {models.length > 0 && (
          <View>
            <Text style={styles.label}>Model</Text>
            <View style={styles.row}>
              {models.map((model) => (
                <Pressable key={model.id} style={styles.chip(selectedModel === model.id)} onPress={() => setSelectedModel(model.id)}>
                  <Text style={styles.chipText(selectedModel === model.id)}>{model.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        <Pressable accessibilityRole="button" style={styles.button} onPress={handleCreateAndBind} disabled={busy || !cwd}>
          <Text style={styles.buttonText}>{busy ? "创建中…" : "创建并绑定 Agent"}</Text>
        </Pressable>
      </View>
    );
  }

  const state = describeState(theme, liveStatus, binding.lastOutcome, task.status);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>执行 Agent</Text>
      {error && <Text style={styles.errorText}>{error}</Text>}
      <View style={styles.statusRow}>
        <View style={styles.statusDot(state.color)} />
        <Text style={styles.label}>{state.label}</Text>
      </View>
      <Text style={styles.label}>Provider: {binding.provider}</Text>
      <Text style={styles.label}>Workspace: {binding.workspaceId}</Text>

      {binding.pendingWriteback && (
        <View>
          <Text style={styles.errorText}>
            ⚠️ 上一次结果回写到任务看板失败：{binding.pendingWriteback.error}
          </Text>
          <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={handleRetryWriteback} disabled={busy}>
            <Text style={styles.secondaryButtonText}>重试写回</Text>
          </Pressable>
        </View>
      )}

      <TextInput
        style={styles.input}
        placeholder="继续对话（发送给该 Agent）…"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={followUp}
        onChangeText={setFollowUp}
        multiline
      />
      <View style={styles.row}>
        <Pressable accessibilityRole="button" style={styles.button} onPress={handleSendFollowUp} disabled={busy}>
          <Text style={styles.buttonText}>继续会话</Text>
        </Pressable>
        {navigation?.openAgent && (
          <Pressable
            accessibilityRole="button"
            style={styles.secondaryButton}
            onPress={() => navigation.openAgent({ agentId: binding.agentId })}
          >
            <Text style={styles.secondaryButtonText}>在 Paseo 中打开</Text>
          </Pressable>
        )}
        <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={onNeedsRefresh} disabled={busy}>
          <Text style={styles.secondaryButtonText}>刷新状态</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={handleUnbind} disabled={busy}>
          <Text style={styles.secondaryButtonText}>解除绑定</Text>
        </Pressable>
      </View>
    </View>
  );
}
