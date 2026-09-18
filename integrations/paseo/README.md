# Dashi Taskboard — Paseo 原生插件

## 从 Agent Taskboard 安装

本插件随 [moeacgx/agent-taskboard](https://github.com/moeacgx/agent-taskboard) 提供，基于原作者 [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)。以下固定安装目录及实机记录是开发环境示例，并不表示新克隆的机器已经安装插件。

在仓库根目录安装依赖并构建 Dashi 页面，再启动本地服务：

```powershell
git clone https://github.com/moeacgx/agent-taskboard.git
cd agent-taskboard
npm ci
npm run build:web
npm start
```

在另一个终端安装插件依赖，并使用与当前桌面版匹配的 Paseo CLI 安装插件：

```powershell
cd agent-taskboard/integrations/paseo
npm ci --ignore-scripts
npm run typecheck
paseo plugin install .
```

仓库包含插件运行所需的 `client/original-app.generated.ts`。修改根目录 `web/` 后，在插件目录执行 `npm run build:original-srcdoc`，再执行 `paseo plugin reload dashi-taskboard`。`.paseo-web-dist/` 是可重新生成的中间产物，不提交到仓库。

把 [dashi-taskboard](../..) 的项目/任务数据接入 Paseo 侧栏。默认页面是三列看板：**等待认领**（创意想法，
不执行）、**处理中**（拖入后自动创建或继续 Paseo Agent）、**等你确认**（Agent 完成后自动进入，绝不自动
置为 `done`）。看板支持桌面 DOM 拖拽、同列排序、项目默认工作区与 Agent Profile，以及失败后的明确 blocked
状态和重试入口。

设计取舍与"真实路径证明"见 [DESIGN.md](DESIGN.md)。这里只写"怎么跑起来、装在哪、哪些已经验证过"。

## 三个位置，不要混淆

| 位置 | 路径 | 是什么 |
| --- | --- | --- |
| **开发源码** | 本 worktree 内 `integrations/paseo/`（就是这份代码） | 日常改代码的地方 |
| **固定安装目录（当前实际运行的插件）** | `%LOCALAPPDATA%\DashiPaseo\plugin`（即 `C:/Users/Administrator/AppData/Local/DashiPaseo/plugin`） | 已由主协调完成安装：把 `index.client.tsx`、`index.server.ts`、`client/`、`server/`、`shared/`、`paseo-plugin.json`、`package.json`、`tsconfig.json` 复制到这里，Paseo 里运行的插件 id `dashi-taskboard` 指向这个固定路径，已不依赖开发 worktree，即使 worktree 被清理插件也不受影响 |
| **数据目录** | dashi 服务自身数据：`%LOCALAPPDATA%\DashiPaseo`（sqlite/attachments 等，由 `CODEX_TASKBOARD_DATA_DIR` 决定）；插件自己的 `bindings.json`（任务↔Agent）与 `settings.json`（项目默认工作区/Profile）：`~/.paseo/plugin-data/dashi-taskboard/` | 运行时产生的状态，和上面两处代码都互相独立 |

**这不是零依赖的纯文件复制。** 插件的构建/加载步骤会解析 `@getpaseo/plugin`、`@getpaseo/client`、
`@getpaseo/protocol`（包括仅用于类型标注的 `@getpaseo/protocol/agent-types`）、`zod`、`react`、
`react-native` 这些依赖，即使最终运行时由 Paseo 宿主提供实现，构建器本身也需要能在本地解析到它们。
复制源码之后、`paseo plugin install`/`reload` 之前，必须在**固定安装目录**里执行一次依赖安装
（本次实际安装使用的是 `npm ci --ignore-scripts`，原因见下方"已知环境问题"），再跑
`npm run typecheck` 确认无误：

```powershell
cd $env:LOCALAPPDATA\DashiPaseo\plugin
npm ci --ignore-scripts
npm run typecheck
```

漏掉这一步，`paseo plugin install`/`reload` 会因为解析不到 `@getpaseo/protocol/agent-types` 等
依赖而失败，不是插件源码本身的问题。

## 启动 dashi-taskboard 服务（PowerShell）

插件不会自己拉起这个服务——先手动启动，插件只负责连接。默认端口 `47823`，只监听
`127.0.0.1`（不对外暴露，也不注册任何开机自启动任务；关掉这个 PowerShell 窗口服务就停了）：

```powershell
cd D:\脚本程序\开源程序二开\dashi-taskboard
$env:CODEX_TASKBOARD_HOST = "127.0.0.1"
$env:CODEX_TASKBOARD_PORT = "47823"
$env:CODEX_TASKBOARD_DATA_DIR = "$env:LOCALAPPDATA\DashiPaseo"   # 可选：显式指定数据目录
node server/index.mjs
```

按上面的默认值启动时，插件不需要任何额外配置就能连上（见下方 `DASHI_TASKBOARD_URL`）。

## 插件自身的环境变量

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `DASHI_TASKBOARD_URL` | dashi-taskboard HTTP API 地址，服务不在默认地址/端口时设置 | `http://127.0.0.1:47823` |
| `DASHI_TASKBOARD_PLUGIN_DATA_DIR` | 插件自己的任务↔Agent 绑定文件存放目录 | `~/.paseo/plugin-data/dashi-taskboard/`（内含 `bindings.json`） |

绑定文件独立于 Dashi 的 SQLite 数据库。插件不修改数据库结构，任务、评论和状态通过 Dashi HTTP API 写入。

## 安装到 Paseo（当前状态：已安装、运行中）

主协调已完成实际安装：源码复制到固定目录 → 该目录内 `npm ci --ignore-scripts` → `npm run typecheck`
通过 → `paseo plugin install`/`reload` 到 `dashi-taskboard` 这个 runtime id。当前 `paseo plugin ls`
应显示 `dashi-taskboard` 为 `running`，且已不依赖本开发 worktree（见上表）。

以后在**固定安装目录**（不是这个开发 worktree）更新代码后，重复同样的步骤：

```powershell
cd $env:LOCALAPPDATA\DashiPaseo\plugin
npm ci --ignore-scripts
npm run typecheck
& "D:\APP\AI\Paseo\resources\bin\paseo.cmd" plugin reload dashi-taskboard
```

`requirements.paseo` 为 `>=0.8.0`；已在本机 Paseo CLI `@getpaseo/plugin@0.8.0` 上完成真实安装、
`reload`、真实 Paseo App 侧栏 UI 验证（见下方"已验证 / 未验证"）。

## 目录结构

```
integrations/paseo/
  paseo-plugin.json     manifest：id=dashi-taskboard，requirements.paseo >=0.8.0
  package.json          独立 npm 包，不进 dashi-taskboard 根 workspace
  index.client.tsx       客户端入口：注册侧栏 surface
  index.server.ts        服务端入口：注册 RPC + 生命周期钩子
  shared/
    contracts.ts          Task/Comment/Project/Binding 的 Zod 定义 + 全部 dashi.* RPC 契约
    timeline-text.ts       从 agent 会话 timeline 里还原"最后一次回复"文本的纯函数
  server/
    dashi-api.ts           唯一知道 dashi HTTP API 形状/地址解析的地方（fetch 封装）
    bindings.ts             任务↔Agent 绑定的 JSON 文件存储（原子写、同进程内串行）
    writeback.ts            把结果写回 dashi 的可续传逻辑（评论/状态失败时不重复发评论）
    handlers.ts             注册全部 dashi.* RPC（看板移动/自动派发/自动认领/重试）
    dispatch.ts             每任务去重的创建或继续 Agent 调度
    automation.ts           Paseo 自动认领 scheduler、项目 FIFO 与单次领取上限
    settings.ts             项目默认工作区和完整 Agent Profile 的 JSON 存储
    lifecycle.ts            agent.turn_started/turn_ended 钩子：进度可见 + 保证结果回写
  client/
    App.tsx                 侧栏根组件，内部状态机做多页导航（项目→任务→详情→表单）
    ProjectList.tsx / TaskList.tsx / TaskDetail.tsx / TaskForm.tsx / AgentPanel.tsx
    board.ts / web.ts        三列映射、排序计算与仅 Web 的 HTML5 drag/drop
    ConnectionGate.tsx      服务未连接时的提示界面
    hooks.ts / format.ts / types.ts   小工具
  test/
    dashi-api.test.ts / board.test.ts / dispatch.test.ts / board-api.test.ts
                            临时 dashi 服务 + 真实 RPC handler 主路径测试
```

## 状态与回写策略

- 任务状态沿用 dashi 已有的 `backlog/todo/in_progress/in_review/blocked/done/canceled`，没有新造状态。
- 从看板拖动、自动认领、重试或详情继续 Paseo 会话时，服务端都会在移动/武装/发送前读取该任务所属项目的
  最新项目文档。提示词优先级为“最新人工要求 > 当前任务具体要求 > 项目公共背景”；空文档省略，读取失败则
  本轮不继续执行。详情首次启动由服务端构造完整提示，后续继续只发送最新项目背景和本次人工要求，不重复旧提示。
- Agent 开始一轮（`agent.turn_started`）→ 任务移到 `in_progress`（已是 `done`/`canceled` 则不动）。
- 一轮结束（`agent.turn_ended`）：
  - `completed` → 评论（包含 Agent 最后一次实际回复的摘要）+ 移到 `in_review`（**待验收，插件绝不自动置
    `done`**）
  - `failed` → 评论（含错误信息）+ 移到 `blocked`
  - `canceled` → 只评论，任务状态不变（取消和失败、完成三者在 UI 与回写文案里严格区分，不把"Agent 结束"
    等同于"任务完成"）
- 评论文案只陈述"Agent 做了什么"，不断言"任务已经被置成了什么状态"——状态移动是单独一步，可能因为版本
  冲突、任务已被人工置为 `done`/`canceled`、或 dashi 服务瞬时不可用而失败，评论不应该在这种情况下撒谎。
- 写回（评论 + 状态移动）失败时不会被静默吞掉：记录为该任务绑定上的 `pendingWriteback`（在 Paseo UI 里
  显示为一条警告 + "重试写回"按钮），并记住评论是否已经发出去，重试时不会把评论发两遍。
- 任务↔Agent 绑定不写入 dashi 数据库，存在插件自己的 JSON 文件里；同一个 Agent 只能绑定一个任务（换绑到
  新任务会原子移除旧的那条），同一任务换成新 Agent 时旧 Agent 的运行结果不会被当成新 Agent 的结果展示。

## 测试

以下测试在开发 worktree 的 `integrations/paseo/` 中执行，依赖仓库服务源码；固定运行目录只用于安装和类型检查。

```bash
npm run typecheck
npm test
```

`npm test` 会在系统临时目录里起一个**真实**的 dashi-taskboard 服务实例（复用仓库自己的
`server/app.mjs`，随机端口、独立 SQLite 文件），跑完整主路径：连接检测、列项目/建任务/查任务/按状态
筛选/移动状态/加评论、乐观并发冲突（`VERSION_CONFLICT`）、绑定存储的增删查、"同一 Agent 只能绑一个
任务"与"换新 Agent 清空旧结果"两条不变式、写回失败后重试不重复发评论、流式回复文本的正确拼接，以及
旧版（缺 `pendingWriteback`）绑定记录的向后兼容解析；另覆盖三列映射/排序、项目默认配置持久化、
`move-task-board` handler 的缺配置不移动、保存配置后仅派发一次、同列排序不重派、版本冲突不派发，以及
Agent 创建失败时评论 + `blocked`。另覆盖旧绑定 JSON 的轮次字段默认值、快结束 turn、空 turnId、send 失败
撤销 armed 与写回前读取失败保留 pending write-back。全程不接触真实的 dashi 数据库或真实的 `~/.paseo`。
当前为 **48 项测试**，单测试超时限制 60 秒。新增覆盖默认关闭、每 tick 仅领取一项、在途关闭真实落盘、
自动与手动同任务并发仅发送一次，以及取消轮次消费后重新派发、等待权限仍保持门禁。轮次并发还覆盖：reload
后只在 SDK 明确 idle、无 active turn、无待权限时按精确旧 turn 回收 stale accepted/armed；迟到旧 ended 与新派发
通过同一 task FIFO 串行；旧 generation 的 pending write-back 不得覆盖新轮；完整属性 PATCH 跨状态返回 409，不能
绕过移动、派发和权限门禁。

首次运行前需要 dashi-taskboard 仓库根目录能 `import` 到 `ws`（`server/app.mjs` 的依赖）；如果根目录还
没装依赖：

```bash
cd ../..   # 回到 dashi-taskboard 仓库根目录
npm install --ignore-scripts   # 见下方"已知环境问题"
```

## 已验证 / 未验证

**已在真实 Paseo App + 真实 dashi 服务上验收：**

- 自包含原版 iframe 可加载，插件保持 `running`。三列看板在 1220×1350 的长窗口等宽、等高并填满主内容区，
  在 1200×420 的短窗口仍保持合理可用高度；不会把空列收成顶部横条。已完成、已取消、已归档入口是独立可换行的
  chips，430px 宽时可正确切换对应内容；不再把长文字塞进 28px 图标按钮。
- 负责人菜单在 960px 宽度使用 Paseo 官方 Claude 星芒、Codex、OMP π、Grok 图标；provider snapshot 有安全
  inline SVG 时优先使用，无图时按 provider ID 回退到同款官方几何。菜单没有横向滚动条。430px 窄菜单已由真实
  DOM 验证可运行；验收工具在该尺寸没有绘制截图，因此**未将其报告为截图验收**。
- 原版创建对话框可提交 todo。Paseo 负责人菜单读取真实 Profile、工作区和未归档会话；不显示固定
  `Codex Agent`。一级显示“我/未分配”、少量 Profile 快捷项、当前启用且可用的 provider，以及独立的“绑定已有
  会话”入口；点 provider 后才展示其真实模型目录，搜索与返回均在该层级内可用。实际验收时目录为 Claude 16、
  Codex 6、OMP 41、Grok 2；目录由 SDK 实时读取，不硬编码这些数量。
- 选择 Profile 或 provider 的模型后，工作区仍独立选择，项目默认自动化工作区优先，未命中时必须手选，绝不回退到
  第一个无关工作区。选择模型会按最终工作区读取 SDK 默认 mode、thinking 与 feature 值后保存任务计划；选择已有
  Paseo 会话只写绑定，`armed=false`，两种保存均不创建/不发送 Agent。已用 Codex GPT-5.6-Luna 创建 `LOCAL-6`
  验证该路径。负责人身份在新建、详情、卡片和列表中保持一致。
- 用户显式把已绑定任务移入处理中才发送；真实 turn 被接管、结束后清理资格，完成写入实际回复评论并转为
  `in_review`。done/canceled 的旧 turn 不会覆盖人工终态。
- 等待认领的原版右键菜单提供一次确认删除：先归档再 DELETE；从详情选择“我”可清除计划/绑定。专用 QA
  任务完成上述验收，既有用户任务状态和版本未改动。
- 三列拖放、同列排序、缺配置不移动、运行/待权限不重复派发、完成后的轮询移列，以及归档/恢复已走过真实
  Paseo DOM 与 Dashi API 路径。
- Paseo Worktree 已走过真实宿主闭环：新建任务可选择真实 Grok `maolaoapi` 配置与 daemon 管理的
  Worktree，任务计划立即落盘为该 `workspaceDirectory` 的 cwd，且不会创建或发送 Agent。详情页可选择已有
  `qa-existing` Worktree，也可新建 `qa-detail-fixed` 后立即写入任务开发上下文；两种路径均正确递增任务版本、
  写入活动记录，且 iframe 不再空白。非 Git 的 `D:\脚本程序` 会明确提示“当前目录不是 Git 仓库”并禁用创建；
  1540×1000、1200×420 与 iframe 430×728 的真实截图均通过。服务端临时 Git 仓库测试还覆盖 Git 根限制、
  已有 Worktree 分支拒绝、登记目录返回，以及任务级 Worktree 强制覆盖旧计划 cwd。
- 自动化与轮次恢复已在完整 runtime 安装/reload 后通过主协调真实宿主验收：专用 `PAS4` 从 `todo v4`
  被后台自动认领并完成到 `in_review v6`，页面无需刷新即可同步（检查时间 08:10）；关闭自动化后，人工
  拖动经历 `todo v7 → processing v8` 并真实取消 Agent（`canceled`、`generation=2`、`acceptedTurnId=null`），
  再次拖动 `todo v9 → processing v10` 后完成到 `in_review v11`，DOM 的 4 秒刷新持续跟随。开关和 interval
  均可正常使用。真实 `LOCAL-7` 的 Agent 仍处于待权限且未被自动批准；用户任务最终状态/版本另行核验。
- 固定安装目录已同步最新源码。项目文档作为 Paseo 任务共享背景已通过真实主路径验收：QA 任务 `PAS6`
  (`596c9ae8...`) 的任务描述不含验证口令；项目文档 A 版由 API 保存为 `v1` 后，首次拖入处理中得到
  `DOC-A-9274`。前端 `ProjectReadmeView` 改为显式保存/取消后，真实页面成功保存 B 版为 `v2`；同一任务
  第二次拖入处理中读取到最新文档并返回 `DOC-B-5831`，最终进入 `in_review v6`。这证明看板派发会按轮次
  读取最新项目公共背景，而不是复用首次内容。

**已知不能用、已经绕开的坑：**

- `@getpaseo/plugin/client` 的 `useAgent`/`useWorkspace` 在本机安装的 0.8.0 版本里，从**侧栏 surface**
  （`addSurface`，不是 workspace panel）调用会直接抛 `Plugin state hooks must run inside a workspace
  panel`。`AgentPanel.tsx` 因此改用 `usePaseo().agents.ref(id).refresh()` 做每 4 秒一次的轮询，只在
  任务详情页里有绑定 Agent 时才跑，卸载即清理定时器。
- `@getpaseo/plugin` 的 `server.registerSettings()` 在本机安装的 0.8.0 版本里返回 `void`（没有
  read/save 的 handle）——比公开文档描述的行为更旧；因此任务↔Agent 绑定改成插件自己的 JSON 文件存储
  （`server/bindings.ts`），不依赖 `defineSettings`。
- RPC 名称必须匹配 `/^[a-z][a-z0-9._-]*$/`（`node_modules/@getpaseo/plugin/dist/rpc.js` 里的硬校验），
  不能用 camelCase——全部 `dashi.*` RPC 已改成小写连字符形式。
- **schema 演进要小心旧数据**：`pendingWriteback`、`turnGeneration` 与 pending 的 `turnId/generation` 是后加字段，真实安装里已经有绑定 JSON 是在这些字段
  存在之前写入的，完全没有这个 key。`BindingSchema` 一开始只写了 `.nullable()`，缺 key 时是
  `undefined` 不是 `null`，校验直接失败——`getBinding` RPC 报错，UI 又把"取绑定信息失败"误当成"还没
  绑定"直接显示创建面板，掩盖了真实的加载失败。已修：schema 改成 `.nullable().default(null)`
  （向后兼容旧记录，没有改动任何现存 JSON 文件本身）；`TaskDetail.tsx` 现在会明确展示
  `bindingQuery.error` 而不是静默 fallback 成"未绑定"状态。以后再给 `Binding`/`PendingWriteback`
  加字段，同样要用 `.default(...)` 兼容已经写在磁盘上的旧记录。

**未验证 / 不应据此宣称已完成：**

- 桌面 Web 使用自包含原版 DOM/CSS；移动端仍是原生 RN 三列看板，**不提供移动端全保真原版体验**。
- 外部 Jira 账号配置、同步和真实账号交互尚未验收；不要把原版 Jira 入口视为 Paseo 已验证集成。
- 附件上传/下载、relations、活动编辑、富文本/Markdown、Mermaid、完整甘特拖动/依赖连线等原版交互没有
  逐项真实验收。原版页面能加载不等于这些功能均已通过 Paseo 桥接验证。
- 项目文档共享背景只覆盖从任务看板发起的派发；插件不会改写用户直接在 Paseo 原生会话中发送的消息，也不会
  自动同步仓库中的 `README`、扫描附件、执行 OCR 或生成背景摘要。
- `dashi.retry-writeback` 的完整真实 UI 点击路径尚未验收；其续传逻辑仅由临时真实服务测试覆盖。
- 已保存新 Agent 计划的任务卡仍可能显示通用 `P` 头像；计划已经落盘，但该负责人展示映射尚未定位和验收。
  新 Worktree 中实际发送 Agent 轮次也尚未真实验收，当前 cwd 派发仅由自动化测试覆盖。
- Paseo 自动认领开关、间隔、缺配置提示和每次最多领取一项已由 RPC/runtime 测试覆盖；专用 `PAS4` 已完成
  UI→scheduler→Agent 的上述真实宿主路径验收。自动化默认关闭；关闭不会取消已经进入领取事务的 Agent，只阻止
  后续领取。不同 provider、额度联动和更复杂的多任务调度仍未逐项验收。
  当前 SDK 无法可靠提供 provider 额度，因此仅额度联动开关不可用，主开关与间隔仍可用。插件进程重启后必须先收到
  任意插件 RPC 或 Agent lifecycle 事件以取得宿主注入的 Paseo API；在此之前不保证后台调度已启动，UI 会通过
  `schedulerReady` 明确显示状态。
- 等待权限状态已在真实 `LOCAL-7` 上确认保持未批准；插件不会自动批准权限。除该路径外，复杂权限交互和所有
  provider 的权限 UI 仍未逐项验收。

## 已知环境问题（与本插件代码无关）

本机请使用桌面版自带 CLI：`D:\APP\AI\Paseo\resources\bin\paseo.cmd`。已核验它与运行中的 daemon 均为 0.8.0；PATH 上旧的全局 CLI 无法解析当前 `agentProfiles` 配置。

以下安装脚本问题是实现会话报告的环境限制。主协调实际使用 `npm.cmd ci --ignore-scripts`、`npm.cmd run typecheck`、`npm.cmd test` 均通过。

这台机器上 `npm install`（含 postinstall 脚本）经由 `cmd.exe` 调用 `node` 时会报
`'node' is not recognized`（`workerd`/`wrangler` 的 postinstall 就是这样失败的；`npm run typecheck`/
`npm test` 这类简单脚本一般不受影响，但如果也遇到同样报错，直接用
`node node_modules/typescript/bin/tsc --noEmit` 和 `node --test --test-timeout=60000
test/dashi-api.test.ts` 绕过 shim 即可，两者本会话都已验证可用）。这是本机 PATH 配置问题，不是插件或
dashi-taskboard 代码的问题，本次交付未改动系统 PATH 或 npm 全局配置。

## 许可

本插件是 dashi-taskboard 项目的一部分，遵循仓库根目录的 Apache License 2.0（见根目录 `LICENSE`），未
新增独立许可证。
