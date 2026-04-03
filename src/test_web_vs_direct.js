#!/usr/bin/env node

/**
 * Visual comparison: web terminal (via SSH) vs direct SSH PTY.
 *
 * Captures the same Claude Code startup from two sources:
 *   A) Direct node-pty → ssh → claude (baseline, no web layer)
 *   B) Web terminal /claude page with computelabproxy project selected
 * Renders both side-by-side via xterm.js and screenshots.
 */

const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { chromium } = require('playwright-core');
const { execFileSync } = require('child_process');

const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_vs_direct');
const HOST = 'computelabproxy';
const CWD = '/home/xiaochent/W3';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function resolveSshPath() {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', [
        '-NoProfile', '-Command', '(Get-Command ssh -ErrorAction Stop).Source',
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }
  } catch {}
  return 'ssh';
}

function capturePty(cmd, args, { cols, rows, timeoutMs }) {
  return new Promise(resolve => {
    let buf = '';
    const p = pty.spawn(cmd, args, {
      name: 'xterm-256color', cols, rows,
      cwd: process.cwd(), env: { ...process.env },
    });
    p.onData(d => { buf += d; });
    setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.onExit(() => resolve(buf));
  });
}

function buildHtml(directAnsi, webAnsi, cols, rows) {
  const e = s => JSON.stringify(s);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"><\/script>
<style>body{margin:0;padding:20px;background:#1a1a2e;color:#eee;font-family:system-ui}
h2{font-size:14px;margin:10px 0 6px}.pair{display:flex;gap:24px}.panel{flex:1}</style>
</head><body>
<div class="pair">
  <div class="panel"><h2>A) Direct SSH PTY (baseline)</h2><div id="t1"></div></div>
  <div class="panel"><h2>B) Web terminal /claude (via SSH)</h2><div id="t2"></div></div>
</div>
<script>
const T={background:"#1a1a2e",foreground:"#e0e0e0",cursor:"#e0e0e0",
  black:"#1a1a2e",red:"#e53935",green:"#43a047",yellow:"#fb8c00",
  blue:"#1e88e5",magenta:"#8e24aa",cyan:"#00acc1",white:"#d4d4d4",
  brightBlack:"#757575",brightRed:"#ff5252",brightGreen:"#69f0ae",
  brightYellow:"#ffd740",brightBlue:"#448aff",brightMagenta:"#e040fb",
  brightCyan:"#18ffff",brightWhite:"#ffffff"};
function mk(el,d,c,r){const t=new Terminal({cols:c,rows:r,theme:T,
  fontFamily:"Consolas,Menlo,monospace",fontSize:13,scrollback:0});
  t.open(el);t.write(d)}
mk(document.getElementById("t1"),${e('{DIRECT}')},${cols},${rows});
mk(document.getElementById("t2"),${e('{WEB}')},${cols},${rows});
<\/script></body></html>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const cols = 100, rows = 25;

  // ---- A) Direct SSH PTY → claude ---------------------------------------
  console.log('Capture A: Direct SSH PTY → claude ...');
  const sshPath = resolveSshPath();
  const remoteCmd = `cd '${CWD}' && claude --model opus`;
  const directAnsi = await capturePty(sshPath, ['-t', '-o', 'ServerAliveInterval=15', HOST, remoteCmd],
    { cols, rows, timeoutMs: 25000 });
  console.log(`  ${directAnsi.length} bytes`);

  // ---- B) Web terminal page → select computelabproxy --------------------
  console.log('Capture B: Web terminal page ...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.goto('http://localhost:5123/claude');
  await page.waitForTimeout(3000);

  // Select computelabproxy
  const options = await page.$$eval('#project-select option', opts =>
    opts.map(o => ({ text: o.textContent, value: o.value }))
  );
  const target = options.find(o => o.text.includes('computelabproxy') && o.text.includes('W3'));
  if (target) {
    await page.selectOption('#project-select', { label: target.text });
    console.log(`  Selected: ${target.text}`);
  } else {
    console.log('  WARNING: computelabproxy W3 not found, using default');
  }

  console.log('  Waiting for SSH + Claude startup (25s) ...');
  await page.waitForTimeout(25000);

  // Read xterm buffer as raw ANSI — we need the output buffer from server
  // Since we can't extract raw ANSI from xterm, screenshot the page directly
  const webScreenPath = path.join(OUT, 'web_terminal.png');
  await page.screenshot({ path: webScreenPath });
  console.log(`  Web screenshot: ${webScreenPath}`);

  // Also read screen text for comparison
  const webText = await page.evaluate(() => {
    if (!window.term) return '';
    const buf = window.term.buffer.active;
    const lines = [];
    for (let i = 0; i < window.term.rows; i++) {
      const l = buf.getLine(i);
      if (l) lines.push(l.translateToString(true));
    }
    return lines.join('\n');
  });
  fs.writeFileSync(path.join(OUT, 'web_screen_text.txt'), webText);
  await browser.close();

  // ---- Build side-by-side comparison ------------------------------------
  console.log('Building comparison page ...');
  const html = buildHtml(directAnsi, directAnsi, cols, rows)
    .replace(JSON.stringify('{DIRECT}'), JSON.stringify(directAnsi))
    .replace(JSON.stringify('{WEB}'), JSON.stringify(directAnsi)); // both from direct for xterm render test

  // Actually for the web side, we want to show what xterm rendered.
  // But we can't easily extract raw ANSI from the web terminal.
  // So: render the direct baseline with xterm.js and screenshot the web page separately.

  const htmlPath = path.join(OUT, 'direct_rendered.html');
  fs.writeFileSync(htmlPath, buildHtml(directAnsi, directAnsi, cols, rows)
    .replace(JSON.stringify('{DIRECT}'), JSON.stringify(directAnsi))
    .replace(JSON.stringify('{WEB}'), JSON.stringify(directAnsi)));

  const browser2 = await chromium.launch({ headless: true });
  const page2 = await browser2.newPage({ viewport: { width: 1200, height: 600 } });
  await page2.goto('file:///' + htmlPath.replace(/\\/g, '/'));
  await page2.waitForTimeout(2000);
  const directScreenPath = path.join(OUT, 'direct_rendered.png');
  await page2.screenshot({ path: directScreenPath });
  await browser2.close();

  console.log(`\nDirect SSH baseline: ${directScreenPath}`);
  console.log(`Web terminal:        ${webScreenPath}`);

  // ---- Compare text content ---------------------------------------------
  const directText = directAnsi
    .replace(/\x1B\[\d+;\d+H/g, '\n').replace(/\x1B\[\d+H/g, '\n')
    .replace(/\x1B\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[\(\)][AB012]/g, '').replace(/\x1B[>=<c78HDMZ]/g, '')
    .replace(/\x1B\[>[0-9;]*[a-z]/g, '').replace(/\r/g, '');
  fs.writeFileSync(path.join(OUT, 'direct_screen_text.txt'), directText);

  const directLines = directText.split('\n').filter(l => l.trim()).slice(0, 10);
  const webLines = webText.split('\n').filter(l => l.trim()).slice(0, 10);

  console.log('\n=== Direct SSH (first 10 lines) ===');
  directLines.forEach(l => console.log('  ' + l.substring(0, 80)));
  console.log('\n=== Web terminal (first 10 lines) ===');
  webLines.forEach(l => console.log('  ' + l.substring(0, 80)));

  console.log('\nDone. Compare the two screenshots visually.');
}

main().catch(e => { console.error(e); process.exit(1); });
