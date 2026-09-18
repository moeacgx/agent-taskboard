import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createBindingsStore } from "./server/bindings";
import { registerHandlers } from "./server/handlers";
import { registerLifecycle } from "./server/lifecycle";
import { createSettingsStore } from "./server/settings";
import { createTaskPlansStore } from "./server/task-plans";
import { createTaskDispatchCoordinator, createTaskMutationLock } from "./server/dispatch";
import { createPaseoAutomationRuntime } from "./server/automation";

export default function contribute(server: PluginServerContext) {
  const bindings = createBindingsStore();
  const settings = createSettingsStore();
  const plans = createTaskPlansStore();
  const coordinator = createTaskDispatchCoordinator();
  const mutationLock = createTaskMutationLock();
  const automation = createPaseoAutomationRuntime(settings, plans, bindings, coordinator, mutationLock);
  registerHandlers(server, bindings, settings, plans, coordinator, automation, mutationLock);
  registerLifecycle(server, bindings, (paseo) => automation.attach(paseo), mutationLock);
  return () => automation.stop();
}
