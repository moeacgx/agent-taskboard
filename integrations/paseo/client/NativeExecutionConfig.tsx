import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import * as contracts from "../shared/contracts";
import type { AgentProfileConfig, PaseoConfigurationOptions, PaseoTaskAssignment, Task } from "../shared/contracts";
import type { PluginLayout } from "./types";
import { useRpcQuery } from "./hooks";

export function NativeExecutionConfig(props: {
  theme: PluginTheme;
  layout: PluginLayout;
  task: Task;
  assignment: PaseoTaskAssignment | null;
  onSaved: () => void;
}) {
  const { theme, layout, task, assignment, onSaved } = props;
  const savePlan = useRpc(contracts.saveTaskExecutionPlan);
  const listOptions = useRpc(contracts.listPaseoAssignmentOptions);
  const getConfigurationOptions = useRpc(contracts.getPaseoConfigurationOptions);
  const catalog = useRpcQuery(listOptions, { projectId: task.projectId });
  const [profile, setProfile] = useState<AgentProfileConfig | null>(assignment?.kind === "planned" ? assignment.profile : null);
  const [workspacePath, setWorkspacePath] = useState(assignment?.kind === "planned" ? assignment.workspacePath ?? "" : "");
  const [options, setOptions] = useState<PaseoConfigurationOptions | null>(null);
  const [modeId, setModeId] = useState(assignment?.kind === "planned" ? assignment.profile?.modeId : undefined);
  const [thinkingOptionId, setThinkingOptionId] = useState(assignment?.kind === "planned" ? assignment.profile?.thinkingOptionId : undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile?.provider || !profile.model) {
      setOptions(null);
      return;
    }
    let cancelled = false;
    void getConfigurationOptions({
      provider: profile.provider,
      model: profile.model,
      workspacePath: workspacePath.trim() || null,
      ...(profile.modeId ? { modeId: profile.modeId } : {}),
      ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
    }).then((result) => {
      if (!cancelled) setOptions(result.options);
    }).catch(() => {
      if (!cancelled) setOptions(null);
    });
    return () => { cancelled = true; };
    // useRpc 返回函数每次渲染可能变化，配置输入已经覆盖真实请求依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.provider, profile?.model, workspacePath]);

  const profiles: AgentProfileConfig[] = [...(catalog.data?.profiles ?? []), ...(catalog.data?.models ?? [])];
  const workspaces = catalog.data?.workspaces ?? [];

  const styles = useMemo(() => ({
    box: { padding: 12, gap: 9, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
    title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    label: { color: theme.colors.foregroundMuted, fontSize: 11 },
    row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: (active: boolean) => ({ paddingVertical: 6, paddingHorizontal: 9, borderRadius: 999, backgroundColor: active ? theme.colors.accent : theme.colors.surface2 }),
    chipText: (active: boolean) => ({ color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const }),
    input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 7, padding: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface0 },
    button: { alignSelf: "flex-start" as const, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: theme.colors.accent },
    buttonText: { color: theme.colors.accentForeground, fontWeight: "700" as const, fontSize: 12 },
    error: { color: theme.colors.statusDanger, fontSize: 12 },
  }), [theme]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const nextProfile = profile
        ? { ...profile, ...(modeId ? { modeId } : {}), ...(thinkingOptionId ? { thinkingOptionId } : {}) }
        : null;
      await savePlan({
        taskId: task.id,
        projectId: task.projectId,
        workspacePath: workspacePath.trim() || null,
        profile: nextProfile,
        replaceWorkspace: true,
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.box} testID="native-execution-config">
      <Text style={styles.title}>执行配置</Text>
      <Text style={styles.label}>Agent Profile（可留空，使用项目默认）</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        <Pressable style={styles.chip(profile === null)} onPress={() => { setProfile(null); setModeId(undefined); setThinkingOptionId(undefined); }}>
          <Text style={styles.chipText(profile === null)}>使用项目默认</Text>
        </Pressable>
        {profiles.map((candidate) => (
          <Pressable key={`${candidate.provider}:${candidate.id}`} style={styles.chip(profile?.id === candidate.id)} onPress={() => { setProfile(candidate); setModeId(candidate.modeId); setThinkingOptionId(candidate.thinkingOptionId); }}>
            <Text style={styles.chipText(profile?.id === candidate.id)}>{candidate.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Text style={styles.label}>代码工作目录（可留空，使用项目默认）</Text>
      <TextInput style={styles.input} value={workspacePath} onChangeText={setWorkspacePath} placeholder="使用项目默认目录" placeholderTextColor={theme.colors.foregroundMuted} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {workspaces.filter((candidate) => candidate.path).map((candidate) => (
          <Pressable key={candidate.id} style={styles.chip(workspacePath === candidate.path)} onPress={() => setWorkspacePath(candidate.path ?? "")}>
            <Text style={styles.chipText(workspacePath === candidate.path)}>{candidate.kind === "project" ? `项目 · ${candidate.name ?? candidate.path}` : candidate.name ?? candidate.path}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {profile && (
        <>
          <Text style={styles.label}>Mode</Text>
          {options?.modes?.length ? <View style={styles.row}>{options.modes.map((option) => <Pressable key={option.id} style={styles.chip(modeId === option.id)} onPress={() => setModeId(option.id)}><Text style={styles.chipText(modeId === option.id)}>{option.label}</Text></Pressable>)}</View> : <Text style={styles.label}>使用当前 Provider 默认模式</Text>}
          <Text style={styles.label}>Thinking</Text>
          {options?.thinkingOptions?.length ? <View style={styles.row}>{options.thinkingOptions.map((option) => <Pressable key={option.id} style={styles.chip(thinkingOptionId === option.id)} onPress={() => setThinkingOptionId(option.id)}><Text style={styles.chipText(thinkingOptionId === option.id)}>{option.label}</Text></Pressable>)}</View> : <Text style={styles.label}>使用当前 Provider 默认 Thinking</Text>}
        </>
      )}
      {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
      <Pressable accessibilityRole="button" style={styles.button} disabled={saving} onPress={() => void handleSave()}><Text style={styles.buttonText}>{saving ? "保存中…" : "保存执行配置"}</Text></Pressable>
    </View>
  );
}
