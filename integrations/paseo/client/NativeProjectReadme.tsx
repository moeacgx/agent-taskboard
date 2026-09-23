import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import * as contracts from "../shared/contracts";
import type { PluginLayout } from "./types";

interface ProjectReadmeDocument {
  projectId: string;
  content: string;
  version: number;
}

interface BridgeJsonResponse {
  status: number;
  body: { kind: "json"; value: unknown } | { kind: "base64"; value: string };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function responseError(response: BridgeJsonResponse, action: string): string {
  const value = response.body.kind === "json" ? record(response.body.value) : null;
  const error = record(value?.error);
  const message = typeof error?.message === "string" ? error.message : `${action}失败（HTTP ${response.status}）`;
  if (response.status !== 409) return message;

  const details = record(error?.details);
  const actualVersion = typeof details?.actualVersion === "number" ? details.actualVersion : null;
  return actualVersion === null
    ? "项目说明已在其他位置更新，当前草稿仍保留。请复制草稿后取消编辑，再重新打开项目说明获取最新内容。"
    : `项目说明已在其他位置更新到版本 ${actualVersion}，当前草稿仍保留。请复制草稿后取消编辑，再重新打开项目说明获取最新内容。`;
}

function readDocument(response: BridgeJsonResponse, projectId: string, action: string): ProjectReadmeDocument {
  if (response.status < 200 || response.status >= 300) throw new Error(responseError(response, action));
  const value = response.body.kind === "json" ? record(response.body.value) : null;
  const readme = record(value?.readme);
  if (typeof readme?.content !== "string" || !Number.isInteger(readme.version) || Number(readme.version) < 0) {
    throw new Error(`${action}失败：Dashi 返回了无效的项目说明。`);
  }
  return { projectId, content: readme.content, version: Number(readme.version) };
}

export function NativeProjectReadme(props: {
  theme: PluginTheme;
  layout: PluginLayout;
  projectId: string | null;
  projectName: string;
}) {
  const { theme, layout, projectId, projectName } = props;
  const bridgeRequest = useRpc(contracts.bridgeRequest);
  const requestGeneration = useRef(0);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [document, setDocument] = useState<ProjectReadmeDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setDocument(null);
    setDraft("");
    setEditing(false);
    setSaving(false);
    setError(null);
    if (!projectId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void bridgeRequest({
      method: "GET",
      path: `/api/projects/${encodeURIComponent(projectId)}/readme`,
      headers: {},
      body: null,
    }).then((response) => {
      if (requestGeneration.current !== generation) return;
      const next = readDocument(response, projectId, "读取项目说明");
      setDocument(next);
      setDraft(next.content);
    }).catch((caught: unknown) => {
      if (requestGeneration.current === generation) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }).finally(() => {
      if (requestGeneration.current === generation) setLoading(false);
    });
    // useRpc 每次渲染可能返回新函数；项目与手动刷新世代已经描述请求身份。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, reloadGeneration]);

  const styles = useMemo(() => ({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: layout.compact ? 14 : 22, gap: 14, flexGrow: 1 },
    header: { flexDirection: "row" as const, alignItems: "flex-start" as const, justifyContent: "space-between" as const, gap: 12 },
    headingWrap: { flex: 1, minWidth: 0 },
    title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 20, fontWeight: "700" as const },
    subtitle: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, marginTop: 4 },
    body: { color: theme.colors.foreground, fontSize: 14, lineHeight: 22 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 },
    error: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 18 },
    editor: {
      minHeight: layout.compact ? 300 : 380,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      padding: 12,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface1,
      fontSize: 14,
      lineHeight: 21,
      textAlignVertical: "top" as const,
    },
    actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    primaryButton: { paddingVertical: 8, paddingHorizontal: 13, borderRadius: 8, backgroundColor: theme.colors.accent },
    primaryButtonDisabled: { opacity: 0.5 },
    primaryText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700" as const },
    secondaryButton: { paddingVertical: 8, paddingHorizontal: 13, borderRadius: 8, backgroundColor: theme.colors.surface2 },
    secondaryText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
  }), [theme, layout.compact]);

  const activeDocument = document?.projectId === projectId ? document : null;

  async function save() {
    if (!projectId || !activeDocument || saving) return;
    const generation = requestGeneration.current;
    const savingProjectId = projectId;
    setSaving(true);
    setError(null);
    try {
      const response = await bridgeRequest({
        method: "PUT",
        path: `/api/projects/${encodeURIComponent(savingProjectId)}/readme`,
        headers: { "content-type": "application/json" },
        body: {
          kind: "text",
          value: JSON.stringify({ content: draft, version: activeDocument.version }),
        },
      });
      const next = readDocument(response, savingProjectId, "保存项目说明");
      if (requestGeneration.current !== generation) return;
      setDocument(next);
      setDraft(next.content);
      setEditing(false);
    } catch (caught) {
      if (requestGeneration.current === generation) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (requestGeneration.current === generation) setSaving(false);
    }
  }

  function cancelEditing() {
    if (!activeDocument) return;
    setDraft(activeDocument.content);
    setEditing(false);
    setError(null);
  }

  if (!projectId) {
    return (
      <View style={[styles.screen, styles.content]} testID="native-project-readme-empty-project">
        <Text style={styles.title}>项目说明</Text>
        <Text style={styles.muted}>请先选择一个项目。</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" testID="native-project-readme">
      <View style={styles.header}>
        <View style={styles.headingWrap}>
          <Text style={styles.title}>{projectName || "项目说明"}</Text>
          <Text style={styles.subtitle}>项目说明会作为该项目看板任务执行时的共享背景附上。</Text>
        </View>
        {!editing && activeDocument && (
          <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={() => { setDraft(activeDocument.content); setError(null); setEditing(true); }}>
            <Text style={styles.secondaryText}>{activeDocument.content ? "编辑" : "开始填写"}</Text>
          </Pressable>
        )}
      </View>

      {loading && <Text style={styles.muted}>正在读取项目说明…</Text>}
      {!loading && error && !editing && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
      {!loading && error && !editing && (
        <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={() => setReloadGeneration((value) => value + 1)}>
          <Text style={styles.secondaryText}>重试</Text>
        </Pressable>
      )}

      {!loading && activeDocument && editing && (
        <>
          <TextInput
            accessibilityLabel={`${projectName || "当前项目"}项目说明`}
            multiline
            value={draft}
            onChangeText={setDraft}
            placeholder="填写项目目标、约束与所有任务都应了解的共享背景"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.editor}
            testID="native-project-readme-input"
          />
          {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" style={styles.secondaryButton} disabled={saving} onPress={cancelEditing}>
              <Text style={styles.secondaryText}>取消</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={[styles.primaryButton, (saving || draft === activeDocument.content) && styles.primaryButtonDisabled]}
              disabled={saving || draft === activeDocument.content}
              onPress={() => void save()}
            >
              <Text style={styles.primaryText}>{saving ? "保存中…" : "保存"}</Text>
            </Pressable>
          </View>
        </>
      )}

      {!loading && activeDocument && !editing && (
        activeDocument.content
          ? <Text selectable style={styles.body}>{activeDocument.content}</Text>
          : <Text style={styles.muted}>当前项目还没有说明。</Text>
      )}
    </ScrollView>
  );
}
