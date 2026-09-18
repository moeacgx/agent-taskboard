import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

import type { PluginLayout } from "./types";

export function ConnectionGate(props: {
  theme: PluginTheme;
  layout: PluginLayout;
  message: string;
  baseUrl: string | null;
  onRetry: () => void;
}) {
  const { theme, layout, message, baseUrl, onRetry } = props;
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: layout.compact ? 20 : 32,
        gap: 12,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 17 : 19, fontWeight: "600" as const },
      body: { color: theme.colors.foregroundMuted, fontSize: 14, textAlign: "center" as const, lineHeight: 20 },
      baseUrl: { color: theme.colors.foregroundMuted, fontSize: 12 },
      button: {
        marginTop: 8,
        paddingVertical: 10,
        paddingHorizontal: 18,
        borderRadius: 10,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>未连接到任务看板服务</Text>
      <Text style={styles.body}>{message}</Text>
      {baseUrl ? <Text style={styles.baseUrl}>目标地址: {baseUrl}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="重试连接"
        onPress={onRetry}
        style={styles.button}
      >
        <Text style={styles.buttonText}>重试</Text>
      </Pressable>
    </View>
  );
}
