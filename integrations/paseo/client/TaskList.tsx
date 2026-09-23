import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";

import * as contracts from "../shared/contracts";
import type { PaseoAutomationState, Task, TaskStatus } from "../shared/contracts";
import { BOARD_COLUMN_LABELS, BOARD_COLUMNS, boardColumnForStatus, calculateDropSortOrder, isMainBoardStatus, orderBoardTasks } from "./board";
import { PRIORITY_LABELS } from "./format";
import { useRpcQuery } from "./hooks";
import { OriginalTaskboardFrame, WebBoard } from "./web";
import type { PluginLayout } from "./types";

const COLUMN_STATUS: Record<(typeof BOARD_COLUMNS)[number], TaskStatus> = {
  ideas: "todo",
  processing: "in_progress",
  review: "in_review",
};

export type BoardTaskAction =
  | { kind: "open" }
  | { kind: "archive" }
  | { kind: "restore" }
  | { kind: "delete" }
  | { kind: "move"; status: TaskStatus };

type TaskView = "board" | "list" | "done" | "canceled" | "archived";

export function TaskList(props: {
  theme: PluginTheme;
  layout: PluginLayout;
  navigation: import("./types").PluginNavigation;
  projectId: string | null;
  projectName: string;
  onBack: () => void;
  onSelectTask: (taskId: string) => void;
  onCreateTask: (status?: TaskStatus) => void;
  embedded?: boolean;
}) {
  const { theme, layout, navigation, projectId, projectName, onBack, onSelectTask, onCreateTask, embedded = false } = props;
  const listTasks = useRpc(contracts.listTasks);
  const moveBoard = useRpc(contracts.moveTaskBoard);
  const retryDispatch = useRpc(contracts.retryTaskDispatch);
  const archiveTask = useRpc(contracts.archiveTask);
  const restoreTask = useRpc(contracts.restoreTask);
  const deleteTask = useRpc(contracts.deleteTask);
  const getAutomation = useRpc(contracts.getPaseoAutomation);
  const saveAutomation = useRpc(contracts.savePaseoAutomation);
  const [view, setView] = useState<TaskView>("board");
  const query = useRpcQuery(listTasks, {
    projectId: projectId ?? undefined,
    archived: view === "archived",
    status: view === "done" || view === "canceled" ? view : undefined,
  });
  const automationQuery = useRpcQuery(getAutomation, { projectId: projectId ?? "" }, { enabled: projectId !== null });
  const [movingId, setMovingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (movingId || settingsOpen) return;
    const timer = setInterval(() => query.refetch(), 4000);
    return () => clearInterval(timer);
    // `listTasks` and `query` are intentionally omitted: this poll must not
    // reset the settings form or interrupt a move already in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, movingId, settingsOpen]);

  const styles = useMemo(() => ({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    header: { padding: layout.compact ? 14 : 22, paddingBottom: 10, gap: 8 },
    headerRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 12 },
    backText: { color: theme.colors.accent, fontSize: 14 },
    title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "700" as const },
    subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
    button: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 7, backgroundColor: theme.colors.accent },
    buttonText: { color: theme.colors.accentForeground, fontWeight: "700" as const, fontSize: 12 },
    secondary: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 7, backgroundColor: theme.colors.surface2 },
    secondaryText: { color: theme.colors.foreground, fontWeight: "600" as const, fontSize: 12 },
    error: { color: theme.colors.statusDanger, fontSize: 12, paddingHorizontal: layout.compact ? 14 : 22 },
    settings: { marginHorizontal: layout.compact ? 14 : 22, padding: 12, gap: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
    label: { color: theme.colors.foregroundMuted, fontSize: 12 },
    input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 7, padding: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface0 },
    row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: (active: boolean) => ({ paddingVertical: 6, paddingHorizontal: 9, borderRadius: 999, backgroundColor: active ? theme.colors.accent : theme.colors.surface2 }),
    chipText: (active: boolean) => ({ color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const }),
  }), [theme, layout.compact]);

  const tasks = useMemo(() => {
    const loaded = query.data?.tasks ?? [];
    return view === "board" ? orderBoardTasks(loaded.filter((task) => isMainBoardStatus(task.status))) : loaded;
  }, [query.data?.tasks, view]);

  function destinationStatus(task: Task, column: (typeof BOARD_COLUMNS)[number]): TaskStatus {
    return boardColumnForStatus(task.status) === column ? task.status : COLUMN_STATUS[column];
  }

  async function handleDrop(task: Task, column: (typeof BOARD_COLUMNS)[number], targetIndex: number) {
    if (movingId) return;
    const status = destinationStatus(task, column);
    const destination = tasks.filter((item) => boardColumnForStatus(item.status) === column && item.id !== task.id);
    setMovingId(task.id);
    setNotice(null);
    try {
      const result = await moveBoard({ id: task.id, version: task.version, status, sortOrder: calculateDropSortOrder(destination, targetIndex) });
      if (result.dispatch === "needs_configuration") {
        setNotice(result.dispatchMessage ?? "请打开任务详情配置 Agent 和代码目录，再重试开始执行。");
      }
      if (result.dispatchMessage) setNotice(result.dispatchMessage);
      query.refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message);
      query.refetch();
    } finally {
      setMovingId(null);
    }
  }

  async function handleRetry(task: Task) {
    setMovingId(task.id);
    setNotice(null);
    try {
      const result = await retryDispatch({ id: task.id, version: task.version });
      if (result.dispatchMessage) setNotice(result.dispatchMessage);
      query.refetch();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      query.refetch();
    } finally {
      setMovingId(null);
    }
  }

  async function confirmDelete(task: Task): Promise<boolean> {
    const message = `确认删除任务 ${task.identifier}？删除不会删除 Paseo 会话、绑定或评论。`;
    if (Platform.OS === "web") return Boolean((globalThis as { confirm?: (value: string) => boolean }).confirm?.(message));
    return new Promise((resolve) => Alert.alert("确认删除", message, [
      { text: "取消", style: "cancel", onPress: () => resolve(false) },
      { text: "删除", style: "destructive", onPress: () => resolve(true) },
    ]));
  }

  async function handleAction(task: Task, action: BoardTaskAction) {
    if (action.kind === "open") {
      onSelectTask(task.id);
      return;
    }
    setMovingId(task.id);
    setNotice(null);
    try {
      if (action.kind === "move") {
        const result = await moveBoard({ id: task.id, version: task.version, status: action.status });
        if (result.dispatchMessage) setNotice(result.dispatchMessage);
      } else if (action.kind === "archive") {
        await archiveTask({ id: task.id, version: task.version });
      } else if (action.kind === "restore") {
        await restoreTask({ id: task.id, version: task.version });
      } else if (action.kind === "delete") {
        if (!(await confirmDelete(task))) return;
        await deleteTask({ id: task.id, version: task.version });
      }
      query.refetch();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      query.refetch();
    } finally {
      setMovingId(null);
    }
  }

  if (query.error) return <View style={styles.screen}><Text style={styles.error}>加载任务失败：{query.error}</Text></View>;

  return (
    <View style={styles.screen} testID="paseo-taskboard">
      <View style={[styles.header, embedded ? { paddingTop: 8 } : null]}>
        {!embedded && <Pressable accessibilityRole="button" accessibilityLabel="返回项目列表" testID="board-back" onPress={onBack}><Text style={styles.backText}>‹ 全部项目</Text></Pressable>}
        {!embedded && <View style={styles.headerRow}>
          <View><Text style={styles.title}>{projectName}</Text><Text style={styles.subtitle}>拖动想法开始执行，完成后自动进入等你确认</Text></View>
        </View>}
        <View style={styles.headerRow}>
          <Text style={styles.subtitle}>{view === "board" ? "议题看板" : view === "list" ? "任务列表" : view === "done" ? "已完成" : view === "canceled" ? "已取消" : "已归档"}</Text>
          <View style={styles.row}>
            {embedded && view !== "board" && <Pressable accessibilityRole="button" testID="native-issues-back-board" style={styles.secondary} onPress={() => { setView("board"); setMoreOpen(false); }}><Text style={styles.secondaryText}>返回看板</Text></Pressable>}
            {embedded && <Pressable accessibilityRole="button" testID="native-issues-more" style={styles.secondary} onPress={() => setMoreOpen((value) => !value)}><Text style={styles.secondaryText}>更多</Text></Pressable>}
            {projectId !== null && <Pressable accessibilityRole="button" accessibilityLabel="项目自动认领设置" testID="project-settings-toggle" style={styles.secondary} onPress={() => setSettingsOpen((value) => !value)}><Text style={styles.secondaryText}>自动认领</Text></Pressable>}
            <Pressable accessibilityRole="button" accessibilityLabel="新建任务" testID="create-task" onPress={() => onCreateTask()} style={styles.button}><Text style={styles.buttonText}>新建</Text></Pressable>
          </View>
        </View>
        {!embedded && <View style={styles.row}>
          {(["board", "done", "canceled", "archived"] as TaskView[]).map((candidate) => (
            <Pressable key={candidate} accessibilityRole="button" accessibilityLabel={candidate === "board" ? "议题看板" : candidate === "done" ? "已完成任务" : candidate === "canceled" ? "已取消任务" : "归档任务"} testID={`task-view-${candidate}`} style={styles.chip(view === candidate)} onPress={() => setView(candidate)}>
              <Text style={styles.chipText(view === candidate)}>{candidate === "board" ? "议题看板" : candidate === "done" ? "已完成" : candidate === "canceled" ? "已取消" : "归档"}</Text>
            </Pressable>
          ))}
        </View>}
        {embedded && moreOpen && <View style={styles.settings} testID="native-issues-more-menu">
          <Text style={styles.label}>其他视图</Text>
          <View style={styles.row}>
            {(["list", "done", "canceled", "archived"] as TaskView[]).map((candidate) => (
              <Pressable key={candidate} accessibilityRole="button" testID={`task-view-${candidate}`} style={styles.chip(view === candidate)} onPress={() => { setView(candidate); setMoreOpen(false); }}>
                <Text style={styles.chipText(view === candidate)}>{candidate === "list" ? "普通列表" : candidate === "done" ? "已完成" : candidate === "canceled" ? "已取消" : "已归档"}</Text>
              </Pressable>
            ))}
          </View>
        </View>}
      </View>
      {notice && <Text style={styles.error} accessibilityRole="alert" testID="board-notice">{notice}</Text>}
      {settingsOpen && projectId !== null && <ProjectAutomationSettingsPanel theme={theme} layout={layout} initialAutomation={automationQuery.data?.automation ?? null} projectId={projectId} saveAutomation={saveAutomation} onSaved={() => { automationQuery.refetch(); setNotice("自动认领设置已保存。 "); }} />}
      {view === "board"
        ? (Platform.OS === "web" ? <OriginalTaskboardFrame theme={theme} layout={layout} navigation={navigation} /> : <NativeBoard theme={theme} layout={layout} tasks={tasks} movingId={movingId} onSelectTask={onSelectTask} onDrop={handleDrop} onRetry={handleRetry} onAction={handleAction} />)
        : <TaskStatusList theme={theme} layout={layout} tasks={tasks} view={view} movingId={movingId} onSelectTask={onSelectTask} onAction={handleAction} />}
    </View>
  );
}

function ProjectAutomationSettingsPanel(props: { theme: PluginTheme; layout: PluginLayout; initialAutomation: PaseoAutomationState | null; projectId: string; saveAutomation: (input: { projectId: string; enabledByUser: boolean; intervalMinutes: 5 | 10 | 15 | 30 | 60; quotaAware: boolean }) => Promise<unknown>; onSaved: () => void }) {
  const { theme, layout, initialAutomation, projectId, saveAutomation, onSaved } = props;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabledByUser, setEnabledByUser] = useState(initialAutomation?.enabledByUser ?? false);
  const [intervalMinutes, setIntervalMinutes] = useState<5 | 10 | 15 | 30 | 60>(initialAutomation?.intervalMinutes ?? 5);
  const styles = useMemo(() => ({ box: { marginHorizontal: layout.compact ? 14 : 22, padding: 12, gap: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }, label: { color: theme.colors.foregroundMuted, fontSize: 12 }, row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 }, chip: (active: boolean) => ({ paddingVertical: 6, paddingHorizontal: 9, borderRadius: 999, backgroundColor: active ? theme.colors.accent : theme.colors.surface2 }), chipText: (active: boolean) => ({ color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const }), save: { alignSelf: "flex-start" as const, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 7, backgroundColor: theme.colors.accent }, saveText: { color: theme.colors.accentForeground, fontWeight: "700" as const, fontSize: 12 }, error: { color: theme.colors.statusDanger, fontSize: 12 } }), [theme, layout.compact]);
  async function handleSave() {
    setSaving(true); setError(null);
    try {
      await saveAutomation({ projectId, enabledByUser, intervalMinutes, quotaAware: false });
      onSaved();
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); } finally { setSaving(false); }
  }
  return <View style={styles.box} testID="project-automation-settings"><Text style={styles.label}>自动认领</Text><View style={styles.row}><Pressable accessibilityRole="button" style={styles.chip(enabledByUser)} onPress={() => setEnabledByUser((value) => !value)}><Text style={styles.chipText(enabledByUser)}>{enabledByUser ? "已启用" : "已关闭"}</Text></Pressable>{([5, 10, 15, 30, 60] as const).map((minutes) => <Pressable key={minutes} accessibilityRole="button" style={styles.chip(intervalMinutes === minutes)} onPress={() => setIntervalMinutes(minutes)}><Text style={styles.chipText(intervalMinutes === minutes)}>{minutes} 分钟</Text></Pressable>)}</View><Text style={styles.label}>额度感知</Text><Text style={styles.label}>当前 Paseo SDK 未提供额度目录，额度开关保持关闭。</Text>{error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}<Pressable accessibilityRole="button" accessibilityLabel="保存项目自动认领设置" testID="save-project-settings" style={styles.save} onPress={() => void handleSave()} disabled={saving}><Text style={styles.saveText}>{saving ? "保存中…" : "保存自动认领"}</Text></Pressable></View>;
}

function NativeBoard(props: { theme: PluginTheme; layout: PluginLayout; tasks: Task[]; movingId: string | null; onSelectTask: (id: string) => void; onDrop: (task: Task, column: (typeof BOARD_COLUMNS)[number], index: number) => void; onRetry: (task: Task) => void; onAction: (task: Task, action: BoardTaskAction) => void }) {
  const { theme, layout, tasks, movingId, onSelectTask, onDrop, onRetry, onAction } = props;
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  return <ScrollView horizontal contentContainerStyle={{ gap: 10, padding: layout.compact ? 10 : 16 }} testID="native-board">{BOARD_COLUMNS.map((column) => { const columnTasks = tasks.filter((task) => boardColumnForStatus(task.status) === column); return <View key={column} style={{ width: layout.compact ? 285 : 340, backgroundColor: theme.colors.surface2, borderRadius: 9, padding: 8, gap: 8 }}><Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{BOARD_COLUMN_LABELS[column]} {columnTasks.length}</Text>{columnTasks.map((task, index) => <View key={task.id} style={{ padding: 12, borderRadius: 8, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, gap: 5 }}><Pressable accessibilityRole="button" accessibilityLabel={`任务 ${task.identifier} ${task.title}`} testID={`task-card-${task.id}`} onPress={() => onSelectTask(task.id)}><Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>ID: {task.identifier}</Text><Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{task.title}</Text><Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{PRIORITY_LABELS[task.priority]} {task.labels.length ? `· ${task.labels.join(", ")}` : ""}</Text></Pressable><View style={{ flexDirection: "row", gap: 8 }}><Pressable accessibilityRole="button" accessibilityLabel={`打开 ${task.identifier} 操作菜单`} testID={`task-menu-${task.id}`} onPress={() => setMenuTaskId(menuTaskId === task.id ? null : task.id)}><Text style={{ color: theme.colors.foregroundMuted, fontSize: 16 }}>…</Text></Pressable>{task.status === "blocked" && <Pressable accessibilityRole="button" accessibilityLabel={`重试 ${task.identifier}`} testID={`retry-task-${task.id}`} onPress={() => onRetry(task)} disabled={movingId === task.id}><Text style={{ color: theme.colors.accent }}>重试 Agent</Text></Pressable>}</View>{menuTaskId === task.id && <View style={{ gap: 5 }}><Pressable accessibilityRole="button" onPress={() => onAction(task, { kind: "open" })}><Text style={{ color: theme.colors.accent }}>打开详情</Text></Pressable><Pressable accessibilityRole="button" onPress={() => onAction(task, { kind: "move", status: "todo" })}><Text style={{ color: theme.colors.accent }}>移动到等待认领</Text></Pressable><Pressable accessibilityRole="button" onPress={() => onAction(task, { kind: "move", status: "in_progress" })}><Text style={{ color: theme.colors.accent }}>移动到处理中</Text></Pressable><Pressable accessibilityRole="button" onPress={() => onAction(task, { kind: "move", status: "in_review" })}><Text style={{ color: theme.colors.accent }}>移动到等你确认</Text></Pressable><Pressable accessibilityRole="button" onPress={() => onAction(task, { kind: "move", status: "done" })}><Text style={{ color: theme.colors.accent }}>标记完成</Text></Pressable><Pressable accessibilityRole="button" onPress={() => onAction(task, { kind: "archive" })}><Text style={{ color: theme.colors.accent }}>归档</Text></Pressable>{column === "ideas" && <Pressable accessibilityRole="button" onPress={() => onAction(task, { kind: "delete" })}><Text style={{ color: theme.colors.statusDanger }}>删除</Text></Pressable>}</View>}{index < columnTasks.length - 1 && <Pressable accessibilityRole="button" accessibilityLabel={`将 ${task.identifier} 移到本列末尾`} onPress={() => void onDrop(task, column, columnTasks.length - 1)}><Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>移到本列末尾</Text></Pressable>}</View>)}</View>; })}</ScrollView>;
}

function TaskStatusList(props: { theme: PluginTheme; layout: PluginLayout; tasks: Task[]; view: Exclude<TaskView, "board">; movingId: string | null; onSelectTask: (id: string) => void; onAction: (task: Task, action: BoardTaskAction) => void }) {
  const { theme, layout, tasks, view, movingId, onSelectTask, onAction } = props;
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: layout.compact ? 14 : 22, gap: 8 }} testID={`task-status-list-${view}`}>{tasks.map((task) => <View key={task.id} style={{ padding: 12, borderRadius: 8, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, gap: 6 }}><Pressable accessibilityRole="button" accessibilityLabel={`任务 ${task.identifier} ${task.title}`} onPress={() => onSelectTask(task.id)}><Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>ID: {task.identifier}</Text><Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{task.title}</Text><Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{task.status} · v{task.version}</Text></Pressable><View style={{ flexDirection: "row", gap: 10 }}>{view === "archived" ? <><Pressable accessibilityRole="button" onPress={() => onAction(task, { kind: "restore" })} disabled={movingId === task.id}><Text style={{ color: theme.colors.accent }}>恢复</Text></Pressable><Pressable accessibilityRole="button" onPress={() => onAction(task, { kind: "delete" })} disabled={movingId === task.id}><Text style={{ color: theme.colors.statusDanger }}>删除</Text></Pressable></> : <Pressable accessibilityRole="button" onPress={() => onAction(task, { kind: "archive" })} disabled={movingId === task.id}><Text style={{ color: theme.colors.accent }}>归档</Text></Pressable>}</View></View>)}</ScrollView>;
}
