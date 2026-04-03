#!/usr/bin/env node

/**
 * Visual fidelity test for claude_code_pty.js
 *
 * Captures raw ANSI output from two PTY runs of `claude`:
 *   A) direct node-pty spawn (baseline)
 *   B) through our claude_code_pty wrapper (--no-auto)
 * Then renders both side-by-side via xterm.js and takes a screenshot.
 *
 * Usage:  node src/test_pty_visual.js [--cols 120] [--rows 30]
 */

const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { chromium } = require('playwright-core');
const { execFileSync } = require('child_process');

function resolveClaudePath() {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', [
        '-NoProfile', '-Command', '(Get-Command claude -ErrorAction Stop).Source',
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }
    return execFileSync('which', ['claude'], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { return 'claude'; }
}

function capturePty(cmd, args, { cols, rows, timeoutMs }) {
  return new Promise((resolve) => {
    let buf = '';
    const proc = pty.spawn(cmd, args, {
      name: 'xterm-256color', cols, rows,
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '1' },
    });
    proc.onData((d) => { buf += d; });

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
    }, timeoutMs);

    proc.onExit(() => {
      clearTimeout(timer);
      resolve(buf);
    });
  });
}

function buildHtml(directAnsi, wrapperAnsi, cols, rows) {
  const escapeForJs = (s) => JSON.stringify(s);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>PTY Visual Comparison</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"><\/script>
  <style>
    body { margin: 0; padding: 20px; background: #1e1e1e; color: #eee; font-family: system-ui, sans-serif; }
    h2 { margin: 10px 0 6px; font-size: 14px; font-weight: 600; }
    .pair { display: flex; gap: 24px; }
    .panel { flex: 1; }
    .xterm { padding: 4px; }
  </style>
</head>
<body>
  <div class="pair">
    <div class="panel">
      <h2>A) Direct node-pty &rarr; claude (baseline)</h2>
      <div id="term-direct"></div>
    </div>
    <div class="panel">
      <h2>B) claude_code_pty.js wrapper (--no-auto)</h2>
      <div id="term-wrapper"></div>
    </div>
  </div>
  <script>
    const THEME = {
      background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4',
      black: '#1e1e1e', red: '#e53935', green: '#43a047', yellow: '#fb8c00',
      blue: '#1e88e5', magenta: '#8e24aa', cyan: '#00acc1', white: '#d4d4d4',
      brightBlack: '#757575', brightRed: '#ff5252', brightGreen: '#69f0ae',
      brightYellow: '#ffd740', brightBlue: '#448aff', brightMagenta: '#e040fb',
      brightCyan: '#18ffff', brightWhite: '#ffffff',
    };
    function makeTerm(el, data, cols, rows) {
      const t = new Terminal({ cols, rows, theme: THEME, fontFamily: 'Consolas, Menlo, monospace', fontSize: 13, convertEol: false, scrollback: 0 });
      t.open(el);
      t.write(data);
    }
    makeTerm(document.getElementById('term-direct'),  ${escapeForJs(directAnsi)},  ${cols}, ${rows});
    makeTerm(document.getElementById('term-wrapper'), ${escapeForJs(wrapperAnsi)}, ${cols}, ${rows});
  <\/script>
</body>
</html>`;
}

async function main() {
  const cols = 120;
  const rows = 30;
  const claudePath = resolveClaudePath();
  const wrapperPath = path.resolve(__dirname, 'claude_code_pty.js');

  console.log(`claude path: ${claudePath}`);
  console.log(`wrapper path: ${wrapperPath}`);
  console.log(`cols=${cols} rows=${rows}`);

  const testPrompt = 'say hello in one sentence, do not use any tools';

  console.log(`\n--- Capture A: direct node-pty → claude "${testPrompt}" ---`);
  const directAnsi = await capturePty(claudePath, [testPrompt], { cols, rows, timeoutMs: 30000 });
  console.log(`  captured ${directAnsi.length} bytes`);

  console.log(`--- Capture B: wrapper → claude "${testPrompt}" ---`);
  const wrapperAnsi = await capturePty(
    process.execPath,
    [wrapperPath, '--no-auto', '--prompt', testPrompt],
    { cols, rows, timeoutMs: 30000 },
  );
  console.log(`  captured ${wrapperAnsi.length} bytes`);

  const ts = new Date().toISOString().replace(/[T:]/g, '').replace(/-/g, '').slice(0, 15).replace('.', '_');
  const outDir = path.resolve(__dirname, '..', 'dist', 'visual-test', ts);
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, 'direct_raw.txt'), directAnsi);
  fs.writeFileSync(path.join(outDir, 'wrapper_raw.txt'), wrapperAnsi);

  const htmlContent = buildHtml(directAnsi, wrapperAnsi, cols, rows);
  const htmlPath = path.join(outDir, 'comparison.html');
  fs.writeFileSync(htmlPath, htmlContent);
  console.log(`\nHTML: ${htmlPath}`);

  console.log('--- Taking screenshot with Playwright ---');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1800, height: 900 } });
  await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`);
  await page.waitForTimeout(2000);

  const screenshotPath = path.join(outDir, 'comparison.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Screenshot: ${screenshotPath}`);

  await browser.close();
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
