# cursor_auto

Automation utilities for **Cursor / VS Code (Electron)** by attaching to the Workbench Renderer via **Chrome DevTools Protocol (CDP)**.

## Features

1. **Auto-click** — monitor and click Workbench DOM buttons (e.g. Composer Run/Fetch), with watch mode, scan-tabs mode, and AX status indicator
2. **Claude Code auto-approval** — automatically approve Claude Code extension permission dialogs (integrated into auto-click watch loop)
3. **Static snapshot capture** — grab the Workbench DOM (or Claude Code webviews) as offline-viewable HTML, MHTML, and screenshot
4. **Live View** — real-time iframe preview of the Cursor UI with click forwarding (click in the preview, Cursor executes)
5. **Composer Input** — programmatically insert text into the Cursor AI chat input and send messages via CDP
6. **Claude Code Web terminal** — run Claude Code CLI locally or over SSH from your browser (`/claude`), with per-tab independent xterm.js sessions and client-side prompt auto-approval
7. **Window Resize** — resize/maximize/restore the Cursor window via Win32 API (physical pixels)
8. **Web Dashboard** — phone/tablet-friendly control panel to trigger all actions from any LAN device

---

## Prerequisites

- **Node.js 18+**
- **Cursor or VS Code desktop** (Electron)
- Launch with CDP port enabled:

```bash
# Windows (PowerShell)
& "C:\Program Files\cursor\Cursor.exe" --remote-debugging-port=9292

# macOS
open -na "Cursor" --args --remote-debugging-port=9292

# Or use the provided script
.\start_cursor.ps1
```

Quick sanity check:

```bash
npm run doctor
```

Verify the port is open:

```bash
curl -s http://127.0.0.1:9292/json/version
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

### Claude Code auto-approval

Both watch and scan modes automatically detect and approve **Claude Code extension** permission dialogs (e.g. "Allow this bash command?"). This runs on every loop iteration alongside the Composer button checks.

- Scans all `vscode-webview://` CDP targets for permission dialogs
- Clicks the "Yes" button (shortcut key `1`) when a dialog is found
- Indicator briefly shows `CC: APPROVE` when a dialog is approved
- Respects the same pause/resume state as the main auto-click loop
- Does **not** steal focus — uses pure JS `click()` without `scrollIntoView` or `focus`

**Technical note:** Claude Code webviews are separate renderer processes, invisible to Playwright's page tree. The auto-approval uses raw WebSocket CDP connections (`ws` module) to reach into these isolated targets.

### Customize selector/text

```bash
node src/auto_click.js --once \
  --selector .composer-run-button \
  --contains Fetch \
  --host 127.0.0.1 --port 9292
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

## Claude Code snapshot capture (CLI)

Capture content from Claude Code extension webviews (separate from the main Workbench capture):

```bash
npm run capture:claude
```

Without image embedding (faster/smaller):

```bash
npm run capture:claude:noimg
```

Outputs to `dist/capture/claude/<timestamp>/` (multiple targets get subdirectories):

| File | Description |
|------|-------------|
| `index.html` | Static snapshot of the Claude Code inner document — CSS inlined from extension files, scripts removed |
| `screenshot.png` | Best-effort (not available on Electron iframe targets — `screenshot_error.txt` explains) |
| `snapshot.mhtml` | Best-effort (same Electron limitation as screenshot) |
| `report.json` | Target identification, resource inlining report, errors |

**How it works:** Claude Code runs in isolated `vscode-webview://` CDP iframe targets that are invisible to Playwright. This script discovers them via `/json/list`, identifies Claude targets by DOM fingerprint (CSS module class markers + text content), then captures each one using raw WebSocket CDP connections.

**Note:** Screenshot and MHTML are restricted to top-level CDP targets by Electron. The HTML output is the primary artifact and includes full CSS from the extension's bundled stylesheet via filesystem fallback.

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

## Claude Code Web terminal

Open `http://localhost:5123/claude` to run Claude Code CLI through a browser terminal (xterm.js). Each tab has an **independent** xterm + WebSocket + reconnect timer — terminals in background tabs keep receiving output, so switching tabs never drops logs.

### Features

- **Per-tab sessions** — each tab is its own `TabConnection` (own terminal buffer, ws, debouncer). Switching tabs only toggles a CSS overlay.
- **Local + SSH** — projects are auto-discovered from Cursor's `workspaceStorage`. Local paths launch via `node-pty`; `vscode-remote://ssh-remote/...` paths launch `claude` remotely via `ssh2`, reading `~/.ssh/config`.
- **AX auto-approval** — client-side regex matchers (`PROMPT_PATTERNS`) detect "Do you want to...", "wants to run/edit/...", "Yes/No" prompts; after a 200 ms debounce they send `1\r` to approve. A 3 s cooldown prevents repeat clicks.
- **tmux-style scroll** — `PageUp` enters a locked scroll mode; `ArrowUp/Down`, `PageUp/Down`, `Home`, `End` navigate; `Esc` or `q` exits.
- **Approve counter badge** — each tab shows a green badge with the number of prompts auto-approved in that session.

### HTTP endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/claude` | Web terminal UI |
| GET | `/api/claude/projects` | List local + SSH projects from Cursor's `workspaceStorage` |
| WS | `/api/claude/ws` | PTY WebSocket (handled by `claude_pty_server.js`) |

### macOS note

`node-pty` ships prebuilt binaries whose `spawn-helper` can lose its executable bit when npm extracts the tarball. The project wraps `node-pty` in `src/node_pty.js` which `chmod +x` the helper on first load. Always `require('./node_pty')` instead of `require('node-pty')` if you add new PTY code.

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
  "port": 9292
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

### Claude Code terminal

| Method | Path | Description |
|--------|------|-------------|
| GET | `/claude` | Claude Code Web terminal page |
| GET | `/api/claude/projects` | Scan Cursor `workspaceStorage` → `[{type:'local'|'ssh', host, cwd, project}]` |
| WS | `/api/claude/ws` | PTY WebSocket (local via node-pty, SSH via ssh2) |

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
| `npm run capture:claude` | Claude Code extension snapshot |
| `npm run capture:claude:noimg` | Claude Code snapshot without embedded images |
| `npm run resize` | Resize window (see `--help`) |
| `npm run resize:info` | Show current window info |
| `npm run claude` | Launch Claude Code CLI in the current terminal via node-pty |
| `npm run claude:verbose` | Same as above, with verbose logging |
| `npm run build` | Select model + Build |
| `npm run build:models` | List available models |
| `npm run doctor` | Health check |
| `npm run site:build` | Generate static index site |
| `npm run help` | Show `auto_click.js` CLI options |

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

## Proxy configuration (Claude Code / Codex CLI)

If you need Claude Code or Codex CLI to go through a proxy (e.g. corporate network, SSH SOCKS tunnel), use the provided `start_claude_proxy.sh` script or configure manually.

### Quick start with `start_claude_proxy.sh`

The script starts a **pproxy** (SOCKS5 → HTTP) bridge and automatically syncs proxy settings into both `~/.claude/settings.json` and Cursor `settings.json`:

```bash
# Default: SOCKS5 :9988 → HTTP :9991
./start_claude_proxy.sh

# Custom SOCKS port
CLAUDE_SOCKS_PORT=1080 ./start_claude_proxy.sh

# Also start SSH SOCKS tunnel to a remote host
CLAUDE_SSH_HOST="user@server" ./start_claude_proxy.sh

# Remove proxy keys from ~/.claude/settings.json and Cursor settings.json
./start_claude_proxy.sh --stop
```

The script auto-creates `~/.claude/settings.json` or Cursor's `settings.json` if missing (with `{}`), then merges proxy keys in. `--stop` removes those keys and prints a reminder to restart Cursor / Claude Code for the change to take effect.

Prerequisites: `pip install pproxy` and `jq`.

### Manual configuration

#### Claude Code CLI (`~/.claude/settings.json`)

Add proxy environment variables under the `env` key. Claude Code spawns subprocesses (including Codex plugin) that **inherit** these variables.

```json
{
  "env": {
    "HTTPS_PROXY": "http://127.0.0.1:9991",
    "HTTP_PROXY": "http://127.0.0.1:9991",
    "NO_PROXY": "localhost,127.0.0.1"
  }
}
```

Reference: [Claude Code — Enterprise network configuration](https://code.claude.com/docs/en/network-config)

> **Important**: Restart Claude Code after modifying `settings.json` for changes to take effect.

#### Codex CLI (`~/.codex/config.toml`)

Codex CLI does **not** have a dedicated proxy field in `config.toml`. It relies on environment variables inherited from the parent process.

| Method | How | Use case |
|--------|-----|----------|
| Environment variable | `HTTPS_PROXY` / `HTTP_PROXY` | HTTP/SOCKS proxy (most common) |
| CLI flag | `codex --proxy http://...` | One-off override |
| Config file | `openai_base_url = "https://..."` in `~/.codex/config.toml` | API relay / base URL redirect |

When running the Codex plugin inside Claude Code, the plugin spawns the `codex` binary as a subprocess. As long as `HTTPS_PROXY` is set in Claude Code's `~/.claude/settings.json` (see above), the Codex plugin will also go through the proxy automatically.

Reference: [Codex — Advanced Configuration](https://developers.openai.com/codex/config-advanced/), [PR #3455](https://github.com/openai/codex/pull/3455)

#### Codex plugin for Claude Code (`codex-plugin-cc`)

Install inside Claude Code:

```bash
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

The plugin delegates to your local `codex` CLI. It uses the same auth and proxy settings as `codex` itself — no separate proxy configuration needed. Just ensure `HTTPS_PROXY` is set via `~/.claude/settings.json` as shown above.

If Codex is not logged in yet: `!codex login`

Reference: [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)

### Proxy configuration summary

```
~/.claude/settings.json          ← Claude Code reads this
  └─ env.HTTPS_PROXY             ← inherited by all subprocesses
      ├─ Claude Code API calls   ← goes through proxy
      └─ codex plugin subprocess ← also goes through proxy
          └─ codex CLI           ← respects HTTPS_PROXY env var
```

---

## Claude Code remote settings and fewer prompts

Claude Code configuration can come from multiple layers:

- User settings: `~/.claude/settings.json`
- Project settings: `.claude/settings.json`
- Local project override: `.claude/settings.local.json`
- Remote managed settings cache: `~/.claude/remote-settings.json`

When Claude Code is attached to an org with **server-managed settings**, startup may fetch remote policy and write a local cache file at `~/.claude/remote-settings.json`. In Cursor / VS Code logs this shows up as:

- `Remote managed settings loaded`
- `Remote settings: Saved to ~/.claude/remote-settings.json`

### Temporary override workaround

If an org-managed policy is too noisy (for example, `permissions.ask` contains broad rules like `Bash` or `WebFetch`), an observed workaround is:

1. Start Claude Code and wait for startup to finish
2. Let Claude write `~/.claude/remote-settings.json`
3. Edit `~/.claude/remote-settings.json` **after** startup

This can temporarily override the cached remote rules for the current run, but it is **not** an official or durable configuration mechanism. Expect the file to be overwritten again by:

- Restarting Claude Code
- A later remote settings refresh
- Reconnecting / reinitializing the IDE extension

Use this only as a short-lived local override. If you need a permanent change, update the organization-side managed settings instead.

### Permission modes that reduce confirmation clicks

If no higher-priority managed policy overrides your local settings, these are the most useful ways to reduce prompts:

| Mode / flag | Effect | Notes |
|-------------|--------|-------|
| `permissions.defaultMode: "acceptEdits"` | Auto-accepts file edits and common filesystem operations | Good balance when you still want Bash / network prompts |
| `permissions.defaultMode: "bypassPermissions"` | Highest-autonomy documented mode in `settings.json` | Equivalent in spirit to starting in dangerous mode; use only in trusted environments |
| `claude --permission-mode acceptEdits` | One-off session in accept-edits mode | Does not persist |
| `claude --dangerously-skip-permissions` | One-off session in bypass mode | Equivalent to `--permission-mode bypassPermissions` |
| `claude --allow-dangerously-skip-permissions` | Adds bypass mode to the `Shift+Tab` cycle without starting in it | Useful when you want to escalate later |

Safer default with fewer prompts:

```json
{
  "permissions": {
    "defaultMode": "acceptEdits"
  }
}
```

Maximum autonomy in local `settings.json`:

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

Important caveats:

- `bypassPermissions` is the most permissive documented local setting, but use it only in a trusted repo / machine.
- Deny rules still win over permissive modes.
- Org-managed remote settings can still reintroduce prompts or restrictions.
- If your org writes `~/.claude/remote-settings.json`, local `settings.json` may not fully silence all prompts until the managed policy is changed or temporarily overridden.

References: [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings), [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), [SDK permissions](https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-permissions)

---

## Remote access via SSH tunnel

If the machine running cursor_auto (Machine A) is **not directly reachable** from the machine you want to browse the dashboard on (Machine C), but there is an intermediate machine (Machine B) that both sides can reach, you can use SSH port forwarding to bridge the gap.

### Typical scenario

```
  Machine C (browser, no direct route to A)
      │
      │  SSH over public internet
      ▼
  Machine B (has a public IP; can reach A over VPN / LAN)
      │
      │  VPN / LAN
      ▼
  Machine A (runs cursor_auto server on 0.0.0.0:5123)
```

- **A** runs the cursor_auto server. It is only reachable from B (e.g. via a VPN such as OpenVPN/WireGuard where A's VPN IP is `10.8.0.3`).
- **B** is the only machine with a public IP. A and B are connected via VPN (or LAN).
- **C** can SSH into B but has no VPN access to A.

### SSH local port forwarding (recommended)

Run this on **Machine C**:

```bash
ssh -L 5123:10.8.0.3:5123 user@B_PUBLIC_IP
```

| Part | Meaning |
|------|---------|
| `-L` | Enable local port forwarding |
| `5123` (first) | Port to open on C's localhost |
| `10.8.0.3` | A's address **as seen from B** (VPN/LAN IP) |
| `5123` (second) | A's cursor_auto server port |
| `user@B_PUBLIC_IP` | SSH login to Machine B |

Then open your browser on C:

```
http://localhost:5123
```

All dashboard features (Live View, Auto Click, Composer Input, etc.) work through the tunnel because the frontend uses relative API paths (`/api/live`, `/api/click`, …).

To run the tunnel in the background without an interactive shell:

```bash
ssh -fNL 5123:10.8.0.3:5123 user@B_PUBLIC_IP
```

### Alternative: reverse proxy on B

For long-term or multi-device access, set up a reverse proxy (e.g. nginx) on Machine B:

```nginx
server {
    listen 8080;
    location / {
        proxy_pass http://10.8.0.3:5123;
        proxy_set_header Host $host;
    }
}
```

Then any device can access `http://B_PUBLIC_IP:8080`.

> **Security warning**: this exposes the dashboard to the public internet. Always enable token auth:
>
> ```bash
> # On Machine A
> CURSOR_AUTO_TOKEN=your_secret npm run server
> ```
>
> Then access with `http://B_PUBLIC_IP:8080/?token=your_secret`

### Reverse scenario: A accessing a service on C

In the scenario above, C accesses A. But what if it's the other way around — Machine A needs to access a service running on Machine C?

The challenge: A can reach B (via VPN), and C can SSH into B, but **B cannot initiate connections to C**, and **A has no route to C at all**. The only option is for C to "push" its port onto B using an SSH reverse tunnel, then A reaches it through B.

```
  Machine A (wants to access C's service)
      │
      │  VPN (e.g. 10.8.0.x)
      ▼
  Machine B (public IP, VPN IP e.g. 10.8.0.1)
      ▲
      │  SSH reverse tunnel (initiated by C)
      │
  Machine C (runs a service on port 8080)
```

**Step 1** — On Machine C, create a reverse tunnel that binds to B's **VPN IP only**:

```bash
ssh -R 10.8.0.1:18080:localhost:8080 user@B_PUBLIC_IP
```

| Part | Meaning |
|------|---------|
| `-R` | Remote (reverse) port forwarding — C pushes its port onto B |
| `10.8.0.1` | Bind address on B — **B's VPN IP only**, not all interfaces |
| `18080` | Port to open on B |
| `localhost:8080` | C's local service |
| `user@B_PUBLIC_IP` | SSH into B |

**Step 2** — Machine A accesses the service through B's VPN IP:

```
http://10.8.0.1:18080
```

Data flow:

```
A  ──VPN──►  B (10.8.0.1:18080)  ──SSH reverse tunnel──►  C (localhost:8080)
```

**Prerequisite**: B's SSH server must allow the client to choose a bind address. Edit `/etc/ssh/sshd_config` on B:

```
GatewayPorts clientspecified
```

Then restart sshd: `sudo systemctl restart sshd`

#### Why bind to the VPN IP instead of 0.0.0.0?

If C runs `ssh -R 0.0.0.0:18080:...`, port 18080 listens on **all of B's network interfaces**, including the public one. Anyone on the internet who knows B's public IP can access `http://B_PUBLIC_IP:18080` — this is a security risk.

By binding to `10.8.0.1` (B's VPN IP), the port is **only reachable from within the VPN**. Machines outside the VPN (the public internet) cannot connect to it at all.

| Bind address | Who can reach it | Security |
|-------------|-----------------|----------|
| `0.0.0.0` | Everyone (public internet + VPN + localhost) | **Dangerous** |
| `10.8.0.1` | VPN peers only (e.g. Machine A) | **Safe** |
| `localhost` (default) | Only B itself | Safest, but A can't reach it directly |

#### Extra hardening: firewall on B

Even when binding to the VPN IP, you can add a firewall rule on B as defense-in-depth:

```bash
# Allow only the VPN subnet to reach the tunneled port
iptables -A INPUT -p tcp --dport 18080 -s 10.8.0.0/24 -j ACCEPT
iptables -A INPUT -p tcp --dport 18080 -j DROP
```

This ensures that even if the bind address is misconfigured (e.g. someone accidentally uses `0.0.0.0`), the port remains inaccessible from the public internet.

To run the reverse tunnel in the background:

```bash
ssh -fNR 10.8.0.1:18080:localhost:8080 user@B_PUBLIC_IP
```

---

## Safety

- **Do NOT** expose CDP port 9292 to the internet.
- Keep it bound to localhost; only expose the dashboard to LAN if you need phone/tablet control.
- Use `CURSOR_AUTO_TOKEN` when exposing the dashboard.

---

## Troubleshooting

1. **`Could not find a page containing selector`** — Make sure Cursor is running with `--remote-debugging-port=9292`.

2. **`Found existing auto_click process(es)`** — Another instance is running. Stop it first, or use `--force`.

3. **Static snapshot looks unstyled** — Check `report.json` for `missingCss`. Some CSS may not be retrievable via CDP.

4. **Missing icons/images** — Many are referenced from CSS `url(...)`, not `<img>`. Check `report.json` for `missingImages`.

5. **Titlebar indicator stuck** — Run `node src/test_indicator.js --remove` to clean up.

6. **Composer input not found** — Make sure the Cursor Composer panel is open (the AI chat sidebar). The selector `.aislash-editor-input` must be present in the DOM.

7. **Chinese text not appearing** — The Composer insert API uses CDP `Input.insertText` which supports Unicode natively. If issues persist, check that the composer input has focus.

---

## License

MIT
