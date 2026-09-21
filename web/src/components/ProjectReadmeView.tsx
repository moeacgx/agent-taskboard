import { resolveInlineAttachments } from "../inlineAttachments";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  getProjectReadme,
  saveProjectReadme,
  uploadProjectReadmeAttachment,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { Project, ProjectReadme, Task, TaskRelationSummary } from "../types";
import { DescriptionDocument } from "./DescriptionDocument";
import {
  createInlineMediaSegments,
  inlineMediaImages,
  normalizeSegments,
  serializeInlineMedia,
  type InlineMediaSegment,
} from "../documentModel";
import { InlineMediaComposer, type InlineMediaComposerHandle } from "./InlineMediaComposer";
import { LinearIcon } from "./LinearIcon";
import "./ProjectReadmeView.css";

type ProjectReadmeError = string | readonly [string, string];

const PROJECT_INSTRUCTION_PRESETS = [
  {
    id: "code",
    name: "代码开发",
    description: "适合新增功能、修改逻辑和日常开发。",
    content: [
      "## 代码开发要求",
      "- 使用中文回复，并先确认现有实现方式。",
      "- 遵循项目已有结构、命名和代码风格。",
      "- 只修改完成任务所需的内容，避免无关重构。",
      "- 改完后执行相关验证，并说明结果与剩余限制。",
    ].join("\n"),
  },
  {
    id: "ui",
    name: "界面优化",
    description: "适合调整页面、交互、文案和响应式布局。",
    content: [
      "## 界面优化要求",
      "- 使用中文回复，界面文案统一使用中文。",
      "- 保持现有视觉风格和交互习惯，不随意改动业务流程。",
      "- 同时检查常用桌面宽度和窄窗口下的显示。",
      "- 完成后说明实际调整和验证结果。",
    ].join("\n"),
  },
  {
    id: "debug",
    name: "问题排查",
    description: "适合定位报错、异常状态和偶发问题。",
    content: [
      "## 问题排查要求",
      "- 使用中文回复，先给出可核对的根因证据。",
      "- 沿真实调用链定位问题，不把猜测当作结论。",
      "- 优先修复根因，避免扩大到无关模块。",
      "- 修复后复核原失败路径，并说明验证结果。",
    ].join("\n"),
  },
  {
    id: "docs",
    name: "文档整理",
    description: "适合补充说明、更新指南和整理已有内容。",
    content: [
      "## 文档整理要求",
      "- 使用中文，表达简洁、准确并面向实际使用者。",
      "- 以当前代码和真实行为为准，不保留过时说明。",
      "- 保持现有文档结构和术语一致。",
      "- 完成后列出更新内容和已核对的事实。",
    ].join("\n"),
  },
] as const;

interface ProjectReadmeViewProps {
  project: Project;
  paseoMode?: boolean;
  tasks: Task[];
  referenceTasks: Task[];
  revision: number;
  onOpenTask: (task: TaskRelationSummary) => void;
  onError?: (error: ProjectReadmeError | null) => void;
}

export function ProjectReadmeView({
  project,
  paseoMode = false,
  tasks,
  referenceTasks,
  revision,
  onOpenTask,
  onError,
}: ProjectReadmeViewProps) {
  const { text } = useTaskboardI18n();
  const [readme, setReadme] = useState<ProjectReadme | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRequest, setLoadRequest] = useState(0);
  const [editing, setEditing] = useState(false);
  const [segments, setSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments("", referenceTasks),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const composerRef = useRef<InlineMediaComposerHandle>(null);

  useEffect(() => {
    if (editing) return;
    let active = true;
    setSaveError(null);
    setLoadError(null);

    getProjectReadme(project.id)
      .then((data) => {
        if (!active) return;
        setReadme(data);
        setSegments(createInlineMediaSegments(data.content, referenceTasks));
      })
      .catch((err) => {
        if (!active) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoadError(message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [editing, loadRequest, project.id, revision]);

  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }, [editing]);

  function startEditing() {
    if (!readme) return;
    setSegments(createInlineMediaSegments(readme.content, referenceTasks));
    setEditing(true);
    setSaveError(null);
    setSavedNotice(false);
  }

  function cancelEditing() {
    setSegments(createInlineMediaSegments(readme?.content ?? "", referenceTasks));
    setEditing(false);
    setSaveError(null);
  }

  async function save() {
    if (saving || !readme) return;
    const draftContent = serializeInlineMedia(segments);
    const inlineImages = inlineMediaImages(segments);
    if (draftContent === readme.content && inlineImages.length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setSaveError(null);
    onError?.(null);

    try {
      const uploaded = await Promise.all(
        inlineImages.map((image) => uploadProjectReadmeAttachment(project.id, image.file)),
      );
      const resolvedContent = resolveInlineAttachments(
        draftContent,
        inlineImages,
        uploaded,
      );
      const updated = await saveProjectReadme(project.id, resolvedContent, readme.version);
      setReadme(updated);
      setSegments(createInlineMediaSegments(updated.content, referenceTasks));
      setEditing(false);
      setSavedNotice(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "VERSION_CONFLICT") {
        setSaveError(text(
          "项目文档已被其他协作者或 Agent 更新，请刷新后重试。",
          "Project Docs were modified elsewhere. Please refresh and try again.",
        ));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setSaveError(message);
        onError?.(message);
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="project-readme-loading">
        <div className="project-readme-spinner" />
        <p>{text(
          paseoMode ? "正在加载项目说明…" : "正在加载项目文档…",
          paseoMode ? "Loading project instructions…" : "Loading Project Docs…",
        )}</p>
      </div>
    );
  }

  if (loadError && !readme) {
    return (
      <div className="project-readme-loading" role="alert">
        <p>{loadError}</p>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setLoading(true);
            setLoadRequest((current) => current + 1);
          }}
        >
          {text("重试", "Try again")}
        </button>
      </div>
    );
  }

  const content = readme?.content ?? "";
  const draftContent = serializeInlineMedia(segments);

  function applyPreset(template: string) {
    if (saving || draftContent.includes(template)) return;
    const presetSegments = createInlineMediaSegments(
      `${draftContent.trim() ? "\n\n" : ""}${template}`,
      referenceTasks,
    );
    setSegments((current) => normalizeSegments([...current, ...presetSegments]));
    setEditing(true);
    setSaveError(null);
    setSavedNotice(false);
  }

  return (
    <div className="project-readme-container">
      <div className="project-readme-content">
        <header className="project-readme-hero">
          <div className="project-readme-project">
            <LinearIcon name="folder" />
            <span>{text("适用项目", "Applies to")}</span>
            <strong>{project.name}</strong>
          </div>
          <div className="project-readme-heading">
            <div>
              <h1>{text(
                paseoMode ? "给 Agent 的项目说明" : "项目文档",
                paseoMode ? "Project instructions for Agents" : "Project Docs",
              )}</h1>
              <p>{text(
                paseoMode
                  ? "把每个任务都要交代的话写在这里。具体要做什么写在任务里；这里放共用要求。"
                  : "记录这个项目中需要长期保留的说明。",
                paseoMode
                  ? "Write the guidance every task should receive here. Put the specific work in each task; keep shared requirements here."
                  : "Keep durable notes for this project here.",
              )}</p>
            </div>
            {!editing && (
              <button type="button" className="button primary project-readme-edit-button" onClick={startEditing}>
                {text(content ? "编辑说明" : "开始填写", content ? "Edit instructions" : "Start writing")}
              </button>
            )}
          </div>
          {paseoMode && (
            <div className="project-readme-scope">
              <LinearIcon name="check" />
              <div>
                <strong>{text("从看板执行时自动附上", "Automatically included from the board")}</strong>
                <span>{text(
                  "从看板启动或继续本项目任务时，会自动附上已保存的说明。",
                  "Saved instructions are included when this project's tasks are started or continued from the board.",
                )}</span>
              </div>
            </div>
          )}
          {paseoMode && (
            <details className="project-readme-when">
              <summary>{text("何时生效", "When this applies")}</summary>
              <p>{text(
                "同一项目选择不同工作区仍共用这份说明；修改不会影响已经进行中的对话。在 Paseo 原生会话中直接输入时不会自动附加。",
                "All workspaces in this project share these instructions. Changes do not affect conversations already in progress, and direct prompts in native Paseo sessions do not include them automatically.",
              )}</p>
            </details>
          )}
        </header>

        {saveError && (
          <div className="project-readme-alert error" role="alert">
            <LinearIcon name="alert" />
            <span>{saveError}</span>
          </div>
        )}

        {loadError && !editing && (
          <div className="project-readme-alert error" role="alert">
            <LinearIcon name="alert" />
            <span>{loadError}</span>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setLoading(true);
                setLoadRequest((current) => current + 1);
              }}
            >
              {text("重试", "Try again")}
            </button>
          </div>
        )}

        {savedNotice && !editing && paseoMode && (
          <div className="project-readme-saved" role="status">
            <LinearIcon name="check" />
            <span>{text("已保存，下次执行会带上", "Saved and ready for the next run")}</span>
          </div>
        )}

        {paseoMode && (
          <section className="project-readme-presets" aria-labelledby="project-readme-presets-title">
            <div className="project-readme-presets-heading">
              <div>
                <h2 id="project-readme-presets-title">选个预设，直接开始</h2>
                <p>选择后可修改，保存才生效。</p>
              </div>
            </div>
            <div className="project-readme-preset-grid">
              {PROJECT_INSTRUCTION_PRESETS.map((preset) => {
                const added = draftContent.includes(preset.content);
                const appending = Boolean(draftContent.trim());
                return (
                  <article className={`project-readme-preset${added ? " is-added" : ""}`} key={preset.id}>
                    <div>
                      <strong>{preset.name}</strong>
                      <p>{preset.description}</p>
                    </div>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={saving || added}
                      onClick={() => applyPreset(preset.content)}
                    >
                      {added ? "已添加" : appending ? "追加到说明" : "使用预设"}
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {editing ? (
          <div className="issue-description-composer project-readme-editor">
            <InlineMediaComposer
              ref={composerRef}
              segments={segments}
              mentionTasks={tasks}
              referenceTasks={referenceTasks}
              completionContext={{
                projectId: project.id,
                surface: "issue-description",
              }}
              placeholder={text(
                paseoMode ? "写下每个任务都要遵守的共用要求…" : "添加说明...",
                paseoMode ? "Write shared requirements for every task…" : "Add notes...",
              )}
              ariaLabel={text(paseoMode ? "项目说明" : "项目文档", paseoMode ? "Project instructions" : "Project Docs")}
              disabled={saving}
              onChange={setSegments}
              onError={(message) => onError?.(message)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelEditing();
                }
              }}
            />
            <div className="project-readme-editor-actions">
              <button
                type="button"
                className="button secondary"
                disabled={saving}
                onClick={cancelEditing}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? text("保存中…", "Saving…") : text("保存", "Save")}
              </button>
            </div>
          </div>
        ) : content ? (
          <div className="issue-description-read project-readme-document">
            <DescriptionDocument
              value={content}
              referenceTasks={referenceTasks}
              onOpenTask={onOpenTask}
            />
          </div>
        ) : (
          <div className="project-readme-empty">
            <LinearIcon name="file" />
            <strong>{text(paseoMode ? "还没有项目说明" : "还没有项目文档", paseoMode ? "No project instructions yet" : "No project docs yet")}</strong>
            <span>{text(
              paseoMode ? "选上方预设，或自己写一条所有任务都要遵守的要求。" : "开始记录这个项目的长期说明。",
              paseoMode ? "Choose a preset above, or write one requirement every task should follow." : "Start recording durable notes for this project.",
            )}</span>
            <button type="button" className="button primary" onClick={startEditing}>
              {text("开始填写", "Start writing")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
