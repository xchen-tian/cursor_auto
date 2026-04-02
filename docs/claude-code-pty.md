# Claude Code PTY Auto-Clicker 技术文档

## 概述

`src/claude_code_pty.js` 通过 node-pty 在伪终端中运行 Claude Code CLI，作为透明中间人转发所有 I/O，同时自动检测权限提示并按 Yes。

```
用户终端 (Cursor 集成终端)
  ↕ stdin / stdout
claude_code_pty.js (中间人)
  ↕ node-pty (conpty on Windows)
Claude Code CLI (Ink TUI, React for terminal)
```

## 用法

```bash
npm run claude              # 启动，自动审批默认开启
npm run claude:verbose      # 带调试日志

node src/claude_code_pty.js --prompt "fix bug"    # 带初始 prompt
node src/claude_code_pty.js --no-auto             # 纯代理，不自动审批
node src/claude_code_pty.js -- -c                 # 恢复上次会话
node src/claude_code_pty.js -- --model sonnet     # 透传 claude CLI 参数
```

运行时按 `||`（快速连按两次竖线，300ms 内）切换 auto-approve 开关。

## 四大机制

### 1. PTY 代理（透明转发）

node-pty spawn `claude.exe`，stdin 设 raw mode，用户输入通过 `pty.write()` 转发，Claude 输出通过 `onData` 写到 `process.stdout`。

关键细节：
- Windows 上 node-pty 需要完整路径，`resolveClaudePath()` 用 PowerShell `Get-Command` 获取
- `process.stdin.setRawMode(true)` 确保每个按键立即传递
- `process.stdout.on('resize')` 同步终端尺寸到 PTY

### 2. 权限提示检测 + 自动审批

数据流：

```
Claude 原始输出 (含 ANSI)
  → stripAnsi() 剥离转义码得到纯文本
  → RingBuffer 保存最近 100 行
  → detectPrompt() 正则匹配 + DIALOG_COMPLETE_RE 确认渲染完毕
  → debounce 150ms
  → 全屏反色闪 (\x1B[?5h / \x1B[?5l)
  → pty.write('\r') 发送 Enter
```

**ANSI 剥离策略**：Ink 不用换行符分行，而用 CSI 光标定位。剥离时做语义转换：

| ANSI 序列 | 处理 | 原因 |
|-----------|------|------|
| `\x1B[row;colH` | → `\n` | Ink 用它分行 |
| `\x1B[nC` | → n 个空格 | Ink 用它做单词间距 |
| `\x1B[nA/B/D` | → 删除 | 无文本等价物 |
| `\x1B[...m` | → 删除 | 检测不需要颜色 |
| `\x1B]...\x07` | → 删除 | OSC 标题等 |

**检测正则**（PROMPT_PATTERNS）：

```javascript
/Do you want to\s+\w/i           // "Do you want to" + 任意动词
/wants to\s+(create|run|...)/i   // "wants to create/run/..."
/requires confirmation/i          // "Permission rule Bash requires confirmation"
/allow\s+(this|the|tool)/i       // "allow this/the/tool"
/\bYes\b[\s\S]{0,200}\bNo\b/    // "Yes" 和 "No" 同屏
/❯\s*\d+\.\s*Yes/               // "❯ 1. Yes" 菜单格式
```

**稳定性判断**：不靠静默时间（Ink spinner 持续发数据），而是检测对话框底部标志：

```javascript
const DIALOG_COMPLETE_RE = /Esc to cancel|Tab to amend|ctrl\+e to explain/i;
```

两个条件同时满足才触发审批。

### 3. AX Badge（右上角状态指示器）

搭 Claude 输出的便车，每次 `onData` 把 badge 拼到数据末尾一次性 write：

```javascript
process.stdout.write(data + badgeSeq());
```

不用定时器，因为定时器的独立 write 会和 Claude 的 write 互相穿插，导致光标位置冲突（DEC save/restore 只有一个存储槽）。

状态：
- `AX●` 绿色背景闪烁 — auto-approve ON
- `AX■` 红色背景静止 — auto-approve OFF

### 4. `||` 快捷键切换

检测 300ms 内两次 `|` 按键。第一个 `|` 暂存，第二个到达就 toggle，否则把暂存的转发给 Claude。

**kitty 键盘协议**：Claude Code 启用 kitty 协议后，终端把按键编码为 CSI 序列而不是原始字节。`|` (code point 124) 被发送为 `\x1B[...;124;...u`，用正则匹配：

```javascript
const PIPE_KITTY_RE = /\x1B\[(?:\d+;)*124(?:;\d*)*[u_]/;
```

**stdin 数据绝不拆分**：`handleStdin` 只检查整块数据是否是 `|` 键事件，其他数据原封不动转发。逐字符处理会拆碎 ANSI 序列导致乱码（`\x1B[I` 焦点事件被拆成三个独立字节，`I` 变成输入字符）。

**Toggle ON 时立即重检**：如果权限提示在 OFF 期间渲染完毕，toggle ON 后 Claude 不再输出（等待用户审批），没有新 onData 触发检测。所以 toggle 时立刻对当前 ring buffer 做一次检测。

## 开发中踩过的坑

| 问题 | 根因 | 修法 |
|------|------|------|
| stripAnsi 后单词粘连 | `\x1B[1C`（光标右移）被删除而非替换 | 替换成空格 |
| stripAnsi 后文本全在一行 | `\x1B[row;colH`（光标定位）被删除 | 替换成 `\n` |
| "Do you want to create" 检测不到 | pattern 动词列表不全 | 改为 `/Do you want to\s+\w/i` 匹配任意动词 |
| "Do you want to proceed" 检测不到 | 同上，"proceed" 不在列表里 | 同上 |
| "requires confirmation" 检测不到 | Claude 的另一种提示格式 | 加对应 pattern |
| Yes...No 距离超限 | `\bYes\b[\s\S]{0,60}\bNo\b` 上限太小 | 扩到 200 |
| badge 定时器导致光标跳动 | DEC save/restore 只有一个槽，与 Claude 共用 | 去掉定时器，搭 onData 便车 |
| badge 运行时消失 | 500ms 静默检查在 Claude 持续输出时跳过绘制 | 去掉静默检查 |
| 逐字符循环拆碎 ANSI 导致乱码 | `\x1B[I` 被拆成 `\x1B` `[` `I` | 改为整块数据判断 |
| Ctrl+\\、Alt+1 快捷键无效 | Cursor IDE 截获按键 | 改用 `\|\|`（普通字符） |
| `data === '/'` 永远 false | kitty 协议编码按键为 CSI 序列 | 正则匹配 key code |
| kitty 正则 `(?:^;)47` 不匹配 | `^` 在字符串中间无效 | 改为 `(?:\d+;)*47` |
| `//` 跟 URL 冲突 | 复制 URL 时双斜杠误触 toggle | 改用 `\|\|` |
| flush pending slash 丢 kitty 序列 | 写了原始 `'/'` 而非保存的 kitty 数据 | 用 `slashHeldData` 保存并回放 |
| toggle ON 后不审批已有提示 | 提示在 OFF 期间渲染，ON 后无新 onData | toggle 时立即重检 ring buffer |
| 行级闪烁定位不准 | conpty 重排 ANSI 序列导致行号错误 | 改为全屏反色闪（无需定位） |

## 已知问题

### 1. badge 在 Claude 静默时不更新

badge 搭 onData 便车。Claude 等待用户输入（完全无输出）时没有重绘机会。终端 resize 等操作可能覆盖 badge，直到 Claude 下次输出才恢复。

### 2. 非 Windows 平台未测试

macOS/Linux 没有 conpty，ANSI 序列更原始。`resolveClaudePath` 用 `which`。整体架构应兼容但未验证。
