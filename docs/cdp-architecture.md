# CDP 连接架构：Playwright vs Raw WebSocket

本文档说明 cursor_auto 项目中两种 CDP (Chrome DevTools Protocol) 连接方式的技术原理、选型原因和实现细节。

---

## 前提：Cursor 的 CDP 端点

Cursor 基于 Electron，启动时加 `--remote-debugging-port=9292` 即暴露 CDP HTTP/WebSocket 端点：

```bash
# macOS
open -na "Cursor" --args --remote-debugging-port=9292

# Windows
cursor --remote-debugging-port=9292
```

验证：

```bash
curl http://127.0.0.1:9292/json/version
# → { "Browser": "Chrome/...", "webSocketDebuggerUrl": "ws://..." }
```

---

## CDP target 模型

一个 Cursor 实例内部有多个独立的渲染进程，每个对应一个 CDP target。通过 `/json/list` 可以查看所有 target：

```bash
curl http://127.0.0.1:9292/json/list
```

返回示例（简化）：

```json
[
  {
    "id": "AAA-111",
    "type": "page",
    "title": "server.js - cursor_auto - Cursor",
    "url": "vscode-file://vscode-app/.../workbench.html",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9292/devtools/page/AAA-111"
  },
  {
    "id": "BBB-222",
    "type": "iframe",
    "title": "",
    "url": "vscode-webview://xxx/index.html?...",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9292/devtools/page/BBB-222"
  },
  {
    "id": "CCC-333",
    "type": "iframe",
    "title": "",
    "url": "vscode-webview://yyy/index.html?...",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9292/devtools/page/CCC-333"
  }
]
```

### target 类型与对应内容

| type | URL 特征 | 内容 | 独立进程？ |
|------|---------|------|-----------|
| `page` | `vscode-file://...workbench.html` | Cursor 主界面（编辑器、Composer、终端等） | 是 |
| `iframe` | `vscode-webview://...` | VS Code 扩展的 webview（如 Claude Code、GitHub Copilot 等） | 是，每个 webview 独立 |

关键认识：**不同 type 的 target 是不同渲染进程，它们的 DOM 树完全隔离**。在 page target 里执行 `document.querySelector()` 永远找不到 iframe target 里的元素。

---

## 两种连接方式

### 方式一：Playwright（操作主 Workbench）

用于所有 `type: "page"` target 的操作。

```
Playwright chromium.connectOverCDP("http://127.0.0.1:9292")
  → browser.contexts()[0]
    → context.pages()          ← 只返回 type:"page" 的 target
      → page.evaluate(js)     ← 底层是 CDP Runtime.evaluate
```

**使用场景：** 自动点击 Composer 按钮、注入 AX status 指示器、静态快照、Live View、模型切换等。

**代码入口：** `src/cdp.js`

```javascript
const { chromium } = require('playwright-core');

async function connectOverCDP({ host, port }) {
  const url = `http://${host}:${port}`;
  const browser = await chromium.connectOverCDP(url);
  const context = browser.contexts()[0];
  return { browser, context, url };
}
```

**优点：**
- 高级 API：自动序列化参数、错误处理、超时管理
- `page.evaluate()` 支持传递复杂 JS 函数和参数
- `page.waitForSelector()` 等便捷方法
- 连接管理（重连、清理）由 Playwright 处理

**限制：** `context.pages()` 只返回 `type: "page"` 的 target。`type: "iframe"` 的 webview target 完全不可见。

### 方式二：Raw WebSocket（操作 webview 扩展）

用于 `type: "iframe"` target 的操作，目前唯一用例是 Claude Code 扩展权限审批。

```
fetch("http://127.0.0.1:9292/json/list")
  → 过滤 type:"iframe" + url 含 "vscode-webview"
    → 对每个 target 的 webSocketDebuggerUrl:
      → new WebSocket(wsUrl)
        → 发送 { method: "Runtime.enable" }
        → 发送 { method: "Runtime.evaluate", params: { expression: js } }
        → 接收结果 → 关闭连接
```

**使用场景：** Claude Code 扩展的权限对话框自动审批。

**代码入口：** `src/claude_code_clicker.js`

```javascript
const WebSocket = require('ws');

function evalOnWebview(wsUrl, expression, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    // 1. ws.on('open') → 发送 Runtime.enable
    // 2. 收到 Runtime.enable 响应 → 发送 Runtime.evaluate
    // 3. 收到 Runtime.evaluate 响应 → 取值 → 关闭连接
  });
}
```

**为什么必须用 raw WebSocket：**
- Playwright 不暴露 `type: "iframe"` target，没有 API 获取它们
- webview 是独立渲染进程，不能通过主 page 的 `page.frames()` 访问
- 但每个 target 都有 `webSocketDebuggerUrl`，可以直接建立 CDP 会话

**为什么不直接用 Playwright 连接 webSocketDebuggerUrl：**
- Playwright 的 `connectOverCDP()` 只接受浏览器级别的 CDP endpoint（`/json/version` 返回的 `webSocketDebuggerUrl`），不支持连接单个 page/iframe 级别的 WebSocket

---

## 架构图

```
Cursor Electron 进程 (--remote-debugging-port=9292)
│
├── http://127.0.0.1:9292/json/list     ← target 发现入口
│
├── Target: type="page" (主 Workbench)
│   ├── ws://...9292/devtools/page/AAA  ← Playwright 通过 connectOverCDP 自动连接
│   └── DOM:
│       ├── .monaco-workbench
│       ├── .composer-run-button        ← auto_click.js 点击
│       ├── .titlebar-right             ← indicator.js 注入指示器
│       └── .aislash-editor-input       ← server.js 插入文字
│
├── Target: type="iframe" (Claude Code webview #1)
│   ├── ws://...9292/devtools/page/BBB  ← claude_code_clicker.js 手动连接
│   └── DOM:
│       └── <iframe id="active-frame">
│           └── contentDocument
│               └── [class*="permissionRequestContainer_"]
│                   └── button (Yes) ← click()
│
└── Target: type="iframe" (Claude Code webview #2)
    ├── ws://...9292/devtools/page/CCC  ← 同样手动连接
    └── DOM: (同上结构)
```

---

## webview 内部的 DOM 层次

连接到 webview 的 CDP target 后，还需要穿透一层 iframe 才能碰到 Claude Code 的 UI：

```
webview target 的 document (vscode-webview://xxx/index.html)
└── <iframe id="active-frame" src="fake.html">
    └── contentDocument                    ← 同源，可通过 JS 访问
        └── Claude Code React 应用
            └── [class*="permissionRequestContainer_"]
                ├── [class*="permissionRequestHeader_"]   → "Allow this bash command?"
                └── [class*="buttonContainer_"]
                    ├── button [shortcutNum="1"]           → "Yes, allow"
                    └── button [shortcutNum="2"]           → "No, deny"
```

外层 webview document 和内层 `#active-frame` 是同源的，所以可以直接通过 `document.getElementById('active-frame').contentDocument` 访问。这个穿透在 `Runtime.evaluate` 的 JS 表达式中完成，一次 CDP 调用即可。

---

## CSS Modules 选择器策略

Claude Code webview 使用 CSS Modules 构建，类名格式为 `baseName_hashSuffix`（如 `permissionRequestContainer_qlaBag`）。hash 随扩展版本变化。

为跨版本兼容，所有选择器使用**属性部分匹配**：

```css
/* 不用这个（会随版本失效） */
.permissionRequestContainer_qlaBag

/* 用这个（跨版本兼容） */
[class*="permissionRequestContainer_"]
```

项目中的选择器定义（`claude_code_clicker.js`）：

```javascript
const SEL = {
  permissionContainer: '[class*="permissionRequestContainer_"]',
  permissionHeader:    '[class*="permissionRequestHeader_"]',
  buttonContainer:     '[class*="buttonContainer_"]',
  button:              'button[class*="button_"]',
  shortcutNum:         '[class*="shortcutNum_"]',
  rejectInput:         '[class*="rejectMessageInput_"]',
};
```

Cursor 主 Workbench 的选择器则是普通的 class 名（如 `.composer-run-button`），不涉及 CSS Modules。

---

## 对比总结

| 维度 | Playwright (page target) | Raw WebSocket (iframe target) |
|------|-------------------------|-------------------------------|
| 库 | `playwright-core` | `ws` |
| 连接入口 | `chromium.connectOverCDP(url)` | `new WebSocket(target.webSocketDebuggerUrl)` |
| target 发现 | Playwright 自动管理 | 手动 `fetch /json/list` + 过滤 |
| 执行 JS | `page.evaluate(fn, args)` | `Runtime.evaluate({ expression })` |
| 参数传递 | 自动序列化 | 必须内联到 expression 字符串 |
| 错误处理 | Playwright 异常体系 | 手动处理 WebSocket 事件 |
| 连接生命周期 | 长连接，Playwright 管理 | 短连接，用完即关 |
| 适用 target type | `page` | `iframe`（也可用于 `page`，但没必要） |
| 本项目使用者 | cdp.js, auto_click.js, indicator.js, capture_static.js, live_snapshot.js, build.js | claude_code_clicker.js |

---

## 扩展新 target 类型时的决策

如果将来需要操作其他 VS Code 扩展的 webview（如 GitHub Copilot、其他自定义扩展）：

1. **先确认 target 类型**：`curl /json/list` 看它是 `page` 还是 `iframe`
2. **如果是 `page`**：直接用 Playwright，通过 `findPageWithSelector()` 定位
3. **如果是 `iframe`**：参考 `claude_code_clicker.js` 的模式，用 raw WebSocket 连接
4. **识别 webview**：通过 URL 中的关键字过滤（如 `vscode-webview` + 扩展特征）
5. **处理 CSS Modules**：如果目标扩展使用 CSS Modules，采用 `[class*="baseName_"]` 部分匹配

---

## 常见问题

**Q: 为什么不把所有操作都用 raw WebSocket 实现？**

可以，但没必要。Playwright 提供的高级 API（参数序列化、等待选择器、截图、网络拦截等）大幅简化了主 Workbench 页面的操作。只在 Playwright 无法触及的 target 类型才退回到 raw WebSocket。

**Q: raw WebSocket 方式可以做 Playwright 做的所有事吗？**

理论上可以——Playwright 底层也是 CDP 协议。但需要手动实现所有 CDP 命令序列（启用 domain → 调用方法 → 处理事件），工作量大且容易出错。

**Q: webview target 的 WebSocket 连接会抢焦点吗？**

不会。CDP 连接是调试通道，不影响 Electron 的焦点状态。但在 `Runtime.evaluate` 中调用 `element.focus()` 或 `element.scrollIntoView()` 可能触发 VS Code 的焦点追踪系统，导致面板切换。因此本项目只用 `element.click()`（纯 JS 合成事件）来避免这个问题。

**Q: 多个 webview target 怎么区分哪个是 Claude Code？**

目前通过 URL 过滤：`type === 'iframe' && url.includes('vscode-webview')`。扫描时逐个连接检查，只有内部 DOM 存在 `[class*="permissionRequestContainer_"]` 的才是有权限对话框的 Claude Code 实例。不匹配的 target 会返回 `{ found: false }` 被跳过。
