import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import { z } from "zod";

import { bridgeRequest } from "../shared/contracts";

export const taskMessageImagesSchema = z.object({
  text: z.string(),
  images: z.array(z.object({
    id: z.string(),
    filename: z.string(),
  })),
});

type TaskMessageImagesData = z.output<typeof taskMessageImagesSchema>;
type TimelineProps = PluginTimelineItemProps<TaskMessageImagesData>;

function contentType(headers: Record<string, string>): string | null {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type");
  const value = entry?.[1]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return value.startsWith("image/") ? value : null;
}

function TimelineImage(props: {
  id: string;
  filename: string;
  compact: boolean;
  theme: TimelineProps["theme"];
}) {
  const { id, filename, compact, theme } = props;
  const request = useRpc(bridgeRequest);
  const requestRef = useRef(request);
  requestRef.current = request;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; uri: string }
    | { status: "error" }
  >({ status: "loading" });
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void requestRef.current({
      method: "GET",
      path: `/api/attachments/${encodeURIComponent(id)}/content`,
      headers: {},
      body: null,
    }).then((response) => {
      if (!active) return;
      if (response.status < 200 || response.status >= 300 || response.body.kind !== "base64") {
        setState({ status: "error" });
        return;
      }
      const mimeType = contentType(response.headers);
      if (!mimeType) {
        setState({ status: "error" });
        return;
      }
      setState({
        status: "ready",
        uri: `data:${mimeType};base64,${response.body.value}`,
      });
    }).catch(() => {
      if (active) setState({ status: "error" });
    });
    return () => {
      active = false;
    };
  }, [attempt, id]);

  const styles = useMemo(() => ({
    frame: {
      width: "100%" as const,
      height: compact ? 180 : 240,
      borderRadius: 8,
      overflow: "hidden" as const,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    image: { width: "100%" as const, height: "100%" as const },
    filename: { color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" as const },
    retry: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const, marginTop: 8 },
    modal: { width: "100%" as const, alignSelf: "stretch" as const, backgroundColor: theme.colors.surface0 },
    modalContent: {
      width: "100%" as const,
      alignSelf: "stretch" as const,
      alignItems: "stretch" as const,
      justifyContent: "center" as const,
      flexGrow: 1,
    },
    modalImageFrame: { width: "100%" as const, alignSelf: "stretch" as const, height: compact ? 360 : 480 },
    modalImage: { width: "100%" as const, height: "100%" as const },
  }), [compact, theme]);

  return (
    <>
      <View style={styles.frame}>
        {state.status === "loading" && <ActivityIndicator color={theme.colors.accent} />}
        {state.status === "error" && (
          <View style={{ alignItems: "center", padding: 16 }}>
            <Text style={styles.filename}>{filename}</Text>
            <Pressable accessibilityRole="button" onPress={() => setAttempt((value) => value + 1)}>
              <Text style={styles.retry}>重新加载</Text>
            </Pressable>
          </View>
        )}
        {state.status === "ready" && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`查看大图：${filename}`}
            style={{ width: "100%", height: "100%" }}
            onPress={() => setPreviewOpen(true)}
          >
            <Image
              source={{ uri: state.uri }}
              style={styles.image}
              resizeMode="contain"
              onError={() => setState({ status: "error" })}
            />
          </Pressable>
        )}
      </View>
      <Modal title={filename} open={previewOpen} onOpenChange={setPreviewOpen}>
        <Modal.Content style={styles.modal} contentContainerStyle={styles.modalContent} scrollable={false}>
          {state.status === "ready" && (
            <View style={styles.modalImageFrame}>
              <Image
                source={{ uri: state.uri }}
                style={styles.modalImage}
                resizeMode="contain"
                onError={() => {
                  setPreviewOpen(false);
                  setState({ status: "error" });
                }}
              />
            </View>
          )}
        </Modal.Content>
      </Modal>
    </>
  );
}

export function TaskMessageImages({ item, theme, layout }: TimelineProps) {
  const styles = useMemo(() => ({
    card: { gap: 10, maxWidth: layout.compact ? "100%" as const : 720 },
    images: { gap: 8 },
    text: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 },
  }), [layout.compact, theme]);

  return (
    <View style={styles.card}>
      {item.data.images.length > 0 && (
        <View style={styles.images}>
          {item.data.images.map((image) => (
            <TimelineImage
              key={image.id}
              id={image.id}
              filename={image.filename}
              compact={layout.compact}
              theme={theme}
            />
          ))}
        </View>
      )}
      {item.data.text.length > 0 && <Text selectable style={styles.text}>{item.data.text}</Text>}
    </View>
  );
}
