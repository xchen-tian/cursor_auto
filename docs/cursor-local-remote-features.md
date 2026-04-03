# cursor-local-remote 功能详解

> 仓库：[jon-makinen/cursor-local-remote](https://github.com/jon-makinen/cursor-local-remote) v0.1.15
> 技术栈：Next.js 15 + React 19 + TypeScript (ESM) + Tailwind v4 + sql.js + xterm.js

---

## 目录
/
1. [CLI 启动与连接](#1-cli-启动与连接)
2. [认证系统](#2-认证系统)
3. [AI 对话（聊天）](#3-ai-对话聊天)
4. [模型与模式切换](#4-模型与模式切换)
5. [实时流式更新](#5-实时流式更新)
6. [Tool Call 可视化](#6-tool-call-可视化)
7. [会话管理](#7-会话管理)
8. [多项目切换](#8-多项目切换)
9. [Git 面板](#9-git-面板)
10. [远程终端](#10-远程终端)
11. [QR 码连接](#11-qr-码连接)
12. [设置面板](#12-设置面板)
13. [通知系统](#13-通知系统)
14. [消息队列](#14-消息队列)
15. [图片上传](#15-图片上传)
16. [会话导出](#16-会话导出)
17. [PWA 支持](#17-pwa-支持)

---

## 1. CLI 启动与连接

### 功能

通过命令行启动 Next.js 服务，在局域网内暴露 Web UI，任何设备通过浏览器访问即可控制 Cursor。

### 实现文件

| 文件 | 作用 |
|------|------|
| `bin/cursor-remote.mjs` | CLI 入口，解析参数、自动端口探测、生成 token、打印 QR 码、启动 Next.js |

### 使用方法

```bash
# 全局安装
npm install -g cursor-local-remote

# 在项目目录下启动（默认端口 3100）
clr

# 指定项目路径
clr ~/projects/my-app

# 指定端口
clr --port 8080

# 使用固定 token
clr --token my-secret

# 仅绑定 localhost
clr --host 127.0.0.1

# 禁用自动审批
clr --no-trust

# 查看所有运行中的实例
clr --status

# 列出所有已知项目
clr --list

# 更新到最新版
clr --update
```

启动后终端会显示：
- ASCII art logo
- Workspace 路径
- Local 和 Network URL
- Auth token（如 `alpine-berry`）
- QR 码（手机扫码直连）

端口被占用时自动递增查找可用端口（最多尝试 20 个）。

---

## 2. 认证系统

### 功能

三重认证方式保护 Web UI，防止局域网内未授权访问。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/middleware.ts` | Next.js 中间件，拦截所有请求进行认证 |
| `bin/cursor-remote.mjs` | Token 生成逻辑（随机单词对） |

### 认证方式

1. **URL Token**：访问 `http://host:port?token=xxx`，自动设置 httpOnly cookie（有效期 7 天）
2. **Cookie**：`cr_session` cookie 持有 token 值
3. **Bearer Token**：API 调用时 `Authorization: Bearer xxx`

### 使用方法

- **扫码**：手机扫描终端中的 QR 码（QR 码编码了带 token 的完整 URL）
- **手动输入**：打开 URL 后看到登录页面，粘贴 token 点击 "Connect"
- **API 调用**：请求头加 `Authorization: Bearer <token>`

未认证时：
- 网页请求 → 显示优雅的登录页面（深色主题，输入框 + Connect 按钮）
- API 请求 → 返回 `401 { error: "Unauthorized" }`

---

## 3. AI 对话（聊天）

### 功能

通过 Cursor CLI `agent` 命令发送 prompt，实时获取 AI 回复、工具调用、文件编辑等。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/lib/cursor-cli.ts` | 封装 `spawn("agent", args)` |
| `src/app/api/chat/route.ts` | POST `/api/chat` → 启动 agent 进程 → 返回 sessionId |
| `src/lib/process-registry.ts` | 管理运行中的 agent 子进程、内存事件缓冲 |
| `src/hooks/use-chat.ts` | 前端聊天状态管理 hook |
| `src/components/chat-container.tsx` | 聊天容器组件 |
| `src/components/chat-input.tsx` | 输入框组件 |
| `src/components/message-list.tsx` | 消息列表组件 |
| `src/components/message-bubble.tsx` | 单条消息气泡 |
| `src/components/markdown.tsx` | Markdown 渲染（react-markdown + rehype-highlight + remark-gfm） |

### 使用方法

1. 在页面底部的输入框中输入 prompt
2. 按 **Enter** 发送（**Shift+Enter** 换行）
3. 或点击右下角的 **↑ 发送按钮**
4. 发送后：
   - 用户消息立即显示
   - 调用 `POST /api/chat` → 后端 `spawn("agent", ["-p", prompt, "--output-format", "stream-json", "--stream-partial-output"])`
   - 返回 `sessionId`
   - 前端通过 SSE 实时接收更新
5. Agent 运行期间顶部栏显示：当前模型名 + 已用时间（如 `claude-4-opus / 23s`）
6. 点击 **Stop 按钮**（方块图标）可终止 agent

### 后端流程

```
用户 prompt → POST /api/chat
  → spawnAgent() → spawn("agent", ["-p", ..., "--output-format", "stream-json"])
  → registerProcess() 注册进程
  → waitForSessionId() 等待 agent 输出 init 事件
    → 解析 NDJSON stdout
    → 找到 { type: "system", subtype: "init", session_id } 后返回 sessionId
  → upsertSession() 写入 SQLite
  → 返回 { sessionId } 给前端
```

---

## 4. 模型与模式切换

### 功能

选择不同 AI 模型和对话模式（Agent / Ask / Plan）。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/app/api/models/route.ts` | GET `/api/models` → 执行 `agent models` CLI → 解析输出 |
| `src/components/chat-input.tsx` | 模型选择下拉菜单 + 模式切换按钮 |

### 使用方法

**切换模式：**
- 输入框左下角有三个按钮：**Agent** / **Ask** / **Plan**
- 点击对应按钮切换模式
- 选中状态高亮显示

**切换模型：**
1. 点击输入框右下角的**模型名称**（如 "auto"）
2. 弹出下拉菜单，显示所有可用模型
3. 模型列表从 `agent models --trust` 获取并缓存 5 分钟
4. 每个模型显示标签，标注 `default` 和 `current`
5. 点击选择模型

---

## 5. 实时流式更新

### 功能

通过 SSE（Server-Sent Events）实时推送 agent 的输出变化，三层机制保证不丢失更新。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/app/api/sessions/watch/route.ts` | SSE 端点，三层更新机制 |
| `src/lib/process-registry.ts` | 内存事件缓冲（liveEvents Map） |
| `src/lib/transcript-reader.ts` | JSONL 文件读取与解析 |
| `src/hooks/use-session-watch.ts` | 前端 SSE 消费 hook |

### 三层更新机制

1. **内存事件缓冲**（最快）：agent stdout 的 NDJSON 解析后存入 `liveEvents` Map，SSE 立即推送
2. **fs.watch**（文件级）：监听 `~/.cursor/projects/<key>/agent-transcripts/<sessionId>.jsonl` 变更
3. **轮询兜底**：若 JSONL 文件尚未出现，每 `FILE_POLL_MS` 轮询一次直到出现

### 事件类型

| SSE 事件 | 数据 | 触发时机 |
|----------|------|---------|
| `connected` | 初始 messages + toolCalls + modifiedAt + isActive | 连接建立 |
| `update` | 最新 messages + toolCalls + modifiedAt + isActive | 数据变更 |
| `ping` | `{ ts }` | 每 `SSE_KEEPALIVE_MS` 保活 |

---

## 6. Tool Call 可视化

### 功能

将 agent 的工具调用（读文件、写文件、编辑、Shell 命令、搜索、Todo）以可折叠卡片形式展示。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/components/tool-call-card.tsx` | ToolCallCard / ToolCallGroup / ChangesSummary / TodoLogCard 组件 |
| `src/lib/transcript-reader.ts` | `extractToolCallsFromContent()` 从 JSONL 解析工具调用 |
| `src/lib/types.ts` | `ToolCallInfo` / `TodoItem` 类型定义 |

### 展示的工具类型

| 类型 | 图标 | 展示内容 |
|------|------|---------|
| `read` (Read/List) | 文件图标 | 文件路径 |
| `write` (Write) | 编辑图标 | 文件路径 + diff（前 30 行） |
| `edit` (Edit/StrReplace) | 编辑图标 | 文件路径 + old/new diff |
| `shell` (Shell) | 终端图标 | 命令文本 |
| `search` (Grep/Glob) | 搜索图标 | 搜索模式 + 目录 |
| `todo` (TodoWrite) | 勾选图标 | Todo 列表 + 进度（如 "5 items · 3 done"） |
| `other` | 齿轮图标 | 工具名称 |

### 使用方法

- 消息流中 tool call 自动以紧凑卡片显示
- 点击卡片可**展开/折叠**查看详情（diff、命令、todo 列表）
- **次要工具调用**（read、search 等）自动折叠为一组，显示 "3 Read, 2 Grep" 的概要
- **重要工具调用**（edit、write、shell、todo）单独显示
- **Changes Summary**：在消息末尾汇总所有文件变更（N files changed, M edits, K writes），点击展开可查看每个文件的 diff
- **Todo 面板**：TodoWrite 的最后一次调用以进度卡片显示，带完成/进行中/待办状态图标

---

## 7. 会话管理

### 功能

浏览、恢复、归档、删除历史会话。合并 Cursor IDE 会话 + CLR 自建会话。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/components/session-sidebar.tsx` | 左侧滑出式会话侧栏 |
| `src/lib/session-store.ts` | SQLite 会话 CRUD（`~/.cursor-local-remote/sessions.db`） |
| `src/lib/transcript-reader.ts` | 扫描 `~/.cursor/projects/<key>/agent-transcripts/` |
| `src/app/api/sessions/route.ts` | GET/DELETE/PATCH 会话列表 |
| `src/app/api/sessions/active/route.ts` | 当前运行中的 agent |
| `src/app/api/sessions/history/route.ts` | 单个会话完整历史 |

### 使用方法

1. 点击顶部栏左侧的 **☰ 菜单按钮** → 打开会话侧栏
2. 侧栏顶部：
   - **+ New session**：新建空白会话
   - **项目下拉菜单**：切换不同项目（见"多项目切换"）
   - **Archive / Archive all**：归档当前/全部会话
3. 会话列表：
   - 每个会话显示**标题**（首条用户消息前 60 字符）+ **更新时间**
   - 运行中的会话左侧有**旋转动画指示器**（绿色）
   - **点击会话**：加载该会话的完整历史并开始监听
   - **鼠标悬停**：右侧出现归档（📦）和删除（🗑️）按钮
   - **Tooltip**：悬停显示完整标题和预览
4. 删除操作需**二次确认**（点一次出现 "Delete" 确认按钮，再点一次执行）
5. 点击 **Archive** 切换到归档视图，可对归档会话执行 **Unarchive**
6. 点击 **刷新按钮**（🔄）重新加载列表

### 数据合并逻辑

```
GET /api/sessions →
  1. readCursorSessions(workspace) — 扫描 JSONL 文件
  2. listSessions(workspace) — 查询 SQLite
  3. mergeSessions() — 以 ID 去重，取较新的 updatedAt
  4. 过滤掉已归档的会话
```

---

## 8. 多项目切换

### 功能

自动发现所有 Cursor 项目，支持在不同项目间切换，可收藏常用项目。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/components/session-sidebar.tsx` | 项目下拉菜单 + 收藏星标 |
| `src/lib/transcript-reader.ts` | `listProjects()` 扫描 `~/.cursor/projects/` |
| `src/app/api/projects/route.ts` | GET `/api/projects` |

### 使用方法

1. 打开会话侧栏
2. 点击**项目名称下拉菜单**（如 "cursor_auto"）
3. 下拉列表显示：
   - **All projects**：查看所有项目的会话
   - 每个项目显示**名称** + **完整路径** + **运行终端数**（绿点）
   - 每个项目右侧有 **★ 收藏按钮**
4. 收藏的项目会固定在下拉菜单上方，作为快速切换入口
5. 选择不同项目后，会话列表自动刷新为该项目的会话

### 项目发现原理

扫描 `~/.cursor/projects/` 目录：
- 仅处理大写字母开头的目录名（Cursor 的项目 key 格式）
- 检查该 key 下是否有 `agent-transcripts/` 子目录
- 通过 `projectKeyToWorkspace()` 逆向推导出原始文件系统路径

---

## 9. Git 面板

### 功能

完整 Git 操作面板：查看状态、diff、stage/unstage、commit、push、pull、fetch、切换分支、新建分支、discard。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/components/git-panel.tsx` | Git 面板 UI（右侧滑出） |
| `src/app/api/git/route.ts` | GET（status/diff/branches）+ POST（commit/push/pull/fetch/stage/unstage/discard/checkout/create_branch） |

### 使用方法

1. 点击顶部栏的 **分支名按钮**（如 `main +3`）→ 打开 Git 面板
2. 面板顶部：
   - 当前分支名（点击 → 打开**分支切换下拉菜单**）
   - `↑2`（ahead commits）/ `↓1`（behind commits）
   - 刷新按钮 / 关闭按钮
3. **分支操作**：
   - 点击分支名旁的 **▼** → 显示本地分支 + 远程分支
   - 点击分支名 → **切换分支**
   - 顶部输入框输入名称 + 点击 "Create" → **新建分支**
4. **文件列表**：
   - 每个文件显示：**勾选框** + **状态标签**（M/A/D/U/R） + **文件名**
   - 状态颜色：绿色=added/untracked，红色=deleted，黄色=modified，蓝色=renamed
   - 点击文件 → **展开查看 diff**（彩色高亮：绿=新增行，红=删除行，蓝=位置标记）
   - 点击勾选框 → 选择/取消选择文件
   - 顶部 **全选/取消全选** + **Discard** 按钮（需二次确认）
5. **底部操作按钮**：
   - **Fetch** / **Pull** / **Push**：三个并排按钮
   - **Commit 区域**：
     - 输入 Commit message
     - 点击 **"Commit N files"** 按钮（或 **Cmd+Enter** 快捷键）
     - 按钮文字动态显示选中文件数

### 底层实现

所有 Git 操作通过 `execFile("git", args)` 执行，超时 10-15 秒：

```
GET /api/git                → git status --porcelain + git log -1 + git rev-parse
GET /api/git?detail=status  → 详细 status + ahead/behind
GET /api/git?detail=diff    → git diff HEAD / --cached / --no-index
GET /api/git?detail=branches→ git branch --format + git branch -r
POST { action: "commit" }   → git add + git commit -m
POST { action: "push" }     → git push
POST { action: "pull" }     → git pull
POST { action: "fetch" }    → git fetch
POST { action: "discard" }  → git checkout HEAD / git rm / git clean（按文件类型分别处理）
POST { action: "checkout" } → git checkout <branch>
POST { action: "create_branch" } → git checkout -b <branch>
```

---

## 10. 远程终端

### 功能

在浏览器中打开完整的远程 Shell 终端，支持多标签页、命令输入、Ctrl+C 中断。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/components/terminal-panel.tsx` | 终端面板 UI（xterm.js 渲染 + 多标签页） |
| `src/lib/terminal-registry.ts` | 进程管理：`spawn(shell, ["-i"])`、stdin/stdout 桥接 |
| `src/app/api/terminal/route.ts` | POST（创建终端）/ GET（列出终端）/ DELETE（杀死/移除） |
| `src/app/api/terminal/stream/route.ts` | SSE 流式终端输出 |
| `src/app/api/terminal/input/route.ts` | POST 发送 stdin 数据 |

### 使用方法

1. 点击顶部栏的 **Terminal 按钮** → 打开终端面板
2. 如果没有运行中的终端，显示 **"+ New terminal"** 按钮
3. 点击 **+** 创建新终端 → spawn 交互式 shell
4. **终端标签页**：
   - 每个终端显示为一个标签
   - 绿色圆点 = 运行中，灰色 = 正常退出，红色 = 异常退出
   - 点击标签 → 切换终端
   - 点击标签上的 **×** → 运行中时杀死进程，已退出时移除
5. **终端区域**：xterm.js 渲染，支持：
   - 256 色
   - 可点击链接
   - 5000 行滚动缓冲
   - 自动 fit 窗口大小
6. **底部命令输入栏**（运行中时显示）：
   - `>` 提示符 + 输入框
   - 输入命令 → **Enter** 发送
   - **^C 按钮** → 发送 Ctrl+C（`\x03`）
   - **Stop 按钮** → SIGTERM 杀死进程
7. 终端退出后底部显示退出码 + **Remove** 按钮

### 技术细节

- 后端：`spawn(shell, ["-i"])` 以交互模式启动 Shell
- 输出缓冲最大 512KB，超出时丢弃旧内容
- 环境变量清理：过滤掉 `PORT`、`AUTH_TOKEN`、`__NEXT_*` 等内部变量
- 前端动态加载 xterm.js（`import("@xterm/xterm")`），不阻塞首屏

---

## 11. QR 码连接

### 功能

生成 QR 码方便手机扫码直连（编码含 token 的 URL）。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/components/qr-modal.tsx` | QR 码弹窗（qrcode.react 渲染 SVG） |
| `src/app/api/info/route.ts` | 返回 LAN IP、端口、authUrl 等 |
| `bin/cursor-remote.mjs` | CLI 终端打印 QR 码（qrcode-terminal） |

### 使用方法

**CLI 终端：**
- 启动时自动在终端中打印 QR 码（用 `qrcode-terminal` 库）
- `--no-qr` 可禁用

**Web UI：**
1. 点击顶部栏右侧的 **QR 码图标**（田字格图标）
2. 弹出模态框，显示：
   - "Connect device" 标题
   - 白色背景上的 QR 码（180×180）
   - 下方显示网络 URL
3. 手机摄像头扫码 → 自动打开浏览器并认证
4. 点击 **Close** 或点击遮罩层关闭

---

## 12. 设置面板

### 功能

配置 trust 模式、声音、PWA 提示、默认模型、Webhook URL 等。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/components/settings-panel.tsx` | 设置面板 UI（右侧滑出） |
| `src/app/api/settings/route.ts` | GET/PATCH 读写设置 |
| `src/lib/session-store.ts` | `config` 表存储键值对 |

### 使用方法

1. 点击顶部栏右侧的 **⚙️ 齿轮图标** → 打开设置面板
2. **开关项**（点击切换）：

| 设置 | 说明 | 默认值 |
|------|------|--------|
| Workspace trust | 允许 agent 自动执行代码和编辑文件 | 开 |
| Sound effects | 完成/出错时播放声音 | 开 |
| Suggest PWA install | 页面加载时显示安装为 App 的提示 | 开 |

3. **Default model**：
   - 点击下拉菜单选择默认模型
   - 新会话将使用此模型
4. **Webhook notifications**：
   - 输入 Webhook URL（支持 Slack / Discord / ntfy / 任意 HTTP 端点）
   - 点击 **"Send test"** 发送测试通知验证配置
5. **Clear cache**：
   - 清除 Service Worker 缓存
   - 用于修复 App 状态异常

---

## 13. 通知系统

### 功能

Agent 完成任务后通过多种方式通知用户。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/hooks/use-notification.ts` | 标签页标题闪烁 + favicon 变色 |
| `src/hooks/use-sound.ts` | 完成/出错音效播放 |
| `src/lib/webhooks.ts` | Webhook 推送（Discord/Slack/通用） |
| `src/app/api/notifications/test/route.ts` | 测试 webhook |
| `src/components/chat-container.tsx` | 通知条显示逻辑 |

### 通知方式

**内置（无需配置）：**
- **标签页标题闪烁**：浏览器不在前台时，标题变为 "Done! - CLR" 或 "Error - CLR"
- **音效**：完成播放成功音，出错播放错误音（需运行 >3 秒或标签页在后台）
- **震动**：手机上触觉反馈（`use-haptics.ts`，使用 web-haptics 库）
- **横幅**：切回页面后显示 "Agent finished (23s)" 或 "Agent errored" 横幅，带关闭按钮

**Webhook（需配置）：**
1. 在设置面板输入 Webhook URL
2. Agent 完成后发送 POST 请求
3. 支持平台：
   - **Discord**：自动转为 embed 格式（带标题、描述、颜色、时间戳）
   - **Slack**：自动转为 Slack 消息格式（`*title*\nmessage`）
   - **通用**：原始 JSON payload

Webhook payload 示例：
```json
{
  "event": "agent_complete",
  "title": "Done - my-project",
  "message": "\"用户prompt前60字符\"\n\n✅ Task A\n⏳ Task B\n⬜ Task C",
  "url": "http://192.168.1.100:3100?token=xxx#session=abc&workspace=/path",
  "sessionId": "abc12345-...",
  "workspace": "/path/to/project",
  "timestamp": 1710000000000
}
```

---

## 14. 消息队列

### 功能

Agent 正在运行时发送的消息自动排队，运行结束后依次发送。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/hooks/use-message-queue.ts` | 消息排队逻辑 |
| `src/hooks/use-chat.ts` | 集成队列与聊天流程 |

### 使用方法

1. Agent 运行中时，输入框 placeholder 变为 **"Type to queue a message..."**
2. 发送按钮图标变为 **+**（加号），表示排队而非立即发送
3. 排队的消息显示在消息列表中，有特殊标记
4. 可以**编辑**或**删除**排队中的消息
5. 可以点击排队消息上的 **"Send now"** 强制立即发送
6. Agent 完成后自动发送队列中的下一条消息

---

## 15. 图片上传

### 功能

支持在聊天中附加图片（粘贴、拖拽、文件选择）。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/components/chat-input.tsx` | 图片预览、拖拽/粘贴处理 |
| `src/app/api/upload/route.ts` | multipart/form-data 上传 |

### 使用方法

1. **粘贴图片**：Ctrl+V 粘贴剪贴板中的图片
2. **拖拽图片**：将图片文件拖入输入框（边框变色提示）
3. 图片以缩略图形式显示在输入框下方
4. 鼠标悬停缩略图 → 显示 **×** 删除按钮
5. 发送时图片先上传到服务器，然后以 `[Attached image: /path]` 形式附加到 prompt

---

## 16. 会话导出

### 功能

将当前会话导出为 Markdown 格式。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/lib/export.ts` | `exportSessionMarkdown()` 格式化 |
| `src/components/chat-container.tsx` | 导出按钮 |

### 使用方法

1. 在有消息的会话中，点击顶部栏右侧的 **导出图标**（向上箭头图标）
2. 自动复制 Markdown 到剪贴板（显示 ✓ 确认图标 1.5 秒）
3. 如果剪贴板 API 不可用，改为下载 `.md` 文件

---

## 17. PWA 支持

### 功能

可安装为手机主屏幕应用（Progressive Web App）。

### 实现文件

| 文件 | 作用 |
|------|------|
| `src/app/manifest.ts` | Web App Manifest 生成 |
| `src/components/pwa-install.tsx` | PWA 安装提示组件 |
| `public/sw.js` | Service Worker |
| `public/icon-192.png` / `public/icon-512.png` | App 图标 |
| `public/apple-touch-icon.png` | iOS 图标 |

### 使用方法

1. 在手机浏览器中访问 CLR
2. 如果设置中启用了 "Suggest PWA install"，页面加载后显示安装提示
3. iOS：Safari → 分享 → 添加到主屏幕
4. Android：Chrome 地址栏提示 → 安装
5. 安装后以独立窗口运行（`display: standalone`），深色主题（`#0a0a0b`）

---

## API 端点总览

| 端点 | 方法 | 功能 | 实现文件 |
|------|------|------|---------|
| `/api/chat` | POST | 发送 prompt，启动 agent | `src/app/api/chat/route.ts` |
| `/api/models` | GET | 列出可用模型 | `src/app/api/models/route.ts` |
| `/api/sessions` | GET | 会话列表 | `src/app/api/sessions/route.ts` |
| `/api/sessions` | DELETE | 删除会话 | `src/app/api/sessions/route.ts` |
| `/api/sessions` | PATCH | 归档/取消归档 | `src/app/api/sessions/route.ts` |
| `/api/sessions/active` | GET | 运行中的 agent | `src/app/api/sessions/active/route.ts` |
| `/api/sessions/active` | DELETE | 终止 agent | `src/app/api/sessions/active/route.ts` |
| `/api/sessions/history` | GET | 会话完整历史 | `src/app/api/sessions/history/route.ts` |
| `/api/sessions/watch` | GET (SSE) | 实时会话更新 | `src/app/api/sessions/watch/route.ts` |
| `/api/projects` | GET | 已知项目列表 | `src/app/api/projects/route.ts` |
| `/api/git` | GET | Git 状态/diff/分支 | `src/app/api/git/route.ts` |
| `/api/git` | POST | Git 操作 | `src/app/api/git/route.ts` |
| `/api/terminal` | GET | 终端列表 | `src/app/api/terminal/route.ts` |
| `/api/terminal` | POST | 创建终端 | `src/app/api/terminal/route.ts` |
| `/api/terminal` | DELETE | 杀死/移除终端 | `src/app/api/terminal/route.ts` |
| `/api/terminal/stream` | GET (SSE) | 终端输出流 | `src/app/api/terminal/stream/route.ts` |
| `/api/terminal/input` | POST | 终端 stdin 输入 | `src/app/api/terminal/input/route.ts` |
| `/api/upload` | POST | 图片上传 | `src/app/api/upload/route.ts` |
| `/api/settings` | GET | 读取设置 | `src/app/api/settings/route.ts` |
| `/api/settings` | PATCH | 更新设置 | `src/app/api/settings/route.ts` |
| `/api/notifications/test` | POST | 测试 webhook | `src/app/api/notifications/test/route.ts` |
| `/api/info` | GET | 网络信息/auth URL | `src/app/api/info/route.ts` |

---

## 关键 lib 模块

| 文件 | 作用 |
|------|------|
| `src/lib/cursor-cli.ts` | Cursor `agent` CLI 封装 |
| `src/lib/transcript-reader.ts` | JSONL 转录文件读取、解析消息和工具调用 |
| `src/lib/session-store.ts` | SQLite 会话与配置持久化 |
| `src/lib/process-registry.ts` | agent 子进程生命周期管理 + 内存事件缓冲 |
| `src/lib/terminal-registry.ts` | Shell 终端进程管理 |
| `src/lib/webhooks.ts` | Webhook 通知（Discord/Slack/通用） |
| `src/lib/network.ts` | LAN IP 发现 |
| `src/lib/workspace.ts` | 当前 workspace 路径获取 |
| `src/lib/validation.ts` | Zod schema 请求校验 |
| `src/lib/errors.ts` | 统一错误响应 |
| `src/lib/constants.ts` | 超时/间隔/缓冲等常量 |
| `src/lib/export.ts` | Markdown 导出 |
| `src/lib/format.ts` | `timeAgo()` 等格式化工具 |
| `src/lib/api-fetch.ts` | 前端 fetch 封装（自动带 auth） |
| `src/lib/uuid.ts` | UUID 生成 |
| `src/lib/verbose.ts` | 条件日志 (`CLR_VERBOSE=1`) |
| `src/lib/shutdown.ts` | 优雅关闭（清理进程和终端） |

---

## 前端 Hooks

| 文件 | 作用 |
|------|------|
| `src/hooks/use-chat.ts` | 聊天核心状态 |
| `src/hooks/use-session-watch.ts` | SSE 会话监听 |
| `src/hooks/use-message-queue.ts` | 消息排队 |
| `src/hooks/use-haptics.ts` | 触觉反馈（手机震动） |
| `src/hooks/use-sound.ts` | 音效播放 |
| `src/hooks/use-notification.ts` | 标签页标题闪烁/favicon 变色 |
