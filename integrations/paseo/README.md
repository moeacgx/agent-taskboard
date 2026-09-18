# Dashi Taskboard for Paseo

这是 Dashi Taskboard 的 Paseo 0.8 插件。它把 Dashi 的项目和任务界面接入 Paseo，并将任务执行映射到真实的
Paseo Workspace、Agent、Provider 和生命周期事件。

桌面 Web 端加载自包含的原版 Taskboard 页面；Paseo 负责宿主身份、导航、Agent、Workspace 和插件 RPC，
Dashi 服务负责项目、任务、评论、附件和项目文档等持久化数据。

## 前提条件

- Paseo `>=0.8.0`，并已在 **Settings → Plugins** 启用插件功能。
- 满足仓库根目录 `package.json` 要求的 Node.js 版本。
- Dashi Taskboard 服务必须独立运行。插件不会启动、停止或重启 Dashi 服务。
- 插件是可信、非沙箱代码。仅安装已审查的源码。

## 启动 Dashi 服务

先在仓库根目录安装依赖并启动服务：

```bash
git clone https://github.com/moeacgx/agent-taskboard.git
cd agent-taskboard
npm install --ignore-scripts
node server/index.mjs
```

服务默认监听 `http://127.0.0.1:47823`。可通过环境变量调整：

- `CODEX_TASKBOARD_HOST`：Dashi 监听地址。
- `CODEX_TASKBOARD_PORT`：Dashi 监听端口。
- `CODEX_TASKBOARD_DATA_DIR`：Dashi 数据库和附件目录。

插件通过 `DASHI_TASKBOARD_URL` 连接 Dashi；未设置时使用默认地址。插件不会自动发现或拉起其它 Dashi 实例。

## 安装插件

在克隆目录中安装插件依赖并检查类型：

```bash
cd integrations/paseo
npm ci --ignore-scripts
npm run typecheck
```

然后回到克隆目录并安装插件：

```bash
cd ../..
paseo plugin install ./integrations/paseo
paseo plugin ls
```

源码更新后先重新运行类型检查，再加载插件：

```bash
paseo plugin reload dashi-taskboard
```

不要通过重启 Paseo daemon 来加载源码变更；daemon 重启可能中断正在运行的 Agent。

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

项目文档增强只覆盖从 Taskboard 发起的派发。用户直接在 Paseo 原生会话中输入的消息不会被插件改写。插件也不会
同步仓库中的 `README`、扫描附件、执行 OCR 或自动生成背景摘要。

生命周期写回规则：

- `completed`：追加实际回复评论，并移动到 `in_review`。
- `failed`：记录错误，并移动到 `blocked`。
- `canceled`：记录取消评论，不自动改变任务状态。

插件不会自动把任务置为 `done`。评论与状态写回失败会保存为待重试状态，避免已经成功的评论被重复发布。

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

当前测试套件包含 **48 项测试**，单项超时为 60 秒。测试使用临时 Dashi 数据和模拟 Paseo SDK，覆盖主要 API、
任务移动与派发、绑定存储、自动化、Worktree、写回恢复及 turn 所有权。通过测试表示源码行为满足这些契约，不等同于
所有 Paseo 宿主和外部服务组合都已完成实机验收。

## 已知边界

- 桌面 Web 使用自包含原版 DOM/CSS；移动端是紧凑的 React Native 看板，不提供桌面原版的全保真体验。
- 外部 Jira 账号配置与同步需要在目标环境单独验证。
- 附件、任务关系、活动编辑、Markdown/Mermaid 和甘特依赖交互虽保留原版入口，但仍应按发布环境逐项验证。
- 现有 Agent 的运行配置只能通过当前公开 SDK 读取，不能由插件内直接修改。
- Provider、模型、Mode、Thinking、权限和 feature 能力以所连接 Paseo daemon 的实时目录或会话快照为准。
- Dashi 服务不可用时，插件会报告连接错误，不会启动备用服务或切换到其它数据源。

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
