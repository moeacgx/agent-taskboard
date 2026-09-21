import { resolveInlineAttachments } from "./inlineAttachments";
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ApiError,
  addTaskRelation,
  archiveTask as archiveTaskRequest,
  createProjectLabel as createProjectLabelRequest,
  createProject as createProjectRequest,
  createTask as createTaskRequest,
  configureJiraConnection,
  deleteArchivedTask as deleteArchivedTaskRequest,
  deleteProjectLabel as deleteProjectLabelRequest,
  deleteProject as deleteProjectRequest,
  getAiChatCatalog,
  getCodexThreadProgress,
  getJiraConnection,
  getTaskboardRevision,
  getTaskboardMetadata,
  listArchivedTasks,
  listDevelopmentContexts,
  listDeviceWorkspaces,
  listProjects,
  listTasks,
  moveTask as moveTaskRequest,
  moveTaskToProject as moveTaskToProjectRequest,
  publishHostRuntime,
  removeTaskRelation,
  resolveTaskboardUrl,
  resolveTaskboardWebSocketUrl,
  restoreTask as restoreTaskRequest,
  setApiText,
  setCurrentUserActor,
  syncJiraConnection,
  uploadAttachment,
  updateProjectName,
  updateTask as updateTaskRequest,
} from "./api";
import {
  actorKey,
  actorForAssigneeTarget,
  assigneeTargetForActor,
} from "./actors";
import { BoardColumn } from "./components/BoardColumn";
import type { AiChatOpenThreadRequest } from "./components/AiChat";
import {
  BoardCardDisplayMenu,
  DEFAULT_BOARD_DISPLAY_SETTINGS,
  type BoardDisplaySettings,
} from "./components/BoardCardDisplayMenu";
import { DashboardView } from "./components/DashboardView";
import { ProjectReadmeView } from "./components/ProjectReadmeView";
import { IssueListView } from "./components/IssueListView";
import { JiraConnectionDialog } from "./components/JiraConnectionDialog";
import { ArchivedTasksColumn, OtherTasksPanel } from "./components/OtherTasksPanel";
import {
  type PendingInlineAttachment,
  type PendingInlineImage,
} from "./documentModel";
import { LinearIcon } from "./components/LinearIcon";
import {
  DeleteIcon,
  MoreIcon,
  PlusIcon,
  RefreshIcon,
  RelationIcon,
} from "./components/SemanticIcons";
import { ProjectAutomationMenu } from "./components/ProjectAutomationMenu";
import {
  PaseoProjectDefaultsDialog,
  type PaseoProjectDefaultsCatalog,
  type PaseoProjectDefaultsValue,
} from "./components/PaseoProjectDefaultsDialog";
import { TaskboardIcon } from "./components/TaskboardIcon";
import { TaskContextMenu } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import { PaseoExecutionConfigDialog } from "./components/PaseoExecutionConfigDialog";
import type { PaseoAssigneeOption } from "./components/PaseoAssigneePicker";
import type { PaseoConfigurationSelection } from "./components/PaseoConfigurationFields";
import {
  TaskEditor,
  type NewTaskCreateOptions,
  type NewTaskEditorDraft,
} from "./components/TaskEditor";
import { TaskFilterMenu } from "./components/TaskFilterMenu";
import {
  PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX,
  projectBoardDisplaySettingsStorageEntries,
  refreshProjectBoardDisplaySettingsStorage,
  taskboardStorage,
} from "./storage";
import {
  installEmbeddedExternalLinkHandler,
  postEmbeddedHostMessage,
  setEmbeddedFrameChallenge,
} from "./embeddedHost.mjs";
import type {
  PaseoAutomationIntervalMinutes,
  PaseoAutomationState,
  PaseoAssignmentOptions,
  PaseoConfigurationOptions,
  PaseoConfigurationOptionsRequest,
  PaseoCopyRequest,
  PaseoCopyResponse,
  PaseoMergeIdeasRequest,
  PaseoMergeIdeasResult,
  PaseoTaskAssignment,
} from "./paseo-bridge";
import { profileIconSource, providerIconSource } from "./providerIcons";
import { buildIssueUrl, readIssueIdentifier } from "./issueRoute";
import {
  getTaskboardI18n,
  resolveTaskboardLanguage,
  taskStatusLabel,
  TaskboardLanguageProvider,
} from "./i18n";
import {
  MAIN_STATUSES,
  type OtherTaskTab,
} from "./issueBoardStatuses";
import {
  indexAiThreadsByTask,
  normalizeCodexThreadId,
  taskCardPresentation,
  type PaseoAgentPresentation,
  type TaskCardPresentation,
  type TaskConversationItem,
} from "./taskConversations";
import {
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  matchesTaskSearch,
  readTaskFilters,
  taskFilterCount,
  writeTaskFilters,
} from "./taskFilters";
import {
  TASK_STATUSES,
  type ActorIdentity,
  type AiChatModel,
  type AiChatThread,
  type CodexProjectIdentity,
  type CodexThreadBinding,
  type DevelopmentScan,
  type HostContext,
  type IssueRelationOrigin,
  type IssueRelationType,
  type JiraConnection,
  type Project,
  type Task,
  type TaskboardMetadata,
  type TaskDraft,
  type TaskStatus,
} from "./types";
// The poller stays in ESM JavaScript so its lifecycle can be tested directly with node:test.
// @ts-expect-error The module's option contract is enforced by its focused node tests.
import { createRefreshPoller, createRevisionPoller, createRevisionWebSocketClient, getRevisionPollingInterval, getRevisionWebSocketConfig } from "./revisionPolling.mjs";

type ConnectionState = "connecting" | "live" | "reconnecting";
type Theme = "light" | "dark";
type BoardView = "readme" | "dashboard" | "issues" | "list" | "gantt";
type DetailSourceScroll =
  | { projectId: string; view: "issues"; status: TaskStatus; scrollTop: number; scrollLeft: number }
  | { projectId: string; view: "list"; scrollTop: number };
type GanttZoom = "day" | "week" | "month";
type ActionError = string | readonly [string, string] | {
  kind: "pending-task-sync";
  message: string;
  taskId: string;
  previousVersion: number;
};
type PaseoExecutionDialogState = {
  taskId: string;
  projectId: string;
  taskIdentifier: string;
  initialChoiceId: string;
  initialWorkspacePath: string | null;
  initialProfile: Extract<PaseoTaskAssignment, { kind: "planned" }>["profile"] | null;
  initialModeId?: string;
  initialThinkingOptionId?: string;
};

function isPendingTaskSyncError(error: ActionError): error is Extract<ActionError, { kind: "pending-task-sync" }> {
  return typeof error === "object" && "kind" in error && error.kind === "pending-task-sync";
}
type ProjectLoadError = {
  source: "projects";
  operation: "initial" | "refresh";
  requestId: number;
  message: string;
};
type TasksLoadError = {
  source: "tasks";
  requestId: number;
  message: string;
};
type LoadError = ProjectLoadError | TasksLoadError;
const GANTT_ZOOM_OPTIONS: GanttZoom[] = ["day", "week", "month"];

const AiChat = lazy(() => import("./components/AiChat").then((module) => ({
  default: module.AiChat,
})));
const GanttView = lazy(() => import("./components/GanttView").then((module) => ({
  default: module.GanttView,
})));

interface EditorState {
  status: TaskStatus;
  projectId?: string | null;
  mergeSources?: Task[];
  mergeRequestId?: string;
  mergeOperationId?: string;
  mergeStartAfterSave?: boolean;
}

interface ContextMenuState {
  taskId: string;
  x: number;
  y: number;
}

interface ProjectChoice {
  id: string;
  name: string;
  issueCount: number;
  inCodex: boolean;
  persisted: boolean;
  codexIdentity: CodexProjectIdentity | null;
}

interface ProjectContextMenuState {
  project: ProjectChoice;
  x: number;
  y: number;
}

interface UndoOperation {
  id: number;
  undo: () => Promise<void>;
}

interface UndoNotice {
  id: number;
  message: string;
}

type ProjectAutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type AutomationIntervalMinutes = 5 | 10 | 15 | 30 | 60;

interface AutomationQuotaStatus {
  state: AutomationQuotaState;
  checkedAt: number;
  resetsAt?: number;
  reason?: "api-key";
}

interface ProjectAutomationRecord {
  automationId?: string;
  codexProjectId: string;
  codexProjectKind: "local" | "remote";
  codexHostId: string;
  workspacePath: string;
  status: ProjectAutomationStatus;
  enabledByUser: boolean;
  quotaAware: boolean;
  quota?: AutomationQuotaStatus;
  intervalMinutes: AutomationIntervalMinutes;
  model: string;
  reasoningEffort: string;
}

interface ProjectAutomationOptions {
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: AutomationIntervalMinutes;
  model?: string;
  reasoningEffort?: string;
}

interface AutomationRequestContext {
  taskboardProjectId: string;
  codexProjectId: string;
  codexProjectKind: "local" | "remote";
  codexHostId: string;
  projectName: string;
  workspacePath: string;
  remoteProjects: CodexProjectIdentity[];
  skillPath: string;
}

interface QueuedProjectAutomationSave {
  projectId: string;
  context: AutomationRequestContext;
  options: ProjectAutomationOptions;
}

type ProjectAutomations = Record<string, ProjectAutomationRecord>;

interface AutomationHostItem {
  id: string;
  status: ProjectAutomationStatus;
  model: string;
  reasoningEffort: string;
  rrule: string;
}

interface AutomationHostResponse {
  requestId: string;
  ok: boolean;
  item?: AutomationHostItem;
  items?: AutomationHostItem[];
  quota?: AutomationQuotaStatus;
  policy?: {
    automationId?: string;
    codexProjectId: string;
    codexProjectKind: "local" | "remote";
    codexHostId: string;
    workspacePath: string;
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: AutomationIntervalMinutes;
    model: string;
    reasoningEffort: string;
  };
  error?: string;
}

interface PendingAutomationRequest {
  resolve: (response: AutomationHostResponse) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const GLOBAL_PROJECT_ID = "local";
const ALL_PROJECTS_ID = "__all_projects__";
const ALL_PROJECTS_DEFAULT_BOARD_DISPLAY_SETTINGS: BoardDisplaySettings = {
  ...DEFAULT_BOARD_DISPLAY_SETTINGS,
  mainStatuses: ["backlog", ...DEFAULT_BOARD_DISPLAY_SETTINGS.mainStatuses],
  sidebarStatuses: DEFAULT_BOARD_DISPLAY_SETTINGS.sidebarStatuses.filter(
    (status) => status !== "backlog",
  ),
};
const PASEO_DEFAULT_BOARD_DISPLAY_SETTINGS: BoardDisplaySettings = {
  cover: true,
  body: false,
  mainStatuses: ["todo", "in_progress", "in_review"],
  sidebarStatuses: ["done", "canceled", "archived"],
  hiddenStatuses: [],
};

const PASEO_UNASSIGNED_ACTOR: ActorIdentity = {
  type: "user",
  id: "paseo-unassigned",
  name: "未分配",
  avatarUrl: null,
};

function assignmentProviderIcon(
  provider: string,
  providerIcons: ReadonlyMap<string, string | null>,
): string | null {
  return providerIcons.get(provider) ?? providerIcons.get(provider.split("/", 1)[0]) ?? null;
}

interface PendingPaseoAutomationRequest {
  resolve: (automation: PaseoAutomationState) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

interface PendingPaseoProjectDefaultsRequest extends PendingPaseoAutomationRequest {
  projectId: string;
}

interface PendingPaseoConfigurationRequest {
  resolve: (options: PaseoConfigurationOptions) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

interface PendingPaseoMergeRequest {
  resolve: (result: PaseoMergeIdeasResult) => void;
  reject: (error: Error) => void;
  timeoutId: number;
  sourceTaskIds: string[];
}

interface PendingPaseoCopyRequest {
  resolve: (copiedText: string) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

interface PaseoAutomationRequestToken {
  sequence: number;
  foreground: boolean;
}

export function createPaseoAutomationRequestGate(onPendingChange: (pending: boolean) => void) {
  let sequence = 0;
  let foregroundRequests = 0;

  return {
    begin(quiet: boolean): PaseoAutomationRequestToken | null {
      if (quiet && foregroundRequests > 0) return null;
      const token = { sequence: ++sequence, foreground: !quiet };
      if (token.foreground) {
        foregroundRequests += 1;
        if (foregroundRequests === 1) onPendingChange(true);
      }
      return token;
    },
    isCurrent(token: PaseoAutomationRequestToken): boolean {
      return token.sequence === sequence;
    },
    end(token: PaseoAutomationRequestToken): void {
      if (!token.foreground) return;
      foregroundRequests = Math.max(0, foregroundRequests - 1);
      if (foregroundRequests === 0) onPendingChange(false);
    },
  };
}

function paseoAssignmentActor(
  assignment: PaseoTaskAssignment,
  providerIcons: ReadonlyMap<string, string | null>,
): ActorIdentity {
  if (assignment.kind === "existing") {
    return {
      type: "agent",
      id: `paseo-agent:${assignment.agentId}`,
      name: assignment.title ?? `Paseo · ${assignment.provider}${assignment.model ? `/${assignment.model}` : ""}`,
      avatarUrl: providerIconSource(assignment.provider, assignmentProviderIcon(assignment.provider, providerIcons)),
    };
  }
  if (!assignment.profile) {
    return {
      type: "agent",
      id: `paseo-plan:project-default:${assignment.taskId}`,
      name: "计划执行 · 使用项目默认 Agent",
      avatarUrl: null,
    };
  }
  return {
    type: "agent",
    id: `paseo-plan:${assignment.profile.id}`,
    name: `计划新建 · ${assignment.profile.name}`,
    avatarUrl: profileIconSource(
      assignment.profile.icon,
      assignment.profile.provider,
      assignmentProviderIcon(assignment.profile.provider, providerIcons),
    ),
  };
}

function decoratePaseoTask(
  task: Task,
  assignment: PaseoTaskAssignment | undefined,
  providerIcons: ReadonlyMap<string, string | null>,
): Task {
  if (assignment) {
    const actor = paseoAssignmentActor(assignment, providerIcons);
    const participants = [
      ...task.participants.filter((participant) => participant.id !== "codex-agent" && actorKey(participant) !== actorKey(actor)),
      actor,
    ];
    if (
      actorKey(task.assignee) === actorKey(actor)
      && task.assignee.name === actor.name
      && task.assignee.avatarUrl === actor.avatarUrl
      && task.participants.length === participants.length
    ) return task;
    return { ...task, assignee: actor, participants };
  }
  if (task.assignee.id !== "codex-agent" && !task.participants.some((participant) => participant.id === "codex-agent")) return task;
  return {
    ...task,
    assignee: task.assignee.id === "codex-agent" ? PASEO_UNASSIGNED_ACTOR : task.assignee,
    participants: task.participants.filter((participant) => participant.id !== "codex-agent"),
  };
}

type PaseoAssignmentChoice =
  | { kind: "self" | "unassigned" }
  | { kind: "existing"; agentId: string }
  | { kind: "planned"; profile: PaseoAssignmentOptions["profiles"][number] | PaseoAssignmentOptions["models"][number] | null };

const PASEO_SAVED_TASK_PLAN_ID = "paseo:saved-task-plan";

/** 请求已交给父端但 iframe 未在时限内收到回包；不能当成创建或保存失败。 */
class PaseoAssignmentSavePendingError extends Error {
  constructor() {
    super("Paseo 负责人仍在保存，请刷新后确认任务计划；不会重复创建任务。");
    this.name = "PaseoAssignmentSavePendingError";
  }
}

function sameBoardDisplaySettings(left: BoardDisplaySettings, right: BoardDisplaySettings): boolean {
  return left.cover === right.cover
    && left.body === right.body
    && left.mainStatuses.join(",") === right.mainStatuses.join(",")
    && left.sidebarStatuses.join(",") === right.sidebarStatuses.join(",")
    && left.hiddenStatuses.join(",") === right.hiddenStatuses.join(",");
}
const RECENT_PROJECT_IDS_KEY = "taskboard.recentProjectIds.v1";
const PROJECT_VIEW_KEY_PREFIX = "taskboard.project-view.v1.";
const DEVICE_WORKSPACE_PATHS_KEY = "taskboard.deviceWorkspacePaths.v1";
const PROJECT_CODEX_IDENTITIES_KEY = "taskboard.projectCodexIdentities.v1";
const PROJECT_AUTOMATIONS_KEY = "taskboard.projectAutomations.v1";
const ISSUE_READ_KEY_PREFIX = "taskboard.issue-read.v1";
const FIRST_USE_COMPLETE_KEY = "taskboard.first-use-complete.v1";
function issueReadStorageKey(mode: string, task: Pick<Task, "id" | "projectId">) {
  return `${ISSUE_READ_KEY_PREFIX}:${mode}:${task.projectId}:${task.id}`;
}

function readProjectBoardView(projectId: string): BoardView {
  const view = taskboardStorage.getItem(`${PROJECT_VIEW_KEY_PREFIX}${projectId}`);
  return view === "readme" || view === "dashboard" || view === "list" || view === "gantt" || view === "issues"
    ? view
    : "issues";
}

function readProjectBoardDisplaySettings(): Record<string, BoardDisplaySettings> {
  const settings: Record<string, BoardDisplaySettings> = {};
  for (const [key, storedValue] of projectBoardDisplaySettingsStorageEntries()) {
    const projectId = key.slice(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX.length);
    if (!projectId) continue;
    try {
      const value = JSON.parse(storedValue);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        settings[projectId] = value as BoardDisplaySettings;
      }
    } catch {
      // Ignore malformed display settings without affecting other projects.
    }
  }
  return settings;
}

function readRecentProjectIds(): string[] {
  try {
    const value = JSON.parse(taskboardStorage.getItem(RECENT_PROJECT_IDS_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((projectId): projectId is string => typeof projectId === "string" && projectId.length > 0)
      : [];
  } catch {
    return [];
  }
}

const EVENT_NAMES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "task.deleted",
  "task.relation.updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "project.created",
  "project.labels.updated",
  "project.readme.updated",
  "client-storage.updated",
] as const;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function getInitialTheme(): Theme {
  const query = new URL(document.baseURI).searchParams;
  const host = query.get("host");
  if (
    window.parent !== window
    && (host === "codex" || host === "deepseek-harness" || host === "paseo")
  ) {
    const fromQuery = query.get("theme");
    if (isTheme(fromQuery)) return fromQuery;
    const stored = taskboardStorage.getItem("taskboard.theme");
    if (isTheme(stored)) return stored;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readDeviceWorkspacePaths(): Record<string, string> {
  try {
    const value = JSON.parse(taskboardStorage.getItem(DEVICE_WORKSPACE_PATHS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

function readProjectCodexIdentities(): Record<string, CodexProjectIdentity> {
  try {
    const value = JSON.parse(taskboardStorage.getItem(PROJECT_CODEX_IDENTITIES_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, CodexProjectIdentity] => {
      const identity = entry[1] as Partial<CodexProjectIdentity> | null;
      return Boolean(
        identity
        && typeof identity.codexProjectId === "string"
        && (identity.codexProjectKind === "local" || identity.codexProjectKind === "remote")
        && typeof identity.codexHostId === "string"
        && typeof identity.workspacePath === "string",
      );
    }));
  } catch {
    return {};
  }
}

function readProjectAutomations(): ProjectAutomations {
  try {
    const value = JSON.parse(taskboardStorage.getItem(PROJECT_AUTOMATIONS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ProjectAutomations = {};
    for (const [projectId, record] of Object.entries(value)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const candidate = record as Partial<ProjectAutomationRecord>;
      const model = candidate.model;
      const reasoningEffort = candidate.reasoningEffort;
      const enabledByUser = candidate.enabledByUser ?? candidate.status === "ACTIVE";
      const quotaAware = candidate.quotaAware ?? false;
      if (
        (candidate.automationId !== undefined && typeof candidate.automationId !== "string")
        || typeof candidate.codexProjectId !== "string"
        || (candidate.codexProjectKind !== "local" && candidate.codexProjectKind !== "remote")
        || typeof candidate.codexHostId !== "string"
        || typeof candidate.workspacePath !== "string"
        || (candidate.status !== "ACTIVE" && candidate.status !== "PAUSED")
        || !isAutomationIntervalMinutes(candidate.intervalMinutes ?? 5)
        || typeof model !== "string"
        || !model.trim()
        || typeof reasoningEffort !== "string"
        || !reasoningEffort.trim()
        || (candidate.status === "ACTIVE" && !candidate.automationId)
        || typeof enabledByUser !== "boolean"
        || typeof quotaAware !== "boolean"
      ) continue;
      const quota = isAutomationQuotaStatus(candidate.quota) ? candidate.quota : undefined;
      result[projectId] = {
        automationId: candidate.automationId,
        codexProjectId: candidate.codexProjectId,
        codexProjectKind: candidate.codexProjectKind,
        codexHostId: candidate.codexHostId,
        workspacePath: candidate.workspacePath,
        status: candidate.status,
        enabledByUser,
        quotaAware,
        ...(quota ? { quota } : {}),
        intervalMinutes: candidate.intervalMinutes ?? 5,
        model,
        reasoningEffort,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function isAutomationQuotaStatus(value: unknown): value is AutomationQuotaStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AutomationQuotaStatus>;
  return (
    (candidate.state === "available"
      || candidate.state === "blocked"
      || candidate.state === "unknown"
      || candidate.state === "unavailable")
    && Number.isFinite(candidate.checkedAt)
    && (candidate.resetsAt === undefined || Number.isFinite(candidate.resetsAt))
    && (candidate.reason === undefined || candidate.reason === "api-key")
  );
}

function isAutomationHostPolicy(
  value: AutomationHostResponse["policy"] | undefined,
): value is NonNullable<AutomationHostResponse["policy"]> {
  return Boolean(
    value
    && (value.automationId === undefined || typeof value.automationId === "string")
    && typeof value.codexProjectId === "string"
    && (value.codexProjectKind === "local" || value.codexProjectKind === "remote")
    && typeof value.codexHostId === "string"
    && typeof value.workspacePath === "string"
    && typeof value.enabledByUser === "boolean"
    && typeof value.quotaAware === "boolean"
    && isAutomationIntervalMinutes(value.intervalMinutes)
    && typeof value.model === "string"
    && Boolean(value.model.trim())
    && typeof value.reasoningEffort === "string"
    && Boolean(value.reasoningEffort.trim()),
  );
}

function isAutomationIntervalMinutes(value: unknown): value is AutomationIntervalMinutes {
  return value === 5 || value === 10 || value === 15 || value === 30 || value === 60;
}

function isPaseoAutomationState(value: unknown): value is PaseoAutomationState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<PaseoAutomationState>;
  return typeof state.projectId === "string"
    && (state.workspacePath === null || typeof state.workspacePath === "string")
    && (state.profile === null || typeof state.profile === "object")
    && typeof state.enabledByUser === "boolean"
    && isAutomationIntervalMinutes(state.intervalMinutes)
    && typeof state.quotaAware === "boolean"
    && (state.status === "ACTIVE" || state.status === "PAUSED")
    && typeof state.schedulerReady === "boolean"
    && typeof state.quotaAvailable === "boolean"
    && (state.lastRunAt === null || typeof state.lastRunAt === "string")
    && (state.lastError === null || typeof state.lastError === "string");
}

function isPaseoConfigurationOptions(value: unknown): value is PaseoConfigurationOptions {
  if (!value || typeof value !== "object") return false;
  const options = value as Partial<PaseoConfigurationOptions>;
  return typeof options.provider === "string"
    && typeof options.model === "string"
    && Array.isArray(options.modes)
    && Array.isArray(options.thinkingOptions)
    && typeof options.editable === "boolean";
}

function intervalMinutesFromRrule(value: string): AutomationIntervalMinutes | null {
  const match = /^RRULE:FREQ=MINUTELY;INTERVAL=(5|10|15|30|60)$/.exec(value);
  return match ? Number(match[1]) as AutomationIntervalMinutes : null;
}

function isAutomationHostItem(value: unknown): value is AutomationHostItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<AutomationHostItem>;
  return (
    typeof item.id === "string"
    && (item.status === "ACTIVE" || item.status === "PAUSED")
    && typeof item.model === "string"
    && Boolean(item.model.trim())
    && typeof item.reasoningEffort === "string"
    && Boolean(item.reasoningEffort.trim())
    && typeof item.rrule === "string"
    && intervalMinutesFromRrule(item.rrule) !== null
  );
}

function isLocalTaskboardOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === "http:" || protocol === "https:")
      && (hostname === "127.0.0.1" || hostname === "localhost");
  } catch {
    return false;
  }
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
  );
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    developmentContext: task.developmentContext,
    startDate: task.startDate,
    dueDate: task.dueDate,
    recurrence: task.recurrence,
  };
}

interface LocalRealtimeSyncProps {
  selectedProjectId: string;
  detailTaskId: string | null;
  refreshProjectList: () => Promise<void>;
  refreshTasks: (
    projectId: string,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  refreshProjectBoardDisplaySettings: () => Promise<void>;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setCommentsRevision: Dispatch<SetStateAction<number>>;
  setAttachmentsRevision: Dispatch<SetStateAction<number>>;
  setReadmeRevision: Dispatch<SetStateAction<number>>;
}

function LocalRealtimeSync({
  selectedProjectId,
  detailTaskId,
  refreshProjectList,
  refreshTasks,
  refreshProjectBoardDisplaySettings,
  setConnection,
  setCommentsRevision,
  setAttachmentsRevision,
  setReadmeRevision,
}: LocalRealtimeSyncProps) {
  const selectionRef = useRef({ selectedProjectId, detailTaskId });
  const eventsUrl = resolveTaskboardUrl("/api/events");

  useLayoutEffect(() => {
    selectionRef.current = { selectedProjectId, detailTaskId };
  }, [selectedProjectId, detailTaskId]);

  useEffect(() => {
    const source = new EventSource(eventsUrl);
    let refreshTimer: number | undefined;
    let refreshProjectsPending = false;
    const pendingTaskProjects = new Set<string | undefined>();

    const scheduleRefresh = (options: { projects?: boolean; tasks?: boolean; projectId?: string }) => {
      refreshProjectsPending ||= options.projects === true;
      if (options.tasks) pendingTaskProjects.add(options.projectId);
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const { selectedProjectId } = selectionRef.current;
        if (refreshProjectsPending) void refreshProjectList();
        if (
          selectedProjectId
          && pendingTaskProjects.size > 0
          && (
            selectedProjectId === ALL_PROJECTS_ID
            || pendingTaskProjects.has(undefined)
            || pendingTaskProjects.has(selectedProjectId)
          )
        ) {
          void refreshTasks(selectedProjectId, { quiet: true });
        }
        refreshProjectsPending = false;
        pendingTaskProjects.clear();
      }, 120);
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let payload: { projectId?: string; taskId?: string; project?: Project; key?: string } = {};
      try {
        payload = JSON.parse(message.data) as {
          projectId?: string;
          taskId?: string;
          project?: Project;
          key?: string;
        };
      } catch {
        // A malformed event should not interrupt later updates.
      }
      if (
        event.type === "client-storage.updated"
        && payload.key?.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX)
      ) {
        void refreshProjectBoardDisplaySettings();
        return;
      }
      const { selectedProjectId, detailTaskId } = selectionRef.current;
      const eventProjectId = payload.projectId ?? payload.project?.id;
      const affectsSelectedProject = Boolean(selectedProjectId)
        && (
          selectedProjectId === ALL_PROJECTS_ID
          || !eventProjectId
          || eventProjectId === selectedProjectId
        );
      if (event.type === "project.created") {
        scheduleRefresh({ projects: true });
        return;
      }
      if (event.type === "project.labels.updated") {
        scheduleRefresh({ projects: true, tasks: affectsSelectedProject, projectId: eventProjectId });
        return;
      }
      if (event.type.startsWith("task.")) {
        scheduleRefresh({
          projects: event.type !== "task.relation.updated",
          tasks: affectsSelectedProject,
          projectId: eventProjectId,
        });
        return;
      }
      if (!affectsSelectedProject) return;
      if (event.type === "project.readme.updated") {
        setReadmeRevision((current) => current + 1);
        return;
      }
      if (event.type.startsWith("comment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setCommentsRevision((current) => current + 1);
        }
        scheduleRefresh({ tasks: true, projectId: eventProjectId });
        return;
      }
      if (event.type.startsWith("attachment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setAttachmentsRevision((current) => current + 1);
          setCommentsRevision((current) => current + 1);
        }
      }
    };

    EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => {
      setConnection("live");
      const { selectedProjectId, detailTaskId } = selectionRef.current;
      void refreshProjectBoardDisplaySettings();
      scheduleRefresh({ projects: true, tasks: Boolean(selectedProjectId) });
      if (selectedProjectId && selectedProjectId !== ALL_PROJECTS_ID) {
        setReadmeRevision((current) => current + 1);
      }
      if (detailTaskId) {
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      }
    };
    source.onerror = () => {
      setConnection("reconnecting");
    };

    return () => {
      window.clearTimeout(refreshTimer);
      EVENT_NAMES.forEach((name) => source.removeEventListener(name, handleEvent));
      source.close();
    };
  }, [
    eventsUrl,
    refreshProjectBoardDisplaySettings,
    refreshProjectList,
    refreshTasks,
    setAttachmentsRevision,
    setCommentsRevision,
    setConnection,
    setReadmeRevision,
  ]);

  return null;
}

export function App() {
  const query = useMemo(() => new URL(document.baseURI).searchParams, []);
  const host = query.get("host");
  const embedded = host === "codex" || host === "deepseek-harness" || host === "paseo";
  const undoShortcut = navigator.userAgent.includes("Macintosh") ? "⌘Z" : "Ctrl+Z";
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  const language = resolveTaskboardLanguage(
    hostContext?.language ?? query.get("lang") ?? navigator.language,
  );
  const { locale, text } = getTaskboardI18n(language);
  const [embeddedFrameChallenge, setEmbeddedFrameChallengeState] = useState("");
  const [developmentScan, setDevelopmentScan] = useState<DevelopmentScan>({ workspacePath: null, contexts: [] });
  const [developmentScanLoading, setDevelopmentScanLoading] = useState(false);
  const [manageTaskboardSkillPath, setManageTaskboardSkillPath] = useState("");
  const [taskboardMetadata, setTaskboardMetadata] = useState<TaskboardMetadata | null>(null);
  const [localAiChatAvailable, setLocalAiChatAvailable] = useState(false);
  const [aiImportReadyProjectId, setAiImportReadyProjectId] = useState<string | null>(null);
  const [aiThreads, setAiThreads] = useState<AiChatThread[]>([]);
  const [aiOpenThreadRequest, setAiOpenThreadRequest] = useState<AiChatOpenThreadRequest | null>(null);
  const aiOpenThreadRequestSequenceRef = useRef(0);
  const handleAiOpenThreadRequestHandled = useCallback((requestId: number) => {
    setAiOpenThreadRequest((current) => (
      current?.requestId === requestId ? null : current
    ));
  }, []);
  const [readActivityKeys, setReadActivityKeys] = useState<Record<string, string>>({});
  const [codexThreadProgress, setCodexThreadProgress] = useState<
    Record<string, {
      completed: number | null;
      total: number | null;
      running: boolean;
    } | null>
  >({});
  const [paseoAgentPresentations, setPaseoAgentPresentations] = useState<Record<string, PaseoAgentPresentation>>({});
  const [paseoAutomations, setPaseoAutomations] = useState<Record<string, PaseoAutomationState>>({});
  const [paseoAutomationPending, setPaseoAutomationPending] = useState(false);
  const [paseoAutomationError, setPaseoAutomationError] = useState<string | null>(null);
  const [paseoAssignments, setPaseoAssignments] = useState<Record<string, PaseoTaskAssignment>>({});
  const [paseoAssignmentOptions, setPaseoAssignmentOptions] = useState<PaseoAssignmentOptions | null>(null);
  const [paseoAssignmentOptionsLoading, setPaseoAssignmentOptionsLoading] = useState(false);
  const [paseoAssignmentOptionsError, setPaseoAssignmentOptionsError] = useState<string | null>(null);
  const [paseoExecutionDialog, setPaseoExecutionDialog] = useState<PaseoExecutionDialogState | null>(null);
  const [recentProjectIds, setRecentProjectIds] = useState(readRecentProjectIds);
  const initialProjectId = query.get("project") ?? recentProjectIds[0] ?? ALL_PROJECTS_ID;
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [projectLoadError, setProjectLoadError] = useState<ProjectLoadError | null>(null);
  const [tasksLoadError, setTasksLoadError] = useState<TasksLoadError | null>(null);
  const loadError: LoadError | null = projectLoadError ?? tasksLoadError;
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const actionErrorText = actionError === null
    ? null
    : typeof actionError === "string"
      ? actionError
      : isPendingTaskSyncError(actionError)
        ? actionError.message
        : text(actionError[0], actionError[1]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(readTaskFilters);
  const [boardView, setBoardView] = useState<BoardView>(() => readProjectBoardView(initialProjectId));
  const [projectBoardDisplaySettings, setProjectBoardDisplaySettings] = useState(
    readProjectBoardDisplaySettings,
  );
  const refreshProjectBoardDisplaySettings = useCallback(async () => {
    try {
      await refreshProjectBoardDisplaySettingsStorage();
      setProjectBoardDisplaySettings(readProjectBoardDisplaySettings());
    } catch (error) {
      console.error(error);
    }
  }, []);
  const [dashboardSummaryAnimatedProjectId, setDashboardSummaryAnimatedProjectId] = useState<string | null>(null);
  const [ganttZoom, setGanttZoom] = useState<GanttZoom>("week");
  const [ganttHideCompleted, setGanttHideCompleted] = useState(false);
  const [ganttTodayRequest, setGanttTodayRequest] = useState(0);
  const [ganttViewMenuOpen, setGanttViewMenuOpen] = useState(false);
  const [otherTasksOpen, setOtherTasksOpen] = useState(false);
  const [otherTasksMounted, setOtherTasksMounted] = useState(false);
  const [otherTasksVisible, setOtherTasksVisible] = useState(false);
  const [otherTasksTab, setOtherTasksTab] = useState<OtherTaskTab>("backlog");
  const [restoringTaskId, setRestoringTaskId] = useState<string | null>(null);
  const [pendingArchivedTaskDelete, setPendingArchivedTaskDelete] = useState<Task | null>(null);
  const [pendingSelectedTaskDelete, setPendingSelectedTaskDelete] = useState<Task[] | null>(null);
  const [pendingTaskProjectMove, setPendingTaskProjectMove] = useState<{
    task: Task;
    targetProjectId: string | null;
  } | null>(null);
  const [taskProjectMoveSearch, setTaskProjectMoveSearch] = useState("");
  const [taskProjectMoveError, setTaskProjectMoveError] = useState<string | null>(null);
  const [movingTaskProject, setMovingTaskProject] = useState(false);
  const [deletingArchivedTaskId, setDeletingArchivedTaskId] = useState<string | null>(null);
  const batchDeleteInFlightRef = useRef(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [ideaSelectionMode, setIdeaSelectionMode] = useState(false);
  const [selectedIdeaIds, setSelectedIdeaIds] = useState<Set<string>>(() => new Set());
  const [newTaskDraft, setNewTaskDraft] = useState<{
    projectId: string;
    targetProjectId: string | null;
    draft: NewTaskEditorDraft;
  } | null>(null);
  const [detailTaskIdentifier, setDetailTaskIdentifier] = useState<string | null>(
    () => readIssueIdentifier(window.location.search),
  );
  const [commentsRevision, setCommentsRevision] = useState(0);
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
  const [readmeRevision, setReadmeRevision] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskIds, setDraggedTaskIds] = useState<Set<string>>(() => new Set());
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [batchMovingTaskIds, setBatchMovingTaskIds] = useState<Set<string>>(() => new Set());
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingThreadTaskId, setOpeningThreadTaskId] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(
    () => taskboardStorage.getItem(FIRST_USE_COMPLETE_KEY) === null,
  );
  const [projectMenuSearch, setProjectMenuSearch] = useState("");
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectCreateId, setProjectCreateId] = useState<string | null>(null);
  const [projectCreateDefaults, setProjectCreateDefaults] = useState<PaseoProjectDefaultsValue>({
    profile: null,
    workspacePath: null,
  });
  const [projectCreateDefaultsOpen, setProjectCreateDefaultsOpen] = useState(false);
  const [projectDefaultsProjectId, setProjectDefaultsProjectId] = useState<string | null>(null);
  const [projectSettingsName, setProjectSettingsName] = useState("");
  const [projectDefaultsLoading, setProjectDefaultsLoading] = useState(false);
  const [jiraDialogOpen, setJiraDialogOpen] = useState(false);
  const [jiraConnection, setJiraConnection] = useState<JiraConnection | null>(null);
  const [jiraSaving, setJiraSaving] = useState(false);
  const [jiraSyncing, setJiraSyncing] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [pendingProjectDelete, setPendingProjectDelete] = useState<ProjectChoice | null>(null);
  const [projectDeleteIssueCount, setProjectDeleteIssueCount] = useState<number | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deviceWorkspacePaths, setDeviceWorkspacePaths] = useState(readDeviceWorkspacePaths);
  const [projectCodexIdentities, setProjectCodexIdentities] = useState(readProjectCodexIdentities);
  const [projectAutomations, setProjectAutomations] = useState(readProjectAutomations);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [automationCatalog, setAutomationCatalog] = useState<{
    projectId: string;
    models: AiChatModel[];
  } | null>(null);
  const [automationCatalogLoading, setAutomationCatalogLoading] = useState(false);
  const [automationCatalogError, setAutomationCatalogError] = useState<string | null>(null);
  const [announcement, setAnnouncementValue] = useState("");
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
  const projectsRequestRef = useRef(0);
  const tasksRequestRef = useRef(0);
  const tasksRef = useRef<Task[]>([]);
  const draggedTaskIdsRef = useRef<string[]>([]);
  const batchMoveInFlightRef = useRef(false);
  const paseoHostRouteInitializedRef = useRef(false);
  const paseoAssignmentOptionsRequestRef = useRef(0);
  const pendingPaseoAssignmentSaveRef = useRef(new Map<string, {
    resolve: (assignment: PaseoTaskAssignment | null) => void;
    reject: (error: Error) => void;
    timeoutId: number;
  }>());
  const undoSequenceRef = useRef(0);
  const undoStackRef = useRef<UndoOperation[]>([]);
  const undoInFlightRef = useRef(false);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const issueListRef = useRef<HTMLDivElement>(null);
  const boardScrollRef = useRef<HTMLDivElement>(null);
  const boardColumnScrollRefs = useRef<Partial<Record<TaskStatus, HTMLDivElement | null>>>({});
  const detailSourceProjectIdRef = useRef<string | null>(null);
  const pendingDetailSourceScrollRef = useRef<DetailSourceScroll | null>(null);
  const taskScopeProjectId = detailSourceProjectIdRef.current ?? selectedProjectId;
  const taskScopeProjectIdRef = useRef(taskScopeProjectId);
  taskScopeProjectIdRef.current = taskScopeProjectId;

  const revisionPollingInterval = getRevisionPollingInterval(taskboardMetadata);
  const revisionWebSocketConfig = getRevisionWebSocketConfig(taskboardMetadata);
  const revisionWebSocketEndpoint = revisionWebSocketConfig?.endpoint ?? null;
  const textRef = useRef(text);
  textRef.current = text;
  setApiText(text);
  function errorMessage(error: unknown): string {
    if (error instanceof ApiError) return error.message;
    if (error instanceof Error) return error.message;
    return textRef.current(
      "加载议题时出现问题。",
      "Something went wrong while loading your issues.",
    );
  }
  const pendingAutomationRequestsRef = useRef(new Map<string, PendingAutomationRequest>());
  const pendingPaseoAutomationRequestsRef = useRef(new Map<string, PendingPaseoAutomationRequest>());
  const pendingPaseoProjectDefaultsRequestsRef = useRef(new Map<string, PendingPaseoProjectDefaultsRequest>());
  const pendingPaseoConfigurationRequestsRef = useRef(new Map<string, PendingPaseoConfigurationRequest>());
  const pendingPaseoMergeRequestsRef = useRef(new Map<string, PendingPaseoMergeRequest>());
  const pendingPaseoCopyRequestsRef = useRef(new Map<string, PendingPaseoCopyRequest>());
  const copyActionErrorRef = useRef<string | null>(null);
  const paseoAutomationRequestGateRef = useRef<ReturnType<typeof createPaseoAutomationRequestGate> | null>(null);
  if (!paseoAutomationRequestGateRef.current) {
    paseoAutomationRequestGateRef.current = createPaseoAutomationRequestGate(setPaseoAutomationPending);
  }
  const automationRequestInFlightRef = useRef<"list" | "save" | null>(null);
  const loadedAutomationProjectIdsRef = useRef(new Set<string>());
  const queuedAutomationSavesRef = useRef(new Map<string, QueuedProjectAutomationSave>());
  const projectAutomationsRef = useRef(projectAutomations);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setAnnouncement = useCallback((message: string) => {
    setUndoNotice(null);
    setAnnouncementValue(message);
  }, []);

  const markDashboardSummaryAnimationStarted = useCallback((projectId: string) => {
    setDashboardSummaryAnimatedProjectId(projectId);
  }, []);

  const rememberDeviceWorkspacePath = useCallback((projectId: string, workspacePath: string) => {
    if (projectId === GLOBAL_PROJECT_ID) return;
    const normalizedPath = workspacePath.trim();
    setDeviceWorkspacePaths((current) => {
      if (current[projectId] === normalizedPath || (!normalizedPath && !(projectId in current))) {
        return current;
      }
      const next = { ...current };
      if (normalizedPath) next[projectId] = normalizedPath;
      else delete next[projectId];
      taskboardStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const rememberProjectOpen = useCallback((projectId: string) => {
    setRecentProjectIds((current) => {
      if (current[0] === projectId) return current;
      const next = [projectId, ...current.filter((candidate) => candidate !== projectId)];
      taskboardStorage.setItem(RECENT_PROJECT_IDS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedCodexProjectIdentity = useMemo(
    () => selectedProject ? codexProjectContextForTaskProject(selectedProject.id) : null,
    [deviceWorkspacePaths, hostContext, projectCodexIdentities, projects, selectedProject?.id],
  );
  const isAllProjects = selectedProjectId === ALL_PROJECTS_ID;
  const isJiraProject = selectedProject?.source === "jira";
  const savedBoardDisplaySettings = projectBoardDisplaySettings[selectedProjectId];
  // 曾经自动写入的原版默认四列不是用户自定义；Paseo 继续采用用户约定的三列默认。
  const usesPaseoDefaultBoard = host === "paseo" && (
    savedBoardDisplaySettings === undefined
    || sameBoardDisplaySettings(
      savedBoardDisplaySettings,
      isAllProjects ? ALL_PROJECTS_DEFAULT_BOARD_DISPLAY_SETTINGS : DEFAULT_BOARD_DISPLAY_SETTINGS,
    )
  );
  const storedBoardDisplaySettings = savedBoardDisplaySettings
    ?? (usesPaseoDefaultBoard
      ? PASEO_DEFAULT_BOARD_DISPLAY_SETTINGS
      : (
        isAllProjects
          ? ALL_PROJECTS_DEFAULT_BOARD_DISPLAY_SETTINGS
          : DEFAULT_BOARD_DISPLAY_SETTINGS
      ))
  const boardDisplaySettings: BoardDisplaySettings = isAllProjects
    && storedBoardDisplaySettings.sidebarStatuses.includes("backlog")
    && !storedBoardDisplaySettings.mainStatuses.includes("backlog")
    ? {
        ...storedBoardDisplaySettings,
        mainStatuses: ["backlog", ...storedBoardDisplaySettings.mainStatuses],
        sidebarStatuses: storedBoardDisplaySettings.sidebarStatuses.filter(
          (status) => status !== "backlog",
        ),
      }
    : storedBoardDisplaySettings;
  const automationModels = automationCatalog && automationCatalog.projectId === selectedProject?.id
    ? automationCatalog.models
    : [];
  useEffect(() => {
    setAutomationCatalog(null);
    setAutomationCatalogError(null);
    if (host === "paseo" || !selectedProject || !localAiChatAvailable) {
      setAutomationCatalogLoading(false);
      return;
    }
    const controller = new AbortController();
    setAutomationCatalogLoading(true);
    void getAiChatCatalog(
      selectedProject.id,
      controller.signal,
      selectedCodexProjectIdentity,
    ).then(
      (catalog) => {
        if (controller.signal.aborted) return;
        setAutomationCatalog({ projectId: selectedProject.id, models: catalog.models });
        setAutomationCatalogLoading(false);
      },
      (error) => {
        if (controller.signal.aborted) return;
        setAutomationCatalogError(error instanceof Error
          ? error.message
          : text("无法读取 Codex 模型目录", "Could not load the Codex model catalog."));
        setAutomationCatalogLoading(false);
      },
    );
    return () => controller.abort();
  }, [
    localAiChatAvailable,
    host,
    selectedCodexProjectIdentity?.codexHostId,
    selectedCodexProjectIdentity?.codexProjectId,
    selectedCodexProjectIdentity?.codexProjectKind,
    selectedCodexProjectIdentity?.workspacePath,
    selectedProject?.id,
    text,
  ]);
  const aiImportProjectId = hasLoadedTasks
    && tasks.length === 0
    && selectedProject
    && selectedProject.id !== GLOBAL_PROJECT_ID
    && !isJiraProject
    && localAiChatAvailable
      ? selectedProject.id
      : null;
  useEffect(() => {
    setAiImportReadyProjectId(null);
    if (!aiImportProjectId) return;
    const controller = new AbortController();
    void getAiChatCatalog(aiImportProjectId, controller.signal, selectedCodexProjectIdentity)
      .then(() => {
        if (!controller.signal.aborted) setAiImportReadyProjectId(aiImportProjectId);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [
    aiImportProjectId,
    selectedCodexProjectIdentity?.codexHostId,
    selectedCodexProjectIdentity?.codexProjectId,
    selectedCodexProjectIdentity?.codexProjectKind,
    selectedCodexProjectIdentity?.workspacePath,
  ]);
  useLayoutEffect(() => {
    if (selectedProject) rememberProjectOpen(selectedProject.id);
  }, [rememberProjectOpen, selectedProject]);
  const currentUser = hostContext?.user ?? {
    ...DEFAULT_USER_ACTOR,
    name: text("本地用户", "Local user"),
  };
  const selectedDeviceWorkspacePath = selectedProjectId === GLOBAL_PROJECT_ID || isAllProjects
    ? undefined
    : deviceWorkspacePaths[selectedProjectId];
  const selectedProjectAutomation = projectAutomations[selectedProjectId];
  const selectedPaseoAutomation = paseoAutomations[selectedProjectId];
  const automationProjectContext = useMemo<Partial<CodexProjectIdentity> & {
    unavailableReason: string | null;
  }>(() => {
    if (!embedded || window.parent === window) {
      return { unavailableReason: text("仅可在 Codex App 中使用", "Available only in the Codex app") };
    }
    if (!isLocalTaskboardOrigin(new URL(document.baseURI).origin)) {
      return { unavailableReason: text("仅本地任务面板可用", "Available only on the local taskboard") };
    }
    if (!selectedProject) {
      return { unavailableReason: text("请先选择项目", "Select a project first") };
    }

    const savedIdentity = projectCodexIdentities[selectedProject.id];
    if (savedIdentity?.codexProjectKind === "remote") {
      const liveProject = hostContext?.projects?.find(
        (project) => project.id === savedIdentity.codexProjectId,
      );
      if (
        liveProject?.projectKind !== "remote"
        || liveProject.hostId !== savedIdentity.codexHostId
        || liveProject.workspacePath !== savedIdentity.workspacePath
      ) {
        return { unavailableReason: text(
          "已保存的 SSH 远程项目或主机当前不可用",
          "The saved SSH remote project or host is not available",
        ) };
      }
      if (!manageTaskboardSkillPath) {
        return { unavailableReason: text(
          "任务面板还没有读取到 Skill 路径",
          "Taskboard has not received the Skill path",
        ) };
      }
      return { ...savedIdentity, unavailableReason: null };
    }

    const effectiveCodexProjectId = selectedProject.id === GLOBAL_PROJECT_ID
      ? hostContext?.projectId
      : selectedProject.id;
    const directCodexProject = hostContext?.projects?.find(
      (project) => project.id === effectiveCodexProjectId,
    );
    const workspacePath = (
      directCodexProject?.projectKind === "remote"
        ? directCodexProject.workspacePath
        : undefined
    )
      ?? deviceWorkspacePaths[selectedProject.id]
      ?? selectedProject.workspacePath
      ?? directCodexProject?.workspacePath
      ?? (
        directCodexProject && hostContext?.projectId === effectiveCodexProjectId
          ? hostContext?.workspacePath
          : undefined
      );
    const codexProjectId = directCodexProject
      ? directCodexProject.id
      : hostContext?.projects?.find(
        (project) => (deviceWorkspacePaths[project.id] ?? project.workspacePath) === workspacePath,
      )?.id;

    if (!workspacePath || !codexProjectId) {
      return { unavailableReason: text(
        "请先在 Codex 中添加并映射该项目目录",
        "Add and map this project directory in Codex first",
      ) };
    }
    if (!manageTaskboardSkillPath) {
      return { unavailableReason: text(
        "任务面板还没有读取到 Skill 路径",
        "Taskboard has not received the Skill path",
      ) };
    }
    const codexProject = hostContext?.projects?.find((project) => project.id === codexProjectId);
    return {
      workspacePath,
      codexProjectId,
      codexProjectKind: codexProject?.projectKind ?? "local",
      codexHostId: codexProject?.hostId ?? "local",
      unavailableReason: null,
    };
  }, [
    deviceWorkspacePaths,
    embedded,
    hostContext,
    manageTaskboardSkillPath,
    projectCodexIdentities,
    selectedProject,
    text,
  ]);
  const automationRequestContext = useMemo<AutomationRequestContext | null>(() => {
    if (
      !selectedProject
      || !automationProjectContext.codexProjectId
      || !automationProjectContext.codexProjectKind
      || !automationProjectContext.codexHostId
      || !automationProjectContext.workspacePath
      || !manageTaskboardSkillPath
    ) return null;
    return {
      taskboardProjectId: selectedProject.id,
      codexProjectId: automationProjectContext.codexProjectId,
      codexProjectKind: automationProjectContext.codexProjectKind,
      codexHostId: automationProjectContext.codexHostId,
      projectName: selectedProject.name,
      workspacePath: automationProjectContext.workspacePath,
      remoteProjects: automationProjectContext.codexProjectKind === "remote"
        ? (hostContext?.projects ?? [])
            .filter((project) => (
              project.projectKind === "remote"
              && project.hostId === automationProjectContext.codexHostId
              && typeof project.workspacePath === "string"
            ))
            .map((project) => ({
              codexProjectId: project.id,
              codexProjectKind: "remote" as const,
              codexHostId: project.hostId!,
              workspacePath: project.workspacePath!,
            }))
            .sort((left, right) => (
              left.workspacePath.localeCompare(right.workspacePath)
              || left.codexProjectId.localeCompare(right.codexProjectId)
            ))
        : [],
      skillPath: manageTaskboardSkillPath,
    };
  }, [automationProjectContext, hostContext, manageTaskboardSkillPath, selectedProject]);
  const referenceTasks = useMemo(() => [...tasks, ...archivedTasks], [archivedTasks, tasks]);
  const detailTask = detailTaskIdentifier
    ? referenceTasks.find((task) => task.identifier === detailTaskIdentifier) ?? null
    : null;
  const detailTaskId = detailTask?.id ?? null;
  const contextMenuTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;
  const contextMenuWorkspacePath = contextMenuTask
    ? deviceWorkspacePaths[contextMenuTask.projectId]
    : undefined;
  const availableLabels = isAllProjects
    ? [...new Set(projects.flatMap((project) => project.labels))]
    : selectedProject?.labels ?? [];
  const projectNames = useMemo(() => Object.fromEntries(projects.map((project) => [
    project.id,
    project.id === GLOBAL_PROJECT_ID ? text("临时任务", "Temporary tasks") : project.name,
  ])), [projects, text]);
  const projectChoices = useMemo<ProjectChoice[]>(() => {
    const persistedById = new Map(projects.map((project) => [project.id, project]));
    const seen = new Set<string>();
    const choices: ProjectChoice[] = [];
    for (const project of hostContext?.projects ?? []) {
      if (!project.id || !project.name || seen.has(project.id)) continue;
      seen.add(project.id);
      choices.push({
        id: project.id,
        name: project.id === GLOBAL_PROJECT_ID
          ? text("临时任务", "Temporary tasks")
          : persistedById.get(project.id)?.name ?? project.name,
        issueCount: persistedById.get(project.id)?.issueCount ?? 0,
        inCodex: true,
        persisted: persistedById.has(project.id),
        codexIdentity: project.workspacePath && project.projectKind && project.hostId
          ? {
              codexProjectId: project.id,
              codexProjectKind: project.projectKind,
              codexHostId: project.hostId,
              workspacePath: project.workspacePath,
            }
          : null,
      });
    }
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      choices.push({
        id: project.id,
        name: project.id === GLOBAL_PROJECT_ID
          ? text("临时任务", "Temporary tasks")
          : project.name,
        issueCount: project.issueCount,
        inCodex: false,
        persisted: true,
        codexIdentity: projectCodexIdentities[project.id] ?? null,
      });
    }
    const recentOrder = new Map(recentProjectIds.map((projectId, index) => [projectId, index]));
    const sortedChoices = choices.sort((left, right) => (
      (recentOrder.get(left.id) ?? recentProjectIds.length)
      - (recentOrder.get(right.id) ?? recentProjectIds.length)
    ));
    return [
      ...sortedChoices.filter((project) => project.issueCount > 0),
      ...sortedChoices.filter((project) => project.issueCount === 0),
    ];
  }, [hostContext?.projects, projectCodexIdentities, projects, recentProjectIds, text]);
  const projectMenuCandidates = projectChoices.filter(
    (project) => host === "paseo" || project.id !== GLOBAL_PROJECT_ID || project.issueCount > 0,
  );
  const persistedProjectsById = new Map(projects.map((project) => [project.id, project]));
  function projectActionsFor(project: ProjectChoice) {
    const persistedProject = persistedProjectsById.get(project.id);
    const isLocalProject = persistedProject?.source === "local";
    return {
      canEdit: host === "paseo" && isLocalProject,
      canDelete: isLocalProject && (
        host === "paseo"
          ? project.id !== GLOBAL_PROJECT_ID
          : project.id.startsWith("temp-")
      ),
    };
  }
  const projectSettingsProject = projectDefaultsProjectId
    ? projects.find((project) => project.id === projectDefaultsProjectId) ?? null
    : null;
  const projectSettingsChoice = projectDefaultsProjectId
    ? projectChoices.find((project) => project.id === projectDefaultsProjectId) ?? null
    : null;
  const projectSettingsCanDelete = projectSettingsChoice
    ? projectActionsFor(projectSettingsChoice).canDelete
    : false;
  const projectContextActions = projectContextMenu
    ? projectActionsFor(projectContextMenu.project)
    : null;
  const projectMenuNeedle = projectMenuSearch.trim().toLocaleLowerCase();
  const projectMenuChoices = projectMenuNeedle
    ? projectMenuCandidates.filter((project) => project.name.toLocaleLowerCase().includes(projectMenuNeedle))
    : projectMenuCandidates;
  const taskProjectMoveNeedle = taskProjectMoveSearch.trim().toLocaleLowerCase();
  const taskProjectMoveTargets = pendingTaskProjectMove
    ? projects.map((project) => ({
        ...project,
        name: projectChoices.find((choice) => choice.id === project.id)?.name ?? project.name,
      })).filter((project) => (
        project.source === "local"
          && project.id !== pendingTaskProjectMove.task.projectId
          && project.id !== ALL_PROJECTS_ID
          && (!taskProjectMoveNeedle || project.name.toLocaleLowerCase().includes(taskProjectMoveNeedle))
      ))
    : [];
  const firstEmptyProjectId = projectMenuChoices.find((project) => project.issueCount === 0)?.id ?? null;
  const hasProjectsWithIssues = projectMenuChoices.some((project) => project.issueCount > 0);
  const editorProjectId = editor?.projectId
    ?? (newTaskDraft?.projectId === selectedProjectId ? newTaskDraft.targetProjectId : undefined)
    ?? (isAllProjects ? GLOBAL_PROJECT_ID : selectedProjectId);
  const editorMergeSources = editor?.mergeSources ?? [];
  const developmentEditorProjectId = isAllProjects && editor ? editorProjectId : null;
  const paseoProviderIcons = useMemo(() => new Map(
    (paseoAssignmentOptions?.providers ?? []).map((provider) => [provider.id, provider.iconDataUrl]),
  ), [paseoAssignmentOptions]);
  const paseoAssignmentsRef = useRef(paseoAssignments);
  const paseoProviderIconsRef = useRef(paseoProviderIcons);
  paseoAssignmentsRef.current = paseoAssignments;
  paseoProviderIconsRef.current = paseoProviderIcons;
  const paseoAssigneeChoices = useMemo(() => {
    const options: PaseoAssigneeOption[] = [
      { id: "paseo:self", label: `${currentUser.name}（我）`, group: "self" },
      { id: "paseo:unassigned", label: "未分配", detail: "仅保存任务，不绑定或创建 Agent", group: "self" },
      {
        id: "paseo:project-default",
        label: "使用项目默认 Agent",
        detail: "开始任务时读取项目当前默认配置",
        group: "self",
        requiresWorkspace: true,
      },
    ];
    const choices = new Map<string, PaseoAssignmentChoice>([
      ["paseo:self", { kind: "self" }],
      ["paseo:unassigned", { kind: "unassigned" }],
      ["paseo:project-default", { kind: "planned", profile: null }],
    ]);
    const catalog = paseoAssignmentOptions;
    if (!catalog) return { options, choices };
    const providerChoices = new Map(catalog.providers.map((provider) => [provider.id, provider]));
    for (const [index, profile] of catalog.profiles.entries()) {
      const id = `paseo:profile:${profile.id}`;
      options.push({
        id,
        label: profile.name,
        detail: `${profile.provider}${profile.model ? `/${profile.model}` : ""} · 可继承项目默认目录`,
        group: "profile",
        provider: profile.provider,
        model: profile.model,
        modeId: profile.modeId,
        thinkingOptionId: profile.thinkingOptionId,
        iconDataUrl: providerChoices.get(profile.provider)?.iconDataUrl ?? null,
        profileIcon: profile.icon,
        hiddenFromRoot: index >= 4,
        requiresWorkspace: true,
      });
      choices.set(id, { kind: "planned", profile });
    }
    for (const provider of catalog.providers) {
      const modelCount = catalog.models.filter((model) => model.provider === provider.id).length;
      options.push({
        id: `paseo:provider:${provider.id}`,
        label: provider.label,
        detail: `${modelCount} 个模型`,
        group: "provider",
        kind: "provider",
        providerId: provider.id,
        provider: provider.id,
        iconDataUrl: provider.iconDataUrl,
      });
    }
    for (const model of catalog.models) {
      const id = `paseo:model:${model.id}`;
      options.push({
        id,
        label: model.name,
        detail: `${providerChoices.get(model.provider)?.label ?? model.provider} · ${model.model ?? "默认模型"}`,
        group: "profile",
        providerId: model.provider,
        provider: model.provider,
        model: model.model,
        modeId: model.modeId,
        thinkingOptionId: model.thinkingOptionId,
        iconDataUrl: providerChoices.get(model.provider)?.iconDataUrl ?? null,
        hiddenFromRoot: true,
        requiresWorkspace: true,
      });
      choices.set(id, { kind: "planned", profile: model });
    }
    options.push({
      id: "paseo:agents",
      label: "绑定已有会话",
      detail: "选择后仅保存绑定，不发送消息",
      group: "agent",
      kind: "agent-browser",
    });
    for (const agent of catalog.agents) {
      const id = `paseo:agent:${agent.id}`;
      const status = agent.requiresAttention
        ? "等待权限"
        : agent.status === "running" ? "运行中" : agent.status;
      const occupied = agent.assignedTaskIdentifier;
      options.push({
        id,
        label: agent.title ?? `Paseo · ${agent.provider}${agent.model ? `/${agent.model}` : ""}`,
        detail: `${(agent.workspaceName ?? agent.cwd) || "未知工作区"} · ${agent.provider}${agent.model ? `/${agent.model}` : ""} · ${status}`,
        group: "agent",
        provider: agent.provider,
        model: agent.model,
        workspacePath: agent.cwd,
        agentId: agent.id,
        iconDataUrl: providerChoices.get(agent.provider)?.iconDataUrl ?? null,
        hiddenFromRoot: true,
        disabled: Boolean(occupied),
        disabledReason: occupied ? `已绑定到任务 ${occupied}，不能抢占。` : undefined,
      });
      choices.set(id, { kind: "existing", agentId: agent.id });
    }
    return { options, choices };
  }, [currentUser.name, paseoAssignmentOptions]);
  const paseoAutomationProfiles = useMemo(() => new Map(
    [...paseoAssigneeChoices.choices.entries()].flatMap(([id, choice]) => (
      choice.kind === "planned" && choice.profile ? [[id, choice.profile] as const] : []
    )),
  ), [paseoAssigneeChoices]);
  function refreshPaseoAssignmentOptions(projectId = editorProjectId ?? detailTask?.projectId) {
    if (host !== "paseo" || !embeddedFrameChallenge || !projectId) return;
    const requestId = ++paseoAssignmentOptionsRequestRef.current;
    setPaseoAssignmentOptionsLoading(true);
    setPaseoAssignmentOptionsError(null);
    postEmbeddedHostMessage({
      type: "taskboard:paseo-assignment-options-request",
      payload: { requestId, projectId },
    });
  }

  const loadPaseoConfigurationOptions = useCallback((target: PaseoConfigurationOptionsRequest) => {
    if (host !== "paseo" || !embeddedFrameChallenge) {
      return Promise.reject(new Error("Paseo 配置桥尚未就绪。"));
    }
    const requestId = crypto.randomUUID();
    const response = new Promise<PaseoConfigurationOptions>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingPaseoConfigurationRequestsRef.current.delete(requestId);
        reject(new Error("Paseo 配置选项没有响应，请重试。"));
      }, 15_000);
      pendingPaseoConfigurationRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });
    postEmbeddedHostMessage({
      type: "taskboard:paseo-configuration-options-request",
      payload: { requestId, ...target },
    });
    return response;
  }, [embeddedFrameChallenge, host]);

  const paseoProjectDefaultsCatalog: PaseoProjectDefaultsCatalog = {
    options: paseoAssigneeChoices.options.filter((option) => (
      option.group === "profile" || option.group === "provider"
    )),
    profiles: paseoAutomationProfiles,
    workspaces: (paseoAssignmentOptions?.workspaces ?? []).flatMap((workspace) => (
      workspace.path ? [{ ...workspace, path: workspace.path }] : []
    )),
    loading: paseoAssignmentOptionsLoading,
    error: paseoAssignmentOptionsError,
    onRefresh: () => {
      const projectId = projectDefaultsProjectId
        ?? projectCreateId
        ?? (selectedProjectId !== ALL_PROJECTS_ID ? selectedProjectId : undefined);
      if (projectId) refreshPaseoAssignmentOptions(projectId);
    },
    loadConfigurationOptions: loadPaseoConfigurationOptions,
  };

  const requestPaseoMergeIdeas = useCallback((input: PaseoMergeIdeasRequest) => {
    if (host !== "paseo" || !embeddedFrameChallenge) {
      return Promise.reject(new Error("Paseo 合并桥尚未就绪。"));
    }
    const response = new Promise<PaseoMergeIdeasResult>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingPaseoMergeRequestsRef.current.delete(input.requestId);
        reject(new Error("合并请求仍在处理中。当前草稿和重试标识已保留，请稍后重试。"));
      }, 15_000);
      pendingPaseoMergeRequestsRef.current.set(input.requestId, {
        resolve,
        reject,
        timeoutId,
        sourceTaskIds: input.sourceTaskIds,
      });
    });
    postEmbeddedHostMessage({
      type: "taskboard:paseo-merge-ideas-request",
      payload: input,
    });
    return response;
  }, [embeddedFrameChallenge, host]);

  const requestPaseoCopy = useCallback((input:
    | { kind: "text"; text: string }
    | { kind: "issue-link"; projectId: string; identifier: string }
  ) => {
    if (host !== "paseo" || !embeddedFrameChallenge) {
      return Promise.reject(new Error("Paseo 剪贴板桥尚未就绪。"));
    }
    const requestId = crypto.randomUUID();
    const payload = { requestId, ...input } as PaseoCopyRequest;
    const response = new Promise<string>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingPaseoCopyRequestsRef.current.delete(requestId);
        reject(new Error("Paseo 剪贴板没有响应，请重试。"));
      }, 10_000);
      pendingPaseoCopyRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });
    postEmbeddedHostMessage({
      type: "taskboard:paseo-copy-request",
      payload,
    });
    return response;
  }, [embeddedFrameChallenge, host]);

  function savePaseoTaskAssignment(
    task: Pick<Task, "id" | "projectId">,
    choiceId: string | undefined,
    workspacePath?: string | null,
    configuration?: PaseoConfigurationSelection,
    replaceWorkspace = false,
    choiceOverride?: PaseoAssignmentChoice,
  ): Promise<PaseoTaskAssignment | null> {
    const choice = choiceOverride ?? (choiceId ? paseoAssigneeChoices.choices.get(choiceId) : null);
    if (host !== "paseo" || !choice) {
      return Promise.resolve(null);
    }
    const requestId = crypto.randomUUID();
    return new Promise<PaseoTaskAssignment | null>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingPaseoAssignmentSaveRef.current.delete(requestId);
        reject(new PaseoAssignmentSavePendingError());
      }, 15_000);
      pendingPaseoAssignmentSaveRef.current.set(requestId, { resolve, reject, timeoutId });
      postEmbeddedHostMessage({
        type: "taskboard:paseo-assignment-save",
        payload: {
          requestId,
          taskId: task.id,
          projectId: task.projectId,
          choice: choice.kind === "planned" ? {
            ...choice,
            workspacePath: workspacePath ?? null,
            ...(replaceWorkspace ? { replaceWorkspace: true } : {}),
            profile: configuration && choice.profile?.model ? {
              ...choice.profile,
              modeId: configuration.modeId,
              thinkingOptionId: configuration.thinkingOptionId,
            } : choice.profile,
          } : choice,
        },
      });
    });
  }

  function paseoAssignmentValue(task: Task): string {
    const assignment = paseoAssignments[task.id];
    if (!assignment) {
      const projectDefaults = paseoAutomations[task.projectId];
      if (projectDefaults?.profile || projectDefaults?.workspacePath) return "paseo:project-default";
      return task.assignee.id === PASEO_UNASSIGNED_ACTOR.id ? "paseo:unassigned" : "paseo:self";
    }
    if (assignment.kind === "existing") return `paseo:agent:${assignment.agentId}`;
    if (!assignment.profile) return "paseo:project-default";
    for (const [id, choice] of paseoAssigneeChoices.choices) {
      if (
        choice.kind === "planned"
        && choice.profile
        && (
          choice.profile.id === assignment.profile.id
          || (
            choice.profile.provider === assignment.profile.provider
            && choice.profile.model === assignment.profile.model
          )
        )
      ) return id;
    }
    return "paseo:self";
  }

  function configurationTargetForAssignment(
    assignment: PaseoTaskAssignment | undefined,
  ): PaseoConfigurationOptionsRequest | null {
    if (!assignment) return null;
    if (assignment.kind === "planned") {
      if (!assignment.profile?.model) return null;
      return {
        provider: assignment.profile.provider,
        model: assignment.profile.model,
        workspacePath: assignment.workspacePath,
        ...(assignment.profile.modeId ? { modeId: assignment.profile.modeId } : {}),
        ...(assignment.profile.thinkingOptionId
          ? { thinkingOptionId: assignment.profile.thinkingOptionId }
          : {}),
      };
    }
    const agent = paseoAssignmentOptions?.agents.find((candidate) => candidate.id === assignment.agentId);
    if (!assignment.model || !agent?.cwd) return null;
    return {
      provider: assignment.provider,
      model: assignment.model,
      workspacePath: agent.cwd,
      agentId: assignment.agentId,
    };
  }

  async function changePaseoTaskAssignment(
    task: Pick<Task, "id" | "projectId">,
    choiceId: string,
    workspacePath?: string | null,
    configuration?: PaseoConfigurationSelection,
    propagateError = false,
    replaceWorkspace = false,
    choiceOverride?: PaseoAssignmentChoice,
  ) {
    setActionError(null);
    try {
      const assignment = await savePaseoTaskAssignment(
        task,
        choiceId,
        workspacePath,
        configuration,
        replaceWorkspace,
        choiceOverride,
      );
      setPaseoAssignments((current) => {
        const next = { ...current };
        if (assignment) next[task.id] = assignment;
        else delete next[task.id];
        return next;
      });
    } catch (error) {
      setActionError(errorMessage(error));
      if (propagateError) throw error;
    }
  }

  function openPaseoExecutionDialog(task: Task, preferredChoiceId?: string) {
    const assignment = paseoAssignments[task.id];
    if (assignment?.kind === "existing") return;
    const currentChoiceId = assignment?.kind === "planned" ? paseoAssignmentValue(task) : "";
    const matchedChoiceId = preferredChoiceId
      && paseoAssigneeChoices.choices.get(preferredChoiceId)?.kind === "planned"
      ? preferredChoiceId
      : currentChoiceId === "paseo:project-default"
        || currentChoiceId.startsWith("paseo:profile:")
        || currentChoiceId.startsWith("paseo:model:")
        ? currentChoiceId
        : "";
    const choiceId = assignment?.kind === "planned"
      ? assignment.profile ? PASEO_SAVED_TASK_PLAN_ID : "paseo:project-default"
      : matchedChoiceId;
    const selectedChoice = matchedChoiceId ? paseoAssigneeChoices.choices.get(matchedChoiceId) : null;
    const initialProfile = assignment?.kind === "planned"
      ? assignment.profile
      : selectedChoice?.kind === "planned" ? selectedChoice.profile : null;
    setPaseoExecutionDialog({
      taskId: task.id,
      projectId: task.projectId,
      taskIdentifier: task.externalKey ?? task.identifier,
      initialChoiceId: choiceId,
      initialProfile,
      initialWorkspacePath: assignment?.kind === "planned"
        ? assignment.workspacePath
        : task.developmentContext?.type === "worktree" ? task.developmentContext.path : null,
      ...(initialProfile?.modeId ? { initialModeId: initialProfile.modeId } : {}),
      ...(initialProfile?.thinkingOptionId
        ? { initialThinkingOptionId: initialProfile.thinkingOptionId }
        : {}),
    });
    refreshPaseoAssignmentOptions(task.projectId);
  }
  const createTargetProjects = projectChoices.flatMap((choice) => {
    const project = projects.find((candidate) => candidate.id === choice.id);
    return project && project.source !== "jira"
      ? [{ id: choice.id, name: choice.name }]
      : [];
  });
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  function openTaskContextMenu(task: Task, position: { x: number; y: number }) {
    if (
      isAllProjects
      && (!embedded || window.parent === window)
      && task.developmentContext?.type === "worktree"
    ) {
      setDevelopmentScanLoading(true);
    }
    setContextMenu({ taskId: task.id, ...position });
  }
  const issueReadMode = taskboardMetadata?.mode ?? "local";

  useEffect(() => {
    let mountFrame = 0;
    let showFrame = 0;
    let closeTimer = 0;

    if (otherTasksOpen) {
      setOtherTasksMounted(true);
      mountFrame = window.requestAnimationFrame(() => {
        showFrame = window.requestAnimationFrame(() => setOtherTasksVisible(true));
      });
    } else {
      setOtherTasksVisible(false);
      closeTimer = window.setTimeout(() => setOtherTasksMounted(false), 320);
    }

    return () => {
      window.cancelAnimationFrame(mountFrame);
      window.cancelAnimationFrame(showFrame);
      window.clearTimeout(closeTimer);
    };
  }, [otherTasksOpen]);

  const markTaskRead = useCallback((task: Task) => {
    if (!task.activityKey) return;
    const storageKey = issueReadStorageKey(issueReadMode, task);
    setReadActivityKeys((current) => {
      if (current[storageKey] === task.activityKey) return current;
      const next = { ...current, [storageKey]: task.activityKey };
      try {
        taskboardStorage.setItem(storageKey, task.activityKey);
      } catch {
        // Read state remains valid for this page even when browser persistence is unavailable.
      }
      return next;
    });
  }, [issueReadMode]);

  useEffect(() => {
    if (detailTask) markTaskRead(detailTask);
  }, [detailTask?.activityKey, detailTask?.id, markTaskRead]);

  const writeProjectAutomation = useCallback((
    projectId: string,
    record: ProjectAutomationRecord | null | undefined,
  ) => {
    setProjectAutomations((current) => {
      if (
        record
        && current[projectId]?.automationId === record.automationId
        && current[projectId]?.codexProjectId === record.codexProjectId
        && current[projectId]?.codexProjectKind === record.codexProjectKind
        && current[projectId]?.codexHostId === record.codexHostId
        && current[projectId]?.workspacePath === record.workspacePath
        && current[projectId]?.status === record.status
        && current[projectId]?.enabledByUser === record.enabledByUser
        && current[projectId]?.quotaAware === record.quotaAware
        && JSON.stringify(current[projectId]?.quota) === JSON.stringify(record.quota)
        && current[projectId]?.intervalMinutes === record.intervalMinutes
        && current[projectId]?.model === record.model
        && current[projectId]?.reasoningEffort === record.reasoningEffort
      ) {
        return current;
      }
      const next = { ...current };
      if (record) next[projectId] = record;
      else delete next[projectId];
      projectAutomationsRef.current = next;
      taskboardStorage.setItem(PROJECT_AUTOMATIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const sendAutomationRequest = useCallback((
    operation: "ensure-active" | "pause" | "list" | "apply-policy",
    options: ProjectAutomationOptions,
    context: AutomationRequestContext,
    automationId?: string,
  ) => {
    if (!options.model || !options.reasoningEffort) {
      return Promise.reject(new Error(textRef.current(
        "Codex 自动化需要选择模型和推理强度。",
        "Codex automation requires a model and reasoning effort.",
      )));
    }
    const requestId = window.crypto.randomUUID();
    const response = new Promise<AutomationHostResponse>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingAutomationRequestsRef.current.delete(requestId);
        reject(new Error(textRef.current(
          "Codex 自动化没有响应，请稍后重试",
          "Codex automation did not respond. Try again later.",
        )));
      }, 10_000);
      pendingAutomationRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });
    postEmbeddedHostMessage({
      type: "taskboard:automation-request",
      payload: {
        requestId,
        operation,
        taskboardProjectId: context.taskboardProjectId,
        codexProjectId: context.codexProjectId,
        codexProjectKind: context.codexProjectKind,
        codexHostId: context.codexHostId,
        projectName: context.projectName,
        workspacePath: context.workspacePath,
        remoteProjects: context.remoteProjects,
        skillPath: context.skillPath,
        ...(automationId ? { automationId } : {}),
        enabledByUser: options.enabledByUser,
        quotaAware: options.quotaAware,
        intervalMinutes: options.intervalMinutes,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      },
    });
    return response;
  }, []);

  const drainQueuedAutomationSaves = useCallback(async (preferredProjectId?: string) => {
    if (automationRequestInFlightRef.current) return;
    let nextProjectId = preferredProjectId;
    while (queuedAutomationSavesRef.current.size > 0) {
      const queuedSave = (
        nextProjectId ? queuedAutomationSavesRef.current.get(nextProjectId) : undefined
      ) ?? queuedAutomationSavesRef.current.values().next().value;
      nextProjectId = undefined;
      if (!queuedSave) return;
      queuedAutomationSavesRef.current.delete(queuedSave.projectId);
      const previousRecord = projectAutomationsRef.current[queuedSave.projectId];
      automationRequestInFlightRef.current = "save";
      setAutomationPending(true);
      setAutomationError(null);
      try {
        if (!queuedSave.options.model || !queuedSave.options.reasoningEffort) {
          throw new Error(textRef.current(
            "Codex 自动化需要选择模型和推理强度。",
            "Codex automation requires a model and reasoning effort.",
          ));
        }
        const response = await sendAutomationRequest(
          "apply-policy",
          queuedSave.options,
          queuedSave.context,
          previousRecord?.automationId,
        );
        const item = isAutomationHostItem(response.item) ? response.item : undefined;
        const policy = isAutomationHostPolicy(response.policy) ? response.policy : null;
        if (!policy) {
          throw new Error(textRef.current(
            "Codex 没有返回实际生效的自动化策略",
            "Codex did not return the effective automation policy.",
          ));
        }
        writeProjectAutomation(queuedSave.projectId, {
          automationId: item?.id ?? policy.automationId,
          codexProjectId: policy.codexProjectId,
          codexProjectKind: policy.codexProjectKind,
          codexHostId: policy.codexHostId,
          workspacePath: policy.workspacePath,
          status: item?.status ?? "PAUSED",
          enabledByUser: policy.enabledByUser,
          quotaAware: policy.quotaAware,
          ...(response.quota ? { quota: response.quota } : {}),
          intervalMinutes: policy.intervalMinutes,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort,
        });
      } catch (error) {
        writeProjectAutomation(queuedSave.projectId, previousRecord);
        setAutomationError(error instanceof Error
          ? error.message
          : textRef.current("无法更新自动化", "Could not update automation."));
      } finally {
        automationRequestInFlightRef.current = null;
        setAutomationPending(false);
      }
    }
  }, [sendAutomationRequest, writeProjectAutomation]);

  const reconcileProjectAutomation = useCallback(async () => {
    if (!automationRequestContext) {
      setAutomationError(null);
      return;
    }
    const models = automationCatalog?.projectId === automationRequestContext.taskboardProjectId
      ? automationCatalog.models
      : null;
    if (!models) return;
    if (automationRequestInFlightRef.current) return;
    const projectId = automationRequestContext.taskboardProjectId;
    const stored = projectAutomationsRef.current[projectId];
    const initialLoad = !loadedAutomationProjectIdsRef.current.has(projectId);
    automationRequestInFlightRef.current = "list";
    if (initialLoad) setAutomationPending(true);
    setAutomationError(null);
    try {
      const defaultModel = models[0];
      let options: ProjectAutomationOptions | undefined = stored;
      if (!options) {
        if (!defaultModel) return;
        options = {
          enabledByUser: false,
          quotaAware: false,
          intervalMinutes: 5,
          model: defaultModel.slug,
          reasoningEffort: defaultModel.defaultReasoningEffort,
        };
      }
      const response = await sendAutomationRequest(
        "list",
        options,
        automationRequestContext,
        stored?.automationId,
      );
      const items = Array.isArray(response.items)
        ? response.items.filter(isAutomationHostItem)
        : [];
      const policy = isAutomationHostPolicy(response.policy) ? response.policy : null;
      const effectiveProjectIdentity = policy ?? automationRequestContext;
      if (!stored) {
        if (!policy) return;
        const item = (isAutomationHostItem(response.item) ? response.item : undefined)
          ?? items.find((candidate) => candidate.id === policy.automationId)
          ?? (items.length === 1 ? items[0] : undefined);
        writeProjectAutomation(projectId, {
          automationId: item?.id ?? policy.automationId,
          codexProjectId: policy.codexProjectId,
          codexProjectKind: policy.codexProjectKind,
          codexHostId: policy.codexHostId,
          workspacePath: policy.workspacePath,
          status: item?.status ?? "PAUSED",
          enabledByUser: policy.enabledByUser,
          quotaAware: policy.quotaAware,
          ...(response.quota ? { quota: response.quota } : {}),
          intervalMinutes: policy.intervalMinutes,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort,
        });
        return;
      }
      const item = (isAutomationHostItem(response.item) ? response.item : undefined)
        ?? items.find((item) => item.id === stored?.automationId)
        ?? (items.length === 1 ? items[0] : undefined);
      if (!item) {
        if (stored) {
          writeProjectAutomation(projectId, {
            ...stored,
            automationId: undefined,
            codexProjectId: effectiveProjectIdentity.codexProjectId,
            codexProjectKind: effectiveProjectIdentity.codexProjectKind,
            codexHostId: effectiveProjectIdentity.codexHostId,
            workspacePath: effectiveProjectIdentity.workspacePath,
            status: "PAUSED",
            enabledByUser: policy?.enabledByUser ?? stored.enabledByUser,
            quotaAware: policy?.quotaAware ?? stored.quotaAware,
            ...(response.quota ? { quota: response.quota } : {}),
            intervalMinutes: policy?.intervalMinutes ?? stored.intervalMinutes,
            model: policy?.model ?? stored.model,
            reasoningEffort: policy?.reasoningEffort ?? stored.reasoningEffort,
          });
        }
        return;
      }
      const intervalMinutes = policy?.intervalMinutes ?? intervalMinutesFromRrule(item.rrule);
      if (!intervalMinutes) return;
      writeProjectAutomation(projectId, {
        automationId: item.id,
        codexProjectId: effectiveProjectIdentity.codexProjectId,
        codexProjectKind: effectiveProjectIdentity.codexProjectKind,
        codexHostId: effectiveProjectIdentity.codexHostId,
        workspacePath: effectiveProjectIdentity.workspacePath,
        status: item.status,
        enabledByUser: policy?.enabledByUser ?? stored.enabledByUser,
        quotaAware: policy?.quotaAware ?? stored.quotaAware,
        ...(
          response.quota
            ? { quota: response.quota }
            : stored.quota
              ? { quota: stored.quota }
              : {}
        ),
        intervalMinutes,
        model: policy?.model ?? item.model,
        reasoningEffort: policy?.reasoningEffort ?? item.reasoningEffort,
      });
    } catch (error) {
      setAutomationError(error instanceof Error
        ? error.message
        : text("无法读取自动化状态", "Could not read the automation status."));
    } finally {
      loadedAutomationProjectIdsRef.current.add(projectId);
      automationRequestInFlightRef.current = null;
      if (initialLoad) setAutomationPending(false);
      void drainQueuedAutomationSaves(projectId);
    }
  }, [
    automationCatalog,
    automationRequestContext,
    drainQueuedAutomationSaves,
    sendAutomationRequest,
    text,
    writeProjectAutomation,
  ]);

  const saveProjectAutomation = useCallback((options: ProjectAutomationOptions) => {
    if (!automationRequestContext) return;
    const queuedSave = {
      projectId: automationRequestContext.taskboardProjectId,
      context: automationRequestContext,
      options,
    };
    queuedAutomationSavesRef.current.set(queuedSave.projectId, queuedSave);
    if (!automationRequestInFlightRef.current) {
      void drainQueuedAutomationSaves(queuedSave.projectId);
    }
  }, [
    automationRequestContext,
    drainQueuedAutomationSaves,
  ]);

  const requestPaseoAutomation = useCallback((
    operation: "get" | "save",
    projectId: string,
    options?: {
      enabledByUser: boolean;
      intervalMinutes: PaseoAutomationIntervalMinutes;
      quotaAware: boolean;
      workspacePath?: string | null;
      profile?: PaseoAssignmentOptions["profiles"][number] | null;
    },
  ) => {
    const requestId = window.crypto.randomUUID();
    const response = new Promise<PaseoAutomationState>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingPaseoAutomationRequestsRef.current.delete(requestId);
        reject(new Error(textRef.current(
          "Paseo 自动认领服务没有响应，请稍后重试。",
          "Paseo auto-claim did not respond. Try again later.",
        )));
      }, 15_000);
      pendingPaseoAutomationRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });
    postEmbeddedHostMessage({
      type: "taskboard:paseo-automation-request",
      payload: {
        requestId,
        operation,
        projectId,
        ...(options ?? {}),
      },
    });
    return response;
  }, []);

  const savePaseoProjectDefaults = useCallback(async (
    projectId: string,
    value: PaseoProjectDefaultsValue,
  ) => {
    if (host !== "paseo" || !embeddedFrameChallenge) {
      return Promise.reject(new Error("Paseo 项目默认配置桥尚未就绪。"));
    }
    const requestId = window.crypto.randomUUID();
    const response = new Promise<PaseoAutomationState>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingPaseoProjectDefaultsRequestsRef.current.delete(requestId);
        reject(new Error("Paseo 项目默认配置没有响应，请重试。"));
      }, 15_000);
      pendingPaseoProjectDefaultsRequestsRef.current.set(requestId, {
        resolve,
        reject,
        timeoutId,
        projectId,
      });
    });
    postEmbeddedHostMessage({
      type: "taskboard:paseo-project-defaults-save",
      payload: {
        requestId,
        projectId,
        workspacePath: value.workspacePath,
        profile: value.profile,
      },
    });
    const requestGate = paseoAutomationRequestGateRef.current!;
    const requestToken = requestGate.begin(false)!;
    try {
      const automation = await response;
      if (automation.projectId !== projectId) {
        throw new Error("Paseo 返回了其它项目的默认配置状态。");
      }
      if (requestGate.isCurrent(requestToken)) {
        setPaseoAutomations((current) => ({ ...current, [projectId]: automation }));
      }
      return automation;
    } finally {
      requestGate.end(requestToken);
    }
  }, [embeddedFrameChallenge, host]);

  const refreshPaseoAutomation = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (host !== "paseo" || !selectedProject || selectedProject.id === ALL_PROJECTS_ID) return;
    const requestGate = paseoAutomationRequestGateRef.current!;
    const requestToken = requestGate.begin(options.quiet === true);
    if (!requestToken) return;
    if (!options.quiet) setPaseoAutomationError(null);
    try {
      const automation = await requestPaseoAutomation("get", selectedProject.id);
      if (!requestGate.isCurrent(requestToken)) return;
      setPaseoAutomations((current) => ({ ...current, [automation.projectId]: automation }));
      setPaseoAutomationError(null);
    } catch (error) {
      if (!requestGate.isCurrent(requestToken)) return;
      setPaseoAutomationError(error instanceof Error
        ? error.message
        : textRef.current("无法读取 Paseo 自动认领状态。", "Could not read Paseo auto-claim status."));
    } finally {
      requestGate.end(requestToken);
    }
  }, [host, requestPaseoAutomation, selectedProject]);

  const savePaseoAutomation = useCallback(async (options: {
    enabledByUser: boolean;
    intervalMinutes: PaseoAutomationIntervalMinutes;
    quotaAware: boolean;
    workspacePath?: string | null;
    profile?: PaseoAssignmentOptions["profiles"][number] | null;
  }) => {
    if (host !== "paseo" || !selectedProject || selectedProject.id === ALL_PROJECTS_ID) return false;
    const requestGate = paseoAutomationRequestGateRef.current!;
    const requestToken = requestGate.begin(false)!;
    setPaseoAutomationError(null);
    try {
      const automation = await requestPaseoAutomation("save", selectedProject.id, options);
      if (requestGate.isCurrent(requestToken)) {
        setPaseoAutomations((current) => ({ ...current, [automation.projectId]: automation }));
      }
      return true;
    } catch (error) {
      if (requestGate.isCurrent(requestToken)) {
        setPaseoAutomationError(error instanceof Error
          ? error.message
          : textRef.current("无法更新 Paseo 自动认领。", "Could not update Paseo auto-claim."));
      }
      return false;
    } finally {
      requestGate.end(requestToken);
    }
  }, [host, requestPaseoAutomation, selectedProject]);

  function openTaskDetail(task: Pick<Task, "identifier" | "projectId">) {
    const fullTask = tasksRef.current.find((candidate) => candidate.identifier === task.identifier);
    if (fullTask) markTaskRead(fullTask);
    const currentIssue = readIssueIdentifier(window.location.search);
    if (!currentIssue) detailSourceProjectIdRef.current = selectedProjectId;
    if (isAllProjects) setSelectedProjectId(task.projectId);
    if (boardView === "list" && issueListRef.current) {
      pendingDetailSourceScrollRef.current = {
        projectId: selectedProjectId,
        view: "list",
        scrollTop: issueListRef.current.scrollTop,
      };
    } else if (boardView === "issues" && fullTask) {
      const scrollContainer = boardColumnScrollRefs.current[fullTask.status];
      if (scrollContainer) {
        pendingDetailSourceScrollRef.current = {
          projectId: selectedProjectId,
          view: "issues",
          status: fullTask.status,
          scrollTop: scrollContainer.scrollTop,
          scrollLeft: boardScrollRef.current?.scrollLeft ?? 0,
        };
      }
    }
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(task.identifier);
    if (host === "paseo") return;
    const boardUrl = buildIssueUrl(window.location.href, selectedProjectId, null);
    if (!currentIssue) {
      window.history.replaceState(window.history.state, "", boardUrl);
    }
    const detailUrl = buildIssueUrl(
      currentIssue ? window.location.href : boardUrl.href,
      task.projectId,
      task.identifier,
    );
    window.history.pushState(window.history.state, "", detailUrl);
  }

  function closeTaskDetail() {
    const sourceProjectId = detailSourceProjectIdRef.current ?? selectedProjectId;
    detailSourceProjectIdRef.current = null;
    setDetailTaskIdentifier(null);
    if (sourceProjectId !== selectedProjectId) {
      setSelectedProjectId(sourceProjectId);
      setBoardView(sourceProjectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(sourceProjectId));
    }
    if (host === "paseo") return;
    const url = buildIssueUrl(window.location.href, sourceProjectId, null);
    window.history.replaceState(window.history.state, "", url);
  }

  useLayoutEffect(() => {
    if (detailTaskIdentifier) return;
    const pendingScroll = pendingDetailSourceScrollRef.current;
    if (!pendingScroll) return;
    if (pendingScroll.view !== boardView || pendingScroll.projectId !== selectedProjectId) {
      pendingDetailSourceScrollRef.current = null;
      return;
    }
    pendingDetailSourceScrollRef.current = null;
    if (pendingScroll.view === "list") {
      if (issueListRef.current) issueListRef.current.scrollTop = pendingScroll.scrollTop;
      return;
    }
    const columnScrollContainer = boardColumnScrollRefs.current[pendingScroll.status];
    if (columnScrollContainer) columnScrollContainer.scrollTop = pendingScroll.scrollTop;
    if (boardScrollRef.current) boardScrollRef.current.scrollLeft = pendingScroll.scrollLeft;
  }, [boardView, detailTaskIdentifier, selectedProjectId]);

  useEffect(() => {
    function syncRouteFromLocation() {
      const url = new URL(window.location.href);
      const routeProjectId = url.searchParams.get("project") ?? GLOBAL_PROJECT_ID;
      const routeIssueIdentifier = readIssueIdentifier(url.search);
      if (routeIssueIdentifier && boardView === "list" && issueListRef.current) {
        pendingDetailSourceScrollRef.current = {
          projectId: selectedProjectId,
          view: "list",
          scrollTop: issueListRef.current.scrollTop,
        };
      } else if (routeIssueIdentifier && boardView === "issues") {
        const routeTask = tasksRef.current.find(
          (task) => task.identifier === routeIssueIdentifier,
        );
        const scrollContainer = routeTask
          ? boardColumnScrollRefs.current[routeTask.status]
          : null;
        if (routeTask && scrollContainer) {
          pendingDetailSourceScrollRef.current = {
            projectId: selectedProjectId,
            view: "issues",
            status: routeTask.status,
            scrollTop: scrollContainer.scrollTop,
            scrollLeft: boardScrollRef.current?.scrollLeft ?? 0,
          };
        }
      }
      if (!routeIssueIdentifier) detailSourceProjectIdRef.current = null;
      setDetailTaskIdentifier(routeIssueIdentifier);
      if (routeProjectId === selectedProjectId) return;
      setBoardView(routeProjectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(routeProjectId));
      setSelectedProjectId(routeProjectId);
    }

    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, [boardView, selectedProjectId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.embedded = String(embedded);
    document.documentElement.style.colorScheme = theme;
  }, [embedded, theme]);

  useEffect(() => {
    if (embedded && window.parent !== window) return;
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => setTheme(systemTheme.matches ? "dark" : "light");
    syncTheme();
    systemTheme.addEventListener("change", syncTheme);
    return () => systemTheme.removeEventListener("change", syncTheme);
  }, [embedded]);

  useEffect(() => {
    if (selectedProjectId) {
      setBoardView(selectedProjectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(selectedProjectId));
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDashboardSummaryAnimatedProjectId(null);
    } else if (boardView !== "dashboard") {
      setDashboardSummaryAnimatedProjectId(selectedProjectId);
    }
  }, [boardView, selectedProjectId]);

  useEffect(() => {
    writeTaskFilters(filters);
  }, [filters]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (host !== "paseo") return;
    const decorate = (items: Task[]) => {
      const next = items.map((task) => decoratePaseoTask(task, paseoAssignments[task.id], paseoProviderIcons));
      return next.some((task, index) => task !== items[index]) ? sortTasks(next) : items;
    };
    setTasks(decorate);
    setArchivedTasks(decorate);
  }, [archivedTasks, host, paseoAssignments, paseoProviderIcons, tasks]);

  useEffect(() => {
    const projectId = editor ? editorProjectId : detailTask?.projectId;
    if (host !== "paseo" || !projectId || (!editor && !detailTask)) return;
    refreshPaseoAssignmentOptions(projectId);
  }, [detailTask?.id, detailTask?.projectId, editor, editorProjectId, embeddedFrameChallenge, host]);

  useEffect(() => {
    if (taskboardStorage.getItem(FIRST_USE_COMPLETE_KEY) === null) {
      taskboardStorage.setItem(FIRST_USE_COMPLETE_KEY, "true");
    }
  }, []);

  useEffect(() => {
    if (!projectMenuOpen) return;
    function closeProjectMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-switcher], [data-project-context-menu]")) setProjectMenuOpen(false);
    }
    function closeProjectMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !projectContextMenu) setProjectMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeProjectMenu);
    window.addEventListener("keydown", closeProjectMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectMenu);
      window.removeEventListener("keydown", closeProjectMenuWithEscape);
    };
  }, [projectMenuOpen, projectContextMenu]);

  useEffect(() => {
    if (!projectContextMenu) return;
    function closeProjectContextMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-context-menu], .project-menu-more")) setProjectContextMenu(null);
    }
    function closeProjectContextMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectContextMenu(null);
    }
    document.addEventListener("pointerdown", closeProjectContextMenu);
    window.addEventListener("keydown", closeProjectContextMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectContextMenu);
      window.removeEventListener("keydown", closeProjectContextMenuWithEscape);
    };
  }, [projectContextMenu]);

  useEffect(() => {
    if (host === "paseo") {
      void refreshPaseoAutomation();
      return;
    }
    setAutomationError(null);
    void reconcileProjectAutomation();
  }, [host, selectedProjectId, reconcileProjectAutomation, refreshPaseoAutomation]);

  useEffect(() => {
    if (!embedded || window.parent === window) return;
    let acknowledgedFrameChallenge = "";

    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: string; payload?: unknown; theme?: unknown };

      if (message.type === "taskboard:frame-challenge") {
        const challenge = typeof message.payload === "object"
          && message.payload
          && "challenge" in message.payload
          && typeof message.payload.challenge === "string"
          ? message.payload.challenge
          : "";
        if (!challenge || challenge === acknowledgedFrameChallenge) return;
        acknowledgedFrameChallenge = challenge;
        setEmbeddedFrameChallenge(challenge);
        setEmbeddedFrameChallengeState(challenge);
        postEmbeddedHostMessage({ type: "taskboard:ready" });
        return;
      }

      if (message.type === "taskboard:automation-response" && message.payload) {
        const payload = message.payload as Partial<AutomationHostResponse>;
        if (typeof payload.requestId !== "string") return;
        const pending = pendingAutomationRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingAutomationRequestsRef.current.delete(payload.requestId);
        if (payload.ok) pending.resolve(payload as AutomationHostResponse);
        else pending.reject(new Error(
          typeof payload.error === "string"
            ? payload.error
            : textRef.current("Codex 无法更新自动化", "Codex could not update automation"),
        ));
        return;
      }

      if (message.type === "taskboard:theme" && isTheme(message.theme)) {
        setTheme(message.theme);
        return;
      }

      if (message.type === "taskboard:thread-prepared" && message.payload) {
        setOpeningThreadTaskId(null);
        return;
      }

      if (message.type === "taskboard:thread-create-error" && message.payload) {
        const payload = message.payload as { error?: unknown };
        setOpeningThreadTaskId(null);
        setActionError(typeof payload.error === "string"
          ? payload.error
          : textRef.current("无法在 Codex 中打开新对话。", "Could not open a new conversation in Codex."));
        return;
      }

      if (message.type === "taskboard:thread-open-error" && message.payload) {
        const payload = message.payload as { error?: unknown };
        setActionError(typeof payload.error === "string"
          ? payload.error
          : textRef.current("无法打开 Codex 对话。", "Could not open the Codex conversation."));
        return;
      }

      if (message.type === "taskboard:paseo-automation-response" && message.payload) {
        const payload = message.payload as { requestId?: unknown; automation?: unknown; error?: unknown };
        if (typeof payload.requestId !== "string") return;
        const pending = pendingPaseoAutomationRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingPaseoAutomationRequestsRef.current.delete(payload.requestId);
        if (typeof payload.error === "string") {
          pending.reject(new Error(payload.error));
        } else if (isPaseoAutomationState(payload.automation)) {
          pending.resolve(payload.automation);
        } else {
          pending.reject(new Error(textRef.current(
            "Paseo 返回了无效的自动认领状态。",
            "Paseo returned an invalid auto-claim state.",
          )));
        }
        return;
      }

      if (message.type === "taskboard:paseo-project-defaults-saved" && message.payload) {
        const payload = message.payload as {
          requestId?: unknown;
          projectId?: unknown;
          automation?: unknown;
          error?: unknown;
        };
        if (typeof payload.requestId !== "string") return;
        const pending = pendingPaseoProjectDefaultsRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingPaseoProjectDefaultsRequestsRef.current.delete(payload.requestId);
        if (typeof payload.error === "string") {
          pending.reject(new Error(payload.error));
        } else if (
          payload.projectId === pending.projectId
          && isPaseoAutomationState(payload.automation)
          && payload.automation.projectId === pending.projectId
        ) {
          pending.resolve(payload.automation);
        } else {
          pending.reject(new Error("Paseo 返回了无效的项目默认配置状态。"));
        }
        return;
      }

      if (message.type === "taskboard:paseo-presentations" && message.payload) {
        const payload = message.payload as { presentations?: unknown };
        if (!Array.isArray(payload.presentations)) return;
        const next: Record<string, PaseoAgentPresentation> = {};
        for (const item of payload.presentations) {
          if (!item || typeof item !== "object") continue;
          const presentation = item as Partial<PaseoAgentPresentation> & { taskId?: unknown };
          if (
            typeof presentation.taskId !== "string"
            || typeof presentation.agentId !== "string"
            || typeof presentation.status !== "string"
            || typeof presentation.requiresAttention !== "boolean"
          ) continue;
          next[presentation.taskId] = {
            agentId: presentation.agentId,
            status: presentation.status as PaseoAgentPresentation["status"],
            requiresAttention: presentation.requiresAttention,
            attentionReason: presentation.attentionReason ?? null,
            updatedAt: presentation.updatedAt ?? null,
            title: presentation.title ?? null,
          };
        }
        setPaseoAgentPresentations(next);
        return;
      }

      if (message.type === "taskboard:paseo-assignment-options" && message.payload) {
        const payload = message.payload as { requestId?: unknown; options?: PaseoAssignmentOptions; error?: unknown };
        if (payload.requestId !== paseoAssignmentOptionsRequestRef.current) return;
        setPaseoAssignmentOptionsLoading(false);
        if (typeof payload.error === "string") {
          setPaseoAssignmentOptionsError(payload.error);
          return;
        }
        if (payload.options) {
          setPaseoAssignmentOptions(payload.options);
          setPaseoAssignmentOptionsError(null);
        }
        return;
      }

      if (message.type === "taskboard:paseo-configuration-options" && message.payload) {
        const payload = message.payload as { requestId?: unknown; options?: unknown; error?: unknown };
        if (typeof payload.requestId !== "string") return;
        const pending = pendingPaseoConfigurationRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingPaseoConfigurationRequestsRef.current.delete(payload.requestId);
        if (typeof payload.error === "string") pending.reject(new Error(payload.error));
        else if (isPaseoConfigurationOptions(payload.options)) pending.resolve(payload.options);
        else pending.reject(new Error("Paseo 返回了无效的配置选项。"));
        return;
      }

      if (message.type === "taskboard:paseo-merge-ideas" && message.payload) {
        const payload = message.payload as {
          requestId?: unknown;
          task?: unknown;
          assignment?: unknown;
          sourceTaskIds?: unknown;
          replayed?: unknown;
          error?: unknown;
        };
        if (typeof payload.requestId !== "string") return;
        const pending = pendingPaseoMergeRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingPaseoMergeRequestsRef.current.delete(payload.requestId);
        if (typeof payload.error === "string") {
          pending.reject(new Error(payload.error));
          return;
        }
        const task = payload.task as Task | undefined;
        const assignment = payload.assignment as PaseoTaskAssignment | undefined;
        if (!task || typeof task.id !== "string" || assignment?.kind !== "planned") {
          pending.reject(new Error("Paseo 返回了无效的想法合并结果。"));
          return;
        }
        const returnedSourceTaskIds = Array.isArray(payload.sourceTaskIds)
          ? payload.sourceTaskIds.filter((id): id is string => typeof id === "string")
          : [];
        pending.resolve({
          task,
          assignment,
          sourceTaskIds: returnedSourceTaskIds.length >= 2
            ? returnedSourceTaskIds
            : pending.sourceTaskIds,
          replayed: payload.replayed === true,
        });
        return;
      }

      if (message.type === "taskboard:paseo-task-assignments" && message.payload) {
        const payload = message.payload as { assignments?: PaseoTaskAssignment[] };
        if (!Array.isArray(payload.assignments)) return;
        setPaseoAssignments(Object.fromEntries(payload.assignments.map((assignment) => [assignment.taskId, assignment])));
        return;
      }

      if (message.type === "taskboard:paseo-assignment-saved" && message.payload) {
        const payload = message.payload as {
          requestId?: unknown;
          taskId?: unknown;
          task?: Task;
          assignment?: PaseoTaskAssignment | null;
          error?: unknown;
        };
        if (typeof payload.requestId !== "string") return;
        if (payload.task && typeof payload.task.id === "string" && !payload.error) {
          const savedTask = host === "paseo"
            ? decoratePaseoTask(
                payload.task,
                payload.assignment ?? undefined,
                paseoProviderIconsRef.current,
              )
            : payload.task;
          setTasks((current) => current.map((task) => task.id === savedTask.id ? savedTask : task));
          setArchivedTasks((current) => current.map((task) => task.id === savedTask.id ? savedTask : task));
        }
        const pending = pendingPaseoAssignmentSaveRef.current.get(payload.requestId);
        if (!pending) {
          // iframe 已提示“仍在保存”后仍可能收到迟到成功；不可丢掉真实计划映射。
          const taskId = payload.taskId;
          if (typeof taskId === "string" && !payload.error) {
            setPaseoAssignments((current) => {
              const next = { ...current };
              if (payload.assignment) next[taskId] = payload.assignment;
              else delete next[taskId];
              return next;
            });
          }
          return;
        }
        window.clearTimeout(pending.timeoutId);
        pendingPaseoAssignmentSaveRef.current.delete(payload.requestId);
        if (typeof payload.error === "string") pending.reject(new Error(payload.error));
        else pending.resolve(payload.assignment ?? null);
        return;
      }

      if (message.type === "taskboard:paseo-copy-response" && message.payload) {
        const payload = message.payload as Partial<PaseoCopyResponse>;
        if (typeof payload.requestId !== "string") return;
        const pending = pendingPaseoCopyRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingPaseoCopyRequestsRef.current.delete(payload.requestId);
        if (typeof payload.error === "string") pending.reject(new Error(payload.error));
        else if (typeof payload.copiedText === "string") pending.resolve(payload.copiedText);
        else pending.reject(new Error("Paseo 未确认剪贴板写入结果。"));
        return;
      }

      if (message.type !== "taskboard:host-context" || !message.payload) return;
      const payload = message.payload as HostContext;
      setHostContext(payload);
      setCurrentUserActor(payload.user);
      if (isTheme(payload.theme)) setTheme(payload.theme);
      const routeProjectId = payload.route?.projectId?.trim() || null;
      const routeIssueIdentifier = payload.route?.issueIdentifier?.trim() || null;
      if (
        host === "paseo"
        && (routeProjectId || routeIssueIdentifier)
        && !paseoHostRouteInitializedRef.current
      ) {
        paseoHostRouteInitializedRef.current = true;
        detailSourceProjectIdRef.current = null;
        if (routeProjectId) {
          setSelectedProjectId(routeProjectId);
          setBoardView(routeProjectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(routeProjectId));
        }
        setDetailTaskIdentifier(routeIssueIdentifier);
      }
      if (host === "codex") void publishHostRuntime(payload);
    }

    const removeExternalLinkHandler = installEmbeddedExternalLinkHandler();
    window.addEventListener("message", receiveHostMessage);
    postEmbeddedHostMessage({ type: "taskboard:frame-awaiting-challenge" });
    return () => {
      window.removeEventListener("message", receiveHostMessage);
      setEmbeddedFrameChallenge("");
      removeExternalLinkHandler();
      for (const pending of pendingAutomationRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error(textRef.current(
          "Taskboard 消息桥已关闭",
          "The Taskboard host bridge was closed",
        )));
      }
      pendingAutomationRequestsRef.current.clear();
      for (const pending of pendingPaseoAutomationRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error(textRef.current("Paseo 自动认领桥已关闭", "Paseo auto-claim bridge closed.")));
      }
      pendingPaseoAutomationRequestsRef.current.clear();
      for (const pending of pendingPaseoProjectDefaultsRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error("Paseo 项目默认配置桥已关闭。"));
      }
      pendingPaseoProjectDefaultsRequestsRef.current.clear();
      for (const pending of pendingPaseoConfigurationRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error("Paseo 配置桥已关闭。"));
      }
      pendingPaseoConfigurationRequestsRef.current.clear();
      for (const pending of pendingPaseoMergeRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error("Paseo 合并桥已关闭。当前草稿和重试标识已保留。"));
      }
      pendingPaseoMergeRequestsRef.current.clear();
      for (const pending of pendingPaseoCopyRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error("Paseo 剪贴板桥已关闭。"));
      }
      pendingPaseoCopyRequestsRef.current.clear();
      for (const pending of pendingPaseoAssignmentSaveRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error(textRef.current("Paseo 负责人桥已关闭", "Paseo assignee bridge closed.")));
      }
      pendingPaseoAssignmentSaveRef.current.clear();
    };
  }, [embedded, host]);

  useEffect(() => {
    if (host !== "paseo" || !embeddedFrameChallenge || window.parent === window) return;
    const requestPaseoTaskState = () => {
      const taskIds = [...tasks, ...archivedTasks].map((task) => task.id).slice(0, 200);
      if (taskIds.length === 0) {
        setPaseoAssignments({});
        setPaseoAgentPresentations({});
        return;
      }
      postEmbeddedHostMessage({
        type: "taskboard:paseo-presentations-request",
        payload: { taskIds },
      });
      postEmbeddedHostMessage({
        type: "taskboard:paseo-task-assignments-request",
        payload: { taskIds },
      });
    };
    requestPaseoTaskState();
    const timer = window.setInterval(requestPaseoTaskState, 4_000);
    return () => window.clearInterval(timer);
  }, [archivedTasks, embeddedFrameChallenge, host, tasks]);

  useLayoutEffect(() => {
    if (!embedded || window.parent === window || !dragRegionRef.current) return;
    const region = dragRegionRef.current;
    const publish = () => {
      const rect = region.getBoundingClientRect();
      postEmbeddedHostMessage({
        type: "taskboard:drag-region",
        payload: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    };
    const observer = new ResizeObserver(publish);
    observer.observe(region);
    window.addEventListener("resize", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      postEmbeddedHostMessage({ type: "taskboard:drag-region", payload: null });
    };
  }, [detailTaskId, embedded, embeddedFrameChallenge, selectedProjectId]);

  const loadProjectList = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++projectsRequestRef.current;
    setProjectLoadError((current) => (
      current?.operation === "initial" ? { ...current, requestId } : current
    ));
    try {
      const [nextProjects, metadata, workspaces] = await Promise.all([
        listProjects(signal),
        getTaskboardMetadata(signal),
        listDeviceWorkspaces(signal),
      ]);
      if (requestId !== projectsRequestRef.current) return;
      const [nextJiraConnection, nextTemporaryTasks] = await Promise.all([
        getJiraConnection(signal),
        listTasks(GLOBAL_PROJECT_ID, signal),
      ]);
      if (requestId !== projectsRequestRef.current) return;
      setTaskboardMetadata((current) => (
        current
        && current.mode === metadata.mode
        && JSON.stringify(current.realtime) === JSON.stringify(metadata.realtime)
        && current.manageTaskboardSkillPath === metadata.manageTaskboardSkillPath
        && current.localCapabilities?.available === metadata.localCapabilities?.available
          ? current
          : metadata
      ));
      setManageTaskboardSkillPath(metadata.manageTaskboardSkillPath ?? "");
      setLocalAiChatAvailable(metadata.capabilities?.localAiChat === true);
      setDeviceWorkspacePaths((current) => {
        const next = { ...current, ...workspaces };
        delete next[GLOBAL_PROJECT_ID];
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        taskboardStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
        return next;
      });
      setProjects(nextProjects.map((project) => project.id === GLOBAL_PROJECT_ID
        ? {
            ...project,
            issueCount: nextTemporaryTasks.filter((task) => (
              MAIN_STATUSES.some((status) => status === task.status)
            )).length,
          }
        : project));
      setJiraConnection(nextJiraConnection);
      setSelectedProjectId((current) => {
        const fromQuery = new URLSearchParams(window.location.search).get("project");
        if (fromQuery === ALL_PROJECTS_ID) return fromQuery;
        if (fromQuery && nextProjects.some((project) => project.id === fromQuery)) return fromQuery;
        if (current === ALL_PROJECTS_ID) return current;
        if (current && nextProjects.some((project) => project.id === current)) return current;
        return nextProjects.find((project) => project.id === GLOBAL_PROJECT_ID)?.id
          ?? nextProjects[0]?.id
          ?? GLOBAL_PROJECT_ID;
      });
      setProjectLoadError((current) => (
        current?.operation === "initial" && current.requestId === requestId ? null : current
      ));
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === projectsRequestRef.current) {
        setProjectLoadError({
          source: "projects",
          operation: "initial",
          requestId,
          message: errorMessage(error),
        });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjectList(controller.signal);
    return () => controller.abort();
  }, [loadProjectList]);

  const refreshProjectList = useCallback(async () => {
    const requestId = ++projectsRequestRef.current;
    setProjectLoadError((current) => (
      current?.operation === "refresh" ? { ...current, requestId } : current
    ));
    try {
      const [nextProjects, nextTemporaryTasks] = await Promise.all([
        listProjects(),
        listTasks(GLOBAL_PROJECT_ID),
      ]);
      if (requestId !== projectsRequestRef.current) return;
      setProjects(nextProjects.map((project) => project.id === GLOBAL_PROJECT_ID
        ? {
            ...project,
            issueCount: nextTemporaryTasks.filter((task) => (
              MAIN_STATUSES.some((status) => status === task.status)
            )).length,
          }
        : project));
      setProjectLoadError((current) => (
        current?.operation === "refresh" && current.requestId === requestId ? null : current
      ));
    } catch (error) {
      if (requestId === projectsRequestRef.current) {
        setProjectLoadError({
          source: "projects",
          operation: "refresh",
          requestId,
          message: errorMessage(error),
        });
      }
    }
  }, []);

  const refreshTasks = useCallback(async (
    projectId: string,
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    const requestId = ++tasksRequestRef.current;
    if (!options.quiet) setTasksLoading(true);
    setTasksLoadError((current) => (
      current ? { ...current, requestId } : current
    ));
    try {
      const taskProjectId = projectId === ALL_PROJECTS_ID ? undefined : projectId;
      const [nextTasks, nextArchivedTasks] = await Promise.all([
        listTasks(taskProjectId, options.signal),
        listArchivedTasks(taskProjectId, options.signal),
      ]);
      if (requestId !== tasksRequestRef.current) return;
      const decorate = (items: Task[]) => host === "paseo"
        ? items.map((task) => decoratePaseoTask(
            task,
            paseoAssignmentsRef.current[task.id],
            paseoProviderIconsRef.current,
          ))
        : items;
      setTasks(sortTasks(decorate(nextTasks)));
      setArchivedTasks(sortTasks(decorate(nextArchivedTasks)));
      setActionError((current) => {
        if (!current || !isPendingTaskSyncError(current)) {
          return current;
        }
        const synced = [...nextTasks, ...nextArchivedTasks].find((task) => task.id === current.taskId);
        return synced && synced.version > current.previousVersion ? null : current;
      });
      setProjects((current) => current.map((project) => {
        if (project.id !== projectId || project.source !== "jira") return project;
        const labels = [...new Set(nextTasks.flatMap((task) => task.labels))];
        return JSON.stringify(labels) === JSON.stringify(project.labels)
          ? project
          : { ...project, labels };
      }));
      setHasLoadedTasks(true);
      setTasksLoadError((current) => (
        current?.requestId === requestId ? null : current
      ));
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === tasksRequestRef.current) {
        setTasksLoadError({ source: "tasks", requestId, message: errorMessage(error) });
      }
    } finally {
      if (!options.quiet && requestId === tasksRequestRef.current) setTasksLoading(false);
    }
  }, [host]);

  useEffect(() => {
    if (!taskScopeProjectId) {
      setTasks([]);
      setArchivedTasks([]);
      setHasLoadedTasks(false);
      return;
    }
    setHasLoadedTasks(false);
    const controller = new AbortController();
    void refreshTasks(taskScopeProjectId, { signal: controller.signal });
    return () => controller.abort();
  }, [refreshTasks, taskScopeProjectId]);

  useEffect(() => {
    if (host !== "paseo" || !embeddedFrameChallenge || !taskScopeProjectId) return;
    const poller = createRefreshPoller({
      intervalMs: 4_000,
      refresh: () => Promise.all([
        refreshTasks(taskScopeProjectId, { quiet: true }),
        refreshPaseoAutomation({ quiet: true }),
      ]),
    });
    poller.start();
    return () => poller.stop();
  }, [
    embeddedFrameChallenge,
    host,
    refreshPaseoAutomation,
    refreshTasks,
    taskScopeProjectId,
  ]);

  useEffect(() => {
    const isAllProjectTaskScope = taskScopeProjectId === ALL_PROJECTS_ID;
    if ((!isJiraProject && !(isAllProjectTaskScope && jiraConnection?.configured)) || !taskScopeProjectId) return;
    const timer = window.setInterval(() => {
      void refreshTasks(taskScopeProjectId, { quiet: true });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [isJiraProject, jiraConnection?.configured, refreshTasks, taskScopeProjectId]);

  useEffect(() => {
    const standalone = !embedded || window.parent === window;
    const developmentProjectId = isAllProjects
      ? developmentEditorProjectId ?? (standalone ? contextMenuTask?.projectId : null)
      : selectedProjectId;
    if (!developmentProjectId) {
      setDevelopmentScan({ workspacePath: null, contexts: [] });
      setDevelopmentScanLoading(false);
      return;
    }
    const controller = new AbortController();
    const codexProjectId = developmentProjectId === GLOBAL_PROJECT_ID
      ? hostContext?.projectId
      : developmentProjectId;
    const codexThreadId = hostContext?.threadId
      ?? (isAllProjects ? contextMenuTask?.threadId : detailTask?.threadId)
      ?? undefined;
    const workspacePath = isAllProjects
      ? developmentEditorProjectId
        ? deviceWorkspacePaths[developmentEditorProjectId]
        : contextMenuWorkspacePath
      : selectedDeviceWorkspacePath;
    setDevelopmentScan({ workspacePath: workspacePath ?? null, contexts: [] });
    setDevelopmentScanLoading(true);
    void listDevelopmentContexts(
      developmentProjectId,
      codexProjectId,
      codexThreadId,
      controller.signal,
      workspacePath,
    )
      .then((scan) => {
        setDevelopmentScan(scan);
        if (scan.workspacePath) rememberDeviceWorkspacePath(developmentProjectId, scan.workspacePath);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setDevelopmentScan({ workspacePath: workspacePath ?? null, contexts: [] });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDevelopmentScanLoading(false);
      });
    return () => controller.abort();
  }, [
    contextMenuTask?.projectId,
    contextMenuTask?.threadId,
    contextMenuWorkspacePath,
    detailTask?.threadId,
    deviceWorkspacePaths,
    developmentEditorProjectId,
    embedded,
    hostContext?.projectId,
    hostContext?.threadId,
    isAllProjects,
    rememberDeviceWorkspacePath,
    selectedProjectId,
    selectedDeviceWorkspacePath,
  ]);

  const invalidateCloudData = useCallback(() => {
    void refreshProjectList();
    void refreshProjectBoardDisplaySettings();
    const projectId = taskScopeProjectIdRef.current;
    if (projectId) {
      void refreshTasks(projectId, { quiet: true });
    }
    setReadmeRevision((current) => current + 1);
    setCommentsRevision((current) => current + 1);
    setAttachmentsRevision((current) => current + 1);
  }, [refreshProjectList, refreshProjectBoardDisplaySettings, refreshTasks]);

  useEffect(() => {
    if (revisionPollingInterval === null) return;
    const controller = new AbortController();
    setConnection("connecting");
    const poller = createRevisionPoller({
      intervalMs: revisionPollingInterval,
      fetchRevision: async (since: number) => {
        try {
          const result = await getTaskboardRevision(since, controller.signal);
          setConnection("live");
          return result;
        } catch (error) {
          if (!controller.signal.aborted) setConnection("reconnecting");
          throw error;
        }
      },
      onInvalidate: invalidateCloudData,
    });
    poller.start();
    return () => {
      controller.abort();
      poller.stop();
    };
  }, [
    revisionPollingInterval,
    invalidateCloudData,
  ]);

  useEffect(() => {
    if (revisionWebSocketEndpoint === null) return;
    const controller = new AbortController();
    const client = createRevisionWebSocketClient({
      url: resolveTaskboardWebSocketUrl(revisionWebSocketEndpoint),
      fetchRevision: (since: number) => getTaskboardRevision(since, controller.signal),
      onInvalidate: invalidateCloudData,
      onConnectionChange: setConnection,
    });
    client.start();
    return () => {
      controller.abort();
      client.stop();
    };
  }, [
    invalidateCloudData,
    revisionWebSocketEndpoint,
  ]);

  function pushUndo(message: string | null, undo: () => Promise<void>) {
    const operation = { id: ++undoSequenceRef.current, undo };
    undoStackRef.current = [...undoStackRef.current.slice(-19), operation];
    if (!message) return;
    setAnnouncementValue("");
    setUndoNotice({ id: operation.id, message });
  }

  async function performUndo() {
    if (undoInFlightRef.current) return;
    const operation = undoStackRef.current.at(-1);
    if (!operation) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    undoInFlightRef.current = true;
    setUndoNotice(null);
    setProjectMenuOpen(false);
    closeContextMenu();
    setActionError(null);
    try {
      await operation.undo();
    } catch (error) {
      setActionError(text(
        `无法撤回这次操作：${errorMessage(error)}`,
        `Could not undo this action: ${errorMessage(error)}`,
      ));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      undoInFlightRef.current = false;
    }
  }

  async function restoreTaskDetails(
    snapshot: Task,
    changed: Task,
    assigneeTarget = assigneeTargetForActor(snapshot.assignee, currentUser),
  ) {
    const candidate = tasksRef.current.find((task) => task.id === changed.id);
    const current = candidate && candidate.version >= changed.version ? candidate : changed;
    const restored = await updateTaskRequest(current, {
      ...taskToDraft(snapshot),
      ...(assigneeTarget ? { assigneeTarget } : {}),
    });
    setTasks((tasks) => sortTasks(tasks.map((task) => task.id === restored.id ? restored : task)));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (
        event.key.toLowerCase() === "z"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !isTyping
        && !editor
      ) {
        event.preventDefault();
        void performUndo();
        return;
      }
      if (isTyping || contextMenu || projectMenuOpen) return;
      if (
        event.key.toLowerCase() === "c"
        && !event.metaKey
        && !event.ctrlKey
        && selectedProjectId
        && !isJiraProject
      ) {
        event.preventDefault();
        setEditor({ status: "todo" });
      }
      if (
        event.key === "/"
        && !detailTaskId
        && selectedProjectId
        && (boardView === "issues" || boardView === "list" || boardView === "gantt")
      ) {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "Escape" && detailTaskId) {
        closeTaskDetail();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [boardView, contextMenu, detailTaskId, editor, isJiraProject, projectMenuOpen, selectedProjectId]);

  const filteredTasks = useMemo(() => {
    return tasks.filter(
      (task) => matchesTaskSearch(task, search, language) && matchesTaskFilters(task, filters),
    );
  }, [filters, language, search, tasks]);

  const filteredArchivedTasks = useMemo(() => archivedTasks.filter(
    (task) => matchesTaskSearch(task, search, language) && matchesTaskFilters(task, filters),
  ), [archivedTasks, filters, language, search]);

  const activeFilterCount = taskFilterCount(filters);
  const hasActiveTaskFilters = Boolean(search.trim()) || activeFilterCount > 0;

  const trackedCodexThreadIds = useMemo(() => [...new Set(tasks
    .filter((task) => task.status === "in_progress" && task.threadId)
    .map((task) => normalizeCodexThreadId(task.threadId))
    .filter(Boolean))].sort(), [tasks]);
  const trackedCodexThreadIdsKey = trackedCodexThreadIds.join(",");

  useEffect(() => {
    if (trackedCodexThreadIds.length === 0) {
      setCodexThreadProgress({});
      return;
    }
    let disposed = false;
    const sync = async () => {
      try {
        const progress = await getCodexThreadProgress(trackedCodexThreadIds);
        if (!disposed) {
          setCodexThreadProgress((current) => (
            JSON.stringify(current) === JSON.stringify(progress) ? current : progress
          ));
        }
      } catch {}
    };
    void sync();
    const timer = window.setInterval(sync, 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [trackedCodexThreadIdsKey]);

  const tasksByStatus = useMemo(() => {
    return Object.fromEntries(
      TASK_STATUSES.map((status) => [status, filteredTasks.filter((task) => task.status === status)]),
    ) as Record<TaskStatus, Task[]>;
  }, [filteredTasks]);

  function mainColumnTasks(status: TaskStatus): Task[] {
    if (!usesPaseoDefaultBoard) return tasksByStatus[status];
    const statuses = status === "todo"
      ? ["backlog", "todo"] as const
      : status === "in_progress"
        ? ["in_progress", "blocked"] as const
        : [status] as const;
    return statuses.flatMap((item) => tasksByStatus[item]).sort((left, right) => (
      left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt)
    ));
  }

  function isMergeIdeaEligible(task: Task): boolean {
    const assignment = paseoAssignments[task.id];
    return task.archivedAt === null
      && (task.status === "backlog" || task.status === "todo")
      && assignment?.kind !== "existing";
  }

  function canSelectMergeIdea(task: Task): boolean {
    if (!isMergeIdeaEligible(task)) return false;
    if (!selectedIdeaIds.has(task.id) && selectedIdeaIds.size >= 50) return false;
    const selectedProject = tasks.find((candidate) => selectedIdeaIds.has(candidate.id))?.projectId;
    return !selectedProject || selectedProject === task.projectId;
  }

  function toggleMergeIdea(task: Task) {
    if (!canSelectMergeIdea(task)) return;
    setSelectedIdeaIds((current) => {
      const next = new Set(current);
      if (next.has(task.id)) next.delete(task.id);
      else next.add(task.id);
      return next;
    });
  }

  function openSelectedTaskDeleteConfirmation() {
    if (batchMoveInFlightRef.current || batchDeleteInFlightRef.current || selectedIdeaIds.size === 0) return;
    const snapshot = tasks
      .filter((task) => selectedIdeaIds.has(task.id) && isMergeIdeaEligible(task))
      .map((task) => ({ ...task }));
    if (snapshot.length === 0) return;
    setPendingSelectedTaskDelete(snapshot);
  }

  async function deleteSelectedTasks() {
    if (!pendingSelectedTaskDelete || deletingArchivedTaskId || batchDeleteInFlightRef.current) return;
    const snapshot = pendingSelectedTaskDelete;
    batchDeleteInFlightRef.current = true;
    setDeletingArchivedTaskId("batch");
    setActionError(null);
    const failed: Array<{ task: Task; message: string }> = [];
    const deletedIds = new Set<string>();
    try {
      for (const captured of snapshot) {
        const current = tasksRef.current.find((task) => task.id === captured.id);
        if (!current || current.version !== captured.version || current.status !== captured.status || current.archivedAt !== captured.archivedAt) {
          failed.push({
            task: captured,
            message: text("任务已变化，请重新确认", "Task changed; confirm again"),
          });
          continue;
        }
        try {
          const archived = await archiveTaskRequest(captured);
          setTasks((currentTasks) => currentTasks.filter((task) => task.id !== archived.id));
          setArchivedTasks((currentTasks) => sortTasks([
            ...currentTasks.filter((task) => task.id !== archived.id),
            archived,
          ]));
          try {
            await deleteArchivedTaskRequest(archived);
            deletedIds.add(captured.id);
          } catch (error) {
            failed.push({
              task: captured,
              message: text(`已归档，但永久删除失败；请到已归档列表重试：${errorMessage(error)}`, `Archived, but permanent deletion failed; retry it from Archived: ${errorMessage(error)}`),
            });
          }
        } catch (error) {
          failed.push({ task: captured, message: errorMessage(error) });
        }
      }
      setTasks((current) => current.filter((task) => !deletedIds.has(task.id)));
      setArchivedTasks((current) => current.filter((task) => !deletedIds.has(task.id)));
      setPaseoAssignments((current) => Object.fromEntries(
        Object.entries(current).filter(([taskId]) => !deletedIds.has(taskId)),
      ));
      setSelectedIdeaIds(new Set(failed.map(({ task }) => task.id)));
      setPendingSelectedTaskDelete(null);
      setIdeaSelectionMode(failed.length > 0);
      if (failed.length === 0) {
        setAnnouncement(text(`${deletedIds.size} 项任务已永久删除。`, `${deletedIds.size} tasks were permanently deleted.`));
      } else {
        setActionError(text(
          `已删除 ${deletedIds.size} 项；${failed.map(({ task, message }) => `${task.externalKey ?? task.identifier}：${message}`).join("；")}`,
          `${deletedIds.size} deleted; ${failed.map(({ task, message }) => `${task.externalKey ?? task.identifier}: ${message}`).join("; ")}`,
        ));
      }
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      batchDeleteInFlightRef.current = false;
      setDeletingArchivedTaskId(null);
    }
  }

  function openMergeIdeasEditorForSources(sourceSnapshot: Task[], startAfterSave = false) {
    const sources = sourceSnapshot.filter((task) => isMergeIdeaEligible(task));
    const projectId = sources[0]?.projectId;
    if (!projectId || sources.length < 2 || sources.some((task) => task.projectId !== projectId)) return;
    setEditor({
      status: "todo",
      projectId,
      mergeSources: [...sources],
      mergeRequestId: crypto.randomUUID(),
      mergeOperationId: crypto.randomUUID(),
      mergeStartAfterSave: startAfterSave,
    });
  }

  function openMergeIdeasEditor() {
    openMergeIdeasEditorForSources(tasks.filter((task) => selectedIdeaIds.has(task.id)));
  }

  useEffect(() => {
    if (host !== "paseo") {
      setIdeaSelectionMode(false);
      setSelectedIdeaIds((current) => current.size === 0 ? current : new Set());
      return;
    }
    if (batchMoveInFlightRef.current) return;
    setSelectedIdeaIds((current) => {
      const candidates = tasks.filter((task) => current.has(task.id) && isMergeIdeaEligible(task));
      const projectId = candidates[0]?.projectId;
      const valid = projectId ? candidates.filter((task) => task.projectId === projectId) : [];
      const next = new Set(valid.map((task) => task.id));
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
    });
  }, [host, paseoAssignments, selectedProjectId, tasks]);

  function mainColumnLabel(status: TaskStatus): string | undefined {
    if (!usesPaseoDefaultBoard) return undefined;
    if (status === "todo") return text("等待认领", "Ideas");
    if (status === "in_progress") return text("处理中", "In progress");
    if (status === "in_review") return text("等你确认", "Awaiting review");
    return undefined;
  }

  function mainColumnEmptyMessage(status: TaskStatus): string {
    if (hasActiveTaskFilters) return text("当前筛选下无匹配议题", "No issues match the current filters");
    if (!usesPaseoDefaultBoard) return text("暂无议题", "No issues");
    if (status === "todo") return text("当前没有等待认领的议题。", "There are no ideas waiting to be claimed.");
    if (status === "in_progress") {
      return text("当前没有进行中的议题，可从等待认领拖入处理中。", "No issues are in progress. Drag an idea here to start it.");
    }
    return text("当前没有等待确认的议题。", "There are no issues awaiting review.");
  }

  const mainBoardItems = boardDisplaySettings.mainStatuses.filter(
    (status) => status !== "blocked"
      || !hasLoadedTasks
      || tasks.some((task) => task.status === "blocked"),
  );
  const mainBoardTaskCount = mainBoardItems.reduce(
    (count, status) => count + (status === "archived"
      ? filteredArchivedTasks.length
      : mainColumnTasks(status).length),
    0,
  );
  const doneTaskCount = tasks.filter((task) => task.status === "done").length;
  const canceledTaskCount = tasks.filter((task) => task.status === "canceled").length;
  const archivedTaskCount = archivedTasks.length;
  const boardScopeLabel = isAllProjects
    ? text("全部项目", "All projects")
    : selectedProject?.name ?? text("当前项目", "Current project");
  const emptyMainBoard = !tasksLoading && mainBoardTaskCount === 0;
  const mainColumnCount = Math.max(mainBoardItems.length, 1);
  const mainBoardMinWidth = (mainColumnCount * 300) + ((mainColumnCount - 1) * 24);
  const mainBoardMaxWidth = (mainColumnCount * 400) + ((mainColumnCount - 1) * 24);
  const otherTasksColumnCount = mainColumnCount + 1;
  const otherTasksWidth = `clamp(300px, calc(${100 / otherTasksColumnCount}% - ${(36 + (mainColumnCount * 24)) / otherTasksColumnCount}px), 400px)`;
  const otherTaskTabs = boardDisplaySettings.sidebarStatuses;
  const otherTaskTabsKey = otherTaskTabs.join(",");
  const otherTasksAvailable = otherTaskTabs.length > 0;

  useEffect(() => {
    if (!otherTasksAvailable) {
      setOtherTasksOpen(false);
      return;
    }
    if (otherTaskTabs.includes(otherTasksTab)) return;
    setOtherTasksTab(otherTaskTabs[0]);
  }, [otherTaskTabsKey, otherTasksAvailable, otherTasksTab]);

  function toggleOtherTasks(tab: OtherTaskTab) {
    const closingCurrentTab = otherTasksOpen && otherTasksTab === tab;
    setOtherTasksTab(tab);
    setOtherTasksOpen(!closingCurrentTab);
  }

  const aiThreadsByTask = useMemo(() => indexAiThreadsByTask(aiThreads), [aiThreads]);
  function paseoWorkspaceDisplay(task: Task, assignment: PaseoTaskAssignment | undefined): TaskCardPresentation["workspaceDisplay"] {
    const worktreePath = task.developmentContext?.type === "worktree"
      ? task.developmentContext.path
      : null;
    const plannedPath = assignment?.kind === "planned" ? assignment.workspacePath : null;
    const path = worktreePath ?? plannedPath;
    const basename = (value: string) => value.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? value;
    const assignmentName = assignment?.kind === "existing" ? assignment.workspaceName?.trim() : "";
    const name = assignmentName || (path ? basename(path) : "");
    return name ? { name, path } : null;
  }
  const taskPresentations = useMemo(() => Object.fromEntries(tasks.map((task) => {
    const storageKey = issueReadStorageKey(issueReadMode, task);
    const readActivityKey = readActivityKeys[storageKey] ?? taskboardStorage.getItem(storageKey);
    const unread = (task.status === "in_review" || task.status === "blocked")
      && readActivityKey !== task.activityKey;
    const runningNativeThreadId = hostContext?.threadRunning
      ? hostContext.threadId ?? null
      : null;
    const taskThreadId = normalizeCodexThreadId(task.threadId);
    return [task.id, taskCardPresentation(
      task,
      aiThreadsByTask.get(task.id) ?? [],
      unread,
      runningNativeThreadId,
      hostContext?.threadTodoProgress ?? null,
      taskThreadId ? codexThreadProgress[taskThreadId] ?? null : undefined,
      host === "paseo" ? paseoAgentPresentations[task.id] ?? null : null,
      host === "paseo" ? paseoWorkspaceDisplay(task, paseoAssignments[task.id]) : null,
    )];
  })) as Record<string, TaskCardPresentation>, [
    aiThreadsByTask,
    codexThreadProgress,
    hostContext?.threadId,
    hostContext?.threadRunning,
    hostContext?.threadTodoProgress,
    issueReadMode,
    host,
    paseoAgentPresentations,
    paseoAssignments,
    readActivityKeys,
    tasks,
  ]);

  function selectBoardView(view: BoardView) {
    closeContextMenu();
    setGanttViewMenuOpen(false);
    setBoardView(view);
    if (selectedProjectId) {
      taskboardStorage.setItem(`${PROJECT_VIEW_KEY_PREFIX}${selectedProjectId}`, view);
    }
  }

  function updateProjectBoardDisplaySettings(value: BoardDisplaySettings) {
    setProjectBoardDisplaySettings((current) => {
      const next = { ...current, [selectedProjectId]: value };
      taskboardStorage.setItem(
        `${PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX}${selectedProjectId}`,
        JSON.stringify(value),
      );
      return next;
    });
  }

  function resetProjectBoardDisplaySettings() {
    setProjectBoardDisplaySettings((current) => {
      const next = { ...current };
      delete next[selectedProjectId];
      taskboardStorage.removeItem(
        `${PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX}${selectedProjectId}`,
      );
      return next;
    });
  }

  async function saveEditor(
    draft: TaskDraft,
    inlineFiles: PendingInlineAttachment[],
    inlineImages: PendingInlineImage[],
    createOptions?: NewTaskCreateOptions,
  ) {
    if (!selectedProjectId || !editor) return;
    const targetProjectId = editorProjectId ?? selectedProjectId;
    setActionError(null);
    let saved = await createTaskRequest(targetProjectId, draft);
    setProjects((current) => current.map((project) => (
      project.id === targetProjectId
        ? { ...project, issueCount: project.issueCount + 1 }
        : project
    )));
    let assignmentStillSaving = false;
    if (host === "paseo" && createOptions?.paseoAssigneeId) {
      try {
        const assignment = await savePaseoTaskAssignment(
          saved,
          createOptions.paseoAssigneeId,
          createOptions.paseoWorkspacePath,
          {
            ...(createOptions.paseoModeId ? { modeId: createOptions.paseoModeId } : {}),
            ...(createOptions.paseoThinkingOptionId
              ? { thinkingOptionId: createOptions.paseoThinkingOptionId }
              : {}),
          },
        );
        if (assignment) {
          setPaseoAssignments((current) => ({ ...current, [saved.id]: assignment }));
        }
      } catch (error) {
        setTasks((current) => sortTasks([...current, saved]));
        if (error instanceof PaseoAssignmentSavePendingError) {
          assignmentStillSaving = true;
        } else {
          throw new Error(`${saved.identifier} 已创建，但 Paseo 负责人保存失败：${errorMessage(error)}`);
        }
      }
    }
    let postCreateWriteFailed = false;
    if (inlineFiles.length > 0 || inlineImages.length > 0) {
      const [fileResults, inlineResults] = await Promise.all([
          Promise.allSettled(
            inlineFiles.map((file) => uploadAttachment(saved.id, file.file, "attachment")),
          ),
          Promise.allSettled(
            inlineImages.map((image) => uploadAttachment(saved.id, image.file, "inline")),
          ),
      ]);
      const fileAttachments = fileResults.flatMap((result) => (
        result.status === "fulfilled" ? [result.value] : []
      ));
      const inlineAttachments = inlineResults.flatMap((result) => (
        result.status === "fulfilled" ? [result.value] : []
      ));
      if (
        fileAttachments.length !== inlineFiles.length
        || inlineAttachments.length !== inlineImages.length
      ) {
        postCreateWriteFailed = true;
      } else if (inlineFiles.length > 0 || inlineImages.length > 0) {
        try {
          const description = resolveInlineAttachments(
            draft.description,
            [...inlineImages, ...inlineFiles],
            [...inlineAttachments, ...fileAttachments],
          );
          saved = await updateTaskRequest(saved, { ...draft, description });
        } catch {
          postCreateWriteFailed = true;
        }
      }
    }
    const relationUpdates = new Map<string, Task>();
    const movedSubIssues: Array<{ task: Task; previousParentId: string | null }> = [];
    let addedParentId: string | null = null;
    const addedRelatedIds: string[] = [];
    let relationWriteFailed = false;
    if (createOptions) {
      const { parentId, relatedIds, subIssueIds } = createOptions.relations;
      try {
        if (parentId) {
          const result = await addTaskRelation(saved, "parent", parentId);
          saved = result.task;
          addedParentId = parentId;
          relationUpdates.set(result.relatedTask.id, result.relatedTask);
        }
        for (const relatedId of relatedIds) {
          const result = await addTaskRelation(saved, "related", relatedId);
          saved = result.task;
          addedRelatedIds.push(relatedId);
          relationUpdates.set(result.relatedTask.id, result.relatedTask);
        }
        for (const subIssueId of subIssueIds) {
          const child = relationUpdates.get(subIssueId)
            ?? tasksRef.current.find((candidate) => candidate.id === subIssueId)!;
          const previousParentId = child.relations.parent?.id ?? null;
          const result = await addTaskRelation(child, "parent", saved.id);
          movedSubIssues.push({ task: result.task, previousParentId });
          relationUpdates.set(result.task.id, result.task);
          saved = result.relatedTask;
        }
      } catch {
        relationWriteFailed = true;
      }
    }
    relationUpdates.set(saved.id, saved);
    setTasks((current) => sortTasks([
      ...current.filter((task) => !relationUpdates.has(task.id)),
      ...relationUpdates.values(),
    ]));
    setNewTaskDraft(null);
    const failedWrites = [
      ...(relationWriteFailed ? [{ zh: "关系", en: "relations" }] : []),
      ...(postCreateWriteFailed ? [{ zh: "正文或媒体", en: "description or media" }] : []),
    ];
    if (!createOptions?.keepOpen || failedWrites.length > 0 || assignmentStillSaving) setEditor(null);
    if (failedWrites.length > 0) {
      setActionError(text(
        `${saved.identifier} 已创建，但以下内容写入失败：${failedWrites.map((failure) => failure.zh).join("、")}。`,
        `${saved.identifier} was created, but these follow-up writes failed: ${failedWrites.map((failure) => failure.en).join(", ")}.`,
      ));
    }
    if (assignmentStillSaving) {
      setActionError(text(
        `${saved.identifier} 已创建，Paseo 负责人仍在保存；已打开详情，刷新后确认即可，不会重复创建任务。`,
        `${saved.identifier} was created and its Paseo assignee is still saving. The detail is open; refresh to confirm without creating another task.`,
      ));
      requestAnimationFrame(() => openTaskDetail(saved));
    }
    pushUndo(null, async () => {
      const restoredRelations = new Map<string, Task>();
      const candidate = tasksRef.current.find((task) => task.id === saved.id);
      let current = candidate && candidate.version >= saved.version ? candidate : saved;
      if (addedParentId) {
        const result = await removeTaskRelation(current, "parent", addedParentId);
        current = result.task;
        restoredRelations.set(result.relatedTask.id, result.relatedTask);
      }
      for (const relatedId of [...addedRelatedIds].reverse()) {
        const result = await removeTaskRelation(current, "related", relatedId);
        current = result.task;
        restoredRelations.set(result.relatedTask.id, result.relatedTask);
      }
      for (const movedSubIssue of [...movedSubIssues].reverse()) {
        const latestChild = tasksRef.current.find((task) => task.id === movedSubIssue.task.id);
        const child = latestChild && latestChild.version >= movedSubIssue.task.version
          ? latestChild
          : movedSubIssue.task;
        const removed = await removeTaskRelation(child, "parent", saved.id);
        restoredRelations.set(removed.task.id, removed.task);
        current = removed.relatedTask;
        if (movedSubIssue.previousParentId) {
          const restored = await addTaskRelation(
            removed.task,
            "parent",
            movedSubIssue.previousParentId,
          );
          restoredRelations.set(restored.task.id, restored.task);
          restoredRelations.set(restored.relatedTask.id, restored.relatedTask);
        }
      }
      await archiveTaskRequest(current);
      setTasks((tasks) => sortTasks([
        ...tasks.filter((task) => task.id !== saved.id && !restoredRelations.has(task.id)),
        ...[...restoredRelations.values()].filter((task) => task.id !== saved.id),
      ]));
    });
  }

  async function moveTask(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null = null,
    useDropPosition = false,
  ) {
    if (movingTaskId || batchMoveInFlightRef.current) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskIds(new Set());
      setDraggedTaskHeight(0);
      return;
    }

    const destination = tasks.filter((candidate) => (
      candidate.projectId === task.projectId
      && candidate.status === status
      && candidate.id !== task.id
    ));
    const statusChanged = task.status !== status;
    const insertionIndex = statusChanged && !useDropPosition
      ? 0
      : beforeTaskId
        ? destination.findIndex((candidate) => candidate.id === beforeTaskId)
        : destination.length;
    const targetIndex = insertionIndex < 0 ? destination.length : insertionIndex;
    const desiredOrder = [...destination];
    desiredOrder.splice(targetIndex, 0, task);
    const currentOrder = tasks.filter((candidate) => (
      candidate.projectId === task.projectId && candidate.status === status
    ));
    if (
      task.status === status
      && currentOrder.length === desiredOrder.length
      && currentOrder.every((candidate, index) => candidate.id === desiredOrder[index].id)
    ) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskIds(new Set());
      setDraggedTaskHeight(0);
      return;
    }
    const previousTask = destination[targetIndex - 1] ?? null;
    const nextTask = destination[targetIndex] ?? null;
    const sortOrder = previousTask && nextTask
      ? (previousTask.sortOrder + nextTask.sortOrder) / 2
      : previousTask
        ? previousTask.sortOrder + 1024
        : nextTask
          ? nextTask.sortOrder - 1024
          : 1024;
    const previous = task;
    setActionError(null);
    setMovingTaskId(task.id);
    setTasks((current) => sortTasks(current.map((candidate) =>
      candidate.id === task.id ? { ...candidate, status, sortOrder } : candidate,
    )));

    try {
      const moved = await moveTaskRequest(task, status, sortOrder);
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === moved.id ? moved : candidate,
      )));
      pushUndo(null, async () => {
        const candidate = tasksRef.current.find((current) => current.id === moved.id);
        const current = candidate && candidate.version >= moved.version ? candidate : moved;
        const restored = await moveTaskRequest(current, previous.status, previous.sortOrder);
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === restored.id ? restored : item)));
      });
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? textRef.current(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : host === "paseo"
          && error instanceof ApiError
          && error.status === 0
          && error.code === "SERVICE_UNAVAILABLE"
          ? {
              kind: "pending-task-sync",
              message: errorMessage(error),
              taskId: task.id,
              previousVersion: task.version,
            }
          : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      setMovingTaskId(null);
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskIds(new Set());
      setDraggedTaskHeight(0);
    }
  }

  function taskBelongsToVisualColumn(taskStatus: TaskStatus, columnStatus: TaskStatus): boolean {
    if (!usesPaseoDefaultBoard) return taskStatus === columnStatus;
    if (columnStatus === "todo") return taskStatus === "backlog" || taskStatus === "todo";
    if (columnStatus === "in_progress") return taskStatus === "in_progress" || taskStatus === "blocked";
    return taskStatus === columnStatus;
  }

  async function moveSelectedTasks(
    taskIds: string[],
    destination: TaskStatus,
    beforeTaskId: string | null,
  ) {
    if (batchMoveInFlightRef.current || movingTaskId) return;
    const snapshot = taskIds
      .map((id) => tasksRef.current.find((task) => task.id === id))
      .filter((task): task is Task => Boolean(task));
    if (snapshot.length < 2) return;

    const projectId = snapshot[0].projectId;
    if (snapshot.some((task) => task.projectId !== projectId)) {
      setActionError(text("只能整组移动同一项目的议题。", "Only issues from the same project can be moved together."));
      return;
    }

    const selectedIds = new Set(snapshot.map((task) => task.id));
    const ordered = [...snapshot].sort((left, right) => (
      left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt)
    ));
    const destinationTasks = tasksRef.current
      .filter((task) => (
        task.projectId === projectId
        && !selectedIds.has(task.id)
        && taskBelongsToVisualColumn(task.status, destination)
      ))
      .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt));
    const requestedIndex = beforeTaskId
      ? destinationTasks.findIndex((task) => task.id === beforeTaskId)
      : destinationTasks.length;
    const insertionIndex = requestedIndex < 0 ? destinationTasks.length : requestedIndex;
    const previousTask = destinationTasks[insertionIndex - 1] ?? null;
    const nextTask = destinationTasks[insertionIndex] ?? null;
    const orders = ordered.map((_, index) => {
      if (previousTask && nextTask) {
        return previousTask.sortOrder
          + ((nextTask.sortOrder - previousTask.sortOrder) * (index + 1)) / (ordered.length + 1);
      }
      if (previousTask) return previousTask.sortOrder + 1024 * (index + 1);
      if (nextTask) return nextTask.sortOrder - 1024 * (ordered.length - index);
      return 1024 * (index + 1);
    });
    const moves = ordered.map((task, index) => {
      const staysInMergedColumn = usesPaseoDefaultBoard
        && taskBelongsToVisualColumn(task.status, destination);
      return {
        task,
        status: staysInMergedColumn ? task.status : destination,
        sortOrder: orders[index],
        configured: destination !== "in_progress" || paseoAssignments[task.id]?.kind === "planned",
      };
    });

    batchMoveInFlightRef.current = true;
    setActionError(null);
    setBatchMovingTaskIds(new Set(taskIds));
    setTasks((current) => sortTasks(current.map((task) => {
      const move = moves.find((candidate) => candidate.task.id === task.id && candidate.configured);
      return move ? { ...task, status: move.status, sortOrder: move.sortOrder } : task;
    })));

    const successfulIds = new Set<string>();
    const failures: Array<{ task: Task; message: string; retryable: boolean }> = moves
      .filter((move) => !move.configured)
      .map((move) => ({
        task: move.task,
        message: text("尚未保存 Agent 配置", "Agent configuration has not been saved"),
        retryable: true,
      }));
    const uncertain: Array<{ task: Task; message: string }> = [];
    let needsRefresh = false;

    try {
      for (const move of moves) {
        if (!move.configured) continue;
        try {
          const moved = await moveTaskRequest(move.task, move.status, move.sortOrder);
          if (move.status === "in_progress" && moved.status === "blocked") {
            setTasks((current) => sortTasks(current.map((task) => task.id === moved.id ? moved : task)));
            failures.push({
              task: moved,
              message: text("Agent 启动失败，任务已进入阻塞状态", "Agent start failed and the issue is blocked"),
              retryable: false,
            });
            continue;
          }
          successfulIds.add(move.task.id);
          setTasks((current) => sortTasks(current.map((task) => task.id === moved.id ? moved : task)));
        } catch (error) {
          let reconciled: Task | null = null;
          if (error instanceof ApiError && error.status === 0 && error.code === "SERVICE_UNAVAILABLE") {
            needsRefresh = true;
            try {
              const latest = (await listTasks(projectId)).find((task) => task.id === move.task.id) ?? null;
              const continuedAfterStart = move.status === "in_progress"
                && latest
                && latest.version > move.task.version
                && ["in_progress", "in_review", "done"].includes(latest.status);
              if (latest && latest.version > move.task.version
                && (latest.status === move.status || continuedAfterStart)) {
                reconciled = latest;
              } else if (latest?.status === "blocked" && latest.version > move.task.version) {
                setTasks((current) => sortTasks(current.map((task) => task.id === latest.id ? latest : task)));
                failures.push({
                  task: latest,
                  message: text("Paseo 已将任务标记为阻塞，未成功启动", "Paseo marked the issue blocked; it did not start successfully"),
                  retryable: false,
                });
                continue;
              }
            } catch {
              // 保留失败项，等待正常任务轮询确认后再由用户重试。
            }
          }
          if (reconciled) {
            successfulIds.add(move.task.id);
            setTasks((current) => sortTasks(current.map((task) => task.id === reconciled!.id ? reconciled! : task)));
          } else {
            setTasks((current) => sortTasks(current.map((task) => task.id === move.task.id ? move.task : task)));
            if (error instanceof ApiError && error.status === 0 && error.code === "SERVICE_UNAVAILABLE") {
              uncertain.push({
                task: move.task,
                message: text("网络结果待刷新确认，请勿立即重试", "Network result awaits refresh; do not retry yet"),
              });
            } else {
              failures.push({ task: move.task, message: errorMessage(error), retryable: true });
            }
          }
        }
      }

      const failedIds = new Set(failures.filter((failure) => failure.retryable).map((failure) => failure.task.id));
      setSelectedIdeaIds((current) => new Set([...current].filter((id) => (
        !selectedIds.has(id) || failedIds.has(id)
      ))));
      if (failures.length === 0 && uncertain.length === 0) {
        setIdeaSelectionMode(false);
        setAnnouncement(text(
          `已移动 ${successfulIds.size} 项议题。`,
          `${successfulIds.size} issues moved.`,
        ));
      } else {
        const resultDetails = [
          ...failures.map(({ task, message }) => `${task.externalKey ?? task.identifier}：${message}`),
          ...uncertain.map(({ task, message }) => `${task.externalKey ?? task.identifier}：${message}`),
        ].join("；");
        setActionError(text(
          `已移动 ${successfulIds.size} 项。${resultDetails}${failedIds.size > 0 ? "；可重试的失败项已保留选择。" : ""}`,
          `${successfulIds.size} moved. ${resultDetails}${failedIds.size > 0 ? "; retryable failures remain selected." : ""}`,
        ));
      }
      if (needsRefresh && taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      batchMoveInFlightRef.current = false;
      setBatchMovingTaskIds(new Set());
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskIds(new Set());
      setDraggedTaskHeight(0);
    }
  }

  function startTaskDrag(task: Task, height: number) {
    const snapshot = ideaSelectionMode && selectedIdeaIds.has(task.id)
      ? tasks
          .filter((candidate) => selectedIdeaIds.has(candidate.id) && isMergeIdeaEligible(candidate))
          .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt))
      : [task];
    draggedTaskIdsRef.current = snapshot.map((candidate) => candidate.id);
    setDraggedTaskId(task.id);
    setDraggedTaskIds(new Set(draggedTaskIdsRef.current));
    setDraggedTaskHeight(height);
    setDropTarget(task.status);
  }

  function endTaskDrag() {
    draggedTaskIdsRef.current = [];
    setDraggedTaskId(null);
    setDraggedTaskIds(new Set());
    setDraggedTaskHeight(0);
    setDropTarget(null);
  }

  function finishTaskDrop(destination: TaskStatus, taskId: string, beforeTaskId: string | null = null) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    const taskIds = draggedTaskIdsRef.current.includes(taskId)
      ? [...draggedTaskIdsRef.current]
      : [taskId];
    draggedTaskIdsRef.current = [];
    setDraggedTaskId(null);
    setDraggedTaskIds(new Set());
    setDraggedTaskHeight(0);
    setDropTarget(null);
    if (!task) return;
    if (taskIds.length > 1) {
      if (host === "paseo" && destination === "in_progress") {
        openMergeIdeasEditorForSources(
          taskIds.map((id) => tasksRef.current.find((candidate) => candidate.id === id))
            .filter((candidate): candidate is Task => Boolean(candidate)),
          true,
        );
        return;
      }
      void moveSelectedTasks(taskIds, destination, beforeTaskId);
      return;
    }
    setSettlingTaskId(task.id);
    window.setTimeout(() => {
      setSettlingTaskId((current) => current === task.id ? null : current);
    }, 220);
    // Paseo 默认列把 blocked 与 in_progress 合在“处理中”；同列排序不可暗中重试 Agent。
    const effectiveDestination = usesPaseoDefaultBoard
      && destination === "in_progress"
      && task.status === "blocked"
      ? "blocked"
      : destination;
    void moveTask(task, effectiveDestination, beforeTaskId, true);
  }

  async function saveMergeIdeasDraft(
    draft: TaskDraft,
    inlineFiles: PendingInlineAttachment[],
    inlineImages: PendingInlineImage[],
    createOptions?: NewTaskCreateOptions,
  ) {
    if (!editor?.mergeSources || !editor.mergeRequestId || !editor.mergeOperationId || !editor.projectId) {
      throw new Error("合并草稿已失效，请重新选择来源想法。");
    }
    if (inlineFiles.length > 0 || inlineImages.length > 0) {
      throw new Error("合并任务的补充要求暂不支持附件，请移除附件后重试。");
    }
    const choice = createOptions?.paseoAssigneeId
      ? paseoAssigneeChoices.choices.get(createOptions.paseoAssigneeId)
      : null;
    if (choice?.kind !== "planned" || !choice.profile) {
      throw new Error("请选择用于新任务的新建 Agent 配置。");
    }
    const workspacePath = createOptions?.paseoWorkspacePath;
    if (!workspacePath) throw new Error("请选择新 Agent 的项目或工作区。");
    const sourceTaskIds = editor.mergeSources.map((source) => source.id);
    if (sourceTaskIds.length < 2 || sourceTaskIds.length > 50) {
      throw new Error("请选择 2 至 50 个来源想法。");
    }
    const result = await requestPaseoMergeIdeas({
      requestId: editor.mergeRequestId,
      operationId: editor.mergeOperationId,
      projectId: editor.projectId,
      sourceTaskIds,
      title: draft.title,
      ...(draft.description.trim() ? { description: draft.description } : {}),
      workspacePath,
      profile: {
        ...choice.profile,
        modeId: createOptions?.paseoModeId,
        thinkingOptionId: createOptions?.paseoThinkingOptionId,
      },
    });
    const archivedSourceIds = new Set(result.sourceTaskIds);
    setTasks((current) => sortTasks([
      ...current.filter((task) => !archivedSourceIds.has(task.id) && task.id !== result.task.id),
      result.task,
    ]));
    setPaseoAssignments((current) => ({
      ...Object.fromEntries(Object.entries(current).filter(([taskId]) => !archivedSourceIds.has(taskId))),
      [result.task.id]: result.assignment,
    }));
    const startAfterSave = editor.mergeStartAfterSave === true;
    let startedTask: Task | null = null;
    let startError: unknown = null;
    let startUnconfirmed = false;
    if (startAfterSave) {
      if (["in_progress", "in_review", "done"].includes(result.task.status)) {
        startedTask = result.task;
      } else if (result.task.status === "blocked") {
        startError = new Error("blocked");
      } else {
        try {
          startedTask = await moveTaskRequest(result.task, "in_progress");
          if (startedTask.status === "blocked") startError = new Error("blocked");
        } catch (error) {
          startError = error;
          startUnconfirmed = error instanceof ApiError
            && error.status === 0
            && error.code === "SERVICE_UNAVAILABLE";
        }
      }
    }
    const finalTask = startedTask ?? result.task;
    setTasks((current) => sortTasks(current.map((task) => task.id === finalTask.id ? finalTask : task)));
    setSelectedIdeaIds(new Set());
    setIdeaSelectionMode(false);
    setNewTaskDraft(null);
    setEditor(null);
    setActionError(null);
    if (startAfterSave && startError) {
      setActionError(text(
        startUnconfirmed
          ? `${result.task.identifier} 已合并，启动尚未确认；请打开详情刷新后再决定是否重试。`
          : `${result.task.identifier} 已合并，启动失败，请打开详情重试。`,
        startUnconfirmed
          ? `${result.task.identifier} was merged, but start is not yet confirmed. Refresh the detail before retrying.`
          : `${result.task.identifier} was merged, but starting failed. Open the detail to retry.`,
      ));
      requestAnimationFrame(() => openTaskDetail(finalTask));
    } else if (startAfterSave) {
      setAnnouncement(text(
        `${result.task.identifier} 已合并并开始；来源想法已保留记录并归档。`,
        `${result.task.identifier} was merged and started; source ideas kept their history and were archived.`,
      ));
    } else {
      setAnnouncement(text(
        `${result.task.identifier} 已创建；${archivedSourceIds.size} 个来源想法已保留记录并归档。`,
        `${result.task.identifier} was created; ${archivedSourceIds.size} source ideas kept their history and were archived.`,
      ));
    }
    void refreshTasks(editor.projectId, { quiet: true });
  }

  async function updateTaskProperties(task: Task, changes: Partial<TaskDraft>): Promise<Task> {
    const previous = task;
    const { assigneeTarget, ...taskChanges } = changes;
    const optimisticAssignee = assigneeTarget
      ? actorForAssigneeTarget(assigneeTarget, currentUser)
      : task.assignee;
    const optimisticParticipants = assigneeTarget
      && !task.participants.some((participant) => actorKey(participant) === actorKey(optimisticAssignee))
      ? [...task.participants, optimisticAssignee]
      : task.participants;
    setActionError(null);
    setTasks((current) => current.map((candidate) =>
      candidate.id === task.id
        ? { ...candidate, ...taskChanges, assignee: optimisticAssignee, participants: optimisticParticipants }
        : candidate,
    ));

    try {
      // 原版详情的状态下拉只修改 status。用 /move 保留 Paseo 父端的自动派发链；
      // 含其它属性的完整 PATCH 则原样交给 Dashi，不能丢 developmentContext 等字段。
      const statusOnly = Object.keys(changes).length === 1 && typeof changes.status === "string";
      const updated = statusOnly
        ? await moveTaskRequest(task, changes.status!)
        : await updateTaskRequest(task, { ...taskToDraft(task), ...changes });
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      )));
      const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
      if (!assigneeTarget || previousAssigneeTarget) {
        pushUndo(
          null,
          () => restoreTaskDetails(previous, updated, previousAssigneeTarget),
        );
      }
      return updated;
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
      throw error;
    }
  }

  async function persistProjectLabel(label: string, projectId = selectedProjectId) {
    setActionError(null);
    try {
      const project = await createProjectLabelRequest(projectId, label);
      setProjects((current) => current.map((candidate) => (
        candidate.id === project.id ? project : candidate
      )));
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    }
  }

  async function removeProjectLabel(label: string) {
    setActionError(null);
    try {
      const project = await deleteProjectLabelRequest(selectedProjectId, label);
      setProjects((current) => current.map((candidate) => (
        candidate.id === project.id ? project : candidate
      )));
      await refreshTasks(taskScopeProjectId, { quiet: true });
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    }
  }

  async function mutateTaskRelation(
    action: "add" | "remove",
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
    origin?: IssueRelationOrigin,
  ) {
    setActionError(null);
    try {
      const result = action === "add"
        ? await addTaskRelation(task, type, relatedTaskId, undefined, origin)
        : await removeTaskRelation(task, type, relatedTaskId, undefined, origin);
      setTasks((current) => sortTasks(current.map((candidate) => {
        if (candidate.id === result.task.id) return result.task;
        if (candidate.id === result.relatedTask.id) return result.relatedTask;
        return candidate;
      })));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
      throw error;
    }
  }

  async function duplicateTask(task: Task) {
    setActionError(null);
    try {
      const duplicated = await createTaskRequest(task.projectId, {
        ...taskToDraft(task),
        assigneeTarget: assigneeTargetForActor(task.assignee, currentUser),
        developmentContext: null,
      });
      setTasks((current) => sortTasks([...current, duplicated]));
      pushUndo(text(
        `${duplicated.identifier} 副本已创建。`,
        `${duplicated.identifier} copy was created.`,
      ), async () => {
        const candidate = tasksRef.current.find((current) => current.id === duplicated.id);
        const current = candidate && candidate.version >= duplicated.version ? candidate : duplicated;
        await archiveTaskRequest(current);
        setTasks((tasks) => tasks.filter((item) => item.id !== duplicated.id));
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function archiveTask(task: Task) {
    setActionError(null);
    try {
      const archived = await archiveTaskRequest(task);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setArchivedTasks((current) => sortTasks([
        ...current.filter((candidate) => candidate.id !== archived.id),
        archived,
      ]));
      pushUndo(text(`${task.identifier} 已归档。`, `${task.identifier} was archived.`), async () => {
        const restored = await restoreTaskRequest(archived);
        setArchivedTasks((current) => current.filter((candidate) => candidate.id !== restored.id));
        setTasks((current) => sortTasks([
          ...current.filter((candidate) => candidate.id !== restored.id),
          restored,
        ]));
      });
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    }
  }

  async function restoreArchivedTask(task: Task) {
    setActionError(null);
    setRestoringTaskId(task.id);
    try {
      const restored = await restoreTaskRequest(task);
      setArchivedTasks((current) => current.filter((candidate) => candidate.id !== restored.id));
      setTasks((current) => sortTasks([
        ...current.filter((candidate) => candidate.id !== restored.id),
        restored,
      ]));
      setAnnouncement(text(
        `${restored.identifier} 已恢复。`,
        `${restored.identifier} was restored.`,
      ));
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      setRestoringTaskId(null);
    }
  }

  async function deletePendingArchivedTask() {
    if (!pendingArchivedTaskDelete || deletingArchivedTaskId) return;
    const task = pendingArchivedTaskDelete;
    setActionError(null);
    setDeletingArchivedTaskId(task.id);
    let archived = task;
    try {
      if (!archived.archivedAt) {
        archived = await archiveTaskRequest(task);
        setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
        setArchivedTasks((current) => sortTasks([
          ...current.filter((candidate) => candidate.id !== archived.id),
          archived,
        ]));
      }
      await deleteArchivedTaskRequest(archived);
      setArchivedTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setPendingArchivedTaskDelete(null);
      setAnnouncement(text(
        `${task.identifier} 已永久删除。`,
        `${task.identifier} was permanently deleted.`,
      ));
    } catch (error) {
      const message = error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : archived.archivedAt && !task.archivedAt
          ? text(
            `${task.identifier} 已归档，但永久删除失败；可在已归档列表中重试。`,
            `${task.identifier} was archived, but permanent deletion failed. Retry it from Archived.`,
          )
          : errorMessage(error);
      setActionError(message);
      if (archived.archivedAt && !task.archivedAt) setPendingArchivedTaskDelete(null);
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      setDeletingArchivedTaskId(null);
    }
  }

  async function copyText(content: string, message: string) {
    try {
      if (host === "paseo") await requestPaseoCopy({ kind: "text", text: content });
      else await navigator.clipboard.writeText(content);
      const previousCopyError = copyActionErrorRef.current;
      copyActionErrorRef.current = null;
      if (previousCopyError) {
        setActionError((current) => current === previousCopyError ? null : current);
      }
      setAnnouncement(message);
    } catch (error) {
      const copyError = error instanceof Error
        ? error.message
        : text("无法写入剪贴板。", "Could not write to the clipboard.");
      copyActionErrorRef.current = copyError;
      setActionError(copyError);
    }
  }

  function openTaskProjectMove(task: Task) {
    if (task.source === "jira") return;
    setPendingTaskProjectMove({ task, targetProjectId: null });
    setTaskProjectMoveSearch("");
    setTaskProjectMoveError(null);
  }

  function closeTaskProjectMove() {
    if (movingTaskProject) return;
    setPendingTaskProjectMove(null);
    setTaskProjectMoveSearch("");
    setTaskProjectMoveError(null);
  }

  async function confirmTaskProjectMove() {
    if (!pendingTaskProjectMove?.targetProjectId || movingTaskProject) return;
    const { task, targetProjectId } = pendingTaskProjectMove;
    const targetProject = projects.find((project) => project.id === targetProjectId);
    if (!targetProject || targetProject.source !== "local" || targetProject.id === task.projectId) return;
    const targetProjectName = projectChoices.find((project) => project.id === targetProjectId)?.name ?? targetProject.name;
    setMovingTaskProject(true);
    setTaskProjectMoveError(null);
    try {
      const moved = await moveTaskToProjectRequest(task, targetProjectId);
      setTasks((current) => {
        if (selectedProjectId !== ALL_PROJECTS_ID && selectedProjectId !== moved.projectId) {
          return current.filter((candidate) => candidate.id !== moved.id);
        }
        return sortTasks([
          ...current.filter((candidate) => candidate.id !== moved.id),
          moved,
        ]);
      });
      setProjects((current) => current.map((project) => {
        if (project.id === task.projectId) {
          return { ...project, issueCount: Math.max(0, project.issueCount - 1) };
        }
        if (project.id === moved.projectId) {
          return { ...project, issueCount: project.issueCount + 1 };
        }
        return project;
      }));
      if (detailTaskIdentifier === task.identifier && selectedProjectId !== ALL_PROJECTS_ID) {
        closeTaskDetail();
      }
      setPendingTaskProjectMove(null);
      setTaskProjectMoveSearch("");
      setAnnouncement(text(
        `${moved.identifier} 已移动到“${targetProjectName}”。`,
        `${moved.identifier} moved to “${targetProjectName}”.`,
      ));
      void refreshProjectList();
    } catch (error) {
      setTaskProjectMoveError(error instanceof ApiError && error.code === "CROSS_PROJECT_RELATION"
        ? text("该议题有父子、依赖或相关任务，请先解除这些关联，再移动到其他项目。", "Remove this issue's parent, dependency, and related issue links before moving it to another project.")
        : error instanceof ApiError && error.code === "AI_CHAT_PROJECT_MOVE_BLOCKED"
          ? text("该议题已关联原项目的内置 AI 对话，暂不支持跨项目移动。", "This issue has linked AI conversations in its original project and cannot be moved yet.")
          : error instanceof ApiError && error.code === "VERSION_CONFLICT"
            ? text("议题已发生变化，请重新打开移动窗口后重试。", "This issue has changed. Reopen the move dialog and try again.")
            : errorMessage(error));
    } finally {
      setMovingTaskProject(false);
    }
  }

  async function copyIssueLink(projectId: string, identifier: string, message: string) {
    try {
      if (host === "paseo") {
        await requestPaseoCopy({ kind: "issue-link", projectId, identifier });
      } else {
        await navigator.clipboard.writeText(buildIssueUrl(
          document.baseURI,
          projectId,
          identifier,
        ).href);
      }
      const previousCopyError = copyActionErrorRef.current;
      copyActionErrorRef.current = null;
      if (previousCopyError) {
        setActionError((current) => current === previousCopyError ? null : current);
      }
      setAnnouncement(message);
    } catch (error) {
      const copyError = error instanceof Error
        ? error.message
        : text("无法复制议题链接。", "Could not copy the issue link.");
      copyActionErrorRef.current = copyError;
      setActionError(copyError);
    }
  }

  function codexProjectContextForTaskProject(taskboardProjectId: string) {
    if (taskboardProjectId === GLOBAL_PROJECT_ID) return null;
    const taskboardProject = projects.find((project) => project.id === taskboardProjectId);
    const savedIdentity = projectCodexIdentities[taskboardProjectId];
    if (savedIdentity?.codexProjectKind === "remote") {
      const liveProject = hostContext?.projects?.find(
        (project) => project.id === savedIdentity.codexProjectId,
      );
      return liveProject?.projectKind === "remote"
        && liveProject.hostId === savedIdentity.codexHostId
        && liveProject.workspacePath === savedIdentity.workspacePath
        ? savedIdentity
        : null;
    }
    const directCodexProject = hostContext?.projects?.find(
      (project) => project.id === taskboardProjectId,
    );
    const mappedWorkspacePath = deviceWorkspacePaths[taskboardProjectId]
      ?? taskboardProject?.workspacePath
      ?? directCodexProject?.workspacePath;
    const codexProject = directCodexProject ?? hostContext?.projects?.find(
      (project) => project.workspacePath === mappedWorkspacePath,
    );
    if (!codexProject) return null;
    return {
      codexProjectId: codexProject.id,
      codexProjectKind: codexProject.projectKind ?? "local" as const,
      codexHostId: codexProject.hostId ?? "local",
      workspacePath: mappedWorkspacePath ?? codexProject.workspacePath,
    };
  }

  function openThread(binding: CodexThreadBinding) {
    const remoteProject = binding.codexProjectKind === "remote"
      ? hostContext?.projects?.find((project) => (
          project.id === binding.codexProjectId
          && project.projectKind === "remote"
          && project.hostId === binding.codexHostId
          && project.workspacePath === binding.workspacePath
        ))
      : null;
    if (binding.codexProjectKind === "remote" && !remoteProject) {
      setActionError(text(
        "该对话绑定的 SSH 远程项目或主机当前不可用。",
        "The SSH remote project or host bound to this conversation is not available.",
      ));
      return;
    }
    if (embedded && window.parent !== window) {
      postEmbeddedHostMessage({
        type: "taskboard:open-thread",
        payload: binding,
      });
      return;
    }

    if (binding.codexProjectKind === "remote") {
      setActionError(text(
        "请在 Codex App 中打开该 SSH 远程对话。",
        "Open this SSH remote conversation in the Codex app.",
      ));
      return;
    }
    window.location.assign(`codex://threads/${encodeURIComponent(binding.threadId.trim())}`);
  }

  function openLegacyLocalThread(threadId: string) {
    if (embedded && window.parent !== window) {
      postEmbeddedHostMessage({
        type: "taskboard:open-thread",
        payload: { threadId, legacyLocal: true },
      });
      return;
    }
    window.location.assign(`codex://threads/${encodeURIComponent(threadId.trim())}`);
  }

  function openTaskConversation(conversation: TaskConversationItem) {
    if (conversation.kind === "paseo" && conversation.paseoAgentId) {
      postEmbeddedHostMessage({
        type: "taskboard:open-paseo-agent",
        payload: { agentId: conversation.paseoAgentId },
      });
      return;
    }
    if (conversation.kind === "local-ai" && conversation.aiThreadId) {
      aiOpenThreadRequestSequenceRef.current += 1;
      setAiOpenThreadRequest({
        threadId: conversation.aiThreadId!,
        requestId: aiOpenThreadRequestSequenceRef.current,
      });
      return;
    }
    if (conversation.threadBinding) {
      openThread(conversation.threadBinding);
    } else if (conversation.legacyLocalThreadId) {
      openLegacyLocalThread(conversation.legacyLocalThreadId);
    }
  }

  function expandCodexSidebar() {
    if (!embedded || window.parent === window) return;
    postEmbeddedHostMessage({ type: "taskboard:expand-sidebar" });
  }

  function remoteIdentityForTask(
    task: Task,
    baseIdentity: CodexProjectIdentity,
  ): CodexProjectIdentity | null {
    if (task.developmentContext?.type === "worktree") {
      const worktreePath = task.developmentContext.path;
      const matches = (hostContext?.projects ?? []).filter((project) => (
        project.projectKind === "remote"
        && project.hostId === baseIdentity.codexHostId
        && project.workspacePath === worktreePath
      ));
      if (matches.length !== 1) return null;
      return {
        codexProjectId: matches[0].id,
        codexProjectKind: "remote",
        codexHostId: matches[0].hostId!,
        workspacePath: matches[0].workspacePath!,
      };
    }
    const liveProject = hostContext?.projects?.find((project) => (
      project.id === baseIdentity.codexProjectId
      && project.projectKind === "remote"
      && project.hostId === baseIdentity.codexHostId
      && project.workspacePath === baseIdentity.workspacePath
    ));
    return liveProject ? baseIdentity : null;
  }

  async function openTaskInThread(task: Task) {
    const standalone = !embedded || window.parent === window;
    const projectless = task.projectId === GLOBAL_PROJECT_ID;
    const taskboardProject = projects.find((project) => project.id === task.projectId);
    const savedRemoteIdentity = projectCodexIdentities[task.projectId]?.codexProjectKind === "remote"
      ? projectCodexIdentities[task.projectId]
      : null;
    let codexProjectContext = savedRemoteIdentity
      ?? codexProjectContextForTaskProject(task.projectId);
    if (
      projectCodexIdentities[task.projectId]?.codexProjectKind === "remote"
      && !codexProjectContext
    ) {
      setActionError(text(
        "已保存的 SSH 远程项目或主机当前不可用。",
        "The saved SSH remote project or host is not available.",
      ));
      return;
    }
    if (!standalone && codexProjectContext?.codexProjectKind === "remote") {
      const identity = remoteIdentityForTask(task, codexProjectContext);
      if (!identity) {
        setActionError(task.developmentContext?.type === "worktree"
          ? text(
            "目标 SSH worktree 未在保存的主机中添加或映射。",
            "The target SSH worktree is not added or mapped on the saved host.",
          )
          : text(
            "已保存的 SSH 远程项目或主机当前不可用。",
            "The saved SSH remote project or host is not available.",
          ));
        return;
      }
      codexProjectContext = identity;
    }
    let workspacePath = projectless
      ? undefined
      : task.developmentContext?.type === "worktree"
        ? task.developmentContext.path
        : codexProjectContext?.workspacePath
          ?? deviceWorkspacePaths[task.projectId]
          ?? taskboardProject?.workspacePath;
    const embeddedInstruction = text(
      `[$manage-taskboard](${manageTaskboardSkillPath}) 议题 ID：${task.identifier}`,
      `[$manage-taskboard](${manageTaskboardSkillPath}) Issue ID: ${task.identifier}`,
    );

    if (
      !projectless
      && task.developmentContext?.type === "worktree"
      && codexProjectContext?.codexProjectKind !== "remote"
    ) {
      const expectedWorktreePath = task.developmentContext.path;
      const baseWorkspacePath = codexProjectContext?.workspacePath
        ?? deviceWorkspacePaths[task.projectId]
        ?? taskboardProject?.workspacePath;
      if (standalone) {
        const worktreeExists = developmentScan.contexts.some((context) => (
          context.type === "worktree" && context.path === expectedWorktreePath
        ));
        if (!worktreeExists) workspacePath = developmentScan.workspacePath ?? baseWorkspacePath;
      } else {
        try {
          const scan = await listDevelopmentContexts(
            task.projectId,
            codexProjectContext?.codexProjectId,
            hostContext?.threadId ?? undefined,
            undefined,
            baseWorkspacePath,
          );
          const worktreeExists = scan.contexts.some((context) => (
            context.type === "worktree" && context.path === expectedWorktreePath
          ));
          if (!worktreeExists) workspacePath = scan.workspacePath ?? baseWorkspacePath;
        } catch (error) {
          setActionError(errorMessage(error));
          return;
        }
      }
    }

    if (codexProjectContext?.codexProjectKind === "remote" && !codexProjectContext.workspacePath) {
      setActionError(text(
        "SSH 远程项目缺少精确工作目录映射。",
        "The SSH remote project is missing its exact workspace mapping.",
      ));
      return;
    }
    if (openingThreadTaskId) return;
    if (standalone) {
      if (codexProjectContext?.codexProjectKind === "remote") {
        setActionError(text(
          "请在 Codex App 中打开该 SSH 远程项目的新对话。",
          "Open the new SSH remote project conversation in the Codex app.",
        ));
        return;
      }
      const deepLink = new URL("codex://threads/new");
      if (workspacePath) deepLink.searchParams.set("path", workspacePath);
      deepLink.searchParams.set("prompt", embeddedInstruction);
      window.location.assign(deepLink.toString());
      return;
    }
    setOpeningThreadTaskId(task.id);
    setActionError(null);
    postEmbeddedHostMessage({
      type: "taskboard:create-thread",
      payload: {
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        instruction: embeddedInstruction,
        projectless,
        codexProjectId: codexProjectContext?.codexProjectId,
        codexProjectKind: codexProjectContext?.codexProjectKind ?? "local",
        codexHostId: codexProjectContext?.codexHostId ?? "local",
        codexProjectWorkspacePath: codexProjectContext?.workspacePath,
        workspacePath,
      },
    });
  }

  function changeProject(projectId: string) {
    closeContextMenu();
    setProjectContextMenu(null);
    setProjectMenuOpen(false);
    detailSourceProjectIdRef.current = null;
    setDetailTaskIdentifier(null);
    setBoardView(projectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(projectId));
    if (projectId !== ALL_PROJECTS_ID) rememberProjectOpen(projectId);
    setSelectedProjectId(projectId);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    if (host === "paseo") return;
    const url = buildIssueUrl(window.location.href, projectId, null);
    window.history.replaceState(null, "", url);
  }

  async function selectProject(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      let project = projects.find((candidate) => candidate.id === choice.id) ?? null;
      if (!project) {
        try {
          project = await createProjectRequest({
            id: choice.id,
            name: choice.name,
            workspacePath: null,
          });
          setProjects((current) => [...current, project!]);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
          const nextProjects = await listProjects();
          setProjects(nextProjects);
          project = nextProjects.find((candidate) => candidate.id === choice.id) ?? null;
          if (!project) throw error;
        }
      }
      if (choice.codexIdentity) {
        setProjectCodexIdentities((current) => {
          const next = { ...current, [project!.id]: choice.codexIdentity! };
          taskboardStorage.setItem(PROJECT_CODEX_IDENTITIES_KEY, JSON.stringify(next));
          return next;
        });
        rememberDeviceWorkspacePath(project.id, choice.codexIdentity.workspacePath);
      }
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  function openJiraDialog() {
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setJiraError(null);
    setJiraDialogOpen(true);
  }

  async function saveJiraConnection(input: {
    baseUrl: string;
    username: string;
    password: string;
    projects: string[];
  }) {
    if (jiraSaving) return;
    setJiraSaving(true);
    setJiraError(null);
    try {
      const connection = await configureJiraConnection(input);
      const nextProjects = await listProjects();
      setJiraConnection(connection);
      setProjects(nextProjects);
      setJiraDialogOpen(false);
      changeProject(connection.projectId);
      await refreshTasks(connection.projectId);
      setAnnouncement(text(
        `已同步 ${connection.displayName ?? connection.username} 的 Jira 任务`,
        `Synced Jira issues for ${connection.displayName ?? connection.username}`,
      ));
    } catch (error) {
      setJiraError(errorMessage(error));
    } finally {
      setJiraSaving(false);
    }
  }

  async function syncJiraNow() {
    if (jiraSyncing || !selectedProjectId) return;
    setJiraSyncing(true);
    setActionError(null);
    try {
      const connection = await syncJiraConnection();
      setJiraConnection(connection);
      await Promise.all([
        refreshTasks(taskScopeProjectId, { quiet: true }),
        refreshProjectList(),
      ]);
      setAnnouncement(text("Jira 任务已同步", "Jira issues synced"));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setJiraSyncing(false);
    }
  }

  function openCreateProjectDialog() {
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setProjectName("");
    setProjectCreateId(`temp-${window.crypto.randomUUID()}`);
    setProjectCreateDefaults({ profile: null, workspacePath: null });
    setProjectCreateDefaultsOpen(false);
    setActionError(null);
    setProjectCreateOpen(true);
  }

  function closeCreateProjectDialog() {
    if (openingProjectId) return;
    setProjectCreateOpen(false);
    setProjectCreateId(null);
    setProjectCreateDefaultsOpen(false);
    setActionError(null);
  }

  async function createTemporaryProject() {
    if (openingProjectId) return;
    const name = projectName.trim();
    if (!name) return;
    const projectId = projectCreateId;
    if (!projectId) return;
    setOpeningProjectId(projectId);
    setActionError(null);
    try {
      if (host === "paseo") {
        await savePaseoProjectDefaults(projectId, projectCreateDefaults);
      }
      let project: Project;
      try {
        project = await createProjectRequest({
          id: projectId,
          name,
          workspacePath: null,
        });
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
        const nextProjects = await listProjects();
        project = nextProjects.find((candidate) => candidate.id === projectId)
          ?? (() => { throw error; })();
      }
      setProjects((current) => current.some((candidate) => candidate.id === project.id)
        ? current.map((candidate) => candidate.id === project.id ? project : candidate)
        : [...current, project]);
      setProjectCreateOpen(false);
      setProjectCreateId(null);
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  async function openProjectDefaultsDialog(projectId: string) {
    if (host !== "paseo" || projectDefaultsLoading) return;
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setProjectDefaultsLoading(true);
    setActionError(null);
    refreshPaseoAssignmentOptions(projectId);
    try {
      const automation = await requestPaseoAutomation("get", projectId);
      setPaseoAutomations((current) => ({ ...current, [automation.projectId]: automation }));
      setProjectSettingsName(
        projects.find((project) => project.id === projectId)?.name
          ?? projectChoices.find((project) => project.id === projectId)?.name
          ?? "",
      );
      setProjectDefaultsProjectId(projectId);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setProjectDefaultsLoading(false);
    }
  }

  function requestProjectDelete(project: ProjectChoice) {
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setProjectDeleteIssueCount(null);
    setPendingProjectDelete(project);
  }

  function openProjectContextMenu(project: ProjectChoice, x: number, y: number) {
    const actions = projectActionsFor(project);
    if (!actions.canEdit && !actions.canDelete) return;
    const menuWidth = 190;
    if (projectContextMenu?.project.id === project.id) {
      setProjectContextMenu(null);
      return;
    }
    const menuHeight = (Number(actions.canEdit) + 1) * 32 + 12 + (actions.canDelete ? 0 : 40);
    setProjectContextMenu({
      project,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    });
  }

  function closeProjectDeleteDialog() {
    if (deletingProjectId) return;
    setPendingProjectDelete(null);
    setProjectDeleteIssueCount(null);
  }

  async function deletePendingProject() {
    if (!pendingProjectDelete || deletingProjectId) return;
    const project = pendingProjectDelete;
    setDeletingProjectId(project.id);
    setActionError(null);
    try {
      await deleteProjectRequest(project.id);
      setProjects((current) => current.filter((candidate) => candidate.id !== project.id));
      setRecentProjectIds((current) => {
        const next = current.filter((candidate) => candidate !== project.id);
        taskboardStorage.setItem(RECENT_PROJECT_IDS_KEY, JSON.stringify(next));
        return next;
      });
      setProjectCodexIdentities((current) => {
        const next = { ...current };
        delete next[project.id];
        taskboardStorage.setItem(PROJECT_CODEX_IDENTITIES_KEY, JSON.stringify(next));
        return next;
      });
      setPendingProjectDelete(null);
      setProjectDeleteIssueCount(null);
      if (selectedProjectId === project.id) changeProject(GLOBAL_PROJECT_ID);
      setAnnouncement(text(
        `已删除项目“${project.name}”`,
        `Deleted project “${project.name}”`,
      ));
    } catch (error) {
      if (error instanceof ApiError && error.code === "PROJECT_NOT_EMPTY") {
        const details = error.details as { issueCount: number };
        setProjectDeleteIssueCount(details.issueCount);
      } else {
        setPendingProjectDelete(null);
        setActionError(errorMessage(error));
      }
    } finally {
      setDeletingProjectId(null);
    }
  }

  const headerProjectName = isAllProjects
    ? text("所有项目", "All projects")
    : selectedProject?.id === GLOBAL_PROJECT_ID
      ? text("临时任务", "Temporary tasks")
      : selectedProject?.name ?? text("任务面板", "Taskboard");
  const appShellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  return (
    <TaskboardLanguageProvider language={language}>
      <div className={`app-shell${embedded ? " embedded" : ""}`} style={appShellStyle}>
      {taskboardMetadata && taskboardMetadata.mode !== "cloud" && (
        <LocalRealtimeSync
          selectedProjectId={taskScopeProjectId}
          detailTaskId={detailTaskId}
          refreshProjectList={refreshProjectList}
          refreshTasks={refreshTasks}
          refreshProjectBoardDisplaySettings={refreshProjectBoardDisplaySettings}
          setConnection={setConnection}
          setCommentsRevision={setCommentsRevision}
          setAttachmentsRevision={setAttachmentsRevision}
          setReadmeRevision={setReadmeRevision}
        />
      )}
      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-title">
            <div className="workspace-kicker">
              {detailTask && (
                <button
                  className="detail-back-button"
                  type="button"
                  aria-label={text("返回议题看板", "Back to issue board")}
                  title={text("返回议题看板 (Esc)", "Back to issue board (Esc)")}
                  onClick={closeTaskDetail}
                >
                  <LinearIcon name="chevronLeft" />
                </button>
              )}
              {embedded && hostContext?.sidebarCollapsed && (
                <button
                  className="detail-back-button codex-sidebar-expand-button"
                  type="button"
                  aria-label={text("展开 Codex 侧边栏", "Expand Codex sidebar")}
                  title={text("展开侧边栏", "Expand sidebar")}
                  onClick={expandCodexSidebar}
                >
                  <LinearIcon name="codexSidebarExpand" />
                </button>
              )}
              <div className="header-project-switcher" data-project-switcher>
                <button
                  className="header-project-button"
                  type="button"
                  aria-label={text("切换项目", "Switch project")}
                  aria-haspopup="menu"
                  aria-expanded={projectMenuOpen}
                  onClick={() => {
                    setProjectContextMenu(null);
                    setProjectMenuSearch("");
                    setProjectMenuOpen((current) => !current);
                  }}
                >
                  <span className="project-name">{headerProjectName}</span>
                  <TaskboardIcon className="project-switcher-chevron" name="dropdown" />
                </button>
                {projectMenuOpen && (
                  <div className="header-project-menu" role="menu" aria-label={text("项目", "Projects")}>
                    <span>{text("切换项目", "Switch project")}</span>
                    <div className="project-menu-search">
                      <label className="sr-only" htmlFor="project-menu-search-input">
                        {text("按名称筛选项目", "Filter projects by name")}
                      </label>
                      <TaskboardIcon name="search" />
                      <input
                        id="project-menu-search-input"
                        autoFocus
                        type="search"
                        value={projectMenuSearch}
                        onChange={(event) => setProjectMenuSearch(event.target.value)}
                        placeholder={text("筛选项目…", "Filter projects…")}
                      />
                      {projectMenuSearch && (
                        <button
                          className="search-clear"
                          type="button"
                          aria-label={text("清除项目筛选", "Clear project filter")}
                          onClick={() => setProjectMenuSearch("")}
                        >
                          <LinearIcon name="close" />
                        </button>
                      )}
                    </div>
                    <div className="project-menu-list">
                      {!projectMenuNeedle && (
                        <>
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={isAllProjects}
                            disabled={openingProjectId !== null}
                            onClick={() => {
                              if (isAllProjects) setProjectMenuOpen(false);
                              else changeProject(ALL_PROJECTS_ID);
                            }}
                          >
                            <TaskboardIcon className="project-avatar" name="projectFolder" />
                            <span>{text("所有项目", "All projects")}</span>
                            {isAllProjects && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                          </button>
                          <div className="project-menu-divider" role="separator" />
                        </>
                      )}
                      {projectMenuChoices.map((project) => {
                        const actions = projectActionsFor(project);
                        return (
                          <Fragment key={project.id}>
                          {hasProjectsWithIssues && project.id === firstEmptyProjectId && (
                            <div className="project-menu-divider" role="separator" />
                          )}
                          <div className="project-menu-row">
                            <button
                              className="project-menu-select"
                              type="button"
                              role="menuitemradio"
                              aria-checked={project.id === selectedProjectId}
                              disabled={openingProjectId !== null}
                              onContextMenu={(event) => {
                                if (!actions.canEdit && !actions.canDelete) return;
                                event.preventDefault();
                                openProjectContextMenu(project, event.clientX, event.clientY);
                              }}
                              onClick={() => {
                                if (project.id === selectedProjectId) setProjectMenuOpen(false);
                                else void selectProject(project);
                              }}
                            >
                              <TaskboardIcon className="project-avatar" name="projectFolder" />
                              <span title={project.name}>{project.name}</span>
                              {project.id === selectedProjectId && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                            </button>
                            {(actions.canEdit || actions.canDelete) && (
                              <button
                                className="project-menu-more"
                                type="button"
                                role="menuitem"
                                aria-haspopup="menu"
                                aria-expanded={projectContextMenu?.project.id === project.id}
                                aria-label={text(`管理项目“${project.name}”`, `Manage project “${project.name}”`)}
                                title={text("更多", "More")}
                                disabled={openingProjectId !== null}
                                onClick={(event) => {
                                  const rect = event.currentTarget.getBoundingClientRect();
                                  const parentRect = event.currentTarget.closest(".header-project-menu")?.getBoundingClientRect();
                                  const right = (parentRect?.right ?? rect.right) + 6;
                                  const left = (parentRect?.left ?? rect.left) - 196;
                                  const x = right + 190 <= window.innerWidth - 8 || left < 8 ? right : left;
                                  openProjectContextMenu(project, x, rect.top);
                                }}
                              >
                                <MoreIcon color="currentColor" />
                              </button>
                            )}
                          </div>
                          </Fragment>
                        );
                      })}
                      {projectMenuNeedle && projectMenuChoices.length === 0 && (
                        <div className="project-menu-empty">{text("没有匹配项目", "No matching projects")}</div>
                      )}
                    </div>
                    <div className="project-menu-actions">
                      <div className="project-menu-divider" role="separator" />
                      <button
                        type="button"
                        role="menuitem"
                        disabled={openingProjectId !== null}
                        onClick={openJiraDialog}
                      >
                        <RelationIcon className="project-avatar" color="currentColor" size={16} />
                        <span>
                          {jiraConnection?.configured
                            ? text("Jira 设置", "Jira settings")
                            : text("连接 Jira", "Connect Jira")}
                        </span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={openingProjectId !== null}
                        onClick={openCreateProjectDialog}
                      >
                        <PlusIcon className="project-avatar" color="currentColor" size={16} />
                        <span>{text("创建项目", "Create project")}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />

          <div className="header-actions">
            {host === "paseo" && selectedProject && selectedProject.id !== ALL_PROJECTS_ID && (
              <button
                className="icon-button project-settings-trigger"
                type="button"
                disabled={projectDefaultsLoading}
                aria-label={text("项目设置", "Project settings")}
                title={text("项目设置", "Project settings")}
                onClick={() => void openProjectDefaultsDialog(selectedProject.id)}
              >
                <LinearIcon name="displayOptions" />
              </button>
            )}
            {selectedProject && (
              <ProjectAutomationMenu
                automation={host === "paseo" ? selectedPaseoAutomation : selectedProjectAutomation}
                models={host === "paseo" ? undefined : automationModels}
                mode={host === "paseo" ? "paseo" : "codex"}
                pending={host === "paseo"
                  ? paseoAutomationPending
                  : automationPending || automationCatalogLoading}
                error={host === "paseo"
                  ? paseoAutomationError
                  : automationCatalogError ?? automationError}
                unavailableReason={host === "paseo"
                  ? selectedProjectId === ALL_PROJECTS_ID
                    ? text("请选择具体项目", "Select a specific project")
                    : null
                  : automationProjectContext.unavailableReason}
                onOpen={() => {
                  if (host === "paseo") {
                    void refreshPaseoAutomation();
                    refreshPaseoAssignmentOptions(selectedProject.id);
                  }
                  else void reconcileProjectAutomation();
                }}
                onChange={(options) => {
                  if (host === "paseo") {
                    return savePaseoAutomation({
                      enabledByUser: options.enabledByUser,
                      intervalMinutes: options.intervalMinutes,
                      quotaAware: options.quotaAware,
                      ...(Object.hasOwn(options, "workspacePath") ? { workspacePath: options.workspacePath ?? null } : {}),
                      ...(Object.hasOwn(options, "profile") ? { profile: options.profile ?? null } : {}),
                    });
                  } else if (options.model && options.reasoningEffort) {
                    void saveProjectAutomation({
                      enabledByUser: options.enabledByUser,
                      intervalMinutes: options.intervalMinutes,
                      quotaAware: options.quotaAware,
                      model: options.model,
                      reasoningEffort: options.reasoningEffort,
                    });
                  }
                }}
                onSaveDefaults={host === "paseo" ? async (value) => {
                  await savePaseoProjectDefaults(selectedProject.id, value);
                  return true;
                } : undefined}
                paseoDefaults={host === "paseo" ? paseoProjectDefaultsCatalog : undefined}
              />
            )}
            {isJiraProject && (
              <button
                className="icon-button"
                type="button"
                disabled={jiraSyncing}
                onClick={() => void syncJiraNow()}
                aria-label={text("同步 Jira", "Sync Jira")}
                title={text("同步 Jira", "Sync Jira")}
              >
                <RefreshIcon color="currentColor" />
              </button>
            )}
            {selectedProjectId && !isJiraProject && (
              <button
                className="icon-button header-create-button"
                type="button"
                onClick={() => setEditor({ status: "todo" })}
                aria-label={text("新建议题", "Create issue")}
                title={text("新建议题 (C)", "Create issue (C)")}
              >
                <PlusIcon color="currentColor" size={14} />
              </button>
            )}
          </div>
        </header>

        {selectedProjectId && !detailTask && <div className="board-toolbar">
          <div className="view-tabs" aria-label={text("看板视图", "Board views")}>
            <button
              className={`view-tab${boardView === "dashboard" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "dashboard"}
              onClick={() => selectBoardView("dashboard")}
            >
              {text("仪表盘", "Dashboard")}
            </button>
            <button
              className={`view-tab${boardView === "issues" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "issues"}
              onClick={() => selectBoardView("issues")}
            >
              {text("议题看板", "Issue board")}
            </button>
            <button
              className={`view-tab${boardView === "list" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "list"}
              onClick={() => selectBoardView("list")}
            >
              {text("列表视图", "List")}
            </button>
            <button
              className={`view-tab${boardView === "gantt" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "gantt"}
              onClick={() => selectBoardView("gantt")}
            >
              {text("甘特图", "Gantt")}
            </button>
            {!isAllProjects && (
              <button
                className={`view-tab${boardView === "readme" ? " active" : ""}`}
                type="button"
                aria-pressed={boardView === "readme"}
                onClick={() => selectBoardView("readme")}
              >
                {text(host === "paseo" ? "项目说明" : "项目文档", host === "paseo" ? "Project Instructions" : "Project Docs")}
              </button>
            )}
          </div>
          {(boardView === "issues" || boardView === "list" || boardView === "gantt") && <div className="toolbar-tools">
            <div className={`search-field${search ? " has-value" : ""}`} title={text("搜索议题 (/)", "Search issues (/)")}>
              <TaskboardIcon className="search-icon" name="search" />
              <input
                id="task-search"
                type="search"
                aria-label={text("搜索议题", "Search issues")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={text("搜索议题…", "Search issues…")}
              />
              {!search && <kbd>/</kbd>}
              {search && (
                <button
                  className="search-clear"
                  type="button"
                  aria-label={text("清除搜索", "Clear search")}
                  onClick={() => {
                    setSearch("");
                    document.getElementById("task-search")?.focus();
                  }}
                >
                  <LinearIcon name="close" />
                </button>
              )}
            </div>
            {boardView === "gantt" && (
              <div className="gantt-toolbar-controls">
                <label className="gantt-hide-completed">
                  <input type="checkbox" checked={ganttHideCompleted} onChange={(event) => setGanttHideCompleted(event.target.checked)} />
                  <i><LinearIcon name="check" /></i>
                  <span>{text("隐藏已完成", "Hide completed")}</span>
                </label>
                <button type="button" className="gantt-today-button" onClick={() => setGanttTodayRequest((current) => current + 1)}>{text("今天", "Today")}</button>
                <div className="gantt-view-menu-wrap">
                  <button type="button" className="gantt-view-menu-trigger" aria-label={text("时间轴视图选项", "Timeline view options")} aria-expanded={ganttViewMenuOpen} onClick={() => setGanttViewMenuOpen((current) => !current)}>
                    <MoreIcon color="currentColor" />
                  </button>
                  {ganttViewMenuOpen && (
                    <div className="gantt-view-menu" role="menu">
                      {GANTT_ZOOM_OPTIONS.map((value) => (
                        <button type="button" role="menuitemradio" aria-checked={ganttZoom === value} className={ganttZoom === value ? "active" : ""} onClick={() => { setGanttZoom(value); setGanttViewMenuOpen(false); }} key={value}>
                          <span>{language === "zh"
                            ? { day: "日视图", week: "周视图", month: "月视图" }[value]
                            : { day: "Day", week: "Week", month: "Month" }[value]}</span>
                          {ganttZoom === value && <LinearIcon name="check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <TaskFilterMenu
              tasks={tasks}
              search={search}
              labels={availableLabels}
              filters={filters}
              onChange={setFilters}
            />
            {boardView === "issues" && (isAllProjects || selectedProject) && (
              <BoardCardDisplayMenu
                settings={boardDisplaySettings}
                onChange={updateProjectBoardDisplaySettings}
                onReset={resetProjectBoardDisplaySettings}
              />
            )}
          </div>}
        </div>}

        {(loadError || actionErrorText) && (
          <div className="error-banner" role="alert">
            <span className="error-mark" aria-hidden="true"><LinearIcon name="alert" /></span>
            <div><strong>{text("任务面板需要处理", "Taskboard needs attention")}</strong><p>{actionErrorText ?? loadError?.message}</p></div>
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                if (loadError?.source === "projects") {
                  if (loadError.operation === "initial") void loadProjectList();
                  else void refreshProjectList();
                } else if (taskScopeProjectId) void refreshTasks(taskScopeProjectId);
                else void loadProjectList();
              }}
            >
              {text("重试", "Try again")}
            </button>
          </div>
        )}

        {detailTask && selectedProject ? (
          <TaskDetail
            key={detailTask.id}
            task={detailTask}
            tasks={tasks.filter((task) => task.projectId === detailTask.projectId)}
            referenceTasks={referenceTasks.filter((task) => task.projectId === detailTask.projectId)}
            currentUser={currentUser}
            availableLabels={availableLabels}
            developmentScan={developmentScan}
            developmentScanLoading={developmentScanLoading}
            commentsRevision={commentsRevision}
            attachmentsRevision={attachmentsRevision}
            onCreateLabel={persistProjectLabel}
            onDeleteLabel={removeProjectLabel}
            onUpdate={(current, changes) => updateTaskProperties(current, changes)}
            onOpenTask={openTaskDetail}
            onAddRelation={(current, type, relatedTaskId, origin) => (
              mutateTaskRelation("add", current, type, relatedTaskId, origin)
            )}
            onRemoveRelation={(current, type, relatedTaskId, origin) => (
              mutateTaskRelation("remove", current, type, relatedTaskId, origin)
            )}
            onOpenThread={openThread}
            onOpenLegacyLocalThread={openLegacyLocalThread}
            onOpenInThread={openTaskInThread}
            onCopy={(text, message) => void copyText(text, message)}
            onCopyIssueLink={(projectId, identifier, message) => void copyIssueLink(projectId, identifier, message)}
            openingThread={openingThreadTaskId === detailTask.id}
            onError={setActionError}
            paseoAssignment={host === "paseo" ? paseoAssignments[detailTask.id] ?? null : null}
            paseoPresentation={host === "paseo" ? paseoAgentPresentations[detailTask.id] ?? null : null}
            onOpenPaseoAgent={host === "paseo" ? (agentId) => {
              postEmbeddedHostMessage({
                type: "taskboard:open-paseo-agent",
                payload: { agentId },
              });
            } : undefined}
            paseoAssignee={host === "paseo" ? {
              options: paseoAssigneeChoices.options,
              value: paseoAssignmentValue(detailTask),
              loading: paseoAssignmentOptionsLoading,
              error: paseoAssignmentOptionsError,
              onRefresh: () => refreshPaseoAssignmentOptions(detailTask.projectId),
              onChange: (choiceId) => {
                const currentAssignment = paseoAssignments[detailTask.id];
                const choice = paseoAssigneeChoices.choices.get(choiceId);
                if (choice?.kind === "planned") {
                  openPaseoExecutionDialog(detailTask, choiceId);
                  return;
                }
                void changePaseoTaskAssignment(
                  detailTask,
                  choiceId,
                  currentAssignment?.kind === "planned" ? currentAssignment.workspacePath : undefined,
                );
              },
            } : undefined}
            paseoExecutionConfig={host === "paseo" && paseoAssignments[detailTask.id]?.kind !== "existing" ? {
              onOpen: () => openPaseoExecutionDialog(detailTask),
            } : undefined}
            paseoProjectDefaults={host === "paseo" ? {
              profile: paseoAutomations[detailTask.projectId]?.profile ?? null,
              workspacePath: paseoAutomations[detailTask.projectId]?.workspacePath ?? null,
            } : undefined}
            paseoConfiguration={host === "paseo" ? (() => {
              const assignment = paseoAssignments[detailTask.id];
              const target = configurationTargetForAssignment(assignment);
              if (!target) return undefined;
              return {
                target,
                loadOptions: loadPaseoConfigurationOptions,
                ...(assignment?.kind === "planned" ? {
                  onSave: async (selection: PaseoConfigurationSelection) => {
                    const choiceId = paseoAssignmentValue(detailTask);
                    if (!choiceId.startsWith("paseo:profile:") && !choiceId.startsWith("paseo:model:")) {
                      throw new Error("当前 Agent 计划已不在可用目录中，请重新选择负责人。");
                    }
                    await changePaseoTaskAssignment(
                      detailTask,
                      choiceId,
                      assignment.workspacePath,
                      selection,
                      true,
                    );
                  },
                } : {}),
              };
            })() : undefined}
            paseoWorktree={host === "paseo" ? {
              workspaces: (paseoAssignmentOptions?.workspaces ?? []).flatMap((workspace) => (
                workspace.path ? [{ ...workspace, path: workspace.path }] : []
              )),
              onRefresh: () => refreshPaseoAssignmentOptions(detailTask.projectId),
              onCreated: async (result) => {
                const assignment = paseoAssignments[detailTask.id];
                if (assignment?.kind !== "planned") return;
                await changePaseoTaskAssignment(
                  detailTask,
                  paseoAssignmentValue(detailTask),
                  result.workspace.path,
                  undefined,
                  true,
                  true,
                  { kind: "planned", profile: assignment.profile },
                );
              },
            } : undefined}
          />
        ) : boardView !== "readme"
          && hasLoadedTasks
          && tasks.length === 0
          && selectedProject
          && aiImportReadyProjectId === selectedProject.id ? (
          <div className="page-empty">
            <h2>{text("当前项目还没有任务", "This project has no issues yet")}</h2>
            <p>{text(
              "让 Codex 检查当前项目目录对应的对话，并整理任务状态。",
              "Ask Codex to inspect conversations for this project directory and organize their task status.",
            )}</p>
            <div className="page-empty-actions">
              <button
                className="button primary"
                type="button"
                onClick={() => {
                  aiOpenThreadRequestSequenceRef.current += 1;
                  setAiOpenThreadRequest({
                    projectId: selectedProject.id,
                    issueId: null,
                    composerText: text(
                      "只检查当前项目目录对应的 Codex 对话。请将其中已完成、处理中和待执行的任务整理并导入当前项目的 Taskboard。",
                      "Only inspect Codex conversations associated with this project directory. Organize completed, in-progress, and pending tasks, then import them into this project's Taskboard.",
                    ),
                    requestId: aiOpenThreadRequestSequenceRef.current,
                  });
                }}
              >
                {text("导入当前项目任务状态", "Import current project task status")}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => setEditor({ status: "todo" })}
              >
                {text("添加议题", "Add issue")}
              </button>
            </div>
          </div>
        ) : boardView === "readme" && selectedProject ? (
          <ProjectReadmeView
            key={selectedProjectId}
            project={selectedProject}
            paseoMode={host === "paseo"}
            tasks={tasks.filter((task) => task.projectId === selectedProject.id)}
            referenceTasks={referenceTasks.filter((task) => task.projectId === selectedProject.id)}
            revision={readmeRevision}
            onOpenTask={openTaskDetail}
            onError={setActionError}
          />
        ) : boardView === "dashboard" && (selectedProject || isAllProjects) ? (
          <DashboardView
            key={selectedProjectId}
            projectId={selectedProjectId}
            projectCreatedAt={selectedProject?.createdAt ?? null}
            isAllProjects={isAllProjects}
            tasks={tasks}
            presentations={taskPresentations}
            currentUser={currentUser}
            animateSummary={dashboardSummaryAnimatedProjectId !== selectedProjectId}
            onSummaryAnimationStart={markDashboardSummaryAnimationStarted}
            onOpenTask={openTaskDetail}
            onOpenConversation={openTaskConversation}
          />
        ) : boardView === "list" ? (
          <IssueListView
            scrollRef={issueListRef}
            tasks={filteredTasks}
            presentations={taskPresentations}
            currentUser={currentUser}
            hasActiveFilters={hasActiveTaskFilters}
            onOpenTask={openTaskDetail}
            onOpenConversation={openTaskConversation}
            onUpdate={updateTaskProperties}
          />
        ) : boardView === "gantt" ? (
          <Suspense fallback={<div className="board-view-loading">{text("正在打开甘特图…", "Opening Gantt…")}</div>}>
            <GanttView
              tasks={filteredTasks}
              presentations={taskPresentations}
              hasActiveFilters={hasActiveTaskFilters}
              zoom={ganttZoom}
              hideCompleted={ganttHideCompleted}
              todayRequest={ganttTodayRequest}
              onOpenTask={openTaskDetail}
              onUpdate={updateTaskProperties}
            />
          </Suspense>
        ) : (
          <div
            className={`issue-board-layout${otherTasksAvailable && otherTasksOpen ? " has-other-tasks" : ""}${emptyMainBoard ? " is-empty-main-board" : ""}`}
            data-main-columns={mainBoardItems.length}
            style={{
              "--main-column-count": mainColumnCount,
              "--main-board-min-width": `${mainBoardMinWidth}px`,
              "--main-board-max-width": `${mainBoardMaxWidth}px`,
              "--other-tasks-width": otherTasksWidth,
            } as CSSProperties}
          >
            {tasksLoading && !hasLoadedTasks ? (
              <div className="loading-board" aria-label={text("正在加载议题", "Loading issues")} aria-busy="true">
                {mainBoardItems.map((item) => (
                  <div className="loading-column" key={item}>
                    <span /><div /><div />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div ref={boardScrollRef} className="board-scroll" aria-label={text("议题看板", "Issue board")}>
                  <div className="board-context-summary" aria-live="polite">
                    <div className="board-context-primary">
                      <strong>{boardScopeLabel}</strong>
                      <span>{text(`未归档议题 ${tasks.length} 个，主看板显示 ${mainBoardTaskCount} 个。`, `${tasks.length} unarchived issues; ${mainBoardTaskCount} shown on the main board.`)}</span>
                    </div>
                    {otherTasksAvailable && (
                      <div className="board-context-terminal-actions" aria-label={text("终态任务入口", "Terminal issue shortcuts")}>
                        {otherTaskTabs.includes("done") && (
                          <button
                            type="button"
                            className={`board-terminal-chip status-done${otherTasksOpen && otherTasksTab === "done" ? " is-active" : ""}`}
                            aria-controls="other-tasks-panel"
                            aria-pressed={otherTasksOpen && otherTasksTab === "done"}
                            onClick={() => toggleOtherTasks("done")}
                          >
                            <span>{text("已完成", "Done")}</span><b>{doneTaskCount}</b>
                          </button>
                        )}
                        {otherTaskTabs.includes("canceled") && (
                          <button
                            type="button"
                            className={`board-terminal-chip status-canceled${otherTasksOpen && otherTasksTab === "canceled" ? " is-active" : ""}`}
                            aria-controls="other-tasks-panel"
                            aria-pressed={otherTasksOpen && otherTasksTab === "canceled"}
                            onClick={() => toggleOtherTasks("canceled")}
                          >
                            <span>{text("已取消", "Canceled")}</span><b>{canceledTaskCount}</b>
                          </button>
                        )}
                        {otherTaskTabs.includes("archived") && (
                          <button
                            type="button"
                            className={`board-terminal-chip status-archived${otherTasksOpen && otherTasksTab === "archived" ? " is-active" : ""}`}
                            aria-controls="other-tasks-panel"
                            aria-pressed={otherTasksOpen && otherTasksTab === "archived"}
                            onClick={() => toggleOtherTasks("archived")}
                          >
                            <span>{text("已归档", "Archived")}</span><b>{archivedTaskCount}</b>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="board">
                    {mainBoardItems.map((item) => item === "archived" ? (
                      <ArchivedTasksColumn
                        key={item}
                        tasks={filteredArchivedTasks}
                        hasActiveFilters={hasActiveTaskFilters}
                        restoringTaskId={restoringTaskId}
                        deletingTaskId={deletingArchivedTaskId}
                        onRestore={(task) => void restoreArchivedTask(task)}
                        onDelete={setPendingArchivedTaskDelete}
                      />
                    ) : (
                      <BoardColumn
                        key={item}
                        scrollRef={(element) => {
                          boardColumnScrollRefs.current[item] = element;
                        }}
                        status={item}
                        label={mainColumnLabel(item)}
                        tasks={mainColumnTasks(item)}
                        presentations={taskPresentations}
                        emptyMessage={mainColumnEmptyMessage(item)}
                        isDropTarget={dropTarget === item}
                        draggedTaskId={draggedTaskId}
                        draggedTaskIds={draggedTaskIds}
                        draggedTaskHeight={draggedTaskHeight}
                        movingTaskId={movingTaskId}
                        batchMovingTaskIds={batchMovingTaskIds}
                        settlingTaskId={settlingTaskId}
                        contextMenuTaskId={contextMenu?.taskId ?? null}
                        availableLabels={availableLabels}
                        projectNames={isAllProjects ? projectNames : undefined}
                        currentUser={currentUser}
                        showCover={boardDisplaySettings.cover}
                        showBody={boardDisplaySettings.body}
                        createEnabled={!isJiraProject}
                        onCreateLabel={persistProjectLabel}
                        onCreate={(initialStatus) => setEditor({ status: initialStatus })}
                        onEdit={openTaskDetail}
                        onUpdate={updateTaskProperties}
                        onComplete={(task) => moveTask(task, "done")}
                        onContextMenu={openTaskContextMenu}
                        onDragStart={startTaskDrag}
                        onDragEnd={endTaskDrag}
                        onDragEnter={setDropTarget}
                        onDrop={finishTaskDrop}
                        onOpenConversation={openTaskConversation}
                        ideaSelection={host === "paseo" && (item === "todo" || item === "backlog") ? {
                          active: ideaSelectionMode,
                          selectedIds: selectedIdeaIds,
                          canSelect: canSelectMergeIdea,
                          onToggleMode: () => {
                            setIdeaSelectionMode((current) => !current);
                            setSelectedIdeaIds(new Set());
                          },
                          onToggleTask: toggleMergeIdea,
                          onMerge: openMergeIdeasEditor,
                          onDelete: openSelectedTaskDeleteConfirmation,
                          moving: batchMoveInFlightRef.current || deletingArchivedTaskId !== null,
                        } : undefined}
                      />
                    ))}
                  </div>
                </div>
                {otherTasksAvailable && otherTasksMounted && (
                  <OtherTasksPanel
                    open={otherTasksVisible}
                    activeTab={otherTasksTab}
                    tabs={otherTaskTabs}
                    tasksByStatus={tasksByStatus}
                    archivedTasks={filteredArchivedTasks}
                    presentations={taskPresentations}
                    hasActiveFilters={hasActiveTaskFilters}
                    isDropTarget={otherTasksTab !== "archived" && dropTarget === otherTasksTab}
                    draggedTaskId={draggedTaskId}
                    draggedTaskIds={draggedTaskIds}
                    draggedTaskHeight={draggedTaskHeight}
                    movingTaskId={movingTaskId}
                    batchMovingTaskIds={batchMovingTaskIds}
                    settlingTaskId={settlingTaskId}
                    contextMenuTaskId={contextMenu?.taskId ?? null}
                    availableLabels={availableLabels}
                    projectNames={isAllProjects ? projectNames : undefined}
                    currentUser={currentUser}
                    showCover={boardDisplaySettings.cover}
                    showBody={boardDisplaySettings.body}
                    onCreateLabel={persistProjectLabel}
                    restoringTaskId={restoringTaskId}
                    deletingTaskId={deletingArchivedTaskId}
                    onClose={() => setOtherTasksOpen(false)}
                    onTabChange={setOtherTasksTab}
                    onCreate={isJiraProject
                      ? undefined
                      : (initialStatus) => setEditor({ status: initialStatus })}
                    onRestore={(task) => void restoreArchivedTask(task)}
                    onDelete={setPendingArchivedTaskDelete}
                    onEdit={openTaskDetail}
                    onUpdate={updateTaskProperties}
                    onContextMenu={openTaskContextMenu}
                    onDragStart={startTaskDrag}
                    onDragEnd={endTaskDrag}
                    onDragEnter={setDropTarget}
                    onDrop={finishTaskDrop}
                    onOpenConversation={openTaskConversation}
                  />
                )}
              </>
            )}
          </div>
        )}
      </main>

      {projectContextMenu && (
        <div
          className="task-context-menu project-context-menu"
          data-project-context-menu
          role="menu"
          aria-label={text(
            `项目“${projectContextMenu.project.name}”`,
            `Project “${projectContextMenu.project.name}”`,
          )}
          style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
        >
          {projectContextActions?.canEdit && (
            <button
              className="context-menu-item"
              type="button"
              role="menuitem"
              disabled={projectDefaultsLoading}
              onClick={() => void openProjectDefaultsDialog(projectContextMenu.project.id)}
            >
              <span className="context-menu-icon" aria-hidden="true"><LinearIcon name="displayOptions" /></span>
              <span className="context-menu-label">{text("编辑项目", "Edit project")}</span>
            </button>
          )}
          {projectContextActions && (
            <button
              className="context-menu-item is-danger"
              type="button"
              role="menuitem"
              disabled={!projectContextActions.canDelete}
              onClick={() => requestProjectDelete(projectContextMenu.project)}
            >
              <span className="context-menu-icon" aria-hidden="true"><DeleteIcon color="currentColor" /></span>
              <span className="context-menu-label">{text("删除项目", "Delete project")}</span>
            </button>
          )}
          {projectContextActions && !projectContextActions.canDelete && (
            <p className="project-context-menu-note">{projectContextMenu.project.id === GLOBAL_PROJECT_ID
              ? text("系统默认项目，不能删除。", "The default system project cannot be deleted.")
              : text("此项目由系统管理，不能删除。", "This project is managed by the system and cannot be deleted.")}</p>
          )}
        </div>
      )}

      {jiraDialogOpen && (
        <JiraConnectionDialog
          connection={jiraConnection}
          saving={jiraSaving}
          error={jiraError}
          onClose={() => {
            if (!jiraSaving) setJiraDialogOpen(false);
          }}
          onSave={saveJiraConnection}
        />
      )}

      {projectCreateOpen && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeCreateProjectDialog();
          }}
        >
          <form
            className="delete-dialog project-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-create-title"
            onSubmit={(event) => {
              event.preventDefault();
              void createTemporaryProject();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeCreateProjectDialog();
            }}
          >
            <h2 id="project-create-title">{text("创建项目", "Create project")}</h2>
            <label>
              <span>{text("项目名称", "Project name")}</span>
              <input
                autoFocus
                maxLength={120}
                required
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </label>
            {host === "paseo" && (
              <div className="project-create-defaults">
                <div>
                  <strong>{text("默认执行配置", "Default execution settings")}</strong>
                  <span>{[
                    projectCreateDefaults.profile?.name ?? text("未指定 Agent", "No Agent"),
                    projectCreateDefaults.profile?.thinkingOptionId
                      ? `Thinking ${projectCreateDefaults.profile.thinkingOptionId}`
                      : null,
                    projectCreateDefaults.profile?.modeId
                      ? `Mode ${projectCreateDefaults.profile.modeId}`
                      : null,
                    projectCreateDefaults.workspacePath
                      ? projectCreateDefaults.workspacePath.split(/[\\/]/).filter(Boolean).at(-1)
                      : text("未指定目录", "No directory"),
                  ].filter(Boolean).join(" · ")}</span>
                </div>
                <button
                  type="button"
                  disabled={openingProjectId !== null}
                  onClick={() => {
                    if (projectCreateId) refreshPaseoAssignmentOptions(projectCreateId);
                    setProjectCreateDefaultsOpen(true);
                  }}
                >
                  {text("配置", "Configure")}
                </button>
              </div>
            )}
            {actionErrorText && <p className="project-dialog-error">{actionErrorText}</p>}
            <div className="project-create-actions">
              <button
                className="button secondary"
                type="button"
                disabled={openingProjectId !== null}
                onClick={closeCreateProjectDialog}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={!projectName.trim() || openingProjectId !== null}
              >
                {openingProjectId
                  ? text("创建中…", "Creating…")
                  : text("创建", "Create")}
              </button>
            </div>
          </form>
        </div>
      )}

      {projectCreateDefaultsOpen && host === "paseo" && (
        <PaseoProjectDefaultsDialog
          key={`create:${projectCreateId ?? "new"}`}
          title={text("项目默认执行配置", "Project default execution settings")}
          description={text(
            "可全部留空。手动开始和自动认领都会使用这里的当前配置。",
            "Everything is optional. Manual start and auto-claim use the current settings here.",
          )}
          value={projectCreateDefaults}
          catalog={paseoProjectDefaultsCatalog}
          onClose={() => setProjectCreateDefaultsOpen(false)}
          onSave={(value) => {
            setProjectCreateDefaults(value);
            return true;
          }}
        />
      )}

      {projectDefaultsProjectId && host === "paseo" && (
        <PaseoProjectDefaultsDialog
          key={`settings:${projectDefaultsProjectId}`}
          title={text("项目设置", "Project settings")}
          description={text(
            "修改项目名称、默认 Agent 和代码目录；任务自己的执行配置优先。",
            "Edit the project name, default Agent, and code directory; task-level settings take priority.",
          )}
          projectName={projectSettingsProject ? projectSettingsName : undefined}
          onProjectNameChange={projectSettingsProject ? setProjectSettingsName : undefined}
          value={{
            profile: paseoAutomations[projectDefaultsProjectId]?.profile ?? null,
            workspacePath: paseoAutomations[projectDefaultsProjectId]?.workspacePath ?? null,
          }}
          catalog={paseoProjectDefaultsCatalog}
          onClose={() => setProjectDefaultsProjectId(null)}
          onSave={async (value) => {
            const name = projectSettingsName.trim();
            if (projectSettingsProject && !name) {
              throw new Error(text("请输入项目名称。", "Enter a project name."));
            }
            if (projectSettingsProject && name !== projectSettingsProject.name) {
              const updated = await updateProjectName(projectSettingsProject.id, name);
              setProjects((current) => current.map((project) => (
                project.id === updated.id ? updated : project
              )));
            }
            await savePaseoProjectDefaults(projectDefaultsProjectId, value);
            return true;
          }}
          onDelete={projectSettingsCanDelete && projectSettingsChoice
            ? () => {
                setProjectDefaultsProjectId(null);
                requestProjectDelete(projectSettingsChoice);
              }
            : undefined}
        />
      )}

      {pendingProjectDelete && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeProjectDeleteDialog();
          }}
        >
          <div
            className="delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="project-delete-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeProjectDeleteDialog();
            }}
          >
            {projectDeleteIssueCount === null ? (
              <>
                <h2 id="project-delete-title">{text(
                  `删除项目“${pendingProjectDelete.name}”？`,
                  `Delete project “${pendingProjectDelete.name}”?`,
                )}</h2>
                <p>{text(
                  "仅空项目可以删除。删除后无法恢复。",
                  "Only empty projects can be deleted. This cannot be undone.",
                )}</p>
                <div>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={deletingProjectId !== null}
                    onClick={closeProjectDeleteDialog}
                  >
                    {text("取消", "Cancel")}
                  </button>
                  <button
                    className="button danger"
                    type="button"
                    disabled={deletingProjectId !== null}
                    onClick={() => void deletePendingProject()}
                  >
                    {deletingProjectId
                      ? text("删除中…", "Deleting…")
                      : text("删除项目", "Delete project")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="project-delete-title">{text(
                  `无法删除项目“${pendingProjectDelete.name}”`,
                  `Cannot delete project “${pendingProjectDelete.name}”`,
                )}</h2>
                <p>{text(
                  `该项目还有 ${projectDeleteIssueCount} 个议题（包含已归档议题）。请先移动或删除这些议题。`,
                  `This project still has ${projectDeleteIssueCount} issues, including archived issues. Move or delete them first.`,
                )}</p>
                <div>
                  <button className="button primary" type="button" onClick={closeProjectDeleteDialog}>
                    {text("知道了", "Got it")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {pendingArchivedTaskDelete && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deletingArchivedTaskId) {
              setPendingArchivedTaskDelete(null);
            }
          }}
        >
          <div
            className="delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="archived-task-delete-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !deletingArchivedTaskId) {
                setPendingArchivedTaskDelete(null);
              }
            }}
          >
            <h2 id="archived-task-delete-title">{text(
              `永久删除 ${pendingArchivedTaskDelete.identifier}？`,
              `Permanently delete ${pendingArchivedTaskDelete.identifier}?`,
            )}</h2>
            <p>{pendingArchivedTaskDelete.archivedAt ? text(
              `“${pendingArchivedTaskDelete.title}”及其评论和附件将被永久删除，此操作无法撤销。`,
              `“${pendingArchivedTaskDelete.title}” and its comments and attachments will be permanently deleted. This cannot be undone.`,
            ) : text(
              `“${pendingArchivedTaskDelete.title}”将先归档，再永久删除其评论和附件；此操作无法撤销。`,
              `“${pendingArchivedTaskDelete.title}” will be archived first, then its comments and attachments will be permanently deleted. This cannot be undone.`,
            )}</p>
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={deletingArchivedTaskId !== null}
                onClick={() => setPendingArchivedTaskDelete(null)}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="button danger"
                type="button"
                disabled={deletingArchivedTaskId !== null}
                onClick={() => void deletePendingArchivedTask()}
              >
                {deletingArchivedTaskId
                  ? text("删除中…", "Deleting…")
                  : text("永久删除", "Delete permanently")}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingSelectedTaskDelete && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deletingArchivedTaskId) {
              setPendingSelectedTaskDelete(null);
            }
          }}
        >
          <div
            className="delete-dialog batch-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="selected-task-delete-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !deletingArchivedTaskId) setPendingSelectedTaskDelete(null);
            }}
          >
            <h2 id="selected-task-delete-title">{text(
              `永久删除 ${pendingSelectedTaskDelete.length} 项任务？`,
              `Permanently delete ${pendingSelectedTaskDelete.length} tasks?`,
            )}</h2>
            <p>{text(
              "以下任务、评论和附件将被永久删除，无法撤销。请确认任务列表没有变化。",
              "The following tasks, comments, and attachments will be permanently deleted and cannot be undone. Confirm that the list has not changed.",
            )}</p>
            <ul className="batch-delete-list">
              {pendingSelectedTaskDelete.map((task) => (
                <li key={task.id}>
                  <strong>{task.externalKey ?? task.identifier}</strong>
                  <span>{task.title}</span>
                </li>
              ))}
            </ul>
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={deletingArchivedTaskId !== null}
                onClick={() => setPendingSelectedTaskDelete(null)}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="button danger"
                type="button"
                disabled={deletingArchivedTaskId !== null}
                onClick={() => void deleteSelectedTasks()}
              >
                {deletingArchivedTaskId
                  ? text("删除中…", "Deleting…")
                  : text("永久删除", "Delete permanently")}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingTaskProjectMove && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeTaskProjectMove();
          }}
        >
          <form
            className="delete-dialog move-task-project-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="move-task-project-title"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmTaskProjectMove();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeTaskProjectMove();
            }}
          >
            <h2 id="move-task-project-title">{text(
              `移动 ${pendingTaskProjectMove.task.externalKey ?? pendingTaskProjectMove.task.identifier} 到其他项目`,
              `Move ${pendingTaskProjectMove.task.externalKey ?? pendingTaskProjectMove.task.identifier} to another project`,
            )}</h2>
            <p>{text(
              "保留议题内容和已设执行配置；未单独配置的想法改用目标项目默认值。移动本身不会启动 Agent。",
              "Keep the issue content and explicit execution settings; unset fields inherit the destination project's defaults. Moving does not start an Agent.",
            )}</p>
            <label className="move-task-project-search">
              <span className="sr-only">{text("搜索目标项目", "Search target projects")}</span>
              <TaskboardIcon name="search" />
              <input
                autoFocus
                type="search"
                value={taskProjectMoveSearch}
                placeholder={text("搜索项目…", "Search projects…")}
                disabled={movingTaskProject}
                onChange={(event) => setTaskProjectMoveSearch(event.target.value)}
              />
            </label>
            <div className="move-task-project-list" role="radiogroup" aria-label={text("目标项目", "Target project")}>
              {taskProjectMoveTargets.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="radio"
                  aria-checked={pendingTaskProjectMove.targetProjectId === project.id}
                  className={pendingTaskProjectMove.targetProjectId === project.id ? "is-selected" : ""}
                  disabled={movingTaskProject}
                  onClick={() => {
                    setPendingTaskProjectMove((current) => current
                      ? { ...current, targetProjectId: project.id }
                      : current);
                    setTaskProjectMoveError(null);
                  }}
                >
                  <TaskboardIcon name="projectFolder" />
                  <span title={project.name}>{project.name}</span>
                  {pendingTaskProjectMove.targetProjectId === project.id && <LinearIcon name="check" />}
                </button>
              ))}
              {taskProjectMoveTargets.length === 0 && (
                <p className="move-task-project-empty">{taskProjectMoveNeedle
                  ? text("没有匹配的本地项目。", "No matching local projects.")
                  : text("没有其他可移动到的本地项目。", "No other local projects are available.")}</p>
              )}
            </div>
            {taskProjectMoveError && <p className="project-dialog-error" role="alert">{taskProjectMoveError}</p>}
            <div className="move-task-project-actions">
              <button className="button secondary" type="button" disabled={movingTaskProject} onClick={closeTaskProjectMove}>
                {text("取消", "Cancel")}
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={!pendingTaskProjectMove.targetProjectId || movingTaskProject}
              >
                {movingTaskProject ? text("移动中…", "Moving…") : text("确认移动", "Move issue")}
              </button>
            </div>
          </form>
        </div>
      )}

      {editor && (
        <TaskEditor
          key={`new-${selectedProjectId}-${editor.status}-${editor.mergeRequestId ?? "single"}`}
          projectId={editorProjectId}
          projectOptions={isAllProjects ? createTargetProjects : undefined}
          onProjectChange={(projectId) => setEditor((current) => (
            current ? { ...current, projectId } : current
          ))}
          tasks={tasks.filter((task) => task.projectId === editorProjectId)}
          referenceTasks={referenceTasks.filter((task) => task.projectId === editorProjectId)}
          initialStatus={editor.status}
          initialDraft={editor.mergeSources || newTaskDraft?.projectId !== selectedProjectId
            ? null
            : newTaskDraft.draft}
          labels={projects.find((project) => project.id === editorProjectId)?.labels ?? []}
          currentUser={currentUser}
          developmentScan={developmentScan}
          developmentScanLoading={developmentScanLoading}
          paseoAssignee={host === "paseo" ? {
            options: editor.mergeSources
              ? paseoAssigneeChoices.options.filter((option) => option.group === "profile" || option.group === "provider")
              : paseoAssigneeChoices.options,
            loading: paseoAssignmentOptionsLoading,
            error: paseoAssignmentOptionsError,
            onRefresh: refreshPaseoAssignmentOptions,
          } : undefined}
          paseoConfiguration={host === "paseo" ? {
            loadOptions: loadPaseoConfigurationOptions,
            onOpenAgent: (agentId) => {
              postEmbeddedHostMessage({
                type: "taskboard:open-paseo-agent",
                payload: { agentId },
              });
            },
          } : undefined}
          paseoWorkspaces={host === "paseo"
            ? (paseoAssignmentOptions?.workspaces ?? []).flatMap((workspace) => workspace.path ? [{ ...workspace, path: workspace.path }] : [])
            : undefined}
          paseoWorktree={host === "paseo" ? { onCreated: () => {} } : undefined}
          mergeSources={editorMergeSources}
          mergeStartAfterSave={editor.mergeStartAfterSave === true}
          onCreateLabel={(label) => persistProjectLabel(label, editorProjectId ?? selectedProjectId)}
          onCancel={(draft) => {
            setNewTaskDraft(editor.mergeSources
              ? null
              : draft ? {
                  projectId: selectedProjectId,
                  targetProjectId: editorProjectId,
                  draft,
                } : null);
            setEditor(null);
          }}
          onSave={editor.mergeSources ? saveMergeIdeasDraft : saveEditor}
        />
      )}

      {paseoExecutionDialog && (
        <PaseoExecutionConfigDialog
          taskIdentifier={paseoExecutionDialog.taskIdentifier}
          options={[
            ...(paseoExecutionDialog.initialProfile
              && paseoExecutionDialog.initialChoiceId === PASEO_SAVED_TASK_PLAN_ID ? [{
                id: PASEO_SAVED_TASK_PLAN_ID,
                label: paseoExecutionDialog.initialProfile.name,
                detail: "当前已保存的执行计划",
                group: "profile" as const,
                provider: paseoExecutionDialog.initialProfile.provider,
                model: paseoExecutionDialog.initialProfile.model,
                modeId: paseoExecutionDialog.initialProfile.modeId,
                thinkingOptionId: paseoExecutionDialog.initialProfile.thinkingOptionId,
              }] : []),
            ...paseoAssigneeChoices.options.filter((option) => (
              option.id === "paseo:project-default"
              || option.group === "profile"
              || option.group === "provider"
            )),
          ]}
          workspaces={(paseoAssignmentOptions?.workspaces ?? []).flatMap((workspace) => (
            workspace.path ? [{ ...workspace, path: workspace.path }] : []
          ))}
          loading={paseoAssignmentOptionsLoading}
          error={paseoAssignmentOptionsError}
          initialChoiceId={paseoExecutionDialog.initialChoiceId}
          initialWorkspacePath={paseoExecutionDialog.initialWorkspacePath}
          initialModeId={paseoExecutionDialog.initialModeId}
          initialThinkingOptionId={paseoExecutionDialog.initialThinkingOptionId}
          onRefresh={() => refreshPaseoAssignmentOptions(paseoExecutionDialog.projectId)}
          loadOptions={loadPaseoConfigurationOptions}
          onCancel={() => setPaseoExecutionDialog(null)}
          onSave={async (choiceId, workspacePath, configuration) => {
            const choice = choiceId === PASEO_SAVED_TASK_PLAN_ID && paseoExecutionDialog.initialProfile
              ? { kind: "planned" as const, profile: paseoExecutionDialog.initialProfile }
              : paseoAssigneeChoices.choices.get(choiceId);
            if (choice?.kind !== "planned") {
              throw new Error("当前 Agent 计划已不在可用目录中，请重新选择。");
            }
            await changePaseoTaskAssignment(
              { id: paseoExecutionDialog.taskId, projectId: paseoExecutionDialog.projectId },
              choiceId,
              workspacePath,
              configuration,
              true,
              true,
              choice,
            );
            setPaseoExecutionDialog(null);
          }}
        />
      )}

      {contextMenu && contextMenuTask && (
        <TaskContextMenu
          task={contextMenuTask}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          labels={availableLabels}
          onClose={closeContextMenu}
          onEdit={openTaskDetail}
          onStatusChange={(task, status) => void moveTask(task, status)}
          onPriorityChange={(task, nextPriority) => void updateTaskProperties(
            task,
            { priority: nextPriority },
          ).catch(() => {})}
          onLabelsChange={(task, labels) => void updateTaskProperties(
            task,
            { labels },
          ).catch(() => {})}
          onDuplicate={(task) => void duplicateTask(task)}
          onMoveToProject={contextMenuTask.source === "local" ? openTaskProjectMove : undefined}
          onCopy={(text, message) => void copyText(text, message)}
          openInThreadDisabled={developmentScanLoading}
          onOpenInThread={openTaskInThread}
          onArchive={(task) => void archiveTask(task)}
          onDelete={setPendingArchivedTaskDelete}
        />
      )}

      {localAiChatAvailable && !isAllProjects && (
        <Suspense fallback={null}>
          <AiChat
            available
            projectId={selectedProjectId || null}
            issueId={detailTaskId}
            codexProjectIdentity={selectedCodexProjectIdentity}
            onThreadsChange={setAiThreads}
            openThreadRequest={aiOpenThreadRequest}
            onOpenThreadRequestHandled={handleAiOpenThreadRequestHandled}
          />
        </Suspense>
      )}

      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {undoNotice && (
        <div
          className="toast undo-toast"
          role="status"
          onAnimationEnd={() => setUndoNotice((current) => current?.id === undoNotice.id ? null : current)}
        >
          <span aria-hidden="true"><LinearIcon name="check" /></span>
          <span className="undo-toast-message">{undoNotice.message}</span>
          <button type="button" onClick={() => void performUndo()}>
            {text("撤回", "Undo")} <kbd>{undoShortcut}</kbd>
          </button>
        </div>
      )}
      {announcement && (
        <div className="toast" role="status" onAnimationEnd={() => setAnnouncementValue("")}>
          <span aria-hidden="true"><LinearIcon name="check" /></span>{announcement}
        </div>
      )}
      </div>
    </TaskboardLanguageProvider>
  );
}
