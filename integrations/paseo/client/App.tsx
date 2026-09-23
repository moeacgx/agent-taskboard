import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import * as contracts from "../shared/contracts";
import { ConnectionGate } from "./ConnectionGate";
import { useRpcQuery } from "./hooks";
import { ProjectList } from "./ProjectList";
import { NativeDashboard } from "./NativeDashboard";
import { NativeProjectReadme } from "./NativeProjectReadme";
import { TaskDetail } from "./TaskDetail";
import { TaskForm } from "./TaskForm";
import type { TaskStatus } from "../shared/contracts";
import { TaskList } from "./TaskList";
import { OriginalTaskboardFrame } from "./web";

type NativeTab = "dashboard" | "issues" | "readme";

export type Route =
  | { kind: "main"; tab: NativeTab }
  | { kind: "projects"; backTab: NativeTab }
  | { kind: "detail"; taskId: string; backTab: NativeTab }
  | { kind: "form"; mode: "create" | "edit"; taskId?: string; projectId: string | null; createStatus?: TaskStatus; backTab: NativeTab };

export function TaskboardApp(props: PluginSurfaceProps) {
  const { theme, layout, navigation } = props;
  const [route, setRoute] = useState<Route>({ kind: "main", tab: "dashboard" });
  const [selectedProject, setSelectedProject] = useState<{ id: string | null; name: string } | null>(null);
  const projectInitialized = useRef(false);
  const checkConnection = useRpc(contracts.checkConnection);
  const connection = useRpcQuery(checkConnection, {});
  const listProjects = useRpc(contracts.listProjects);
  const projectsQuery = useRpcQuery(listProjects, {}, { enabled: Platform.OS !== "web" && connection.data?.connected === true });

  useEffect(() => {
    if (connection.loading || (!connection.error && connection.data?.connected !== false)) return;
    const timer = setTimeout(() => connection.refetch(), 3000);
    return () => clearTimeout(timer);
  }, [connection.loading, connection.error, connection.data?.connected, connection.refetch]);

  useEffect(() => {
    if (projectInitialized.current || !projectsQuery.data) return;
    projectInitialized.current = true;
    const localProject = projectsQuery.data.projects.find((project) => project.id === "local");
    setSelectedProject(localProject
      ? { id: localProject.id, name: localProject.name }
      : { id: null, name: "全部项目" });
  }, [projectsQuery.data]);

  useEffect(() => {
    if (!projectsQuery.data) return;
    setSelectedProject((currentSelection) => {
      if (!currentSelection?.id) return currentSelection;
      const current = projectsQuery.data!.projects.find((project) => project.id === currentSelection.id);
      if (current) {
        return current.name === currentSelection.name
          ? currentSelection
          : { id: current.id, name: current.name };
      }
      const localProject = projectsQuery.data!.projects.find((project) => project.id === "local");
      return localProject
        ? { id: localProject.id, name: localProject.name }
        : { id: null, name: "全部项目" };
    });
  }, [projectsQuery.data]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      centered: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const },
      muted: { color: theme.colors.foregroundMuted },
      header: { paddingHorizontal: layout.compact ? 14 : 22, paddingTop: 10, paddingBottom: 7, gap: 9, borderBottomWidth: 1, borderBottomColor: theme.colors.border, backgroundColor: theme.colors.surface0 },
      projectButton: { flexDirection: "row" as const, alignItems: "center" as const, minHeight: 38, gap: 9, paddingHorizontal: 9, borderRadius: 7, backgroundColor: theme.colors.surface1 },
      projectCopy: { flex: 1, minWidth: 0, gap: 1 },
      projectName: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      projectHint: { color: theme.colors.foregroundMuted, fontSize: 10 },
      tabs: { flexDirection: "row" as const, gap: 4 },
      tab: (active: boolean) => ({ flex: 1, minHeight: 38, flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 5, borderRadius: 7, backgroundColor: active ? theme.colors.surface2 : "transparent" }),
      tabText: (active: boolean) => ({ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 11, fontWeight: active ? "600" as const : "500" as const }),
      error: { color: theme.colors.statusDanger, padding: 16, fontSize: 12 },
    }),
    [layout.compact, theme],
  );

  if (connection.loading && !connection.data) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.muted}>正在连接 dashi-taskboard…</Text>
      </View>
    );
  }

  if (connection.error || connection.data?.connected === false) {
    return (
      <View style={styles.screen}>
        <ConnectionGate
          theme={theme}
          layout={layout}
          message={connection.error ?? connection.data?.error ?? "无法连接到 dashi-taskboard 服务。"}
          baseUrl={connection.data?.baseUrl ?? null}
          onRetry={connection.refetch}
        />
      </View>
    );
  }

  // 桌面端由原版 DOM 应用自行提供项目选择、导航和工具栏，避免与 RN 壳叠两层界面。
  if (Platform.OS === "web") {
    return (
      <View style={styles.screen}>
        <OriginalTaskboardFrame theme={theme} layout={layout} navigation={navigation} />
      </View>
    );
  }

  if (projectsQuery.error) {
    return <View style={[styles.screen, styles.centered]}><Text style={styles.error}>加载项目失败：{projectsQuery.error}</Text><Pressable accessibilityRole="button" onPress={projectsQuery.refetch}><Text style={{ color: theme.colors.accent, fontWeight: "600" }}>重试</Text></Pressable></View>;
  }

  if (!selectedProject) {
    return <View style={[styles.screen, styles.centered]}><Text style={styles.muted}>正在加载项目…</Text></View>;
  }

  const activeTab = route.kind === "main" ? route.tab : route.backTab;
  const openTask = (taskId: string) => setRoute({ kind: "detail", taskId, backTab: activeTab });

  const mainContent = route.kind === "main" && route.tab === "dashboard"
    ? <NativeDashboard theme={theme} layout={layout} navigation={navigation} projectId={selectedProject.id} projectName={selectedProject.name} onOpenTask={openTask} />
    : route.kind === "main" && route.tab === "issues"
      ? <TaskList theme={theme} layout={layout} navigation={navigation} projectId={selectedProject.id} projectName={selectedProject.name} embedded onBack={() => setRoute({ kind: "projects", backTab: "issues" })} onSelectTask={openTask} onCreateTask={(createStatus) => setRoute({ kind: "form", mode: "create", projectId: selectedProject.id, createStatus, backTab: "issues" })} />
      : route.kind === "main" && route.tab === "readme"
        ? <NativeProjectReadme theme={theme} layout={layout} projectId={selectedProject.id} projectName={selectedProject.name} />
        : null;

  return (
    <View style={styles.screen}>
      {route.kind === "main" && <View style={styles.header}>
        <Pressable accessibilityRole="button" testID="native-project-switch" style={styles.projectButton} onPress={() => setRoute({ kind: "projects", backTab: route.tab })}>
          <Icon name="FolderKanban" size={18} color={theme.colors.accent} />
          <View style={styles.projectCopy}>
            <Text style={styles.projectName} numberOfLines={1}>{selectedProject.name}</Text>
            <Text style={styles.projectHint}>切换或管理项目</Text>
          </View>
          <Icon name="ChevronDown" size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
        <View style={styles.tabs}>
          {([
            ["dashboard", "仪表盘", "LayoutDashboard", "native-tab-dashboard"],
            ["issues", "议题", "ListTodo", "native-tab-issues"],
            ["readme", "项目说明", "FileText", "native-tab-readme"],
          ] as const).map(([tab, label, icon, testID]) => (
            <Pressable key={tab} accessibilityRole="button" testID={testID} style={styles.tab(route.tab === tab)} onPress={() => setRoute({ kind: "main", tab })}>
              <Icon name={icon} size={15} color={route.tab === tab ? theme.colors.foreground : theme.colors.foregroundMuted} />
              <Text style={styles.tabText(route.tab === tab)}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>}
      {mainContent}
      {route.kind === "projects" && (
        <ProjectList
          theme={theme}
          layout={layout}
          onCancel={() => {
            projectsQuery.refetch();
            setRoute({ kind: "main", tab: route.backTab });
          }}
          onSelectProject={(projectId, projectName) => {
            setSelectedProject({ id: projectId, name: projectName });
            projectsQuery.refetch();
            setRoute({ kind: "main", tab: route.backTab });
          }}
        />
      )}
      {route.kind === "detail" && (
        <TaskDetail
          theme={theme}
          layout={layout}
          navigation={navigation}
          taskId={route.taskId}
          onBack={() => setRoute({ kind: "main", tab: route.backTab })}
          onEdit={(taskId, projectId) =>
            setRoute({ kind: "form", mode: "edit", taskId, projectId, backTab: route.backTab })
          }
        />
      )}
      {route.kind === "form" && (
        <TaskForm
          theme={theme}
          layout={layout}
          mode={route.mode}
          taskId={route.taskId}
          projectId={route.projectId}
          createStatus={route.createStatus}
          onCancel={() => setRoute({ kind: "main", tab: route.backTab })}
          onSaved={(taskId) => setRoute({ kind: "detail", taskId, backTab: route.backTab })}
        />
      )}
    </View>
  );
}
