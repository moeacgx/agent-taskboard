import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import * as contracts from "../shared/contracts";
import type { TaskPriority, TaskStatus } from "../shared/contracts";
import { PRIORITY_LABELS, PRIORITY_ORDER } from "./format";
import type { PluginLayout } from "./types";

export function TaskForm(props: {
  theme: PluginTheme;
  layout: PluginLayout;
  mode: "create" | "edit";
  taskId?: string;
  projectId: string | null;
  createStatus?: TaskStatus;
  onCancel: () => void;
  onSaved: (taskId: string) => void;
}) {
  const { theme, layout, mode, taskId, projectId, createStatus, onCancel, onSaved } = props;
  const getTask = useRpc(contracts.getTask);
  const createTask = useRpc(contracts.createTask);
  const updateTask = useRpc(contracts.updateTask);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [labelsText, setLabelsText] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "edit" || !taskId) return;
    let cancelled = false;
    setLoading(true);
    getTask({ id: taskId })
      .then(({ task }) => {
        if (cancelled) return;
        setTitle(task.title);
        setDescription(task.description);
        setPriority(task.priority);
        setLabelsText(task.labels.join(", "));
        setVersion(task.version);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, taskId]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 14 },
      title: { color: theme.colors.foreground, fontSize: 20, fontWeight: "700" as const },
      label: { color: theme.colors.foregroundMuted, fontSize: 12, marginBottom: 4 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
      },
      multiline: { minHeight: 96, textAlignVertical: "top" as const },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      chip: (active: boolean) => ({
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
      }),
      chipText: (active: boolean) => ({
        color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted,
        fontWeight: "600" as const,
      }),
      actions: { flexDirection: "row" as const, gap: 10, marginTop: 6 },
      primaryButton: {
        paddingVertical: 10,
        paddingHorizontal: 20,
        borderRadius: 10,
        backgroundColor: theme.colors.accent,
        opacity: saving ? 0.6 : 1,
      },
      secondaryButton: {
        paddingVertical: 10,
        paddingHorizontal: 20,
        borderRadius: 10,
        backgroundColor: theme.colors.surface2,
      },
      primaryButtonText: { color: theme.colors.accentForeground, fontWeight: "700" as const },
      secondaryButtonText: { color: theme.colors.foreground, fontWeight: "700" as const },
      errorText: { color: theme.colors.statusDanger, fontSize: 13 },
      muted: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact, saving],
  );

  function parseLabels(): string[] {
    return labelsText
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
  }

  async function handleSubmit() {
    if (!title.trim()) {
      setError("标题不能为空");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === "create") {
        const { task } = await createTask({
          projectId: projectId ?? undefined,
          title: title.trim(),
          description: description.trim() || undefined,
          priority,
          labels: parseLabels(),
          status: createStatus,
        });
        onSaved(task.id);
      } else if (taskId && version !== null) {
        const { task } = await updateTask({
          id: taskId,
          version,
          title: title.trim(),
          description: description.trim(),
          priority,
          labels: parseLabels(),
        });
        onSaved(task.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.screen}>
        <Text style={[styles.muted, { padding: layout.compact ? 16 : 24 }]}>加载中…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen}>
      <View style={styles.content}>
        <Text style={styles.title}>{mode === "create" ? "新建任务" : "编辑任务"}</Text>
        {error && <Text style={styles.errorText}>{error}</Text>}

        <View>
          <Text style={styles.label}>标题</Text>
          <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="任务标题" placeholderTextColor={theme.colors.foregroundMuted} />
        </View>

        <View>
          <Text style={styles.label}>描述</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={description}
            onChangeText={setDescription}
            placeholder="任务描述（纯文本）"
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
          />
        </View>

        <View>
          <Text style={styles.label}>优先级</Text>
          <View style={styles.row}>
            {PRIORITY_ORDER.map((value) => (
              <Pressable key={value} style={styles.chip(priority === value)} onPress={() => setPriority(value)}>
                <Text style={styles.chipText(priority === value)}>{PRIORITY_LABELS[value]}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View>
          <Text style={styles.label}>标签（逗号分隔）</Text>
          <TextInput
            style={styles.input}
            value={labelsText}
            onChangeText={setLabelsText}
            placeholder="例如: 缺陷, phase-1"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
        </View>

        <View style={styles.actions}>
          <Pressable accessibilityRole="button" style={styles.primaryButton} onPress={handleSubmit} disabled={saving}>
            <Text style={styles.primaryButtonText}>{saving ? "保存中…" : "保存"}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={onCancel}>
            <Text style={styles.secondaryButtonText}>取消</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}
