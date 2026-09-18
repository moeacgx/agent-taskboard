# Dashi Taskboard — Paseo 原生插件设计（精简版）

## 已核实的真实路径

`server/database.mjs`(SQLite,表 `tasks`/`comments`,status 枚举含 `in_review`=待验收)
→ `server/app.mjs` HTTP API(`GET/POST /api/tasks`、`GET/PATCH /api/tasks/:id`、
`POST /api/tasks/:id/move|archive|restore`、`GET/POST /api/tasks/:id/comments`,
默认 `http://127.0.0.1:47823`,本地请求靠 `X-Taskboard-User-*` 头识别身份,无需 token)
→ 插件 `server/*.ts`(`defineRpc`+`server.handle` 包一层 fetch,不碰 schema)
→ 插件 `client/*.tsx`(`addSurface`+`addSidebarItem`,三列看板；Web 层用 HTML5 drag/drop)
→ `dashi.move-task-board` RPC（先检查配置和绑定，再 move、串行创建/继续 Agent）
→ Agent 绑定(`workspace.agents.create({config,title})` → 持久绑定 → `agent.send(prompt)`,
`server.on("agent.turn_ended")` 回写)。

## 范围(本版只做这些)

- 项目列表 → 默认三列看板：等待认领（`backlog/todo/canceled`）、处理中（`in_progress/blocked`）、
  等你确认（`in_review/done`）；支持跨列拖放和同列排序。
- 新任务默认在等待认领；把任务拖入处理中会使用项目默认工作区 + 完整 Agent Profile 创建 Agent，已有绑定则
  继续原 Agent。运行中或等待权限的 Agent 不会重复派发；失败写评论并移到 `blocked`，可独立重试。
- 未配置默认工作区/Profile 时，拖入处理中不写状态、展开设置；保存后自动重放该次拖放。运行中的任务不能移回
  等待认领，以免 Agent 被看板隐形。
- 任务详情页:关联工作区(创建或复用 workspace)、选 provider/model(有 profile 就优先展示)、
  创建执行 Agent 并与任务绑定、对已绑定任务继续会话、查看运行中/完成/错误/取消四种状态
- Agent turn 结束时自动回写任务:完成→评论+移到 `in_review`(待验收,绝不自动 `done`);
  失败→评论+移到 `blocked`;取消→只评论,不改状态(三者严格分开,不把"agent 结束"等同于"任务完成")
- 服务发现:环境变量覆盖 → 默认端口探测;服务未运行时 UI 给出明确启动命令,不自建托管服务

**明确不做**(超出首版闭环,留作后续):附件、完整 markdown 渲染、relations/activities、
Jira 联动、云同步、Tauri/CDP 注入、多 provider 的 MCP 自动配置、权限请求自动应答。

## 目录结构

```
integrations/paseo/
  paseo-plugin.json        # manifest, id: dashi-taskboard, requirements.paseo >=0.8.0
  package.json             # 独立 npm 包,不进根 workspace
  tsconfig.json
  index.client.tsx
  index.server.ts
  shared/
    contracts.ts             # Zod: Task/Comment/Project/Binding + 全部 RPC 定义(纯值,无 Node/RN 依赖)
    timeline-text.ts          # 从 agent timeline 还原"最后回复"文本的纯函数
  server/
    dashi-api.ts             # fetch 封装 + 服务发现,唯一知道 dashi HTTP API 形状的地方
    bindings.ts               # 插件自己的 JSON 文件存储 taskId <-> {workspaceId, agentId, provider, lastOutcome, pendingWriteback}
    writeback.ts               # 可续传的写回逻辑(评论+状态移动),turn_ended 钩子和重试 RPC 共用
    handlers.ts                 # RPC 处理器实现,组合 dashi-api + bindings + writeback
    dispatch.ts                 # move 后的每任务去重创建/继续 Agent
    settings.ts                 # 项目默认工作区/Profile JSON 存储
    lifecycle.ts                 # server.on("agent.turn_started"/"agent.turn_ended") 回写逻辑
  client/
    App.tsx                    # 根 surface,内部状态机做多页导航(默认进入三列看板)
    ProjectList.tsx / TaskList.tsx / TaskDetail.tsx / TaskForm.tsx / AgentPanel.tsx
  test/dashi-api.test.ts      # 起一个临时端口+临时 sqlite 的真实 server,走一遍主路径
  README.md
```

## 关键设计决定

1. **绑定关系不写入 dashi 数据库,也不用 `defineSettings`**:存在插件自己的 JSON 文件
   (`server/bindings.ts`)里,避免动 dashi schema。`defineSettings`/`server.registerSettings()`
   在本机安装的 `@getpaseo/plugin@0.8.0` 里返回 `void`(没有 read/save handle)——比公开文档描述的
   行为更旧,已用安装的 `.d.ts` 核实,不是猜测。
2. **assignee 不强行塞 Paseo agent id**:dashi 的 `assigneeTarget` 只接受
   `"current-user" | "codex-agent"` 两个固定值(`shared/api-fields.mjs`),不接受任意 id,且
   `"codex-agent"` 是 dashi 内置的 Codex Agent 受理人,和 Paseo 身份无关。插件从不设置
   `assigneeTarget`,真实的 Paseo agent 身份完全走插件自己的绑定表。
3. **回写走 `agent.turn_started`/`agent.turn_ended` 钩子,不依赖 agent 自觉**:
   `outcome.kind` 是 `completed|failed|canceled` 三选一(已从安装的 `.d.ts` 核实),分别对应
   "待验收/blocked/仅评论";`turn_started` 额外把任务移到 `in_progress`,让"正在运行"在看板上也
   可见。这保证即使 agent 完全不知道任务系统存在,结果也会被记录,满足"避免只拼启动按钮而无结果
   关联"。不依赖仓库自带的 `cli/taskctl.mjs`——taskctl 的 `threadBinding`/`CODEX_THREAD_ID` 是
   Codex 专用的线程归属机制,把 Paseo agent id 塞进去会破坏它的假设,首版直接用不带 Codex 身份的
   HTTP 请求(`X-Taskboard-User-*`)加评论,不强行复用。
4. **`lastOutcome` 只在写回真正成功后才落地**:agent 自己跑完和"把结果写回 dashi"是两件独立的事——
   评论文案也不断言具体的目标状态("已置为 in_review"),只说 agent 做了什么,因为状态移动可能因为
   版本冲突、任务已被人工置为 done/canceled、或 dashi 瞬时不可用而单独失败。失败的写回记为
   `pendingWriteback`(可在 UI 里看到 + 重试),不是把异常吞掉;重试记住评论是否已经发出去,不会
   重复发评论(`server/writeback.ts` 的 `commentPosted` 标记)。
5. **同一 Agent 只能绑一个任务,换绑不沿用旧结果**:`bindings.upsert` 换绑到新任务时原子移除该
   Agent 在旧任务上的绑定;同一任务换成新 Agent 时清空 `lastOutcome`/`pendingWriteback`,避免旧
   Agent 的运行结果被误当成新 Agent 的结果展示;`recordOutcome`/`recordWritebackError` 都校验
   当前 `agentId`,拒绝已经被换绑掉的旧 Agent 的迟到 turn 事件覆盖新绑定。
6. **状态转移是单向收紧的**:`in_review` 之后是否 `done` 完全由人工在任务板里决定,插件永不
   自动置 `done`;取消(`canceled` outcome)不改变任务的 `status` 字段,避免和任务级"取消"语义混淆。
7. **服务发现只做两层**:`DASHI_TASKBOARD_URL` 环境变量 → 默认 `127.0.0.1:47823` 健康探测。
   不做复杂的跨平台 runtime-file 扫描或自动拉起子进程,匹配"首版选已有服务连接+明确启动命令"的范围收紧。
8. **不用 `useAgent`/`useWorkspace`**:这两个 host-subscribed hook 在本机安装的 0.8.0 版本里,从
   `addSurface` 注册的侧栏 surface(不是 workspace panel)调用会直接抛
   `Plugin state hooks must run inside a workspace panel`(真实 reload 后在 Paseo App 里复现)。
   `AgentPanel.tsx` 改用 `usePaseo().agents.ref(id).refresh()` 做每 4 秒一次的轮询,只在任务详情
   页且有绑定 Agent 时才跑,卸载清理定时器,避免全页刷新或打断正在输入的文本框。
9. **看板刷新与排序不触发派发**:列表每 4 秒轻量刷新，只在非拖动、非项目设置编辑时运行；同列拖放只传
   `sortOrder`，只有实际跨列进入 `in_progress` 才触发 dispatch。排序使用前后任务的均值、顶端减 1000、
   末尾加 1000、空列 1000；409 交给调用方刷新重算，不盲重试。

## 三列看板验收边界

- 主协调已在真实 Paseo UI 验证 DOM `dragstart/dragover/drop` → dashi `move` → 创建/继续真实 Agent →
  lifecycle 回写 `in_review`，以及回拖复用 Agent、同列排序持久化且不派发。
- 自动化浏览器拖拽能力没有产生原生 `drop`，实际验收使用 DOM 事件链；物理鼠标拖动尚未独立验证。
