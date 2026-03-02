# cursor_auto

Automation utilities for Cursor / VS Code (Electron) by attaching to the Workbench Renderer via **Chrome DevTools Protocol (CDP)**.

What you get:

1) **Auto-click** a Workbench DOM button (e.g. `.composer-run-button` “Fetch/Run”) using Playwright over CDP.
2) **Static snapshot capture** of the current Workbench DOM:
   - `index.html`: a best-effort static HTML snapshot (CSP removed, CSS inlined where possible, scripts removed)
   - `snapshot.mhtml`: a best-effort MHTML archive from CDP (if supported)
   - `screenshot.png`: full-page screenshot (always the most reliable “what you saw”)
3) A tiny local web dashboard so you can trigger both actions from **another device** (phone/tablet) on your LAN.

---

## Why static HTML capture is hard (based on your captured DOM)

Your captured Workbench DOM (see `a.html` in your notes) contains:

- A **very strict CSP** meta tag like:
  - `default-src 'none'` and locked-down `script-src`, `img-src`, etc.
  - If you host that HTML on a website as-is, the CSP will block most resources and inline execution.

- Critical scripts and assets loaded via **Cursor/VS Code custom schemes**, e.g.:
  - `vscode-file://vscode-app/.../workbench.js`
  - `vscode-webview:`
  - `vscode-remote-resource:` / `vscode-managed-remote-resource:`
  - `blob:`

A normal mobile browser cannot resolve `vscode-file://...` (it’s an Electron-internal scheme), and even if it could, those scripts expect VS Code/Cursor’s internal services (IPC, file service, command service, extension host, etc.).

**So the realistic goal of “static capture” is a *read-only snapshot* for viewing**, not a fully functional Cursor UI.

This project therefore:

- Removes CSP meta from the captured HTML.
- Inlines stylesheets that are retrievable via CDP (`Page.getResourceTree` + `Page.getResourceContent`).
- Optionally embeds `<img>` as `data:` URLs if CDP can retrieve them.
- Removes all `<script>` tags (otherwise they will error outside Electron).

Even with all that:

- Some icons/fonts/background images can still be missing (often referenced indirectly via CSS `url(...)` or via custom schemes).
- Any interactive behavior will not work (it’s a snapshot).

---

## Prerequisites

- Node.js 18+
- Cursor or VS Code **desktop** app (Electron)
- You must launch Cursor/VS Code with a CDP port:
  - `--remote-debugging-port=9222`

Quick sanity check:

```bash
npm run doctor
```

### Launch Cursor with CDP enabled (macOS)

```bash
open -na "Cursor" --args --remote-debugging-port=9222
```

If `open --args` doesn’t work on your machine, run the app binary directly:

```bash
/Applications/Cursor.app/Contents/MacOS/Cursor --remote-debugging-port=9222
```

### Verify the port is open

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

```bash
npm run click:watch
```

Indicator displays: `WATCH: idle` / `WATCH: SHIMMER` / `WATCH: RUN`

### Scan-tabs mode

Like watch mode, but automatically **cycles through all AI chat tabs** with smart scheduling.
Tabs with recent activity (shimmer/run) are checked more frequently; idle tabs back off up to 60 seconds.

```bash
npm run click:watch:scan
```

Indicator displays: `SCAN: idle [2] 13s` / `SCAN: SHIMMER [2]` / `SCAN: RUN [2]`

The number in brackets is the tab index; the seconds value is the next check interval for that tab.

### Duplicate process protection

If you try to start a second auto_click process while one is already running, the script will warn and exit.
Use `--force` to override this check.

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

Capture a snapshot (writes to `dist/capture/<timestamp>/...`):

```bash
npm run capture
```

Capture without embedding images (faster/smaller):

```bash
npm run capture:noimg
```

Outputs per capture folder:
- `index.html` – static snapshot for hosting/viewing
- `report.json` – what was inlined/embedded and what was missing
- `snapshot.mhtml` – best-effort archive (if the Electron build supports `Page.captureSnapshot`)
- `screenshot.png` – always works, best “ground truth”

---

## Local web dashboard (phone-friendly)

Start server:

```bash
npm run server
```

Open on the same machine:
- http://localhost:5123

From your phone on the same LAN:
- http://<your-computer-lan-ip>:5123

### Optional auth (recommended)

Set a token so random LAN devices can’t trigger clicks:

```bash
export CURSOR_AUTO_TOKEN='change-me'
npm run server
```

Then your requests must include `x-token: change-me` header, or `?token=change-me`.

The dashboard page supports this by providing a **Token** input.

### New: Start/Stop auto-click from the dashboard

Endpoints:

- `POST /api/click` – click once
- `POST /api/click/start` – start a single background watcher
- `POST /api/click/stop` – stop the watcher
- `GET  /api/click/status` – tail logs + running state
- `GET  /api/status` – CDP reachability + watcher state + latest capture URL

The dashboard auto-refreshes `/api/status` every ~2 seconds.

---

## “One-click deploy” for the static snapshot

After `npm run capture`, you can host the generated folder:

- The latest snapshot is in: `dist/capture/<timestamp>/index.html`
- Copy that folder to any static host (GitHub Pages, Netlify, Nginx, etc.)

Example (quick local static host):

```bash
npx serve dist/capture
```

Then visit:

- http://localhost:3000/<timestamp>/index.html

### Bonus: Build a simple static index page (good for publishing)

This generates `dist/site/` with an `index.html` that lists all captures and links to each snapshot:

```bash
npm run site:build
npx serve dist/site
```

Then publish `dist/site/` to any static host.

---

## Safety

- **Do NOT** expose CDP port `9222` to the internet.
- Keep it bound to localhost and only expose the *dashboard* to LAN if you need phone control.

---

## Troubleshooting

1) `Could not find a page containing selector`:
   - Make sure Cursor is running and CDP port is enabled (`curl .../json/version`).

2) `Found existing auto_click process(es)`:
   - Another auto_click is already running. Stop it first, or use `--force`.
   - To find and kill stale processes: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CommandLine`

3) Static snapshot looks unstyled:
   - Some CSS may not be retrievable via CDP in your build.
   - Check `report.json` for `missingCss`.

4) Missing icons/images:
   - Many are referenced from CSS `url(...)` (not `<img>`). This tool embeds `<img>` sources, not all CSS-referenced assets.

5) Titlebar indicator not visible:
   - Run `node src/test_indicator.js` to test injection independently.
   - Run `node src/test_indicator.js --remove` to clean up a stuck indicator.

---

## License

MIT
