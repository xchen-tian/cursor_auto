#!/usr/bin/env node
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const claudePath = execFileSync('powershell.exe',
  ['-NoProfile','-Command','(Get-Command claude -ErrorAction Stop).Source'],
  { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
const wrapperPath = path.resolve(__dirname, 'claude_code_pty.js');

function capture(cmd, args, { cols, rows, timeoutMs }) {
  return new Promise(resolve => {
    let buf = '';
    const p = pty.spawn(cmd, args, {
      name: 'xterm-256color', cols, rows,
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '1' },
    });
    p.onData(d => { buf += d; });
    setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.onExit(() => resolve(buf));
  });
}

function buildHtml(ansiOn, ansiOff, cols, rows) {
  const e = s => JSON.stringify(s);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"><\/script>
<style>body{margin:0;padding:20px;background:#1e1e1e;color:#eee;font-family:system-ui}
h2{font-size:14px;margin:10px 0 6px}.pair{display:flex;gap:24px}.panel{flex:1}</style>
</head><body>
<div class="pair">
  <div class="panel"><h2>A) --auto (watch ON, yellow dot)</h2><div id="t1"></div></div>
  <div class="panel"><h2>B) --no-auto (watch OFF, gray pause)</h2><div id="t2"></div></div>
</div>
<script>
const T={background:"#1e1e1e",foreground:"#d4d4d4",cursor:"#d4d4d4",
  black:"#1e1e1e",red:"#e53935",green:"#43a047",yellow:"#fb8c00",
  blue:"#1e88e5",magenta:"#8e24aa",cyan:"#00acc1",white:"#d4d4d4",
  brightBlack:"#757575",brightRed:"#ff5252",brightGreen:"#69f0ae",
  brightYellow:"#ffd740",brightBlue:"#448aff",brightMagenta:"#e040fb",
  brightCyan:"#18ffff",brightWhite:"#ffffff"};
function mk(el,d,c,r){const t=new Terminal({cols:c,rows:r,theme:T,
  fontFamily:"Consolas,Menlo,monospace",fontSize:13,scrollback:0});
  t.open(el);t.write(d)}
mk(document.getElementById("t1"),${e('{ON}')},${100},${20});
mk(document.getElementById("t2"),${e('{OFF}')},${100},${20});
<\/script></body></html>`;
}

(async () => {
  const cols = 100, rows = 20;

  console.log('Capture A: --auto (watch ON)...');
  const ansiOn = await capture(process.execPath,
    [wrapperPath, '--prompt', 'say hello in one word'],
    { cols, rows, timeoutMs: 25000 });
  console.log('  ' + ansiOn.length + ' bytes');

  console.log('Capture B: --no-auto (watch OFF)...');
  const ansiOff = await capture(process.execPath,
    [wrapperPath, '--no-auto', '--prompt', 'say hello in one word'],
    { cols, rows, timeoutMs: 25000 });
  console.log('  ' + ansiOff.length + ' bytes');

  const dir = path.resolve(__dirname, '..', 'dist', 'visual-test', 'badge_test');
  fs.mkdirSync(dir, { recursive: true });

  const html = buildHtml(ansiOn, ansiOff, cols, rows)
    .replace(JSON.stringify('{ON}'), JSON.stringify(ansiOn))
    .replace(JSON.stringify('{OFF}'), JSON.stringify(ansiOff));
  const htmlPath = path.join(dir, 'badge.html');
  fs.writeFileSync(htmlPath, html);

  console.log('Taking screenshot...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 700 } });
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'));
  await page.waitForTimeout(2000);
  const pngPath = path.join(dir, 'badge.png');
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
  console.log('Screenshot: ' + pngPath);
})();
