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
  const continueTaskAgentRpc = useRpc(contracts.continueTaskAgent);
  const unbindAgentRpc = useRpc(contracts.unbindAgent);
  const retryWritebackRpc = useRpc(contracts.retryWriteback);
  const getAutomation = useRpc(contracts.getPaseoAutomation);
  const automationQuery = useRpcQuery(getAutomation, { projectId: task.projectId });
  const getPresentations = useRpc(contracts.getPaseoPresentations);
  const presentationQuery = useRpcQuery(getPresentations, { taskIds: [task.id] });

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
    if (automationQuery.data?.automation.workspacePath) return automationQuery.data.automation.workspacePath;
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
        setSelectedProvider((current) => current ?? automationQuery.data?.automation.profile?.provider ?? null);
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
  }, [automationQuery.data?.automation.profile?.provider]);

  useEffect(() => {
    const saved = automationQuery.data?.automation.profile;
    if (!saved) return;
    setSelectedProvider(saved.provider);
    setSelectedModel(saved.model);
    setSelectedModeId(saved.modeId);
    setSelectedThinkingOptionId(saved.thinkingOptionId);
    setSelectedFeatureValues(saved.featureValues);
  }, [automationQuery.data?.automation.profile]);

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
      if (!cancelled) {
        presentationQuery.refetch();
        onNeedsRefresh();
      }
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
    setBusy(true);
    setError(null);
    try {
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
        <Text style={styles.label}>启动时由服务端读取下方任务执行配置；留空字段继承项目当前默认值。</Text>
        <Pressable accessibilityRole="button" style={styles.button} onPress={handleCreateAndBind} disabled={busy}>
          <Text style={styles.buttonText}>{busy ? "启动中…" : "按任务或项目配置启动"}</Text>
        </Pressable>
      </View>
    );
  }

  const state = describeState(theme, liveStatus, binding.lastOutcome, task.status);
  const presentation = presentationQuery.data?.presentations.find((item) => item.taskId === task.id) ?? null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>执行 Agent</Text>
      {error && <Text style={styles.errorText}>{error}</Text>}
      {presentation?.attentionReason === "permission" && (
        <View style={styles.section}>
          <Text style={styles.errorText}>等待你的授权</Text>
          <Text style={styles.label}>Agent 正在等待 Paseo 权限确认。</Text>
          {navigation?.openAgent && <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={() => navigation.openAgent?.({ agentId: binding.agentId })}><Text style={styles.secondaryButtonText}>打开会话处理权限</Text></Pressable>}
        </View>
      )}
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
