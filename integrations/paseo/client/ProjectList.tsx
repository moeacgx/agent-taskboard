import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import * as contracts from "../shared/contracts";
import { useRpcQuery } from "./hooks";
import type { PluginLayout } from "./types";
import type { AgentProfileConfig, PaseoConfigurationOptions, Project } from "../shared/contracts";

export function ProjectList(props: {
  theme: PluginTheme;
  layout: PluginLayout;
  onSelectProject: (projectId: string | null, projectName: string) => void;
}) {
  const { theme, layout, onSelectProject } = props;
  const listProjects = useRpc(contracts.listProjects);
  const bridgeRequest = useRpc(contracts.bridgeRequest);
  const saveDefaults = useRpc(contracts.savePaseoProjectDefaults);
  const getAutomation = useRpc(contracts.getPaseoAutomation);
  const query = useRpcQuery(listProjects, {});
  const [editor, setEditor] = useState<{ id: string; name: string; workspacePath: string | null; profile: AgentProfileConfig | null } | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request(method: "POST" | "PATCH" | "DELETE", path: string, value: unknown) {
    const result = await bridgeRequest({
      method,
      path,
      headers: { "content-type": "application/json" },
      body: value === null ? null : { kind: "text", value: JSON.stringify(value) },
    });
    if (result.status < 200 || result.status >= 300) throw new Error(`Dashi 请求失败（HTTP ${result.status}）`);
    if (result.body.kind !== "json") throw new Error("Dashi 返回格式无效。");
    return result.body.value as { project?: Project };
  }

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        padding: layout.compact ? 16 : 24,
        paddingBottom: 12,
        gap: 4,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" as const },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 13 },
      list: { paddingHorizontal: layout.compact ? 16 : 24, paddingBottom: 24, gap: 10 },
      card: {
        padding: 14,
        borderRadius: 12,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        gap: 4,
      },
      cardTitle: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      cardMeta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      muted: { color: theme.colors.foregroundMuted, padding: layout.compact ? 16 : 24 },
      errorText: { color: theme.colors.statusDanger, padding: layout.compact ? 16 : 24 },
      modal: { margin: layout.compact ? 14 : 24, padding: 14, gap: 10, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
      input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 7, padding: 9, color: theme.colors.foreground, backgroundColor: theme.colors.surface0 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      chip: (active: boolean) => ({ paddingVertical: 6, paddingHorizontal: 9, borderRadius: 999, backgroundColor: active ? theme.colors.accent : theme.colors.surface2 }),
      chipText: (active: boolean) => ({ color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const }),
      button: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700" as const },
      secondaryButton: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: theme.colors.surface2 },
      secondaryButtonText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
    }),
    [theme, layout.compact],
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={styles.header}>
        <Text style={styles.title}>任务看板</Text>
        <Text style={styles.subtitle}>选择项目查看任务，或直接查看全部任务</Text>
        <Pressable accessibilityRole="button" testID="create-project" style={styles.button} onPress={() => { setError(null); setCreating(true); setEditor({ id: `temp-${Date.now()}`, name: "", workspacePath: null, profile: null }); }}><Text style={styles.buttonText}>新建项目</Text></Pressable>
      </View>

      {(query.error || (!editor && error)) && <Text style={styles.errorText}>{query.error ?? error}</Text>}

      <View style={styles.list}>
        <Pressable
          accessibilityRole="button"
          onPress={() => onSelectProject(null, "全部任务")}
          style={styles.card}
        >
          <Text style={styles.cardTitle}>全部任务</Text>
          <Text style={styles.cardMeta}>跨所有项目查看</Text>
        </Pressable>

        {query.data?.projects.map((project) => (
          <View key={project.id} style={styles.card}>
            <Pressable accessibilityRole="button" onPress={() => onSelectProject(project.id, project.name)}>
              <Text style={styles.cardTitle}>{project.name}</Text>
              <Text style={styles.cardMeta}>{project.issueCount} 个任务{project.workspacePath ? ` · ${project.workspacePath}` : ""}</Text>
            </Pressable>
            {project.source === "local" && <View style={styles.row}><Pressable accessibilityRole="button" testID={`project-settings-${project.id}`} style={styles.secondaryButton} onPress={() => void openProjectSettings(project)}><Text style={styles.secondaryButtonText}>项目设置</Text></Pressable>{project.id !== "local" && <Pressable accessibilityRole="button" testID={`project-delete-${project.id}`} style={styles.secondaryButton} onPress={() => Alert.alert("删除项目", `确认删除“${project.name}”？空项目才可删除。`, [{ text: "取消", style: "cancel" }, { text: "删除", style: "destructive", onPress: () => void handleDelete(project.id) }])}><Text style={[styles.secondaryButtonText, { color: theme.colors.statusDanger }]}>删除</Text></Pressable>}</View>}
          </View>
        ))}

        {!query.loading && query.data?.projects.length === 0 && (
          <Text style={styles.muted}>还没有项目。请先在 dashi-taskboard 里创建一个项目。</Text>
        )}
      </View>
      {editor && <ProjectEditor theme={theme} layout={layout} editor={editor} creating={creating} busy={busy} error={error} onChange={setEditor} onCancel={() => { if (!busy) setEditor(null); }} onSave={(value) => void handleSave(value)} />}
    </ScrollView>
  );

  async function handleDelete(id: string) {
    setBusy(true); setError(null);
    try { await request("DELETE", `/api/projects/${encodeURIComponent(id)}`, null); setEditor(null); await query.refetch(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  async function openProjectSettings(project: Project) {
    setError(null); setBusy(true);
    try {
      const result = await getAutomation({ projectId: project.id });
      setCreating(false);
      setEditor({ id: project.id, name: project.name, workspacePath: result.automation.workspacePath, profile: result.automation.profile });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(false); }
  }

  async function handleSave(value: { id: string; name: string; workspacePath: string | null; profile: AgentProfileConfig | null }) {
    if (!value.name.trim()) { setError("项目名称不能为空。 "); return; }
    setBusy(true); setError(null);
    try {
      if (creating) {
        await saveDefaults({ projectId: value.id, workspacePath: value.workspacePath, profile: value.profile });
        await request("POST", "/api/projects", { id: value.id, name: value.name.trim(), workspacePath: null });
      } else {
        await request("PATCH", `/api/projects/${encodeURIComponent(value.id)}`, { name: value.name.trim() });
        await saveDefaults({ projectId: value.id, workspacePath: value.workspacePath, profile: value.profile });
      }
      setEditor(null);
      await query.refetch();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }
}

function ProjectEditor(props: { theme: PluginTheme; layout: PluginLayout; editor: { id: string; name: string; workspacePath: string | null; profile: AgentProfileConfig | null }; creating: boolean; busy: boolean; error: string | null; onChange: (value: { id: string; name: string; workspacePath: string | null; profile: AgentProfileConfig | null }) => void; onCancel: () => void; onSave: (value: { id: string; name: string; workspacePath: string | null; profile: AgentProfileConfig | null }) => void }) {
  const { theme, layout, editor, creating, busy, error, onChange, onCancel, onSave } = props;
  const listOptions = useRpc(contracts.listPaseoAssignmentOptions);
  const getConfigurationOptions = useRpc(contracts.getPaseoConfigurationOptions);
  const catalog = useRpcQuery(listOptions, { projectId: editor.id });
  const [configuration, setConfiguration] = useState<PaseoConfigurationOptions | null>(null);
  useEffect(() => {
    if (!editor.profile?.model) { setConfiguration(null); return; }
    let cancelled = false;
    void getConfigurationOptions({ provider: editor.profile.provider, model: editor.profile.model, workspacePath: editor.workspacePath }).then((result) => { if (!cancelled) setConfiguration(result.options); }).catch(() => { if (!cancelled) setConfiguration(null); });
    return () => { cancelled = true; };
    // useRpc 的函数身份不作为请求条件；只在真实配置目标变化时重新 inspect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.profile?.provider, editor.profile?.model, editor.workspacePath]);
  const profiles = [...(catalog.data?.profiles ?? []), ...(catalog.data?.models ?? [])];
  const workspaces = catalog.data?.workspaces ?? [];
  const styles = useMemo(() => ({ box: { marginHorizontal: layout.compact ? 14 : 24, marginBottom: 20, padding: 14, gap: 9, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }, label: { color: theme.colors.foregroundMuted, fontSize: 11 }, input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 7, padding: 9, color: theme.colors.foreground, backgroundColor: theme.colors.surface0 }, row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 }, chip: (active: boolean) => ({ paddingVertical: 6, paddingHorizontal: 9, borderRadius: 999, backgroundColor: active ? theme.colors.accent : theme.colors.surface2 }), chipText: (active: boolean) => ({ color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const }), error: { color: theme.colors.statusDanger, fontSize: 12 }, actions: { flexDirection: "row" as const, gap: 8 } }), [theme, layout.compact]);
  return <View style={styles.box} testID="project-editor"><Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "700" }}>{creating ? "新建项目" : "项目设置"}</Text><Text style={styles.label}>项目名称</Text><TextInput style={styles.input} value={editor.name} onChangeText={(name) => onChange({ ...editor, name })} /><Text style={styles.label}>默认代码目录（可选）</Text><TextInput style={styles.input} value={editor.workspacePath ?? ""} onChangeText={(workspacePath) => onChange({ ...editor, workspacePath: workspacePath || null })} placeholder="未指定时由任务选择" placeholderTextColor={theme.colors.foregroundMuted} /><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>{workspaces.filter((entry) => entry.path).map((entry) => <Pressable key={entry.id} style={styles.chip(editor.workspacePath === entry.path)} onPress={() => onChange({ ...editor, workspacePath: entry.path })}><Text style={styles.chipText(editor.workspacePath === entry.path)}>{entry.kind === "project" ? `项目 · ${entry.name ?? entry.path}` : entry.name ?? entry.path}</Text></Pressable>)}</ScrollView><Text style={styles.label}>默认 Agent（可选）</Text><View style={styles.row}><Pressable style={styles.chip(editor.profile === null)} onPress={() => onChange({ ...editor, profile: null })}><Text style={styles.chipText(editor.profile === null)}>不指定默认 Agent</Text></Pressable>{profiles.map((profile) => <Pressable key={`${profile.provider}:${profile.id}`} style={styles.chip(editor.profile?.id === profile.id)} onPress={() => onChange({ ...editor, profile })}><Text style={styles.chipText(editor.profile?.id === profile.id)}>{profile.name}</Text></Pressable>)}</View>{editor.profile && <><Text style={styles.label}>Mode</Text>{configuration?.modes.length ? <View style={styles.row}>{configuration.modes.map((option) => <Pressable key={option.id} style={styles.chip(editor.profile?.modeId === option.id)} onPress={() => onChange({ ...editor, profile: editor.profile ? { ...editor.profile, modeId: option.id } : null })}><Text style={styles.chipText(editor.profile?.modeId === option.id)}>{option.label}</Text></Pressable>)}</View> : <Text style={styles.label}>当前集成未提供可切换模式，使用默认模式。</Text>}<Text style={styles.label}>Thinking</Text>{configuration?.thinkingOptions.length ? <View style={styles.row}>{configuration.thinkingOptions.map((option) => <Pressable key={option.id} style={styles.chip(editor.profile?.thinkingOptionId === option.id)} onPress={() => onChange({ ...editor, profile: editor.profile ? { ...editor.profile, thinkingOptionId: option.id } : null })}><Text style={styles.chipText(editor.profile?.thinkingOptionId === option.id)}>{option.label}</Text></Pressable>)}</View> : <Text style={styles.label}>使用当前 Provider 默认 Thinking。</Text>}</>}{catalog.error && <Text style={styles.error}>{catalog.error}</Text>}{error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}<View style={styles.actions}><Pressable style={styles.chip(false)} disabled={busy} onPress={onCancel}><Text style={styles.chipText(false)}>取消</Text></Pressable><Pressable style={styles.chip(true)} disabled={busy} onPress={() => onSave(editor)}><Text style={styles.chipText(true)}>{busy ? "保存中…" : "保存"}</Text></Pressable></View></View>;
}
