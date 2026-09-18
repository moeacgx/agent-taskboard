import type { PluginClientContext } from "@getpaseo/plugin/client";

import { TaskboardApp } from "./client/App";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", TaskboardApp);
  client.addSidebarItem({
    id: "main",
    title: "任务看板",
    icon: "ListTodo",
    surface: "main",
  });
  return () => {};
}
