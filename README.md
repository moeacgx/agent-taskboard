[English](README.md) | [简体中文](README.zh-CN.md)

# Agent Taskboard

基于 [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) 的扩展版本，保留原作者 Git 历史和 Apache-2.0 许可证，并增加 Paseo 任务看板插件。

Paseo 支持任务与真实 Agent 绑定、提供方和模型选择、Thinking / Mode 配置、项目及 Worktree 选择、拖动执行、自动认领、结果回写，以及项目文档共享背景。

**Paseo 安装与使用：[integrations/paseo/README.md](integrations/paseo/README.md)。** 本仓库的插件标识仍为 `dashi-taskboard`。以下保留原版功能和运行说明；原项目的发布资产不包含本仓库新增的 Paseo 插件。

本次导入基于原作者提交 `c346e8e`，不代表已同步原作者最新主分支。插件、模型和模式能力以实际 Paseo 提供的数据为准。

## 在 Paseo 中安装和使用

**正式版：[v0.3.1 下载与更新说明](https://github.com/moeacgx/agent-taskboard/releases/tag/v0.3.1)。**
下载 `agent-taskboard-paseo-v0.3.1.zip`，解压到稳定目录后，在解压目录运行
`paseo plugin install .`。安装会自动准备依赖及后台服务；无需克隆完整仓库。
升级现有安装时保留原数据目录，详见[插件安装说明](integrations/paseo/README.md#使用正式版安装包)。

### 准备环境

- 安装 [Paseo](https://paseo.sh/download)，插件要求 Paseo 0.8 或更高版本。
- 安装 Node.js 22.5 或更高版本，以及 Git。
- 在 Paseo 的 **Settings → Plugins** 中启用插件，并配置至少一个可用的 Agent 提供方。
- 以下命令在运行 Paseo daemon 的同一台机器上执行；使用与该 daemon 版本匹配的 `paseo` CLI。

### 1. 准备插件

在终端中克隆本仓库，然后安装插件依赖并准备后台运行文件：

```bash
git clone https://github.com/moeacgx/agent-taskboard.git
cd agent-taskboard
cd integrations/paseo
npm ci --ignore-scripts
npm run prepare:runtime
```

不需要保留终端运行。插件加载时自动启动本地后台，默认监听 `http://127.0.0.1:47823`，已有健康服务会直接复用。

### 2. 安装 Paseo 插件

继续在 `integrations/paseo` 目录中执行：

```bash
npm run typecheck
paseo plugin install .
paseo plugin ls
```

确认 `dashi-taskboard` 状态为 `running`，然后打开 Paseo 侧栏的 **任务看板**。仓库已包含插件所需的自包含页面，无需另外启动前端开发服务器。

Windows 默认沿用 `%LOCALAPPDATA%/DashiPaseo` 数据目录。已有数据存放在其它位置时，先通过
`DASHI_TASKBOARD_DATA_DIR` 指定原目录；不要删除数据库。若设置 `DASHI_TASKBOARD_URL`，表示连接自行管理的外部服务，
插件不会启动或停止该服务。

### 3. 创建并执行任务

1. 在任务看板选择或创建项目，点击 **新建议题**。
2. 填写任务要求，选择提供方、模型、Thinking / Mode，以及项目根目录或 Worktree。
3. 保存后，将任务拖入 **处理中**，插件会创建或继续绑定的 Paseo Agent。
4. Agent 完成后，结果自动写入任务评论，任务进入 **等你确认**；人工验收后再标记完成。
5. **项目文档**可填写共享背景；从看板发起的每轮执行会读取最新文档。自动认领默认关闭，需要时在项目自动化菜单中开启。

### 让 Agent 帮你安装

可以把下面这段提示词复制到有本机终端权限的 Paseo、Codex 或 Claude Code 对话中。安装位置必须是 **Paseo daemon 所在的机器**；仅能聊天、无法执行命令的 Agent 不能代为安装。

```text
请帮我安装并验证 Agent Taskboard 的 Paseo 插件，直接完成可执行步骤，不要只给安装计划。

仓库：https://github.com/moeacgx/agent-taskboard

先检查操作系统、Git、Node.js 和 Paseo 的安装情况，确认当前机器是目标 Paseo daemon 所在机器。
阅读仓库 README.md、integrations/paseo/README.md 及适用的 AGENTS.md，按当前版本说明操作。

执行要求：
1. 使用稳定的本地目录克隆仓库；如果已有克隆或安装，先检查状态，保留已有修改和任务数据。
2. 检查 Node.js 版本要求，以及与 daemon 匹配的 Paseo CLI。
   缺少依赖时明确说明；涉及全局安装、系统配置或启用可信插件时，先征得我同意。
3. 核对已有数据库位置，必要时指定 DASHI_TASKBOARD_DATA_DIR，保留已有项目和任务。
   若已有服务，先核对归属和可用性；不要终止不属于本次安装的进程。
4. 在 integrations/paseo 安装依赖、运行 prepare:runtime 和 typecheck，
   再使用 Paseo CLI 安装或重新加载 dashi-taskboard 插件，不要重启整个 daemon。
5. 确认数据服务可访问、插件状态为 running。
   有界面操作能力时，打开 Paseo 侧栏“任务看板”验证；没有则明确列出尚未验证的界面步骤。
6. 不要创建或启动执行任务、打开自动认领、代批 Agent 权限或修改我的现有任务。

最后告诉我：
- 仓库、插件和数据分别放在哪里；
- 哪些检查实际通过，哪些仍需我操作；
- 日常如何启动、如何停止本次启动的数据服务、如何更新插件。

请验证插件能自动启动本地 Dashi 服务，不需要保留终端或打开原版看板窗口。
只有显式配置 DASHI_TASKBOARD_URL 时才使用自行管理的外部服务。
不要在回复中输出密钥、令牌或其他凭据。
```

### 日常启动与更新

**插件由 Paseo 自动加载并启动本地看板数据服务，不需要单独打开原版看板窗口或保留终端。** 外部 URL 模式由用户自行管理服务。

安装后不要移动或删除插件源码目录。拉取更新后，按上述步骤更新依赖、运行类型检查，再执行：

```bash
paseo plugin reload dashi-taskboard
```

服务不在默认地址时，通过 `DASHI_TASKBOARD_URL` 配置插件连接地址。更多设置、数据目录和功能边界见 [Paseo 插件说明](integrations/paseo/README.md)。

## 原版 Codex Taskboard

A local-first issue board that runs in a browser and can be embedded in Codex through the standalone CDP launcher or its injection script. The same HTTP API powers the React UI and the `taskctl` CLI used by the bundled Codex Skill.

![Codex Taskboard product screenshot](docs/assets/codex-taskboard.png)

## Requirements

- Node.js 22.5 or newer
- macOS App and DMG builds: Xcode Command Line Tools and Rust 1.88 or newer with the `aarch64-apple-darwin` and `x86_64-apple-darwin` targets. `npm install` installs the Tauri CLI used by this project.
- Windows NSIS builds: the Microsoft Store Codex App, Rust 1.88 or newer, and Visual Studio Build Tools with the C++ workload and Windows SDK.

## Run locally

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:47823>. The SQLite database is stored at `.data/taskboard.sqlite`.

For development with live frontend reload:

```bash
npm run dev
```

The Vite UI runs at <http://127.0.0.1:5173> and proxies API requests to the local service.

## Use the CLI

Run it from the project:

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

Use `npm link` if you want `taskctl` on your shell path. Set `CODEX_TASKBOARD_URL` to point the CLI at another local or LAN service. Cloud deployments are configured through the **loopback companion** (device-local loopback service for auth and path mapping—not a chat persona) with `taskctl cloud login`.

## Install the Codex Skill

Copy or symlink `skills/manage-taskboard` into the Codex skills directory, then start a new Codex task:

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.agents/skills/manage-taskboard
```

The desktop app keeps this same directory synchronized with its bundled Skill. The Skill teaches Codex to inspect an issue, move it to `in_progress`, use optimistic versions, verify the work, and then move it to `in_review`; it moves the issue to `done` only after the user explicitly confirms acceptance or asks to mark it complete.

## Embed in Codex

### Manual: use a dedicated CDP port

Keep the existing Codex window open. From the Taskboard repository, start a second Codex instance with a dedicated CDP port:

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

After the new Codex window appears, run the injector in another terminal:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

Keep the injector terminal running while using the embedded panel. The original Codex window remains unchanged, and the new window receives the Taskboard sidebar entry. If port `9231` is occupied, use another port in both commands.

### Recommended: launch an independent Taskboard window with one command

Keep existing Codex windows open and run:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

This starts the local Taskboard service when needed. It reuses an open Codex with a reachable CDP renderer, opens Taskboard in the native browser panel of an ordinary Codex without CDP, or launches the official macOS Codex app with an independent profile and loopback-only port `9231` when no Codex is open. It injects a native-looking Taskboard entry after Plugins when CDP is available and keeps watching both the service and replacement renderers. Keep this command running while using the embedded panel. The launcher does not modify `ChatGPT.app` or its `app.asar`.

The source launcher writes its authenticated endpoint to `.data/launcher-runtime.json`. A `taskctl` command installed with `npm link` reads this file by default, so a normal shell and a Codex task opened from the panel use the same Taskboard service without an extra environment variable.

### macOS App: open and inject without a terminal

For Tauri development, run:

```bash
npm run app:dev
```

To build the local App and DMG, install the two Rust targets once, then run the build:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run app:build
```

Open `src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app` from Finder. The DMG is in `src-tauri/target/universal-apple-darwin/release/bundle/dmg/`. If you only want the stable App, download the current DMG from [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases/latest).

The App contains its own Node runtime, Taskboard service, built web UI, Skill, CLI wrapper, and injection script. It starts the service, reuses an open Codex with a reachable CDP renderer, opens Taskboard in the native browser panel of an ordinary Codex without CDP, or launches the official Codex app when no Codex is open. It waits for the renderer, injects the sidebar entry when CDP is available, and opens the panel without showing a terminal window. The App can be copied away from this checkout; the target Mac only needs the official Codex app and does not need this repository, a system Node installation, or a separate Codex CLI installation. Taskboard data is stored in `~/Library/Application Support/Codex Taskboard`, and launcher output is written to `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log`.

### Linux App: Ubuntu 24.04 x64 packages

The first Linux desktop release supports Ubuntu 24.04 LTS on x64 only. Install the official ChatGPT desktop `.deb` first and confirm that `chatgpt` opens it. Then download either the Codex Taskboard `.deb` or `.AppImage` from [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases/latest). Replace `<file>` below with the downloaded filename.

Install the `.deb` package:

```bash
sudo apt install ./<file>.deb
```

Or run the AppImage:

```bash
chmod +x ./<file>.AppImage
./<file>.AppImage
```

To build both packages on Ubuntu 24.04 x64, run:

```bash
npm ci
npm run app:build:linux:x64
```

This first release does not support ARM64, Fedora, RPM packages, or other Linux distributions.

### Windows code signing

For official Windows releases after the application is approved: **Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).** Current Windows CI artifacts remain unsigned until that approval. See the [Code signing policy](docs/code-signing-policy.md), [Privacy policy](PRIVACY.md), and [Windows uninstall instructions](docs/windows-uninstall.md).

The local build uses ad-hoc code signing for direct verification. A public macOS download still needs Developer ID signing and Apple notarization.

### Windows App: tray launcher and bundled Taskboard

Install the official Codex App from the Microsoft Store. To build the current-user NSIS installer on Windows x64, run:

```powershell
npm ci
npm run app:build:windows
```

The installer is written to `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. It installs a tray launcher, bundled Node runtime, local service, built web UI, Skill, `taskctl.cmd`, and injection script. Taskboard data is stored in `%APPDATA%\Codex Taskboard`; logs are stored in `%LOCALAPPDATA%\Codex Taskboard\Logs`; the Skill is copied to `%USERPROFILE%\.agents\skills\manage-taskboard`.

Windows CI artifacts are intentionally unsigned and do not auto-update. Review [the code-signing policy](docs/code-signing-policy.md) before distributing a build. See [Windows uninstall](docs/windows-uninstall.md) for retained-data behavior.

Codex 26.715.52143 ships a renderer CSP that blocks arbitrary HTTP iframes. The launcher therefore enables CDP CSP bypass, reloads that renderer once, installs the document-start script, and waits until the Taskboard OOPIF is actually loaded. CDP is unauthenticated to other processes on the same machine, so only run trusted local code while the launcher is active.

To inject into a Codex instance that was already launched with CDP by another method, run:

```bash
npm run codex:inject -- --port 9229 --open
```

This command also stays resident so the injected tab can restart Taskboard after a service exit. Stop it with `Ctrl-C`.

The script adds a Taskboard entry to the Codex sidebar and renders the iframe across Codex's complete main workspace, including the contextual titlebar area so Taskboard's own header does not leave an empty strip. That full rectangular header is placed above Electron's draggable layer and marked `no-drag`; because the native contextual actions are suppressed while Taskboard is active, its own actions use their normal edge padding without an artificial right-side gap. The native sidebar stays mounted, while the previous page selection and contextual header are temporarily suppressed; choosing another Codex page restores them.

“在对话中打开” selects the corresponding native Codex project when one is available and opens an unsent native composer with an `e-taskboard` instruction and the issue's actual identifier. The installed Skill is selected implicitly from that instruction, so the composer does not add a `$manage-taskboard` mention. A conversation is attributed only after it actually processes the issue: `taskctl` reads Codex's `CODEX_THREAD_ID` and records that ID on the issue or comment mutation. Recorded IDs are clickable through Codex's native route bridge. Each issue can bind either one Git branch or one worktree; the options are scanned from the selected Codex project's repository instead of being typed by hand. The integration uses Codex's existing project, composer, and route markers; it does not patch React, replace `fetch`, load private chunks, or edit Codex data files.

To use a different UI origin, set `window.__CODEX_TASKBOARD_URL__` before the user script runs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP bind address; use `127.0.0.1` to disable LAN access |
| `CODEX_TASKBOARD_PORT` | `47823` | Local HTTP port |
| `CODEX_TASKBOARD_TRUSTED_ORIGINS` | unset | Comma-separated exact HTTPS origins allowed through a loopback reverse tunnel |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite data directory |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API origin |

`npm start` prints both the local URL and the available LAN URLs. Teammates on the same trusted network can open one of those LAN URLs and use the same taskboard service. Task, comment, and attachment changes are broadcast to every open client through server-sent events; reconnecting clients perform a full refresh so changes made while disconnected are not missed. A teammate using `taskctl` can point it at the shared service with `CODEX_TASKBOARD_URL=http://<host-ip>:47823`.

LAN mode has no account authentication: anyone on the trusted local network who can reach the URL can read and write the taskboard. Public internet and cloud deployment require an authenticated deployment boundary.

For a reverse tunnel that connects to the local listener, set `CODEX_TASKBOARD_TRUSTED_ORIGINS` to the tunnel's public HTTPS origin, for example `https://board.example.test`. Multiple origins are comma-separated. The variable cannot be empty, and duplicate origins (including normalized forms such as a trailing slash or default HTTPS port) are rejected at startup. Entries must otherwise be exact HTTPS origins; paths, queries, fragments, credentials, and wildcards are rejected. A reverse proxy or tunnel can preserve that public `Host`: Taskboard derives its canonical HTTPS origin and requires an exact configured match. If the browser supplies an `Origin`, that header is validated independently; the proxy must preserve it rather than fabricate one. Forwarded headers are not used for either decision. Configured public hosts and trusted origins can use ordinary Taskboard HTTP and realtime endpoints, but device-local capability routes remain unavailable even though the tunnel socket is loopback. Requests using only direct local or private-LAN hosts and origins keep their existing behavior.

## Share through Cloudflare

For two trusted collaborators, the taskboard can run on Cloudflare with Worker Static Assets and API routes, D1 as the authoritative business database, and a private R2 bucket for attachments. The deployment uses HTTPS Basic Authentication with a shared password and refreshes open boards after a global revision changes.

Each device keeps its own project checkout mapping and continues to use a local companion for Codex, Git/worktree, Skill, and MCP capabilities. Cloud mode never falls back to or double-writes the local SQLite database.

See [Cloud collaboration](docs/cloud-collaboration.md) for owner deployment, existing GitHub installation setup, password rotation, local path mapping, and the one-time local-data migration flow.

## Verify

```bash
npm run check
```

This runs TypeScript checking, a production frontend build, the component tests, and the server/CLI/injection test suite.

## Task Markdown

Task descriptions and comments support GFM, including tables and task lists. Fenced `mermaid` blocks are rendered as read-only diagrams after the viewer loads; the diagram source remains available when rendering fails. Markdown HTML comments, such as `<!-- trace-analysis:v1 ... -->`, are hidden from the rendered document. Raw HTML is not enabled.
