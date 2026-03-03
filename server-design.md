# cursor_auto Server 设计文档

## 架构总览

```
┌───────────────────────────────────────────────────────────────┐
│                 Express Server (server.js)                     │
│  端口 5123 | 认证: CURSOR_AUTO_TOKEN | Dashboard + REST API   │
└──┬───────────────┬────────────────────┬───────────────────────┘
   │               │                    │
   │  /api/click ──┼─ spawn ──► auto_click.js ──► CDP ──► Cursor
   │  /api/capture ┼─ spawn ──► capture_static.js ──► CDP
   │  /api/live ───┼─ spawn ──► live_snapshot.js ──► CDP (stdout pipe)
   │  /api/vscode-file/* ──► 读 appRoot 下的文件（字体、图标等）
   │  /api/remote-click ───► spawn auto_click.js --once
   │               │
   │  静态文件:    │
   │   /          ─┼─► public/index.html (Dashboard)
   │   /captures/ ─┼─► dist/capture/<timestamp>/ (历史快照)
   └───────────────┴────────────────────────────────────────────

共享模块:
  cdp.js          — connectOverCDP(), findPageWithSelector()
  css_rewrite.js  — rewriteCssUrls() (CSS URL 改写)
  indicator.js    — 状态指示器注入/更新/移除
```

---

## 文件说明

### `src/server.js` — HTTP 服务

Express 5 服务器，所有功能的入口。

**环境变量：**
| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 5123 | 监听端口 |
| `BIND` | 0.0.0.0 | 绑定地址 |
| `CURSOR_AUTO_TOKEN` | (空) | 设置后所有 API 需要 `x-token` 头或 `?token=` |
| `CURSOR_APP_ROOT` | (自动发现) | 手动指定 Cursor app 目录 |

**核心设计：**
- 所有重活（CDP 连接、DOM 操作）都在**子进程**里做，主进程只做路由和 pipe
- 用 `runNode()` 跑一次性脚本（click、capture），用 `spawnNodeLong()` 跑长期 watcher
- `/api/live` 直接把 `live_snapshot.js` 的 stdout pipe 到 HTTP response（流式，不缓冲）
- watcher 单例：同时只允许一个 auto-click 循环进程

**认证中间件：**
```
请求 → 检查 x-token 头 或 ?token 参数 → 匹配 CURSOR_AUTO_TOKEN → 放行/401
```

---

### `src/cdp.js` — CDP 连接工具

所有需要连 Cursor/VS Code 的脚本共用的模块。

| 函数 | 说明 |
|---|---|
| `connectOverCDP({host, port})` | 通过 Playwright 连接 CDP 端点，返回 `{browser, context, url}` |
| `findPageWithSelector(context, opts)` | 轮询所有 page 找到含指定 selector 的页面，超时返回 null |
| `sleep(ms)` | Promise sleep |

---

### `src/live_snapshot.js` — 实时快照

基于 `capture_static.js` 的轻量版，输出到 stdout（不写磁盘）。

**CLI 参数：**
```
--host, --port, --selector, --contains, --timeout
--token <str>         嵌入到点击转发脚本的认证 token
--proxy-base <url>    默认 /api/vscode-file
```

**处理流程：**
1. CDP 连接 → 找到 `.monaco-workbench` 页面
2. `Page.getResourceTree` 构建资源映射（URL → frameId）
3. `page.content()` 获取 DOM HTML
4. 移除 CSP meta 标签
5. 内联 `<link rel=stylesheet>` → `<style>` 并**改写 CSS URL**
6. 改写 `src`/`href` 属性中的 `vscode-file://` URL
7. 移除所有原始 `<script>` 标签
8. 注入**点击转发脚本**（capture 阶段 click → POST `/api/remote-click`）
9. 输出 HTML 到 stdout

**点击转发脚本（注入到 iframe 内运行）：**
```
用户点击 iframe 元素
  → buildSelector(el)  构建 CSS 选择器路径
  → showFlash()        黄色闪烁反馈
  → fetch('/api/remote-click', { selector, requireReady: false })
  → 服务器调用 auto_click.js → CDP 在 Cursor 里执行真实点击
```

---

### `src/capture_static.js` — 静态快照

完整的快照工具，输出到磁盘 `dist/capture/<timestamp>/`。

**CLI 参数：**
```
--host, --port, --selector, --contains, --timeout
--out <dir>           输出目录，默认 dist/capture
--embed-images        嵌入 <img> 为 data: URI，默认 true
--inline-css          内联样式表，默认 true
--remove-scripts      移除 <script>，默认 true
```

**输出目录结构：**
```
dist/capture/20260302_175435/
  ├── index.html       静态快照（内联 CSS、嵌入图片、无脚本）
  ├── screenshot.png   全页截图
  ├── snapshot.mhtml   MHTML 归档（best-effort）
  └── report.json      元数据 + 资源清单
```

**与 live_snapshot.js 的区别：**
| | live_snapshot | capture_static |
|---|---|---|
| 输出 | stdout（流式） | 磁盘文件 |
| 截图 | 无 | 有 (PNG) |
| MHTML | 无 | 有 |
| 脚本处理 | 注入点击转发脚本 | 完全移除 |
| 图片处理 | 保持原样 | 嵌入为 data: URI |
| 速度 | 快（5-15s） | 慢（需截图+MHTML） |

---

### `src/css_rewrite.js` — CSS URL 改写

纯函数模块，被 `live_snapshot.js` 和 `capture_static.js` 共用。

```javascript
rewriteCssUrls(cssText, cssFileUrl, proxyBase) → string
```

**处理逻辑：**
```
url(../../media/codicon.ttf?hash)
  ↓ 解析为 vscode-file://vscode-app/out/media/codicon.ttf (用 cssFileUrl 做 base)
  ↓ 提取路径: out/media/codicon.ttf (去掉 query/hash)
  ↓ 生成: url(/api/vscode-file/out/media/codicon.ttf)

url(vscode-file://vscode-app/path)
  ↓ 直接提取路径
  ↓ 生成: url(/api/vscode-file/path)

url(data:...) / url(http://...) → 不动
```

**为什么需要这步：**
VS Code 的 CSS（如 `workbench.desktop.main.css`）中字体引用全是相对路径。
内联到 `<style>` 标签后，浏览器会相对于 HTML 页面 URL（`localhost:5123/api/live`）解析，
指向错误地址。必须在内联时把相对路径解析为绝对的代理 URL。

---

### `src/get_resource_path.js` — 应用根目录发现

确定 Cursor/VS Code 的 `resources/app` 目录位置（用于 `/api/vscode-file/` 代理）。

**发现策略（按优先级）：**
1. **已知安装路径**（快，不需要 CDP）
   - Windows: `%LOCALAPPDATA%/Programs/cursor/resources/app`
   - macOS: `/Applications/Cursor.app/Contents/Resources/app`
   - Linux: `~/.local/share/cursor/resources/app` 等
2. **CDP 评估**：在渲染器中执行 `process.resourcesPath`（需要 nodeIntegration 开启）
3. **手动覆盖**：`CURSOR_APP_ROOT` 环境变量

**输出（JSON to stdout）：**
```json
{
  "ok": true,
  "resourcesPath": "C:\\Program Files\\Cursor\\resources",
  "appRoot": "C:\\Program Files\\Cursor\\resources\\app",
  "source": "known-path"
}
```

---

### `src/auto_click.js` — 自动点击

核心自动化脚本，支持单次点击和持续监控两种模式。

**模式：**

| 模式 | 参数 | 说明 |
|---|---|---|
| 单次 | `--once` | 点击一次就退出 |
| 监控 | (默认) | 按 `--interval` 持续轮询 |
| 标签扫描 | `--scan-tabs` | 智能切换聊天标签页，根据活跃度调整等待时间 |

**活跃度检测 (`detectActivity`)：**
- 检查 run 按钮是否存在
- 检测 shimmer 动画（工具调用进行中）
- 读取 composer 状态 data 属性
- 检测 "Running command:" 标头

**TabScheduler 智能调度：**
- 活跃标签等待时间短，空闲标签等待时间长
- 自适应递增：从 `baseWaitMs` 到 `maxWaitMs`
- 避免过度切换（强制最小切换间隔）

---

### `src/indicator.js` — 状态指示器

在 Cursor 标题栏注入/更新一个旋转动画指示器。

| 状态 | 颜色 | 转速 | 含义 |
|---|---|---|---|
| scanning | 红 | 1s | 扫描中 |
| shimmer | 橙 | 0.8s | 检测到活动 |
| generating | 绿（慢） | 1.2s | AI 生成中 |
| clicked | 绿（快） | 0.6s | 已点击 |

---

## API 端点

### 点击相关

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/click` | 单次点击 |
| `POST` | `/api/click/start` | 启动持续监控（单例） |
| `POST` | `/api/click/stop` | 停止监控 |
| `GET` | `/api/click/status` | 获取监控状态和日志尾部 |
| `POST` | `/api/remote-click` | Live View iframe 内点击转发 |

### 快照相关

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/capture` | 触发静态快照 |
| `GET` | `/api/live` | 流式返回实时 HTML 快照 |
| `GET` | `/api/latest` | 获取最新快照 URL |

### 状态 & 资源

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/status` | CDP 状态 + watcher 状态 + 最新快照 |
| `GET` | `/api/vscode-file/*` | 代理 Cursor 内部资源文件 |

### 请求/响应示例

```bash
# 单次点击
curl -X POST http://localhost:5123/api/click \
  -H 'Content-Type: application/json' \
  -d '{"selector":".composer-run-button","contains":"Fetch"}'
# → {"ok":true,"code":0,"stdout":"...","stderr":"..."}

# Live View iframe 内点击
curl -X POST http://localhost:5123/api/remote-click \
  -H 'Content-Type: application/json' \
  -d '{"selector":"div.activitybar > .action-item:nth-of-type(3)","requireReady":false}'

# 资源代理
curl -I http://localhost:5123/api/vscode-file/out/media/codicon.ttf
# → 200 OK, Content-Type: font/sfnt, Cache-Control: public, max-age=3600
```

---

## 数据流

### Live View 完整链路

```
Dashboard (index.html)
  ├─ buildLiveUrl() → GET /api/live?host=...&port=...&selector=...&t=<cachebuster>
  │
  ↓
server.js /api/live
  ├─ probeCDP(host, port) → 确认 CDP 可达
  ├─ spawn live_snapshot.js --host ... --port ... [--token ...]
  ├─ child.stdout.pipe(res)  ← 流式传输，不缓冲
  │
  ↓
live_snapshot.js (子进程)
  ├─ connectOverCDP → findPageWithSelector
  ├─ Page.getResourceTree → 资源映射
  ├─ page.content() → DOM HTML
  ├─ 内联 CSS + rewriteCssUrls() → 相对路径变代理 URL
  ├─ 注入点击转发脚本
  └─ stdout.write(html) → pipe → HTTP response → iframe

iframe 渲染:
  ├─ 浏览器解析 HTML
  ├─ 请求 /api/vscode-file/out/media/codicon.ttf (字体)
  ├─ 请求 /api/vscode-file/out/media/cursor-icons-outline.woff2 (图标)
  └─ 用户点击 → 转发脚本 → POST /api/remote-click → auto_click.js → Cursor
```

### vscode-file 代理链路

```
CSS: url(../../media/codicon.ttf)
  ↓ rewriteCssUrls() 解析 (base = vscode-file://vscode-app/out/vs/workbench/...)
  ↓
CSS: url(/api/vscode-file/out/media/codicon.ttf)
  ↓ 浏览器请求
  ↓
server.js /api/vscode-file/out/media/codicon.ttf
  ├─ resolveAppRoot() → C:\Program Files\Cursor\resources\app (缓存)
  ├─ 安全检查: path.resolve() 不能逃逸 appRoot
  ├─ 文件存在检查
  └─ res.sendFile() + Content-Type: font/sfnt + Cache-Control: 1h
```

### Token 认证流

```
用户在 Dashboard 输入 token
  → GET /api/live?token=<tok>     (中间件验证)
  → server 传 --token <tok> 给 live_snapshot.js
  → live_snapshot.js 把 TOKEN 嵌入注入脚本
  → iframe 内点击 → POST /api/remote-click 带 x-token: <tok> (中间件验证)
  → auto_click.js 在 Cursor 执行点击
```

---

## 安全措施

| 措施 | 位置 | 说明 |
|---|---|---|
| Token 认证 | server.js 中间件 | 可选，`CURSOR_AUTO_TOKEN` 环境变量启用 |
| 路径遍历防护 | `/api/vscode-file/*` | 过滤 `..` 段 + `path.resolve().startsWith()` 检查 |
| CSP 移除 | live_snapshot / capture_static | 移除 Electron 的 CSP 防止阻断静态渲染 |
| iframe sandbox | index.html | `allow-scripts allow-same-origin`（仅允许脚本和同源 fetch） |
| Watcher 单例 | server.js | 同时只能运行一个 auto-click 进程 |
| 进程冲突检测 | auto_click.js | 启动前检查是否已有实例运行 |

---

## 已知限制

- `@import url(vscode-file://...)` 嵌套 CSS 不跟随（VS Code CSS 中极少见）
- KaTeX 数学字体（60 个文件）在 `workbench.desktop.main.css` 中引用路径与实际安装位置不一致，不影响 UI 图标
- 每次 iframe 加载需 5-15 秒（CDP 往返 + CSS 内联），流式传输可让页面更早开始渲染
- 如果 `process.resourcesPath` 不可用且安装路径非标准，需手动设置 `CURSOR_APP_ROOT`
