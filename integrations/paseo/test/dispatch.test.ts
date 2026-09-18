import assert from "node:assert/strict";
import { test } from "node:test";

import { createTaskDispatchCoordinator } from "../server/dispatch.ts";
import { createSettingsStore } from "../server/settings.ts";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("serializes duplicate dispatches for one task and only starts one turn", async () => {
  let starts = 0;
  const coordinator = createTaskDispatchCoordinator();
  const start = () => {
    starts += 1;
    return new Promise<string>((resolve) => setTimeout(() => resolve("started"), 10));
  };

  const [first, second] = await Promise.all([
    coordinator.run("task-1", start),
    coordinator.run("task-1", start),
  ]);

  assert.equal(starts, 1);
  assert.equal(first, "started");
  assert.equal(second, "started");
});

test("does not share a lock between different tasks", async () => {
  const order: string[] = [];
  const coordinator = createTaskDispatchCoordinator();
  await Promise.all([
    coordinator.run("task-a", async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("a-end");
    }),
    coordinator.run("task-b", async () => {
      order.push("b-start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("b-end");
    }),
  ]);

  assert.deepEqual(order.slice(0, 2).sort(), ["a-start", "b-start"]);
});

test("project defaults keep the full selected profile after a fresh store read", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashi-paseo-settings-"));
  const filePath = path.join(directory, "settings.json");
  try {
    const first = createSettingsStore({ filePath });
    await first.upsert({
      projectId: "project-1",
      workspacePath: "C:/workspace/project-1",
      profile: {
        id: "qa-tester",
        name: "QA tester",
        provider: "codex",
        model: "gpt-5.6-sol",
        modeId: "full-access",
        thinkingOptionId: "high",
        featureValues: { browser: true },
      },
      updatedAt: "ignored",
    });

    const reopened = createSettingsStore({ filePath });
    const saved = await reopened.get("project-1");
    assert.equal(saved?.workspacePath, "C:/workspace/project-1");
    assert.equal(saved?.profile?.model, "gpt-5.6-sol");
    assert.equal(saved?.profile?.modeId, "full-access");
    assert.equal(saved?.profile?.thinkingOptionId, "high");
    assert.deepEqual(saved?.profile?.featureValues, { browser: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
