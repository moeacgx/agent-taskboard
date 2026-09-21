import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createBindingsStore } from "./server/bindings";
import { registerHandlers } from "./server/handlers";
import { registerLifecycle } from "./server/lifecycle";
import { createSettingsStore } from "./server/settings";
import { createTaskPlansStore } from "./server/task-plans";
import { createTaskDispatchCoordinator, createTaskMutationLock } from "./server/dispatch";
import { createPaseoAutomationRuntime } from "./server/automation";
import { configureDashiReadyGate } from "./server/dashi-api";
import { createDashiServiceManager } from "./server/dashi-service";
import { PLUGIN_RUNTIME_ROOT } from "./server/plugin-installation.generated";

export default function contribute(server: PluginServerContext) {
  const dashiService = createDashiServiceManager({
    moduleUrl: import.meta.url,
    runtimeRoot: PLUGIN_RUNTIME_ROOT ?? undefined,
  });
  configureDashiReadyGate(dashiService);
  void dashiService.start().catch((error) => {
    console.error("[dashi-taskboard] Dashi 服务自动启动失败", error);
  });
  const bindings = createBindingsStore();
  const settings = createSettingsStore();
  const plans = createTaskPlansStore();
  const coordinator = createTaskDispatchCoordinator();
  const mutationLock = createTaskMutationLock();
  const automation = createPaseoAutomationRuntime(settings, plans, bindings, coordinator, mutationLock);
  registerHandlers(server, bindings, settings, plans, coordinator, automation, mutationLock);
  registerLifecycle(server, bindings, (paseo) => automation.attach(paseo), mutationLock);
  return async () => {
    await automation.stop();
    configureDashiReadyGate(null);
    await dashiService.stop();
  };
}
