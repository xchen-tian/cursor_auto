# cursor_auto 快速上手

## 安装

```powershell
cd c:\p\cursor_auto
npm install
```

---

## 单个 Cursor 使用

### 1. 启动 Cursor（带 CDP 端口）

```powershell
cursor --remote-debugging-port=9292 C:\p\your-project
```

或使用项目自带的脚本：

```powershell
.\start_cursor.ps1
```

### 2. 验证连接

```powershell
npm run doctor
```

或手动检查：

```powershell
curl http://127.0.0.1:9292/json/version
```

能看到 JSON 输出即表示 CDP 端口正常。

### 3. 自动点击

最常用的功能——自动监控并点击 Composer 的 Run/Fetch 按钮，支持 Agent 模式自动审批。

```powershell
# 单次点击
npm run click

# 持续监控当前对话标签（Watch 模式）
npm run click:watch

# 持续监控 + 自动轮询所有对话标签（Scan 模式，推荐）
npm run click:watch:scan
```

启动后 Cursor 标题栏右侧会出现状态指示器：

| 颜色 | 含义 |
|------|------|
| 灰色 | 初始化/切换中 |
| 红色旋转 | 扫描中 |
| 橙色旋转 | 检测到活动（shimmer） |
| 绿色快转 | 已点击 Run |
| 灰蓝静止 | 已暂停 |

点击指示器上的旋转圆圈可暂停/恢复，点击 `W`/`S` 按钮可切换 Watch/Scan 模式。

### 4. Dashboard 控制面板

```powershell
npm run server
```

打开 http://localhost:5123，可在网页上操控所有功能：

- **Auto Click** — 启动/停止/暂停 Watch 或 Scan 模式
- **Composer Input** — 远程向 Cursor AI 输入框插入文字并发送
- **Live View** — 实时预览 Cursor 界面（支持点击转发和滚动）
- **Window Size** — 调整 Cursor 窗口大小
- **Capture** — 生成静态快照

局域网内手机/平板访问：`http://<你的电脑IP>:5123`

#### 4.1 远程访问（SSH `-R` 反向隧道）

当你的电脑在内网/NAT 后（外网无法直接访问 `5123`），可以用 **SSH 反向端口转发**把本机 Dashboard “挂”到一台你能登录的远程机器上，然后在远端打开页面。

本机（运行 Cursor + cursor_auto 的机器）：

```powershell
# 1) 启动 Dashboard
# 建议：只绑定到 127.0.0.1，并开启 token（避免在本机局域网/公网暴露）
$env:BIND="127.0.0.1"
$env:CURSOR_AUTO_TOKEN="your_token_here"
npm run server

# 2) 建立反向隧道：远端 5123 -> 本机 127.0.0.1:5123
# 如果你修改了 PORT（比如 5124），把下面的 5123 一并替换成对应端口
ssh -R 5123:127.0.0.1:5123 -N -o ServerAliveInterval=60 -o ExitOnForwardFailure=yes user@remote_ip

# 例：
# ssh -R 5123:127.0.0.1:5123 -N -o ServerAliveInterval=60 -o ExitOnForwardFailure=yes xiaochenu@10.19.229.116
```

远端（`remote_ip` 这台机器）：

```bash
# 远端机器本机访问（默认只绑定 127.0.0.1）
curl "http://127.0.0.1:5123/?token=your_token_here"
# 或用浏览器打开同样地址
```

> 注意：如果你设置了 `CURSOR_AUTO_TOKEN`，需要在 URL 上带 `?token=...` 才能加载页面；页面里的 Token 输入框也要填同一个 token（API 调用走 `x-token` header）。

#### SSH `-R` 反向隧道踩坑笔记

1. **Windows OpenSSH IPv6 Bug（最重要）**
   - Windows 自带 OpenSSH 在处理端口转发时，`localhost` 可能解析到 IPv6 的 `::1`，导致 socket 错误，远程 `curl` 返回 `Empty reply from server`（错误码 52）。
   - 现象：
     - 本地直接访问 `localhost:端口` 完全正常
     - 远程通过隧道访问，连接能建立但返回空内容
     - `ssh -v` 日志不会明确提示这个错误
   - 修复：用 `127.0.0.1` 替代 `localhost`

```powershell
# 错误写法（Windows 上可能失败）
ssh -R 5123:localhost:5123 user@remote

# 正确写法（强制 IPv4）
ssh -R 5123:127.0.0.1:5123 user@remote
```

参考：[Win32-OpenSSH issue #414](https://github.com/PowerShell/Win32-OpenSSH/issues/414)

2. **远程端口被占用**
   - 如果之前的 SSH 隧道断开不干净，远程机器上的端口可能还被残留进程占着，导致新隧道绑定失败。
   - SSH 日志表现：`Warning: remote port forwarding failed for listen port 5123`
   - 排查（在远程机器上）：

```bash
ss -tlnp sport = :5123
# 杀掉残留进程（谨慎使用）
kill $(lsof -t -i:5123)
```

   - 预防：加上 `ExitOnForwardFailure=yes`，绑定失败时 SSH 直接退出，而不是静默继续

```powershell
ssh -R 5123:127.0.0.1:5123 -o ExitOnForwardFailure=yes user@remote
```

3. **GatewayPorts 配置**
   - 默认 `ssh -R` 只绑定远程的 `127.0.0.1`，远程机器上的其他人无法通过 IP 访问。
   - debug 可能看到：`debug1: Remote: Forwarding listen address "localhost" overridden by server GatewayPorts`
   - 如果需要远程机器对外暴露端口，需要修改远程 `/etc/ssh/sshd_config`：

```bash
# 推荐：只允许客户端显式指定绑定地址
GatewayPorts clientspecified

# 或：所有 remote-forward 默认对外（更危险）
# GatewayPorts yes

sudo systemctl reload sshd
```

   - 若启用 `clientspecified`，可用显式监听地址把端口暴露给远端其它机器访问：

```powershell
ssh -R 0.0.0.0:5123:127.0.0.1:5123 -N -o ServerAliveInterval=60 -o ExitOnForwardFailure=yes user@remote_ip
```

4. **推荐的完整命令模板**

```powershell
ssh -R 5123:127.0.0.1:5123 `
  -N `
  -o ServerAliveInterval=60 `
  -o ExitOnForwardFailure=yes `
  user@remote_ip
```

| 参数 | 作用 |
|------|------|
| `127.0.0.1` 而非 `localhost` | 避免 Windows IPv6 bug |
| `-N` | 不开 shell，只做端口转发 |
| `-o ServerAliveInterval=60` | 每 60 秒发心跳，防断连 |
| `-o ExitOnForwardFailure=yes` | 端口绑定失败立刻退出 |

5. **不要重复建隧道**
   - 多次执行同一个 `ssh -R` 命令会创建多个 SSH 进程，第二个会绑定失败。启动前先检查：

```powershell
# Windows 检查
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Select ProcessId, CommandLine
```

```bash
# Linux 检查
ps aux | grep "ssh -R"
```

### 5. 静态快照

```powershell
npm run capture
```

输出到 `dist/capture/<时间戳>/`，包含 `index.html`（离线可查看）、`screenshot.png`、`snapshot.mhtml`。

---

## 多个 Cursor 同时使用

在一台机器上打开多个 Cursor 编辑器，每个独立自动化。

### 前置知识：为什么需要 `--user-data-dir`

Cursor 基于 Electron，内置了**单实例锁（Single Instance Lock）**机制：

1. 第一个 Cursor 启动时，在 `%AppData%\Cursor\` 下创建 **lockfile** 并占用一个**命名管道**
2. 后续启动的 Cursor 检测到 lockfile 已存在，会把命令行参数通过管道转发给第一个进程，然后**自己退出**
3. 第一个进程收到消息后只是在内部开一个新窗口——`--remote-debugging-port` 等参数**被丢弃**

因此，仅靠不同的 `--remote-debugging-port` **无法**启动多个独立进程。必须同时指定不同的 `--user-data-dir`，使每个实例的 lockfile 路径不同，Electron 才会将其视为**不同的应用**并允许各自独立运行。

### 架构

```
                          cursor_auto (代码只有一份)
                         c:\p\cursor_auto\
                               │
           ┌───────────────────┼───────────────────┐
           │                   │                   │
    Cursor 实例 A        Cursor 实例 B        Cursor 实例 C
    CDP 端口 9292        CDP 端口 9223        CDP 端口 9224
    user-data 默认       user-data-2          user-data-3
    project-a            project-b            project-c
```

cursor_auto 通过网络端口连接 Cursor，**不需要放在项目目录里**，代码始终只在 `c:\p\cursor_auto` 保留一份。

### 端口分配

| 实例 | Cursor CDP 端口 | user-data-dir | Dashboard 端口（可选） |
|------|----------------|---------------|----------------------|
| A    | 9292           | （默认）       | 5123                 |
| B    | 9223           | `C:\cursor9223` | 5124              |
| C    | 9224           | `C:\cursor9224` | 5125              |

CDP 端口从 9292 起递增，Dashboard 端口从 5123 起递增。第一个实例可使用默认 user-data-dir，其余实例必须指定独立目录。

> **注意**：使用独立 `--user-data-dir` 的实例拥有独立的扩展和设置，首次启动时需要重新登录和配置。

### 步骤 1：启动多个 Cursor

每个 Cursor 实例指定不同的 `--remote-debugging-port`，**第二个实例起**必须加 `--user-data-dir`：

```powershell
# 实例 A —— 使用默认 user-data-dir
cursor --remote-debugging-port=9292 C:\p\project-a

# 实例 B —— 必须指定独立 user-data-dir，否则会复用实例 A 的进程
cursor --remote-debugging-port=9223 --user-data-dir="C:\cursor9223" C:\p\project-b

# 实例 C
cursor --remote-debugging-port=9224 --user-data-dir="C:\cursor9224" C:\p\project-c
```

启动后验证各端口是否正常：

```powershell
curl http://127.0.0.1:9292/json/version
curl http://127.0.0.1:9223/json/version
curl http://127.0.0.1:9224/json/version
```

三个都能返回 JSON 才说明三个独立进程均已就绪。

### 步骤 2：启动自动点击

每个 Cursor 实例需要一个独立的终端窗口运行 auto-click，全部从 `c:\p\cursor_auto` 目录执行：

```powershell
# 终端 1 —— 控制 project-a
cd c:\p\cursor_auto
node src/auto_click.js --port 9292 --verbose --force --scan-tabs

# 终端 2 —— 控制 project-b
cd c:\p\cursor_auto
node src/auto_click.js --port 9223 --verbose --force --scan-tabs

# 终端 3 —— 控制 project-c
cd c:\p\cursor_auto
node src/auto_click.js --port 9224 --verbose --force --scan-tabs
```

> `--force` 跳过进程冲突检测（默认检测到其他 auto_click 进程会拒绝启动，多实例时必须加）。

### 步骤 3（可选）：启动 Dashboard

如果需要 Web 控制面板，每个实例跑一个 server：

```powershell
# 终端 A —— project-a 的 Dashboard
cd c:\p\cursor_auto
$env:PORT=5123; node src/server.js
# 浏览器打开 http://localhost:5123，Port 输入框填 9292

# 终端 B —— project-b 的 Dashboard
cd c:\p\cursor_auto
$env:PORT=5124; node src/server.js
# 浏览器打开 http://localhost:5124，Port 输入框填 9223
```

也可以只开一个 Dashboard，通过修改页面上的 Port 输入框手动切换要控制的 Cursor 实例（但同一时间只能管理一个）。

### 便捷启动脚本

可以在各项目目录放一个 `.bat` 文件快速启动 Cursor：

```bat
:: C:\p\project-a\start_cursor.bat（第一个实例，使用默认 user-data-dir）
cursor --remote-debugging-port=9292 .
```

```bat
:: C:\p\project-b\start_cursor.bat（第二个实例，必须指定独立 user-data-dir）
cursor --remote-debugging-port=9223 --user-data-dir="C:\cursor9223" .
```

或者写一个统一的启动脚本放在 cursor_auto 目录：

```powershell
# c:\p\cursor_auto\start_all.ps1
cursor --remote-debugging-port=9292 C:\p\project-a
cursor --remote-debugging-port=9223 --user-data-dir="C:\cursor9223" C:\p\project-b
Start-Sleep -Seconds 5
Start-Process powershell -ArgumentList "-Command", "cd c:\p\cursor_auto; node src/auto_click.js --port 9292 --verbose --force --scan-tabs"
Start-Process powershell -ArgumentList "-Command", "cd c:\p\cursor_auto; node src/auto_click.js --port 9223 --verbose --force --scan-tabs"
```

---

## CLI 参数速查

### auto_click.js

```powershell
node src/auto_click.js [选项]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--host` | `127.0.0.1` | CDP 主机地址 |
| `--port` | `9292` | CDP 端口 |
| `--once` | `false` | 点一次就退出 |
| `--scan-tabs` | `false` | 轮询所有对话标签 |
| `--interval` | `3000` | 轮询间隔（毫秒） |
| `--force` | `false` | 跳过进程冲突检测（多实例必须） |
| `--verbose` | `false` | 详细日志输出 |

### server.js 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `5123` | Dashboard 监听端口 |
| `BIND` | `0.0.0.0` | 绑定地址 |
| `CURSOR_AUTO_TOKEN` | (空) | 设置后启用 token 认证 |

---

## 常见问题

**Q: 启动 auto-click 提示 "Found existing auto_click process(es)"**
A: 已有一个 auto-click 在运行。多实例场景下加 `--force` 参数即可。

**Q: Cursor 标题栏没有出现指示器**
A: 确认 Cursor 启动时带了 `--remote-debugging-port` 参数，用 `npm run doctor` 检查连接。

**Q: 多实例时 Dashboard 只能控制一个 Cursor？**
A: 单个 Dashboard 同一时间只维护一个 CDP 连接。要同时控制多个，为每个实例启动独立的 server（用不同 `PORT`）。

**Q: auto-click 不点击 Agent 模式的审批按钮？**
A: 已内置支持。Agent 模式的 Run/Skip/Use Allowlist 按钮会被自动检测并点击。

**Q: CDP 端口可以用其他数字吗？**
A: 可以。9292 只是惯例，任何未被占用的端口都行。
