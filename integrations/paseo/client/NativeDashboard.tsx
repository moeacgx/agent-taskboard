import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import * as contracts from "../shared/contracts";
import type { PaseoAgentPresentation, Task } from "../shared/contracts";
import { useRpcQuery } from "./hooks";
import type { PluginLayout, PluginNavigation } from "./types";

export function NativeDashboard(props: {
  theme: PluginTheme;
  layout: PluginLayout;
  navigation: PluginNavigation;
  projectId: string | null;
  projectName: string;
  onOpenTask: (taskId: string) => void;
}) {
  const { theme, layout, navigation, projectId, projectName, onOpenTask } = props;
  const listTasks = useRpc(contracts.listTasks);
  const getPresentations = useRpc(contracts.getPaseoPresentations);
  const tasksQuery = useRpcQuery(listTasks, { projectId: projectId ?? undefined });
  const taskIds = (tasksQuery.data?.tasks ?? []).map((task) => task.id);
  const presentationsQuery = useRpcQuery(getPresentations, { taskIds });

  useEffect(() => {
    if (tasksQuery.loading || presentationsQuery.loading) return;
    const timer = setTimeout(() => {
      tasksQuery.refetch();
      presentationsQuery.refetch();
    }, 4000);
    return () => clearTimeout(timer);
  }, [projectId, presentationsQuery.loading, presentationsQuery.refetch, tasksQuery.loading, tasksQuery.refetch]);

  const tasks = tasksQuery.data?.tasks ?? [];
  const presentations = new Map(
    (presentationsQuery.data?.presentations ?? []).map((presentation) => [presentation.taskId, presentation]),
  );
  const activeTasks = tasks.filter((task) => (
    !task.archivedAt && task.status !== "done" && task.status !== "canceled"
  ));
  const permissionTasks = activeTasks.filter((task) => presentations.get(task.id)?.attentionReason === "permission");
  const permissionIds = new Set(permissionTasks.map((task) => task.id));
  const reviewTasks = activeTasks.filter((task) => task.status === "in_review" && !permissionIds.has(task.id)
    && presentations.get(task.id)?.status !== "running");
  const blockedTasks = activeTasks.filter((task) => task.status === "blocked" && !permissionIds.has(task.id)
    && presentations.get(task.id)?.status !== "running");
  const runningTasks = activeTasks.filter((task) => (
    presentations.get(task.id)?.status === "running"
      && !permissionIds.has(task.id)
  ));
  const presentationUnknown = Boolean(presentationsQuery.error || (presentationsQuery.loading && !presentationsQuery.data));
  const completed = tasks.filter((task) => task.status === "done").length;
  const completion = tasks.length === 0 ? 0 : Math.round((completed / tasks.length) * 100);

  const styles = useMemo(() => ({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: layout.compact ? 14 : 22, gap: 12 },
    heading: { color: theme.colors.foreground, fontSize: 20, fontWeight: "700" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    metrics: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    metric: { width: "48%" as const, minWidth: 132, padding: 12, gap: 5, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
    metricTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 7 },
    metricLabel: { color: theme.colors.foregroundMuted, fontSize: 11 },
    metricValue: { color: theme.colors.foreground, fontSize: 22, fontWeight: "700" as const },
    section: { gap: 7 },
    sectionTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
    task: { padding: 11, gap: 3, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
    taskRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 8 },
    taskTitle: { flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    taskMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
    permission: { borderColor: theme.colors.statusWarning, backgroundColor: theme.colors.surface2 },
    action: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const },
    error: { color: theme.colors.statusDanger, fontSize: 12 },
  }), [layout.compact, theme]);

  function TaskRow({ task, presentation, permission = false }: {
    task: Task;
    presentation?: PaseoAgentPresentation;
    permission?: boolean;
  }) {
    return (
      <View style={[styles.task, permission ? styles.permission : null]}>
        <Pressable accessibilityRole="button" onPress={() => onOpenTask(task.id)}>
          <View style={styles.taskRow}>
            <Text style={styles.taskTitle}>{task.title}</Text>
            <Icon name="ChevronRight" size={15} color={theme.colors.foregroundMuted} />
          </View>
          <Text style={styles.taskMeta}>{task.identifier}</Text>
        </Pressable>
        {permission && <Text style={styles.action}>等待你的授权</Text>}
        {presentation && navigation?.openAgent && (
          <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ agentId: presentation.agentId })}>
            <Text style={styles.action}>{permission ? "打开会话处理权限" : "打开 Agent 会话"}</Text>
          </Pressable>
        )}
      </View>
    );
  }

  if (tasksQuery.error) {
    return <View style={styles.content}><Text style={styles.error}>仪表盘加载失败：{tasksQuery.error}</Text></View>;
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID="native-dashboard">
      <View>
        <Text style={styles.heading}>仪表盘</Text>
        <Text style={styles.muted}>{projectName} 的执行概览</Text>
      </View>
      {tasksQuery.loading && !tasksQuery.data ? <Text style={styles.muted}>正在加载任务概览…</Text> : (
        <>
          <View style={styles.metrics}>
            <View style={styles.metric}><View style={styles.metricTop}><Icon name="ListTodo" size={16} color={theme.colors.accent} /><Text style={styles.metricLabel}>全部任务</Text></View><Text style={styles.metricValue}>{tasks.length}</Text></View>
            <View style={styles.metric}><View style={styles.metricTop}><Icon name="CircleCheck" size={16} color={theme.colors.statusSuccess} /><Text style={styles.metricLabel}>完成度</Text></View><Text style={styles.metricValue}>{completion}%</Text></View>
            <View style={styles.metric}><View style={styles.metricTop}><Icon name="Play" size={16} color={theme.colors.statusWarning} /><Text style={styles.metricLabel}>运行中</Text></View><Text style={styles.metricValue}>{presentationUnknown ? "—" : runningTasks.length}</Text></View>
            <View style={styles.metric}><View style={styles.metricTop}><Icon name="Eye" size={16} color={theme.colors.accent} /><Text style={styles.metricLabel}>等你确认</Text></View><Text style={styles.metricValue}>{reviewTasks.length}</Text></View>
          </View>
          {permissionTasks.length > 0 && <View style={styles.section}><Text style={styles.sectionTitle}>需要关注 · {permissionTasks.length}</Text>{permissionTasks.map((task) => <TaskRow key={task.id} task={task} presentation={presentations.get(task.id)} permission />)}</View>}
          {runningTasks.length > 0 && <View style={styles.section}><Text style={styles.sectionTitle}>运行中 · {runningTasks.length}</Text>{runningTasks.map((task) => <TaskRow key={task.id} task={task} presentation={presentations.get(task.id)} />)}</View>}
          {reviewTasks.length > 0 && <View style={styles.section}><Text style={styles.sectionTitle}>等你确认 · {reviewTasks.length}</Text>{reviewTasks.map((task) => <TaskRow key={task.id} task={task} presentation={presentations.get(task.id)} />)}</View>}
          {blockedTasks.length > 0 && <View style={styles.section}><Text style={styles.sectionTitle}>遇到阻碍 · {blockedTasks.length}</Text>{blockedTasks.map((task) => <TaskRow key={task.id} task={task} presentation={presentations.get(task.id)} />)}</View>}
          {tasks.length === 0 && <Text style={styles.muted}>这个项目还没有任务。</Text>}
        </>
      )}
      {presentationsQuery.error && <Text style={styles.error}>Agent 状态暂时无法刷新：{presentationsQuery.error}</Text>}
    </ScrollView>
  );
}
