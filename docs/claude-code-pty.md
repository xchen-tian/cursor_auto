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

## Scroll Mode（tmux 风格）

Claude Code 输出过程中，每次 PTY 数据写入后都调用 `term.scrollToBottom()`（见 Bug 21 修复），导致用户无法向上滚动阅读历史内容。

### 方案

仿 tmux copy-mode：进入模式后冻结终端显示，PTY 数据暂存在内存 buffer 中，退出时一次性写入 xterm。

```
正常模式                                scroll 模式
PTY data → term.write() → 显示          PTY data → scrollBuffer[] → 暂存
         → scrollToBottom()                         ↓ 退出时
                                        合并所有 ArrayBuffer → term.write() → scrollToBottom()
```

### 进入

| 触发方式 | 条件 |
|----------|------|
| 鼠标滚轮向上 | `baseY > 0`（有 scrollback 内容时立即进入，无 setTimeout） |
| `PageUp` 键 | 同时翻上一页 |

滚轮检测同时监听 `.xterm-viewport` 和 `term.element`（capture 阶段），确保不被 xterm 内部事件吞掉。

**为什么不用 setTimeout 检测：** 早期用 `setTimeout(50ms)` 延迟检查 `viewportY < baseY`，但 PTY 数据的 `scrollToBottom()` 在 50ms 内已经把视口弹回底部，检查时 `viewportY === baseY`，永远进不了 scroll 模式。

**为什么不用 DOM scrollHeight：** xterm.js 6.0 使用虚拟滚动，`.xterm-viewport` 的 `scrollHeight === clientHeight`，原生滚动条不反映 buffer 大小。改用 xterm buffer API（`buf.viewportY`、`buf.baseY`）检测位置。

### 模式内

| 行为 | 说明 |
|------|------|
| PTY binary 数据 | 推入 `scrollBuffer[]`，不写 xterm |
| JSON 控制消息 | 照常处理（`session`/`exit`/`error`） |
| 键盘输入 | `attachCustomKeyEventHandler` 返回 false，不发送到 PTY |
| 滚动导航 | `↑↓` 逐行、`PgUp/PgDn` 翻页、`Home/End` 到顶/底 |
| 自动审批 | `checkAndApprove()` 跳过（屏幕冻结，读到的是旧内容） |
| write 回调 | 已排队的 `term.write()` 回调检查 `scrollMode` 后不调 `scrollToBottom()` |

### 退出

| 方式 | 说明 |
|------|------|
| `Esc` / `q` | 键盘退出 |
| 点击底部橙色指示栏 | 鼠标退出 |
| 切换 tab | 丢弃 buffer（反正要 `term.reset()`） |
| 会话结束/断开 | 先 flush 再显示 overlay |

退出时将所有 `ArrayBuffer` 合并为一个 `Uint8Array`，一次 `term.write(merged, () => scrollToBottom())` 写入。

### 视觉指示

底部固定橙色状态栏，实时显示：

```
⏸ SCROLL MODE — 12 chunk(s), 3.5 KB buffered — Esc / q to resume
```

z-index 20（高于 overlay 的 10），可点击退出。

### 测试

`src/test_web_scroll.js`（20 assertions）：

| 测试 | 验证 |
|------|------|
| T1 | 初始状态 indicator 隐藏 |
| T2-T3 | enterScrollMode / exitScrollMode 切换 indicator |
| T4 | buffer 积累 + indicator 实时更新 + exit 清空 |
| T5 | 鼠标滚轮向上立即进入（含 wheel-down 不触发、无 scrollback 不触发） |
| T6-T7 | Esc / q 退出 |
| T8 | PageUp 进入 |
| T10 | 点击 indicator 退出 |

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

## 测试方法

整个开发过程中，所有功能都通过 Playwright 自动化测试验证。测试脚本在 `src/test_web_*.js`。

### 测试策略

不依赖人工操作浏览器。所有测试都是 Playwright headless Chrome 自动执行：打开页面 → 点击 tab/按钮 → 等待 Claude 启动 → 读屏幕内容 → 验证 → 截图。截图保存在 `dist/visual-test/` 作为证据。

### 核心测试用例

**本地渲染（test_web_all.js T1）**
- 打开 `/claude`，选 `cursor_auto` tab，点 Start Claude
- 等 18 秒让 Claude 启动
- 验证：xterm buffer 包含 "Claude Code"、无 JSON 泄漏（`{"type"` 不出现）、路径正确
- 截图对比确认红色 logo、彩色文字、正确布局

**SSH 远程渲染（test_web_all.js T2）**
- 选 `[ap0] xiaochent` tab，点 Start Claude
- 通过 ssh2 + ProxyJump 连接到远程机器
- 等 30 秒（SSH 握手 + Claude 启动）
- 验证：buffer 包含 "Claude Code"、无 JSON 泄漏、无 MOTD（"Welcome to Ubuntu" 不出现）、远程路径正确

**Tab 切换干净（test_web_all.js T3）**
- 先启动本地 session，然后切到 ap0 tab
- 验证：`term.reset()` 后屏幕字符数 < 20（之前有残影 bug，本地 session 内容残留在 SSH tab 里）

**AX toggle（test_web_all.js T4）**
- 点击 AX 按钮
- 验证 class 从 `on` 变为 `off`

**长时间稳定性（test_web_all.js T5）**
- 启动 session 后空闲 60 秒
- 每 10 秒检查 overlay 是否出现（"Disconnected"）
- 验证 60 秒后仍然 alive（之前有 2 分钟 idle timeout 误杀的 bug）

**运行中不误触审批（test_web_all.js T6）**
- 输入 `echo test` 让 Claude 执行命令
- 验证 approve count 不变（不会因为屏幕上有旧的 "Yes" 而误触）

**自动审批端到端（test_web_autoapprove.js）**
- 输入 prompt 让 Claude 创建文件（触发权限提示）
- 每秒轮询 `#approve-count` 元素
- 验证 count > 0（auto-approve 触发了）
- 等 10 秒后检查文件是否真的被创建、内容是否正确
- 文件名用 `Date.now()` 动态生成，避免 `--continue` 恢复旧 session 时 Claude 跳过重复操作

**长跑测试（test_web_longrun.js）**
- 启动 session，发一个 prompt，然后每 10 秒检查 alive
- 持续 100 秒 + 额外 60 秒空闲
- 验证 160 秒后仍然存活

**直接对比（test_web_vs_direct.js）**
- 同时用 node-pty 直接跑 `ssh → claude`（基线）和通过 Web 终端跑
- 两份 ANSI 输出用 xterm.js 渲染成 HTML，Playwright 截图对比
- 验证 Web 终端的渲染跟直接跑 SSH 一致

### 调试技巧

**screen buffer debug（test_web_debug_screen.js）**：当 auto-approve 不触发时，在 Playwright 里调用 `page.evaluate` 读取 xterm 的 `buffer.active` 详细信息（rows、cols、baseY、length、每行内容），dump 到 console 定位问题。这个方法发现了 Bug 22（getScreenLines 读错位置）。

**SSH config 验证**：用 `ssh -G hostname` 查看解析后的完整配置（HostName、User、ProxyJump），确认 ssh-config npm 包的解析结果一致。

**二进制数据验证**：检查 WebSocket 是否正确发送 binary frame — 在 `_onOutput` 里 `ws.send(buf)` 发送 Buffer，浏览器端 `typeof evt.data !== 'string'` 区分。JSON 控制消息被当作 binary 写入 PTY 的 Bug 8 就是通过截图中出现 JSON 文字发现的。

---

## 开发踩坑详录

### CLI 版阶段

**Bug 1: stripAnsi 后单词粘连**

第一次测试时，`"Do you want to create test.txt?"` 被剥离成 `"Doyouwanttocreatetest.txt?"`。原因是 Ink 用 `\x1B[1C`（光标右移 1 格）来渲染单词间距，而不是真正的空格字符。stripAnsi 把 `\x1B[1C` 直接删除了，导致前后文字连在一起。

修法：`\x1B[nC` 替换成 n 个空格，而不是删除。类似地 `\x1B[row;colH`（光标定位）替换成 `\n`，因为 Ink 用它来分行。

**Bug 2: "Do you want to create" 检测不到**

PROMPT_PATTERNS 最初只包含 `run|execute|allow`，没有 `create`。后来又遇到 `proceed`（"Do you want to proceed?"）和 `requires confirmation`（"Permission rule Bash requires confirmation"）。最终改为 `/Do you want to\s+\w/i` — "Do you want to" 后面跟任意单词都匹配，不再逐个列动词。

**Bug 3: badge 定时器导致光标跳动**

AX badge 最初用 setInterval 每 600ms 重绘。绘制时需要 save cursor → move → draw → restore cursor。但 DEC save/restore（`\x1B7`/`\x1B8`）只有一个存储槽——如果 Claude 的 Ink 渲染恰好也在用 save/restore，两边互相覆盖，光标飞到错误位置。

修法：去掉定时器，badge 搭 Claude 输出的便车——`process.stdout.write(data + badgeSeq())` 一次 write，终端原子处理。Claude 的下一帧输出会覆盖 badge，但我们的下一次 onData 又画回来了。

**Bug 4: 逐字符处理拆碎 ANSI 序列**

`handleStdinByte` 最初用 `for(let i=0; i<data.length; i++)` 逐字符处理。终端焦点事件 `\x1B[I`（3 个字节）被拆成 `\x1B`、`[`、`I` 三次写入，`I` 作为单独字符被 Claude 当作用户输入，出现在 prompt 里。

修法：绝不拆分 multi-byte chunks。只检查整块数据是否匹配 toggle 键，其他原封不动转发。

**Bug 5: Ctrl+\、Alt+1 在 Cursor 终端里无效**

原计划用 Ctrl+\（`\x1C`）作为 toggle 快捷键，但 Cursor IDE 截获了这个按键，字节根本到不了终端。换 Alt+1 也不行。最终改用双竖线 `||`——普通字符不会被任何 IDE 截获。

**Bug 6: kitty 键盘协议**

发现 `data === '/'` 永远 false。debug 发现 Claude Code 启用了 kitty 键盘协议（`\x1B[?2026h`），终端把 `/` 编码为 `\x1B[191;53;47;1;0;1_`（47 是 `/` 的 Unicode 码点）。必须用正则 `/\x1B\[(?:\d+;)*47(?:;\d*)*[u_]/` 从 CSI 序列中提取 key code。

后来改为 `||` toggle 后，同样需要匹配 key code 124（`|` 的码点）。

**Bug 7: 闪烁条定位不准（conpty）**

想在 "❯ 1. Yes" 那一行画绿色高亮。从 rawBuf 中用正则找 `\x1B[行号;列号H❯`，但 Windows conpty 会重排 ANSI 序列——颜色码跑到光标定位前面、多次写入被合并——导致提取的行号跟屏幕实际位置不一致。

CLI 版最终改为全屏反色闪（`\x1B[?5h`/`\x1B[?5l`），放弃精确行定位。Web 版因为有 xterm.js buffer，可以精确定位。

### Web 版阶段

**Bug 8: JSON 控制消息被写入 PTY**

Web 终端最严重的 bug。屏幕上出现了 `{"type":"resize","cols":144,"rows":39}` 这样的 JSON 文字——控制消息被当作键盘输入写入了 Claude。

原因：ws 库的 `message` 事件把**所有消息**（包括 text frame）都以 Buffer 传递。代码 `Buffer.isBuffer(raw)` 为 true → `this._write(raw.toString())` 把整个 JSON 字符串写入了 PTY。

修法：总是先 `Buffer.toString() → JSON.parse()`，如果解析成功且有 `type` 字段就走控制逻辑，否则忽略。

**Bug 9: SSH "File not found" — node-pty Windows 路径问题**

`pty.spawn('ssh', [...])` 报 "File not found"。Windows 上 node-pty 需要完整路径，`ssh` 不够，要 `C:\Windows\System32\OpenSSH\ssh.exe`。后来改用 ssh2 纯 JS 库，彻底不需要外部 ssh 命令。

**Bug 10: SSH 通过 ssh 命令的 conpty 双层 PTY 问题**

用 `pty.spawn('ssh', [...])` 时，数据经过：Claude → 远程 PTY → SSH 协议 → 本地 SSH 客户端 → 本地 conpty → node-pty → WebSocket → xterm.js。本地 conpty 这一层对 ANSI 做了二次加工（重排、合并），导致 Claude 的 logo 变粉色、文字错位、banner 不完整。

修法：改用 ssh2 纯 JS 库。`conn.exec(cmd, { pty: {...} })` 在远程分配 PTY，stream 的原始字节不经过任何本地 PTY，直接通过 WebSocket binary frame 到达 xterm.js。

**Bug 11: SSH "getaddrinfo ENOTFOUND ap0"**

ssh2 不读 `~/.ssh/config`，不认识 `ap0` 这种 SSH 别名。需要额外安装 `ssh-config` 包解析配置，获取 HostName、User、ProxyJump 等信息。

**Bug 12: SSH "claude: command not found"**

SSH 非交互模式不加载 `.bashrc`/`.profile`，claude 装在 `~/.local/bin/` 里不在 PATH 中。修法：用 `bash -lc '...'` 包裹远程命令，`-l` 强制加载 login profile。

**Bug 13: SSH MOTD 和 Claude TUI 叠加**

`conn.shell()` 开的是完整 login shell，先显示 Ubuntu 的 MOTD（Welcome to Ubuntu...），再执行我们的 `bash -lc` 命令。MOTD 和 Claude 的 TUI 叠在一起。

修法：改用 `conn.exec(cmd, { pty: {...} })`。exec 直接执行命令，不显示 MOTD，但 `pty` 选项确保分配伪终端让 Ink TUI 正常工作。

**Bug 14: export 语法错误**

`export TERM=xterm-256color FORCE_COLOR=1` 在某些 shell 里不被识别为设置两个变量。改为 `export TERM=xterm-256color; export FORCE_COLOR=1;` 用分号分隔。

**Bug 15: 消息类型字段冲突**

`resolveProjectInfo` 返回 `{ type: 'ssh', host, cwd }`，发消息时 `wsSend({ type: 'query', ...info })`，`info.type` 覆盖了 `'query'`，变成 `{ type: 'ssh', ... }`。服务端不识别，页面卡在 Loading。

修法：info 的类型字段改名为 `sessionType`，避免与消息的 `type` 字段冲突。

**Bug 16: workspaceStorage 中 hex 编码的 hostname**

某些 Cursor 版本在 workspace URI 中把 SSH host 编码为 hex：`ssh-remote%2B7b22686f73744e616d65223a22617030227d` = `{"hostName":"ap0"}` 的 hex 表示。需要先 hex decode 再 JSON parse 提取 hostName。

**Bug 17: xterm.js getScreenLines 读错位置**

`getLine(0)` 到 `getLine(rows-1)` 读的是 buffer 最顶部（历史记录），不是当前视口。当 buffer 有 scrollback 时（`baseY > 0`），权限提示在底部但读到的是顶部的旧内容。auto-approve 永远检测不到。

debug 发现：`buffer.length=57, baseY=18, rows=39`。代码读 0-38 行（历史），应该读 18-56 行（视口）。改为从 `buf.length - term.rows` 开始读。

**Bug 18: term.write() 异步导致检测不到**

xterm.js v5 的 `write()` 是异步的——数据被缓冲，在下一个动画帧才渲染到 buffer。`write()` 之后立即调用 `checkAndApprove()` 读到的是旧 buffer。

尝试用 `write(data, callback)` 的回调，但在 Playwright headless 里仍不可靠。最终改为 `setInterval(checkAndApprove, 500)` 周期轮询，不依赖 write 回调。

**Bug 19: 频繁断连**

最初用 2 分钟 idle timeout（无输出就杀）。但 Claude 等待权限审批时不输出，2 分钟到了就被杀。改为 10 分钟 + 客户端活动重置，还是不行——xterm 焦点事件 `\x1B[I]` 也算 "client input"，每次都启动 30 秒 response timer，如果 Claude 在思考（不输出但没死），30 秒后被杀。

最终方案：**去掉所有人工超时**。完全依赖 PTY onExit、SSH stream close、ssh2 keepalive 来判断死活。Claude 可以思考多久都不会被杀。

**Bug 20: `Running...` 阻止审批**

`RUNNING_RE = /esc to interrupt|Running\.\.\./i` 误匹配了工具调用显示标签 `Bash(pwd) └ Running...`。这个 "Running..." 是历史 UI 元素，不代表当前有命令在跑。权限提示和 "Running..." 可以同时出现在屏幕上。

修法：只检查 `esc to interrupt`（小写，不加 `/i`）。这是 Claude 底部状态栏的运行指示器，只在命令真正执行时出现。`Esc to cancel`（大写 E）是权限对话框的，不影响。

**Bug 21: xterm.js 滚动条突然跳到顶部**

Claude 输出过程中，xterm.js 的滚动条有时突然跳到 buffer 最顶部。这是 Ink TUI 框架和 xterm.js 5.x 的已知交互问题（[Claude Code #34794](https://github.com/anthropics/claude-code/issues/34794)、[xterm.js #5390](https://github.com/xtermjs/xterm.js/pull/5390)）。

根因：Ink 做差异渲染时，先用 cursor-up 把光标移到输出区域顶部，擦掉旧内容再写新内容。光标移到 buffer 很靠上的位置时，xterm.js 5.x 的视口跟着跳过去。另外 Ink 在某些场景切换 alternate screen buffer（`\x1B[?1049h`/`\x1B[?1049l`），退出 alternate buffer 时视口恢复到主缓冲区的旧位置，也会造成跳变。

修法：升级 xterm.js 5.5.0 → 6.0.0（包含 alternate buffer 滚动修复 PR #5390），同时在每次 PTY 输出写入后调用 `term.scrollToBottom()` 作为双保险。

**Bug 22: xterm.js getScreenLines 读的是历史而非当前视口**

`buffer.active.getLine(i)` 的参数 `i` 是 buffer 中的绝对行号（包含 scrollback 历史），不是视口内的相对行号。当 buffer 有滚动历史时（`baseY > 0`），`getLine(0)` 返回历史最顶部的行，不是屏幕上第一行。

权限提示总是在屏幕底部，但 `getScreenLines()` 读的是 `getLine(0)` 到 `getLine(rows-1)` — 全是旧历史。auto-approve 检测不到权限提示。

debug 时发现 `buffer.length=57, baseY=18, rows=39`：代码读 0-38 行（历史），实际屏幕显示 18-56 行。

修法：从 `buf.length - term.rows` 开始读最后 N 行，即当前视口。

**Bug 24: 滚轮向上滑无法进入 scroll 模式**

Bug 21 的修复（每次写入后 `scrollToBottom()`）导致用户完全无法向上滚动。滚轮向上 → xterm 视口上移 → 几毫秒后下一批 PTY 数据到达 → `scrollToBottom()` 弹回底部。用户肉眼看到的是"滚不动"。

早期 scroll 模式用 `setTimeout(50ms)` 延迟检查 `viewportY < baseY`：在 50ms 内 `scrollToBottom()` 已经把视口弹回底部，`viewportY === baseY` 永远为 true，scroll 模式永远不触发。

另外发现 xterm.js 6.0 的 `.xterm-viewport` 使用虚拟滚动，`scrollHeight === clientHeight`（测试中均为 665px），原生滚动条不反映 buffer 长度，基于 DOM scroll 位置的检测完全失效。

修法（三处）：
1. 滚轮检测改为立即进入：`if (term.buffer.active.baseY > 0) enterScrollMode()`，无 setTimeout
2. 位置检测改用 xterm buffer API（`baseY > 0` 代替 `scrollHeight > clientHeight`）
3. 已排队的 `term.write()` 回调增加 `if (!scrollMode)` 防护，避免进入 scroll 模式后被待处理的回调弹回底部

**Bug 23: term.write() 异步导致 checkAndApprove 读到旧 buffer**

xterm.js v5/v6 的 `write()` 是异步的 — 数据被缓冲，在下一个动画帧才渲染到 buffer。在 `write()` 之后立即调 `checkAndApprove()` 读到的是上一帧的旧内容。

尝试用 `write(data, callback)` 的回调，在 Playwright headless 里仍不可靠（callback 触发时 buffer 可能还没更新）。

修法：不依赖 write 回调。改用 `setInterval(checkAndApprove, 500)` 周期轮询。每 500ms 读一次屏幕，跟渲染时序完全解耦。
