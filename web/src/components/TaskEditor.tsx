import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  taskPriorityLabel,
  taskStatusLabel,
  useTaskboardI18n,
  type TaskboardLanguage,
} from "../i18n";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ActorIdentity,
  type DevelopmentContext,
  type DevelopmentScan,
  type Recurrence,
  type Task,
  type TaskDraft,
  type TaskPriority,
  type TaskStatus,
} from "../types";
import {
  CODEX_AGENT_ACTOR,
  actorKey,
  assigneeTargetForActor,
} from "../actors";
import {
  PaseoAssigneePicker,
  type PaseoAssigneeOption,
} from "./PaseoAssigneePicker";
import {
  PaseoConfigurationFields,
  type PaseoConfigurationSelection,
} from "./PaseoConfigurationFields";
import type {
  PaseoConfigurationOptions,
  PaseoConfigurationOptionsRequest,
} from "../paseo-bridge";
import { PaseoWorktreeDialog } from "./PaseoWorktreeDialog";
import { PaseoWorkspacePicker, type PaseoWorkspaceOption } from "./PaseoWorkspacePicker";
import { ActorAvatar } from "./ActorAvatar";
import { LabelPicker } from "./LabelPicker";
import { IssuePickerContent } from "./IssueRelations";
import { LinearIcon } from "./LinearIcon";
import {
  AttachmentIcon,
  BranchIcon,
  DueDateIcon,
  MoreIcon,
  PlusIcon,
  PriorityIcon,
  RecurrenceIcon,
  RelationIcon,
  StatusIcon,
} from "./SemanticIcons";
import {
  createInlineMediaSegments,
  inlineMediaFiles,
  inlineMediaImages,
  serializeInlineMedia,
  type InlineMediaSegment,
  type PendingInlineAttachment,
  type PendingInlineImage,
} from "../documentModel";
import { InlineMediaComposer, type InlineMediaComposerHandle } from "./InlineMediaComposer";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";

const RECURRENCE_UNITS: Record<TaskboardLanguage, Record<Recurrence["unit"], string>> = {
  zh: {
    day: "天",
    week: "周",
    month: "月",
    year: "年",
  },
  en: {
    day: "day",
    week: "week",
    month: "month",
    year: "year",
  },
};

type TaskEditorError = string | readonly [string, string];
type DraftRelationMenu = "parent" | "related" | "subIssue";

export interface NewTaskRelationDraft {
  parentId: string | null;
  relatedIds: string[];
  subIssueIds: string[];
}

export interface NewTaskCreateOptions {
  keepOpen: boolean;
  relations: NewTaskRelationDraft;
  paseoAssigneeId?: string;
  paseoWorkspacePath?: string;
  paseoModeId?: string;
  paseoThinkingOptionId?: string;
}

export interface NewTaskEditorDraft {
  title: string;
  descriptionSegments: InlineMediaSegment[];
  status: TaskStatus;
  priority: TaskPriority;
  assignee: ActorIdentity;
  selectedLabels: string[];
  developmentContext: DevelopmentContext | null;
  startDate: string;
  dueDate: string;
  recurrence: Recurrence | null;
  relations: NewTaskRelationDraft;
}

interface TaskEditorProps {
  projectId: string | null;
  projectOptions?: Array<{ id: string; name: string }>;
  onProjectChange?: (projectId: string | null) => void;
  tasks: Task[];
  referenceTasks: Task[];
  initialStatus: TaskStatus;
  initialDraft: NewTaskEditorDraft | null;
  labels: string[];
  currentUser: ActorIdentity;
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  paseoAssignee?: {
    options: PaseoAssigneeOption[];
    loading: boolean;
    error: string | null;
    onRefresh: () => void;
  };
  paseoConfiguration?: {
    loadOptions: (target: PaseoConfigurationOptionsRequest) => Promise<PaseoConfigurationOptions>;
    onOpenAgent: (agentId: string) => void;
  };
  paseoWorkspaces?: PaseoWorkspaceOption[];
  paseoWorktree?: {
    onCreated: (context: DevelopmentContext) => void;
  };
  mergeSources?: Task[];
  mergeStartAfterSave?: boolean;
  onCreateLabel: (label: string) => Promise<void>;
  onCancel: (draft: NewTaskEditorDraft | null) => void;
  onSave: (
    draft: TaskDraft,
    inlineFiles: PendingInlineAttachment[],
    inlineImages: PendingInlineImage[],
    createOptions?: NewTaskCreateOptions,
  ) => Promise<void>;
}

function isoDate(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function dateFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function endOfWeek(): string {
  const date = new Date();
  const daysUntilFriday = (5 - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + daysUntilFriday);
  return isoDate(date);
}

function displayDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

function contextValue(context: DevelopmentContext | null): string {
  return context ? JSON.stringify(context) : "";
}

function contextLabel(
  context: DevelopmentContext,
  text: (chinese: string, english: string) => string,
): string {
  if (context.type === "branch") return context.branch;
  const folder = context.path.split(/[\\/]/).filter(Boolean).at(-1) ?? context.path;
  return `${context.branch ?? text("分离 HEAD", "detached")} · ${folder}`;
}

export function TaskEditor({
  projectId,
  projectOptions,
  onProjectChange,
  tasks,
  referenceTasks,
  initialStatus,
  initialDraft,
  labels: availableLabels,
  currentUser,
  developmentScan,
  developmentScanLoading,
  paseoAssignee,
  paseoConfiguration,
  paseoWorkspaces = [],
  paseoWorktree,
  mergeSources = [],
  mergeStartAfterSave = false,
  onCreateLabel,
  onCancel,
  onSave,
}: TaskEditorProps) {
  const { language, locale, text } = useTaskboardI18n();
  const mergingIdeas = mergeSources.length >= 2;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const backdropPointerRef = useRef({ down: false, up: false });
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionComposerRef = useRef<InlineMediaComposerHandle>(null);
  const createSubmitIntentRef = useRef(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [descriptionSegments, setDescriptionSegments] = useState<InlineMediaSegment[]>(
    () => initialDraft?.descriptionSegments ?? createInlineMediaSegments(),
  );
  const [status, setStatus] = useState<TaskStatus>(initialStatus);
  const [priority, setPriority] = useState<TaskPriority>(initialDraft?.priority ?? "none");
  const [assignee, setAssignee] = useState<ActorIdentity>(initialDraft?.assignee ?? currentUser);
  const [paseoAssigneeId, setPaseoAssigneeId] = useState("paseo:project-default");
  const [paseoPlanTouched, setPaseoPlanTouched] = useState(false);
  const [paseoWorkspaceId, setPaseoWorkspaceId] = useState("");
  const [paseoConfigurationSelection, setPaseoConfigurationSelection] = useState<PaseoConfigurationSelection>({});
  const [paseoConfigurationReady, setPaseoConfigurationReady] = useState(false);
  const [selectedLabels, setSelectedLabels] = useState<string[]>(initialDraft?.selectedLabels ?? []);
  const [developmentContext, setDevelopmentContext] = useState<DevelopmentContext | null>(initialDraft?.developmentContext ?? null);
  const [startDate] = useState(initialDraft?.startDate ?? "");
  const [dueDate, setDueDate] = useState(initialDraft?.dueDate ?? "");
  const [recurrence, setRecurrence] = useState<Recurrence | null>(initialDraft?.recurrence ?? null);
  const [parentId, setParentId] = useState<string | null>(initialDraft?.relations.parentId ?? null);
  const [relatedIds, setRelatedIds] = useState<string[]>(initialDraft?.relations.relatedIds ?? []);
  const [subIssueIds, setSubIssueIds] = useState<string[]>(initialDraft?.relations.subIssueIds ?? []);
  const [createMore, setCreateMore] = useState(false);
  const [menu, setMenu] = useState<"project" | "status" | "priority" | "assignee" | "labels" | "development" | "paseo-workspace" | "more" | "due" | "recurrence" | null>(null);
  const [relationMenu, setRelationMenu] = useState<DraftRelationMenu | null>(null);
  const [moreMenuPosition, setMoreMenuPosition] = useState<{ right: number; bottom: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<TaskEditorError | null>(null);
  const [attachmentError, setAttachmentError] = useState<TaskEditorError | null>(null);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [createdPaseoWorkspace, setCreatedPaseoWorkspace] = useState<{
    id: string;
    name: string | null;
    path: string;
    projectWorkspace: boolean;
    kind: "workspace";
  } | null>(null);

  const developmentOptions = useMemo(() => {
    const options = [...developmentScan.contexts];
    if (developmentContext && !options.some((option) => contextValue(option) === contextValue(developmentContext))) {
      options.unshift(developmentContext);
    }
    return options;
  }, [developmentContext, developmentScan.contexts]);

  const taskById = useMemo(() => new Map(tasks.map((candidate) => [candidate.id, candidate])), [tasks]);
  const availableRelationTasks = tasks.filter((candidate) => candidate.archivedAt === null);
  const selectedParent = parentId ? taskById.get(parentId) ?? null : null;
  const selectedRelated = relatedIds
    .map((id) => taskById.get(id))
    .filter((candidate): candidate is Task => candidate !== undefined);
  const selectedSubIssues = subIssueIds
    .map((id) => taskById.get(id))
    .filter((candidate): candidate is Task => candidate !== undefined);
  const selectedRelationChips = [
    ...selectedSubIssues.map((issue) => ({ type: "subIssue" as const, issue })),
    ...(selectedParent ? [{ type: "parent" as const, issue: selectedParent }] : []),
    ...selectedRelated.map((issue) => ({ type: "related" as const, issue })),
  ];
  const selectedParentAncestorIds = useMemo(() => {
    const ids = new Set<string>();
    let currentId = parentId;
    while (currentId && !ids.has(currentId)) {
      ids.add(currentId);
      currentId = taskById.get(currentId)?.relations.parent?.id ?? null;
    }
    return ids;
  }, [parentId, taskById]);
  const selectedSubIssueDescendantIds = useMemo(() => {
    const ids = new Set<string>();
    const queue = [...subIssueIds];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (ids.has(currentId)) continue;
      ids.add(currentId);
      queue.push(...(taskById.get(currentId)?.relations.subIssues.map((item) => item.id) ?? []));
    }
    return ids;
  }, [subIssueIds, taskById]);
  const parentCandidates = availableRelationTasks.filter((candidate) => (
    !selectedSubIssueDescendantIds.has(candidate.id)
  ));
  const relatedCandidates = availableRelationTasks;
  const subIssueCandidates = availableRelationTasks.filter((candidate) => (
    !selectedParentAncestorIds.has(candidate.id)
  ));
  const relationCandidates = relationMenu === "parent"
    ? parentCandidates
    : relationMenu === "related"
      ? relatedCandidates
      : subIssueCandidates;
  const selectedRelationIds = new Set(
    relationMenu === "parent"
      ? parentId ? [parentId] : []
      : relationMenu === "related"
        ? relatedIds
        : subIssueIds,
  );

  const assigneeOptions = [currentUser, CODEX_AGENT_ACTOR]
    .filter((actor, index, actors) => (
      actors.findIndex((candidate) => actorKey(candidate) === actorKey(actor)) === index
    ));

  const paseoNeedsWorkspace = Boolean(
    paseoAssignee?.options.find((option) => option.id === paseoAssigneeId)?.requiresWorkspace,
  );
  const availablePaseoWorkspaces = useMemo(() => [
    ...(createdPaseoWorkspace ? [createdPaseoWorkspace] : []),
    ...paseoWorkspaces.filter((workspace) => workspace.id !== createdPaseoWorkspace?.id),
  ], [createdPaseoWorkspace, paseoWorkspaces]);
  const selectedPaseoWorkspace = availablePaseoWorkspaces.find((workspace) => workspace.id === paseoWorkspaceId) ?? null;
  const selectedPaseoAssignee = paseoAssignee?.options.find((option) => option.id === paseoAssigneeId) ?? null;
  const paseoConfigurationTarget = selectedPaseoAssignee?.provider && selectedPaseoAssignee.model
    ? {
        provider: selectedPaseoAssignee.provider,
        model: selectedPaseoAssignee.model,
        workspacePath: selectedPaseoAssignee.workspacePath ?? selectedPaseoWorkspace?.path ?? null,
        ...(selectedPaseoAssignee.agentId ? { agentId: selectedPaseoAssignee.agentId } : {}),
        ...(selectedPaseoAssignee.modeId ? { modeId: selectedPaseoAssignee.modeId } : {}),
        ...(selectedPaseoAssignee.thinkingOptionId ? { thinkingOptionId: selectedPaseoAssignee.thinkingOptionId } : {}),
      }
    : null;
  const worktreeRepositoryPath = developmentContext?.type === "worktree"
    ? developmentContext.path
    : selectedPaseoWorkspace?.path ?? null;

  useEffect(() => {
    dialogRef.current?.showModal();
    titleRef.current?.focus();
    return () => {
      if (dialogRef.current?.open) dialogRef.current.close();
    };
  }, []);

  useEffect(() => {
    if (menu !== "more" && menu !== "due" && menu !== "recurrence") return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [menu]);

  useEffect(() => {
    if (menu !== "more") {
      setRelationMenu(null);
      setMoreMenuPosition(null);
    }
  }, [menu]);

  function toggleDraftRelation(candidate: Task) {
    if (relationMenu === "parent") {
      setParentId((current) => current === candidate.id ? null : candidate.id);
    } else if (relationMenu === "related") {
      setRelatedIds((current) => current.includes(candidate.id)
        ? current.filter((id) => id !== candidate.id)
        : [...current, candidate.id]);
    } else if (relationMenu === "subIssue") {
      setSubIssueIds((current) => current.includes(candidate.id)
        ? current.filter((id) => id !== candidate.id)
        : [...current, candidate.id]);
    }
  }

  function toggleMoreMenu() {
    setRelationMenu(null);
    if (menu === "more") {
      setMenu(null);
      return;
    }
    const rect = moreMenuRef.current?.getBoundingClientRect();
    setMoreMenuPosition(rect ? {
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.top + 8,
    } : null);
    setMenu("more");
  }

  useEffect(() => {
    const titleElement = titleRef.current;
    if (!titleElement) return;
    const resizeTitle = () => {
      titleElement.style.height = "0px";
      titleElement.style.height = `${titleElement.scrollHeight}px`;
    };
    resizeTitle();

    let titleWidth = titleElement.clientWidth;
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      const nextWidth = titleElement.clientWidth;
      if (nextWidth === titleWidth) return;
      titleWidth = nextWidth;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resizeTitle);
    });
    observer.observe(titleElement);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
    };
  }, [title]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createSubmitIntentRef.current) return;
    createSubmitIntentRef.current = false;
    if (projectOptions && !projectId) {
      setError(["请选择项目。", "Select a project."]);
      return;
    }
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError([
        "请为议题填写一个简短、明确的标题。",
        "Enter a short, clear issue title.",
      ]);
      titleRef.current?.focus();
      return;
    }
    if (recurrence && !dueDate) {
      setError([
        "重复议题需要先设置最早截止日期。",
        "A recurring issue needs an initial due date.",
      ]);
      return;
    }
    if (paseoConfigurationTarget && !paseoConfigurationReady) {
      setError("正在读取 Paseo Thinking/Mode 选项，请稍后重试。");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const assigneeTarget = paseoAssignee
        ? paseoAssigneeId === "paseo:self" ? "current-user" : undefined
        : assigneeTargetForActor(assignee, currentUser);
      const descriptionValue = serializeInlineMedia(descriptionSegments).trim();
      await onSave({
        title: cleanTitle,
        description: descriptionValue,
        status,
        priority,
        labels: selectedLabels,
        ...(assigneeTarget ? { assigneeTarget } : {}),
        developmentContext,
        startDate: startDate || null,
        dueDate: dueDate || null,
        recurrence,
      }, inlineMediaFiles(descriptionSegments), inlineMediaImages(descriptionSegments), {
        keepOpen: createMore,
        relations: { parentId, relatedIds, subIssueIds },
        ...(paseoAssignee && paseoPlanTouched ? { paseoAssigneeId } : {}),
        ...(paseoAssignee && paseoPlanTouched && selectedPaseoWorkspace
          ? { paseoWorkspacePath: selectedPaseoWorkspace.path }
          : {}),
        ...(paseoPlanTouched && paseoConfigurationSelection.modeId
          ? { paseoModeId: paseoConfigurationSelection.modeId }
          : {}),
        ...(paseoPlanTouched && paseoConfigurationSelection.thinkingOptionId
          ? { paseoThinkingOptionId: paseoConfigurationSelection.thinkingOptionId }
          : {}),
      });
      if (createMore) {
        setTitle("");
        setDescriptionSegments(createInlineMediaSegments());
        setSubIssueIds([]);
        setRelationMenu(null);
        setAttachmentError(null);
        if (attachmentInputRef.current) attachmentInputRef.current.value = "";
        requestAnimationFrame(() => titleRef.current?.focus());
      }
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : ["无法保存这个议题。", "Could not save this issue."]);
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.defaultPrevented) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter") return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      createSubmitIntentRef.current = true;
      event.currentTarget.requestSubmit();
      return;
    }
    if (event.target !== titleRef.current) return;
    event.preventDefault();
  }

  function chooseDueDate(value: string) {
    setDueDate(value);
    setMenu(null);
  }

  function cancelEditor() {
    onCancel({
      title,
      descriptionSegments,
      status,
      priority,
      assignee,
      selectedLabels,
      developmentContext,
      startDate,
      dueDate,
      recurrence,
      relations: { parentId, relatedIds, subIssueIds },
    });
  }

  return (
    <dialog
      ref={dialogRef}
      className={`task-dialog${expanded ? " is-expanded" : ""}`}
      aria-labelledby="task-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) cancelEditor();
      }}
      onPointerDown={(event) => {
        backdropPointerRef.current = {
          down: event.target === event.currentTarget,
          up: false,
        };
      }}
      onPointerUp={(event) => {
        backdropPointerRef.current.up = event.target === event.currentTarget;
      }}
      onPointerCancel={() => {
        backdropPointerRef.current = { down: false, up: false };
      }}
      onClick={(event) => {
        const backdropClick = backdropPointerRef.current.down
          && backdropPointerRef.current.up
          && event.target === event.currentTarget;
        backdropPointerRef.current = { down: false, up: false };
        if (backdropClick && !saving) cancelEditor();
      }}
    >
      <form className="task-form is-creating" onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
        <header className="dialog-header">
          <div className="dialog-context">
            <strong id="task-dialog-title">{mergingIdeas
              ? mergeStartAfterSave
                ? text("合并并开始任务", "Merge and start task")
                : text("合并想法为任务", "Merge ideas into task")
              : text("新建议题", "New issue")}</strong>
          </div>
          <div className="dialog-header-actions">
            <button
              type="button"
              className="icon-button dialog-expand"
              aria-label={expanded
                ? text("收起编辑器", "Collapse editor")
                : text("展开编辑器", "Expand editor")}
              onClick={() => setExpanded((current) => !current)}
            >
              <LinearIcon name="expand" />
            </button>
            <button
              type="button"
              className="icon-button dialog-close"
              onClick={cancelEditor}
              disabled={saving}
              aria-label={text("关闭编辑器", "Close editor")}
            >
              <LinearIcon name="close" />
            </button>
          </div>
        </header>

        <div className="form-body">
          <label className="composer-title">
            <span className="sr-only">{text("标题", "Title")}</span>
            <textarea ref={titleRef} rows={1} value={title} onChange={(event) => setTitle(event.target.value.replace(/\n/g, ""))} placeholder={mergingIdeas ? text("合并后的任务标题", "Merged task title") : text("议题标题", "Issue title")} maxLength={240} autoComplete="off" />
          </label>
          <InlineMediaComposer
            ref={descriptionComposerRef}
            className="composer-description inline-media-description"
            segments={descriptionSegments}
            mentionTasks={tasks}
            referenceTasks={referenceTasks}
            completionContext={projectId ? { projectId, surface: "issue-description" } : undefined}
            placeholder={mergingIdeas
              ? text("补充要求（来源想法内容由系统追加）", "Additional requirements (source idea content is appended automatically)")
              : text("添加描述…", "Add description…")}
            ariaLabel={mergingIdeas ? text("补充要求", "Additional requirements") : text("描述", "Description")}
            disabled={saving}
            allowAttachments={!mergingIdeas}
            onChange={setDescriptionSegments}
            onError={setAttachmentError}
          />

          {mergingIdeas && (
            <section className="merge-ideas-sources" aria-labelledby="merge-ideas-sources-title">
              <header>
                <strong id="merge-ideas-sources-title">{text("来源想法", "Source ideas")}</strong>
                <span>{mergeSources.length}</span>
              </header>
              <p>{text(
                mergeStartAfterSave
                  ? "确认后只创建一个新任务和一个 Agent；来源想法会保留记录、关联到新任务并归档。"
                  : "合并成功后，来源想法会保留完整记录、关联到新任务并归档，不会被删除。",
                mergeStartAfterSave
                  ? "Confirmation creates one new task and one Agent; source ideas keep their history, link to the new task, and are archived."
                  : "After merging, source ideas keep their full history, are linked to the new task, and are archived rather than deleted.",
              )}</p>
              <ul>
                {mergeSources.map((source) => (
                  <li key={source.id}>
                    <span>{source.externalKey ?? source.identifier}</span>
                    <strong>{source.title}</strong>
                  </li>
                ))}
              </ul>
            </section>
          )}

        </div>

        <div className="task-form-dock">
          <div className="property-row">
            {projectOptions && (
              <TaskPropertyPicker
                value={projectId ?? ""}
                options={[
                  {
                    value: "",
                    label: text("项目", "Project"),
                    icon: <TaskboardIcon name="projectFolder" />,
                  },
                  ...projectOptions.map((project) => ({
                    value: project.id,
                    label: project.name,
                    icon: <TaskboardIcon name="projectFolder" />,
                  })),
                ]}
                open={menu === "project"}
                disabled={mergingIdeas}
                triggerClassName="property-control property-project"
                ariaLabel={text("项目", "Project")}
                onOpenChange={(open) => setMenu(open ? "project" : null)}
                onChange={(value) => {
                  const nextProjectId = value || null;
                  if (nextProjectId !== projectId) setDevelopmentContext(null);
                  onProjectChange?.(nextProjectId);
                }}
              />
            )}
            <TaskPropertyPicker
              value={status}
              options={TASK_STATUSES.map((value) => ({
                value,
                label: taskStatusLabel(language, value),
                icon: <StatusIcon status={value} color="currentColor" size={14} />,
              }))}
              open={menu === "status"}
              disabled={mergingIdeas}
              triggerClassName="property-control property-status"
              triggerContent={mergeStartAfterSave ? (
                <>
                  <span className="task-property-trigger-icon">
                    <StatusIcon status="in_progress" color="currentColor" size={14} />
                  </span>
                  <span className="task-property-trigger-label">
                    {taskStatusLabel(language, "in_progress")}
                  </span>
                </>
              ) : undefined}
              ariaLabel={text("状态", "Status")}
              onOpenChange={(open) => setMenu(open ? "status" : null)}
              onChange={setStatus}
            />
            {!mergingIdeas && (!paseoAssignee || paseoNeedsWorkspace) && <TaskPropertyPicker
              value={priority}
              options={TASK_PRIORITIES.map((value) => ({
                value,
                label: taskPriorityLabel(language, value),
                icon: <PriorityIcon priority={value} size={14} />,
                className: `priority-${value}`,
              }))}
              open={menu === "priority"}
              triggerClassName={`property-control property-priority priority-${priority}`}
              ariaLabel={text("优先级", "Priority")}
              onOpenChange={(open) => setMenu(open ? "priority" : null)}
              onChange={setPriority}
            />}
            {paseoAssignee ? (
              <div className="paseo-agent-configuration-group">
                <PaseoAssigneePicker
                  options={paseoAssignee.options}
                  value={paseoAssigneeId}
                  loading={paseoAssignee.loading}
                  error={paseoAssignee.error}
                  onRefresh={paseoAssignee.onRefresh}
                  onChange={(id) => {
                    if (id === paseoAssigneeId) return;
                    setPaseoAssigneeId(id);
                    setPaseoPlanTouched(true);
                    setPaseoWorkspaceId("");
                    setPaseoConfigurationSelection({});
                    setPaseoConfigurationReady(false);
                  }}
                />
                {paseoConfiguration && paseoConfigurationTarget && (
                  <PaseoConfigurationFields
                    target={paseoConfigurationTarget}
                    loadOptions={paseoConfiguration.loadOptions}
                    onSelectionChange={setPaseoConfigurationSelection}
                    onReadyChange={setPaseoConfigurationReady}
                    onOpenAgent={selectedPaseoAssignee?.agentId
                      ? () => paseoConfiguration.onOpenAgent(selectedPaseoAssignee.agentId!)
                      : undefined}
                    variant="editor"
                  />
                )}
              </div>
            ) : <TaskPropertyPicker
              value={actorKey(assignee)}
              options={assigneeOptions.map((actor) => ({
                value: actorKey(actor),
                label: actor.id === currentUser.id
                  ? `${actor.name}${text("（我）", " (me)")}`
                  : actor.name,
                icon: <ActorAvatar actor={actor} className="task-property-assignee-avatar" />,
              }))}
              open={menu === "assignee"}
              triggerClassName="property-control property-assignee"
              ariaLabel={text("负责人", "Assignee")}
              onOpenChange={(open) => setMenu(open ? "assignee" : null)}
              onChange={(value) => {
                const selected = assigneeOptions.find((actor) => actorKey(actor) === value);
                if (selected) setAssignee(selected);
              }}
            />}
            {paseoAssignee && paseoNeedsWorkspace && (
              <PaseoWorkspacePicker
                value={paseoWorkspaceId}
                options={availablePaseoWorkspaces}
                allowEmpty
                emptyLabel={text("使用项目默认目录", "Use project default directory")}
                placeholder={text("使用项目默认目录", "Use project default directory")}
                onChange={(id) => {
                  setPaseoPlanTouched(true);
                  setPaseoWorkspaceId(id);
                }}
              />
            )}
            {!mergingIdeas && <LabelPicker
              availableLabels={availableLabels}
              selectedLabels={selectedLabels}
              open={menu === "labels"}
              triggerClassName="property-control"
              showIcon
              onOpenChange={(open) => setMenu(open ? "labels" : null)}
              onChange={setSelectedLabels}
              onCreateLabel={onCreateLabel}
            />}

            {!mergingIdeas && <TaskPropertyPicker
              value={contextValue(developmentContext)}
              options={[
                {
                  value: "",
                  label: developmentScanLoading
                    ? text("正在扫描 Git…", "Scanning Git…")
                    : text("分支 / Worktree", "Branch / worktree"),
                  icon: <BranchIcon color="currentColor" size={14} />,
                },
                ...developmentOptions.map((context) => ({
                  value: contextValue(context),
                  label: contextLabel(context, text),
                  icon: context.type === "branch"
                    ? <BranchIcon color="currentColor" size={14} />
                    : <LinearIcon name="folder" />,
                })),
                ...(paseoWorktree && paseoNeedsWorkspace ? [{
                  value: "__paseo-create-worktree__",
                  label: text(
                    "新建独立代码目录（Worktree）",
                    "Create isolated code directory (worktree)",
                  ),
                  icon: <PlusIcon color="currentColor" size={14} />,
                  className: "development-context-create-option",
                  onSelect: () => {
                    paseoAssignee?.onRefresh();
                    setWorktreeDialogOpen(true);
                  },
                }] : []),
              ]}
              open={menu === "development"}
              disabled={developmentScanLoading}
              popoverClassName="development-context-popover"
              triggerClassName="property-control property-development"
              ariaLabel={text("代码分支或 Worktree", "Code branch or worktree")}
              title={developmentScan.workspacePath ?? undefined}
              onOpenChange={(open) => setMenu(open ? "development" : null)}
              onChange={(value) => setDevelopmentContext(value ? JSON.parse(value) as DevelopmentContext : null)}
            />}
            {!mergingIdeas && paseoWorktree && paseoNeedsWorkspace && (
              <PaseoWorktreeDialog
                open={worktreeDialogOpen}
                workspaces={availablePaseoWorkspaces}
                initialWorkspacePath={worktreeRepositoryPath}
                onClose={() => setWorktreeDialogOpen(false)}
                onCreated={(result) => {
                  setDevelopmentContext(result.context);
                  setCreatedPaseoWorkspace({
                    id: result.workspace.id,
                    name: `Worktree · ${result.workspace.branch}`,
                    path: result.workspace.path,
                    projectWorkspace: false,
                    kind: "workspace",
                  });
                  setPaseoWorkspaceId(result.workspace.id);
                  setPaseoPlanTouched(true);
                  paseoWorktree.onCreated(result.context);
                }}
              />
            )}

            {!mergingIdeas && dueDate && (
              <button className="property-control" type="button" title={text("用于计划安排，不会定时启动 Agent。", "Used for planning; it does not start an Agent on a schedule.")} onClick={() => setMenu("due")}>
                <span>{text(
                  `截止 ${displayDate(dueDate, locale)}`,
                  `Due ${displayDate(dueDate, locale)}`,
                )}</span>
              </button>
            )}
            {!mergingIdeas && recurrence && (
              <button className="property-control" type="button" title={text("仅记录周期，尚不自动生成下一次任务。", "Records the cadence only; it does not create the next task automatically.")} onClick={() => setMenu("recurrence")}>
                <span>{text(
                  `每 ${recurrence.interval} ${RECURRENCE_UNITS.zh[recurrence.unit]}`,
                  `Every ${recurrence.interval} ${RECURRENCE_UNITS.en[recurrence.unit]}${recurrence.interval === 1 ? "" : "s"}`,
                )}</span>
              </button>
            )}

            {!mergingIdeas && selectedRelationChips.map(({ type, issue }) => {
              const identifier = issue.externalKey ?? issue.identifier;
              const relationLabel = type === "subIssue"
                ? text("子", "Sub")
                : type === "parent"
                  ? text("父", "Parent")
                  : text("关联", "Related");
              return (
                <span className="property-control property-relation-chip" key={`${type}:${issue.id}`}>
                  <span className="property-relation-kind">{relationLabel}</span>
                  <span>{identifier}</span>
                  <span className="property-relation-tooltip" role="tooltip">{issue.title}</span>
                  <button
                    className="property-relation-remove"
                    type="button"
                    aria-label={text(`移除 ${identifier}`, `Remove ${identifier}`)}
                    onClick={() => {
                      if (type === "parent") setParentId(null);
                      else if (type === "related") {
                        setRelatedIds((current) => current.filter((id) => id !== issue.id));
                      } else {
                        setSubIssueIds((current) => current.filter((id) => id !== issue.id));
                      }
                    }}
                  >
                    <LinearIcon name="close" />
                  </button>
                </span>
              );
            })}

            {!mergingIdeas && <div className="composer-menu-anchor" ref={moreMenuRef}>
              <button className="property-control property-more" type="button" aria-label={text("更多属性", "More properties")} onClick={toggleMoreMenu}><MoreIcon color="currentColor" /></button>
              {menu === "more" && (
                <div
                  className="composer-popover more-popover"
                  role="menu"
                  style={moreMenuPosition ? {
                    position: "fixed",
                    top: "auto",
                    right: moreMenuPosition.right,
                    bottom: moreMenuPosition.bottom,
                    left: "auto",
                  } : undefined}
                >
                  <button type="button" title={text("用于计划安排，不会定时启动 Agent。", "Used for planning; it does not start an Agent on a schedule.")} onClick={() => setMenu("due")}><span><DueDateIcon color="currentColor" /></span><strong>{text("设置截止日期", "Set due date")}</strong><kbd>⇧ D</kbd><b><LinearIcon name="chevronRight" /></b></button>
                  <button type="button" title={text("仅记录周期，尚不自动生成下一次任务。", "Records the cadence only; it does not create the next task automatically.")} onClick={() => setMenu("recurrence")}><span><RecurrenceIcon color="currentColor" /></span><strong>{text("设置重复…", "Set recurrence…")}</strong><b><LinearIcon name="chevronRight" /></b></button>
                  <div className="more-popover-divider" />
                  <button className={relationMenu === "subIssue" ? "is-open" : undefined} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={relationMenu === "subIssue"} onClick={() => setRelationMenu("subIssue")}><span><PlusIcon color="currentColor" size={16} /></span><strong>{text("添加子议题", "Add sub-issue")}</strong>{selectedSubIssues.length > 0 && <small>{text(`${selectedSubIssues.length} 个已选`, `${selectedSubIssues.length} selected`)}</small>}<b><LinearIcon name="chevronRight" /></b></button>
                  <button className={relationMenu === "parent" ? "is-open" : undefined} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={relationMenu === "parent"} onClick={() => setRelationMenu("parent")}><span><PlusIcon color="currentColor" size={16} /></span><strong>{text("添加父议题", "Add parent issue")}</strong>{selectedParent && <small>{selectedParent.externalKey ?? selectedParent.identifier}</small>}<b><LinearIcon name="chevronRight" /></b></button>
                  <button className={relationMenu === "related" ? "is-open" : undefined} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={relationMenu === "related"} onClick={() => setRelationMenu("related")}><span><RelationIcon color="currentColor" size={16} /></span><strong>{text("添加关联议题", "Add related issue")}</strong>{selectedRelated.length > 0 && <small>{text(`${selectedRelated.length} 个已选`, `${selectedRelated.length} selected`)}</small>}<b><LinearIcon name="chevronRight" /></b></button>
                  {relationMenu && (
                    <div className="issue-relation-popover task-create-relation-submenu" aria-label={text("选择关系议题", "Select relation issue")}>
                      <IssuePickerContent
                        key={relationMenu}
                        candidates={relationCandidates}
                        selectedIds={selectedRelationIds}
                        onEscape={() => setRelationMenu(null)}
                        onSelect={toggleDraftRelation}
                      />
                    </div>
                  )}
                </div>
              )}
              {menu === "due" && (
                <div className="composer-popover due-popover">
                  <p className="composer-scheduling-note">{text("日期用于计划安排，不会定时启动 Agent。", "Dates are for planning and do not start an Agent on a schedule.")}</p>
                  <label className="custom-date-row"><span>{text("自定义…", "Custom…")}</span><input type="date" value={dueDate} onChange={(event) => chooseDueDate(event.target.value)} /></label>
                  <button type="button" onClick={() => chooseDueDate(dateFromNow(1))}><strong>{text("明天", "Tomorrow")}</strong><span>{displayDate(dateFromNow(1), locale)}</span></button>
                  <button type="button" onClick={() => chooseDueDate(endOfWeek())}><strong>{text("本周结束", "End of this week")}</strong><span>{displayDate(endOfWeek(), locale)}</span></button>
                  <button type="button" onClick={() => chooseDueDate(dateFromNow(7))}><strong>{text("一周后", "In one week")}</strong><span>{displayDate(dateFromNow(7), locale)}</span></button>
                  {dueDate && <button className="destructive-menu-row" type="button" onClick={() => { setDueDate(""); setRecurrence(null); setMenu(null); }}>{text("清除截止日期", "Clear due date")}</button>}
                </div>
              )}
              {menu === "recurrence" && (
                <div className="composer-popover recurrence-popover">
                  <p className="composer-scheduling-note">{text("仅记录周期，尚不自动生成下一次任务。", "This records the cadence only and does not create the next task automatically.")}</p>
                  <label><span>{text("最早截止日期", "Initial due date")}</span><input type="date" value={dueDate || dateFromNow(7)} onChange={(event) => setDueDate(event.target.value)} /></label>
                  <label><span>{text("重复频率", "Repeat frequency")}</span><span className="recurrence-controls"><input type="number" min="1" max="365" value={recurrence?.interval ?? 1} onChange={(event) => setRecurrence({ interval: Number(event.target.value), unit: recurrence?.unit ?? "week" })} /><select value={recurrence?.unit ?? "week"} onChange={(event) => setRecurrence({ interval: recurrence?.interval ?? 1, unit: event.target.value as Recurrence["unit"] })}>{Object.entries(RECURRENCE_UNITS[language]).map(([unit, label]) => <option value={unit} key={unit}>{label}</option>)}</select></span></label>
                  <button className="recurrence-save" type="button" onClick={() => { if (!dueDate) setDueDate(dateFromNow(7)); if (!recurrence) setRecurrence({ interval: 1, unit: "week" }); setMenu(null); }}>{text("设置重复", "Set recurrence")}</button>
                  {recurrence && <button className="destructive-menu-row" type="button" onClick={() => { setRecurrence(null); setMenu(null); }}>{text("清除重复", "Clear recurrence")}</button>}
                </div>
              )}
            </div>}
          </div>

          {attachmentError && (
            <div className="form-error" role="alert">
              {typeof attachmentError === "string"
                ? attachmentError
                : text(attachmentError[0], attachmentError[1])}
            </div>
          )}
          {error && (
            <div className="form-error" role="alert">
              {typeof error === "string" ? error : text(error[0], error[1])}
            </div>
          )}

          <footer className="dialog-footer">
            {!mergingIdeas && (
              <>
                <button className="composer-attach-icon" type="button" disabled={saving} onClick={() => attachmentInputRef.current?.click()} aria-label={text("上传附件", "Upload attachments")}>
                  <AttachmentIcon color="currentColor" />
                </button>
                <input ref={attachmentInputRef} type="file" multiple hidden onChange={(event) => { if (event.currentTarget.files) descriptionComposerRef.current?.addFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
              </>
            )}
            <div className="dialog-actions">
              {!mergingIdeas && <div className="create-more-control">
                <span>{text("创建更多", "Create more")}</span>
                <button
                  type="button"
                  className={`board-setting-switch${createMore ? " is-on" : ""}`}
                  role="switch"
                  aria-checked={createMore}
                  disabled={saving}
                  onClick={() => setCreateMore((current) => !current)}
                >
                  <span aria-hidden="true" />
                </button>
              </div>}
              <button
                className="button primary"
                type="submit"
                disabled={saving}
                onClick={() => {
                  createSubmitIntentRef.current = true;
                }}
              >
                {saving
                  ? text("正在保存…", "Saving…")
                  : mergingIdeas
                    ? mergeStartAfterSave
                      ? text("合并并开始", "Merge and start")
                      : text("合并为任务", "Merge into task")
                    : text("创建议题", "Create issue")}
              </button>
            </div>
          </footer>
        </div>
      </form>
    </dialog>
  );
}
