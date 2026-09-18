import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Platform, Text, View } from "react-native";

import * as contracts from "../shared/contracts";
import { ConnectionGate } from "./ConnectionGate";
import { useRpcQuery } from "./hooks";
import { ProjectList } from "./ProjectList";
import { TaskDetail } from "./TaskDetail";
import { TaskForm } from "./TaskForm";
import type { TaskStatus } from "../shared/contracts";
import { TaskList } from "./TaskList";
import { OriginalTaskboardFrame } from "./web";

export type Route =
  | { kind: "projects" }
  | { kind: "tasks"; projectId: string | null; projectName: string }
  | { kind: "detail"; taskId: string; back: Route }
  | { kind: "form"; mode: "create" | "edit"; taskId?: string; projectId: string | null; createStatus?: TaskStatus; back: Route };

export function TaskboardApp(props: PluginSurfaceProps) {
  const { theme, layout, navigation } = props;
  const [route, setRoute] = useState<Route>({ kind: "projects" });
  const checkConnection = useRpc(contracts.checkConnection);
  const connection = useRpcQuery(checkConnection, {});

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      centered: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const },
      muted: { color: theme.colors.foregroundMuted },
    }),
    [theme],
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

  return (
    <View style={styles.screen}>
      {route.kind === "projects" && (
        <ProjectList
          theme={theme}
          layout={layout}
          onSelectProject={(projectId, projectName) => setRoute({ kind: "tasks", projectId, projectName })}
        />
      )}
      {route.kind === "tasks" && (
        <TaskList
          theme={theme}
          layout={layout}
          navigation={navigation}
          projectId={route.projectId}
          projectName={route.projectName}
          onBack={() => setRoute({ kind: "projects" })}
          onSelectTask={(taskId) => setRoute({ kind: "detail", taskId, back: route })}
          onCreateTask={(createStatus) => setRoute({ kind: "form", mode: "create", projectId: route.projectId, createStatus, back: route })}
        />
      )}
      {route.kind === "detail" && (
        <TaskDetail
          theme={theme}
          layout={layout}
          navigation={navigation}
          taskId={route.taskId}
          onBack={() => setRoute(route.back)}
          onEdit={(taskId, projectId) =>
            setRoute({ kind: "form", mode: "edit", taskId, projectId, back: route })
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
          onCancel={() => setRoute(route.back)}
          onSaved={(taskId) => setRoute({ kind: "detail", taskId, back: route.back })}
        />
      )}
    </View>
  );
}
