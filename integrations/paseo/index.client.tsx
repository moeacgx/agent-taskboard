import type { PluginClientContext } from "@getpaseo/plugin/client";

import { TaskboardApp } from "./client/App";
import { TaskMessageImages, taskMessageImagesSchema } from "./client/TaskMessageImages";
import { parseDashiTaskMessageImages } from "./shared/task-message-images";

export default function contribute(client: PluginClientContext) {
  const removeSurface = client.addSurface("main", TaskboardApp);
  const removeSidebarItem = client.addSidebarItem({
    id: "main",
    title: "任务看板",
    icon: "ListTodo",
    surface: "main",
  });
  const removeTransformer = client.addTimelineTransformer({
    id: "dashi-task-message-images",
    query: { itemType: "user_message" },
    transform({ item }) {
      const data = parseDashiTaskMessageImages(item.text);
      if (!data) return undefined;
      return {
        items: [{
          type: "plugin",
          kind: "dashi-task-message-images",
          version: 1,
          data,
        }],
      };
    },
  });
  const removeRenderer = client.addTimelineRenderer({
    kind: "dashi-task-message-images",
    version: 1,
    schema: taskMessageImagesSchema,
    Component: TaskMessageImages,
  });
  return () => {
    removeRenderer();
    removeTransformer();
    removeSidebarItem();
    removeSurface();
  };
}
