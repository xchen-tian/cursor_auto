# cursor_auto

Automation utilities for **Cursor / VS Code (Electron)** by attaching to the Workbench Renderer via **Chrome DevTools Protocol (CDP)**.

## Features

1. **Auto-click** — monitor and click Workbench DOM buttons (e.g. Composer Run/Fetch), with watch mode, scan-tabs mode, and AX status indicator
2. **Static snapshot capture** — grab the Workbench DOM as offline-viewable HTML, MHTML, and screenshot
3. **Live View** — real-time iframe preview of the Cursor UI with click forwarding (click in the preview, Cursor executes)
4. **Composer Input** — programmatically insert text into the Cursor AI chat input and send messages via CDP
5. **Window Resize** — resize/maximize/restore the Cursor window via Win32 API (physical pixels)
6. **Web Dashboard** — phone/tablet-friendly control panel to trigger all actions from any LAN device

---

## Prerequisites

- **Node.js 18+**
- **Cursor or VS Code desktop** (Electron)
- Launch with CDP port enabled:

```bash
# Windows (PowerShell)
& "C:\Program Files\cursor\Cursor.exe" --remote-debugging-port=9222

# macOS
open -na "Cursor" --args --remote-debugging-port=9222

# Or use the provided script
.\start_cursor.ps1
```

Quick sanity check:

```bash
npm run doctor
```

Verify the port is open:

```bash
curl -s http://127.0.0.1:9222/json/version
```

You should see JSON with a `webSocketDebuggerUrl`.

---

## Install

```bash
cd cursor_auto
npm install
```

---

## Auto-click (CLI)

Click once:

```bash
npm run click
```

### Watch mode

Polls the current chat tab and clicks whenever the button becomes ready.
A visual **indicator** (spinning circle) is injected into the Cursor titlebar showing the current state.
The spinner is clickable: click once to **pause**, click again to **resume**.

```bash
npm run click:watch
```

Indicator displays: `WATCH: idle` / `WATCH: SHIMMER` / `WATCH: RUN` / `WATCH: paused`

### Scan-tabs mode

Like watch mode, but automatically **cycles through all AI chat tabs** with smart scheduling.
Tabs with recent activity are checked more frequently; idle tabs back off up to 5 minutes.

```bash
npm run click:watch:scan
```

Indicator displays: `SCAN: idle [2] 13s` / `SCAN: SHIMMER [2]` / `SCAN: RUN [2]` / `SCAN: paused`

### Customize selector/text

```bash
node src/auto_click.js --once \
  --selector .composer-run-button \
  --contains Fetch \
  --host 127.0.0.1 --port 9222
```

All options:

| Option | Default | Description |
|--------|---------|-------------|
| `--selector` | `.composer-run-button` | CSS selector for the button to click |
| `--contains` | `""` | Only match buttons containing this text |
| `--once` | `false` | Click once and exit (vs. continuous watch) |
| `--scan-tabs` | `false` | Cycle through AI chat tabs |
| `--interval` | `3000` | Poll interval in ms (watch mode) |
| `--require-ready` | `true` | Check `data-click-ready="true"` before clicking |
| `--tab-settle-ms` | `500` | Wait after switching tab before probing |
| `--force` | `false` | Skip duplicate process check |
| `--verbose` | `false` | Print detailed logs |

---

## Static snapshot capture (CLI)

Capture a snapshot (writes to `dist/capture/<timestamp>/`):

```bash
npm run capture
```

Capture without embedding images (faster/smaller):

```bash
npm run capture:noimg
```

Outputs per capture folder:

| File | Description |
|------|-------------|
| `index.html` | Static snapshot — CSS inlined, scripts removed, CSP stripped |
| `screenshot.png` | Full-page screenshot (always reliable) |
| `snapshot.mhtml` | MHTML archive (best-effort, depends on Electron build) |
| `report.json` | Resource inlining report (what succeeded / what's missing) |

---

## Window resize (CLI)

Resize the Cursor window using Win32 API (works even when maximized):

```bash
# Show current window info
npm run resize:info

# Resize to specific dimensions
node src/resize_window.js -w 1920 -h 1080

# Resize and center
node src/resize_window.js -w 1280 -h 800 --center

# Maximize / Restore
node src/resize_window.js --maximize
node src/resize_window.js --restore
```

> Note: dimensions are in **physical pixels**. On a display with dpr=1.25, Win32's 1920px = CSS's 1536px.

---

## Web dashboard

Start server:

```bash
npm run server
```

Open: http://localhost:5123

From your phone on the same LAN: `http://<your-computer-lan-ip>:5123`

### Dashboard sections

| Section | What it does |
|---------|-------------|
| **Connection** | Configure CDP host/port, token, selector; trigger click/capture |
| **Window Size** | Preset buttons (1280×800, 1920×1080, 2560×1440), custom W×H, maximize, fit-to-client |
| **Composer Input** | Text area for inserting text into Cursor's AI chat, with Insert / Send / Insert & Send buttons |
| **Live View** | Real-time iframe preview of Cursor UI with configurable refresh rate, overflow, height, and scale |
| **Output** | JSON log of API responses |

### Composer Input

The Composer Input card lets you remotely type into Cursor's AI chat composer:

- **Insert** — insert the text into the composer input box (does not send)
- **Send (Enter)** — press Enter to send whatever is currently in the input box
- **Insert & Send** — insert text then immediately send
- **Append** checkbox — when unchecked, replaces existing content; when checked, appends to it

Multiline text is supported: each `\n` is converted to `Shift+Enter` in the composer (since bare `Enter` sends the message).

Under the hood this uses CDP `Input.insertText` for text and `Input.dispatchKeyEvent` for key simulation, which correctly handles **Chinese and other non-ASCII characters**.

### Live View

Real-time preview of the Cursor UI rendered as an iframe:

- **Double-buffered** — new frame loads behind the scenes, then swaps in (no flicker)
- **Click forwarding** — click anything in the preview and the click is dispatched to the real Cursor via CDP
- **Configurable refresh** — 1s / 2s / 3s / 5s / 8s / 10s / manual
- **Overflow / Height / Scale** controls to fit any screen

### Optional auth

```bash
export CURSOR_AUTO_TOKEN='change-me'
npm run server
```

Requests must include `x-token: change-me` header or `?token=change-me` query param.

---

## REST API

### Click

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/click` | Click once |
| POST | `/api/click/start` | Start background auto-click watcher (singleton) |
| POST | `/api/click/stop` | Stop watcher |
| GET | `/api/click/status` | Watcher state + log tail |

### Composer

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/composer/insert` | Insert text into Cursor composer input |
| POST | `/api/composer/send` | Press Enter to send current composer content |

**`POST /api/composer/insert`** body:

```json
{
  "text": "hello\nworld",
  "append": true,
  "send": false,
  "host": "127.0.0.1",
  "port": 9222
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `text` | string | `""` | Text to insert (supports `\n` for multiline) |
| `append` | bool | `true` | `true` = append; `false` = replace existing content |
| `send` | bool | `false` | Press Enter after inserting to send the message |

### Capture & Live

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/capture` | Trigger static snapshot capture |
| GET | `/api/live` | Render real-time HTML snapshot (for iframe) |
| GET | `/api/latest` | Get latest capture URL |
| POST | `/api/remote-click` | Forward a click to Cursor (used by Live View iframe) |

### Window Resize

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/resize/info` | Current window dimensions and state |
| POST | `/api/resize` | Resize/maximize the window |

**`POST /api/resize`** body:

```json
{ "width": 1920, "height": 1080 }
```

or `{ "maximize": true }`

### Status & Resources

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | CDP reachability + watcher state + latest capture |
| GET | `/api/vscode-file/*` | Proxy Cursor internal resources (fonts, icons) |

---

## npm scripts

| Command | Description |
|---------|-------------|
| `npm run server` | Start Express server (port 5123) |
| `npm run click` | Single click |
| `npm run click:watch` | Continuous watch (single tab) |
| `npm run click:watch:scan` | Continuous watch (multi-tab scan) |
| `npm run capture` | Static snapshot |
| `npm run capture:noimg` | Static snapshot without embedded images |
| `npm run resize` | Resize window (see `--help`) |
| `npm run resize:info` | Show current window info |
| `npm run build` | Select model + Build |
| `npm run build:models` | List available models |
| `npm run doctor` | Health check |
| `npm run site:build` | Generate static index site |

---

## Static snapshot hosting

After `npm run capture`, host the generated folder:

```bash
npx serve dist/capture
# visit http://localhost:3000/<timestamp>/index.html
```

Build a static index page linking all captures:

```bash
npm run site:build
npx serve dist/site
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5123` | Server listen port |
| `BIND` | `0.0.0.0` | Bind address |
| `CURSOR_AUTO_TOKEN` | (empty) | Enable token auth |
| `CURSOR_APP_ROOT` | (auto-detected) | Manual Cursor `resources/app` path |

---

## Safety

- **Do NOT** expose CDP port 9222 to the internet.
- Keep it bound to localhost; only expose the dashboard to LAN if you need phone/tablet control.
- Use `CURSOR_AUTO_TOKEN` when exposing the dashboard.

---

## Troubleshooting

1. **`Could not find a page containing selector`** — Make sure Cursor is running with `--remote-debugging-port=9222`.

2. **`Found existing auto_click process(es)`** — Another instance is running. Stop it first, or use `--force`.

3. **Static snapshot looks unstyled** — Check `report.json` for `missingCss`. Some CSS may not be retrievable via CDP.

4. **Missing icons/images** — Many are referenced from CSS `url(...)`, not `<img>`. Check `report.json` for `missingImages`.

5. **Titlebar indicator stuck** — Run `node src/test_indicator.js --remove` to clean up.

6. **Composer input not found** — Make sure the Cursor Composer panel is open (the AI chat sidebar). The selector `.aislash-editor-input` must be present in the DOM.

7. **Chinese text not appearing** — The Composer insert API uses CDP `Input.insertText` which supports Unicode natively. If issues persist, check that the composer input has focus.

---

## License

MIT
