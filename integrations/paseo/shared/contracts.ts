import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Field names mirror the dashi-taskboard HTTP API response shape exactly
 * (see server/database.mjs `taskFromRow` / `commentFromRow` / `projectFromRow`
 * in the dashi-taskboard repository), so this plugin never reshapes data it
 * does not own.
 */

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const ActorSchema = z.object({
  type: z.string(),
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});

export const DevelopmentContextSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("worktree"), path: z.string(), branch: z.string().nullable() }),
    z.object({ type: z.literal("branch"), branch: z.string() }),
  ])
  .nullable();

/** Paseo 专用 Git 扫描结果；非 Git 目录不是空列表，而是明确状态。 */
export const PaseoWorktreeScanSchema = z.object({
  workspacePath: z.string(),
  gitRoot: z.string().nullable(),
  isGitRoot: z.boolean(),
  head: z.string().nullable(),
  branches: z.array(z.string()),
  worktrees: z.array(z.object({ path: z.string(), branch: z.string().nullable() })),
  error: z.string().nullable(),
});
export type PaseoWorktreeScan = z.infer<typeof PaseoWorktreeScanSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  labels: z.array(z.string()),
  sortOrder: z.number(),
  creatorType: z.string(),
  creatorId: z.string(),
  creatorName: z.string(),
  assignee: ActorSchema,
  developmentContext: DevelopmentContextSchema,
  source: z.enum(["local", "jira"]),
  archivedAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  commentId: z.string().nullable(),
  kind: z.enum(["inline", "attachment"]),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  createdAt: z.string(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  body: z.string(),
  authorType: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  attachments: z.array(AttachmentSchema).default([]),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspacePath: z.string().nullable(),
  source: z.enum(["local", "jira"]),
  issueCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** Plugin-owned link between a dashi task and a Paseo workspace/agent. Never written to the dashi database. */
export const AgentOutcomeSchema = z.object({
  kind: z.enum(["completed", "failed", "canceled"]),
  at: z.string(),
  message: z.string().nullable(),
});
export type AgentOutcome = z.infer<typeof AgentOutcomeSchema>;

/**
 * A write-back attempt (comment + status move) that failed and has not been
 * retried successfully yet. Kept separate from `lastOutcome`: the agent can
 * finish successfully while the *write-back to dashi* still fails (service
 * down, version conflict, ...), and those are different facts. `lastOutcome`
 * only ever reflects a write-back that actually landed.
 */
export const PendingWritebackSchema = z.object({
  outcome: AgentOutcomeSchema,
  commentBody: z.string(),
  status: TaskStatusSchema.nullable(),
  error: z.string(),
  /** Whether the comment half already landed, so a retry does not repost it. */
  commentPosted: z.boolean(),
  /** 产生结果的真实 Paseo turn；旧版本记录没有该字段。 */
  turnId: z.string().nullable().default(null),
  /** 绑定在接受该轮时递增的 generation；用于拒绝迟到旧结果。 */
  generation: z.number().int().nonnegative().nullable().default(null),
});
export type PendingWriteback = z.infer<typeof PendingWritebackSchema>;

export const BindingSchema = z.object({
  taskId: z.string(),
  taskIdentifier: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  provider: z.string(),
  /** 真实 Paseo 会话身份；旧绑定缺字段时保留兼容。 */
  agentTitle: z.string().nullable().default(null),
  agentModel: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastOutcome: AgentOutcomeSchema.nullable(),
  // `.default(null)`, not just `.nullable()`: bindings.json files written
  // before this field existed have no `pendingWriteback` key at all, and a
  // missing key is `undefined`, which `.nullable()` alone does not accept.
  pendingWriteback: PendingWritebackSchema.nullable().default(null),
  /** 仅由任务板明确派发的下一轮可以被 lifecycle 接受；直接在 Paseo 中发送不写回任务。 */
  dispatchArmed: z.boolean().default(false),
  /** 已被 lifecycle 接受、尚可写回的本轮 Paseo turn id。 */
  acceptedTurnId: z.string().nullable().default(null),
  /** 每次接受真实 turn 递增；reload 后仍能区分旧 pending 写回。 */
  turnGeneration: z.number().int().nonnegative().default(0),
});
export type Binding = z.infer<typeof BindingSchema>;

/** 原版 iframe 只消费 Paseo 已刷新过的 Agent 摘要，不接触 SDK 或伪造 Codex thread。 */
export const PaseoAgentPresentationSchema = z.object({
  taskId: z.string(),
  agentId: z.string(),
  status: z.enum(["initializing", "idle", "running", "error", "closed", "unavailable"]),
  requiresAttention: z.boolean(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable(),
  updatedAt: z.string().nullable(),
  title: z.string().nullable(),
});
export type PaseoAgentPresentation = z.infer<typeof PaseoAgentPresentationSchema>;

export const AgentProfileConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Paseo profile registry key, not a URL. */
  icon: z.string().nullable().optional(),
  provider: z.string(),
  model: z.string().nullable(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
});
export type AgentProfileConfig = z.infer<typeof AgentProfileConfigSchema>;

export const ProjectAutomationSettingsSchema = z.object({
  projectId: z.string(),
  workspacePath: z.string().nullable(),
  profile: AgentProfileConfigSchema.nullable(),
  enabledByUser: z.boolean().default(false),
  intervalMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]).default(5),
  quotaAware: z.boolean().default(false),
  lastRunAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type ProjectAutomationSettings = z.infer<typeof ProjectAutomationSettingsSchema>;

export const PaseoAutomationStateSchema = z.object({
  projectId: z.string(),
  workspacePath: z.string().nullable(),
  profile: AgentProfileConfigSchema.nullable(),
  enabledByUser: z.boolean(),
  intervalMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]),
  quotaAware: z.boolean(),
  status: z.enum(["ACTIVE", "PAUSED"]),
  schedulerReady: z.boolean(),
  quotaAvailable: z.literal(false),
  lastRunAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type PaseoAutomationState = z.infer<typeof PaseoAutomationStateSchema>;

/**
 * 新建 Agent 的任务级计划：保存配置但不创建、不发送，拖入处理中时才真正执行。
 * workspacePath/profile 为 null 表示该字段继承当前项目 defaults；双 null 不会清除项目 defaults。
 */
export const TaskExecutionPlanSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  workspacePath: z.string().min(1).nullable(),
  profile: AgentProfileConfigSchema.nullable(),
  updatedAt: z.string(),
});
export type TaskExecutionPlan = z.infer<typeof TaskExecutionPlanSchema>;

export const PaseoExistingAgentSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  cwd: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  status: z.enum(["initializing", "idle", "running", "error", "closed"]),
  requiresAttention: z.boolean(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable(),
});
export type PaseoExistingAgent = z.infer<typeof PaseoExistingAgentSchema>;

export const PaseoWorkspaceChoiceSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  path: z.string().nullable(),
  projectWorkspace: z.boolean(),
  kind: z.enum(["project", "workspace"]),
});
export type PaseoWorkspaceChoice = z.infer<typeof PaseoWorkspaceChoiceSchema>;

/** 已启用且当前可用的 Paseo provider；模型由真实 SDK 目录读取。 */
export const PaseoProviderChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** 已过滤的 inline SVG data URL；缺失时客户端按 provider ID 回退。 */
  iconDataUrl: z.string().nullable(),
});
export type PaseoProviderChoice = z.infer<typeof PaseoProviderChoiceSchema>;

export const PaseoConfigurationOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type PaseoConfigurationOption = z.infer<typeof PaseoConfigurationOptionSchema>;

/** 负责人所选 provider/model 在指定工作区的真实 Mode 与 Thinking 目录。 */
export const PaseoConfigurationOptionsSchema = z.object({
  provider: z.string(),
  model: z.string(),
  modes: z.array(PaseoConfigurationOptionSchema),
  thinkingOptions: z.array(PaseoConfigurationOptionSchema),
  defaultModeId: z.string().optional(),
  defaultThinkingOptionId: z.string().optional(),
  currentModeId: z.string().optional(),
  currentThinkingOptionId: z.string().optional(),
  modeSource: z.enum(["provider_catalog", "agent_session", "none"]),
  modeMessage: z.string().optional(),
  editable: z.boolean(),
});
export type PaseoConfigurationOptions = z.infer<typeof PaseoConfigurationOptionsSchema>;

export const PaseoTaskAssignmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), taskId: z.string(), agentId: z.string(), workspaceId: z.string(), workspaceName: z.string().nullable(), workspacePath: z.string().nullable(), provider: z.string(), model: z.string().nullable(), title: z.string().nullable(), status: z.enum(["initializing", "idle", "running", "error", "closed", "unavailable"]) }),
  z.object({ kind: z.literal("planned"), taskId: z.string(), workspacePath: z.string().nullable(), profile: AgentProfileConfigSchema.nullable() }),
]);
export type PaseoTaskAssignment = z.infer<typeof PaseoTaskAssignmentSchema>;

// ---- RPC contracts -------------------------------------------------------

export const checkConnection = defineRpc({
  name: "dashi.check-connection",
  input: z.object({}),
  output: z.object({
    connected: z.boolean(),
    baseUrl: z.string(),
    error: z.string().nullable(),
  }),
});

export const listProjects = defineRpc({
  name: "dashi.list-projects",
  input: z.object({}),
  output: z.object({ projects: z.array(ProjectSchema) }),
});

export const listTasks = defineRpc({
  name: "dashi.list-tasks",
  input: z.object({
    projectId: z.string().optional(),
    status: TaskStatusSchema.optional(),
    archived: z.boolean().optional(),
  }),
  output: z.object({ tasks: z.array(TaskSchema) }),
});

export const archiveTask = defineRpc({
  name: "dashi.archive-task",
  input: z.object({ id: z.string(), version: z.number() }),
  output: z.object({ task: TaskSchema }),
});

export const restoreTask = defineRpc({
  name: "dashi.restore-task",
  input: z.object({ id: z.string(), version: z.number() }),
  output: z.object({ task: TaskSchema }),
});

export const deleteTask = defineRpc({
  name: "dashi.delete-task",
  input: z.object({ id: z.string(), version: z.number() }),
  output: z.object({ deleted: z.literal(true) }),
});

/** 原版 srcDoc 只能调用明确列出的 Taskboard HTTP API。 */
const BridgeBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), value: z.string().max(1_000_000) }),
  // Dashi 附件上限为 25 MiB；base64 传输后的最大长度约为 33.4 MiB。
  z.object({ kind: z.literal("base64"), value: z.string().max(34_952_536) }),
]);

export const bridgeRequest = defineRpc({
  name: "dashi.bridge-request",
  input: z.object({
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    path: z.string().min(1).max(4_096),
    headers: z.record(z.string(), z.string()).default({}),
    body: BridgeBodySchema.nullable(),
  }),
  output: z.object({
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
    body: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("json"), value: z.unknown() }),
      z.object({ kind: z.literal("base64"), value: z.string().max(34_952_536) }),
    ]),
  }),
});

/** 仅供隔离 srcDoc 查询真实 Git 根、分支和已登记 worktree。 */
export const inspectPaseoWorktree = defineRpc({
  name: "dashi.inspect-paseo-worktree",
  input: z.object({ workspacePath: z.string().min(1).max(4_096) }),
  output: PaseoWorktreeScanSchema,
});

/**
 * 由 Paseo daemon 创建并登记 Git worktree。
 * `taskId` 只在详情页已有任务时传入，用来阻止把已有 Agent 静默切到别的 cwd。
 */
export const createPaseoWorktree = defineRpc({
  name: "dashi.create-paseo-worktree",
  input: z.object({
    workspacePath: z.string().min(1).max(4_096),
    branch: z.string().min(1).max(255),
    branchMode: z.enum(["existing", "new"]),
    taskId: z.string().optional(),
  }),
  output: z.object({
    context: DevelopmentContextSchema.unwrap(),
    workspace: z.object({ id: z.string(), path: z.string(), branch: z.string() }),
    scan: PaseoWorktreeScanSchema,
  }),
});

export const getTask = defineRpc({
  name: "dashi.get-task",
  input: z.object({ id: z.string() }),
  output: z.object({ task: TaskSchema }),
});

export const createTask = defineRpc({
  name: "dashi.create-task",
  input: z.object({
    projectId: z.string().optional(),
    title: z.string().min(1).max(240),
    description: z.string().max(100_000).optional(),
    priority: TaskPrioritySchema.optional(),
    labels: z.array(z.string()).optional(),
    status: TaskStatusSchema.optional(),
  }),
  output: z.object({ task: TaskSchema }),
});

export const updateTask = defineRpc({
  name: "dashi.update-task",
  input: z.object({
    id: z.string(),
    version: z.number(),
    title: z.string().min(1).max(240).optional(),
    description: z.string().max(100_000).optional(),
    priority: TaskPrioritySchema.optional(),
    labels: z.array(z.string()).optional(),
  }),
  output: z.object({ task: TaskSchema }),
});

export const moveTask = defineRpc({
  name: "dashi.move-task",
  input: z.object({
    id: z.string(),
    version: z.number(),
    status: TaskStatusSchema,
  }),
  output: z.object({ task: TaskSchema }),
});

export const moveTaskBoard = defineRpc({
  name: "dashi.move-task-board",
  input: z.object({
    id: z.string(),
    version: z.number(),
    status: TaskStatusSchema,
    sortOrder: z.number().optional(),
  }),
  output: z.object({
    task: TaskSchema,
    dispatch: z.enum(["started", "continued", "skipped", "needs_configuration", "failed", "none"]),
    dispatchMessage: z.string().nullable(),
  }),
});

export const retryTaskDispatch = defineRpc({
  name: "dashi.retry-task-dispatch",
  input: z.object({ id: z.string(), version: z.number() }),
  output: z.object({
    task: TaskSchema,
    dispatch: z.enum(["started", "continued", "skipped", "needs_configuration", "failed"]),
    dispatchMessage: z.string().nullable(),
  }),
});

/** 任务详情“继续会话”的显式派发；先武装本轮，再发送，避免原生旧 turn 误写回。 */
export const continueTaskAgent = defineRpc({
  name: "dashi.continue-task-agent",
  input: z.object({ taskId: z.string(), message: z.string().min(1).max(100_000).optional() }),
  output: z.object({ task: TaskSchema, binding: BindingSchema }),
});

/** 已绑定后由详情创建流程在客户端发送前武装下一轮。 */
export const armTaskTurn = defineRpc({
  name: "dashi.arm-task-turn",
  input: z.object({ taskId: z.string() }),
  output: z.object({ binding: BindingSchema }),
});

/** 由服务端按当前任务和人工评论构造统一的 Agent 提示词。 */
export const buildTaskPrompt = defineRpc({
  name: "dashi.build-task-prompt",
  input: z.object({ taskId: z.string() }),
  output: z.object({ prompt: z.string() }),
});

export const getProjectSettings = defineRpc({
  name: "dashi.get-project-settings",
  input: z.object({ projectId: z.string() }),
  output: z.object({ settings: ProjectAutomationSettingsSchema.nullable() }),
});

export const saveProjectSettings = defineRpc({
  name: "dashi.save-project-settings",
  input: ProjectAutomationSettingsSchema.omit({ updatedAt: true }),
  output: z.object({ settings: ProjectAutomationSettingsSchema }),
});

export const getPaseoAutomation = defineRpc({
  name: "dashi.get-paseo-automation",
  input: z.object({ projectId: z.string() }),
  output: z.object({ automation: PaseoAutomationStateSchema }),
});

export const savePaseoAutomation = defineRpc({
  name: "dashi.save-paseo-automation",
  input: z.object({
    projectId: z.string(),
    enabledByUser: z.boolean(),
    intervalMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]),
    quotaAware: z.boolean(),
    workspacePath: z.string().min(1).max(4_096).nullable().optional(),
    profile: AgentProfileConfigSchema.nullable().optional(),
  }).superRefine((value, context) => {
    const hasWorkspacePath = Object.hasOwn(value, "workspacePath");
    const hasProfile = Object.hasOwn(value, "profile");
    if (
      hasWorkspacePath !== hasProfile
      || (hasWorkspacePath && value.workspacePath !== null && value.profile === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "workspacePath 与 profile 必须同时设置或同时清空",
      });
    }
  }),
  output: z.object({ automation: PaseoAutomationStateSchema }),
});

/** 仅保存项目默认 Agent 配置；不修改自动化开关、间隔，不创建或派发 Agent。 */
export const savePaseoProjectDefaults = defineRpc({
  name: "dashi.save-paseo-project-defaults",
  input: z.object({
    projectId: z.string(),
    workspacePath: z.string().min(1).max(4_096).nullable(),
    profile: AgentProfileConfigSchema.nullable(),
  }),
  output: z.object({ projectId: z.string(), automation: PaseoAutomationStateSchema }),
});

/** 读取当前 daemon 的真实未归档会话，及可用于“新建 Agent”的真实 profile/workspace。 */
export const listPaseoAssignmentOptions = defineRpc({
  name: "dashi.list-paseo-assignment-options",
  input: z.object({ projectId: z.string().nullable() }),
  output: z.object({
    agents: z.array(PaseoExistingAgentSchema),
    workspaces: z.array(PaseoWorkspaceChoiceSchema),
    profiles: z.array(AgentProfileConfigSchema),
    providers: z.array(PaseoProviderChoiceSchema),
    /** provider 的完整真实模型目录，不是 agentProfiles 的别名。 */
    models: z.array(AgentProfileConfigSchema),
    defaultWorkspacePath: z.string().nullable(),
  }),
});

export const getPaseoConfigurationOptions = defineRpc({
  name: "dashi.get-paseo-configuration-options",
  input: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    workspacePath: z.string().min(1).nullable().optional(),
    agentId: z.string().min(1).optional(),
    modeId: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
  }),
  output: z.object({ options: PaseoConfigurationOptionsSchema }),
});

/** 创建任务后绑定一个已存在的未归档 Paseo 会话；不会发送消息。 */
export const bindExistingPaseoAgent = defineRpc({
  name: "dashi.bind-existing-paseo-agent",
  input: z.object({ taskId: z.string(), agentId: z.string() }),
  output: z.object({ assignment: PaseoTaskAssignmentSchema }),
});

/** 创建任务后保存新 Agent 的计划；不会创建 Agent 或发送消息。null 字段按项目 defaults 继承。 */
export const saveTaskExecutionPlan = defineRpc({
  name: "dashi.save-task-execution-plan",
  input: TaskExecutionPlanSchema.omit({ updatedAt: true }).extend({ replaceWorkspace: z.boolean().optional() }),
  output: z.object({ assignment: PaseoTaskAssignmentSchema, task: TaskSchema }),
});

/** 合并等待认领想法；operationId 同时是预分配的新任务 UUID。 */
export const mergePaseoIdeas = defineRpc({
  name: "dashi.merge-paseo-ideas",
  input: z.object({
    operationId: z.string().uuid(),
    projectId: z.string(),
    sourceTaskIds: z.array(z.string()).min(2).max(50),
    title: z.string().min(1).max(240),
    description: z.string().max(100_000).optional(),
    workspacePath: z.string().min(1).max(4_096),
    profile: AgentProfileConfigSchema,
  }),
  output: z.object({
    task: TaskSchema,
    assignment: PaseoTaskAssignmentSchema,
    sourceTaskIds: z.array(z.string()),
    replayed: z.boolean(),
  }),
});

export const getPaseoTaskAssignments = defineRpc({
  name: "dashi.get-paseo-task-assignments",
  input: z.object({ taskIds: z.array(z.string()).max(200) }),
  output: z.object({ assignments: z.array(PaseoTaskAssignmentSchema) }),
});

/** 用户明确选择“我”或“未分配”时，仅移除插件绑定/计划，不触碰 Paseo 会话。 */
export const clearPaseoTaskAssignment = defineRpc({
  name: "dashi.clear-paseo-task-assignment",
  input: z.object({ taskId: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

export const listComments = defineRpc({
  name: "dashi.list-comments",
  input: z.object({ taskId: z.string() }),
  output: z.object({ comments: z.array(CommentSchema) }),
});

export const addComment = defineRpc({
  name: "dashi.add-comment",
  input: z.object({ taskId: z.string(), body: z.string().min(1).max(100_000) }),
  output: z.object({ comment: CommentSchema }),
});

export const getBinding = defineRpc({
  name: "dashi.get-binding",
  input: z.object({ taskId: z.string() }),
  output: z.object({ binding: BindingSchema.nullable() }),
});

export const listBindings = defineRpc({
  name: "dashi.list-bindings",
  input: z.object({}),
  output: z.object({ bindings: z.array(BindingSchema) }),
});

export const getPaseoPresentations = defineRpc({
  name: "dashi.get-paseo-presentations",
  input: z.object({ taskIds: z.array(z.string()).max(200) }),
  output: z.object({ presentations: z.array(PaseoAgentPresentationSchema) }),
});

export const bindAgent = defineRpc({
  name: "dashi.bind-agent",
  input: z.object({
    taskId: z.string(),
    taskIdentifier: z.string(),
    projectId: z.string(),
    workspaceId: z.string(),
    agentId: z.string(),
    provider: z.string(),
  }),
  output: z.object({ binding: BindingSchema }),
});

export const unbindAgent = defineRpc({
  name: "dashi.unbind-agent",
  input: z.object({ taskId: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

/** Re-attempts a write-back (comment + status move) that previously failed. */
export const retryWriteback = defineRpc({
  name: "dashi.retry-writeback",
  input: z.object({ taskId: z.string() }),
  output: z.object({ binding: BindingSchema }),
});
