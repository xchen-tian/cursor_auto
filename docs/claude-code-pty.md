# Claude Code PTY — 技术文档

cursor_auto 提供两套 Claude Code 自动审批方案：CLI 版（终端内直接使用）和 Web 版（浏览器内使用）。两者共享检测逻辑，但架构完全不同。

## 为什么需要这个

Claude Code VS Code 插件因 proxy 问题经常不可用。Claude Code CLI 可以绕过 proxy，但每次执行 bash 命令、写文件等操作都需要手动审批权限提示（"Do you want to create...?" → 1. Yes / 2. No）。本方案自动检测并审批这些提示。

---

## 两套方案对比

|  | CLI 版 `claude_code_pty.js` | Web 版 `claude.html` + `claude_pty_server.js` |
|--|---|---|
| 运行环境 | 终端（Cursor 集成终端、Windows Terminal 等） | 浏览器（`http://localhost:5123/claude`） |
| PTY 方式 | node-pty 本地 spawn | 本地: node-pty / SSH: ssh2 纯 JS 库 |
| 检测方式 | 服务端 stripAnsi → RingBuffer → 正则 | **客户端** xterm.js buffer → 纯文本 → 正则 |
| 数据传输 | process.stdout.write（直接终端） | WebSocket binary frame（零 JSON 编码） |
| 状态指示 | AX badge（终端转义码叠加） | HTML AX 按钮 |
| Toggle | `\|\|`（双竖线，kitty 协议兼容） | HTML 按钮点击 |
| SSH 远程 | 外部 ssh 命令（有 conpty 问题） | **ssh2 库直连**（零中间 PTY） |

### 为什么最终选择了 Web 版

CLI 版在开发中遇到大量终端兼容性问题：
- Windows conpty 重排 ANSI 序列，导致行号定位不准
- kitty 键盘协议把按键编码为 CSI 序列，无法用 `data === '/'` 检测
- Cursor IDE 截获 Ctrl+\、Alt+1 等快捷键
- badge 的 DEC save/restore 和 Claude 的光标操作共享同一个存储槽
- SSH 通过 `ssh` 命令 spawn，经过两层 PTY（本地 conpty + 远程 PTY），ANSI 被二次加工

Web 版把渲染交给 xterm.js，所有这些问题都不存在。

---

## Web 版架构

```
浏览器                                  服务器                          远程
┌────────────────────┐   WebSocket   ┌─────────────────┐
│ xterm.js 渲染 ANSI  │◄── binary ──►│ claude_pty_server│
│                    │              │                 │
│ 每 500ms:          │              │ 本地项目:        │
│   读屏幕 buffer    │              │   node-pty spawn │──► claude CLI
│   正则匹配 prompt  │              │                 │
│   匹配 → ws approve│── JSON ────►│ SSH 项目:        │
│                    │              │   ssh2 直连      │──► [SSH] ──► claude CLI
│ AX 按钮 (HTML)     │              │   ssh-config 解析│
│ 项目 tabs (CDP)    │              │   ProxyJump 支持 │
└────────────────────┘              └─────────────────┘
```

### 为什么检测在客户端而不是服务端

服务端做检测需要 stripAnsi 把 ANSI 转义码转成纯文本。但 Ink TUI 用光标定位（`\x1B[row;colH`）代替换行，用光标右移（`\x1B[nC`）代替空格。剥离时必须做语义转换（位置→换行，右移→空格），很容易出错。

客户端用 xterm.js 的 `buffer.active.getLine(i).translateToString()` 直接读屏幕纯文本——xterm.js 已经完成了所有 ANSI 解析和渲染，给出的就是用户看到的文字。零 ANSI 处理，零误差。

### 为什么 SSH 用 ssh2 库而不是 ssh 命令

用 `pty.spawn('ssh', [...])` 经过两层 PTY：
1. 本地 node-pty（Windows 上是 conpty）— 会重排 ANSI 序列
2. 远程 SSH PTY — Claude 在这里渲染

conpty 这一层会修改 ANSI 序列的顺序、合并写入、改变光标定位，导致颜色错误、文字错位。

ssh2 纯 JS 库直接建立 SSH 连接，`conn.exec()` 在远程分配 PTY 运行 claude，stream 的原始字节通过 WebSocket binary frame 直达 xterm.js：

```
Claude (远程 PTY) → ssh2 stream → Buffer → ws.send(binary) → xterm.write(Uint8Array)
```

零中间层，原始字节不经过任何本地 PTY 加工。

### 为什么用 binary WebSocket 而不是 JSON

PTY 输出包含 ANSI 转义码（`\x1B`、控制字符等）。如果用 JSON 编码（`JSON.stringify`），这些字节被转成 `\u001b` 等 Unicode 转义。虽然 `JSON.parse` 可以还原，但 ws 库的 `message` 事件把所有消息（包括 text frame）都以 Buffer 传递，导致 JSON 文本被误判为 binary 并直接写入 PTY。

用 binary frame 传 PTY 数据、text frame 传 JSON 控制消息，通过 `typeof evt.data !== 'string'` 区分，彻底避免混淆。

### 为什么 getScreenLines 从 buf.length - rows 读而不是从 0 读

xterm.js 的 `buffer.active.getLine(i)` 是绝对行号（包含 scrollback）。当终端有滚动历史时，`getLine(0)` 返回的是历史最顶部的行，不是当前可见的第一行。

权限提示在屏幕底部。如果从 0 读，读到的是旧历史，检测不到当前的提示。从 `buf.length - term.rows` 开始读最后 N 行，才是当前视口。

---

## 自动审批流程

```
1. 服务端 PTY/SSH 输出 → binary WebSocket → 浏览器
2. xterm.js 渲染数据
3. 每 500ms setInterval → checkAndApprove()
4. 读屏幕视口纯文本（最后 term.rows 行）
5. 排除: /esc to interrupt/ 在屏幕上 → 命令在跑，不审批
6. 匹配: PROMPT_PATTERNS + DIALOG_COMPLETE_RE 同时满足
7. debounce 200ms → doApprove()
8. 二次验证: 重读屏幕，确认 prompt 还在且没在 Running
9. 找到 "❯ 1. Yes" 所在行号
10. 闪烁: 绿色半透明 div 叠在该行上，闪两下（120ms 亮→暗→亮→暗）
11. 400ms 后: wsSend({ type: 'approve' }) → 服务端 pty.write('\r')
```

### 运行中不审批

`esc to interrupt`（小写）是 Claude 底部状态栏在命令执行时显示的。`Esc to cancel`（大写 E）是权限对话框底部的。只检查小写版本来排除运行中状态。

`Running...` 不作为排除条件，因为它是工具调用的显示标签（`Bash(pwd) └ Running...`），在权限提示出现时仍然可见——并不意味着命令正在执行。

---

## SSH 连接

### SSH Config 解析

ssh2 不读 `~/.ssh/config`。用 `ssh-config` npm 包解析，获取 HostName、User、Port、IdentityFile、ProxyJump。

### ProxyJump 两跳连接

对于需要跳板机的主机（如 `ap0 → computelabproxy → 10.111.111.31`）：

```javascript
jumpConn.connect({ host: jumpHost })
jumpConn.on('ready', () => {
  jumpConn.forwardOut('127.0.0.1', 0, targetHost, 22, (err, channel) => {
    targetConn.connect({ sock: channel, host: targetHost })
    targetConn.on('ready', () => {
      targetConn.exec(cmd, { pty: { term: 'xterm-256color', cols, rows } }, ...)
    })
  })
})
```

### 远程环境

SSH 非交互模式不加载 `.bashrc`，claude 可能不在 PATH 里。用 `bash -lc` 包裹命令强制加载 login profile。同时 export `TERM=xterm-256color` 和 `FORCE_COLOR=1` 确保颜色输出。

---

## Session 管理

- 以 `type:host:cwd` 为 key 的 singleton Map
- WebSocket 断开不杀进程，新连接 attach 并回放最近 100KB 输出
- `--continue` flag 让 Claude 自动恢复上次对话（JSONL 历史）
- 默认参数: `--model opus --effort max --continue`
- 无人工超时，靠 PTY onExit / ssh2 keepalive / stream close 判断死活

---

## 项目选择

tabs 来自 CDP `/api/windows`（当前活跃的 Cursor 窗口），不是 workspaceStorage 历史记录。每个 tab 对应一个 Cursor 窗口/项目。

点击 tab → 查询是否有已存在的 session → 有则显示 "Session active / Reconnect"，无则显示 "No active session / Start Claude"。

点击 Start Claude 或 Reconnect → WebSocket 发 `start` 或 `attach` → 服务端创建或连接 PTY session。

workspaceStorage 用于 cross-reference：从 CDP 窗口标题提取 SSH host 和项目名，在 workspaceStorage 中查找对应的远程路径（`vscode-remote://ssh-remote+host/path`）。

---

## 开发踩坑总结

| 问题 | 根因 | 修法 |
|------|------|------|
| JSON 控制消息被写入 PTY | ws 库所有 message 都以 Buffer 传递，`Buffer.isBuffer` 为 true | 先 toString + JSON.parse，不按 binary 处理 |
| xterm.js 读屏幕读到历史而非视口 | `getLine(0)` 是绝对行号，从 scrollback 顶部开始 | 从 `buf.length - rows` 读 |
| auto-approve 永远不触发 | term.write() 异步，callback 里读到旧 buffer | 改用 setInterval 500ms 轮询 |
| SSH 显示 "command not found" | 非交互 SSH 不加载 .bashrc | 用 `bash -lc` 包裹 |
| SSH MOTD 和 Claude TUI 叠加 | `conn.shell()` 开完整 login shell | 改用 `conn.exec()` 直接执行命令 |
| SSH hostname 无法解析 | ssh2 不读 SSH config | 用 ssh-config 包解析 |
| SSH 颜色不对 | 远程 TERM 未设置 | export TERM=xterm-256color FORCE_COLOR=1 |
| 频繁断连 | 人工 idle/response 超时太激进 | 去掉所有人工超时，靠 PTY/SSH 自身信号 |
| 项目名显示文件名 | extractProjectName 取错字段 | 从 title 中取第二段（项目名），去掉 [SSH:...] |
| `Running...` 阻止审批 | 工具调用标签和运行状态混淆 | 只检查 `esc to interrupt`（小写）|
