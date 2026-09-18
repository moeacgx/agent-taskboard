import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import * as contracts from "../shared/contracts";
import { useRpcQuery } from "./hooks";
import type { PluginLayout } from "./types";

export function ProjectList(props: {
  theme: PluginTheme;
  layout: PluginLayout;
  onSelectProject: (projectId: string | null, projectName: string) => void;
}) {
  const { theme, layout, onSelectProject } = props;
  const listProjects = useRpc(contracts.listProjects);
  const query = useRpcQuery(listProjects, {});

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
    }),
    [theme, layout.compact],
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={styles.header}>
        <Text style={styles.title}>任务看板</Text>
        <Text style={styles.subtitle}>选择项目查看任务，或直接查看全部任务</Text>
      </View>

      {query.error && <Text style={styles.errorText}>加载项目失败: {query.error}</Text>}

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
          <Pressable
            key={project.id}
            accessibilityRole="button"
            onPress={() => onSelectProject(project.id, project.name)}
            style={styles.card}
          >
            <Text style={styles.cardTitle}>{project.name}</Text>
            <Text style={styles.cardMeta}>
              {project.issueCount} 个任务{project.workspacePath ? ` · ${project.workspacePath}` : ""}
            </Text>
          </Pressable>
        ))}

        {!query.loading && query.data?.projects.length === 0 && (
          <Text style={styles.muted}>还没有项目。请先在 dashi-taskboard 里创建一个项目。</Text>
        )}
      </View>
    </ScrollView>
  );
}
