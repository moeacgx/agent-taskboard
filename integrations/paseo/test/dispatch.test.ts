import assert from "node:assert/strict";
import { test } from "node:test";

import type { PaseoAgentHandle } from "@getpaseo/client";

import * as dashi from "../server/dashi-api.ts";
import {
  buildTaskContinuationMessage,
  buildTaskMessage,
  createTaskDispatchCoordinator,
  sendTaskMessage,
} from "../server/dispatch.ts";
import { createSettingsStore } from "../server/settings.ts";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface TestTaskboardServer {
  listen(options: { host: string; port: number }): Promise<{ port: number }>;
  close(): Promise<void>;
}

async function withTaskboard<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashi-paseo-dispatch-"));
  const module = await import("../../../server/app.mjs") as unknown as {
    createTaskboardServer(options: Record<string, unknown>): TestTaskboardServer;
  };
  const server = module.createTaskboardServer({
    dataDirectory: directory,
    databasePath: path.join(directory, "taskboard.sqlite"),
    attachmentsDirectory: path.join(directory, "attachments"),
    staticDirectory: directory,
  });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function uploadAttachment(
  baseUrl: string,
  target: `tasks/${string}` | `comments/${string}`,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ id: string }> {
  const response = await fetch(`${baseUrl}/api/${target}/attachments`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-taskboard-filename": encodeURIComponent(contentType.startsWith("image/") ? "image.png" : "notes.txt"),
      "x-taskboard-attachment-kind": "inline",
    },
    body: bytes,
  });
  assert.equal(response.status, 201);
  return (await response.json() as { attachment: { id: string } }).attachment;
}

function mockAgentSend() {
  const calls: unknown[][] = [];
  const agent = {
    send: async (...args: unknown[]) => { calls.push(args); },
  } as unknown as PaseoAgentHandle;
  return { agent, calls };
}

async function waitForDistinctCommentTimestamp(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

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

test("buildTaskMessage deduplicates description and human-comment image references and send forwards exact bytes", async () => {
  await withTaskboard(async (baseUrl) => {
    const project = (await dashi.listProjects(baseUrl)).projects[0];
    const created = await dashi.createTask(baseUrl, { projectId: project.id, title: "Image dispatch" });
    const { comment } = await dashi.addComment(baseUrl, created.task.id, "placeholder");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const attachment = await uploadAttachment(baseUrl, `comments/${comment.id}`, bytes, "image/png");
    const reference = `api/attachments/${attachment.id}/content`;

    const updated = await dashi.updateTask(baseUrl, created.task.id, {
      version: created.task.version,
      description: `![image.png](${reference})`,
    });
    const commentResponse = await fetch(`${baseUrl}/api/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: comment.version,
        body: `重复引用：/${reference}\n本地 URL：http://localhost:${new URL(baseUrl).port}/${reference}`,
      }),
    });
    assert.equal(commentResponse.status, 200);

    const message = await buildTaskMessage(baseUrl, updated.task);
    assert.deepEqual(message.images, [{ data: bytes.toString("base64"), mimeType: "image/png" }]);

    const mock = mockAgentSend();
    await sendTaskMessage(mock.agent, message);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0][0], message.prompt);
    assert.deepEqual(mock.calls[0][1], {
      images: [{ data: bytes.toString("base64"), mimeType: "image/png" }],
    });
  });
});

test("sendTaskMessage keeps the one-argument text path when no inline image is referenced", async () => {
  await withTaskboard(async (baseUrl) => {
    const project = (await dashi.listProjects(baseUrl)).projects[0];
    const created = await dashi.createTask(baseUrl, { projectId: project.id, title: "Text dispatch" });
    const message = await buildTaskMessage(baseUrl, created.task);
    assert.deepEqual(message.images, []);

    const mock = mockAgentSend();
    await sendTaskMessage(mock.agent, message);
    assert.deepEqual(mock.calls, [[message.prompt]]);
  });
});

test("continuation image scope uses only the latest human comment", async () => {
  await withTaskboard(async (baseUrl) => {
    const project = (await dashi.listProjects(baseUrl)).projects[0];
    const created = await dashi.createTask(baseUrl, { projectId: project.id, title: "Latest image dispatch" });
    const oldComment = await dashi.addComment(baseUrl, created.task.id, "历史图片");
    const oldBytes = Buffer.from("old-image");
    const oldAttachment = await uploadAttachment(baseUrl, `comments/${oldComment.comment.id}`, oldBytes, "image/png");
    const oldReference = `api/attachments/${oldAttachment.id}/content`;
    const oldUpdate = await fetch(`${baseUrl}/api/comments/${oldComment.comment.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: oldComment.comment.version,
        body: `旧图：![old.png](${oldReference})`,
      }),
    });
    assert.equal(oldUpdate.status, 200);
    await waitForDistinctCommentTimestamp();

    const latestComment = await dashi.addComment(baseUrl, created.task.id, "本轮新图");
    const latestBytes = Buffer.from("latest-image");
    const latestAttachment = await uploadAttachment(baseUrl, `comments/${latestComment.comment.id}`, latestBytes, "image/jpeg");
    const latestReference = `api/attachments/${latestAttachment.id}/content`;
    const latestUpdate = await fetch(`${baseUrl}/api/comments/${latestComment.comment.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: latestComment.comment.version,
        body: `本轮新图：![latest.jpg](${latestReference})`,
      }),
    });
    assert.equal(latestUpdate.status, 200);

    const firstMessage = await buildTaskMessage(baseUrl, created.task);
    assert.deepEqual(firstMessage.images, [{ data: latestBytes.toString("base64"), mimeType: "image/jpeg" }]);
    assert.match(firstMessage.prompt, /历史图片附件/);
    assert.doesNotMatch(firstMessage.prompt, new RegExp(`api/attachments/${oldAttachment.id}/content`));

    const continuation = await buildTaskMessage(baseUrl, created.task, { continuation: true });
    assert.deepEqual(continuation.images, [{ data: latestBytes.toString("base64"), mimeType: "image/jpeg" }]);
    assert.match(continuation.prompt, /本轮新图/);
    assert.doesNotMatch(continuation.prompt, new RegExp(`api/attachments/${oldAttachment.id}/content`));
  });
});

test("keeps both images referenced by the same latest human comment", async () => {
  await withTaskboard(async (baseUrl) => {
    const project = (await dashi.listProjects(baseUrl)).projects[0];
    const created = await dashi.createTask(baseUrl, { projectId: project.id, title: "Two latest images" });
    const comment = await dashi.addComment(baseUrl, created.task.id, "占位");
    const firstBytes = Buffer.from("first-latest-image");
    const secondBytes = Buffer.from("second-latest-image");
    const first = await uploadAttachment(baseUrl, `comments/${comment.comment.id}`, firstBytes, "image/png");
    const second = await uploadAttachment(baseUrl, `comments/${comment.comment.id}`, secondBytes, "image/webp");
    const firstReference = `api/attachments/${first.id}/content`;
    const secondReference = `api/attachments/${second.id}/content`;
    const updated = await fetch(`${baseUrl}/api/comments/${comment.comment.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: comment.comment.version,
        body: `本轮两图：![one](${firstReference}) ![two](${secondReference})`,
      }),
    });
    assert.equal(updated.status, 200);

    const message = await buildTaskMessage(baseUrl, created.task, { continuation: true });
    assert.deepEqual(message.images, [
      { data: firstBytes.toString("base64"), mimeType: "image/png" },
      { data: secondBytes.toString("base64"), mimeType: "image/webp" },
    ]);
  });
});

test("first description image is retained while a pure-text explicit continuation sends no image", async () => {
  await withTaskboard(async (baseUrl) => {
    const project = (await dashi.listProjects(baseUrl)).projects[0];
    const created = await dashi.createTask(baseUrl, { projectId: project.id, title: "Description image" });
    const bytes = Buffer.from("description-image");
    const attachment = await uploadAttachment(baseUrl, `tasks/${created.task.id}`, bytes, "image/png");
    const reference = `api/attachments/${attachment.id}/content`;
    const updated = await dashi.updateTask(baseUrl, created.task.id, {
      version: created.task.version,
      description: `任务原图：![description.png](${reference})`,
    });

    const firstMessage = await buildTaskMessage(baseUrl, updated.task);
    assert.deepEqual(firstMessage.images, [{ data: bytes.toString("base64"), mimeType: "image/png" }]);

    const continuation = await buildTaskContinuationMessage(baseUrl, updated.task, "继续处理文字要求");
    assert.deepEqual(continuation.images, []);
    assert.match(continuation.prompt, /继续处理文字要求/);
  });
});

test("missing or non-image references fail before move, arm, or send", async () => {
  await withTaskboard(async (baseUrl) => {
    const project = (await dashi.listProjects(baseUrl)).projects[0];
    const created = await dashi.createTask(baseUrl, { projectId: project.id, title: "Invalid image" });
    let armCount = 0;
    const mock = mockAgentSend();
    const prepareThenDispatch = async (task: typeof created.task) => {
      const message = await buildTaskMessage(baseUrl, task);
      await dashi.moveTask(baseUrl, task.id, { version: task.version, status: "in_progress" });
      armCount += 1;
      await sendTaskMessage(mock.agent, message);
    };

    const missing = await dashi.updateTask(baseUrl, created.task.id, {
      version: created.task.version,
      description: "![missing](api/attachments/missing-image/content)",
    });
    await assert.rejects(() => prepareThenDispatch(missing.task), /不存在或不属于当前任务/);
    assert.equal((await dashi.getTask(baseUrl, created.task.id)).task.status, "backlog");

    const text = await uploadAttachment(baseUrl, `tasks/${created.task.id}`, Buffer.from("not an image"), "text/plain");
    const invalid = await dashi.updateTask(baseUrl, created.task.id, {
      version: missing.task.version,
      description: `![invalid](/api/attachments/${text.id}/content)`,
    });
    await assert.rejects(() => prepareThenDispatch(invalid.task), /不是图片/);
    assert.equal((await dashi.getTask(baseUrl, created.task.id)).task.status, "backlog");

    assert.equal(armCount, 0);
    assert.equal(mock.calls.length, 0);
  });
});
