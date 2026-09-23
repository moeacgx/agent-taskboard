# Dashi Taskboard for Paseo

这是 Dashi Taskboard 的 Paseo 0.8 插件。它把 Dashi 的项目和任务界面接入 Paseo，并将任务执行映射到真实的
Paseo Workspace、Agent、Provider 和生命周期事件。

桌面 Web 端加载自包含的原版 Taskboard 页面，手机端使用原生界面；Paseo 负责宿主身份、导航、Agent、Workspace 和插件 RPC，
Dashi 服务负责项目、任务、评论、附件和项目文档等持久化数据。

## 前提条件

- Paseo `>=0.8.0`，并已在 **Settings → Plugins** 启用插件功能。
- 满足仓库根目录 `package.json` 要求的 Node.js 版本。
- 默认由插件启动和维护本地 Dashi 服务，不需要额外打开终端运行。
- 插件是可信、非沙箱代码。仅安装已审查的源码。

## 准备后台运行文件

以下是源码安装方式；已下载正式版 ZIP 的用户直接按下一节操作，不需要生成 runtime。

源码安装时先生成插件内的后台运行文件：

```bash
git clone https://github.com/moeacgx/agent-taskboard.git
cd agent-taskboard
cd integrations/paseo
npm ci --ignore-scripts
npm run prepare:runtime
```

安装依赖时保留开发依赖，不使用 `--omit=dev`。Paseo 宿主构建插件时需要 SDK 类型包；仅后台 Node 进程能启动，并不代表宿主能够加载插件。

插件启动时等待服务就绪，并检测自己管理的后台进程是否需要恢复；已有健康服务只复用，不会被插件停止。
服务默认只监听 `http://127.0.0.1:47823`。可通过环境变量调整：

- `CODEX_TASKBOARD_PORT`：Dashi 监听端口。
- `DASHI_TASKBOARD_DATA_DIR`：数据库和附件目录，也兼容 `CODEX_TASKBOARD_DATA_DIR`。
- `DASHI_TASKBOARD_NODE`：Node.js 可执行文件的绝对路径，未设置时自动查找。
- `DASHI_TASKBOARD_SOURCE_DIR`：可选的 Dashi 源码根目录；独立安装默认使用包内 `runtime`。

Windows 默认数据目录为 `%LOCALAPPDATA%/DashiPaseo`；macOS 为 `~/Library/Application Support/DashiPaseo`；
Linux 为 `$XDG_DATA_HOME/DashiPaseo`，未设置时使用 `~/.local/share/DashiPaseo`。
升级前若原数据库位于其它位置，明确设置数据目录指向原位置，不会自动迁移或删除旧数据。

显式设置 `DASHI_TASKBOARD_URL` 表示连接外部服务，插件不会启动、停止或接管它。此模式仍需自行管理外部服务。

Paseo 安装构建会自动执行 `scripts/prepare-installation.mjs`，将实际安装目录和包版本写入本机生成文件，供宿主打包使用。
手动复制插件文件到固定安装目录时，也要先在该安装目录运行此脚本，再 reload。不要将带有本机路径的生成文件提交或发布；
仓库中的 `server/plugin-installation.generated.ts` 保留空路径模板。

## 使用正式版安装包

1. 从 [GitHub Releases](https://github.com/moeacgx/agent-taskboard/releases/latest) 下载 `agent-taskboard-paseo-v0.3.1.zip` 和 `SHA256SUMS.txt`。
2. 核对 ZIP 的 SHA-256 后，解压到长期保留的目录。包内已包含后台 runtime、自包含页面、依赖锁文件和安装准备脚本。
3. 在解压后的插件目录运行：

```bash
paseo plugin install .
paseo plugin ls
```

Paseo 会安装完整依赖并生成当前机器的安装信息。状态为 `running` 后打开侧栏“任务看板”；无需手动启动后台。
安装包支持有 Node.js 22.5+ 的 daemon 主机；本版实测环境为 Windows / Paseo 0.9.0-beta.2，其他系统及手机真机尚未完整验收。

更新已有固定目录安装时，退出该插件页面，将 ZIP 内文件覆盖到原插件目录，保留原数据库、附件和插件设置目录，随后在插件目录执行：

```bash
npm ci --ignore-scripts
node scripts/prepare-installation.mjs
paseo plugin reload dashi-taskboard
```

不要删除数据库、附件或插件设置目录；更新检测只提示新版本，不自动安装。正式包中的 `prepare:runtime` 仅供完整源码仓库开发，不用于 ZIP 升级。

## 安装插件

在克隆目录中安装插件依赖并检查类型：

```bash
cd integrations/paseo
npm ci --ignore-scripts
npm run prepare:runtime
npm run typecheck
```

然后回到克隆目录并安装插件：

```bash
cd ../..
paseo plugin install ./integrations/paseo
paseo plugin ls
```

源码更新后重新生成后台运行文件并检查类型，再加载插件：

```bash
npm run prepare:runtime
npm run typecheck
paseo plugin reload dashi-taskboard
```

不要通过重启 Paseo daemon 来加载源码变更；daemon 重启可能中断正在运行的 Agent。

## 发布与更新检测

仪表盘会在打开时检查 `moeacgx/agent-taskboard` 的 GitHub Releases，也可手动再检查一次。有新版本时显示版本号、发布时间和更新说明；没有新版本时显示“当前已是最新版”，尚无正式 Release 时明确提示未发布。检查失败不会影响看板使用。

检测和安装是分开的：插件不会自动下载或替换正在运行的代码，避免打断正在执行的任务。发版时：

1. 更新 `integrations/paseo/package.json` 的 `version`，该值会作为当前安装版本写入插件。
2. 在 GitHub 创建 Release（tag 如 `v0.3.1`），并填写更新说明。
3. 用户在仪表盘看到提示后，按本页“安装插件”步骤拉取新版本并执行 `paseo plugin install ./integrations/paseo`，再用 `paseo plugin reload dashi-taskboard` 加载。

## 数据与配置

Dashi 的项目和任务数据由 Dashi 服务存储。插件只通过其 HTTP API 读写，不修改数据库结构。

插件自己的状态默认位于：

```text
~/.paseo/plugin-data/dashi-taskboard/
```

其中包括：

- 任务与 Paseo Agent 的绑定。
- 项目自动化设置。
- 任务级 Agent 执行计划。

可用 `DASHI_TASKBOARD_PLUGIN_DATA_DIR` 修改插件状态目录。

## 主要功能

### 原版桌面界面

桌面 Web surface 使用自包含 `srcDoc` 加载原版 React/CSS 页面，通过带 challenge、source 和请求 ID 校验的
`postMessage` 桥调用父插件。iframe 不直接访问本机 Dashi 地址，也不获得同源权限。

原版界面包含 Dashboard、看板、列表、甘特图、任务详情、筛选排序、项目文档和相关任务操作。默认看板保留三列
语义：

- **等待认领**：任务已准备，但不会自动启动 Agent。
- **处理中**：用户拖入后创建或继续绑定的 Paseo Agent。
- **等你确认**：Agent 成功结束后等待人工验收。

已完成、已取消和已归档任务通过独立终态入口查看。

### 动态负责人

负责人选择来自当前 Paseo daemon 的真实数据：

- 当前启用且可用的 Provider 及完整模型目录。
- 用户保存的 Agent Profile。
- 未归档的现有 Agent 会话。
- Paseo Project 根目录以及已打开的 Workspace/Worktree。

Project 根目录和 Workspace 按实际路径去重，Project 根优先显示。Project 选择 ID 仅用于界面状态；任务计划始终
保存真实目录路径，后续由 `workspaces.open(path)` 打开。

选择新 Agent 配置只保存任务计划，不会立即创建或发送 Agent。选择现有 Agent 只建立绑定，也不会发送消息。
只有用户明确将任务移入“处理中”、执行重试或启用项目自动认领时才会派发。

新 Agent 计划可保存 Provider、Model、Mode、Thinking 和 Provider feature 默认值。若 Paseo 没有为某个 Provider
提供可选 Mode，插件使用 Provider 默认行为，不据此断言 Provider 本身不支持 Mode。公开 SDK 不提供现有会话的
配置修改能力，因此现有 Agent 的 Mode/Thinking 只读；调整需在 Paseo 中完成。

### 移动到其他项目

在本地议题右键菜单中选择“移动到其他项目”，搜索目标项目后确认。移动保留原议题的 ID、编号、内容、评论、附件和
显式执行配置，不复制任务，也不启动 Agent；未单独指定的执行配置会使用目标项目的默认值。

已绑定的空闲 Paseo 会话保持原样，只同步任务归属；正在运行或等待权限时不能移动。存在父子、依赖或相关任务关系时，
需要先解除关联。Jira 同步议题和项目不参与此操作。

### 合并等待认领想法

同一项目中至少两个未归档的 `backlog/todo` 可以合并为一个新的 `todo`。合并表单统一选择 Agent Profile、
Provider/Model、Mode、Thinking 和工作区，但合并本身只保存 planned 配置，不创建或发送 Agent。

新任务汇总源任务的标题、描述、人工评论和附件引用。源任务通过 `related` 关系保留并归档，可在终态入口恢复；
自动认领不会再执行这些已归档来源。已绑定 Paseo Agent 的任务不能作为合并来源。

合并使用预分配 UUID 作为幂等操作 ID。执行计划先于 Dashi 原子创建/关联/归档事务持久化，因此新任务一旦可见就
已经带有用户选择的计划。响应丢失后复用同一操作 ID 只返回原任务和原计划，不会重复创建或用重试表单覆盖配置。

### Workspace 与 Worktree

工作区选择同时展示 Paseo Project 根目录和当前 Workspace/Worktree。创建 Worktree 使用公开的
`paseo.workspaces.create()` 接口，由 Paseo 管理实际目录并登记 Workspace。

插件仅允许从真实 Git 根目录创建 Worktree。可基于当前分支创建新分支，或检出尚未被其它 Worktree 使用的已有
分支。任务使用 Worktree 后，后续新 Agent 的 cwd 以任务开发上下文为准；已绑定到其它 cwd 的 Agent 不会被静默
切换。

### 派发与生命周期

看板拖动、自动认领和手动重试共享同一派发路径：

1. 读取任务、人工评论和所属项目的最新项目文档。
2. 在任何任务状态移动、轮次武装或 Agent 发送前构造提示词。
3. 创建或继续 Paseo Agent，并记录本轮真实 turn 所有权。
4. 根据生命周期结果写回评论和任务状态。

提示词优先级是：

```text
最新人工要求 > 当前任务的具体要求与原始描述 > 项目公共背景
```

空项目文档会省略；项目文档或评论读取失败时，本轮不会在缺失公共规范的情况下继续执行。详情页首次启动发送完整
任务提示；后续继续只加入最新项目背景和本次人工要求，不重复发送旧的完整提示。

新会话只发送任务描述和最新人工要求中引用的图片；已有会话的自动继续只发送最新人工要求中引用的图片，详情页显式继续只发送本次 message 中引用的图片。

同一附件在一轮中只发送一次；图片不存在或读取失败时，在移动任务、准备派发和发送之前报错。历史人工补充中的图片不会再次附发。会话展示将较早要求中的图片替换为历史图片说明，本轮图片可通过缩略图打开大图；已经发送给模型的历史图片不会撤回。未被上述正文引用的独立附件、项目说明中的图片尚不在发送范围内。

桌面任务详情的评论输入框位于活动区顶部。历史记录按最新优先展示，初次显示 20 条，下滑或点击“加载更早记录”再显示下一批；切换任务后恢复首批，尚未展开的图片不会挂载加载。当前评论和活动的文字数据仍由原接口读取，分批展示不改变任务历史。

Paseo 卡片保留任务标题，在下方显示最新一条评论或 Agent 回复的简短预览，封面也来自同一条评论；最新评论没有图片时不沿用旧图。没有评论时按原显示设置回退到任务描述。

已绑定 Agent 的任务在“等你确认”或“遇到阻碍”时，可以点击“评论并继续处理”：先保存本次文字和图片，再让原 Agent 继续，任务直接进入“处理中”。普通“评论”和 Ctrl+Enter 只保存意见。Agent 正在运行或等待权限时禁用继续；派发失败可重试已保存评论，网络超时会提示结果未确认，不自动重发。

项目文档增强只覆盖从 Taskboard 发起的派发。用户直接在 Paseo 原生会话中输入的消息不会被插件改写。插件也不会
同步仓库中的 `README`、扫描附件、执行 OCR 或自动生成背景摘要。

生命周期写回规则：

- `completed`：追加实际回复评论，并移动到 `in_review`。
- `failed`：记录错误，并移动到 `blocked`。
- `canceled`：记录取消评论，不自动改变任务状态。

插件不会自动把任务置为 `done`。评论与状态写回失败会保存为待重试状态，避免已经成功的评论被重复发布。

### 项目默认执行配置

创建项目时，可选默认 Agent（模型、Thinking、Mode）和代码工作目录；已有项目可通过“项目设置”修改。
两项都不填就是自由项目，也可以只设置其中一项。项目设置与自动化菜单使用同一份默认配置。
项目列表每行的“更多”按钮提供编辑和删除入口，项目设置也支持修改项目名称。普通本地项目不受 ID 前缀限制，
删除前显示确认弹窗；仅允许删除没有任务的项目，归档任务也计入检查。系统默认项目和 Jira 项目不可删除。

在项目内新建想法只需填写标题和描述。执行时，Agent 和目录分别按“任务自己的设置 → 项目当前默认值”取值；
任务显式指定的 Worktree 优先于其它目录。例如任务只改用 Grok，代码目录仍沿用项目默认目录。
任务没有单独配置的字段不会复制为固定计划，修改项目默认值后，尚未启动且继承该字段的任务会使用新值。
已绑定 Agent 的任务继续使用原会话，不会因修改默认配置而切换 Agent 或目录。

保存默认配置不会启动 Agent，也不会开启自动认领。自由项目或缺少必要配置的任务可以先记录想法，补齐配置后再执行。

### 项目自动认领

自动化默认关闭，必须由用户针对项目显式启用。启用后，scheduler 按配置间隔从未归档的 `todo/backlog` 中每轮最多
领取一个任务，并复用该任务的既有绑定、任务计划或项目默认配置。

缺少真实 Workspace/Profile 配置的任务会保持等待状态，不会回退到目录中的第一个 Provider 或 Workspace。关闭
自动化会阻止后续领取，但不会擅自取消已经启动的 Agent。当前 SDK 无法可靠提供统一额度判断，因此额度联动不是
可依赖能力。

插件进程启动后需要先通过一次插件 RPC 或 Agent 生命周期事件取得 Paseo API，之后后台 scheduler 才能工作；界面
通过 `schedulerReady` 展示这一状态。

### 权限与并发

- 运行中或等待权限的 Agent 不会被重复派发。
- 插件不会自动批准权限；用户需在 Paseo 中处理权限请求。
- 每个任务的移动、派发和生命周期写回通过同一任务级 FIFO 串行。
- turn ID 与 generation 用于拒绝迟到的旧轮次结果，避免覆盖新一轮任务状态。
- 同一个 Agent 不能同时绑定多个任务。

## 验证

在 `integrations/paseo` 中运行：

```bash
npm run typecheck
npm test
```

测试套件的单项超时为 60 秒，数量以当前 `npm test` 输出为准。测试使用临时 Dashi 数据和模拟 Paseo SDK，覆盖主要 API、
任务移动与派发、绑定存储、自动化、Worktree、写回恢复及 turn 所有权。通过测试表示源码行为满足这些契约，不等同于
所有 Paseo 宿主和外部服务组合都已完成实机验收。

## 已知边界

- 当前源码的手机原生界面默认进入仪表盘，顶部切换项目，主导航提供仪表盘、议题和项目说明。仪表盘展示真实任务统计、完成度、需要关注和运行中的 Agent；项目说明支持显式编辑、保存与取消。
- 手机原生界面支持项目创建、编辑、删除确认，项目默认 Agent、Thinking、Mode 和可选目录，任务执行配置、状态移动、自动认领开关与间隔，以及 Agent 权限等待提示和打开会话。列表及已完成、已取消、归档视图放在议题页“更多”。
- 手机配置目录使用与桌面相同的完整 Project/Workspace 目录；任务未指定的执行配置按字段继承项目默认值。
- 桌面 Web 使用自包含原版 DOM/CSS；手机使用 React Native。桌面的多选拖拽合并、仪表盘更新面板等不代表已在原生手机端提供。当前未完成 iOS/Android 真机验收。
- 外部 Jira 账号配置与同步需要在目标环境单独验证。
- 附件、任务关系、活动编辑、Markdown/Mermaid 和甘特依赖交互虽保留原版入口，但仍应按发布环境逐项验证。
- 现有 Agent 的运行配置只能通过当前公开 SDK 读取，不能由插件内直接修改。
- Provider、模型、Mode、Thinking、权限和 feature 能力以所连接 Paseo daemon 的实时目录或会话快照为准。
- 本地服务不可用时，插件会尝试在原数据目录启动并等待健康检查；启动失败显示实际错误，不会切换数据源。外部 URL 模式不自动拉起服务。

## 目录概览

```text
integrations/paseo/
  index.client.tsx       Paseo 客户端入口
  index.server.ts        Paseo daemon 插件入口
  client/                surface、父桥和移动端界面
  server/                Dashi API、派发、自动化、生命周期与插件存储
  shared/                Zod RPC 契约和共享类型
  test/                  插件单元与主路径测试
  paseo-plugin.json      插件清单
```
