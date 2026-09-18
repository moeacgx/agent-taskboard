import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import * as contracts from "../shared/contracts";
import type { TaskStatus } from "../shared/contracts";
import { displayCommentBody } from "../shared/agent-comment";
import { AgentPanel } from "./AgentPanel";
import { formatRelativeTime, PRIORITY_LABELS, STATUS_LABELS, STATUS_ORDER, statusColor } from "./format";
import { useRpcQuery } from "./hooks";
import type { PluginLayout, PluginNavigation } from "./types";

export function TaskDetail(props: {
  theme: PluginTheme;
  layout: PluginLayout;
  navigation: PluginNavigation;
  taskId: string;
  onBack: () => void;
  onEdit: (taskId: string, projectId: string) => void;
}) {
  const { theme, layout, navigation, taskId, onBack, onEdit } = props;
  const [commentDraft, setCommentDraft] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const getTask = useRpc(contracts.getTask);
  const taskQuery = useRpcQuery(getTask, { id: taskId });

  const listComments = useRpc(contracts.listComments);
  const commentsQuery = useRpcQuery(listComments, { taskId });

  const getBinding = useRpc(contracts.getBinding);
  const bindingQuery = useRpcQuery(getBinding, { taskId });

  const moveTask = useRpc(contracts.moveTask);
  const restoreTask = useRpc(contracts.restoreTask);
  const addComment = useRpc(contracts.addComment);

  const task = taskQuery.data?.task ?? null;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 16 },
      backText: { color: theme.colors.accent, fontSize: 14 },
      headerRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "flex-start" as const },
      identifier: { color: theme.colors.foregroundMuted, fontSize: 12 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 19 : 22, fontWeight: "700" as const },
      editText: { color: theme.colors.accent, fontSize: 13 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      description: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
      sectionTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, marginBottom: 6 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      chip: (active: boolean, color: string) => ({
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 999,
        backgroundColor: active ? color : theme.colors.surface2,
      }),
      chipText: (active: boolean) => ({
        color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted,
        fontSize: 12,
        fontWeight: "600" as const,
      }),
      card: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        gap: 4,
      },
      commentAuthor: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      commentTime: { color: theme.colors.foregroundMuted, fontSize: 11 },
      commentBody: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        minHeight: 44,
      },
      button: {
        alignSelf: "flex-start" as const,
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
      errorText: { color: theme.colors.statusDanger, fontSize: 12 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  async function handleMove(status: TaskStatus) {
    if (!task || task.archivedAt || status === task.status) return;
    setActionError(null);
    try {
      await moveTask({ id: task.id, version: task.version, status });
      taskQuery.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleRestore() {
    if (!task) return;
    setActionError(null);
    try {
      await restoreTask({ id: task.id, version: task.version });
      taskQuery.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleAddComment() {
    const body = commentDraft.trim();
    if (!body) return;
    setActionError(null);
    try {
      await addComment({ taskId, body });
      setCommentDraft("");
      commentsQuery.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <ScrollView style={styles.screen}>
      <View style={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.backText}>‹ 返回</Text>
        </Pressable>

        {taskQuery.error && <Text style={styles.errorText}>加载任务失败: {taskQuery.error}</Text>}
        {actionError && <Text style={styles.errorText}>{actionError}</Text>}

        {task && (
          <>
            <View>
              <Text style={styles.identifier}>{task.identifier}</Text>
              <View style={styles.headerRow}>
                <Text style={styles.title}>{task.title}</Text>
                {!task.archivedAt && <Pressable accessibilityRole="button" onPress={() => onEdit(task.id, task.projectId)}><Text style={styles.editText}>编辑</Text></Pressable>}
              </View>
              <Text style={styles.meta}>
                {PRIORITY_LABELS[task.priority]}
                {task.labels.length > 0 ? ` · ${task.labels.join(", ")}` : ""}
              </Text>
            </View>

            <View>
              <Text style={styles.sectionTitle}>状态</Text>
              {task.archivedAt ? <View style={styles.row}><Text style={styles.meta}>已归档，只读任务</Text><Pressable accessibilityRole="button" onPress={handleRestore}><Text style={styles.editText}>恢复任务</Text></Pressable></View> : <View style={styles.row}>{STATUS_ORDER.map((status) => <Pressable key={status} style={styles.chip(status === task.status, statusColor(theme, status))} onPress={() => handleMove(status)}><Text style={styles.chipText(status === task.status)}>{STATUS_LABELS[status]}</Text></Pressable>)}</View>}
            </View>

            <View>
              <Text style={styles.sectionTitle}>描述</Text>
              <Text style={styles.description}>{task.description || "（无描述）"}</Text>
            </View>

            {task.archivedAt ? null : bindingQuery.error ? (
              // A failed binding fetch is NOT the same thing as "no binding
              // exists" — showing the create-agent flow here would hide a
              // real error (e.g. a binding record this client can't parse)
              // behind what looks like a fresh, unstarted task.
              <View style={styles.card}>
                <Text style={styles.errorText}>加载 Agent 绑定信息失败：{bindingQuery.error}</Text>
                <Pressable accessibilityRole="button" onPress={bindingQuery.refetch}>
                  <Text style={styles.editText}>重试</Text>
                </Pressable>
              </View>
            ) : (
              <AgentPanel
                theme={theme}
                layout={layout}
                navigation={navigation}
                task={task}
                binding={bindingQuery.data?.binding ?? null}
                onNeedsRefresh={() => {
                  taskQuery.refetch();
                  commentsQuery.refetch();
                  bindingQuery.refetch();
                }}
              />
            )}

            <View>
              <Text style={styles.sectionTitle}>评论</Text>
              <View style={{ gap: 8 }}>
                {commentsQuery.data?.comments.map((comment) => (
                  <View key={comment.id} style={styles.card}>
                    <Text style={styles.commentAuthor}>
                      {comment.authorName}
                      <Text style={styles.commentTime}>  · {formatRelativeTime(comment.createdAt)}</Text>
                    </Text>
                    <Text style={styles.commentBody}>{displayCommentBody(comment.authorId, comment.body)}</Text>
                  </View>
                ))}
                {!commentsQuery.loading && commentsQuery.data?.comments.length === 0 && (
                  <Text style={styles.muted}>还没有评论。</Text>
                )}
              </View>
              {!task.archivedAt && <View style={{ gap: 8, marginTop: 10 }}>
                <TextInput
                  style={styles.input}
                  placeholder="添加评论…"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  value={commentDraft}
                  onChangeText={setCommentDraft}
                  multiline
                />
                <Pressable accessibilityRole="button" style={styles.button} onPress={handleAddComment}>
                  <Text style={styles.buttonText}>发送评论</Text>
                </Pressable>
              </View>}
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}
