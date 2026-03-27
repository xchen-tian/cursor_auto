# cursor_auto vs cursor-local-remote 技术分析与结合方案

## 项目概述

### cursor_auto — CDP 控制层

通过 Chrome DevTools Protocol (CDP) 连接 Cursor Electron GUI，实现：

- **自动点击审批**：轮询 DOM 找 Run/Allow/Skip 按钮 → `.click()`，含 Agent 模式全套审批
- **Live View**：CDP 抓完整 DOM → 内联 CSS → 资源代理 → iframe 渲染，几乎像素级还原 Cursor 界面
- **聊天内容提取**：解析 `.composer-messages-container` DOM，返回带原生样式的 HTML 片段
- **Composer 输入**：CDP `Input.insertText` + `dispatchKeyEvent` 模拟键盘输入
- **文件浏览器**：扫描虚拟化 Explorer DOM 或文件系统，支持打开文件（Ctrl+P Quick Open）
- **编辑器操作**：提取标签列表、文件内容、切换/关闭标签
- **Claude Code 审批**：raw WebSocket 连 webview CDP target，自动点击权限对话框
- **多窗口**：`findAllWorkbenchPages()` 自动发现所有 Cursor 窗口，每个窗口独立子进程
- **窗口管理**：CDP `Browser.getWindowForTarget` + `setWindowBounds` 调整窗口大小
- **状态指示器**：往 Cursor 标题栏注入 HTML 元素（AX status），通过 DOM data 属性通信

技术栈：Node.js CommonJS + Playwright-core + Express + cheerio

### cursor-local-remote — CLI + 文件系统层

通过 Cursor `agent` CLI 命令 + 读取转录文件实现远程控制：

- **AI 对话**：`spawn("agent", ["-p", prompt, "--output-format", "stream-json"])`
- **会话历史**：读 `~/.cursor/projects/<key>/agent-transcripts/*.jsonl`（Anthropic API 格式）
- **实时更新**：SSE + `fs.watch` + 内存事件缓冲三层机制
- **会话持久化**：sql.js SQLite (`~/.cursor-local-remote/sessions.db`)
- **模型切换**：`agent models` CLI 命令
- **Git 操作**：`execFile("git", [...])` 全套 status/diff/commit/push/pull/branch
- **远程终端**：spawn shell + stdin/stdout SSE 桥接 + xterm.js
- **Token 鉴权**：URL token / Cookie / Bearer 三种方式
- **PWA**：manifest + Service Worker，可安装到手机主屏

技术栈：Next.js 15 + React 19 + TypeScript ES Modules + Tailwind v4

---

## 逐维度对比

| 维度 | cursor_auto | cursor-local-remote | 最优方案 |
|------|:-----------:|:-------------------:|:--------:|
| 发消息给 AI | CDP 注入键盘 | CLI `agent -p` | **CLI** — 更可靠 |
| 审批按钮 (Run/Allow) | DOM `.click()` | `--trust` 跳过 | **CDP** — 核心价值 |
| Plan 选择题 | 无 | 无 | **ACP** — 唯一方案 |
| Live View | DOM 快照+CSS 内联 | 无 | **CDP** — 独占能力 |
| 聊天内容 | HTML 片段(原生样式) | 结构化 JSON | 各有千秋 |
| 对话历史 | 仅当前标签 | 全部历史(JSONL扫描) | **Transcript** |
| 文件浏览器 | DOM + 文件系统 | 无 | **CDP** |
| 编辑器操作 | 标签列表+内容读取 | 无 | **CDP** |
| Git 操作 | 无 | 完整 Git 面板 | **execFile("git")** |
| 远程终端 | 无 | shell + xterm.js | **spawn shell** |
| 多窗口 | 原生支持 | 单 workspace | **CDP** |
| Claude Code | webview CDP | 无 | **CDP** |
| 前端 UI | 功能性控制面板 | 现代 PWA | **Next.js** |
| 维护成本 | 高(DOM 选择器) | 低 | — |

---

## CLI NDJSON vs GUI JSONL 格式差异

**GUI 写入的 JSONL**（`~/.cursor/.../agent-transcripts/*.jsonl`）：
```json
{"role":"user","message":{"content":[{"type":"text","text":"..."}]}}
{"role":"assistant","message":{"content":[{"type":"text","text":"..."},{"type":"tool_use","name":"Edit","input":{...}}]}}
```
- 顶层用 `role` 字段
- 工具调用内嵌在 `message.content` 数组（Anthropic API 原生格式）

**CLI 输出的 NDJSON**（`agent --output-format stream-json`）：
```json
{"type":"system","subtype":"init","session_id":"...","model":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]},"session_id":"..."}
{"type":"tool_call","subtype":"started","call_id":"...","tool_call":{"readToolCall":{"args":{"path":"..."}}},"session_id":"..."}
{"type":"tool_call","subtype":"completed","call_id":"...","tool_call":{"readToolCall":{...,"result":{...}}},"session_id":"..."}
{"type":"result","subtype":"success","duration_ms":1234,"session_id":"..."}
```
- 顶层用 `type` 字段
- 工具调用是独立事件行（started/completed）
- 每行都带 `session_id`

CLI 和 GUI 共享 `~/.cursor/projects/<key>/agent-transcripts/` 目录，`agent --resume <sessionId>` 可恢复任一来源的会话。

---

## Cursor Hooks 能力

Cursor 官方 Hooks (`beforeShellExecution`, `postToolUse` 等) 通过 stdin JSON 接收事件数据：

| Hook | 关键数据 |
|------|----------|
| `preToolUse` | `tool_name`, `tool_input`, `tool_use_id` |
| `postToolUse` | 以上 + `tool_output`, `duration` |
| `afterShellExecution` | `command`, `output`, `duration`, `sandbox` |
| `afterFileEdit` | `path`, `diff` |
| `stop` | `status`, `loop_count` |

所有 hook 共享：`conversation_id`, `model`, `transcript_path`, `cursor_version`, `user_email`

---

## ACP (Agent Client Protocol)

Cursor 官方为第三方客户端设计的协议（`agent acp`，stdio JSON-RPC 2.0）：

| 方法 | 能力 |
|------|------|
| `session/prompt` | 发消息 |
| `session/update` | 接收流式回复 |
| `session/request_permission` | 审批（allow-once / allow-always / reject-once） |
| `cursor/ask_question` | Plan 模式选择题 |
| `cursor/create_plan` | Plan 确认 |
| `cursor/update_todos` | Todo 状态更新 |
| `cursor/task` | 子 agent 任务通知 |

已有集成：JetBrains、Neovim (avante.nvim)、Zed

cursor-local-remote 用 `agent -p --trust` 跳过所有交互审批，无法呈现选择题和 Run 按钮。ACP 是唯一能完整支持交互审批的方案。

---

## 推荐结合架构

```
前端 (Next.js PWA)
├─ 聊天界面 (Markdown + ToolCall 卡片)     ← cursor-local-remote
├─ Git 面板                                ← cursor-local-remote
├─ 远程终端 (xterm.js)                     ← cursor-local-remote
├─ Live View iframe                        ← cursor_auto (新增)
├─ 文件浏览器                              ← cursor_auto (新增)
├─ 审批面板 (Run/Allow/选择题)             ← ACP (新增)
└─ Claude Code 审批状态                    ← cursor_auto

后端
├─ ACP 层 (agent acp JSON-RPC)             ← 对话 + 审批的最优通道
│   ├─ session/prompt → 发消息
│   ├─ session/request_permission → 推前端审批
│   └─ cursor/ask_question → 推前端选择题
├─ CDP 层 (Playwright)                     ← GUI 专属操作
│   ├─ Live View: DOM 快照 + CSS 内联
│   ├─ 文件浏览: sidebar-materialized
│   ├─ 编辑器: editor-content
│   ├─ Claude Code: webview CDP 自动审批
│   └─ 多窗口管理
├─ Hook 层 (Cursor hooks)                  ← 实时事件补充
│   ├─ postToolUse → HTTP POST → SSE
│   └─ afterAgentResponse → 同上
├─ Transcript 层                           ← 历史数据
│   └─ fs.watch(agent-transcripts/*.jsonl)
├─ Git: execFile("git", [...])
└─ Terminal: spawn shell + SSE
```

### 各层分工原则

| 需求 | 最优通道 | 理由 |
|------|----------|------|
| 发消息 | ACP | 官方协议，有审批回调 |
| 审批 Run/Allow | ACP | 结构化，可推到手机 |
| Plan 选择题 | ACP | CLI/CDP 都做不到 |
| Claude Code 审批 | CDP | ACP 不覆盖 webview 扩展 |
| Live View | CDP | 独占能力 |
| 文件浏览/编辑器 | CDP | 需要操控 DOM |
| 对话历史 | Transcript JSONL | 最完整 |
| 实时工具调用进度 | Hook postToolUse | GUI 对话也能覆盖 |
| Git | execFile("git") | 直接可靠 |
| 远程终端 | spawn(shell) + SSE | 直接可靠 |
